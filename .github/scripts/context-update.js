/**
 * context-update.js
 * Main script for the context update action.
 * Run by: .github/workflows/context-update.yml
 *
 * Flow:
 * 1. Parse changed files from env
 * 2. Map to affected context docs via covers-paths
 * 3. For each affected doc: call AI to update it
 * 4. Special-case constraints-and-gotchas.md (append-only + gotcha detection)
 * 5. Validate tags against taxonomy
 * 6. Write updated files
 * 7. Set action outputs
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { mapChangedFilesToContextDocs, readChangedFileContents } = require('./utils/diff-mapper');
const { parseFrontmatter, stampLastUpdated, updateFrontmatter } = require('./utils/frontmatter');
const { callAI } = require('./utils/ai-client');
const { fetchTaxonomy, buildApprovedTagSets, validateTags, buildPendingProposals } = require('./utils/taxonomy');

// -----------------------------------------------------------------------
// Environment
// -----------------------------------------------------------------------
const REPO_ROOT = process.cwd();
const CHANGED_FILES = JSON.parse(process.env.CHANGED_FILES || '[]');
const COMMIT_SHA = process.env.COMMIT_SHA || '';
const COMMIT_MESSAGE = process.env.COMMIT_MESSAGE || '';
const STANDARDS_REPO = process.env.STANDARDS_REPO || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const TODAY = new Date().toISOString().split('T')[0];

// Detect if this commit has a [gotcha] tag in the message
const IS_GOTCHA_COMMIT = /\[gotcha\]/i.test(COMMIT_MESSAGE);

// -----------------------------------------------------------------------
// GitHub Actions output helper
// -----------------------------------------------------------------------
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  } else {
    console.log(`OUTPUT ${name}=${value}`);
  }
}

// -----------------------------------------------------------------------
// Build the system prompt for context doc updates
// -----------------------------------------------------------------------
function buildSystemPrompt() {
  return `You are a senior software architect maintaining AI-readable context documentation for a codebase.

Your job is to update a specific .context/*.md file based on changes that were just pushed to the repository.

RULES — non-negotiable:
1. Return ONLY the updated markdown file content. No explanation, no preamble, no code fences around the whole response.
2. Preserve the YAML frontmatter block exactly — only update these frontmatter fields if needed: tags, covers-paths, confidence, intents. Never change title, version, generated, scope.
3. Update the body content to accurately reflect the changed code. Be surgical — only update sections that are actually affected by the diff.
4. If a section is unaffected, reproduce it exactly as-is.
5. Never invent code examples. Only reference actual code from the diff or existing codebase context provided.
6. If the diff shows a deletion (status: D), update the relevant section to remove references to the deleted code.
7. Confidence score: set this honestly. If you can fully verify the update from the diff provided, use 0.85-0.95. If you're inferring, use 0.65-0.80.
8. Tags: only use tags that are listed in the APPROVED TAXONOMY provided. If you need a tag not in the taxonomy, add it to tags-pending-approval as: { tag: "name", category: "category", reason: "why it's needed" }.
9. DO NOT touch constraints-and-gotchas.md body content — that file is handled separately.`;
}

// -----------------------------------------------------------------------
// Build the user prompt for a specific context doc update
// -----------------------------------------------------------------------
function buildUpdatePrompt(contextDoc, changedFileContents, approvedTagSets) {
  const approvedTagsSummary = Object.entries(approvedTagSets)
    .map(([cat, set]) => `${cat}: [${Array.from(set).join(', ')}]`)
    .join('\n');

  const changedFilesFormatted = changedFileContents
    .map(f => {
      if (f.status === 'D') return `### DELETED: ${f.path}\n(file was removed)`;
      return `### ${f.status === 'A' ? 'ADDED' : 'MODIFIED'}: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``;
    })
    .join('\n\n');

  return `## Context Document to Update

File: ${contextDoc.relativePath}

Current content:
---
${yaml.dump(contextDoc.frontmatter)}---
${contextDoc.body}

---

## Changed Source Files (the diff that triggered this update)

${changedFilesFormatted}

---

## Approved Taxonomy Tags

${approvedTagsSummary}

---

Update the context document to accurately reflect these changes.
Return the complete updated file content — frontmatter block included.`;
}

// -----------------------------------------------------------------------
// Build gotcha detection prompt
// -----------------------------------------------------------------------
function buildGotchaPrompt(commitMessage, changedFileContents, existingGotchas) {
  const changedSummary = changedFileContents
    .filter(f => f.content)
    .map(f => `${f.path}:\n${f.content?.slice(0, 2000) || ''}`)
    .join('\n\n---\n\n');

  return `You are reviewing a code commit to determine if it should be recorded as a "gotcha" — a non-obvious problem that was solved and should be documented so others don't hit the same issue.

## Commit Message
${commitMessage}

## Changed Files
${changedSummary}

## Existing Gotcha IDs (for sequential numbering)
${existingGotchas.length > 0 ? existingGotchas.map(g => g.id).join(', ') : 'None yet — start at GOTCHA-001'}

---

TASK:
1. Determine if this commit represents a non-obvious problem worth documenting.
2. A commit is worth a gotcha entry if: it fixes something that took significant investigation, the fix is non-obvious, or future developers would likely hit the same wall.
3. If NOT worth a gotcha entry, respond with exactly: NO_GOTCHA
4. If YES, respond with exactly this format and nothing else:

### [GOTCHA-NNN] <Short descriptive title>

**tags:** <comma-separated relevant tags>
**severity:** critical | high | medium | low
**added-commit:** ${COMMIT_SHA}
**added-date:** ${TODAY}
**disciplines:** <comma-separated discipline tags>
**affects-paths:**
  - <path>

**Problem**
<What happens and why it's non-obvious>

**What Was Tried**
<Approaches that don't work and why — infer from commit message and diff if not explicit>

**Solution**
<What actually works — based on the diff>

**Reference**
Commit: ${COMMIT_SHA}`;
}

// -----------------------------------------------------------------------
// Parse existing gotcha IDs from constraints-and-gotchas.md
// -----------------------------------------------------------------------
function parseExistingGotchaIds(content) {
  const matches = content.matchAll(/###\s+\[(GOTCHA-\d+)\]/g);
  return Array.from(matches).map(m => ({ id: m[1] }));
}

// -----------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------
async function main() {
  console.log(`\n=== Context Update Action ===`);
  console.log(`Commit: ${COMMIT_SHA}`);
  console.log(`Gotcha commit: ${IS_GOTCHA_COMMIT}`);
  console.log(`Changed files: ${CHANGED_FILES.length}`);

  if (CHANGED_FILES.length === 0) {
    console.log('No relevant files changed — exiting');
    setOutput('files_updated', 'false');
    return;
  }

  // 1. Fetch taxonomy
  console.log(`\nFetching taxonomy from ${STANDARDS_REPO}...`);
  let approvedTagSets = {};
  try {
    const taxonomy = await fetchTaxonomy(STANDARDS_REPO, GITHUB_TOKEN);
    approvedTagSets = buildApprovedTagSets(taxonomy);
    console.log(`✓ Taxonomy loaded. Categories: ${Object.keys(approvedTagSets).join(', ')}`);
  } catch (e) {
    console.warn(`⚠ Could not fetch taxonomy: ${e.message}. Proceeding without tag validation.`);
  }

  // 2. Map changed files to context docs
  const affectedDocs = mapChangedFilesToContextDocs(CHANGED_FILES, REPO_ROOT);
  console.log(`\nAffected context docs: ${affectedDocs.map(d => d.relativePath).join(', ')}`);

  if (affectedDocs.length === 0) {
    console.log('No context docs affected by these changes — exiting');
    setOutput('files_updated', 'false');
    return;
  }

  // 3. Read changed file contents (chunked)
  const changedFileContents = readChangedFileContents(CHANGED_FILES, REPO_ROOT);

  const updatedFiles = [];
  const allPendingTags = [];

  for (const doc of affectedDocs) {
    console.log(`\nProcessing: ${doc.relativePath}`);

    // ---------------------------------------------------------------
    // SPECIAL CASE: constraints-and-gotchas.md (append-only)
    // ---------------------------------------------------------------
    if (doc.relativePath.includes('constraints-and-gotchas')) {
      const fullContent = fs.readFileSync(doc.contextFilePath, 'utf8');
      const existingGotchas = parseExistingGotchaIds(fullContent);

      // Only run gotcha detection if [gotcha] in commit message OR it's a push to main
      const shouldCheckGotcha = IS_GOTCHA_COMMIT || process.env.FORCE_GOTCHA_CHECK === 'true';

      if (!shouldCheckGotcha) {
        console.log('  Skipping gotcha check — no [gotcha] tag in commit message');
        // Still stamp the last-updated fields
        const stamped = stampLastUpdated(fullContent, COMMIT_SHA, TODAY);
        fs.writeFileSync(doc.contextFilePath, stamped);
        updatedFiles.push(doc.relativePath);
        continue;
      }

      console.log('  Running gotcha detection...');
      const gotchaResponse = await callAI(
        `You are a technical documentation assistant. Analyze this commit and determine if it warrants a gotcha entry. Be conservative — only flag genuinely non-obvious problems.`,
        buildGotchaPrompt(COMMIT_MESSAGE, changedFileContents, existingGotchas)
      );

      if (gotchaResponse.trim() === 'NO_GOTCHA') {
        console.log('  No gotcha detected');
        const stamped = stampLastUpdated(fullContent, COMMIT_SHA, TODAY);
        fs.writeFileSync(doc.contextFilePath, stamped);
        updatedFiles.push(doc.relativePath);
        continue;
      }

      // Append the new gotcha entry to the Gotchas section
      const gotchasSection = '## Gotchas';
      const insertionPoint = fullContent.indexOf(gotchasSection);

      let updatedContent;
      if (insertionPoint === -1) {
        // Append to end if section not found
        updatedContent = fullContent.trimEnd() + '\n\n' + gotchaResponse.trim() + '\n';
      } else {
        // Find the end of the Gotchas section (next ## heading or end of file)
        const afterSection = fullContent.indexOf('\n## ', insertionPoint + gotchasSection.length);
        const insertAt = afterSection === -1 ? fullContent.length : afterSection;
        updatedContent = fullContent.slice(0, insertAt) + '\n\n' + gotchaResponse.trim() + '\n' + fullContent.slice(insertAt);
      }

      const stamped = stampLastUpdated(updatedContent, COMMIT_SHA, TODAY);
      fs.writeFileSync(doc.contextFilePath, stamped);
      updatedFiles.push(doc.relativePath);
      console.log(`  ✓ Gotcha entry appended`);
      continue;
    }

    // ---------------------------------------------------------------
    // STANDARD context doc update
    // ---------------------------------------------------------------
    const relevantFiles = changedFileContents.filter(f =>
      doc.matchedBy.includes(f.path)
    );

    if (relevantFiles.length === 0) {
      console.log('  No relevant file contents — skipping');
      continue;
    }

    try {
      const updatedContent = await callAI(
        buildSystemPrompt(),
        buildUpdatePrompt(doc, relevantFiles, approvedTagSets)
      );

      if (!updatedContent || updatedContent.trim().length < 50) {
        console.warn(`  ⚠ AI returned empty/short response — skipping`);
        continue;
      }

      // Stamp last-updated fields
      const stamped = stampLastUpdated(updatedContent, COMMIT_SHA, TODAY);

      // Validate tags in the updated content
      const parsed = parseFrontmatter(stamped);
      if (parsed && Object.keys(approvedTagSets).length > 0) {
        const validation = validateTags(parsed.frontmatter.tags || {}, approvedTagSets);
        if (!validation.valid) {
          console.warn(`  ⚠ Unknown tags found: ${validation.unknown.map(t => `${t.category}/${t.tag}`).join(', ')}`);
          const proposals = buildPendingProposals(
            validation.unknown,
            doc.relativePath
          );
          allPendingTags.push(...proposals);

          // Move unknown tags to pending-approval in the file
          const pendingApproval = [
            ...(parsed.frontmatter['tags-pending-approval'] || []),
            ...proposals
          ];
          const withPending = updateFrontmatter(stamped, {
            tags: validation.approved,
            'tags-pending-approval': pendingApproval
          });
          fs.writeFileSync(doc.contextFilePath, withPending);
        } else {
          fs.writeFileSync(doc.contextFilePath, stamped);
        }
      } else {
        fs.writeFileSync(doc.contextFilePath, stamped);
      }

      updatedFiles.push(doc.relativePath);
      console.log(`  ✓ Updated`);

    } catch (e) {
      console.error(`  ✗ Failed to update ${doc.relativePath}: ${e.message}`);
      // Don't crash the whole action for one doc — log and continue
    }
  }

  // -----------------------------------------------------------------------
  // Set action outputs
  // -----------------------------------------------------------------------
  const filesUpdated = updatedFiles.length > 0;
  setOutput('files_updated', filesUpdated.toString());
  setOutput('updated_files_list', updatedFiles.join(', '));
  setOutput('updated_files_list_json', JSON.stringify(updatedFiles));
  setOutput('has_pending_tags', (allPendingTags.length > 0).toString());
  setOutput('pending_tags_json', JSON.stringify(allPendingTags));

  console.log(`\n=== Done ===`);
  console.log(`Files updated: ${updatedFiles.length}`);
  console.log(`Pending taxonomy proposals: ${allPendingTags.length}`);
}

main().catch(e => {
  console.error('Context update action failed:', e);
  process.exit(1);
});
