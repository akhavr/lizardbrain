# LizardBrain Deployment Guide

Step-by-step guide to deploy LizardBrain as an OpenClaw extension. After this, your agents will have persistent, searchable memory of group conversations.

## Prerequisites

- OpenClaw gateway running (systemd service)
- Node.js >= 18 on the server
- LCM (lossless-claw) extension installed (provides `lcm.db`)
- An LLM API key (OpenAI, Anthropic, Gemini, Groq, or any OpenAI-compatible)
- Optional: embedding API key (can be same provider or different)

## Step 1: Install

```bash
cd ~/.openclaw/extensions
mkdir lizardbrain && cd lizardbrain
npm init -y
npm install lizardbrain@latest
```

## Step 2: Configure

Create `lizardbrain.json` in the extension directory:

```json
{
  "memoryDbPath": "./lizardbrain.db",
  "rosterPath": "../MEMBERS.md",

  "llm": {
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "model": "gemini-2.5-flash"
  },

  "embedding": {
    "enabled": true,
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "model": "text-embedding-004"
  },

  "context": {
    "enabled": true,
    "tokenBudget": 1000,
    "recencyDays": 30
  },

  "profile": "team",

  "source": {
    "type": "sqlite",
    "path": "~/.openclaw/lcm.db",
    "table": "messages",
    "columns": {
      "id": "message_id",
      "content": "content",
      "timestamp": "created_at"
    },
    "filter": "role = 'user'",
    "conversationFilter": {
      "column": "conversation_id",
      "detectGroup": { "contentColumn": "content", "marker": "is_group_chat" }
    }
  }
}
```

### API keys

Set API keys as environment variables. **Never put keys in the JSON config.**

```bash
# In your .env or systemd environment:

# LLM extraction (required)
export LIZARDBRAIN_LLM_API_KEY=your-llm-api-key

# Embeddings (optional — enables hybrid vector search)
export LIZARDBRAIN_EMBEDDING_API_KEY=your-embedding-api-key
```

If using the same provider for both LLM and embeddings (e.g., Gemini), one key works for both.

### Provider examples

| Provider | `baseUrl` | LLM `model` | Embedding `model` |
|---|---|---|---|
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` | `text-embedding-004` |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | `text-embedding-3-small` |
| **Anthropic** | (native, set `provider: "anthropic"`) | `claude-sonnet-4-6-20250514` | (use separate provider) |
| **Groq** | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | (use separate provider) |
| **Ollama** | `http://localhost:11434/v1` | `llama3.2` | `nomic-embed-text` |

### Choosing a profile

| Profile | What it extracts | Use when |
|---|---|---|
| `knowledge` | Members, facts, topics | Community/interest groups |
| `team` | + decisions, tasks | Work teams, Slack channels |
| `project` | + questions (no topics) | Client projects, contractor chats |
| `full` | All 7 entity types | You want everything |

## Step 3: Initialize

```bash
cd ~/.openclaw/extensions/lizardbrain
npx lizardbrain init --profile team
```

This creates `lizardbrain.db` with the schema for your chosen profile.

## Step 4: First extraction (test run)

```bash
cd ~/.openclaw/extensions/lizardbrain
LIZARDBRAIN_LLM_API_KEY=your-key npx lizardbrain extract --dry-run --limit 1
```

`--dry-run` sends one batch to the LLM but doesn't write to the database. Verify:
- Source database found and validated
- LLM returns structured entities
- No errors

Then run for real:

```bash
LIZARDBRAIN_LLM_API_KEY=your-key npx lizardbrain extract
```

## Step 5: Verify

```bash
npx lizardbrain stats
npx lizardbrain search "your topic"
npx lizardbrain who "some skill"
```

You should see extracted members, facts, topics, etc.

## Step 6: Set up extraction cron

### Option A: System cron

```bash
crontab -e
```

Add (runs every 2 hours):

```
0 */2 * * * cd ~/.openclaw/extensions/lizardbrain && LIZARDBRAIN_LLM_API_KEY=your-key npx lizardbrain extract --quiet >> /tmp/lizardbrain.log 2>&1
```

### Option B: OpenClaw scheduled task

Add to `~/.openclaw/cron/jobs.json`:

