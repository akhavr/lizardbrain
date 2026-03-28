# Lizardbrain

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-0.4.0-orange.svg)](package.json)

**Persistent memory for group chats.** Reads messages from any source, extracts structured knowledge via any LLM, stores it in SQLite with full-text and hybrid vector search.

Give your AI agent a brain that remembers what your group talks about.

```
Chat Source  -->  Adapter  -->  LLM Extraction  -->  SQLite + FTS5
                                                          |
                                             (optional: better-sqlite3 + sqlite-vec)
                                                          |
                                                   Embedding Pipeline --> vec0 tables
                                                          |
                                                   Hybrid Search (FTS5 + kNN + RRF)
```

---

## Highlights

- **Profile-driven** -- choose what to extract: knowledge communities, team chats, project groups, or define your own
- **7 entity types** -- members, facts, topics, decisions, tasks, questions, events
- **Model-agnostic** -- works with any OpenAI-compatible API (OpenAI, Gemini, Groq, Ollama, Mistral, etc.)
- **Two tiers, one codebase** -- core tier has zero dependencies; add `better-sqlite3` + `sqlite-vec` for hybrid vector search
- **Incremental** -- tracks a cursor, only processes new messages each run
- **Smart deduplication** -- multi-level (exact match + FTS keyword overlap) prevents duplicate facts
- **Hybrid search** -- FTS5 keyword + vector kNN merged via Reciprocal Rank Fusion
- **URL enrichment** -- auto-fetches metadata for links (GitHub stars, page titles) before LLM extraction
- **Pluggable sources** -- SQLite, JSONL, or write your own adapter in 10 lines
- **Roster generation** -- compact member profiles (~30 tokens each) designed for agent context windows

---

## Quick Start

```bash
git clone https://github.com/pandore/lizardbrain && cd lizardbrain

cp examples/lizardbrain.json lizardbrain.json
# Edit lizardbrain.json -- set your chat DB path and LLM provider

node src/cli.js init              # Interactive profile picker
# or: node src/cli.js init --profile team

LIZARDBRAIN_LLM_API_KEY=your-key node src/cli.js extract

# Query
node src/cli.js search "RAG pipeline"
node src/cli.js who "python"
node src/cli.js stats
```

**Enable hybrid vector search** (optional):

```bash
npm install better-sqlite3 sqlite-vec
# Add to lizardbrain.json: "embedding": { "enabled": true, "baseUrl": "...", "model": "..." }
LIZARDBRAIN_EMBEDDING_API_KEY=your-key node src/cli.js embed --backfill
```

---

## Profiles

Profiles control what entity types are extracted and how member fields are interpreted. Pick a profile at `init` time:

| Profile | Entities | Best for |
|---------|----------|----------|
| `knowledge` | Members, Facts, Topics | Communities, interest groups |
| `team` | Members, Facts, Topics, Decisions, Tasks | Teams, workplaces |
| `project` | Members, Facts, Decisions, Tasks, Questions | Client work, project groups |
| `full` | All 7 entity types | When you want everything |

```bash
node src/cli.js init --profile team
# or run without --profile for interactive picker
```

The profile is stored in the database and used automatically on subsequent `extract` runs. You can also set it in config:

```json
{
  "profile": "team"
}
```

<details>
<summary>Custom entity selection</summary>

Override which entities are extracted in your config file:

```json
{
  "profile": "team",
  "entities": ["members", "facts", "decisions", "tasks"]
}
```

Available entity types: `members`, `facts`, `topics`, `decisions`, `tasks`, `questions`, `events`.

</details>

---

## Configuration

Create `lizardbrain.json` in your working directory:

```json
{
  "memoryDbPath": "./lizardbrain.db",
  "batchSize": 40,
  "minMessages": 5,
  "profile": "knowledge",

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

API key via `.env` file, environment variable (`LIZARDBRAIN_LLM_API_KEY`), or directly in config.

### LLM Providers

Any OpenAI-compatible chat completions API. Cheap/fast models work great for extraction -- you don't need a frontier model to pull facts out of chat messages.

| Provider | `baseUrl` | Model | Cost (input/output per 1M) |
|----------|-----------|-------|----------------------------|
| OpenAI | `https://api.openai.com/v1` | `gpt-5-nano` | $0.05 / $0.40 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash-lite` | $0.10 / $0.40 |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-instruct` | $0.10 / $0.32 |
| Mistral | `https://api.mistral.ai/v1` | `ministral-3b-2512` | $0.10 / $0.10 |
| Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` | free (local) |
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-4-scout` | $0.08 / $0.30 |

