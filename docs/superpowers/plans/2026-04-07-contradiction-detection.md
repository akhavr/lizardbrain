# Contradiction Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect when newly extracted entities contradict existing knowledge and mark old entities as superseded, preserving history.

**Architecture:** Post-insertion contradiction check following the same pattern as semantic dedup. After entities are inserted, find similar candidates via hybrid search (kNN + FTS fallback), send to a dedicated LLM call for judgment, then mark old entities with `superseded_by`. Opt-in via config, non-fatal on failure.

**Tech Stack:** Node.js, SQLite (FTS5 + optional sqlite-vec), Zod schemas, Vercel AI SDK

---

### Task 1: Schema — add `superseded_by` column and v0.8 migration

**Files:**
- Modify: `src/schema.js:32-320` (SCHEMA_SQL) and `src/schema.js:353-511` (migrate function)

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after the existing `testMigration` function (after line 772):

```javascript
function testMigrationV08() {
  console.log('\n--- Test: migration v0.8 (superseded_by) ---');

  // Create a v0.7 database
  const V07_DB = path.join(TEST_DIR, 'v07.db');
  if (fs.existsSync(V07_DB)) fs.unlinkSync(V07_DB);
  lizardbrain.init(V07_DB, { profile: 'full' });
  const driver = createDriver(V07_DB);

  // Force version to 0.7 to trigger migration
  driver.write("UPDATE lizardbrain_meta SET value = '0.7' WHERE key = 'schema_version';");

  const result = migrate(driver);
  assert(result.migrated === true, 'v0.8 migration ran');

  // Verify superseded_by column exists on all entity tables
  const tables = ['facts', 'topics', 'decisions', 'tasks', 'questions', 'events', 'members'];
  for (const table of tables) {
    const cols = driver.read(`PRAGMA table_info(${table})`);
    const hasSuperCol = cols.some(c => c.name === 'superseded_by');
    assert(hasSuperCol, `${table} has superseded_by column`);
  }

  // Verify total_superseded column on extraction_state
  const stateCols = driver.read('PRAGMA table_info(extraction_state)');
  const hasSupersededStat = stateCols.some(c => c.name === 'total_superseded');
  assert(hasSupersededStat, 'extraction_state has total_superseded column');

  // Verify schema version is 0.8
  const version = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  assert(version[0]?.value === '0.8', 'Schema version set to 0.8');

  // Idempotent
  const result2 = migrate(driver);
  assert(result2.migrated === false, 'Second v0.8 migration is no-op');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `test/run.js`, in the `runAll()` function (around line 1713), add after `testMigrationV05();`:

```javascript
  testMigrationV08();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `superseded_by` column doesn't exist yet

- [ ] **Step 4: Add `superseded_by` to SCHEMA_SQL**

In `src/schema.js`, add `superseded_by INTEGER` to each entity table in `SCHEMA_SQL`:

In the `facts` table (after `created_at` line):
```javascript
  created_at TEXT DEFAULT (datetime('now')),
  superseded_by INTEGER
```

In the `topics` table (after `created_at` line):
```javascript
  created_at TEXT DEFAULT (datetime('now')),
  superseded_by INTEGER
```

In the `decisions` table (after `updated_at` line):
```javascript
  updated_at TEXT,
  superseded_by INTEGER
```

In the `tasks` table (after `updated_at` line):
```javascript
  updated_at TEXT,
  superseded_by INTEGER
```

In the `questions` table (after `updated_at` line):
```javascript
  updated_at TEXT,
  superseded_by INTEGER
```

In the `events` table (after `created_at` line):
```javascript
  created_at TEXT DEFAULT (datetime('now')),
  superseded_by INTEGER
```

In the `members` table (after `updated_at` line):
```javascript
  updated_at TEXT DEFAULT (datetime('now')),
  superseded_by INTEGER
```

- [ ] **Step 5: Update schema version in init**

In `src/schema.js` `init()` function, change the schema version from `'0.7'` to `'0.8'`:

```javascript
  driver.write(`INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.8', datetime('now'));`);
```

- [ ] **Step 6: Add v0.8 migration block**

In `src/schema.js` `migrate()` function, change the version guard at the top from `'0.7'` to `'0.8'`:

```javascript
  if (version >= '0.8') {
    applyIndexes(driver);
    return { migrated: false, message: 'Already at v0.8' };
  }
