# Context Actions

Shared GitHub Actions template repository for automatic `.context/` file maintenance. Service repos (PHP/Symfony, Node.js, etc.) use `setup_context_action` (an MCP tool) to copy these workflow files into their own `.github/` folder.

---

## What It Does

### Workflow 1: Context Update (`context-update.yml`)

**Trigger:** Push to any branch listed in `context.config.yml` `trigger_branches`

1. Gets the list of files changed in the merge commit
2. Parses `covers-paths` from every `.context/*.md` file's frontmatter
3. For each changed source file, finds which context docs cover it by matching against `covers-paths` globs
4. Deduplicates — if 3 changed files all map to the same context doc, regenerate that doc once
5. Calls the Anthropic API to update each affected context doc, preserving frontmatter and updating `last-updated`
6. Commits changes with `[skip ci]` to prevent infinite loops
7. Uses `CONTEXT_STANDARDS_PAT` for push if branch protection is enabled

**Does NOT:**
- Regenerate context files whose `covers-paths` had no changed files
- Scan `vendor/` or `node_modules/`
- Push to any external repo
- Run if the push is from the bot itself (detected via `[skip ci]` in commit message)

### Workflow 2: Stale Check (`context-stale-check.yml`)

**Trigger:** Weekly cron (Monday 09:00 UTC) + manual dispatch

1. For every `.context/*.md` file, reads the `last-updated` date from frontmatter
2. Identifies files older than the threshold in `context.config.yml` (default: 90 days)
3. For each stale file:
   - Calls the Anthropic API to verify accuracy
   - If accurate (confidence ≥ 0.85): updates `last-updated` to today (resets staleness clock)
   - If inaccurate: opens a GitHub Issue titled `[context] Stale doc needs review: .context/filename.md`
4. Never opens duplicate issues — checks for existing open issues first
5. Files containing `constraints-and-gotchas` are never auto-modified (append-only)

---

## Setup

### 1. Copy files into your repo

```
.github/
  workflows/
    context-update.yml
    context-stale-check.yml
  scripts/
    package.json
    context-update.js
    stale-check.js
    utils/
      ai-client.js
      frontmatter.js
      glob-matcher.js
      github-client.js
      taxonomy.js
context.config.yml        ← repo root
```

### 2. Configure `context.config.yml`

```yaml
context:
  standards_repo: org/context-standards   # patched by setup_context_action
  trigger_branches:
    - main                                 # patched by setup_context_action
  stale_threshold_days: 90
  ai:
    provider: openai                       # openai | anthropic | azure-openai
    model: gpt-4o                          # model string for your provider
    api_key_secret: OPENAI_API_KEY         # GitHub secret name containing the key
```

**Provider options:**
- `openai` (default) — Uses OpenAI API. Works with GitHub Copilot org keys (`gpt-4o`, `gpt-4-turbo`)
- `anthropic` — Uses Anthropic API (`claude-sonnet-4-6`, `claude-opus-4`)
- `azure-openai` — Uses Azure OpenAI. Requires `AZURE_OPENAI_ENDPOINT` secret

### 3. Add required secrets

| Secret | Purpose |
|--------|---------|
| `OPENAI_API_KEY` | OpenAI/Copilot API key — default provider |
| `ANTHROPIC_API_KEY` | Anthropic API key — if using anthropic provider |
| `AZURE_OPENAI_ENDPOINT` | Azure endpoint URL — if using azure-openai provider |
| `CONTEXT_STANDARDS_PAT` | PAT with `contents: write` for the service repo — needed to push context commits if branch protection is on |

---

## Context File Format

Every `.context/*.md` file must have YAML frontmatter with these required fields:

```yaml
---
title: Auth Service
intent: CODE_GENERATION
covers-paths:
  - "src/Service/Auth/**/*.php"
  - "src/Controller/AuthController.php"
tags:
  - authentication
  - api
last-updated: 2026-01-15
---

# Auth Service

This document describes the authentication service...
```

### Required Frontmatter Fields

| Field | Description |
|-------|-------------|
| `title` | Human-readable name of the context doc |
| `intent` | Purpose of the doc (e.g., `CODE_GENERATION`, `ARCHITECTURE`, `API_REFERENCE`) |
| `covers-paths` | Glob patterns for source files this doc describes |
| `last-updated` | Date in YYYY-MM-DD format |

### Valid Intents

- `CODE_GENERATION` — Context for AI code generation tasks
- `ARCHITECTURE` — High-level system architecture documentation
- `API_REFERENCE` — API endpoints and contract documentation
- `DATA_MODEL` — Database schemas and data structures
- `INTEGRATION` — External service integrations
- `SECURITY` — Security patterns and considerations
- `TESTING` — Testing strategies and patterns
- `DEPLOYMENT` — Deployment and infrastructure context
- `CONSTRAINTS` — Gotchas, constraints, and edge cases
- `ONBOARDING` — Developer onboarding context

---

## How Context Mapping Works

The `covers-paths` field is the single source of truth for mapping source changes to context files.

**Example:**

```yaml
covers-paths:
  - "src/Service/Auth/**/*.php"
  - "src/Controller/AuthController.php"
```

If a commit changes `src/Service/Auth/TokenValidator.php`, the action:
1. Finds this context doc because `src/Service/Auth/**/*.php` matches the changed file
2. Reads all current source files covered by `covers-paths`
3. Calls the AI to update the doc body
4. Commits the updated doc with `[skip ci]`

---

## Loop Prevention

The action skips automatically if:
- The pusher is `github-actions[bot]`
- The commit message contains `[skip ci]`

---

## Cost Considerations

The action is designed to be token-efficient:
- Only context docs whose `covers-paths` match changed files are processed
- Source files are truncated at 6,000 chars each
- Total source content is capped at 40,000 chars per context doc
- 1.5s delay between API calls to avoid rate limits

---

## Dry Run Mode

Set `DRY_RUN=true` environment variable to print what would happen without:
- Making API calls
- Creating commits
- Opening issues

Useful for testing the mapping logic locally.

---

## Error Handling

- If the Anthropic API call fails for one file, the error is logged and processing continues
- If a `.context/` file has malformed frontmatter, a warning is logged and it's skipped
- Partial failures do not fail the whole workflow (exit 0)
- Only total failures (can't read repo, can't authenticate) result in exit 1

---

## Architecture Note

Context for a codebase lives **only in that codebase's own `.context/` folder**. There is no central index or router repository.
