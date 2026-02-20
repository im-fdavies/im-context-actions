# Context Update Action

Drop these files into any service repository to get automatic `.context/` file maintenance on every push.

---

## What It Does

- **On every push** to configured branches — diffs the changed files, maps them to the affected `.context/*.md` files via `covers-paths`, and calls the AI to update only the relevant sections
- **Detects `[gotcha]` commits** — if your commit message contains `[gotcha]`, the AI analyses the diff and appends a structured entry to `constraints-and-gotchas.md`
- **Validates tags** against the org taxonomy — unknown tags go into `tags-pending-approval` and trigger a PR on `org/context-standards` automatically
- **Weekly stale check** — scans all context docs, finds ones older than your configured threshold, and re-verifies them against the current codebase
- **Dispatches to `context-router`** after every update so the MCP routing index stays fresh

---

## Setup

### 1. Copy these files into your repo

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
      diff-mapper.js
      frontmatter.js
      taxonomy.js
context.config.yml        ← repo root
```

### 2. Configure `context.config.yml`

Edit the file at the repo root. At minimum, update:
- `trigger_branches` — which branches should trigger updates
- `ai.provider` and `ai.model` — which AI to use
- `ai.api_key_secret` — name of the GitHub secret holding your API key
- `standards.repo` — your `org/context-standards` repo
- `router.repo` — your `org/context-router` repo

### 3. Add required secrets

| Secret | Where | What it is |
|--------|-------|------------|
| `ANTHROPIC_API_KEY` (or whatever you named it) | Org-level | API key for your AI provider |
| `CONTEXT_STANDARDS_PAT` | Org-level | PAT with contents+PR write on context-standards |
| `CONTEXT_ROUTER_PAT` | Org-level | PAT with contents write on context-router |

### 4. Bootstrap your `.context/` folder

Run the Codebase Context Generator prompt against your repo to generate the initial `.context/` files. The action will maintain them from that point forward.

---

## Commit Conventions

| Convention | Effect |
|-----------|--------|
| `[gotcha]` in commit message | AI analyses diff and appends entry to `constraints-and-gotchas.md` |
| `[skip ci]` in commit message | Skips context update entirely |
| `[skip context]` in commit message | Skips context update but not other CI |

---

## Loop Prevention

The action skips automatically if:
- The pusher is `context-bot[bot]`
- The commit message contains `[skip ci]` or `[skip context]`

This prevents the bot's own commits from triggering infinite update loops.

---

## Cost Considerations

The action is designed to be token-efficient:
- Only sends diffs and relevant context docs to the AI — not the whole codebase
- Source files are truncated at 8,000 chars each
- Total changed file content is capped at 40,000 chars per run
- Only the specific `.context/` files whose `covers-paths` match the diff are processed

For a typical feature commit touching 3–5 files, expect 1–3 AI calls per run.
