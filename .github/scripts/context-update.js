/**
 * context-update.js
 * Entrypoint for the context update workflow.
 *
 * Triggered on push to trigger branches. Finds context docs affected by
 * changed files and regenerates them using the Anthropic API.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as core from '@actions/core';
import yaml from 'js-yaml';
import micromatch from 'micromatch';

import { parse, serialize, validate, updateLastUpdated } from './utils/frontmatter.js';
import { matchesCoversPaths, mapChangedFilesToDocs } from './utils/glob-matcher.js';
import { regenerateContextDoc, delay } from './utils/ai-client.js';
import { createCommit } from './utils/github-client.js';
import { validateIntent } from './utils/taxonomy.js';

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------
const REPO_ROOT = process.cwd();
const CONTEXT_DIR = path.join(REPO_ROOT, '.context');
const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 40000;
const DRY_RUN = process.env.DRY_RUN === 'true';

// -----------------------------------------------------------------------
// Environment variables (set by the workflow)
// -----------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CONTEXT_STANDARDS_PAT = process.env.CONTEXT_STANDARDS_PAT;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || 'main';
const BEFORE_SHA = process.env.BEFORE_SHA || '';
const AFTER_SHA = process.env.AFTER_SHA || '';
const COMMIT_MESSAGE = process.env.COMMIT_MESSAGE || '';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function getToday() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Load the context.config.yml file.
 */
function loadConfig() {
  const configPath = path.join(REPO_ROOT, 'context.config.yml');
  if (!fs.existsSync(configPath)) {
    throw new Error('context.config.yml not found at repo root');
  }
  return yaml.load(fs.readFileSync(configPath, 'utf8'));
}

/**
 * Get the list of files changed in this push.
 */
function getChangedFiles() {
  let output;

  try {
    if (BEFORE_SHA && AFTER_SHA && BEFORE_SHA !== '0000000000000000000000000000000000000000') {
      // Normal push with before/after
      output = execSync(`git diff --name-status ${BEFORE_SHA} ${AFTER_SHA}`, { encoding: 'utf8' });
    } else {
      // First push or force push - compare with parent
      output = execSync(`git show --name-status --format="" HEAD`, { encoding: 'utf8' });
    }
  } catch (e) {
    core.warning(`Failed to get changed files via git diff: ${e.message}`);
    output = execSync(`git show --name-status --format="" HEAD`, { encoding: 'utf8' });
  }

  const files = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      return {
        status: parts[0],
        path: parts[parts.length - 1]
      };
    });

  // Filter out ignored paths
  const ignorePaths = ['node_modules/**', 'vendor/**', '**/*.lock', '.context/**', '.github/**'];

  return files.filter(f => {
    if (!f.path) return false;
    return !micromatch.isMatch(f.path, ignorePaths, { dot: true });
  });
}

/**
 * Load all context docs from .context/ directory.
 */
function loadContextDocs() {
  if (!fs.existsSync(CONTEXT_DIR)) {
    return [];
  }

  const files = fs.readdirSync(CONTEXT_DIR).filter(f => f.endsWith('.md'));
  const docs = [];

  for (const filename of files) {
    const filePath = path.join(CONTEXT_DIR, filename);
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parse(content);

    if (!parsed) {
      core.warning(`Skipping ${filename}: invalid or missing frontmatter`);
      continue;
    }

    const validation = validate(parsed.meta);
    if (!validation.valid) {
      core.warning(`Skipping ${filename}: missing required fields: ${validation.missing.join(', ')}`);
      continue;
    }

    docs.push({
      path: `.context/${filename}`,
      filePath,
      filename,
      content,
      meta: parsed.meta,
      body: parsed.body,
      coversPaths: parsed.meta['covers-paths'] || []
    });
  }

  return docs;
}

/**
 * Read source files covered by a context doc.
 * Respects truncation limits.
 */
