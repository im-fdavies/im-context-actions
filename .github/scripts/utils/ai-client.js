/**
 * utils/ai-client.js
 * Multi-provider AI wrapper for context doc regeneration and verification.
 * Supports: openai (GitHub Copilot), anthropic, azure-openai
 * Default: openai (for GitHub Copilot compatibility)
 */

import * as core from '@actions/core';

const REGEN_MAX_TOKENS = 8000;
const VERIFY_MAX_TOKENS = 2000;
const TIMEOUT_MS = 120000; // 120 seconds

/**
 * Dynamically import the appropriate SDK based on provider.
 * This avoids requiring all SDKs to be installed.
 */
async function getProviderClient(provider, apiKey) {
  switch (provider) {
    case 'anthropic': {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      return new Anthropic({ apiKey });
    }
    case 'openai':
    case 'azure-openai': {
      const { default: OpenAI } = await import('openai');
      if (provider === 'azure-openai') {
        return new OpenAI({
          apiKey,
          baseURL: process.env.AZURE_OPENAI_ENDPOINT,
          defaultQuery: { 'api-version': '2024-02-01' },
          defaultHeaders: { 'api-key': apiKey }
        });
      }
      return new OpenAI({ apiKey });
    }
    default:
      throw new Error(`Unknown AI provider: ${provider}. Supported: openai, anthropic, azure-openai`);
  }
}

/**
 * Call the AI provider with a prompt.
 * Handles differences between OpenAI and Anthropic APIs.
 */
async function callProvider(provider, client, model, systemPrompt, userPrompt, maxTokens) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (provider === 'anthropic') {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      }, { signal: controller.signal });
      return response.content[0]?.text || '';
    } else {
      // OpenAI / Azure OpenAI
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      }, { signal: controller.signal });
      return response.choices[0]?.message?.content || '';
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Get configuration from environment.
 */
function getConfig() {
  return {
    provider: process.env.AI_PROVIDER || 'openai',
    model: process.env.AI_MODEL || 'gpt-4o',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
  };
}

/**
 * Regenerate a context document based on current source files.
 * Returns the full updated markdown file content.
 *
 * @param {string} currentDoc - Current content of the context document
 * @param {Array<{path: string, content: string}>} sourceFiles - Source files covered by this doc
 * @param {string} today - Today's date in YYYY-MM-DD format
 * @param {object} options - { provider, model, apiKey } - overrides env vars
 * @returns {Promise<string>} - Updated markdown file content
 */
export async function regenerateContextDoc(currentDoc, sourceFiles, today, options = {}) {
  const config = getConfig();
  const provider = options.provider || config.provider;
  const model = options.model || config.model;
  const apiKey = options.apiKey || config.apiKey;

  if (!apiKey) {
    throw new Error('AI API key not found. Set AI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY');
  }

  const client = await getProviderClient(provider, apiKey);

  const sourceFilesFormatted = sourceFiles
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const systemPrompt = `You are a senior software architect maintaining AI-readable context documentation for a codebase.

Your task is to update a .context/*.md file based on the current state of the source files it covers.

CRITICAL RULES:
1. Return ONLY the complete updated markdown file. No explanation, no preamble, no code fences around the whole response.
2. Preserve the YAML frontmatter block EXACTLY as-is, with one exception: update the 'last-updated' field to '${today}'.
3. Update the body content to accurately describe the current source code.
4. Be thorough but concise. Document architecture, key patterns, and important implementation details.
5. Never invent code that doesn't exist in the source files provided.
6. If the source shows significant changes from what the doc describes, update those sections.
7. Do not add or remove frontmatter fields — preserve the exact structure.`;

  const userPrompt = `## Current Context Document

${currentDoc}

---

## Current Source Files (this is what the document should describe)

${sourceFilesFormatted}

---

Update the context document to accurately reflect the current source code.
Return the complete file including the frontmatter block (with last-updated set to ${today}).`;

  return callProvider(provider, client, model, systemPrompt, userPrompt, REGEN_MAX_TOKENS);
}

/**
 * Verify whether a context document is still accurate.
 * Returns a JSON object with accuracy assessment.
 *
 * @param {string} currentDoc - Current content of the context document
 * @param {Array<{path: string, content: string}>} sourceFiles - Source files covered by this doc
 * @param {object} options - { provider, model, apiKey } - overrides env vars
 * @returns {Promise<{accurate: boolean, confidence: number, issues: string[]}>}
 */
export async function verifyContextDoc(currentDoc, sourceFiles, options = {}) {
  const config = getConfig();
  const provider = options.provider || config.provider;
  const model = options.model || config.model;
  const apiKey = options.apiKey || config.apiKey;

  if (!apiKey) {
    throw new Error('AI API key not found. Set AI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY');
  }

  const client = await getProviderClient(provider, apiKey);

  const sourceFilesFormatted = sourceFiles
    .map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

  const systemPrompt = `You are auditing a context documentation file to verify it is still accurate against the current source code.

Your task is to compare the documentation against the source files and determine:
1. Whether the documentation is still accurate
2. Your confidence level (0.0 to 1.0)
3. Any specific issues or inaccuracies found

IMPORTANT: Respond ONLY with a JSON object in this exact format:
{
  "accurate": true/false,
  "confidence": 0.0-1.0,
  "issues": ["issue 1", "issue 2", ...]
}

Be thorough but reasonable:
- Minor wording differences are not issues
- Outdated code references, missing patterns, or incorrect descriptions ARE issues
- If confidence >= 0.85 and no significant issues, set accurate: true`;

  const userPrompt = `## Context Document to Verify

${currentDoc}

---

## Current Source Files

${sourceFilesFormatted}

---

Analyze the context document against the source files and return your assessment as JSON.`;

  const text = await callProvider(provider, client, model, systemPrompt, userPrompt, VERIFY_MAX_TOKENS);

  // Parse the JSON response
  try {
    // Handle potential markdown code blocks in response
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const jsonStr = jsonMatch[1].trim();
    const result = JSON.parse(jsonStr);

    return {
      accurate: Boolean(result.accurate),
      confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      issues: Array.isArray(result.issues) ? result.issues : []
    };
  } catch (parseError) {
    core.warning(`Failed to parse AI verification response as JSON: ${parseError.message}`);
    return {
      accurate: false,
      confidence: 0.0,
      issues: ['Failed to parse AI response']
    };
  }
}

/**
 * Add a delay between API calls to avoid rate limiting.
 * @param {number} ms - Milliseconds to wait
 */
export function delay(ms = 1500) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


