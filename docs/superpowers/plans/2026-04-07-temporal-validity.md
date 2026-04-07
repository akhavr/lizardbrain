# Temporal Validity Windows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add LLM-assigned durability to facts so ephemeral knowledge expires naturally while durable knowledge persists indefinitely.

**Architecture:** LLM assigns a `durability` enum (ephemeral/short/medium/durable) during extraction. `insertFact()` maps it to a `valid_until` date stored in SQLite. Search and context queries hard-filter expired facts alongside superseded ones.

**Tech Stack:** Node.js, SQLite, Zod schemas, Vercel AI SDK

---

### Task 1: Schema — add `valid_until` column and v0.9 migration

**Files:**
- Modify: `src/schema.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write the failing test**

Add to `test/run.js` after `testMigrationV08`:

```javascript
function testMigrationV09() {
  console.log('\n--- Test: migration v0.9 (valid_until) ---');

  const V08_DB = path.join(TEST_DIR, 'v08.db');
  if (fs.existsSync(V08_DB)) fs.unlinkSync(V08_DB);
  lizardbrain.init(V08_DB, { profile: 'full' });
  const driver = createDriver(V08_DB);

  // Force version to 0.8 to trigger migration
  driver.write("UPDATE lizardbrain_meta SET value = '0.8' WHERE key = 'schema_version';");

  const result = migrate(driver);
  assert(result.migrated === true, 'v0.9 migration ran');

  // Verify valid_until column exists on facts
  const cols = driver.read('PRAGMA table_info(facts)');
  const hasValidUntil = cols.some(c => c.name === 'valid_until');
  assert(hasValidUntil, 'facts has valid_until column');

  // Verify schema version is 0.9
  const version = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  assert(version[0]?.value === '0.9', 'Schema version set to 0.9');

  // Idempotent
  const result2 = migrate(driver);
  assert(result2.migrated === false, 'Second v0.9 migration is no-op');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testMigrationV08();`:

```javascript
  testMigrationV09();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `valid_until` column doesn't exist yet

- [ ] **Step 4: Add `valid_until` to facts table in SCHEMA_SQL**

In `src/schema.js`, in the `facts` table definition, add `valid_until TEXT` after `superseded_by INTEGER`:

```sql
  superseded_by INTEGER,
  valid_until TEXT
```

- [ ] **Step 5: Update schema version in init()**

In `src/schema.js` `init()` function, change `'0.8'` to `'0.9'`:

```javascript
  driver.write(`INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.9', datetime('now'));`);
```

- [ ] **Step 6: Update version guard and message in migrate()**

Change the version guard from `'0.8'` to `'0.9'`:

```javascript
  if (version >= '0.9') {
    applyIndexes(driver);
    return { migrated: false, message: 'Already at v0.9' };
  }
```

- [ ] **Step 7: Add v0.9 migration block**

At the bottom of `migrate()`, before `applyIndexes(driver);`, add:

```javascript
  // v0.9 migration: valid_until on facts for temporal validity
  try { driver.write('ALTER TABLE facts ADD COLUMN valid_until TEXT;'); }
  catch (e) { /* column already exists */ }

  driver.write("INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('schema_version', '0.9', datetime('now'));");
```

- [ ] **Step 8: Update existing migration tests**

In `testMigration()`, update expected version from `'0.8'` to `'0.9'`.
In `testMigrationV05()`, update expected version from `'0.8'` to `'0.9'`.
In `testMigrationV08()`, update expected version from `'0.8'` to `'0.9'`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/schema.js test/run.js
git commit -m "feat: add valid_until column to facts table (v0.9 schema)"
```

---

### Task 2: LLM — add `durability` to fact schema and prompt

**Files:**
- Modify: `src/llm.js`
- Modify: `src/profiles.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing tests**

Add to `test/run.js` after `testMigrationV09`:

```javascript
function testDurabilityInSchema() {
  console.log('\n--- Test: durability in extraction schema ---');

  const { buildExtractionSchema } = require('../src/llm');

  // Schema should accept durability field on facts
  const schema = buildExtractionSchema(['members', 'facts', 'topics'], false);
  const testData = {
    members: [],
    facts: [{ category: 'tool', content: 'Test fact', source_member: null, tags: null, confidence: 0.9, durability: 'ephemeral' }],
    topics: [],
  };
  const result = schema.safeParse(testData);
  assert(result.success, 'Schema accepts durability field on facts');

  // Should accept null durability
  const nullData = {
    members: [],
    facts: [{ category: 'tool', content: 'Test fact', source_member: null, tags: null, confidence: 0.9, durability: null }],
    topics: [],
  };
  const nullResult = schema.safeParse(nullData);
  assert(nullResult.success, 'Schema accepts null durability');

  // Should accept missing durability (backward compat — field is optional via nullable)
  const missingData = {
    members: [],
    facts: [{ category: 'tool', content: 'Test fact', source_member: null, tags: null, confidence: 0.9 }],
    topics: [],
  };
  const missingResult = schema.safeParse(missingData);
  assert(missingResult.success, 'Schema accepts facts without durability field');
}

function testDurabilityInPrompt() {
  console.log('\n--- Test: durability in prompt ---');

  const { buildPrompt } = require('../src/llm');
  const { getProfile } = require('../src/profiles');

  const profileConfig = getProfile('knowledge');
  const prompt = buildPrompt('test messages', profileConfig);
  assert(prompt.includes('durability'), 'Prompt includes durability field');
  assert(prompt.includes('ephemeral'), 'Prompt includes ephemeral option');
  assert(prompt.includes('durable'), 'Prompt includes durable option');
}
```

- [ ] **Step 2: Register the tests**

In `runAll()`, add after `testMigrationV09();`:

```javascript
  testDurabilityInSchema();
  testDurabilityInPrompt();
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — schema doesn't accept durability field

- [ ] **Step 4: Add `durability` to Zod fact schema**

In `src/llm.js`, update the `factSchema` (around line 191):

```javascript
const factSchema = z.object({
  category: z.string(),
  content: z.string(),
  source_member: z.string().nullable(),
  tags: z.string().nullable(),
  confidence: z.number().nullable(),
  durability: z.enum(['ephemeral', 'short', 'medium', 'durable']).nullable().optional(),
});
```

- [ ] **Step 5: Add `durability` to fact prompt fragment in profiles.js**

In `src/profiles.js`, update the `facts.promptFragment` (around line 79):

```javascript
    promptFragment: (labels, categories) => `  "facts": [
    {
      "category": "one of: ${categories.join(', ')}",
      "content": "the factual claim or insight, 1-2 sentences",
      "source_member": "display_name of who said it",
      "tags": "comma-separated relevant tags",
      "confidence": 0.0 to 1.0,
      "durability": "one of: ephemeral, short, medium, durable"
    }
  ]`,
```

- [ ] **Step 6: Add durability rules to fact rules in profiles.js**

In `src/profiles.js`, update `facts.rules` (around line 88) to append durability guidance:

```javascript
    rules: (labels, categories) => `Fact rules:
- Category must be one of: ${categories.join(', ')}
- Confidence: 0.9+ for verified specifics (pricing, versions, benchmarks). 0.75-0.85 for opinions and personal experiences. 0.5-0.7 for secondhand claims or speculation
- Tags should be lowercase, useful for search
- Durability: how long this fact stays relevant
  - "ephemeral": temporary states, current blockers, this-week items (valid ~1 week)
  - "short": sprint goals, short-term plans (valid ~1 month)
  - "medium": quarterly goals, project phases (valid ~3 months)
  - "durable": tech stack, expertise, architecture, permanent knowledge (no expiration)
  - Default to "durable" if unsure`,
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/llm.js src/profiles.js test/run.js
git commit -m "feat: add durability field to fact extraction schema and prompt"
```

---

### Task 3: Store — `insertFact()` computes `valid_until`

**Files:**
- Modify: `src/store.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing tests**

Add to `test/run.js` after `testDurabilityInPrompt`:

```javascript
function testFactDurability() {
  console.log('\n--- Test: fact durability and valid_until ---');

  const db = path.join(TEST_DIR, 'durability.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert facts with different durabilities
  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Ephemeral fact about sprint blocker', tags: 'sprint', confidence: 0.9, durability: 'ephemeral' },
      { category: 'tool', content: 'Short-term fact about sprint goals', tags: 'sprint', confidence: 0.9, durability: 'short' },
      { category: 'tool', content: 'Medium-term fact about Q2 goals', tags: 'quarterly', confidence: 0.9, durability: 'medium' },
      { category: 'tool', content: 'Durable fact about using PostgreSQL', tags: 'database', confidence: 0.9, durability: 'durable' },
      { category: 'tool', content: 'Fact without durability field', tags: 'misc', confidence: 0.9 },
    ],
    topics: [],
  }, '2026-04-01');

  const facts = driver.read('SELECT content, valid_until FROM facts ORDER BY id');
  assert(facts.length === 5, 'All 5 facts inserted');

  // Ephemeral: valid_until = 2026-04-01 + 7 days = 2026-04-08
  assert(facts[0].valid_until !== null, 'Ephemeral fact has valid_until');
  assert(facts[0].valid_until.startsWith('2026-04-08'), `Ephemeral valid_until is 2026-04-08 (got ${facts[0].valid_until})`);

  // Short: valid_until = 2026-04-01 + 30 days = 2026-05-01
  assert(facts[1].valid_until !== null, 'Short fact has valid_until');
  assert(facts[1].valid_until.startsWith('2026-05-01'), `Short valid_until is 2026-05-01 (got ${facts[1].valid_until})`);

  // Medium: valid_until = 2026-04-01 + 90 days = 2026-06-30
  assert(facts[2].valid_until !== null, 'Medium fact has valid_until');
  assert(facts[2].valid_until.startsWith('2026-06-30'), `Medium valid_until is 2026-06-30 (got ${facts[2].valid_until})`);

  // Durable: valid_until is NULL
  assert(facts[3].valid_until === null, 'Durable fact has NULL valid_until');

  // No durability: valid_until is NULL (default = durable)
  assert(facts[4].valid_until === null, 'Fact without durability has NULL valid_until');

  driver.close();
}
```

- [ ] **Step 2: Register the test**

In `runAll()`, add after `testDurabilityInPrompt();`:

```javascript
  testFactDurability();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `valid_until` is NULL for all facts (not computed yet)