```json
{
  "id": "lizardbrain-extract",
  "agentId": "your-ops-agent-id",
  "sessionKey": "agent:ops:cron:lizardbrain-extract",
  "name": "LizardBrain extraction",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 */2 * * *",
    "tz": "Europe/Lisbon"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "message": "Run lizardbrain extraction: cd ~/.openclaw/extensions/lizardbrain && npx lizardbrain extract --quiet",
    "model": "anthropic/claude-sonnet-4-6"
  }
}
```

## Step 7: Enable MCP server for agents

Add to each agent's tools config or MCP settings so they can query knowledge:

```json
{
  "mcpServers": {
    "lizardbrain": {
      "command": "npx",
      "args": ["lizardbrain", "serve"],
      "cwd": "~/.openclaw/extensions/lizardbrain",
      "env": {
        "LIZARDBRAIN_LLM_API_KEY": "your-key"
      }
    }
  }
}
```

The MCP server exposes 9 tools: `search`, `get_context`, `who_knows`, `add_knowledge`, `extract_from_text`, `update_entity`, `add_link`, `get_links`, `stats`.

**Note:** The MCP server requires `better-sqlite3` (optional dependency). If you only installed the core tier, run `npm install better-sqlite3` first.

## Step 8: Enable embeddings (optional)

Embeddings enable hybrid search (keyword + semantic). Without them, search is FTS5 keyword-only — still good, but misses rephrased queries.

### Install vector dependencies

```bash
cd ~/.openclaw/extensions/lizardbrain
npm install better-sqlite3 sqlite-vec
```

### Add embedding config

In `lizardbrain.json`, ensure `embedding` is configured:

```json
{
  "embedding": {
    "enabled": true,
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
    "model": "text-embedding-004"
  }
}
```

Set the embedding API key:

```bash
export LIZARDBRAIN_EMBEDDING_API_KEY=your-embedding-key
```

### Backfill existing entities

If you already have extracted entities without embeddings:

```bash
LIZARDBRAIN_EMBEDDING_API_KEY=your-key npx lizardbrain extract --no-embed  # skip auto-embed
# Then backfill:
node -e "
const lb = require('lizardbrain');
const { createDriver } = require('lizardbrain/src/driver');
const config = require('lizardbrain/src/config').load('./lizardbrain.json');
const driver = createDriver('./lizardbrain.db');
lb.embeddings.backfill(driver, config.embedding).then(r => {
  console.log('Embedded:', r.totalEmbedded, 'vectors');
  driver.close();
});
"
```

Future extractions auto-embed new entities when `embedding.enabled` is true.

## Step 9: Generate member roster (optional)

Create a compact member roster for agent system prompts:

```bash
npx lizardbrain extract --roster ../MEMBERS.md
```

This generates `~/.openclaw/MEMBERS.md` with ~30 tokens per member. Include it in your agents' workspace files for member awareness.

---

## Troubleshooting

**"No such table: messages"** — Check `source.path` points to the correct database and `source.table` matches the actual table name. Run `sqlite3 <path> ".tables"` to verify.

**LLM returns empty results** — Try `--dry-run --limit 1` to see raw LLM output. Check that `source.filter` isn't too restrictive. Ensure `minMessages` (default 5) isn't higher than your message count.

**"fts5: syntax error"** — Upgrade to v1.0.3+ which sanitizes special characters in search queries.

**Embedding errors** — Ensure `better-sqlite3` and `sqlite-vec` are installed. Check that your embedding API key is set and the model name matches your provider's format.

## Environment variable reference

| Variable | Purpose |
|---|---|
| `LIZARDBRAIN_LLM_API_KEY` | LLM API key for extraction |
| `LIZARDBRAIN_LLM_BASE_URL` | LLM endpoint (overrides config) |
| `LIZARDBRAIN_LLM_MODEL` | LLM model (overrides config) |
| `LIZARDBRAIN_EMBEDDING_API_KEY` | Embedding API key |
| `LIZARDBRAIN_EMBEDDING_BASE_URL` | Embedding endpoint (overrides config) |
| `LIZARDBRAIN_EMBEDDING_MODEL` | Embedding model (overrides config) |
| `LIZARDBRAIN_DB_PATH` | Output DB path (overrides config) |
| `LIZARDBRAIN_PROFILE` | Extraction profile |
| `LLM_API_KEY` | Generic fallback for LLM key |
| `LLM_BASE_URL` | Generic fallback for LLM endpoint |