```

Then at the bottom, before `applyIndexes(driver);`, add the v0.8 migration:

```javascript
  // v0.8 migration: superseded_by on all entity tables + total_superseded stat
  const supersededTables = ['facts', 'topics', 'decisions', 'tasks', 'questions', 'events', 'members'];
  for (const table of supersededTables) {
    try { driver.write(`ALTER TABLE ${table} ADD COLUMN superseded_by INTEGER;`); }
    catch (e) { /* column already exists */ }
  }
  try { driver.write('ALTER TABLE extraction_state ADD COLUMN total_superseded INTEGER DEFAULT 0;'); }
  catch (e) { /* column already exists */ }

  driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.8', datetime('now'));");
```

Also update the final version write at the end of the existing v0.7 block — change `'0.7'` to `'0.8'` on the last `schema_version` write so full migrations go all the way.

- [ ] **Step 7: Update existing migration test**

In `test/run.js`, `testMigration()`, update the expected version from `'0.7'` to `'0.8'`:

```javascript
  assert(version[0]?.value === '0.8', 'Schema version set to 0.8');
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS including new `testMigrationV08`

- [ ] **Step 9: Commit**

```bash
git add src/schema.js test/run.js
git commit -m "feat: add superseded_by column to all entity tables (v0.8 schema)"
```

---

### Task 2: Store — `markSuperseded()` and search filters

**Files:**
- Modify: `src/store.js` — add `markSuperseded()`, update all search functions and `getActiveContext()`

- [ ] **Step 1: Write failing tests for markSuperseded and search filtering**

Add to `test/run.js` after `testMigrationV08`:

```javascript
function testSupersededFiltering() {
  console.log('\n--- Test: superseded filtering ---');

  const db = path.join(TEST_DIR, 'superseded.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert two facts
  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Team uses Postgres for the main database', tags: 'database', confidence: 0.9 },
      { category: 'tool', content: 'Team migrated to MySQL for the main database', tags: 'database', confidence: 0.9 },
    ],
    topics: [],
  }, '2026-04-01');

  const allFacts = driver.read('SELECT id FROM facts ORDER BY id');
  assert(allFacts.length === 2, 'Two facts inserted');
  const oldId = allFacts[0].id;
  const newId = allFacts[1].id;

  // markSuperseded: old fact gets superseded_by = new fact id
  store.markSuperseded(driver, 'facts', oldId, newId);

  const old = driver.read(`SELECT superseded_by FROM facts WHERE id = ${oldId}`);
  assert(old[0].superseded_by === newId, 'markSuperseded sets superseded_by on old entity');

  // searchFacts should exclude superseded
  const results = store.searchFacts(driver, 'database');
  assert(results.length === 1, 'searchFacts excludes superseded facts');
  assert(results[0].id === newId, 'searchFacts returns only the new fact');

  // getActiveContext should exclude superseded
  const profiles = require('../src/profiles');
  const ctx = store.getActiveContext(driver, profiles.getProfile('full'));
  const supersededInCtx = ctx.facts?.some(f => f.id === oldId);
  assert(!supersededInCtx, 'getActiveContext excludes superseded facts');

  // Insert and supersede a decision
  store.processExtraction(driver, {
    members: [],
    facts: [],
    decisions: [
      { description: 'Use REST for the API', status: 'agreed', tags: 'api' },
      { description: 'Use GraphQL for the API instead of REST', status: 'agreed', tags: 'api' },
    ],
    topics: [],
  }, '2026-04-01');

  const allDecisions = driver.read('SELECT id FROM decisions ORDER BY id');
  store.markSuperseded(driver, 'decisions', allDecisions[0].id, allDecisions[1].id);

  const decResults = store.searchDecisions(driver, 'API');
  assert(decResults.length === 1, 'searchDecisions excludes superseded');
  assert(decResults[0].id === allDecisions[1].id, 'searchDecisions returns only new decision');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testMigrationV08();`:

```javascript
  testSupersededFiltering();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.markSuperseded is not a function`

- [ ] **Step 4: Implement `markSuperseded()` in `store.js`**

Add after the `updateQuestionAnswer` function (after line 324):

```javascript
function markSuperseded(driver, entityType, oldId, newId) {
  const validTypes = ['facts', 'topics', 'decisions', 'tasks', 'questions', 'events', 'members'];
  if (!validTypes.includes(entityType)) return false;
  const existing = driver.read(`SELECT id FROM ${entityType} WHERE id = ${parseInt(oldId)}`);
  if (existing.length === 0) return false;
  driver.write(`UPDATE ${entityType} SET superseded_by = ${parseInt(newId)} WHERE id = ${parseInt(oldId)};`);
  return true;
}
```

- [ ] **Step 5: Update all search functions to exclude superseded**

