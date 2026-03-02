/**
 * stale-check.js
 * Entrypoint for the context stale check workflow.
 *
 * Runs on a schedule to identify context docs that haven't been updated
 * within the stale threshold and verifies them against current source code.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import * as core from '@actions/core';
import yaml from 'js-yaml';

import { parse, serialize, updateLastUpdated } from './utils/frontmatter.js';
import { verifyContextDoc, delay } from './utils/ai-client.js';
import { createCommit, findOpenIssue, createIssue } from './utils/github-client.js';

// -----------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------
const REPO_ROOT = process.cwd();
const CONTEXT_DIR = path.join(REPO_ROOT, '.context');
const MAX_FILE_CHARS = 6000;
const MAX_TOTAL_CHARS = 40000;
const CONFIDENCE_THRESHOLD = 0.85;
const DRY_RUN = process.env.DRY_RUN === 'true';

// -----------------------------------------------------------------------
// Environment variables (set by the workflow)
// -----------------------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CONTEXT_STANDARDS_PAT = process.env.CONTEXT_STANDARDS_PAT;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_REF_NAME = process.env.GITHUB_REF_NAME || 'main';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function getToday() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Calculate days since a date string.
 */
function daysSince(dateStr) {
  if (!dateStr) return 9999;
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
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

    docs.push({
      path: `.context/${filename}`,
      filePath,
      filename,
      content,
      meta: parsed.meta,
      body: parsed.body,
      coversPaths: parsed.meta['covers-paths'] || [],
      lastUpdated: parsed.meta['last-updated']
    });
  }

  return docs;
}

/**
 * Read source files covered by a context doc.
 */