<details>
<summary>Embedding providers</summary>

Works with any OpenAI-compatible `/v1/embeddings` endpoint. You can mix providers -- e.g., cheap LLM (Groq) for extraction + quality embeddings (OpenAI) for search.

| Provider | `embedding.baseUrl` | Model | Dimensions |
|----------|---------------------|-------|------------|
| OpenAI | `https://api.openai.com/v1` | `text-embedding-3-small` | 1536 |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `text-embedding-004` | 768 |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` | 768 |

See `examples/lizardbrain-mixed.json` for a mixed-provider config.

</details>

---

## Source Adapters

### SQLite (default)

Point at any SQLite database with a messages table. Works with OpenClaw LCM, Telegram exports, or any custom schema.

```json
{
  "source": {
    "type": "sqlite",
    "path": "./chat.db",
    "table": "messages",
    "columns": { "id": "message_id", "content": "text", "sender": "author", "timestamp": "created_at" },
    "filter": "channel = 'general'"
  }
}
```

<details>
<summary>Conversation filtering (group-only extraction)</summary>

Restrict extraction to group chats only -- prevents private messages from leaking into shared memory:

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

Auto-detects group chats (>50% of messages contain the marker) and excludes DMs.

</details>

### JSONL

```json
{
  "source": {
    "type": "jsonl",
    "path": "./messages.jsonl",
    "fields": { "id": "id", "content": "text", "sender": "from", "timestamp": "date" }
  }
}
```

### Custom Adapter

```js
// my-adapter.js
module.exports = {
  name: 'my-source',
  validate() { return { ok: true }; },
  getMessages(afterId) {
    return [{ id: '1', content: 'hello', sender: 'alice', timestamp: '2026-01-01' }];
  }
};
```

```json
{ "source": { "type": "custom", "adapterPath": "./my-adapter.js" } }
```

---

## CLI Reference

```
lizardbrain init [--force] [--profile <name>]       Create memory database
lizardbrain extract [--dry-run] [--reprocess]       Run extraction pipeline
lizardbrain embed [--stats] [--rebuild]             Manage vector embeddings
lizardbrain stats                                   Show database statistics
lizardbrain search <query> [--json] [--fts-only]    Search knowledge (hybrid or FTS5)
lizardbrain who <keyword>                           Find members by expertise
lizardbrain roster [--output path]                  Generate compact member roster
```

| Flag | Description |
|------|-------------|
| `--config <path>` | Path to config file |
| `--profile <name>` | Set extraction profile (knowledge, team, project, full) |
| `--roster <path>` | Generate roster after extraction |
| `--no-enrich` | Skip URL metadata enrichment |
| `--no-embed` | Skip auto-embedding after extraction |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `LIZARDBRAIN_LLM_API_KEY` | LLM API key |
| `LIZARDBRAIN_LLM_BASE_URL` | LLM API base URL |
| `LIZARDBRAIN_LLM_MODEL` | LLM model name |
| `LIZARDBRAIN_EMBEDDING_API_KEY` | Embedding API key |
| `LIZARDBRAIN_EMBEDDING_BASE_URL` | Embedding API base URL |
| `LIZARDBRAIN_EMBEDDING_MODEL` | Embedding model name |
| `LIZARDBRAIN_DB_PATH` | Path to memory database |
| `LIZARDBRAIN_PROFILE` | Extraction profile |

---

## Programmatic API

```js
const lizardbrain = require('lizardbrain');

lizardbrain.init('./memory.db', { profile: 'team' });

const adapter = lizardbrain.adapters.sqlite.create({
  path: './chat.db',
  table: 'messages',
  columns: { id: 'id', content: 'text', sender: 'author', timestamp: 'created_at' },
});
const driver = lizardbrain.createDriver('./memory.db');

