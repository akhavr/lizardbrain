# lizardbrain-nc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a hard fork of Lizardbrain adapted for NanoClaw — NanoClaw-native adapter, zero-config auto-discovery, simplified config, clean project identity.

**Architecture:** Copy Lizardbrain@1.0.2 source into a new repo at `/Users/oleksiinikitin/Documents/Repos/lizardbrain-nc`. Replace the generic adapters with a single NanoClaw-native adapter that reads from `messages.db` (messages + chats tables). Rewrite config.js for `LBNC_*` env vars and auto-discovery. Update CLI and index.js to wire the new adapter. Adapt tests.

**Tech Stack:** Node.js >= 18, CommonJS, SQLite (CLI + optional better-sqlite3), FTS5, sqlite-vec (optional)

**Spec:** `docs/superpowers/specs/2026-04-11-lizardbrain-nc-design.md` (in the lizardbrain repo)

---

## File Map

### New files (created from scratch)
- `src/adapters/nanoclaw.js` — NanoClaw-native adapter
- `src/config.js` — Rewritten config with auto-discovery and `LBNC_*` env vars
- `package.json` — New package identity
- `CLAUDE.md` — Project instructions
- `examples/lizardbrain-nc.json` — Example config
- `test/fixture/create-fixture.js` — Script to create NanoClaw test fixture DB

### Modified files (copied from lizardbrain, then edited)
- `src/index.js` — Update adapter exports (remove sqlite/jsonl/stdin, add nanoclaw)
- `src/cli.js` — Replace `createAdapter()` switch, update help text, rename binary
- `src/extractor.js` — Fix cursor comparison to use numeric (not string)
- `src/store.js` — No changes needed (setCursor already stores as string, which is fine)
- `test/run.js` — Replace source DB fixture with NanoClaw schema, update adapter tests

### Unchanged files (copied as-is)
- `src/driver.js`, `src/schema.js`, `src/store.js`, `src/profiles.js`, `src/llm.js`
- `src/embeddings.js`, `src/search.js`, `src/context.js`, `src/mcp.js`
- `src/enrichers/url.js`

### Deleted files (not copied)
- `src/adapters/sqlite.js`, `src/adapters/jsonl.js`, `src/adapters/stdin.js`
- `examples/` (old OpenClaw examples)

---

### Task 1: Scaffold Project — Copy Source, New Git, New Identity

**Files:**
- Create: `/Users/oleksiinikitin/Documents/Repos/lizardbrain-nc/` (entire project)
- Create: `package.json`
- Create: `CLAUDE.md`
- Create: `.gitignore`

- [ ] **Step 1: Create directory and copy source files**

```bash
mkdir -p /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc

# Copy src (excluding dropped adapters)
mkdir -p src/adapters src/enrichers
for f in index.js cli.js config.js driver.js schema.js store.js profiles.js llm.js extractor.js embeddings.js search.js context.js mcp.js; do
  cp /Users/oleksiinikitin/Documents/Repos/lizardbrain/src/$f src/$f
done
cp /Users/oleksiinikitin/Documents/Repos/lizardbrain/src/enrichers/url.js src/enrichers/url.js

# Copy test dir
mkdir -p test
cp /Users/oleksiinikitin/Documents/Repos/lizardbrain/test/run.js test/run.js

# Copy LICENSE
cp /Users/oleksiinikitin/Documents/Repos/lizardbrain/LICENSE LICENSE 2>/dev/null || true
```

- [ ] **Step 2: Create package.json**

```json
{
  "name": "lizardbrain-nc",
  "version": "0.1.0",
  "description": "Persistent memory for NanoClaw agent conversations.",
  "main": "src/index.js",
  "bin": {
    "lizardbrain-nc": "src/cli.js"
  },
  "scripts": {
    "init": "node src/cli.js init",
    "extract": "node src/cli.js extract",
    "stats": "node src/cli.js stats",
    "serve": "node src/cli.js serve",
    "test": "node test/run.js"
  },
  "keywords": [
    "nanoclaw",
    "memory",
    "extraction",
    "sqlite",
    "fts5",
    "llm",
    "knowledge-base",
    "vector",
    "hybrid-search"
  ],
  "files": [
    "src/",
    "README.md",
    "LICENSE",
    "examples/"
  ],
  "publishConfig": {
    "access": "public"
  },
  "author": "Oleksii Nikitin",
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  },
  "optionalDependencies": {
    "@ai-sdk/anthropic": "^3.0.64",
    "better-sqlite3": "^12.8.0",
    "sqlite-vec": "^0.1.7"
  },
  "dependencies": {
    "@ai-sdk/openai-compatible": "^2.0.37",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ai": "^6.0.142",
    "zod": "^4.3.6"
  }
}
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
.test-data/
*.db
*.db-wal
*.db-shm
.env
.superpowers/
```

- [ ] **Step 4: Create CLAUDE.md**