In `store.js`, update each search function to add `superseded_by IS NULL`:

`searchFacts` (line ~654):
```javascript
function searchFacts(driver, query, limit = 15, minConfidence = 0) {
  const sanitized = esc(sanitizeFtsQuery(query));
  let where = `f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${sanitized}') AND f.superseded_by IS NULL`;
  if (minConfidence > 0) where += ` AND f.confidence >= ${minConfidence}`;
  return driver.read(
    `SELECT f.*, m.display_name as source FROM facts f LEFT JOIN members m ON f.source_member_id = m.id WHERE ${where} ORDER BY f.confidence DESC, f.created_at DESC LIMIT ${limit}`
  );
}
```

`searchTopics` (line ~663):
```javascript
function searchTopics(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM topics WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${sanitized}') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
  );
}
```

`searchMembers` (line ~670):
```javascript
function searchMembers(driver, query) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM members WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${sanitized}') AND superseded_by IS NULL`
  );
}
```

`searchDecisions` (line ~683):
```javascript
function searchDecisions(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM decisions WHERE id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${sanitized}') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
  );
}
```

`searchTasks` (line ~690):
```javascript
function searchTasks(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT t.*, m.display_name as source FROM tasks t LEFT JOIN members m ON t.source_member_id = m.id WHERE t.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${sanitized}') AND t.superseded_by IS NULL ORDER BY t.created_at DESC LIMIT ${limit}`
  );
}
```

`searchQuestions` (line ~698):
```javascript
function searchQuestions(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM questions WHERE id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${sanitized}') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
  );
}
```

`searchEvents` (line ~705):
```javascript
function searchEvents(driver, query, limit = 10) {
  const sanitized = esc(sanitizeFtsQuery(query));
  return driver.read(
    `SELECT * FROM events WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${sanitized}') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
  );
}
```

- [ ] **Step 6: Update `getActiveContext()` to exclude superseded**

In `store.js`, update each query in `getActiveContext()` to add `AND superseded_by IS NULL`:

Decisions query (line ~336):
```javascript
    context.decisions = driver.read(
      `SELECT id, description, status, context FROM decisions WHERE status IN ('proposed', 'agreed') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
    );
```

Tasks query (line ~343):
```javascript
    context.tasks = driver.read(
      `SELECT id, description, assignee, status FROM tasks WHERE status IN ('open', 'blocked') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
    );
```

Questions query (line ~350):
```javascript
    context.questions = driver.read(
      `SELECT id, question, asker, status FROM questions WHERE status = 'open' AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
    );
```

Facts query (line ~357):
```javascript
    context.facts = driver.read(
      `SELECT id, content, confidence FROM facts WHERE created_at >= datetime('now', '-${recencyDays} days') AND superseded_by IS NULL ORDER BY confidence DESC, created_at DESC LIMIT ${limit}`
    );
```

Topics query (line ~364):
```javascript
    context.topics = driver.read(
      `SELECT id, name FROM topics WHERE created_at >= datetime('now', '-${recencyDays} days') AND superseded_by IS NULL ORDER BY created_at DESC LIMIT ${limit}`
    );
```

- [ ] **Step 7: Export `markSuperseded`**

In `store.js` `module.exports` (line ~727), add `markSuperseded`:

```javascript
module.exports = {
  processExtraction,
  // ... existing exports ...
  markSuperseded,
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add src/store.js test/run.js
git commit -m "feat: markSuperseded() and search filters for superseded entities"
```

---

### Task 3: Store — `findContradictionCandidates()`

**Files:**
- Modify: `src/store.js` — add candidate finding with hybrid search

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after `testSupersededFiltering`:

```javascript
function testFindContradictionCandidates() {
  console.log('\n--- Test: find contradiction candidates ---');

  const db = path.join(TEST_DIR, 'candidates.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert some facts
  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Team uses PostgreSQL for the primary database', tags: 'database,postgres', confidence: 0.9 },
      { category: 'tool', content: 'Redis is used for caching layer', tags: 'database,redis', confidence: 0.9 },
      { category: 'opinion', content: 'Python is the best language for data science', tags: 'python,datascience', confidence: 0.8 },
    ],
    topics: [],
  }, '2026-04-01');

  // FTS-based candidate search: should find database-related facts
  const candidates = store.findContradictionCandidates(driver, 'facts', 'Team migrated from PostgreSQL to MySQL', { maxCandidates: 5 });
  assert(candidates.length >= 1, `Found ${candidates.length} candidates (expected >= 1)`);
  assert(candidates.some(c => c.content.includes('PostgreSQL')), 'Found PostgreSQL fact as candidate');

  // Should not find unrelated facts
  const unrelated = store.findContradictionCandidates(driver, 'facts', 'The weather is nice today', { maxCandidates: 5 });
  assert(unrelated.length === 0, 'No candidates for unrelated content');

  // Superseded facts should be excluded
  const allFacts = driver.read('SELECT id FROM facts ORDER BY id');
  driver.write(`UPDATE facts SET superseded_by = 999 WHERE id = ${allFacts[0].id}`);
  const afterSupersede = store.findContradictionCandidates(driver, 'facts', 'Team migrated from PostgreSQL to MySQL', { maxCandidates: 5 });
  const hasSuperseded = afterSupersede.some(c => c.id === allFacts[0].id);
  assert(!hasSuperseded, 'Superseded facts excluded from candidates');

  // Works for decisions too
  store.processExtraction(driver, {
    members: [],
    facts: [],
    decisions: [
      { description: 'Deploy to AWS us-east-1 region', status: 'agreed', tags: 'infrastructure' },
    ],
    topics: [],
  }, '2026-04-01');

  const decCandidates = store.findContradictionCandidates(driver, 'decisions', 'Deploy to GCP europe-west1 instead of AWS', { maxCandidates: 5 });
  assert(decCandidates.length >= 1, 'Found decision candidates');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testSupersededFiltering();`:

```javascript
  testFindContradictionCandidates();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `store.findContradictionCandidates is not a function`

- [ ] **Step 4: Implement `findContradictionCandidates()` in `store.js`**

Add after `markSuperseded`:

```javascript
/**
 * Entity type → content field mapping for contradiction candidate search.
 */
const ENTITY_CONTENT_FIELDS = {
  facts: { textField: 'content', ftsTable: 'facts_fts' },
  topics: { textField: "name || ' ' || COALESCE(summary, '')", ftsTable: 'topics_fts' },
  decisions: { textField: "description || ' ' || COALESCE(context, '')", ftsTable: 'decisions_fts' },
  tasks: { textField: 'description', ftsTable: 'tasks_fts' },
  questions: { textField: "question || ' ' || COALESCE(answer, '')", ftsTable: 'questions_fts' },
  events: { textField: "name || ' ' || COALESCE(description, '')", ftsTable: 'events_fts' },
  members: { textField: "display_name || ' ' || COALESCE(expertise, '') || ' ' || COALESCE(projects, '')", ftsTable: 'members_fts' },
};

/**
 * Find existing entities that might contradict new content.
 * Uses kNN vectors when available, falls back to FTS keyword search.
 *
 * @param {object} driver
 * @param {string} entityType - e.g. 'facts', 'decisions'
 * @param {string} content - Text content of the new entity
 * @param {object} options - { maxCandidates, excludeId, embeddingConfig }
 * @returns {Array<{id: number, content: string}>}
 */
function findContradictionCandidates(driver, entityType, content, options = {}) {
  const { maxCandidates = 5, excludeId = null } = options;
  const fieldDef = ENTITY_CONTENT_FIELDS[entityType];
  if (!fieldDef) return [];

  // FTS-based search: extract keywords and search FTS table
  const keywords = extractKeywords(content);
  if (keywords.length < 2) return [];

  const ftsQuery = esc(keywords.slice(0, 3).join(' AND '));
  let excludeClause = 'superseded_by IS NULL';
  if (excludeId) excludeClause += ` AND id != ${parseInt(excludeId)}`;

  const results = driver.read(
    `SELECT id, ${fieldDef.textField} as content FROM ${entityType} WHERE id IN (SELECT rowid FROM ${fieldDef.ftsTable} WHERE ${fieldDef.ftsTable} MATCH '${ftsQuery}') AND ${excludeClause} ORDER BY created_at DESC LIMIT ${maxCandidates}`
  );

  return results.map(r => ({ id: r.id, content: r.content }));
}
```

- [ ] **Step 5: Export `findContradictionCandidates`**

In `store.js` `module.exports`, add `findContradictionCandidates`:

```javascript
module.exports = {
  // ... existing exports ...
  findContradictionCandidates,
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/store.js test/run.js
git commit -m "feat: findContradictionCandidates() with FTS-based candidate search"
```

---

### Task 4: Store — extend `processExtraction()` to return all inserted IDs

**Files:**
- Modify: `src/store.js:414-516` — track inserted IDs for all entity types

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after `testFindContradictionCandidates`:

```javascript
function testProcessExtractionInsertedIds() {
  console.log('\n--- Test: processExtraction returns all inserted IDs ---');

  const db = path.join(TEST_DIR, 'inserted-ids.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  const result = store.processExtraction(driver, {
    members: [{ display_name: 'Alice', username: 'alice', expertise: 'Python' }],
    facts: [
      { category: 'tool', content: 'Fact one about testing', tags: 'test', confidence: 0.9 },
      { category: 'tool', content: 'Fact two about debugging', tags: 'test', confidence: 0.8 },
    ],
    topics: [{ name: 'Testing strategies', summary: 'Discussion about testing', participants: 'Alice', tags: 'test' }],
    decisions: [{ description: 'Use Jest for testing', status: 'agreed', tags: 'testing' }],
    tasks: [{ description: 'Write unit tests', assignee: 'Alice', status: 'open', tags: 'testing' }],
    questions: [{ question: 'Should we use TDD?', asker: 'Alice', status: 'open', tags: 'testing' }],
    events: [{ name: 'Sprint planning', description: 'Plan sprint 5', tags: 'planning' }],
  }, '2026-04-01');

  assert(result.insertedIds !== undefined, 'processExtraction returns insertedIds');
  assert(result.insertedIds.facts.length === 2, `insertedIds.facts has ${result.insertedIds.facts.length} entries (expected 2)`);
  assert(result.insertedIds.topics.length === 1, `insertedIds.topics has ${result.insertedIds.topics.length} entries (expected 1)`);
  assert(result.insertedIds.decisions.length === 1, `insertedIds.decisions has ${result.insertedIds.decisions.length} entries (expected 1)`);
  assert(result.insertedIds.tasks.length === 1, `insertedIds.tasks has ${result.insertedIds.tasks.length} entries (expected 1)`);
  assert(result.insertedIds.questions.length === 1, `insertedIds.questions has ${result.insertedIds.questions.length} entries (expected 1)`);
  assert(result.insertedIds.events.length === 1, `insertedIds.events has ${result.insertedIds.events.length} entries (expected 1)`);

  // Backward compat: insertedFactIds still works
  assert(result.insertedFactIds.length === 2, 'insertedFactIds backward compat preserved');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testFindContradictionCandidates();`:

```javascript
  testProcessExtractionInsertedIds();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `result.insertedIds` is undefined

- [ ] **Step 4: Implement inserted ID tracking in `processExtraction()`**

In `src/store.js`, modify `processExtraction()`. Replace the `insertedFactIds` variable with a full `insertedIds` object and track IDs for all entity types:

Replace line 418:
```javascript
  const insertedFactIds = [];
```
with:
```javascript
  const insertedIds = { facts: [], topics: [], decisions: [], tasks: [], questions: [], events: [] };
```

In the facts loop (after `totalFacts++` on line 437), replace:
```javascript
        const lastFact = driver.read('SELECT id FROM facts ORDER BY id DESC LIMIT 1');
        if (lastFact.length > 0) insertedFactIds.push(lastFact[0].id);
```
with:
```javascript
        const lastFact = driver.read('SELECT id FROM facts ORDER BY id DESC LIMIT 1');
        if (lastFact.length > 0) insertedIds.facts.push(lastFact[0].id);
```

In the topics loop (after `totalTopics++` on line 449), add:
```javascript
        const lastTopic = driver.read('SELECT id FROM topics ORDER BY id DESC LIMIT 1');
        if (lastTopic.length > 0) insertedIds.topics.push(lastTopic[0].id);
```

In the decisions loop (after `totalDecisions++` on line 459), add:
```javascript
        const lastDecision = driver.read('SELECT id FROM decisions ORDER BY id DESC LIMIT 1');
        if (lastDecision.length > 0) insertedIds.decisions.push(lastDecision[0].id);
```

In the tasks loop (after `totalTasks++` on line 470), add:
```javascript
        const lastTask = driver.read('SELECT id FROM tasks ORDER BY id DESC LIMIT 1');
        if (lastTask.length > 0) insertedIds.tasks.push(lastTask[0].id);
```

In the questions loop (after `totalQuestions++` on line 479), add:
```javascript
        const lastQuestion = driver.read('SELECT id FROM questions ORDER BY id DESC LIMIT 1');
        if (lastQuestion.length > 0) insertedIds.questions.push(lastQuestion[0].id);
```

In the events loop (after `totalEvents++` on line 488), add:
```javascript
        const lastEvent = driver.read('SELECT id FROM events ORDER BY id DESC LIMIT 1');
        if (lastEvent.length > 0) insertedIds.events.push(lastEvent[0].id);
```

Update the return statement (line 515) to include both `insertedIds` and backward-compat `insertedFactIds`:
```javascript
  return { totalFacts, totalTopics, totalMembers, totalDecisions, totalTasks, totalQuestions, totalEvents, totalUpdated, insertedIds, insertedFactIds: insertedIds.facts };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/store.js test/run.js
git commit -m "feat: processExtraction returns insertedIds for all entity types"
```

---

### Task 5: LLM — `checkContradictions()`

**Files:**
- Modify: `src/llm.js` — add contradiction checking function

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after `testProcessExtractionInsertedIds`:

```javascript
function testCheckContradictionsExport() {
  console.log('\n--- Test: checkContradictions export ---');

  const llm = require('../src/llm');
  assert(typeof llm.checkContradictions === 'function', 'checkContradictions is exported');
  assert(typeof llm.buildContradictionPrompt === 'function', 'buildContradictionPrompt is exported');
}

function testBuildContradictionPrompt() {
  console.log('\n--- Test: build contradiction prompt ---');

  const { buildContradictionPrompt } = require('../src/llm');

  const newEntities = [
    { index: 0, content: 'Team migrated to MySQL' },
    { index: 1, content: 'Deploy to GCP europe-west1' },
  ];
  const candidates = [
    { id: 3, content: 'Team uses PostgreSQL for main database' },
    { id: 7, content: 'Deploy to AWS us-east-1' },
  ];

  const prompt = buildContradictionPrompt(newEntities, candidates);
  assert(prompt.includes('[new:0]'), 'Prompt includes new entity index 0');
  assert(prompt.includes('[new:1]'), 'Prompt includes new entity index 1');
  assert(prompt.includes('[id:3]'), 'Prompt includes candidate id 3');
  assert(prompt.includes('[id:7]'), 'Prompt includes candidate id 7');
  assert(prompt.includes('MySQL'), 'Prompt includes new entity content');
  assert(prompt.includes('PostgreSQL'), 'Prompt includes candidate content');
  assert(prompt.includes('superseded_ids'), 'Prompt mentions expected output format');
}
```

- [ ] **Step 2: Register the tests**

In `runAll()`, add after `testProcessExtractionInsertedIds();`:

```javascript
  testCheckContradictionsExport();
  testBuildContradictionPrompt();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `checkContradictions is not a function`

- [ ] **Step 4: Implement `checkContradictions()` and `buildContradictionPrompt()` in `llm.js`**

Add after the `buildExtractionSchema` function (after line 279):

```javascript
// --- Contradiction detection ---

const contradictionSchema = z.object({
  contradictions: z.array(z.object({
    new_index: z.number(),
    superseded_ids: z.array(z.number()),
  })),
});

function buildContradictionPrompt(newEntities, candidates) {
  const newLines = newEntities.map(e => `  [new:${e.index}] ${e.content}`).join('\n');
  const existingLines = candidates.map(c => `  [id:${c.id}] ${c.content}`).join('\n');

  return `Given NEW entities and EXISTING entities of the same type, identify which existing entities are contradicted or superseded by a new one.

A contradiction means the new entity makes the old one FACTUALLY WRONG or OBSOLETE — not merely related, complementary, or a different perspective.

NEW ENTITIES:
${newLines}

EXISTING ENTITIES:
${existingLines}

Return JSON: { "contradictions": [{ "new_index": 0, "superseded_ids": [3] }] }
Only include entries where a new entity genuinely contradicts or replaces an old one.
Return { "contradictions": [] } if nothing is contradicted.`;
}

/**
 * Ask LLM to identify contradictions between new entities and candidates.
 *
 * @param {Array<{index: number, content: string}>} newEntities
 * @param {Array<{id: number, content: string}>} candidates
 * @param {object} config - LLM config (apiKey, baseUrl, model)
 * @returns {Promise<Array<{new_index: number, superseded_ids: number[]}>>}
 */
async function checkContradictions(newEntities, candidates, config) {
  if (!candidates.length || !newEntities.length) return [];

  const provider = createProvider(config);
  const prompt = buildContradictionPrompt(newEntities, candidates);

  const result = await generateText({
    model: provider(config.model),
    system: 'You identify contradictions between knowledge entities. Always respond with valid JSON only.',
    prompt,
    output: Output.object({ schema: contradictionSchema }),
    temperature: 0.1,
    maxTokens: 256,
    maxRetries: 2,
  });

  return result.output?.contradictions || [];
}
```

- [ ] **Step 5: Export the new functions**

In `llm.js` `module.exports` (line ~493), add `checkContradictions` and `buildContradictionPrompt`:

```javascript
module.exports = { extract, extractWithRetry, extractFromText, buildPrompt, formatMessages, isAnthropic, buildExtractionSchema, createProvider, repairJson, EXTRACTION_PROMPT, checkContradictions, buildContradictionPrompt };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/llm.js test/run.js
git commit -m "feat: checkContradictions() LLM judgment for contradiction detection"
```

---

### Task 6: Extractor — pipeline integration

**Files:**
- Modify: `src/extractor.js:178-229` — add contradiction detection block after semantic dedup
- Modify: `src/store.js` — add `updateState` support for `totalSuperseded`

- [ ] **Step 1: Write the failing test (config gating)**

Add to `test/run.js` after `testBuildContradictionPrompt`:

```javascript
function testContradictionConfigGating() {
  console.log('\n--- Test: contradiction config gating ---');

  const db = path.join(TEST_DIR, 'contradiction-config.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert conflicting facts without contradiction enabled
  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Team uses Postgres for production', tags: 'database', confidence: 0.9 },
    ],
    topics: [],
  }, '2026-04-01');

  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Team switched from Postgres to MySQL for production', tags: 'database', confidence: 0.9 },
    ],
    topics: [],
  }, '2026-04-02');

  // Without contradiction config, no superseding should happen
  const facts = driver.read('SELECT id, superseded_by FROM facts');
  const anySuperseded = facts.some(f => f.superseded_by !== null);
  assert(!anySuperseded, 'No facts superseded when contradiction detection is disabled');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testBuildContradictionPrompt();`:

```javascript
  testContradictionConfigGating();
```

- [ ] **Step 3: Run test to verify it passes (gating test — should pass already)**

Run: `npm test`
Expected: PASS — contradiction detection is not wired in yet, so nothing gets superseded

- [ ] **Step 4: Add contradiction detection block to `extractor.js`**

In `src/extractor.js`, add the following after the semantic dedup block (after line 194, after the `}` that closes the semantic dedup `if` block):

```javascript
      // Contradiction detection: if enabled, check new entities against existing
      if (config.contradiction?.enabled && !dryRun) {
        try {
          const llmConfig = {
            ...config.llm,
            maxRetries: 2,
          };
          let batchSuperseded = 0;

          for (const [entityType, ids] of Object.entries(result.insertedIds)) {
            if (ids.length === 0) continue;

            // Build new entity list with content
            const contentField = entityType === 'facts' ? 'content'
              : entityType === 'topics' ? 'name'
              : entityType === 'decisions' ? 'description'
              : entityType === 'tasks' ? 'description'
              : entityType === 'questions' ? 'question'
              : entityType === 'events' ? 'name'
              : 'display_name';
            const newRows = driver.read(
              `SELECT id, ${contentField} as content FROM ${entityType} WHERE id IN (${ids.join(',')})`
            );
            if (newRows.length === 0) continue;

            // Find candidates for all new entities combined
            const allCandidateIds = new Set();
            const allCandidates = [];
            for (const row of newRows) {
              const candidates = store.findContradictionCandidates(driver, entityType, row.content, {
                maxCandidates: config.contradiction.maxCandidates || 5,
                excludeId: row.id,
              });
              for (const c of candidates) {
                if (!allCandidateIds.has(c.id)) {
                  allCandidateIds.add(c.id);
                  allCandidates.push(c);
                }
              }
            }

            if (allCandidates.length === 0) continue;

            // LLM judgment: one call per entity type
            const newEntities = newRows.map((r, i) => ({ index: i, content: r.content }));
            const contradictions = await llm.checkContradictions(newEntities, allCandidates, llmConfig);

            // Apply superseding
            for (const c of contradictions) {
              const newRow = newRows[c.new_index];
              if (!newRow) continue;
              for (const oldId of c.superseded_ids) {
                if (allCandidateIds.has(oldId)) {
                  store.markSuperseded(driver, entityType, oldId, newRow.id);
                  batchSuperseded++;
                }
              }
            }
          }

          if (batchSuperseded > 0) {
            log(`  Contradictions: ${batchSuperseded} entity(ies) superseded`);
            totalSuperseded += batchSuperseded;
          }
        } catch (err) {
          log(`  Contradiction check failed (non-fatal): ${err.message}`);
        }
      }
```

- [ ] **Step 5: Add `totalSuperseded` tracking variable**

In `src/extractor.js`, on the line where counters are declared (line 128), add `totalSuperseded`:

```javascript
  let totalFacts = 0, totalTopics = 0, totalMembers = 0, embedded = 0;
  let totalDecisions = 0, totalTasks = 0, totalQuestions = 0, totalEvents = 0;
  let totalUpdated = 0, totalSuperseded = 0;
```

- [ ] **Step 6: Add superseded count to log output and summary**

In `src/extractor.js`, in the per-batch log (around line 209), add after the `if (result.totalUpdated)` line:

```javascript
      if (totalSuperseded) parts.push(`${totalSuperseded} superseded`);
```

In the final summary object (around line 271), add:

```javascript
    superseded: totalSuperseded,
```

In the final done log (around line 292), add after the updates line:

```javascript
  if (totalSuperseded) doneParts.push(`${totalSuperseded} superseded`);
```

- [ ] **Step 7: Update `updateState` to track superseded count**

In `src/store.js`, add `totalSuperseded` param to `updateState`:

```javascript
function updateState(driver, { lastProcessedId, messagesProcessed, factsExtracted, topicsExtracted,
  decisionsExtracted = 0, tasksExtracted = 0, questionsExtracted = 0, eventsExtracted = 0, updatesApplied = 0, totalSuperseded = 0 }) {
```

And add to the SQL:

```javascript
      total_superseded = total_superseded + ${totalSuperseded},
```

In `src/extractor.js`, in the `updateState` call (around line 237), add:

```javascript
      totalSuperseded,
```

- [ ] **Step 8: Update `getStats` to include superseded count**

In `src/store.js`, in `getStats()`, add to the return object:

```javascript
    superseded: parseInt(state?.total_superseded) || 0,
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/extractor.js src/store.js test/run.js
git commit -m "feat: contradiction detection pipeline integration in extractor"
```

---

### Task 7: Search — exclude superseded from hybrid search

**Files:**
- Modify: `src/search.js` — add `superseded_by IS NULL` to FTS queries

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after `testContradictionConfigGating`:

```javascript
async function testHybridSearchExcludesSuperseded() {
  console.log('\n--- Test: hybrid search excludes superseded ---');

  const { search } = require('../src/search');

  const db = path.join(TEST_DIR, 'search-superseded.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Team uses PostgreSQL database for production', tags: 'database', confidence: 0.9 },
      { category: 'tool', content: 'Team migrated to MySQL database for production', tags: 'database', confidence: 0.9 },
    ],
    topics: [],
  }, '2026-04-01');

  const allFacts = driver.read('SELECT id FROM facts ORDER BY id');
  // Supersede the old fact
  store.markSuperseded(driver, 'facts', allFacts[0].id, allFacts[1].id);

  const results = await search(driver, 'database production', { limit: 10, ftsOnly: true });
  const factResults = results.results.filter(r => r.source === 'fact');
  const hasSuperseded = factResults.some(r => r.id === allFacts[0].id);
  assert(!hasSuperseded, 'Hybrid search excludes superseded facts');
  assert(factResults.length >= 1, 'Hybrid search still returns non-superseded facts');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testContradictionConfigGating();`:

```javascript
  await testHybridSearchExcludesSuperseded();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — hybrid search still returns superseded facts

- [ ] **Step 4: Update `ftsSearch` in `search.js` to exclude superseded**

In `src/search.js`, update each entity query in `ftsSearch()` to add `AND f.superseded_by IS NULL` (or the equivalent for each table alias):

Facts query (around line 55):
```javascript
  const facts = driver.read(
    `SELECT f.id, f.content, f.confidence, f.tags, f.category, m.display_name as member
     FROM facts f
     LEFT JOIN members m ON f.source_member_id = m.id
     WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${escapedQuery}') AND f.superseded_by IS NULL${convFilter}
     ORDER BY f.confidence DESC
     LIMIT ${limit}`
  );
```

Topics query (search for the topics section):
Add `AND superseded_by IS NULL` to the WHERE clause.

Decisions query:
Add `AND superseded_by IS NULL` to the WHERE clause.

Tasks query:
Add `AND t.superseded_by IS NULL` to the WHERE clause.

Questions query:
Add `AND superseded_by IS NULL` to the WHERE clause.

Events query:
Add `AND superseded_by IS NULL` to the WHERE clause.

Members query:
Add `AND superseded_by IS NULL` to the WHERE clause.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/search.js test/run.js
git commit -m "feat: hybrid search excludes superseded entities"
```

---

### Task 8: Version bump and final verification

**Files:**
- Modify: `package.json` — bump version

- [ ] **Step 1: Bump version in package.json**

Bump the minor version (or patch, depending on current version) to reflect the new feature. Read `package.json` to determine current version, then bump minor.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS with 0 failures

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version for contradiction detection feature"
```
