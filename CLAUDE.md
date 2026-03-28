# Lizardbrain (formerly lizardbrain)

Lightweight structured memory extraction for community chats. Reads messages from any source, extracts knowledge (members, facts, topics) via any LLM, stores in SQLite with FTS5 and optional vector hybrid search.

## Architecture

Two-tier, one codebase:
- **Core tier:** Zero dependencies. Uses CLI `sqlite3`. FTS5 keyword search only.
- **Vector tier:** Add `better-sqlite3` + `sqlite-vec` for hybrid search (FTS5 + kNN + RRF merge).

Data flow: `Chat Source → Adapter → URL Enricher → LLM Extraction → SQLite + FTS5 [→ Embedding Pipeline → vec0 tables → Hybrid Search]`

## Project Structure

```
src/
  index.js        — Public API (main entry point)
  cli.js          — CLI (init, extract, embed, stats, search, who, roster)
  config.js       — Config loader (JSON file + env vars + defaults)
  driver.js       — DB driver abstraction (BetterSqliteDriver / CliDriver)
  schema.js       — SQLite schema (members, facts, topics, FTS5, vec0)
  store.js        — Read/write knowledge, deduplication, query helpers
  llm.js          — OpenAI-compatible LLM client
  extractor.js    — Extraction pipeline orchestrator
  embeddings.js   — Embedding pipeline (batching, retries, vec0 tables)
  search.js       — Hybrid search (FTS5 + kNN + RRF merge)
  adapters/
    sqlite.js     — SQLite source adapter
    jsonl.js      — JSONL source adapter
  enrichers/
    url.js        — URL metadata enrichment (GitHub API, HTML meta)
test/
  run.js          — Integration test suite
examples/         — Example config files for various providers
docs/
  specs/          — Technical design specs
  plans/          — Implementation plans
```

## Code Conventions

- **Module system:** CommonJS (require/module.exports)
- **Style:** Single quotes, semicolons, 2-space indent, camelCase
- **Error handling:** Try-catch for I/O; return `{ ok, error }` for validation; throw for unrecoverable; graceful degradation for optional features
- **SQL:** Use `esc()` helper for escaping; parameterized queries with `?` placeholders when using better-sqlite3
- **Async:** async/await, Promise.all for parallel ops, exponential backoff for rate limits
- **Config:** Env vars (`LIZARDBRAIN_*`) override file config; no silent defaults

## Commands

```bash
npm test              # Run test suite (node test/run.js)
npm run init          # Initialize memory database
npm run extract       # Run extraction pipeline
npm run stats         # Show database statistics
```

## Key Design Decisions

- Model-agnostic: any OpenAI-compatible API works for both LLM and embeddings
- Deduplication: multi-level (exact prefix match + FTS keyword overlap)
- Hybrid search: FTS5 + vector kNN merged via Reciprocal Rank Fusion (K=60)
- Auto-detect available deps at startup — gracefully degrade without optional deps
- Incremental processing via cursor tracking in extraction_state table

## Dependencies

- **Runtime:** Node.js >= 18, sqlite3 CLI with FTS5
- **Optional:** better-sqlite3, sqlite-vec (for vector tier)
- **No other dependencies**