```markdown
# Lizardbrain-NC

NanoClaw fork of Lizardbrain. Persistent memory for NanoClaw agent conversations. Reads messages from NanoClaw's messages.db, extracts structured knowledge via any LLM, stores in SQLite with FTS5 and optional vector hybrid search.

## Architecture

Hard fork of lizardbrain@1.0.2 with:
- NanoClaw-native adapter (hardcoded to messages.db schema)
- Zero-config auto-discovery of NanoClaw paths
- LBNC_* environment variable prefix
- Dropped: generic SQLite/JSONL/stdin adapters

Data flow: `NanoClaw messages.db → NanoClaw Adapter → URL Enricher → LLM Extraction → lizardbrain-nc.db + FTS5 [→ Embedding Pipeline → vec0 → Hybrid Search]`

## Project Structure

```
src/
  index.js        — Public API
  cli.js          — CLI (init, extract, stats, search, who, serve)
  config.js       — Config (LBNC_* env vars, auto-discovery)
  driver.js       — DB driver (BetterSqliteDriver / CliDriver)
  schema.js       — SQLite schema (7 entity tables + FTS5 + vec0)
  store.js        — Knowledge read/write, dedup, queries
  profiles.js     — Extraction profiles
  llm.js          — LLM client
  extractor.js    — Extraction pipeline
  embeddings.js   — Embedding pipeline
  search.js       — Hybrid search (FTS5 + kNN + RRF)
  context.js      — Context assembly
  mcp.js          — MCP server
  adapters/
    nanoclaw.js   — NanoClaw messages.db adapter
  enrichers/
    url.js        — URL metadata enrichment
```

## Code Conventions

- CommonJS (require/module.exports), single quotes, semicolons, 2-space indent, camelCase
- SQL: `esc()` helper for escaping; parameterized queries with `?` for better-sqlite3
- Error handling: try-catch for I/O; `{ ok, error }` for validation; throw for unrecoverable

## Commands

```bash
npm test              # Run test suite
npm run init          # Initialize memory database
npm run extract       # Run extraction pipeline
npm run stats         # Show database statistics
```

## Environment Variables

All use `LBNC_` prefix. Legacy `LIZARDBRAIN_*` aliases accepted as fallback.

- `LBNC_MESSAGES_DB` — Path to NanoClaw messages.db
- `LBNC_MEMORY_DB` — Output DB path (default: ./lizardbrain-nc.db)
- `LBNC_LLM_BASE_URL`, `LBNC_LLM_API_KEY`, `LBNC_LLM_MODEL` — LLM config
- `LBNC_PROFILE` — Extraction profile (knowledge/team/project/full)
```

- [ ] **Step 5: Initialize git repo**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
git init
git add -A
git commit -m "feat: scaffold lizardbrain-nc from lizardbrain@1.0.2"
```

---

### Task 2: NanoClaw Adapter (`src/adapters/nanoclaw.js`)

**Files:**
- Create: `src/adapters/nanoclaw.js`
- Create: `test/fixture/create-fixture.js`

- [ ] **Step 1: Create test fixture script**

Create `test/fixture/create-fixture.js` — a script that creates a NanoClaw-schema `messages.db` with test data:

```js
#!/usr/bin/env node
/**
 * Creates a NanoClaw-schema messages.db for testing.
 * Usage: node test/fixture/create-fixture.js <output-path>
 */
const { execSync } = require('child_process');
const path = process.argv[2] || './test-messages.db';

execSync(`sqlite3 "${path}"`, {
  input: `
    CREATE TABLE chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time INTEGER,
      channel TEXT,
      is_group INTEGER
    );

    CREATE TABLE messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp INTEGER,
      is_from_me INTEGER DEFAULT 0,
      is_bot_message INTEGER DEFAULT 0,
      reply_to_message_id TEXT,
      reply_to_message_content TEXT,
      reply_to_sender_name TEXT,
      PRIMARY KEY (id, chat_jid)
    );

    -- Group chat
    INSERT INTO chats VALUES ('tg:-1001234567890', 'Team Chat', 1712000060, 'telegram', 1);
    -- DM chat
    INSERT INTO chats VALUES ('tg:9999', 'Alice DM', 1712000050, 'telegram', 0);

    -- Group messages (human)
    INSERT INTO messages VALUES ('msg1', 'tg:-1001234567890', 'user1', 'Alice', 'I have been using LangChain for our RAG pipeline, works great with chunk size 512', 1712000010, 0, 0, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('msg2', 'tg:-1001234567890', 'user2', 'Bob', 'We switched to LlamaIndex last month, much better for large PDFs', 1712000020, 0, 0, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('msg3', 'tg:-1001234567890', 'user1', 'Alice', 'Interesting! What embedding model are you using?', 1712000030, 0, 0, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('msg4', 'tg:-1001234567890', 'user2', 'Bob', 'text-embedding-3-small from OpenAI, cheap and decent quality', 1712000040, 0, 0, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('msg5', 'tg:-1001234567890', 'user3', 'Charlie', 'Has anyone tried Claude Code for refactoring? I use it daily on our Python backend', 1712000050, 0, 0, NULL, NULL, NULL);
    INSERT INTO messages VALUES ('msg6', 'tg:-1001234567890', 'user1', 'Alice', 'Claude Code is amazing for large refactors, saved us hours last week', 1712000060, 0, 0, NULL, NULL, NULL);

    -- Bot message in group (should be filtered)
    INSERT INTO messages VALUES ('msg7', 'tg:-1001234567890', 'bot', 'TeamBot', 'Daily standup reminder', 1712000070, 0, 1, NULL, NULL, NULL);

    -- Agent own message in group (should be filtered)
    INSERT INTO messages VALUES ('msg8', 'tg:-1001234567890', 'self', 'LizardBrain', 'Here is your summary...', 1712000080, 1, 0, NULL, NULL, NULL);

    -- DM message (filtered when groupsOnly=true)
    INSERT INTO messages VALUES ('dm1', 'tg:9999', 'user1', 'Alice', 'Hey can you help me with the config?', 1712000050, 0, 0, NULL, NULL, NULL);

    -- Message with NULL booleans (edge case)
    INSERT INTO messages VALUES ('msg9', 'tg:-1001234567890', 'user2', 'Bob', 'Testing null booleans', 1712000090, NULL, NULL, NULL, NULL, NULL);
  `,
  stdio: ['pipe', 'pipe', 'pipe'],
});

