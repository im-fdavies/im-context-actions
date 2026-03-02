/**
 * utils/glob-matcher.js
 * Match file paths against covers-paths globs using micromatch.
 * Paths are always relative to repo root.
 */

import micromatch from 'micromatch';

/**
 * Check if a file path matches any of the covers-paths glob patterns.
 * @param {string} filePath - Relative path to the file (from repo root)
 * @param {string[]} coversPaths - Array of glob patterns from frontmatter
 * @returns {boolean} - True if the file matches any pattern
 */
export function matchesCoversPaths(filePath, coversPaths) {
  if (!filePath || !Array.isArray(coversPaths) || coversPaths.length === 0) {
    return false;
  }

  // Normalize the file path (remove leading ./ if present)
  const normalizedPath = filePath.replace(/^\.\//, '');

  return micromatch.isMatch(normalizedPath, coversPaths, {
    dot: true,
    matchBase: false
  });
}

/**
 * Find all context docs that cover a given file path.
 * @param {string} filePath - Relative path to the changed file
 * @param {Array<{path: string, coversPaths: string[]}>} contextDocs - Array of context doc metadata
 * @returns {string[]} - Array of context doc paths that cover this file
 */
export function findCoveringDocs(filePath, contextDocs) {
  return contextDocs
    .filter(doc => matchesCoversPaths(filePath, doc.coversPaths))
    .map(doc => doc.path);
}

/**
 * Given a list of changed files and context docs, return a map of
 * context doc paths to the changed files they cover.
 * @param {string[]} changedFiles - Array of changed file paths
 * @param {Array<{path: string, coversPaths: string[]}>} contextDocs - Array of context doc metadata
 * @returns {Map<string, string[]>} - Map of context doc path to array of changed files it covers
 */
export function mapChangedFilesToDocs(changedFiles, contextDocs) {
  const docToFiles = new Map();

  for (const filePath of changedFiles) {
    for (const doc of contextDocs) {
      if (matchesCoversPaths(filePath, doc.coversPaths)) {
        if (!docToFiles.has(doc.path)) {
          docToFiles.set(doc.path, []);
        }
        docToFiles.get(doc.path).push(filePath);
      }
    }
  }

  return docToFiles;
}

/**
 * Expand glob patterns to actual file paths.
 * This is a simple wrapper that returns the patterns as-is since
 * actual file expansion is done at read time using fs.
 * @param {string[]} patterns - Glob patterns
 * @returns {string[]} - The patterns (for use with micromatch.match)
 */
export function expandGlobs(patterns) {
  return patterns;
}