- [ ] **Step 4: Add `DURABILITY_DAYS` constant and update `insertFact()`**

In `src/store.js`, add the constant after the `GENERIC_MEMBER_PATTERN` line (around line 36):

```javascript
const DURABILITY_DAYS = { ephemeral: 7, short: 30, medium: 90 };
```

Then update `insertFact()` to accept and use durability. Change the INSERT statement (around line 118):

```javascript
  const durability = fact.durability || null;
  const days = DURABILITY_DAYS[durability];
  const validUntil = days ? `datetime('${esc(messageDate)}', '+${days} days')` : 'NULL';

  driver.write(`
    INSERT INTO facts (category, content, source_member_id, tags, confidence, message_date, source_agent, conversation_id, valid_until)
    VALUES (
      '${esc(fact.category)}',
      '${esc(content)}',
      ${memberId || 'NULL'},
      '${esc(fact.tags || '')}',
      ${parseFloat(fact.confidence) || 0.8},
      '${esc(messageDate)}',
      ${sourceAgent ? `'${esc(sourceAgent)}'` : 'NULL'},
      ${conversationId ? `'${esc(conversationId)}'` : 'NULL'},
      ${validUntil}
    );
  `);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/store.js test/run.js
git commit -m "feat: insertFact() computes valid_until from durability"
```

