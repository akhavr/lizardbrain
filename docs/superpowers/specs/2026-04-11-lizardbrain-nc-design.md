# lizardbrain-nc — Design Spec

Hard fork of Lizardbrain adapted for NanoClaw. Strips OpenClaw-specific adapters, adds a NanoClaw-native adapter hardcoded to `messages.db` schema, and adopts NanoClaw conventions for zero-config deployment inside Docker containers.

## Project Identity

- **Name:** `lizardbrain-nc`
- **Location:** `/Users/oleksiinikitin/Documents/Repos/lizardbrain-nc`
- **Package:** `lizardbrain-nc` (new npm package, separate from `lizardbrain`)
- **Git:** Fresh repository (not a git fork — clean history)
- **Base:** Copy of `lizardbrain@1.0.2` source

## Scope

### Kept (unchanged or minor edits)

| Module | Notes |
|---|---|
| `extractor.js` | Extraction pipeline orchestrator — no changes |
| `llm.js` | LLM client — no changes |
| `profiles.js` | Profile definitions — no changes |
| `schema.js` | SQLite schema + migrations — no changes |
| `store.js` | Read/write knowledge, dedup, queries — no changes |
| `search.js` | Hybrid search (FTS5 + kNN + RRF) — no changes |
| `embeddings.js` | Embedding pipeline — no changes |
| `context.js` | Context assembly — no changes |
| `driver.js` | DB driver abstraction — no changes |
| `enrichers/url.js` | URL metadata enrichment — no changes |
| `mcp.js` | MCP server — no changes |
| `index.js` | Public API — update adapter exports |
| `cli.js` | CLI — update adapter wiring, simplify source config |

### Dropped

| Module | Reason |
|---|---|
| `adapters/sqlite.js` | Replaced by NanoClaw-native adapter |
| `adapters/jsonl.js` | No JSONL source in NanoClaw |
| `adapters/stdin.js` | No stdin source in NanoClaw |

### New

| Module | Purpose |
|---|---|
| `adapters/nanoclaw.js` | NanoClaw-native adapter for `messages.db` |
| `config.js` | Rewritten — simplified config with NanoClaw conventions |

## NanoClaw Adapter (`adapters/nanoclaw.js`)

### Source Schema

The adapter reads from NanoClaw's `messages.db`, which contains:

**`messages` table:**
```
id (TEXT)                        — Message unique ID
chat_jid (TEXT)                  — Foreign key to chats.jid
sender (TEXT)                    — Sender user ID
sender_name (TEXT)               — Display name
content (TEXT)                   — Message body
timestamp (INTEGER)              — Unix timestamp
is_from_me (BOOLEAN)             — True if bot sent this
is_bot_message (BOOLEAN)         — True if from any bot
reply_to_message_id (TEXT)       — Thread parent
reply_to_message_content (TEXT)  — Cached replied text
reply_to_sender_name (TEXT)      — Original author name
PRIMARY KEY: (id, chat_jid)
```

**`chats` table:**
```
jid (TEXT, PRIMARY KEY)          — Unique channel ID (e.g., tg:123456789)
name (TEXT)                      — Chat display name
last_message_time (INTEGER)      — Most recent message timestamp
channel (TEXT)                   — Channel type (telegram, etc.)
is_group (BOOLEAN)               — Group vs DM
```

### Adapter Interface

```js
const adapter = nanoclaw.create({
  path: '/path/to/messages.db',   // auto-discovered if omitted
  groupsOnly: true,               // default: true (filter chats.is_group)
  skipBotMessages: true,          // default: true (skip is_from_me + is_bot_message)
  chatJids: null,                 // optional: restrict to specific chat_jid list
});
```

### Query Strategy

```sql
SELECT m.id, m.content, m.sender_name, m.timestamp, m.chat_jid
FROM messages m
JOIN chats c ON m.chat_jid = c.jid
WHERE m.rowid > ?                       -- cursor tracking via rowid
  AND m.is_from_me = 0                  -- skip bot's own messages
  AND m.is_bot_message = 0              -- skip bot markers
  AND c.is_group = 1                    -- groups only (when groupsOnly=true)
ORDER BY m.rowid ASC
```

Note: Using `m.rowid` for cursor instead of composite `(id, chat_jid)` — rowid is monotonically increasing and simpler for cursor tracking.

### Column Mapping

| Adapter output | Source |
|---|---|
| `id` | `messages.rowid` (cast to string) |
| `content` | `messages.content` |
| `sender` | `messages.sender_name` |
| `timestamp` | `messages.timestamp` (unix → ISO 8601) |
| `conversationId` | `messages.chat_jid` |

### Validate Method

- Check `messages.db` exists at path
- Check `messages` and `chats` tables exist
- Check at least one group conversation exists (when `groupsOnly=true`)
- Return `{ ok: true, groupCount, messageCount }`

## Config (`config.js`)

### Auto-Discovery

1. Check `NANOCLAW_MESSAGES_DB` env var
2. Check `~/nanoclaw/store/messages.db`
3. Fall back to explicit `source.path` in config file

### Environment Variables

