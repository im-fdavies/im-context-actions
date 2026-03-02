/**
 * utils/frontmatter.js
 * Parse and serialize YAML frontmatter in .context/*.md files.
 * Uses js-yaml (pure JS, no native bindings).
 */

import yaml from 'js-yaml';
import * as core from '@actions/core';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/;

const REQUIRED_FIELDS = ['title', 'intent', 'covers-paths', 'last-updated'];

/**
 * Parse frontmatter from a markdown string.
 * @param {string} fileContent - Full markdown file content
 * @returns {{ meta: object, body: string } | null} - Parsed frontmatter and body, or null if invalid
 */
export function parse(fileContent) {
  const match = fileContent.match(FRONTMATTER_REGEX);
  if (!match) {
    return null;
  }

  try {
    const meta = yaml.load(match[1]);
    const body = fileContent.slice(match[0].length);
    return { meta, body };
  } catch (e) {
    core.warning(`Failed to parse YAML frontmatter: ${e.message}`);
    return null;
  }
}

/**
 * Serialize frontmatter and body back to a markdown string.
 * @param {object} meta - Frontmatter object
 * @param {string} body - Markdown body content
 * @returns {string} - Full markdown file content
 */
export function serialize(meta, body) {
  const yamlStr = yaml.dump(meta, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
    noRefs: true,
    sortKeys: false
  });
  return `---\n${yamlStr}---\n${body}`;
}

/**
 * Validate that frontmatter contains all required fields.
 * @param {object} meta - Frontmatter object
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validate(meta) {
  if (!meta || typeof meta !== 'object') {
    return { valid: false, missing: REQUIRED_FIELDS };
  }

  const missing = REQUIRED_FIELDS.filter(field => !(field in meta));
  return {
    valid: missing.length === 0,
    missing
  };
}

/**
 * Update the last-updated field in frontmatter to today's date.
 * @param {object} meta - Frontmatter object
 * @param {string} [today] - Date string in YYYY-MM-DD format (defaults to today)
 * @returns {object} - Updated frontmatter object
 */
export function updateLastUpdated(meta, today = null) {
  const dateStr = today || new Date().toISOString().split('T')[0];
  return {
    ...meta,
    'last-updated': dateStr
  };
}