console.log(`Created NanoClaw fixture: ${path}`);
```

- [ ] **Step 2: Run fixture script to verify it works**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
mkdir -p test/fixture
node test/fixture/create-fixture.js test/fixture/test-messages.db
sqlite3 test/fixture/test-messages.db "SELECT COUNT(*) FROM messages; SELECT COUNT(*) FROM chats;"
rm test/fixture/test-messages.db
```

Expected: `9` messages, `2` chats.

- [ ] **Step 3: Write the NanoClaw adapter**

Create `src/adapters/nanoclaw.js`:

```js
/**
 * nanoclaw.js — NanoClaw-native adapter for reading messages from messages.db.
 *
 * Hardcoded to NanoClaw's schema (messages + chats tables).
 * Uses rowid for cursor tracking (monotonically increasing integer).
 *
 * Configuration:
 *   {
 *     path: '/path/to/messages.db',   // auto-discovered if omitted
 *     groupsOnly: true,               // filter to chats.is_group = 1
 *     skipOwnMessages: true,          // skip is_from_me = 1
 *     skipBotMessages: true,          // skip is_bot_message = 1
 *     chatJids: null,                 // restrict to specific chat_jid list (overrides groupsOnly)
 *   }
 */

const { createDriver, dbExists, esc } = require('../driver');

function create(config) {
  const {
    path: dbPath,
    groupsOnly = true,
    skipOwnMessages = true,
    skipBotMessages = true,
    chatJids = null,
  } = config;

  let _driver = null;
  function getDriver() {
    if (!_driver) _driver = createDriver(dbPath);
    return _driver;
  }

  return {
    name: 'nanoclaw',

    validate() {
      if (!dbExists(dbPath)) {
        return { ok: false, error: `NanoClaw database not found: ${dbPath}` };
      }

      const tables = getDriver().read("SELECT name FROM sqlite_master WHERE type='table'");
      const tableNames = tables.map(t => t.name);

      if (!tableNames.includes('messages')) {
        return { ok: false, error: `'messages' table not found. Available: ${tableNames.join(', ')}` };
      }
      if (!tableNames.includes('chats')) {
        return { ok: false, error: `'chats' table not found. Available: ${tableNames.join(', ')}` };
      }

      // Count groups
      const groupRows = getDriver().read('SELECT COUNT(*) as cnt FROM chats WHERE COALESCE(is_group, 0) = 1');
      const groupCount = parseInt(groupRows[0]?.cnt || 0);

      // Count total messages
      const msgRows = getDriver().read('SELECT COUNT(*) as cnt FROM messages');
      const messageCount = parseInt(msgRows[0]?.cnt || 0);

      // Count orphaned messages (no matching chat)
      const orphanRows = getDriver().read(
        'SELECT COUNT(*) as cnt FROM messages m LEFT JOIN chats c ON m.chat_jid = c.jid WHERE c.jid IS NULL'
      );
      const orphanCount = parseInt(orphanRows[0]?.cnt || 0);

      // Validate group requirement
      if (groupsOnly && !chatJids && groupCount === 0) {
        return { ok: false, error: 'No group conversations found in NanoClaw database (groupsOnly=true)' };
      }

      return { ok: true, groupCount, messageCount, orphanCount };
    },

    getMessages(afterId) {
      const afterRowid = parseInt(afterId) || 0;

      const conditions = [`m.rowid > ${afterRowid}`];

      if (skipOwnMessages) {
        conditions.push('COALESCE(m.is_from_me, 0) = 0');
      }
      if (skipBotMessages) {
        conditions.push('COALESCE(m.is_bot_message, 0) = 0');
      }

      if (chatJids && chatJids.length > 0) {
        // Explicit chat list overrides groupsOnly
        const jidList = chatJids.map(j => `m.chat_jid = '${esc(String(j))}'`).join(' OR ');
        conditions.push(`(${jidList})`);
      } else if (groupsOnly) {
        conditions.push('COALESCE(c.is_group, 0) = 1');
      }

      const where = conditions.join(' AND ');
      const query = `SELECT m.rowid as _rowid, m.content, m.sender_name, m.timestamp, m.chat_jid FROM messages m JOIN chats c ON m.chat_jid = c.jid WHERE ${where} ORDER BY m.rowid ASC`;
      const rows = getDriver().read(query);

      return rows
        .filter(row => row.content && row.content.length > 0)
        .map(row => ({
          id: String(row._rowid),
          content: row.content,
          sender: row.sender_name || 'unknown',
          timestamp: row.timestamp ? new Date(row.timestamp * 1000).toISOString() : '',
          conversationId: row.chat_jid || null,
        }));
    },

    describe() {
      return {
        path: dbPath,
        format: 'nanoclaw-sqlite',
        tables: ['messages', 'chats'],
        filters: { groupsOnly, skipOwnMessages, skipBotMessages, chatJids },
      };
    },
  };
}

module.exports = { create };
```

