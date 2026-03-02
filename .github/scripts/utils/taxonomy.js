/**
 * utils/taxonomy.js
 * Valid intents and tag categories for context file validation.
 * This is the local source of truth — no external taxonomy repo dependency.
 */

/**
 * Valid intent values for context documents.
 * These describe the primary purpose of the context file.
 */
export const VALID_INTENTS = [
  'CODE_GENERATION',     // Context for AI code generation tasks
  'ARCHITECTURE',        // High-level system architecture documentation
  'API_REFERENCE',       // API endpoints and contract documentation
  'DATA_MODEL',          // Database schemas and data structures
  'INTEGRATION',         // External service integrations
  'SECURITY',            // Security patterns and considerations
  'TESTING',             // Testing strategies and patterns
  'DEPLOYMENT',          // Deployment and infrastructure context
  'CONSTRAINTS',         // Gotchas, constraints, and edge cases
  'ONBOARDING'           // Developer onboarding context
];

/**
 * Valid tag categories.
 * Tags should be organized under these categories in frontmatter.
 */
export const TAG_CATEGORIES = {
  domain: {
    description: 'Business domain tags',
    examples: ['authentication', 'payments', 'notifications', 'user-management']
  },
  stack: {
    description: 'Technology stack tags',
    examples: ['php', 'symfony', 'node', 'react', 'postgresql', 'redis']
  },
  pattern: {
    description: 'Design pattern tags',
    examples: ['repository', 'factory', 'observer', 'cqrs', 'event-sourcing']
  },
  lifecycle: {
    description: 'Development lifecycle tags',
    examples: ['legacy', 'stable', 'experimental', 'deprecated']
  }
};

/**
 * Validate the intent field in frontmatter.
 * @param {string} intent - The intent value from frontmatter
 * @returns {{ valid: boolean, message: string }}
 */
export function validateIntent(intent) {
  if (!intent) {
    return { valid: false, message: 'Missing required field: intent' };
  }

  if (!VALID_INTENTS.includes(intent)) {
    return {
      valid: false,
      message: `Invalid intent '${intent}'. Valid intents: ${VALID_INTENTS.join(', ')}`
    };
  }

  return { valid: true, message: '' };
}

/**
 * Validate tags in frontmatter.
 * This is a loose validation - tags are freeform but should be organized by category.
 * @param {object | string[]} tags - Tags from frontmatter (object with categories or flat array)
 * @returns {{ valid: boolean, warnings: string[] }}
 */
export function validateTags(tags) {
  const warnings = [];

  if (!tags) {
    return { valid: true, warnings: ['No tags defined'] };
  }

  // Handle flat array of tags (legacy format)
  if (Array.isArray(tags)) {
    return {
      valid: true,
      warnings: ['Tags are in flat array format. Consider organizing by category.']
    };
  }

  // Validate categorized tags
  if (typeof tags === 'object') {
    for (const category of Object.keys(tags)) {
      if (!TAG_CATEGORIES[category]) {
        warnings.push(`Unknown tag category: '${category}'`);
      }
    }
  }

  return { valid: true, warnings };
}

/**
 * Get a summary of valid taxonomy values for documentation.
 * @returns {string}
 */
export function getTaxonomySummary() {
  let summary = '## Valid Intents\n\n';
  for (const intent of VALID_INTENTS) {
    summary += `- ${intent}\n`;
  }

  summary += '\n## Tag Categories\n\n';
  for (const [category, info] of Object.entries(TAG_CATEGORIES)) {
    summary += `### ${category}\n`;
    summary += `${info.description}\n`;
    summary += `Examples: ${info.examples.join(', ')}\n\n`;
  }

  return summary;
}

