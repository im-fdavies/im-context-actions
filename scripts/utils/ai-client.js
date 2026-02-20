/**
 * utils/ai-client.js
 * Model-agnostic AI wrapper.
 * Supports: anthropic, openai, azure-openai
 * Provider and model are set via context.config.yml and passed in as env vars.
 */

const https = require('https');

/**
 * Call the configured AI provider with a prompt.
 * Returns the text response as a string.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} options - { provider, model, apiKey, maxTokens }
 * @returns {Promise<string>}
 */
async function callAI(systemPrompt, userPrompt, options = {}) {
  const {
    provider = process.env.AI_PROVIDER || 'anthropic',
    model = process.env.AI_MODEL || 'claude-opus-4-6',
    apiKey = process.env.AI_API_KEY,
    maxTokens = parseInt(process.env.AI_MAX_TOKENS || '8000')
  } = options;

  if (!apiKey) {
    throw new Error(`AI API key not found. Set the secret named in context.config.yml ai.api_key_secret`);
  }

  switch (provider.toLowerCase()) {
    case 'anthropic':
      return callAnthropic(systemPrompt, userPrompt, model, apiKey, maxTokens);
    case 'openai':
    case 'azure-openai':
      return callOpenAI(systemPrompt, userPrompt, model, apiKey, maxTokens, provider);
    default:
      throw new Error(`Unknown AI provider: ${provider}. Supported: anthropic, openai, azure-openai`);
  }
}

async function callAnthropic(systemPrompt, userPrompt, model, apiKey, maxTokens) {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const response = await httpPost({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  }, body);

  const data = JSON.parse(response);

  if (data.error) {
    throw new Error(`Anthropic API error: ${data.error.message}`);
  }

  return data.content?.[0]?.text || '';
}

async function callOpenAI(systemPrompt, userPrompt, model, apiKey, maxTokens, provider) {
  const hostname = provider === 'azure-openai'
    ? process.env.AZURE_OPENAI_ENDPOINT || 'your-resource.openai.azure.com'
    : 'api.openai.com';

  const path = provider === 'azure-openai'
    ? `/openai/deployments/${model}/chat/completions?api-version=2024-02-01`
    : '/v1/chat/completions';

  const body = JSON.stringify({
    model: provider === 'azure-openai' ? undefined : model,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  const headers = provider === 'azure-openai'
    ? { 'Content-Type': 'application/json', 'api-key': apiKey }
    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

  const response = await httpPost({ hostname, path, headers }, body);
  const data = JSON.parse(response);

  if (data.error) {
    throw new Error(`OpenAI API error: ${data.error.message}`);
  }

  return data.choices?.[0]?.message?.content || '';
}

function httpPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      ...options,
      headers: {
        ...options.headers,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { callAI };