- [ ] **Step 4: Verify adapter loads without errors**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
node -e "const a = require('./src/adapters/nanoclaw'); console.log('OK:', typeof a.create)"
```

Expected: `OK: function`

- [ ] **Step 5: Commit**

```bash
git add src/adapters/nanoclaw.js test/fixture/create-fixture.js
git commit -m "feat: add NanoClaw-native adapter for messages.db"
```

---

### Task 3: Rewrite Config (`src/config.js`)

**Files:**
- Modify: `src/config.js` (full rewrite)

- [ ] **Step 1: Rewrite config.js with LBNC_ env vars and auto-discovery**

Replace the entire contents of `src/config.js` with:

```js
/**
 * config.js — Load lizardbrain-nc configuration from file or env vars.
 *
 * Env var prefix: LBNC_*
 * Legacy fallbacks: LIZARDBRAIN_* → generic (LLM_BASE_URL, etc.)
 *
 * Source DB auto-discovery (precedence):
 *   1. Explicit source.path in config file
 *   2. LBNC_MESSAGES_DB env var
 *   3. ~/nanoclaw/store/messages.db
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  memoryDbPath: './lizardbrain-nc.db',
  batchSize: 40,
  minMessages: 5,
  batchOverlap: 0,
  rosterPath: null,
  context: {
    enabled: false,
    tokenBudget: 1000,
    recencyDays: 30,
    maxItems: { decisions: 5, tasks: 10, questions: 5, facts: 5, topics: 3 },
  },
  llm: {
    provider: null,
    baseUrl: '',
    apiKey: '',
    model: '',
    promptTemplate: null,
  },
  source: {
    path: null,
    groupsOnly: true,
    skipOwnMessages: true,
    skipBotMessages: true,
    chatJids: null,
  },
  embedding: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions: null,
    batchTokenLimit: 8000,
  },
  dedup: {
    semantic: false,
    threshold: 0.15,
  },
  profile: null,
  entities: null,
  factCategories: null,
  sourceAgent: null,
  conversationType: null,
};

/**
 * Resolve env var with LBNC_ > LIZARDBRAIN_ > generic fallback chain.
 */
function env(lbncKey, ...fallbacks) {
  const primary = process.env[`LBNC_${lbncKey}`];
  if (primary !== undefined) return primary;

  // Legacy LIZARDBRAIN_ alias
  const legacy = process.env[`LIZARDBRAIN_${lbncKey}`];
  if (legacy !== undefined) return legacy;

  // Generic fallbacks (e.g., LLM_BASE_URL)
  for (const fb of fallbacks) {
    if (process.env[fb] !== undefined) return process.env[fb];
  }
  return undefined;
}

function loadEnv(dir) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  }
}

/**
 * Auto-discover NanoClaw messages.db path.
 * Precedence: config file > LBNC_MESSAGES_DB env > ~/nanoclaw/store/messages.db
 */
function discoverMessagesDb(fileConfigPath) {
  // 1. Explicit config file path (highest priority)
  if (fileConfigPath) return fileConfigPath;

  // 2. Env var
  const envPath = env('MESSAGES_DB');
  if (envPath) return envPath;

  // 3. Default NanoClaw location
  const defaultPath = path.join(os.homedir(), 'nanoclaw', 'store', 'messages.db');
  if (fs.existsSync(defaultPath)) return defaultPath;

  return null;
}

