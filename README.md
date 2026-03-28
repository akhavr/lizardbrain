# clawmem

Lightweight structured memory for community chats. Reads messages from any source, extracts knowledge (members, facts, topics) via any LLM, stores in a searchable SQLite database with full-text search.

Born from the [OpenClaw](https://github.com/open-claw/openclaw) ecosystem — built to give AI agents persistent memory of group conversations. Works standalone with any chat source and any LLM provider.

**Two tiers, one codebase.** Core tier: zero dependencies, FTS5 keyword search. Vector tier: add `better-sqlite3` + `sqlite-vec` for hybrid search (FTS5 + vector kNN + RRF merge). Auto-detects available deps at startup.

## How It Works

```
[Chat Source] → [Adapter] → [LLM Extraction] → [SQLite + FTS5]
                                                       ↓
                                          (if better-sqlite3 + sqlite-vec)
                                                       ↓
                                               [Embedding Pipeline] → [vec0 tables]
                                                       ↓
                                               [Hybrid Search: FTS5 + kNN + RRF]
```

1. **Adapter** reads new messages from your chat database (SQLite, JSONL, or custom)
2. **LLM** extracts structured knowledge — members, facts, topics — via any OpenAI-compatible API
3. **SQLite + FTS5** stores everything with full-text search, auto-synced indexes, and deduplication

Runs incrementally: tracks a cursor, only processes new messages each run. Designed to run on a cron (every 1-2 hours recommended).

## Quick Start

```bash
# Clone
git clone https://github.com/pandore/clawmem
cd clawmem

# Create config
cp examples/clawmem.json clawmem.json
# Edit clawmem.json — point to your chat DB and LLM

# Initialize memory database
node src/cli.js init

# Run extraction
CLAWMEM_LLM_API_KEY=your-key node src/cli.js extract

# Optional: enable hybrid vector search
npm install better-sqlite3 sqlite-vec

# Add embedding config to clawmem.json:
#   "embedding": { "enabled": true, "baseUrl": "...", "model": "..." }

# Embed existing knowledge
CLAWMEM_EMBEDDING_API_KEY=your-key node src/cli.js embed --backfill

# Query
node src/cli.js stats
node src/cli.js search "RAG pipeline"
node src/cli.js who "python"
```

## Configuration

Create `clawmem.json` in your working directory:

```json
{
  "memoryDbPath": "./clawmem.db",
  "batchSize": 40,
  "minMessages": 5,

  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5-nano"
  },

  "embedding": {
    "enabled": true,
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },

  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": {
      "id": "id",
      "content": "content",
      "sender": "sender_name",
      "timestamp": "created_at"
    },
    "filter": "role = 'user'"
  }
}
```

API key goes in `.env`, environment variable (`CLAWMEM_LLM_API_KEY`), or directly in config.

### LLM Providers

clawmem works with any OpenAI-compatible chat completions API. Pick whatever fits your budget:

| Provider | `baseUrl` | Recommended model | Cost (per 1M tokens) |
|----------|-----------|-------------------|----------------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-5-nano` | $0.05 / $0.40 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash-lite` | $0.10 / $0.40 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3-flash-preview` | $0.50 / $3.00 |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-instruct` | $0.10 / $0.32 |
| Mistral | `https://api.mistral.ai/v1` | `ministral-3b-2512` | $0.10 / $0.10 |
| Anthropic | `https://api.anthropic.com/v1/` | `claude-haiku-4.5` | $1.00 / $5.00 |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` | free (local) |
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-4-scout` | $0.08 / $0.30 |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.1-8B-Instruct-Turbo` | ~$0.05 |
| LM Studio | `http://localhost:1234/v1` | any local model | free (local) |

For extraction tasks, cheap/fast models work great. You don't need a frontier model to pull facts out of chat messages.

### Embedding Providers

When hybrid search is enabled, clawmem needs an embedding API. Works with any OpenAI-compatible `/v1/embeddings` endpoint:

| Provider | `embedding.baseUrl` | Recommended model | Dimensions |
|----------|---------------------|-------------------|------------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | 1536 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `text-embedding-004` | 768 |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` | 768 |

You can mix providers — e.g., cheap LLM (Groq) for extraction + quality embeddings (OpenAI) for search. See `examples/clawmem-mixed.json`.

### Source Adapters

#### SQLite (default)

Point at any SQLite database with a messages table:

```json
{
  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": {
      "id": "message_id",
      "content": "text",
      "sender": "author",
      "timestamp": "created_at"
    },
    "filter": "channel = 'general'"
  }
}
```

Works out of the box with OpenClaw's LCM database, Telegram export databases, or any custom schema.

#### Conversation Filtering (group-only extraction)

If your source has both group chats and DMs, you can restrict extraction to group conversations only:

```json
{
  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "conversationFilter": {
      "column": "conversation_id",
      "detectGroup": { "contentColumn": "content", "marker": "is_group_chat" }
    }
  }
}
```

clawmem auto-detects which conversations are group chats (>50% of messages contain the marker) and excludes DMs/system sessions. This prevents private messages from leaking into shared memory.

#### JSONL

One JSON object per line:

```json
{
  "source": {
    "type": "jsonl",
    "path": "./messages.jsonl",
    "fields": { "id": "id", "content": "text", "sender": "from", "timestamp": "date" }
  }
}
```

#### Custom Adapter

For anything else, point to a JS file:

```json
{ "source": { "type": "custom", "adapterPath": "./my-adapter.js" } }
```

```js
// my-adapter.js
module.exports = {
  name: 'my-source',
  validate() { return { ok: true }; },
  getMessages(afterId) {
    // Return array of { id, content, sender, timestamp }
    return [...]
  }
};
```

## CLI

```
clawmem init [--force]                         Create memory database
clawmem extract [--dry-run] [--reprocess]      Run extraction pipeline
clawmem embed [--stats] [--rebuild]            Manage vector embeddings
clawmem stats                                  Show database statistics
clawmem search <query> [--json] [--fts-only]   Search knowledge (hybrid or FTS5)
clawmem who <keyword>                          Find members by expertise
clawmem roster [--output path]                 Generate compact member roster
```

## Programmatic API

```js
const clawmem = require('clawmem');