function readSourceFiles(coversPaths, maxTotalChars = MAX_TOTAL_CHARS) {
  const files = [];
  let totalChars = 0;

  // Expand globs to actual files
  for (const pattern of coversPaths) {
    try {
      const matches = execSync(`git ls-files "${pattern}" 2>/dev/null || true`, { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);

      for (const filePath of matches) {
        if (totalChars >= maxTotalChars) {
          core.warning(`Token budget reached (${maxTotalChars} chars). Some source files omitted.`);
          break;
        }

        const fullPath = path.join(REPO_ROOT, filePath);
        if (!fs.existsSync(fullPath)) continue;

        try {
          let content = fs.readFileSync(fullPath, 'utf8');

          // Truncate individual files
          if (content.length > MAX_FILE_CHARS) {
            core.warning(`Truncating ${filePath} from ${content.length} to ${MAX_FILE_CHARS} chars`);
            content = content.slice(0, MAX_FILE_CHARS) + '\n\n[... truncated ...]';
          }

          // Check total budget
          if (totalChars + content.length > maxTotalChars) {
            const remaining = maxTotalChars - totalChars;
            content = content.slice(0, remaining) + '\n\n[... truncated for budget ...]';
          }

          files.push({ path: filePath, content });
          totalChars += content.length;
        } catch (e) {
          core.warning(`Failed to read ${filePath}: ${e.message}`);
        }
      }
    } catch {
      // Pattern didn't match anything
    }
  }

  return files;
}

/**
 * Validate that AI response has valid frontmatter.
 */
function validateAIResponse(response) {
  const parsed = parse(response);
  if (!parsed) {
    return { valid: false, error: 'No valid frontmatter in AI response' };
  }

  const validation = validate(parsed.meta);
  if (!validation.valid) {
    return { valid: false, error: `Missing fields in AI response: ${validation.missing.join(', ')}` };
  }

  return { valid: true, parsed };
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  const today = getToday();

  core.info('=== Context Update Action ===');
  core.info(`Date: ${today}`);
  core.info(`Repository: ${GITHUB_REPOSITORY}`);
  core.info(`Branch: ${GITHUB_REF_NAME}`);
  core.info(`Dry run: ${DRY_RUN}`);

  // Check for skip conditions
  if (COMMIT_MESSAGE.includes('[skip ci]')) {
    core.info('Commit message contains [skip ci] - skipping');
    return;
  }

  // Load config
  const config = loadConfig();
  const triggerBranches = config.context?.trigger_branches || ['main'];
  
  // AI config - read from config file
  const aiConfig = config.context?.ai || {};
  const provider = aiConfig.provider || 'openai';
  const model = aiConfig.model || 'gpt-4o';
  const apiKeySecretName = aiConfig.api_key_secret || 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeySecretName] || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  core.info(`AI provider: ${provider}, model: ${model}`);

  // Check if current branch should trigger
  if (!triggerBranches.includes(GITHUB_REF_NAME)) {
    core.info(`Branch ${GITHUB_REF_NAME} not in trigger_branches [${triggerBranches.join(', ')}] - skipping`);
    return;
  }

  // Get changed files
  const changedFiles = getChangedFiles();
  core.info(`Changed files: ${changedFiles.length}`);

  if (changedFiles.length === 0) {
    core.info('No relevant files changed - skipping');
    core.setOutput('files_updated', 'false');
    return;
  }

  for (const f of changedFiles) {
    core.info(`  ${f.status} ${f.path}`);
  }

  // Load context docs
  const contextDocs = loadContextDocs();
  core.info(`Context docs found: ${contextDocs.length}`);

  if (contextDocs.length === 0) {
    core.info('No context docs found in .context/ - skipping');
    core.setOutput('files_updated', 'false');
    return;
  }

  // Map changed files to context docs
  const changedPaths = changedFiles.map(f => f.path);
  const docToChangedFiles = mapChangedFilesToDocs(changedPaths, contextDocs);

  core.info(`Context docs affected: ${docToChangedFiles.size}`);

  if (docToChangedFiles.size === 0) {
    core.info('No context docs cover the changed files - skipping');
    core.setOutput('files_updated', 'false');
    return;
  }

  // Process each affected doc
  const updatedFiles = [];
  const errors = [];
  let checked = 0;
  let regenerated = 0;
  let skipped = 0;

  for (const [docPath, affectedFiles] of docToChangedFiles) {
    checked++;
    const doc = contextDocs.find(d => d.path === docPath);
    if (!doc) continue;

    core.info(`\nProcessing: ${doc.filename}`);
    core.info(`  Triggered by: ${affectedFiles.join(', ')}`);

    // Skip constraints-and-gotchas files (append-only)
    if (doc.filename.includes('constraints-and-gotchas')) {
      core.info('  Skipping: append-only file (constraints-and-gotchas)');
      skipped++;
      continue;
    }

    // Read source files
    const sourceFiles = readSourceFiles(doc.coversPaths);
    core.info(`  Source files read: ${sourceFiles.length}`);

    if (sourceFiles.length === 0) {
      core.warning(`  No source files found for covers-paths - skipping`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      core.info(`  [DRY RUN] Would regenerate this doc`);
      continue;
    }

    // Call AI to regenerate
    try {
      core.info(`  Calling ${provider} API...`);
      const updatedContent = await regenerateContextDoc(
        doc.content,
        sourceFiles,
        today,
        { provider, model, apiKey }
      );

      // Validate AI response
      const validation = validateAIResponse(updatedContent);
      if (!validation.valid) {
        core.error(`  AI response validation failed: ${validation.error}`);
        errors.push({ file: doc.filename, error: validation.error });
        continue;
      }

      // Write updated file
      fs.writeFileSync(doc.filePath, updatedContent);
      updatedFiles.push(doc.path);
      regenerated++;
      core.info(`  ✓ Updated`);

      // Rate limit delay
      await delay(1500);

    } catch (e) {
      core.error(`  ✗ Failed: ${e.message}`);
      errors.push({ file: doc.filename, error: e.message });
    }
  }

  // Summary
  core.info('\n=== Summary ===');
  core.info(`Files checked: ${checked}`);
  core.info(`Files regenerated: ${regenerated}`);
  core.info(`Files skipped: ${skipped}`);
  core.info(`Errors: ${errors.length}`);

  if (errors.length > 0) {
    core.warning('Errors encountered:');
    for (const err of errors) {
      core.warning(`  ${err.file}: ${err.error}`);
    }
  }

  // Commit changes if any
  if (updatedFiles.length > 0 && !DRY_RUN) {
    core.info('\nCommitting changes...');

    const token = CONTEXT_STANDARDS_PAT || GITHUB_TOKEN;
    const [owner, repo] = GITHUB_REPOSITORY.split('/');

    // Read updated file contents for commit
    const filesToCommit = updatedFiles.map(p => ({
      path: p,
      content: fs.readFileSync(path.join(REPO_ROOT, p), 'utf8')
    }));

    try {
      const result = await createCommit({
        owner,
        repo,
        branch: GITHUB_REF_NAME,
        files: filesToCommit,
        message: `chore(context): auto-update context docs [skip ci]\n\nUpdated: ${updatedFiles.join(', ')}`,
        token
      });

      if (result) {
        core.info(`✓ Committed: ${result.sha}`);
      } else {
        core.info('No changes to commit');
      }
    } catch (e) {
      core.error(`Failed to commit: ${e.message}`);
      // Don't fail the whole run for commit issues
    }
  }

  // Set outputs
  core.setOutput('files_updated', (updatedFiles.length > 0).toString());
  core.setOutput('updated_files', updatedFiles.join(','));
  core.setOutput('files_checked', checked.toString());
  core.setOutput('files_regenerated', regenerated.toString());
  core.setOutput('files_skipped', skipped.toString());
  core.setOutput('errors', errors.length.toString());
}

// Run
main().catch(e => {
  core.error(`Context update action failed: ${e.message}`);
  core.setFailed(e.message);
  process.exit(1);
});