| Variable | Purpose | Fallback |
|---|---|---|
| `NANOCLAW_MESSAGES_DB` | Path to NanoClaw's messages.db | auto-discover |
| `NANOCLAW_MEMORY_DB` | Output lizardbrain-nc.db path | `LIZARDBRAIN_DB_PATH` → `./lizardbrain-nc.db` |
| `NANOCLAW_GROUPS_ONLY` | Filter to group chats only | `true` |
| `LIZARDBRAIN_LLM_BASE_URL` | LLM API endpoint | `LLM_BASE_URL` |
| `LIZARDBRAIN_LLM_API_KEY` | LLM API key | `LLM_API_KEY` |
| `LIZARDBRAIN_LLM_MODEL` | LLM model name | `LLM_MODEL` |
| `LIZARDBRAIN_PROFILE` | Extraction profile | `knowledge` |
| `LIZARDBRAIN_EMBEDDING_*` | Embedding config | (same as original) |

The `LIZARDBRAIN_*` env vars are kept for the extraction/LLM/embedding layer since they're not NanoClaw-specific.

### Config File

Still supports `lizardbrain-nc.json` (or `lizardbrain.json` for backward compat) with simplified source section:

```json
{
  "source": {
    "path": "/path/to/messages.db",
    "groupsOnly": true,
    "skipBotMessages": true,
    "chatJids": ["tg:-1001234567890"]
  },
  "llm": { "baseUrl": "...", "apiKey": "...", "model": "..." },
  "profile": "team"
}
```

No `type`, `table`, `columns`, `filter`, `contentParser`, or `conversationFilter` fields — all of that is hardcoded in the NanoClaw adapter.

## Public API Changes (`index.js`)

```js
module.exports = {
  // Schema, extraction, config, driver, query, search, embeddings,
  // enrichers, MCP, context — all unchanged

  // Adapters — single adapter
  adapters: {
    nanoclaw: require('./adapters/nanoclaw'),
  },
};
```

## CLI Changes (`cli.js`)

- `createAdapter()` always creates a NanoClaw adapter (no `source.type` switch)
- `init` defaults output DB to `lizardbrain-nc.db`
- `extract` auto-discovers `messages.db` if no config
- Help text updated to reference NanoClaw
- Binary name: `lizardbrain-nc`

## MCP Server

No changes to `mcp.js`. The MCP server exposes `search`, `get_context`, and `who_knows` tools — these read from the output `lizardbrain-nc.db`, not the source. NanoClaw agents configure it in their `.mcp.json`:

```json
{
  "mcpServers": {
    "lizardbrain": {
      "command": "node",
      "args": ["/path/to/lizardbrain-nc/src/cli.js", "serve"],
      "env": {
        "NANOCLAW_MEMORY_DB": "/path/to/lizardbrain-nc.db"
      }
    }
  }
}
```

## Package.json

```json
{
  "name": "lizardbrain-nc",
  "version": "0.1.0",
  "description": "Persistent memory for NanoClaw agent conversations.",
  "main": "src/index.js",
  "bin": { "lizardbrain-nc": "src/cli.js" },
  "keywords": ["nanoclaw", "memory", "extraction", "sqlite", "fts5", "llm", "knowledge-base"],
  "engines": { "node": ">=18.0.0" }
}
```

Dependencies identical to original Lizardbrain.

## Project Structure

```
lizardbrain-nc/
  src/
    index.js          — Public API (updated adapter exports)
    cli.js            — CLI (simplified adapter wiring)
    config.js         — Config (rewritten with NanoClaw auto-discovery)
    driver.js         — DB driver abstraction (unchanged)
    schema.js         — SQLite schema (unchanged)
    store.js          — Read/write knowledge (unchanged)
    profiles.js       — Profile definitions (unchanged)
    llm.js            — LLM client (unchanged)
    extractor.js      — Extraction pipeline (unchanged)
    embeddings.js     — Embedding pipeline (unchanged)
    search.js         — Hybrid search (unchanged)
    context.js        — Context assembly (unchanged)
    mcp.js            — MCP server (unchanged)
    adapters/
      nanoclaw.js     — NanoClaw-native adapter (new)
    enrichers/
      url.js          — URL enrichment (unchanged)
  test/
    run.js            — Test suite (adapted for NanoClaw adapter)
  examples/
    lizardbrain-nc.json  — Example config for NanoClaw
  README.md           — NanoClaw-focused docs
  package.json        — New package identity
  CLAUDE.md           — Project instructions for Claude
```

## Testing Strategy

- Copy and adapt `test/run.js` from Lizardbrain
- Replace generic SQLite adapter tests with NanoClaw adapter tests
- Create a test fixture: small `messages.db` with NanoClaw schema (messages + chats tables, mix of group/DM, bot/human messages)
- Extraction, search, MCP, and profile tests should pass with minimal changes (they operate on the output DB, not the source)

## Migration Path

This is a clean-slate project. No migration from existing Lizardbrain databases. Users run `lizardbrain-nc init` to create a fresh output DB, then `lizardbrain-nc extract` to populate from NanoClaw's `messages.db`.