function load(configPath) {
  // Load .env from config directory
  if (configPath) {
    loadEnv(path.dirname(configPath));
  } else {
    loadEnv(process.cwd());
  }

  let fileConfig = {};

  // Try loading config file
  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw);
  } else {
    // Try default locations
    for (const name of ['lizardbrain-nc.json', 'lizardbrain.json']) {
      const p = path.join(process.cwd(), name);
      if (fs.existsSync(p)) {
        fileConfig = JSON.parse(fs.readFileSync(p, 'utf-8'));
        break;
      }
    }
  }

  const groupsOnlyEnv = env('GROUPS_ONLY');

  const config = {
    memoryDbPath: fileConfig.memoryDbPath || env('MEMORY_DB', 'LIZARDBRAIN_DB_PATH') || DEFAULTS.memoryDbPath,
    batchSize: fileConfig.batchSize || parseInt(env('BATCH_SIZE')) || DEFAULTS.batchSize,
    minMessages: fileConfig.minMessages || parseInt(env('MIN_MESSAGES')) || DEFAULTS.minMessages,
    batchOverlap: fileConfig.batchOverlap || parseInt(env('BATCH_OVERLAP')) || DEFAULTS.batchOverlap,
    rosterPath: fileConfig.rosterPath || env('ROSTER_PATH') || DEFAULTS.rosterPath,
    context: {
      enabled: fileConfig.context?.enabled ?? DEFAULTS.context.enabled,
      tokenBudget: fileConfig.context?.tokenBudget || DEFAULTS.context.tokenBudget,
      recencyDays: fileConfig.context?.recencyDays || DEFAULTS.context.recencyDays,
      maxItems: { ...DEFAULTS.context.maxItems, ...fileConfig.context?.maxItems },
    },
    profile: fileConfig.profile || env('PROFILE') || DEFAULTS.profile,
    entities: fileConfig.entities || DEFAULTS.entities,
    factCategories: fileConfig.factCategories || DEFAULTS.factCategories,
    sourceAgent: fileConfig.sourceAgent || env('SOURCE_AGENT') || DEFAULTS.sourceAgent,
    conversationType: fileConfig.conversationType || env('CONVERSATION_TYPE') || DEFAULTS.conversationType,
    llm: {
      provider: fileConfig.llm?.provider || env('LLM_PROVIDER') || DEFAULTS.llm.provider,
      baseUrl: fileConfig.llm?.baseUrl || env('LLM_BASE_URL', 'LLM_BASE_URL') || DEFAULTS.llm.baseUrl,
      apiKey: fileConfig.llm?.apiKey || env('LLM_API_KEY', 'LLM_API_KEY') || DEFAULTS.llm.apiKey,
      model: fileConfig.llm?.model || env('LLM_MODEL', 'LLM_MODEL') || DEFAULTS.llm.model,
      promptTemplate: fileConfig.llm?.promptTemplate || DEFAULTS.llm.promptTemplate,
    },
    source: {
      path: discoverMessagesDb(fileConfig.source?.path),
      groupsOnly: fileConfig.source?.groupsOnly ?? (groupsOnlyEnv !== undefined ? groupsOnlyEnv !== 'false' : DEFAULTS.source.groupsOnly),
      skipOwnMessages: fileConfig.source?.skipOwnMessages ?? DEFAULTS.source.skipOwnMessages,
      skipBotMessages: fileConfig.source?.skipBotMessages ?? DEFAULTS.source.skipBotMessages,
      chatJids: fileConfig.source?.chatJids || DEFAULTS.source.chatJids,
    },
    embedding: {
      enabled: fileConfig.embedding?.enabled || false,
      baseUrl: fileConfig.embedding?.baseUrl || env('EMBEDDING_BASE_URL') || DEFAULTS.embedding.baseUrl,
      apiKey: fileConfig.embedding?.apiKey || env('EMBEDDING_API_KEY') || DEFAULTS.embedding.apiKey,
      model: fileConfig.embedding?.model || env('EMBEDDING_MODEL') || DEFAULTS.embedding.model,
      dimensions: fileConfig.embedding?.dimensions || DEFAULTS.embedding.dimensions,
      batchTokenLimit: fileConfig.embedding?.batchTokenLimit || parseInt(env('EMBEDDING_BATCH_LIMIT')) || DEFAULTS.embedding.batchTokenLimit,
    },
    dedup: {
      semantic: fileConfig.dedup?.semantic || DEFAULTS.dedup.semantic,
      threshold: fileConfig.dedup?.threshold || DEFAULTS.dedup.threshold,
    },
  };

  return config;
}

module.exports = { load, DEFAULTS, discoverMessagesDb };
```

- [ ] **Step 2: Verify config loads**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
node -e "const c = require('./src/config'); const cfg = c.load(); console.log('OK, memoryDbPath:', cfg.memoryDbPath, 'source.groupsOnly:', cfg.source.groupsOnly)"
```

Expected: `OK, memoryDbPath: ./lizardbrain-nc.db source.groupsOnly: true`

- [ ] **Step 3: Commit**

```bash
git add src/config.js
git commit -m "feat: rewrite config with LBNC_ env vars and NanoClaw auto-discovery"
```

---

### Task 4: Update Public API (`src/index.js`)

