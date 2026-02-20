/**
 * utils/frontmatter.js
 * Parse, read, and update YAML frontmatter in .context/*.md files
 */

const yaml = require('js-yaml');

const FRONTMATTER_REGEX = /^---\n([\s\S]+?)\n---\n/;

/**
 * Parse frontmatter from a markdown string.
 * @returns {{ frontmatter: object, body: string } | null}
 */
function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return null;

  try {
    const frontmatter = yaml.load(match[1]);
    const body = content.slice(match[0].length);
    return { frontmatter, body };
  } catch (e) {
    console.error('Failed to parse frontmatter:', e.message);
    return null;
  }
}

/**
 * Rebuild a markdown file with updated frontmatter.
 * Preserves the body content exactly.
 */
function serializeFrontmatter(frontmatter, body) {
  const fm = yaml.dump(frontmatter, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true
  });
  return `---\n${fm}---\n${body}`;
}

/**
 * Update specific frontmatter fields without touching the body.
 * @param {string} content - full file content
 * @param {object} updates - key/value pairs to merge into frontmatter
 * @returns {string} updated file content
 */
function updateFrontmatter(content, updates) {
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new Error('Cannot update frontmatter: no valid frontmatter block found');
  }

  const updated = { ...parsed.frontmatter, ...updates };
  return serializeFrontmatter(updated, parsed.body);
}

/**
 * Stamp the last-updated fields on a context file.
 * Called after the AI has updated a file's content.
 */
function stampLastUpdated(content, commitSha, date) {
  return updateFrontmatter(content, {
    'last-updated-date': date || new Date().toISOString().split('T')[0],
    'last-updated-commit': commitSha
  });
}

module.exports = { parseFrontmatter, serializeFrontmatter, updateFrontmatter, stampLastUpdated };
