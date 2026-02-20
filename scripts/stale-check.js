/**
 * stale-check.js
 * Finds context docs that haven't been updated within the stale threshold
 * and re-verifies them against the current codebase.
 *
 * Run by: .github/workflows/context-stale-check.yml (weekly schedule)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { loadContextCoverageMap, readChangedFileContents } = require('./utils/diff-mapper');
const { parseFrontmatter, stampLastUpdated, updateFrontmatter } = require('./utils/frontmatter');
const { callAI } = require('./utils/ai-client');
const { fetchTaxonomy, buildApprovedTagSets, validateTags, buildPendingProposals } = require('./utils/taxonomy');

const REPO_ROOT = process.cwd();
const STANDARDS_REPO = process.env.STANDARDS_REPO || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS || '30');
const FORCE_ALL = process.env.FORCE_ALL === 'true';
const TODAY = new Date().toISOString().split('T')[0];

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${name}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  }
}

function daysSince(dateStr) {
  if (!dateStr) return 9999;
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function buildStaleCheckPrompt(contextDoc, currentFileContents, approvedTagSets) {
  const approvedTagsSummary = Object.entries(approvedTagSets)
    .map(([cat, set]) => `${cat}: [${Array.from(set).join(', ')}]`)
    .join('\n');

  const filesFormatted = currentFileContents
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  return `You are auditing a context documentation file to verify it is still accurate.

## Context Document (may be stale)

File: ${contextDoc.relativePath}
Last updated: ${contextDoc.frontmatter['last-updated-date'] || 'unknown'}

Current content:
---
${require('js-yaml').dump(contextDoc.frontmatter)}---
${contextDoc.body}

---

## Current Source Files This Document Covers

${filesFormatted}

---

## Approved Taxonomy Tags

${approvedTagsSummary}

---

TASK:
1. Compare the context document against the current source files.
2. Identify any inaccuracies, outdated references, missing patterns, or incorrect code examples.
3. Return the fully corrected context document.
4. If the document is still accurate with no changes needed, respond with exactly: STILL_ACCURATE
5. Set confidence score honestly based on how thoroughly you verified it.
6. Only update sections that are actually wrong — preserve accurate sections exactly.
7. Return ONLY the updated markdown content or STILL_ACCURATE. No explanation.`;
}

async function main() {
  console.log(`\n=== Context Stale Check ===`);
  console.log(`Stale threshold: ${STALE_THRESHOLD_DAYS} days`);
  console.log(`Force all: ${FORCE_ALL}`);

  // Load taxonomy
  let approvedTagSets = {};
  try {
    const taxonomy = await fetchTaxonomy(STANDARDS_REPO, GITHUB_TOKEN);
    approvedTagSets = buildApprovedTagSets(taxonomy);
    console.log(`✓ Taxonomy loaded`);
  } catch (e) {
    console.warn(`⚠ Could not fetch taxonomy: ${e.message}`);
  }

  // Load all context docs
  const allDocs = loadContextCoverageMap(REPO_ROOT);
  console.log(`Found ${allDocs.length} context docs`);

  // Filter to stale ones
  const staleDocs = FORCE_ALL
    ? allDocs
    : allDocs.filter(doc => {
        // Skip append-only files
        if (doc.frontmatter?.tags?.sensitivity?.includes('append-only')) return false;
        if (doc.relativePath.includes('constraints-and-gotchas')) return false;

        const age = daysSince(doc.frontmatter?.['last-updated-date']);
        const isStale = age > STALE_THRESHOLD_DAYS;
        if (isStale) console.log(`  Stale (${age}d): ${doc.relativePath}`);
        return isStale;
      });

  console.log(`\nDocs to check: ${staleDocs.length}`);

  if (staleDocs.length === 0) {
    console.log('Nothing stale — exiting');
    setOutput('files_updated', 'false');
    setOutput('updated_files_list', '');
    return;
  }

  const updatedFiles = [];

  for (const doc of staleDocs) {
    console.log(`\nChecking: ${doc.relativePath}`);

    // Read the current versions of the source files this doc covers
    const coveredPaths = doc.coversPaths || [];
    const sourceFiles = [];

    for (const pattern of coveredPaths) {
      try {
        // Expand glob to actual files using git ls-files
        const files = execSync(`git ls-files "${pattern}" 2>/dev/null || find . -path "./${pattern}" -type f 2>/dev/null`)
          .toString().trim().split('\n').filter(Boolean);

        for (const f of files.slice(0, 10)) { // cap at 10 files per pattern
          if (fs.existsSync(f)) {
            const content = fs.readFileSync(f, 'utf8');
            sourceFiles.push({
              path: f,
              content: content.length > 6000 ? content.slice(0, 6000) + '\n[...truncated]' : content
            });
          }
        }
      } catch {
        // Pattern didn't match anything — skip
      }
    }

    if (sourceFiles.length === 0) {
      console.log('  No source files found for covered paths — skipping');
      continue;
    }

    try {
      const response = await callAI(
        `You are auditing technical documentation for accuracy. Be thorough but conservative — only flag genuine inaccuracies, not stylistic preferences.`,
        buildStaleCheckPrompt(doc, sourceFiles, approvedTagSets)
      );

      if (response.trim() === 'STILL_ACCURATE') {
        console.log('  ✓ Still accurate — just stamping date');
        // Still stamp the last-updated fields so we reset the stale clock
        const fullContent = fs.readFileSync(doc.contextFilePath, 'utf8');
        const stamped = stampLastUpdated(fullContent, 'stale-check', TODAY);
        fs.writeFileSync(doc.contextFilePath, stamped);
        updatedFiles.push(doc.relativePath);
        continue;
      }

      const stamped = stampLastUpdated(response, 'stale-check', TODAY);
      fs.writeFileSync(doc.contextFilePath, stamped);
      updatedFiles.push(doc.relativePath);
      console.log(`  ✓ Updated`);

    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
    }
  }

  setOutput('files_updated', (updatedFiles.length > 0).toString());
  setOutput('updated_files_list', updatedFiles.join(', '));

  console.log(`\n=== Done ===`);
  console.log(`Files checked: ${staleDocs.length}`);
  console.log(`Files updated: ${updatedFiles.length}`);
}

main().catch(e => {
  console.error('Stale check failed:', e);
  process.exit(1);
});