**Files:**
- Modify: `src/index.js`

- [ ] **Step 1: Update adapter exports**

In `src/index.js`, replace the adapter imports and exports:

Replace:
```js
const sqliteAdapter = require('./adapters/sqlite');
const jsonlAdapter = require('./adapters/jsonl');
const stdinAdapter = require('./adapters/stdin');
```

With:
```js
const nanoclawAdapter = require('./adapters/nanoclaw');
```

Replace:
```js
  // Adapters
  adapters: {
    sqlite: sqliteAdapter,
    jsonl: jsonlAdapter,
    stdin: stdinAdapter,
  },
```

With:
```js
  // Adapters
  adapters: {
    nanoclaw: nanoclawAdapter,
  },
```

- [ ] **Step 2: Verify module loads**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
node -e "const lb = require('./src/index'); console.log('adapters:', Object.keys(lb.adapters)); console.log('has nanoclaw:', typeof lb.adapters.nanoclaw.create)"
```

Expected:
```
adapters: [ 'nanoclaw' ]
has nanoclaw: function
```

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "feat: update public API — single NanoClaw adapter"
```

---

### Task 5: Update CLI (`src/cli.js`)

**Files:**
- Modify: `src/cli.js`

- [ ] **Step 1: Replace createAdapter function**

At the bottom of `src/cli.js`, replace the `createAdapter` function (around line 610-629):

Replace:
```js
function createAdapter(sourceConfig) {
  const type = sourceConfig.type || 'sqlite';

  switch (type) {
    case 'sqlite':
      return lizardbrain.adapters.sqlite.create(sourceConfig);
    case 'jsonl':
      return lizardbrain.adapters.jsonl.create(sourceConfig);
    case 'stdin':
      return lizardbrain.adapters.stdin.create(sourceConfig);
    case 'custom':
      if (sourceConfig.adapterPath) {
        const custom = require(path.resolve(sourceConfig.adapterPath));
        return typeof custom.create === 'function' ? custom.create(sourceConfig) : custom;
      }
      throw new Error('Custom adapter requires "adapterPath" in source config');
    default:
      throw new Error(`Unknown adapter type: ${type}. Use sqlite, jsonl, stdin, or custom.`);
  }
}
```

With:
```js
function createAdapter(sourceConfig) {
  if (!sourceConfig.path) {
    console.error('NanoClaw messages.db not found. Set LBNC_MESSAGES_DB or configure source.path.');
    process.exit(1);
  }
  return lizardbrain.adapters.nanoclaw.create(sourceConfig);
}
```

- [ ] **Step 2: Update CLI header comment and help text**

Replace the top comment block (lines 1-15) with:

```js
#!/usr/bin/env node
/**
 * lizardbrain-nc CLI — NanoClaw fork of lizardbrain.
 *
 * Usage:
 *   lizardbrain-nc init [--force]                    Create memory database
 *   lizardbrain-nc extract [--dry-run] [--reprocess] Run extraction pipeline
 *   lizardbrain-nc stats                             Show database statistics
 *   lizardbrain-nc search <query>                    Search facts and topics
 *   lizardbrain-nc who <keyword>                     Find members with expertise
 *   lizardbrain-nc serve                             Start MCP server
 *
 * Configuration:
 *   Auto-discovers NanoClaw's messages.db, or use LBNC_* env vars.
 *   Place a lizardbrain-nc.json in your working directory for full control.
 */
```

- [ ] **Step 3: Update stats output label**

In the stats case, replace `=== lizardbrain stats ===` with `=== lizardbrain-nc stats ===`.

- [ ] **Step 4: Verify CLI loads**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
node src/cli.js --help 2>&1 || true
```

Should not crash (may show usage or "unknown command" — that's fine).

- [ ] **Step 5: Commit**

```bash
git add src/cli.js
git commit -m "feat: update CLI for NanoClaw — simplified adapter wiring"
```

---

### Task 6: Fix Cursor Comparison in Extractor (`src/extractor.js`)

**Files:**
- Modify: `src/extractor.js`

The extractor compares cursor IDs as strings (line 135-138). With rowid-based cursors, this causes lexicographic bugs (`"9" > "10"`). Fix to use numeric comparison.

- [ ] **Step 1: Fix batchMaxId comparison**

In `src/extractor.js`, replace:

```js
    const batchMaxId = batch.reduce((max, m) => {
      const id = String(m.id);
      return id > max ? id : max;
    }, '0');
```

With:

```js
    const batchMaxId = batch.reduce((max, m) => {
      const id = String(m.id);
      const numId = parseInt(id);
      const numMax = parseInt(max);
      if (!isNaN(numId) && !isNaN(numMax)) return numId > numMax ? id : max;
      return id > max ? id : max;
    }, '0');
```

- [ ] **Step 2: Fix maxId comparison**

In `src/extractor.js`, replace:

```js
      maxId = batchMaxId > maxId ? batchMaxId : maxId;