---

### Task 4: Store + Search — filter expired facts

**Files:**
- Modify: `src/store.js`
- Modify: `src/search.js`
- Modify: `test/run.js`

- [ ] **Step 1: Write failing tests**

Add to `test/run.js` after `testFactDurability`:

```javascript
function testExpiredFactFiltering() {
  console.log('\n--- Test: expired fact filtering ---');

  const db = path.join(TEST_DIR, 'expired.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  // Insert a fact with a past valid_until (already expired)
  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Expired fact about old sprint blocker', tags: 'sprint,expired', confidence: 0.9, durability: 'ephemeral' },
      { category: 'tool', content: 'Valid fact about PostgreSQL database usage', tags: 'database,valid', confidence: 0.9, durability: 'durable' },
    ],
    topics: [],
  }, '2020-01-01');  // Far in the past — ephemeral fact already expired

  // searchFacts should exclude expired
  const results = store.searchFacts(driver, 'sprint OR database');
  assert(results.length === 1, `searchFacts returns ${results.length} facts (expected 1, only non-expired)`);
  assert(results[0].content.includes('PostgreSQL'), 'searchFacts returns only the valid fact');

  // getActiveContext should exclude expired
  const profiles = require('../src/profiles');
  const ctx = store.getActiveContext(driver, profiles.getProfile('full'), { recencyDays: 99999 });
  const hasExpired = ctx.facts?.some(f => f.content && f.content.includes('sprint'));
  assert(!hasExpired, 'getActiveContext excludes expired facts');

  // findContradictionCandidates should exclude expired
  const candidates = store.findContradictionCandidates(driver, 'facts', 'Old sprint blocker is resolved', { maxCandidates: 5 });
  const hasExpiredCandidate = candidates.some(c => c.content.includes('sprint'));
  assert(!hasExpiredCandidate, 'findContradictionCandidates excludes expired facts');

  driver.close();
}

async function testHybridSearchExcludesExpired() {
  console.log('\n--- Test: hybrid search excludes expired ---');

  const { search } = require('../src/search');

  const db = path.join(TEST_DIR, 'search-expired.db');
  if (fs.existsSync(db)) fs.unlinkSync(db);
  lizardbrain.init(db, { profile: 'full' });
  const driver = createDriver(db);
  migrate(driver);

  store.processExtraction(driver, {
    members: [],
    facts: [
      { category: 'tool', content: 'Expired search fact about sprint velocity', tags: 'sprint', confidence: 0.9, durability: 'ephemeral' },
      { category: 'tool', content: 'Valid search fact about sprint methodology', tags: 'sprint', confidence: 0.9, durability: 'durable' },
    ],
    topics: [],
  }, '2020-01-01');  // Ephemeral already expired

  const results = await search(driver, 'sprint', { limit: 10, ftsOnly: true });
  const factResults = results.results.filter(r => r.source === 'fact');
  assert(factResults.length === 1, `Hybrid search returns ${factResults.length} facts (expected 1)`);
  assert(factResults[0].text.includes('methodology'), 'Hybrid search returns only valid fact');

  driver.close();
}
```

