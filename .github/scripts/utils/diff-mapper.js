/**
 * utils/diff-mapper.js
 * Maps changed source files → the .context/*.md files that cover them,
 * using the covers-paths globs in each context file's frontmatter.
 *
 * This is the core of the path-match routing strategy.
 */

const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');
const { parseFrontmatter } = require('./frontmatter');

/**
 * Load all context files from .context/ and build a coverage map.
 * Returns: Array of { contextFilePath, frontmatter, coversPaths }
 */
function loadContextCoverageMap(repoRoot = process.cwd()) {
  const contextDir = path.join(repoRoot, '.context');

  if (!fs.existsSync(contextDir)) {
    return [];
  }

  const files = fs.readdirSync(contextDir)
    .filter(f => f.endsWith('.md') && f !== '_index.md')
    .map(f => path.join(contextDir, f));

  const coverageMap = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseFrontmatter(content);

    if (!parsed || !parsed.frontmatter['covers-paths']) continue;

    coverageMap.push({
      contextFilePath: filePath,
      relativePath: path.relative(repoRoot, filePath),
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      coversPaths: parsed.frontmatter['covers-paths'] || []
    });
  }

  return coverageMap;
}

/**
 * Given a list of changed files, return the set of context docs
 * that need updating.
 *
 * @param {Array<{status: string, path: string}>} changedFiles
 * @param {string} repoRoot
 * @returns {Array<{contextFilePath, frontmatter, body, matchedBy: string[]}>}
 */
function mapChangedFilesToContextDocs(changedFiles, repoRoot = process.cwd()) {
  const coverageMap = loadContextCoverageMap(repoRoot);
  const results = new Map(); // contextFilePath → result object

  for (const changed of changedFiles) {
    for (const entry of coverageMap) {
      const isMatch = entry.coversPaths.some(pattern =>
        minimatch(changed.path, pattern, { matchBase: true, dot: true })
      );

      if (isMatch) {
        if (!results.has(entry.contextFilePath)) {
          results.set(entry.contextFilePath, {
            contextFilePath: entry.contextFilePath,
            relativePath: entry.relativePath,
            frontmatter: entry.frontmatter,
            body: entry.body,
            matchedBy: []
          });
        }
        results.get(entry.contextFilePath).matchedBy.push(changed.path);
      }
    }
  }

  // Always include constraints-and-gotchas.md if any files changed —
  // the gotcha detector needs to run on every push
  const gotchasPath = path.join(repoRoot, '.context', 'constraints-and-gotchas.md');
  if (fs.existsSync(gotchasPath) && !results.has(gotchasPath)) {
    const content = fs.readFileSync(gotchasPath, 'utf8');
    const parsed = parseFrontmatter(content);
    if (parsed) {
      results.set(gotchasPath, {
        contextFilePath: gotchasPath,
        relativePath: '.context/constraints-and-gotchas.md',
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        matchedBy: ['__gotcha_check__'],
        isGotchaFile: true
      });
    }
  }

  return Array.from(results.values());
}

/**
 * Read the actual content of the changed source files.
 * Used to give the AI enough context to update the docs.
 * Limits to MAX_CHARS total to stay within token budget.
 */
function readChangedFileContents(changedFiles, repoRoot = process.cwd(), maxCharsTotal = 40000) {
  const contents = [];
  let totalChars = 0;

  for (const file of changedFiles) {
    if (file.status === 'D') {
      contents.push({ path: file.path, status: 'deleted', content: null });
      continue;
    }

    const fullPath = path.join(repoRoot, file.path);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      // Truncate large files — we want the structure, not every line
      const truncated = raw.length > 8000 ? raw.slice(0, 8000) + '\n\n[... truncated for context ...]' : raw;

      if (totalChars + truncated.length > maxCharsTotal) {
        contents.push({
          path: file.path,
          status: file.status,
          content: '[omitted — token budget reached]'
        });
        continue;
      }

      contents.push({ path: file.path, status: file.status, content: truncated });
      totalChars += truncated.length;
    } catch {
      contents.push({ path: file.path, status: file.status, content: '[could not read file]' });
    }
  }

  return contents;
}

module.exports = { mapChangedFilesToContextDocs, readChangedFileContents, loadContextCoverageMap };