// Initialize
clawmem.init('./memory.db');

// Create adapter + driver
const adapter = clawmem.adapters.sqlite.create({
  path: './chat.db',
  table: 'messages',
  columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
});
const driver = clawmem.createDriver('./memory.db');

// Extract
await clawmem.extract(adapter, driver, {
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5-nano' },
});

// Search (hybrid when vectors available, FTS5 fallback)
const { mode, results } = await clawmem.search(driver, 'kubernetes', { limit: 5 });

// Query helpers
const facts = clawmem.query.searchFacts(driver, 'kubernetes');
const experts = clawmem.query.whoKnows(driver, 'python');

driver.close();
```

## URL Enrichment

When messages contain URLs, clawmem automatically fetches metadata before sending to the LLM:

- **Web pages**: fetches `<title>` and `og:description` (or `<meta description>`)
- **GitHub repos**: uses GitHub API to get description + star count

This means the LLM sees:
```
Alice: Check out https://github.com/akhavr/nightshift [akhavr/nightshift — Claude Code task management tool | 234 stars]
```
instead of just a bare URL — enabling meaningful fact extraction from shared links.

Enabled by default. Disable with `--no-enrich` or `enrichUrls: false` in options.

## Roster Generation

Generate a compact markdown roster of all members with their expertise and projects:

```bash
# Print to stdout
clawmem roster

# Write to file
clawmem roster --output ./MEMBERS.md

# Auto-generate after every extraction (set in config)
# "rosterPath": "./MEMBERS.md"
```

Output format (~30-50 tokens per member):
```
# Community Members

- **Alice** — RAG, LangChain, Python | builds: pipeline, search-tool
- **Bob** — LlamaIndex, embeddings | builds: pdf-processor
```

This is designed to be loaded into an AI agent's context window for passive awareness of community members. At 100 members it's ~3,000 tokens — cheap enough to always include.

## Confidence Scores

Facts are scored for confidence during extraction:

| Score | Meaning | Example |
|-------|---------|---------|
| 0.9+ | Verified specifics | "Claude Opus costs $15/M output tokens" |
| 0.75-0.89 | Opinions, experiences | "LlamaIndex works better for large PDFs" |
| 0.5-0.74 | Secondhand, speculation | "I heard they might release a new model" |

Filter by confidence in queries:

```js
// Only high-confidence facts
clawmem.query.searchFacts(driver, 'pricing', 15, 0.75);
```

## Cron Setup

```bash
# Every 2 hours — gives enough messages per batch for good extraction quality
0 */2 * * * cd /path/to/project && CLAWMEM_LLM_API_KEY=key node src/cli.js extract >> /tmp/clawmem.log 2>&1

# With hybrid search enabled
0 */2 * * * cd /path/to/project && CLAWMEM_LLM_API_KEY=key CLAWMEM_EMBEDDING_API_KEY=ekey node src/cli.js extract >> /tmp/clawmem.log 2>&1

# With auto-roster generation
0 */2 * * * cd /path/to/project && CLAWMEM_LLM_API_KEY=key node src/cli.js extract --roster ./MEMBERS.md >> /tmp/clawmem.log 2>&1
```

## Schema

clawmem creates these tables in SQLite:

| Table | Contents |
|-------|----------|
| `members` | username, display_name, expertise, projects, first/last seen |
| `facts` | category, content, source member, tags, confidence, date |
| `topics` | name, summary, participants, tags, date |
| `extraction_state` | cursor position, run counters |
| `clawmem_meta` | key-value store for embedding model, dimensions |
| `*_fts` | FTS5 full-text search indexes (auto-synced via triggers) |
| `*_vec` | vec0 vector tables for kNN search (created on first embed) |

Query directly:

```bash
sqlite3 -json clawmem.db "SELECT * FROM facts_fts WHERE facts_fts MATCH 'docker'"
sqlite3 -json clawmem.db "SELECT display_name, expertise FROM members WHERE expertise LIKE '%python%'"
sqlite3 -json clawmem.db "SELECT name, summary FROM topics ORDER BY created_at DESC LIMIT 10"
```

## Requirements

**Core tier (zero dependencies):**
- Node.js >= 18 (uses built-in `fetch`)
- `sqlite3` CLI with FTS5 support (included on macOS and most Linux distros)

**Vector tier (optional, for hybrid search):**
- `better-sqlite3` — in-process SQLite driver
- `sqlite-vec` — SQLite extension for vector search
- An embedding API endpoint (OpenAI, Gemini, Ollama, etc.)

Install: `npm install better-sqlite3 sqlite-vec`

## Background

Built as the memory layer for [LEVI](https://github.com/pandore/limbai-tech), an AI community agent running on [OpenClaw](https://github.com/open-claw/openclaw) in the LIMB.AI/TECH Telegram group. Extracted into a standalone library because every community chat deserves searchable memory.

## License

MIT
