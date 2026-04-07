# Entity Cross-References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a knowledge graph layer via directed, typed links between entities — created by the LLM during extraction and manageable via MCP.

**Architecture:** New `entity_links` junction table stores directional relationships. LLM extraction prompt includes a `links` section referencing entities by `type:id` (existing) or `type:new:index` (same-batch). `processExtraction()` resolves references to actual IDs and stores links. MCP exposes `add_link` and `get_links` tools.

**Tech Stack:** Node.js, SQLite, Zod schemas, Vercel AI SDK

---

### Task 1: Schema — `entity_links` table and v1.0 migration

**Files:**
- Modify: `src/schema.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after `testMigrationV09`:

```javascript
function testMigrationV10() {
  console.log('\n--- Test: migration v1.0 (entity_links) ---');

  const V09_DB = path.join(TEST_DIR, 'v09.db');
  if (fs.existsSync(V09_DB)) fs.unlinkSync(V09_DB);
  lizardbrain.init(V09_DB, { profile: 'full' });
  const driver = createDriver(V09_DB);

  // Force version to 0.9 to trigger migration
  driver.write("UPDATE lizardbrain_meta SET value = '0.9' WHERE key = 'schema_version';");

  const result = migrate(driver);
  assert(result.migrated === true, 'v1.0 migration ran');

  // Verify entity_links table exists
  const tables = execSync(`sqlite3 "${V09_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('entity_links'), 'entity_links table exists');

  // Verify columns
  const cols = driver.read('PRAGMA table_info(entity_links)');
  const colNames = cols.map(c => c.name);
  assert(colNames.includes('from_type'), 'entity_links has from_type');
  assert(colNames.includes('from_id'), 'entity_links has from_id');
  assert(colNames.includes('to_type'), 'entity_links has to_type');
  assert(colNames.includes('to_id'), 'entity_links has to_id');
  assert(colNames.includes('relation'), 'entity_links has relation');

  // Verify schema version
  const version = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  assert(version[0]?.value === '1.0', 'Schema version set to 1.0');

  // Idempotent
  const result2 = migrate(driver);
  assert(result2.migrated === false, 'Second v1.0 migration is no-op');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testMigrationV09();`:

```javascript
  testMigrationV10();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `entity_links` table doesn't exist

- [ ] **Step 4: Add `entity_links` table to SCHEMA_SQL**

In `src/schema.js`, add after the `embedding_metadata` table definition (before `-- Performance indexes`):

```sql
-- Entity cross-references (knowledge graph links)
CREATE TABLE IF NOT EXISTS entity_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_type TEXT NOT NULL,
  from_id INTEGER NOT NULL,
  to_type TEXT NOT NULL,
  to_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(from_type, from_id, to_type, to_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_links_from ON entity_links(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON entity_links(to_type, to_id);
```

- [ ] **Step 5: Update schema version in init()**

Change `'0.9'` to `'1.0'`:

```javascript
  driver.write(`INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '1.0', datetime('now'));`);
```

- [ ] **Step 6: Update version guard in migrate()**

Change from `'0.9'` to `'1.0'`:

```javascript
  if (version >= '1.0') {
    applyIndexes(driver);
    return { migrated: false, message: 'Already at v1.0' };
  }
```

- [ ] **Step 7: Add v1.0 migration block**

At the bottom of `migrate()`, before `applyIndexes(driver);`:

```javascript
  // v1.0 migration: entity_links table for cross-references
  driver.write(`
    CREATE TABLE IF NOT EXISTS entity_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_type TEXT NOT NULL,
      from_id INTEGER NOT NULL,
      to_type TEXT NOT NULL,
      to_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(from_type, from_id, to_type, to_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_links_from ON entity_links(from_type, from_id);
    CREATE INDEX IF NOT EXISTS idx_links_to ON entity_links(to_type, to_id);
  `);

  driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '1.0', datetime('now'));");
```

- [ ] **Step 8: Update existing migration tests**

Update `testMigration()`, `testMigrationV05()`, `testMigrationV08()`, `testMigrationV09()` to expect version `'1.0'`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/schema.js test/run.js
git commit -m "feat: add entity_links table for cross-references (v1.0 schema)"
```

---

### Task 2: Store — link CRUD functions

**Files:**
- Modify: `src/store.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing tests**

Add to `test/run.js` after `testMigrationV10`:

```javascript
function testEntityLinks() {
  console.log('\n--- Test: entity link CRUD ---');

  const db = path.join(TEST_DIR, 'links.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert some entities to link
  store.processExtraction(driver, {
    members: [],
    facts: [{ category: 'tool', content: 'We use PostgreSQL', tags: 'database', confidence: 0.9 }],
    decisions: [{ description: 'Adopt PostgreSQL for production', status: 'agreed', tags: 'database' }],
    tasks: [{ description: 'Set up PostgreSQL cluster', assignee: 'Alice', status: 'open', tags: 'database' }],
    topics: [],
  }, '2026-04-01');

  const facts = driver.read('SELECT id FROM facts LIMIT 1');
  const decisions = driver.read('SELECT id FROM decisions LIMIT 1');
  const tasks = driver.read('SELECT id FROM tasks LIMIT 1');
  const factId = facts[0].id;
  const decisionId = decisions[0].id;
  const taskId = tasks[0].id;

  // addLink: create valid links
  const linkId1 = store.addLink(driver, 'fact', factId, 'decision', decisionId, 'supports');
  assert(typeof linkId1 === 'number', `addLink returns link ID (got ${linkId1})`);

  const linkId2 = store.addLink(driver, 'task', taskId, 'decision', decisionId, 'implements');
  assert(typeof linkId2 === 'number', `addLink returns second link ID (got ${linkId2})`);

  // addLink: reject invalid type
  const badType = store.addLink(driver, 'invalid', 1, 'fact', 1, 'supports');
  assert(badType === false, 'addLink rejects invalid entity type');

  // addLink: reject invalid relation
  const badRelation = store.addLink(driver, 'fact', 1, 'decision', 1, 'destroys');
  assert(badRelation === false, 'addLink rejects invalid relation');

  // addLink: reject duplicate
  const dup = store.addLink(driver, 'fact', factId, 'decision', decisionId, 'supports');
  assert(dup === false, 'addLink rejects duplicate link');

  // getLinks: both directions (default)
  const allLinks = store.getLinks(driver, 'decision', decisionId);
  assert(allLinks.length === 2, `getLinks returns ${allLinks.length} links (expected 2)`);

  // getLinks: from direction only
  const fromLinks = store.getLinks(driver, 'fact', factId, { direction: 'from' });
  assert(fromLinks.length === 1, `getLinks from returns ${fromLinks.length} links (expected 1)`);
  assert(fromLinks[0].to_type === 'decision', 'Link points to decision');
  assert(fromLinks[0].relation === 'supports', 'Link relation is supports');

  // getLinks: to direction only
  const toLinks = store.getLinks(driver, 'decision', decisionId, { direction: 'to' });
  assert(toLinks.length === 2, `getLinks to returns ${toLinks.length} links (expected 2)`);

  // removeLink
  const removed = store.removeLink(driver, linkId1);
  assert(removed === true, 'removeLink returns true');

  const afterRemove = store.getLinks(driver, 'decision', decisionId);
  assert(afterRemove.length === 1, 'One link remaining after removal');

  // removeLink: nonexistent
  const removeBad = store.removeLink(driver, 99999);
  assert(removeBad === false, 'removeLink returns false for nonexistent');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testMigrationV10();`:

```javascript
  testEntityLinks();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.addLink is not a function`

- [ ] **Step 4: Implement link CRUD in `store.js`**

Add after the `findContradictionCandidates` function and its related code:

```javascript
// --- Entity cross-references ---

const VALID_LINK_TYPES = ['fact', 'topic', 'decision', 'task', 'question', 'event', 'member'];
const VALID_RELATIONS = ['implements', 'supports', 'relates', 'blocks', 'answers'];

function addLink(driver, fromType, fromId, toType, toId, relation) {
  if (!VALID_LINK_TYPES.includes(fromType) || !VALID_LINK_TYPES.includes(toType)) return false;
  if (!VALID_RELATIONS.includes(relation)) return false;

  try {
    driver.write(`
      INSERT INTO entity_links (from_type, from_id, to_type, to_id, relation)
      VALUES ('${esc(fromType)}', ${parseInt(fromId)}, '${esc(toType)}', ${parseInt(toId)}, '${esc(relation)}');
    `);
    const last = driver.read('SELECT id FROM entity_links ORDER BY id DESC LIMIT 1');
    return last.length > 0 ? last[0].id : false;
  } catch (e) {
    // UNIQUE constraint violation = duplicate link
    return false;
  }
}

function removeLink(driver, linkId) {
  const existing = driver.read(`SELECT id FROM entity_links WHERE id = ${parseInt(linkId)}`);
  if (existing.length === 0) return false;
  driver.write(`DELETE FROM entity_links WHERE id = ${parseInt(linkId)};`);
  return true;
}

function getLinks(driver, entityType, entityId, options = {}) {
  const { direction = 'both' } = options;
  const id = parseInt(entityId);
  const type = esc(entityType);

  if (direction === 'from') {
    return driver.read(
      `SELECT * FROM entity_links WHERE from_type = '${type}' AND from_id = ${id} ORDER BY created_at DESC`
    );
  }
  if (direction === 'to') {
    return driver.read(
      `SELECT * FROM entity_links WHERE to_type = '${type}' AND to_id = ${id} ORDER BY created_at DESC`
    );
  }
  // both
  return driver.read(
    `SELECT * FROM entity_links WHERE (from_type = '${type}' AND from_id = ${id}) OR (to_type = '${type}' AND to_id = ${id}) ORDER BY created_at DESC`
  );
}
```

- [ ] **Step 5: Export the new functions**

Add `addLink`, `removeLink`, `getLinks` to `module.exports`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/store.js test/run.js
git commit -m "feat: addLink, removeLink, getLinks for entity cross-references"
```

---

### Task 3: LLM — links in extraction schema and prompt

**Files:**
- Modify: `src/llm.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing tests**

Add to `test/run.js` after `testEntityLinks`:

```javascript
function testLinkExtractionSchema() {
  console.log('\n--- Test: link extraction schema ---');

  const { buildExtractionSchema } = require('../src/llm');

  // With context: schema should include links
  const schema = buildExtractionSchema(['members', 'facts', 'decisions', 'tasks'], true);
  const shape = schema.shape;
  assert('links' in shape, 'Schema with context includes links');

  // Validate link data
  const testData = {
    members: [],
    facts: [],
    decisions: [],
    tasks: [],
    updates: null,
    links: [{ from: 'decision:3', to: 'task:new:0', relation: 'implements' }],
  };
  const result = schema.safeParse(testData);
  assert(result.success, 'Schema validates link data');

  // Null links accepted
  const nullLinks = { members: [], facts: [], decisions: [], tasks: [], updates: null, links: null };
  const nullResult = schema.safeParse(nullLinks);
  assert(nullResult.success, 'Schema accepts null links');

  // Multiple entity types without context: schema should include links
  const noCtx = buildExtractionSchema(['facts', 'decisions'], false);
  assert('links' in noCtx.shape, 'Schema includes links when multiple entity types');

  // Single entity type without context: no links
  const single = buildExtractionSchema(['facts'], false);
  assert(!('links' in single.shape), 'Schema excludes links with single entity type');
}

function testLinkPromptRules() {
  console.log('\n--- Test: link prompt rules ---');

  const { buildPrompt } = require('../src/llm');
  const { getProfile } = require('../src/profiles');

  // With context: prompt should include link rules
  const profileConfig = getProfile('team');
  const prompt = buildPrompt('test messages', profileConfig, { contextSection: 'some context' });
  assert(prompt.includes('"links"'), 'Prompt with context includes links schema');
  assert(prompt.includes('Link rules'), 'Prompt with context includes link rules');
  assert(prompt.includes('type:new:index'), 'Prompt includes new entity reference format');
}
```

- [ ] **Step 2: Register the tests**

In `runAll()`, add after `testEntityLinks();`:

```javascript
  testLinkExtractionSchema();
  testLinkPromptRules();
```

- [ ] **Step 3: Run test to verify they fail**

Run: `npm test`
Expected: FAIL — no `links` in schema

- [ ] **Step 4: Add link Zod schema to `llm.js`**

After the `contradictionSchema` definition (around line 289), add:

```javascript
// --- Entity cross-reference links ---

const linkSchema = z.object({
  from: z.string(),
  to: z.string(),
  relation: z.enum(['implements', 'supports', 'relates', 'blocks', 'answers']),
});
```

- [ ] **Step 5: Add links to `buildExtractionSchema()`**

In `src/llm.js`, in the `buildExtractionSchema` function, after the `updates` block (around line 277), add:

```javascript
  // Add links when context is present or multiple entity types allow same-batch linking
  if (hasContext || entities.length > 1) {
    shape.links = z.array(linkSchema).nullable();
  }
```

- [ ] **Step 6: Add link schema fragment to `buildPrompt()`**

In `src/llm.js`, in `buildPrompt()`, after the update schema is added to `schemaFragments` (after line 100), add:

```javascript
  // Add links schema if context or multiple entities
  if (contextSection || entities.length > 1) {
    schemaFragments.push(`  "links": [
    {
      "from": "type:id or type:new:index",
      "to": "type:id or type:new:index",
      "relation": "one of: implements, supports, relates, blocks, answers"
    }
  ]`);
  }
```

- [ ] **Step 7: Add link rules to `buildPrompt()`**

In `src/llm.js`, in `buildPrompt()`, after the update rules block (after line 130), add:

```javascript
  // Add link rules
  if (contextSection || entities.length > 1) {
    rulesFragments.push(`Link rules:
- Reference existing entities by type:id (e.g. "decision:3", "task:7")
- Reference new entities from this batch by type:new:index (e.g. "task:new:0", "fact:new:1")
- Only create links when there is a clear, explicit relationship
- Do not link entities that are merely mentioned in the same message
- Valid relation types: implements, supports, relates, blocks, answers`);
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/llm.js test/run.js
git commit -m "feat: links in extraction schema and prompt for entity cross-references"
```

---

### Task 4: Store — resolve and store links in processExtraction()

**Files:**
- Modify: `src/store.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing test**

Add to `test/run.js` after `testLinkPromptRules`:

```javascript
function testProcessExtractionLinks() {
  console.log('\n--- Test: processExtraction resolves and stores links ---');

  const db = path.join(TEST_DIR, 'extraction-links.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert an existing decision first
  store.processExtraction(driver, {
    members: [],
    facts: [],
    decisions: [{ description: 'Use PostgreSQL for production', status: 'agreed', tags: 'database' }],
    topics: [],
  }, '2026-04-01');

  const existingDecision = driver.read('SELECT id FROM decisions LIMIT 1');
  const decisionId = existingDecision[0].id;

  // Now extract with links referencing both existing and new entities
  const result = store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'PostgreSQL supports JSONB columns', tags: 'database', confidence: 0.9 },
    ],
    tasks: [
      { description: 'Configure PostgreSQL replication', assignee: 'Bob', status: 'open', tags: 'database' },
    ],
    decisions: [],
    topics: [],
    links: [
      { from: `fact:new:0`, to: `decision:${decisionId}`, relation: 'supports' },
      { from: `task:new:0`, to: `decision:${decisionId}`, relation: 'implements' },
    ],
  }, '2026-04-02');

  assert(result.totalLinks === 2, `totalLinks is ${result.totalLinks} (expected 2)`);

  // Verify links were stored with resolved IDs
  const links = store.getLinks(driver, 'decision', decisionId, { direction: 'to' });
  assert(links.length === 2, `Decision has ${links.length} incoming links (expected 2)`);
  const relations = links.map(l => l.relation).sort();
  assert(relations.includes('implements'), 'Has implements link');
  assert(relations.includes('supports'), 'Has supports link');

  // Same-batch linking: link between two new entities
  const result2 = store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Redis supports pub/sub messaging', tags: 'redis', confidence: 0.9 },
    ],
    decisions: [
      { description: 'Use Redis for caching', status: 'proposed', tags: 'redis' },
    ],
    topics: [],
    links: [
      { from: 'fact:new:0', to: 'decision:new:0', relation: 'supports' },
    ],
  }, '2026-04-03');

  assert(result2.totalLinks === 1, 'Same-batch link created');

  // Invalid link references should be skipped silently
  const result3 = store.processExtraction(driver, {
    members: [],
    facts: [{ category: 'tool', content: 'Invalid link test fact', tags: 'test', confidence: 0.9 }],
    topics: [],
    links: [
      { from: 'fact:new:0', to: 'decision:99999', relation: 'supports' },
      { from: 'invalid:new:0', to: 'fact:new:0', relation: 'relates' },
    ],
  }, '2026-04-04');

  // The decision:99999 link should still be attempted (addLink doesn't verify entity existence)
  // The invalid:new:0 link should fail silently (invalid type)
  assert(result3.totalLinks <= 1, 'Invalid links handled gracefully');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testLinkPromptRules();`:

```javascript
  testProcessExtractionLinks();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `result.totalLinks` is undefined

- [ ] **Step 4: Add link resolution to `processExtraction()`**

In `src/store.js`, in `processExtraction()`, after the updates block (after line 585), add:

```javascript
  // Process links (entity cross-references)
  let totalLinks = 0;
  if (extracted.links && Array.isArray(extracted.links)) {
    // Map from plural insertedIds keys to singular link types
    const pluralToSingular = { facts: 'fact', topics: 'topic', decisions: 'decision', tasks: 'task', questions: 'question', events: 'event' };

    for (const link of extracted.links) {
      if (!link.from || !link.to || !link.relation) continue;

      const resolveRef = (ref) => {
        const parts = ref.split(':');
        if (parts.length === 3 && parts[1] === 'new') {
          // type:new:index — resolve from insertedIds
          const type = parts[0];
          const index = parseInt(parts[2]);
          // Find the plural key for this type
          const pluralKey = Object.keys(pluralToSingular).find(k => pluralToSingular[k] === type);
          if (!pluralKey || !insertedIds[pluralKey] || index >= insertedIds[pluralKey].length) return null;
          return { type, id: insertedIds[pluralKey][index] };
        }
        if (parts.length === 2) {
          // type:id — direct reference
          return { type: parts[0], id: parseInt(parts[1]) };
        }
        return null;
      };

      const from = resolveRef(link.from);
      const to = resolveRef(link.to);
      if (!from || !to) continue;

      const linkId = addLink(driver, from.type, from.id, to.type, to.id, link.relation);
      if (linkId !== false) totalLinks++;
    }
  }
```

- [ ] **Step 5: Update the return statement**

Update the return in `processExtraction()` to include `totalLinks`:

```javascript
  return { totalFacts, totalTopics, totalMembers, totalDecisions, totalTasks, totalQuestions, totalEvents, totalUpdated, totalLinks, insertedIds, insertedFactIds: insertedIds.facts };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/store.js test/run.js
git commit -m "feat: resolve and store entity links in processExtraction()"
```

---

### Task 5: MCP — add_link and get_links tools

**Files:**
- Modify: `src/mcp.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing test**

Add to `test/run.js` after `testProcessExtractionLinks`:

```javascript
async function testMcpLinkTools() {
  console.log('\n--- Test: MCP link tools ---');

  let mcp;
  try {
    mcp = require('../src/mcp');
  } catch (e) {
    console.log('  SKIP: @modelcontextprotocol/sdk not installed');
    return;
  }

  const mcpDb = path.join(TEST_DIR, 'mcp-links.db');
  if (fs.existsSync(mcpDb)) fs.unlinkSync(mcpDb);
  lizardbrain.init(mcpDb, { profile: 'full' });
  const driver = createDriver(mcpDb);
  migrate(driver);

  // Insert entities
  store.processExtraction(driver, {
    members: [],
    facts: [{ content: 'MCP link test fact', category: 'tool', tags: 'test', confidence: 0.9 }],
    decisions: [{ description: 'MCP link test decision', status: 'agreed', tags: 'test' }],
    topics: [],
  }, '2026-04-01');

  const factId = driver.read('SELECT id FROM facts LIMIT 1')[0].id;
  const decisionId = driver.read('SELECT id FROM decisions LIMIT 1')[0].id;

  const handlers = mcp.createHandlers(driver, {});

  // add_link
  const addResult = await handlers.add_link({
    from_type: 'fact', from_id: factId,
    to_type: 'decision', to_id: decisionId,
    relation: 'supports',
  });
  assert(!addResult.isError, 'add_link: no error');
  assert(addResult.data.link_id > 0, 'add_link: returns link_id');

  // add_link: invalid relation
  const badResult = await handlers.add_link({
    from_type: 'fact', from_id: factId,
    to_type: 'decision', to_id: decisionId,
    relation: 'destroys',
  });
  assert(badResult.isError === true, 'add_link: rejects invalid relation');

  // get_links
  const getResult = await handlers.get_links({
    entity_type: 'decision', entity_id: decisionId,
  });
  assert(!getResult.isError, 'get_links: no error');
  assert(getResult.data.links.length === 1, 'get_links: returns 1 link');
  assert(getResult.data.links[0].relation === 'supports', 'get_links: correct relation');

  // get_links with direction
  const fromResult = await handlers.get_links({
    entity_type: 'fact', entity_id: factId, direction: 'from',
  });
  assert(!fromResult.isError, 'get_links from: no error');
  assert(fromResult.data.links.length === 1, 'get_links from: returns 1 link');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testProcessExtractionLinks();`:

```javascript
  await testMcpLinkTools();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `handlers.add_link is not a function`

- [ ] **Step 4: Add handlers in `mcp.js`**

In `src/mcp.js`, in the `createHandlers` function, add after the `update_entity` handler (before the closing `};`):

```javascript
    async add_link(args) {
      try {
        const { from_type, from_id, to_type, to_id, relation } = args;
        if (!from_type || !from_id || !to_type || !to_id || !relation) {
          return { isError: true, error: 'Required: from_type, from_id, to_type, to_id, relation' };
        }
        const linkId = store.addLink(driver, from_type, from_id, to_type, to_id, relation);
        if (linkId === false) {
          return { isError: true, error: 'Failed to create link. Check types, relation, and that link is not a duplicate.' };
        }
        return { isError: false, data: { link_id: linkId } };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },

    async get_links(args) {
      try {
        const { entity_type, entity_id, direction } = args;
        if (!entity_type || !entity_id) {
          return { isError: true, error: 'Required: entity_type, entity_id' };
        }
        const links = store.getLinks(driver, entity_type, entity_id, { direction: direction || 'both' });
        return { isError: false, data: { links } };
      } catch (e) {
        return { isError: true, error: e.message };
      }
    },
```

- [ ] **Step 5: Register MCP tools on the server**

In `src/mcp.js`, in the `createServer` function, after the `update_entity` server.tool registration (after the write tools section), add:

```javascript
  // --- Link tools ---

  server.tool(
    'add_link',
    'Create a directional link between two entities. Relations: implements, supports, relates, blocks, answers.',
    {
      from_type: z.string().describe('Source entity type (fact, topic, decision, task, question, event, member)'),
      from_id: z.number().describe('Source entity ID'),
      to_type: z.string().describe('Target entity type'),
      to_id: z.number().describe('Target entity ID'),
      relation: z.string().describe('Relation type: implements, supports, relates, blocks, answers'),
    },
    async (args) => {
      const result = await handlers.add_link(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );

  server.tool(
    'get_links',
    'Get links for an entity. Returns directional relationships to/from the entity.',
    {
      entity_type: z.string().describe('Entity type (fact, topic, decision, task, question, event, member)'),
      entity_id: z.number().describe('Entity ID'),
      direction: z.string().optional().describe('Filter: "from" (outgoing), "to" (incoming), "both" (default)'),
    },
    async (args) => {
      const result = await handlers.get_links(args);
      if (result.isError) {
        return { content: [{ type: 'text', text: result.error }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }
  );
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp.js test/run.js
git commit -m "feat: MCP add_link and get_links tools for entity cross-references"
```

---

### Task 6: Version bump and final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Change version from `0.12.0` to `1.0.0`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS with 0 failures

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 1.0.0 for entity cross-references"
```