```

With:

```js
      const numBatch = parseInt(batchMaxId);
      const numMax = parseInt(maxId);
      if (!isNaN(numBatch) && !isNaN(numMax)) {
        maxId = numBatch > numMax ? batchMaxId : maxId;
      } else {
        maxId = batchMaxId > maxId ? batchMaxId : maxId;
      }
```

- [ ] **Step 3: Verify no syntax errors**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
node -e "require('./src/extractor'); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add src/extractor.js
git commit -m "fix: use numeric cursor comparison for rowid-based adapter"
```

---

### Task 7: Create Example Config

**Files:**
- Create: `examples/lizardbrain-nc.json`

- [ ] **Step 1: Create example config**

```bash
mkdir -p /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc/examples
```

Create `examples/lizardbrain-nc.json`:

```json
{
  "memoryDbPath": "./lizardbrain-nc.db",
  "source": {
    "path": "~/nanoclaw/store/messages.db",
    "groupsOnly": true,
    "skipOwnMessages": true,
    "skipBotMessages": true
  },
  "llm": {
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKey": "",
    "model": "claude-sonnet-4-6-20250514"
  },
  "profile": "team",
  "batchSize": 40,
  "context": {
    "enabled": true,
    "tokenBudget": 1000,
    "recencyDays": 30
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add examples/lizardbrain-nc.json
git commit -m "docs: add example NanoClaw config"
```

---

### Task 8: Adapt Test Suite (`test/run.js`)

**Files:**
- Modify: `test/run.js`

The test suite creates a source DB with the old schema (simple `messages` table with `id, sender, content, timestamp`). We need to replace it with the NanoClaw schema and update adapter usage.

- [ ] **Step 1: Update the setup function to use NanoClaw schema**

In `test/run.js`, replace the `setup()` function with:

```js
function setup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Create NanoClaw-schema source database
  execSync(`sqlite3 "${SOURCE_DB}"`, {
    input: `
      CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time INTEGER,
        channel TEXT,
        is_group INTEGER
      );

      CREATE TABLE messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp INTEGER,
        is_from_me INTEGER DEFAULT 0,
        is_bot_message INTEGER DEFAULT 0,
        reply_to_message_id TEXT,
        reply_to_message_content TEXT,
        reply_to_sender_name TEXT,
        PRIMARY KEY (id, chat_jid)
      );

      INSERT INTO chats VALUES ('tg:-1001234567890', 'Team Chat', 1712000060, 'telegram', 1);
      INSERT INTO chats VALUES ('tg:9999', 'Alice DM', 1712000050, 'telegram', 0);

      INSERT INTO messages VALUES ('msg1', 'tg:-1001234567890', 'user1', 'Alice', 'I have been using LangChain for our RAG pipeline, works great with chunk size 512', 1712000010, 0, 0, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('msg2', 'tg:-1001234567890', 'user2', 'Bob', 'We switched to LlamaIndex last month, much better for large PDFs', 1712000020, 0, 0, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('msg3', 'tg:-1001234567890', 'user1', 'Alice', 'Interesting! What embedding model are you using?', 1712000030, 0, 0, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('msg4', 'tg:-1001234567890', 'user2', 'Bob', 'text-embedding-3-small from OpenAI, cheap and decent quality', 1712000040, 0, 0, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('msg5', 'tg:-1001234567890', 'user3', 'Charlie', 'Has anyone tried Claude Code for refactoring? I use it daily on our Python backend', 1712000050, 0, 0, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('msg6', 'tg:-1001234567890', 'user1', 'Alice', 'Claude Code is amazing for large refactors, saved us hours last week', 1712000060, 0, 0, NULL, NULL, NULL);

      INSERT INTO messages VALUES ('msg7', 'tg:-1001234567890', 'bot', 'TeamBot', 'Daily standup reminder', 1712000070, 0, 1, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('msg8', 'tg:-1001234567890', 'self', 'LizardBrain', 'Here is your summary...', 1712000080, 1, 0, NULL, NULL, NULL);
      INSERT INTO messages VALUES ('dm1', 'tg:9999', 'user1', 'Alice', 'Hey can you help me with the config?', 1712000050, 0, 0, NULL, NULL, NULL);
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
```

- [ ] **Step 2: Update adapter creation in test functions**

Find all instances where the test creates a source adapter. Replace the old pattern:

```js
const adapter = lizardbrain.adapters.sqlite.create({
  path: SOURCE_DB,
  table: 'messages',
  columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
});
```

With:

```js
const adapter = lizardbrain.adapters.nanoclaw.create({
  path: SOURCE_DB,
  groupsOnly: true,
  skipOwnMessages: true,
  skipBotMessages: true,
});
```

Apply this replacement everywhere an adapter is created in the test file.

- [ ] **Step 3: Add NanoClaw adapter-specific tests**

Add a new test function after the existing adapter tests. Insert before the `run()` call at the bottom:

```js
function testNanoclawAdapter() {
  console.log('\n--- Test: NanoClaw adapter ---');

  // Test: groups only (default)
  const adapter = lizardbrain.adapters.nanoclaw.create({
    path: SOURCE_DB,
    groupsOnly: true,
    skipOwnMessages: true,
    skipBotMessages: true,
  });
  const validation = adapter.validate();
  assert(validation.ok === true, 'Validation passes');
  assert(validation.groupCount === 1, 'Detects 1 group chat');
  assert(validation.orphanCount === 0, 'No orphaned messages');

  const msgs = adapter.getMessages('0');
  assert(msgs.length === 6, 'Gets 6 human group messages (skips bot, own, DM)');
  assert(msgs[0].sender === 'Alice', 'First message sender is Alice');
  assert(msgs[0].conversationId === 'tg:-1001234567890', 'conversationId is chat_jid');
  assert(msgs[0].timestamp.includes('2024-'), 'Timestamp converted to ISO 8601');

  // Test: cursor advances
  const firstId = msgs[0].id;
  const remaining = adapter.getMessages(firstId);
  assert(remaining.length === 5, 'Cursor skips first message');

  // Test: include DMs
  const allAdapter = lizardbrain.adapters.nanoclaw.create({
    path: SOURCE_DB,
    groupsOnly: false,
    skipOwnMessages: true,
    skipBotMessages: true,
  });
  const allMsgs = allAdapter.getMessages('0');
  assert(allMsgs.length === 7, 'With groupsOnly=false, gets 7 messages (includes DM)');

  // Test: include bot messages
  const botAdapter = lizardbrain.adapters.nanoclaw.create({
    path: SOURCE_DB,
    groupsOnly: true,
    skipOwnMessages: true,
    skipBotMessages: false,
  });
  const botMsgs = botAdapter.getMessages('0');
  assert(botMsgs.length === 7, 'With skipBotMessages=false, gets 7 messages (includes bot)');

  // Test: chatJids overrides groupsOnly
  const jidAdapter = lizardbrain.adapters.nanoclaw.create({
    path: SOURCE_DB,
    groupsOnly: true,
    chatJids: ['tg:9999'],
  });
  const jidMsgs = jidAdapter.getMessages('0');
  assert(jidMsgs.length === 1, 'chatJids overrides groupsOnly — gets DM');

  // Test: describe
  const desc = adapter.describe();
  assert(desc.format === 'nanoclaw-sqlite', 'describe() returns correct format');
  assert(desc.filters.groupsOnly === true, 'describe() includes filter state');
}
```

- [ ] **Step 4: Add testNanoclawAdapter to the run function**

Find the `run()` or `main()` test execution function and add `testNanoclawAdapter()` to the test list (before the extraction tests, since it tests the adapter in isolation).

- [ ] **Step 5: Run the tests**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
npm test
```

Fix any failures. The adapter tests should pass. Extraction tests may need adjustment if they depend on specific message counts.

- [ ] **Step 6: Commit**

```bash
git add test/run.js
git commit -m "test: adapt test suite for NanoClaw adapter"
```

---

### Task 9: Install Dependencies and Run Full Test Suite

**Files:** None (just npm install and verification)

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
npm install
```

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

- [ ] **Step 3: Fix any remaining test failures**

If tests fail, fix the issues. Common things to check:
- Adapter tests: message counts may differ from old tests
- Extraction tests: mock LLM responses should still work (they operate on the output DB)
- Stats tests: label changes (`lizardbrain-nc stats`)

- [ ] **Step 4: Commit fixes if any**

```bash
git add -A
git commit -m "fix: resolve test failures after fork adaptation"
```

---

### Task 10: Final Cleanup and Verification

**Files:**
- Review all `src/*.js` for stale references

- [ ] **Step 1: Grep for stale references**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
grep -r "openclaw\|clawmem\|adapters/sqlite\|adapters/jsonl\|adapters/stdin" src/ --include="*.js" -l
```

Fix any files that still reference dropped adapters or old project names.

- [ ] **Step 2: Verify the CLI binary name works**

```bash
cd /Users/oleksiinikitin/Documents/Repos/lizardbrain-nc
node src/cli.js stats 2>&1 || true
```

Should either show stats or "Memory database not found" (expected, since no DB is initialized).

- [ ] **Step 3: Run test suite one final time**

```bash
npm test
```

All tests should pass.

- [ ] **Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: clean up stale references from lizardbrain fork"
```

- [ ] **Step 5: Final git log**

```bash
git log --oneline
```

Should show a clean commit history:
```
chore: clean up stale references from lizardbrain fork
fix: resolve test failures after fork adaptation
test: adapt test suite for NanoClaw adapter
docs: add example NanoClaw config
fix: use numeric cursor comparison for rowid-based adapter
feat: update CLI for NanoClaw — simplified adapter wiring
feat: update public API — single NanoClaw adapter
feat: rewrite config with LBNC_ env vars and NanoClaw auto-discovery
feat: add NanoClaw-native adapter for messages.db
feat: scaffold lizardbrain-nc from lizardbrain@1.0.2
```