- [ ] **Step 2: Register the tests**

In `runAll()`, add after `testFactDurability();`:

```javascript
  testExpiredFactFiltering();
  await testHybridSearchExcludesExpired();
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — expired facts still returned from search

- [ ] **Step 4: Update `searchFacts()` in `store.js`**

Add `AND (f.valid_until IS NULL OR f.valid_until >= datetime('now'))` to the WHERE clause. The current line is:

```javascript
  let where = `f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${sanitized}') AND f.superseded_by IS NULL`;
```

Change to:

```javascript
  let where = `f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${sanitized}') AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until >= datetime('now'))`;
```

- [ ] **Step 5: Update `getActiveContext()` facts query in `store.js`**

The current facts query is:

```javascript
      `SELECT id, content, confidence FROM facts WHERE created_at >= datetime('now', '-${recencyDays} days') AND superseded_by IS NULL ORDER BY confidence DESC, created_at DESC LIMIT ${limit}`
```

Change to:

```javascript
      `SELECT id, content, confidence FROM facts WHERE created_at >= datetime('now', '-${recencyDays} days') AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until >= datetime('now')) ORDER BY confidence DESC, created_at DESC LIMIT ${limit}`
```

- [ ] **Step 6: Update `findContradictionCandidates()` for facts in `store.js`**

In the `findContradictionCandidates` function, the `excludeClause` is built as:

```javascript
  let excludeClause = 'superseded_by IS NULL';
```

This applies to all entity types. For facts specifically, we need to also add the validity check. Update the query construction to add it when the entity type is `facts`:

After the `excludeClause` is built, add:

```javascript
  if (entityType === 'facts') excludeClause += ' AND (valid_until IS NULL OR valid_until >= datetime(\'now\'))';
```

- [ ] **Step 7: Update `ftsSearch()` facts query in `search.js`**

In `src/search.js`, the facts FTS query currently has `AND f.superseded_by IS NULL`. Add the validity filter:

```javascript
     WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${escapedQuery}') AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until >= datetime('now'))${convFilter}
```

- [ ] **Step 8: Update `vecSearch()` facts lookup in `search.js`**

In `src/search.js`, the facts vec lookup query currently has `WHERE f.id = ? AND f.superseded_by IS NULL`. Add the validity filter:

```javascript
         WHERE f.id = ? AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until >= datetime('now'))
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add src/store.js src/search.js test/run.js
git commit -m "feat: filter expired facts from search, context, and contradiction candidates"
```

---

### Task 5: Version bump and final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version in package.json**

Change version from `0.11.0` to `0.12.0`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: All tests PASS with 0 failures

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 0.12.0 for temporal validity feature"
```