await lizardbrain.extract(adapter, driver, {
  llm: { baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5-nano' },
});

// Hybrid search (auto-falls back to FTS5 if vectors unavailable)
const { mode, results } = await lizardbrain.search(driver, 'kubernetes', { limit: 5 });

// Query helpers
const facts = lizardbrain.query.searchFacts(driver, 'kubernetes');
const experts = lizardbrain.query.whoKnows(driver, 'python');
const decisions = lizardbrain.query.searchDecisions(driver, 'database');
const tasks = lizardbrain.query.searchTasks(driver, 'migration');

driver.close();
```

---

## How It Works

### Extraction Pipeline

1. **Adapter** reads new messages after the last cursor position
2. **URL enricher** fetches metadata for links (GitHub repos get description + stars, web pages get title + og:description)
3. **LLM** extracts structured knowledge as JSON -- members, facts, topics -- with confidence scores
4. **Store** deduplicates and writes to SQLite with auto-synced FTS5 indexes
5. **Embedder** (optional) generates vectors for hybrid search

Designed to run on a cron every 1-2 hours:

```bash
0 */2 * * * cd /path/to/project && LIZARDBRAIN_LLM_API_KEY=key node src/cli.js extract >> /tmp/lizardbrain.log 2>&1
```

### What Gets Extracted

| Entity | Fields | Example |
|--------|--------|---------|
| **Members** | username, expertise, projects | Alice -- RAG, LangChain \| builds: pipeline |
| **Facts** | category, content, confidence, tags | "LangChain works well with chunk size 512" (0.9) |
| **Topics** | name, summary, participants | "RAG Pipeline Comparison" -- Alice, Bob |
| **Decisions** | description, participants, context, status | "Use PostgreSQL instead of MySQL" (agreed) |
| **Tasks** | description, assignee, deadline, status | "Migrate user service" -- Bob, due Apr 15 |
| **Questions** | question, asker, answer, status | "Best way to handle migrations?" -- answered |
| **Events** | name, date, location, attendees | "Architecture Review" -- Apr 1, Zoom |

### Confidence Scores

| Score | Meaning | Example |
|-------|---------|---------|
| 0.9+ | Verified specifics | "Claude Opus costs $15/M output tokens" |
| 0.75-0.89 | Opinions, experiences | "LlamaIndex works better for large PDFs" |
| 0.5-0.74 | Secondhand, speculation | "I heard they might release a new model" |

### Roster Generation

Generate a compact member roster for agent context windows (~30-50 tokens per member):

```
# Members

- **Alice** -- RAG, LangChain, Python | builds: pipeline, search-tool
- **Bob** -- LlamaIndex, embeddings | builds: pdf-processor
```

At 100 members it's ~3,000 tokens -- cheap enough to always include in an agent's system prompt. Customize the header via the `title` option in the programmatic API.

```bash
lizardbrain roster --output ./MEMBERS.md
```

---

## Database Schema

| Table | Contents |
|-------|----------|
| `members` | username, display_name, expertise, projects, first/last seen |
| `facts` | category, content, source member, tags, confidence, date |
| `topics` | name, summary, participants, tags, date |
| `decisions` | description, participants, context, status, tags, date |
| `tasks` | description, assignee, deadline, status, source member, tags |
| `questions` | question, asker, answer, answered_by, status, tags |
| `events` | name, description, event_date, location, attendees, tags |
| `extraction_state` | cursor position, run counters |
| `lizardbrain_meta` | key-value store (profile, embedding model, dimensions) |
| `*_fts` | FTS5 full-text search indexes (auto-synced via triggers) |
| `*_vec` | vec0 vector tables for kNN search (created on first embed) |

Query directly:

```bash
sqlite3 -json lizardbrain.db "SELECT * FROM facts_fts WHERE facts_fts MATCH 'docker'"
sqlite3 -json lizardbrain.db "SELECT display_name, expertise FROM members WHERE expertise LIKE '%python%'"
```

---

## Requirements

| Tier | Dependencies |
|------|-------------|
| **Core** (zero deps) | Node.js >= 18, `sqlite3` CLI with FTS5 (included on macOS/Linux) |
| **Vector** (optional) | + `better-sqlite3` + `sqlite-vec` + any embedding API |

```bash
# Enable vector tier
npm install better-sqlite3 sqlite-vec
```

## License

MIT