function readSourceFiles(coversPaths, maxTotalChars = MAX_TOTAL_CHARS) {
  const files = [];
  let totalChars = 0;

  for (const pattern of coversPaths) {
    try {
      const matches = execSync(`git ls-files "${pattern}" 2>/dev/null || true`, { encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean);

      for (const filePath of matches) {
        if (totalChars >= maxTotalChars) break;

        const fullPath = path.join(REPO_ROOT, filePath);
        if (!fs.existsSync(fullPath)) continue;

        try {
          let content = fs.readFileSync(fullPath, 'utf8');

          if (content.length > MAX_FILE_CHARS) {
            content = content.slice(0, MAX_FILE_CHARS) + '\n\n[... truncated ...]';
          }

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
 * Check if a file is append-only (constraints-and-gotchas).
 */
function isAppendOnly(filename) {
  return filename.includes('constraints-and-gotchas');
}

// -----------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------

async function main() {
  const today = getToday();

  core.info('=== Context Stale Check ===');
  core.info(`Date: ${today}`);
  core.info(`Repository: ${GITHUB_REPOSITORY}`);
  core.info(`Dry run: ${DRY_RUN}`);

  // Load config
  const config = loadConfig();
  const staleThresholdDays = config.context?.stale_threshold_days || 90;
  
  // AI config - read from config file
  const aiConfig = config.context?.ai || {};
  const provider = aiConfig.provider || 'openai';
  const model = aiConfig.model || 'gpt-4o';
  const apiKeySecretName = aiConfig.api_key_secret || 'OPENAI_API_KEY';
  const apiKey = process.env[apiKeySecretName] || process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  core.info(`Stale threshold: ${staleThresholdDays} days`);
  core.info(`AI provider: ${provider}, model: ${model}`);

  // Load context docs
  const contextDocs = loadContextDocs();
  core.info(`Context docs found: ${contextDocs.length}`);

  if (contextDocs.length === 0) {
    core.info('No context docs found in .context/ - nothing to check');
    core.setOutput('files_updated', 'false');
    return;
  }

  // Filter to stale docs
  const staleDocs = contextDocs.filter(doc => {
    const age = daysSince(doc.lastUpdated);
    const isStale = age > staleThresholdDays;
    if (isStale) {
      core.info(`  Stale (${age} days): ${doc.filename}`);
    }
    return isStale;
  });

  core.info(`\nStale docs to check: ${staleDocs.length}`);

  if (staleDocs.length === 0) {
    core.info('No stale context docs - nothing to check');
    core.setOutput('files_updated', 'false');
    return;
  }

  // Process each stale doc
  const updatedFiles = [];
  const issuesOpened = [];
  const errors = [];
  let checked = 0;
  let refreshed = 0;
  let flagged = 0;
  let skipped = 0;

  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  const token = CONTEXT_STANDARDS_PAT || GITHUB_TOKEN;

  for (const doc of staleDocs) {
    checked++;
    core.info(`\nChecking: ${doc.filename}`);
    core.info(`  Last updated: ${doc.lastUpdated || 'unknown'}`);

    // Read source files
    const sourceFiles = readSourceFiles(doc.coversPaths);
    core.info(`  Source files read: ${sourceFiles.length}`);

    if (sourceFiles.length === 0) {
      core.warning(`  No source files found for covers-paths - skipping`);
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      core.info(`  [DRY RUN] Would verify this doc`);
      continue;
    }

    try {
      core.info(`  Verifying with ${provider} API...`);
      const result = await verifyContextDoc(doc.content, sourceFiles, { provider, model, apiKey });

      core.info(`  Accurate: ${result.accurate}, Confidence: ${result.confidence.toFixed(2)}`);
      if (result.issues.length > 0) {
        core.info(`  Issues: ${result.issues.join('; ')}`);
      }

      // Handle append-only files differently
      if (isAppendOnly(doc.filename)) {
        if (!result.accurate || result.confidence < CONFIDENCE_THRESHOLD) {
          // Open issue but don't modify
          const issueTitle = `[context] Stale doc needs review: ${doc.path}`;

          const existingIssue = await findOpenIssue({ owner, repo, title: issueTitle, token });
          if (existingIssue) {
            core.info(`  Issue already exists: #${existingIssue.number}`);
          } else {
            const issueBody = `## Stale Context Document

**File:** \`${doc.path}\`
**Last updated:** ${doc.lastUpdated || 'unknown'}
**Confidence:** ${result.confidence.toFixed(2)}

### Issues Found

${result.issues.map(i => `- ${i}`).join('\n')}

### Action Required

This is an append-only file (\`constraints-and-gotchas\`) and cannot be auto-modified.
Please review and update manually if needed.

---
*This issue was automatically created by the context stale check workflow.*`;

            const issue = await createIssue({
              owner,
              repo,
              title: issueTitle,
              body: issueBody,
              labels: ['context-stale'],
              token
            });
            core.info(`  ✓ Opened issue: #${issue.number}`);
            issuesOpened.push(doc.path);
            flagged++;
          }
        } else {
          core.info(`  Append-only file is still accurate - no action needed`);
        }
        continue;
      }

      // Standard doc handling
      if (result.accurate && result.confidence >= CONFIDENCE_THRESHOLD) {
        // Still accurate - just bump the date
        const updatedMeta = updateLastUpdated(doc.meta, today);
        const updatedContent = serialize(updatedMeta, doc.body);
        fs.writeFileSync(doc.filePath, updatedContent);
        updatedFiles.push(doc.path);
        refreshed++;
        core.info(`  ✓ Refreshed (still accurate)`);
      } else {
        // Not accurate or low confidence - open an issue
        const issueTitle = `[context] Stale doc needs review: ${doc.path}`;

        const existingIssue = await findOpenIssue({ owner, repo, title: issueTitle, token });
        if (existingIssue) {
          core.info(`  Issue already exists: #${existingIssue.number}`);
        } else {
          const issueBody = `## Stale Context Document

**File:** \`${doc.path}\`
**Last updated:** ${doc.lastUpdated || 'unknown'}
**Confidence:** ${result.confidence.toFixed(2)}

### Issues Found

${result.issues.length > 0 ? result.issues.map(i => `- ${i}`).join('\n') : '- Low confidence in accuracy assessment'}

### Action Required

Please review this context document and update it to reflect the current state of the source code.

---
*This issue was automatically created by the context stale check workflow.*`;

          const issue = await createIssue({
            owner,
            repo,
            title: issueTitle,
            body: issueBody,
            labels: ['context-stale'],
            token
          });
          core.info(`  ✓ Opened issue: #${issue.number}`);
          issuesOpened.push(doc.path);
          flagged++;
        }
      }

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
  core.info(`Files refreshed: ${refreshed}`);
  core.info(`Files flagged: ${flagged}`);
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
        message: `chore(context): refresh stale context docs [skip ci]\n\nRefreshed: ${updatedFiles.join(', ')}`,
        token
      });

      if (result) {
        core.info(`✓ Committed: ${result.sha}`);
      } else {
        core.info('No changes to commit');
      }
    } catch (e) {
      core.error(`Failed to commit: ${e.message}`);
    }
  }

  // Set outputs
  core.setOutput('files_updated', (updatedFiles.length > 0).toString());
  core.setOutput('updated_files', updatedFiles.join(','));
  core.setOutput('issues_opened', issuesOpened.join(','));
  core.setOutput('files_checked', checked.toString());
  core.setOutput('files_refreshed', refreshed.toString());
  core.setOutput('files_flagged', flagged.toString());
  core.setOutput('errors', errors.length.toString());
}

// Run
main().catch(e => {
  core.error(`Stale check action failed: ${e.message}`);
  core.setFailed(e.message);
  process.exit(1);
});

