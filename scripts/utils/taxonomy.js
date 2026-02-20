/**
 * utils/taxonomy.js
 * Validates tags in context file frontmatter against the approved taxonomy.
 * Fetches taxonomy.yaml from the context-standards repo at runtime.
 */

const yaml = require('js-yaml');
const https = require('https');

let _cachedTaxonomy = null;

/**
 * Fetch taxonomy.yaml from the context-standards repo.
 * Cached in memory for the duration of the action run.
 */
async function fetchTaxonomy(standardsRepo, githubToken) {
  if (_cachedTaxonomy) return _cachedTaxonomy;

  const [owner, repo] = standardsRepo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/taxonomy.yaml`;

  const content = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/contents/taxonomy.yaml`,
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'context-update-action'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const decoded = Buffer.from(json.content, 'base64').toString('utf8');
          resolve(decoded);
        } catch (e) {
          reject(new Error(`Failed to decode taxonomy.yaml: ${e.message}`));
        }
      });
    }).on('error', reject);
  });

  _cachedTaxonomy = yaml.load(content);
  return _cachedTaxonomy;
}

/**
 * Build a flat set of all approved tags per category.
 * { stack: Set, disciplines: Set, domain: Set, sensitivity: Set }
 */
function buildApprovedTagSets(taxonomy) {
  const sets = {};
  for (const [category, def] of Object.entries(taxonomy.categories || {})) {
    sets[category] = new Set(
      Object.entries(def.tags || {})
        .filter(([, v]) => v.status === 'approved')
        .map(([k]) => k)
    );
  }
  return sets;
}

/**
 * Validate a context file's tags object against the taxonomy.
 * Returns: { valid: boolean, unknown: Array<{tag, category}>, approved: object }
 */
function validateTags(tagsObject, approvedSets) {
  const unknown = [];
  const approved = {};

  for (const [category, tagList] of Object.entries(tagsObject || {})) {
    if (!Array.isArray(tagList)) continue;
    approved[category] = [];

    for (const tag of tagList) {
      if (approvedSets[category]?.has(tag)) {
        approved[category].push(tag);
      } else {
        unknown.push({ tag, category });
      }
    }
  }

  return {
    valid: unknown.length === 0,
    unknown,
    approved
  };
}

/**
 * Given a set of unknown tags, build the tags-pending-approval array
 * and the proposal payload for the context-standards dispatch.
 */
function buildPendingProposals(unknownTags, contextFilePath, reason = '') {
  return unknownTags.map(({ tag, category }) => ({
    tag,
    category,
    reason: reason || `Tag encountered in ${contextFilePath} — not yet in approved taxonomy`,
    source_file: contextFilePath
  }));
}

module.exports = { fetchTaxonomy, buildApprovedTagSets, validateTags, buildPendingProposals };
