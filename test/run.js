#!/usr/bin/env node
/**
 * Basic integration test for lizardbrain.
 * Creates a test SQLite source, runs extraction with a mock LLM, verifies results.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const lizardbrain = require('../src/index');
const store = require('../src/store');
const { createDriver, esc } = require('../src/driver');
const profiles = require('../src/profiles');
const { buildPrompt } = require('../src/llm');
const { migrate } = require('../src/schema');

const TEST_DIR = path.join(__dirname, '.test-data');
const SOURCE_DB = path.join(TEST_DIR, 'source.db');
const MEMORY_DB = path.join(TEST_DIR, 'memory.db');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

function setup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Create source database with test messages
  execSync(`sqlite3 "${SOURCE_DB}"`, {
    input: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        sender TEXT,
        content TEXT,
        timestamp TEXT
      );
      INSERT INTO messages VALUES (1, 'Alice', 'I have been using LangChain for our RAG pipeline, works great with chunk size 512', '2026-03-15T10:00:00Z');
      INSERT INTO messages VALUES (2, 'Bob', 'We switched to LlamaIndex last month, much better for large PDFs', '2026-03-15T10:05:00Z');
      INSERT INTO messages VALUES (3, 'Alice', 'Interesting! What embedding model are you using?', '2026-03-15T10:10:00Z');
      INSERT INTO messages VALUES (4, 'Bob', 'text-embedding-3-small from OpenAI, cheap and decent quality', '2026-03-15T10:15:00Z');
      INSERT INTO messages VALUES (5, 'Charlie', 'Has anyone tried Claude Code for refactoring? I use it daily on our Python backend', '2026-03-15T10:20:00Z');
      INSERT INTO messages VALUES (6, 'Alice', 'Claude Code is amazing for large refactors, saved us hours last week', '2026-03-15T10:25:00Z');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

// --- Tests ---

function testInit() {
  console.log('\n--- Test: init ---');

  const result = lizardbrain.init(MEMORY_DB, { profile: 'team' });
  assert(result.created === true, 'Database created');
  assert(fs.existsSync(MEMORY_DB), 'File exists on disk');
  assert(result.message.includes('team'), 'Init message includes profile name');

  // Verify schema
  const tables = execSync(`sqlite3 "${MEMORY_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('members'), 'members table exists');
  assert(tables.includes('facts'), 'facts table exists');
  assert(tables.includes('topics'), 'topics table exists');
  assert(tables.includes('decisions'), 'decisions table exists');
  assert(tables.includes('tasks'), 'tasks table exists');
  assert(tables.includes('questions'), 'questions table exists');
  assert(tables.includes('events'), 'events table exists');
  assert(tables.includes('facts_fts'), 'FTS tables exist');
  assert(tables.includes('decisions_fts'), 'decisions_fts table exists');
  assert(tables.includes('tasks_fts'), 'tasks_fts table exists');
  assert(tables.includes('extraction_state'), 'extraction_state table exists');

  // Verify profile stored in meta
  const profileMeta = execSync(`sqlite3 -json "${MEMORY_DB}" "SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'"`, { encoding: 'utf-8' });
  assert(profileMeta.includes('team'), 'Profile name stored in meta');

  // Idempotent
  const result2 = lizardbrain.init(MEMORY_DB);
  assert(result2.created === false, 'Second init skips creation');
}

function testAdapter() {
  console.log('\n--- Test: sqlite adapter ---');

  const adapter = lizardbrain.adapters.sqlite.create({
    path: SOURCE_DB,
    table: 'messages',
    columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
  });

  const validation = adapter.validate();
  assert(validation.ok === true, 'Adapter validates successfully');

  const messages = adapter.getMessages('0');
  assert(messages.length === 6, `Got ${messages.length} messages (expected 6)`);
  assert(messages[0].sender === 'Alice', 'First message sender is Alice');
  assert(messages[0].content.includes('LangChain'), 'First message content is correct');

  // Cursor works
  const after3 = adapter.getMessages('3');
  assert(after3.length === 3, `Got ${after3.length} messages after id 3 (expected 3)`);
}

function testJsonlAdapter() {
  console.log('\n--- Test: jsonl adapter ---');

  const jsonlPath = path.join(TEST_DIR, 'messages.jsonl');
  const lines = [
    '{"id":"1","sender":"Alice","content":"Hello world","timestamp":"2026-01-01"}',
    '{"id":"2","sender":"Bob","content":"Testing JSONL adapter","timestamp":"2026-01-02"}',
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n'));

  const adapter = lizardbrain.adapters.jsonl.create({ path: jsonlPath });
  const validation = adapter.validate();
  assert(validation.ok === true, 'JSONL adapter validates');

  const messages = adapter.getMessages('0');
  assert(messages.length === 2, `Got ${messages.length} messages (expected 2)`);
  assert(messages[0].sender === 'Alice', 'First message sender correct');
}

function testStore() {
  console.log('\n--- Test: store operations ---');

  const memDriver = createDriver(MEMORY_DB);

  // Direct store operations (simulating what extraction does)
  store.processExtraction(memDriver, {
    members: [
      { display_name: 'Alice', username: 'alice', expertise: 'RAG, LangChain', projects: 'pipeline' },
      { display_name: 'Bob', username: 'bob', expertise: 'LlamaIndex, embeddings', projects: '' },
    ],
    facts: [
      { category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag, langchain', confidence: 0.9 },
      { category: 'opinion', content: 'LlamaIndex is better for large PDFs than LangChain', source_member: 'bob', tags: 'rag, llamaindex', confidence: 0.8 },
    ],
    topics: [
      { name: 'RAG Pipeline Comparison', summary: 'Discussion comparing LangChain vs LlamaIndex for RAG', participants: 'Alice, Bob', tags: 'rag, comparison' },
    ],
  }, '2026-03-15');

  const stats = store.getStats(memDriver);
  assert(stats.members === 2, `${stats.members} members (expected 2)`);
  assert(stats.facts === 2, `${stats.facts} facts (expected 2)`);
  assert(stats.topics === 1, `${stats.topics} topics (expected 1)`);

  // FTS search
  const ragFacts = store.searchFacts(memDriver, 'RAG');
  assert(ragFacts.length === 2, `FTS found ${ragFacts.length} RAG facts (expected 2)`);

  const ragTopics = store.searchTopics(memDriver, 'RAG');
  assert(ragTopics.length === 1, `FTS found ${ragTopics.length} RAG topics (expected 1)`);

  // Who knows
  const ragExperts = store.whoKnows(memDriver, 'RAG');
  assert(ragExperts.length === 1, `Found ${ragExperts.length} RAG experts (expected 1)`);

  // Dedup: insert same fact again (exact match)
  store.processExtraction(memDriver, {
    members: [{ display_name: 'Alice', username: 'alice', expertise: 'RAG, Python', projects: 'pipeline, new-project' }],
    facts: [{ category: 'tool', content: 'LangChain works well for RAG with chunk size 512', source_member: 'alice', tags: 'rag', confidence: 0.9 }],
    topics: [],
  }, '2026-03-15');

  const stats2 = store.getStats(memDriver);
  assert(stats2.members === 2, `Still ${stats2.members} members after upsert (expected 2)`);
  assert(stats2.facts === 2, `Still ${stats2.facts} facts — exact dedup worked (expected 2)`);

  // Dedup: insert semantically similar fact (LLM rephrased it)
  store.processExtraction(memDriver, {
    members: [],
    facts: [{ category: 'tool', content: 'LangChain is effective for RAG pipelines, especially with a chunk size of 512 tokens', source_member: 'alice', tags: 'rag, langchain', confidence: 0.9 }],
    topics: [{ name: 'Comparing RAG Pipeline Tools', summary: 'LangChain vs LlamaIndex comparison', participants: 'Alice, Bob', tags: 'rag' }],
  }, '2026-03-15');

  const stats3 = store.getStats(memDriver);
  assert(stats3.facts === 2, `Still ${stats3.facts} facts — semantic dedup worked (expected 2)`);
  assert(stats3.topics === 1, `Still ${stats3.topics} topics — topic dedup worked (expected 1)`);

  // Check member expertise was merged
  const alice = store.searchMembers(memDriver, 'Alice');
  assert(alice.length > 0 && alice[0].expertise.includes('Python'), 'Alice expertise merged with Python');
  assert(alice.length > 0 && alice[0].projects.includes('new-project'), 'Alice projects merged');

  memDriver.close();
}

function testConfidenceFiltering() {
  console.log('\n--- Test: confidence filtering ---');

  const memDriver = createDriver(MEMORY_DB);

  // Insert facts with different confidence levels
  store.processExtraction(memDriver, {
    members: [],
    facts: [
      { category: 'tool', content: 'High confidence fact about Docker pricing at $5/month', source_member: 'alice', tags: 'docker, pricing', confidence: 0.95 },
      { category: 'opinion', content: 'Medium confidence opinion about Kubernetes being overkill', source_member: 'bob', tags: 'kubernetes, opinion', confidence: 0.8 },
      { category: 'tool', content: 'Low confidence rumor about a new AWS service', source_member: 'alice', tags: 'aws, rumor', confidence: 0.5 },
    ],
    topics: [],
  }, '2026-03-16');

  // Search without filter
  const allFacts = store.searchFacts(memDriver, 'Docker OR Kubernetes OR AWS');
  assert(allFacts.length >= 3, `Found ${allFacts.length} facts without filter (expected >= 3)`);

  // Search with minConfidence 0.75
  const highFacts = store.searchFacts(memDriver, 'Docker OR Kubernetes OR AWS', 15, 0.75);
  assert(highFacts.length >= 2, `Found ${highFacts.length} facts with confidence >= 0.75 (expected >= 2)`);

  // Search with minConfidence 0.9
  const veryHigh = store.searchFacts(memDriver, 'Docker OR Kubernetes OR AWS', 15, 0.9);
  assert(veryHigh.length >= 1, `Found ${veryHigh.length} facts with confidence >= 0.9 (expected >= 1)`);

  // Verify ordering: high confidence first
  if (highFacts.length >= 2) {
    assert(parseFloat(highFacts[0].confidence) >= parseFloat(highFacts[1].confidence),
      'Facts ordered by confidence descending');
  }

  memDriver.close();
}

function testRoster() {
  console.log('\n--- Test: roster generation ---');

  const memDriver = createDriver(MEMORY_DB);
  const roster = store.generateRoster(memDriver);

  assert(roster.count >= 2, `Roster has ${roster.count} members (expected >= 2)`);
  assert(roster.content.startsWith('# Members'), 'Roster starts with default header');

  // Custom title
  const custom = store.generateRoster(memDriver, { title: 'Team Roster' });
  assert(custom.content.startsWith('# Team Roster'), 'Roster supports custom title');
  assert(roster.content.includes('Alice'), 'Roster contains Alice');
  assert(roster.content.includes('Bob'), 'Roster contains Bob');
  assert(roster.content.includes('RAG'), 'Roster includes expertise');

  memDriver.close();
}

function testConversationFilter() {
  console.log('\n--- Test: conversation filtering ---');

  // Create a source with mixed group/DM conversations
  const CONV_DB = path.join(TEST_DIR, 'conv-source.db');
  execSync(`sqlite3 "${CONV_DB}"`, {
    input: `
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation_id INTEGER,
        sender TEXT,
        content TEXT,
        timestamp TEXT
      );
      -- Group messages (with is_group_chat marker)
      INSERT INTO messages VALUES (1, 1, 'Alice', 'Group msg with "is_group_chat": true marker about Python', '2026-03-15');
      INSERT INTO messages VALUES (2, 1, 'Bob', 'Another group msg "is_group_chat": true about RAG', '2026-03-15');
      INSERT INTO messages VALUES (3, 1, 'Alice', 'Third group "is_group_chat": true message', '2026-03-15');
      -- DM messages (no marker)
      INSERT INTO messages VALUES (4, 2, 'Alice', 'Private DM message about secrets', '2026-03-15');
      INSERT INTO messages VALUES (5, 2, 'Alice', 'Another private DM', '2026-03-15');
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const adapter = lizardbrain.adapters.sqlite.create({
    path: CONV_DB,
    table: 'messages',
    columns: { id: 'id', content: 'content', sender: 'sender', timestamp: 'timestamp' },
    conversationFilter: {
      column: 'conversation_id',
      detectGroup: { contentColumn: 'content', marker: 'is_group_chat' },
    },
  });

  const validation = adapter.validate();
  assert(validation.ok === true, 'Adapter with conversation filter validates');
  assert(validation.groupConversations?.length === 1, `Detected ${validation.groupConversations?.length} group conversation(s) (expected 1)`);

  const messages = adapter.getMessages('0');
  assert(messages.length === 3, `Got ${messages.length} messages (expected 3 — group only, no DMs)`);
  assert(!messages.some(m => m.content.includes('secrets')), 'DM content excluded');
}

function testCliDriver() {
  console.log('\n--- Test: CliDriver ---');

  const driver = createDriver(MEMORY_DB, { forceBackend: 'cli' });

  assert(driver.backend === 'cli', 'Backend is cli');
  assert(driver.capabilities.inProcess === false, 'inProcess is false');
  assert(driver.capabilities.vectors === false, 'vectors is false');
  assert(driver.capabilities.transactions === false, 'transactions is false');

  // Read (COUNT)
  const rows = driver.read('SELECT COUNT(*) as c FROM members');
  assert(Array.isArray(rows), 'read returns array');
  assert(rows.length === 1 && rows[0].c !== undefined, 'read returns count row');

  // Write (INSERT then DELETE)
  driver.write("INSERT INTO members (username, display_name, first_seen, last_seen) VALUES ('cli_test_user', 'CLI Test User', '2026-01-01', '2026-01-01')");
  const inserted = driver.read("SELECT id FROM members WHERE username='cli_test_user'");
  assert(inserted.length === 1, 'INSERT via write succeeded');

  driver.write("DELETE FROM members WHERE username='cli_test_user'");
  const deleted = driver.read("SELECT id FROM members WHERE username='cli_test_user'");
  assert(deleted.length === 0, 'DELETE via write succeeded');

  // run() is alias for write
  driver.run("INSERT INTO members (username, display_name, first_seen, last_seen) VALUES ('cli_run_user', 'CLI Run User', '2026-01-01', '2026-01-01')");
  const runInserted = driver.read("SELECT id FROM members WHERE username='cli_run_user'");
  assert(runInserted.length === 1, 'run() inserts row');
  driver.write("DELETE FROM members WHERE username='cli_run_user'");

  // transaction just calls fn()
  let called = false;
  const txResult = driver.transaction(() => { called = true; return 42; });
  assert(called === true, 'transaction calls fn');
  assert(txResult === 42, 'transaction returns fn result');

  // close is a noop
  driver.close();
  assert(true, 'close() does not throw');

  // esc() — single quotes
  assert(esc("it's fine") === "it''s fine", "esc handles single quotes");
  assert(esc(null) === '', 'esc handles null');
  assert(esc(undefined) === '', 'esc handles undefined');
  assert(esc('no quotes') === 'no quotes', 'esc leaves clean strings alone');
}

function testBetterSqliteDriver() {
  console.log('\n--- Test: BetterSqliteDriver ---');

  let BetterSqlite3;
  try {
    BetterSqlite3 = require('better-sqlite3');
  } catch (_) {
    console.log('  SKIP: better-sqlite3 not installed');
    return;
  }

  const driver = createDriver(MEMORY_DB);

  assert(driver.backend === 'better-sqlite3', 'Backend is better-sqlite3');
  assert(driver.capabilities.inProcess === true, 'inProcess is true');
  assert(driver.capabilities.transactions === true, 'transactions is true');
  // vectors may or may not be true depending on sqlite-vec; just check it's a boolean
  assert(typeof driver.capabilities.vectors === 'boolean', 'vectors capability is boolean');

  // Read
  const rows = driver.read('SELECT COUNT(*) as c FROM members');
  assert(Array.isArray(rows) && rows.length === 1, 'read returns result');

  // Parameterized read with ? placeholders
  const paramRows = driver.read('SELECT * FROM members WHERE display_name = ?', ['Alice']);
  assert(Array.isArray(paramRows), 'parameterized read returns array');

  // Write with params
  driver.write(
    "INSERT INTO members (username, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)",
    ['bsql_test_user', 'BSql Test User', '2026-01-01', '2026-01-01']
  );
  const inserted = driver.read('SELECT id FROM members WHERE username = ?', ['bsql_test_user']);
  assert(inserted.length === 1, 'write with params inserted row');

  // run() is alias for write
  driver.run('DELETE FROM members WHERE username = ?', ['bsql_test_user']);
  const afterDelete = driver.read('SELECT id FROM members WHERE username = ?', ['bsql_test_user']);
  assert(afterDelete.length === 0, 'run() with params deleted row');

  // Transaction — both inserts committed atomically
  driver.transaction(() => {
    driver.write(
      "INSERT INTO members (username, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)",
      ['tx_user_1', 'TX User 1', '2026-01-01', '2026-01-01']
    );
    driver.write(
      "INSERT INTO members (username, display_name, first_seen, last_seen) VALUES (?, ?, ?, ?)",
      ['tx_user_2', 'TX User 2', '2026-01-01', '2026-01-01']
    );
  });
  const txRows = driver.read("SELECT id FROM members WHERE username IN ('tx_user_1', 'tx_user_2')");
  assert(txRows.length === 2, 'transaction committed both inserts');

  // Cleanup
  driver.write("DELETE FROM members WHERE username IN ('tx_user_1', 'tx_user_2')");

  // _db is exposed for raw access
  assert(driver._db !== undefined, '_db is exposed');

  // dbPath is stored
  assert(driver.dbPath === MEMORY_DB, 'dbPath is stored on driver');

  driver.close();
  assert(true, 'close() does not throw');
}

async function testEmbeddings() {
  console.log('\n--- Test: embeddings module ---');
  const embeddings = require('../src/embeddings');

  assert(embeddings.estimateTokens('hello world') > 0, 'Token estimation positive');
  assert(embeddings.estimateTokens('hello world') < 10, 'Token estimation reasonable');

  const texts = ['short', 'a'.repeat(1000), 'medium length text here', 'another one'];
  const batches = embeddings.splitIntoBatches(texts, 500);
  assert(batches.length >= 2, `Split into ${batches.length} batches (expected >= 2)`);
  assert(batches.flat().length === texts.length, 'All texts in batches');
}

function testRRFMerge() {
  console.log('\n--- Test: RRF merge ---');
  const { mergeRRF } = require('../src/search');

  const ftsResults = [
    { key: 'fact:1', data: { source: 'fact', id: 1, text: 'FTS hit 1' } },
    { key: 'fact:2', data: { source: 'fact', id: 2, text: 'FTS hit 2' } },
    { key: 'topic:1', data: { source: 'topic', id: 1, text: 'FTS topic' } },
  ];
  const vecResults = [
    { key: 'fact:2', data: { source: 'fact', id: 2, text: 'Vec hit 2' } },
    { key: 'fact:3', data: { source: 'fact', id: 3, text: 'Vec hit 3' } },
    { key: 'topic:1', data: { source: 'topic', id: 1, text: 'Vec topic' } },
  ];

  const merged = mergeRRF([ftsResults, vecResults], 60);
  assert(merged.length === 4, `RRF merged ${merged.length} items (expected 4)`);
  const topKey = merged[0].key;
  assert(topKey === 'fact:2' || topKey === 'topic:1', `Top result is overlap: ${topKey}`);
  const keys = merged.map(m => m.key);
  assert(keys.includes('fact:1'), 'FTS-only item present');
  assert(keys.includes('fact:3'), 'Vec-only item present');
  for (let i = 1; i < merged.length; i++) {
    assert(merged[i].score <= merged[i - 1].score, `Score descending at ${i}`);
  }
}

async function testFtsOnlySearch() {
  console.log('\n--- Test: FTS-only search ---');
  const { search } = require('../src/search');
  const driver = createDriver(MEMORY_DB);

  // Note: MEMORY_DB has data from testStore which runs before this
  const result = await search(driver, 'RAG', { limit: 5, ftsOnly: true });
  assert(result.mode === 'fts5', `Mode is fts5: ${result.mode}`);
  assert(result.results.length > 0, `Got ${result.results.length} results`);
  assert(result.results[0].source, 'Has source field');
  assert(result.results[0].text, 'Has text field');
  assert(typeof result.results[0].score === 'number', 'Has numeric score');
  driver.close();
}

async function testUrlEnrichment() {
  console.log('\n--- Test: URL enrichment ---');

  const urlEnricher = require('../src/enrichers/url');

  // Test with a known GitHub repo
  const messages = [
    { id: '1', content: 'Check out https://github.com/pandore/lizardbrain for memory extraction', sender: 'Alice', timestamp: '2026-03-17' },
    { id: '2', content: 'No URLs in this message', sender: 'Bob', timestamp: '2026-03-17' },
    { id: '3', content: 'Multiple URLs: https://github.com/pandore/lizardbrain and https://example.com', sender: 'Alice', timestamp: '2026-03-17' },
  ];

  const result = await urlEnricher.enrichMessages(messages, { timeoutMs: 10000 });
  assert(result.enriched >= 1, `Enriched ${result.enriched} URLs (expected >= 1)`);

  // GitHub URL should have been enriched with repo info
  const msg1 = messages[0].content;
  assert(msg1.includes('[') && msg1.includes('lizardbrain'), `GitHub URL enriched: ${msg1.substring(0, 120)}...`);

  // Message without URLs should be unchanged
  assert(messages[1].content === 'No URLs in this message', 'Non-URL message unchanged');

  // Test with empty messages
  const emptyResult = await urlEnricher.enrichMessages([]);
  assert(emptyResult.enriched === 0, 'Empty messages returns 0 enriched');
}

function testProfiles() {
  console.log('\n--- Test: profiles ---');

  // Profile definitions
  assert(profiles.PROFILE_NAMES.includes('knowledge'), 'knowledge profile exists');
  assert(profiles.PROFILE_NAMES.includes('team'), 'team profile exists');
  assert(profiles.PROFILE_NAMES.includes('project'), 'project profile exists');
  assert(profiles.PROFILE_NAMES.includes('full'), 'full profile exists');

  // getProfile
  const knowledge = profiles.getProfile('knowledge');
  assert(knowledge.entities.includes('members'), 'knowledge has members');
  assert(knowledge.entities.includes('facts'), 'knowledge has facts');
  assert(knowledge.entities.includes('topics'), 'knowledge has topics');
  assert(!knowledge.entities.includes('decisions'), 'knowledge does not have decisions');

  const team = profiles.getProfile('team');
  assert(team.entities.includes('decisions'), 'team has decisions');
  assert(team.entities.includes('tasks'), 'team has tasks');
  assert(!team.entities.includes('questions'), 'team does not have questions');

  const project = profiles.getProfile('project');
  assert(project.entities.includes('questions'), 'project has questions');
  assert(!project.entities.includes('topics'), 'project does not have topics');

  const full = profiles.getProfile('full');
  assert(full.entities.length === profiles.ALL_ENTITIES.length, 'full has all entity types');

  // custom profile
  const custom = profiles.getProfile('custom');
  assert(custom.entities.length === profiles.ALL_ENTITIES.length, 'custom defaults to all entities');

  // buildCustomProfile
  const cp = profiles.buildCustomProfile(['members', 'facts', 'decisions']);
  assert(cp.entities.length === 3, 'custom profile with 3 entities');

  // Error on invalid profile
  let threw = false;
  try { profiles.getProfile('nonexistent'); } catch (e) { threw = true; }
  assert(threw, 'getProfile throws on invalid profile name');

  // Member labels differ between profiles
  assert(knowledge.memberLabels.rosterProjects === 'builds', 'knowledge roster label is "builds"');
  assert(team.memberLabels.rosterProjects === 'works on', 'team roster label is "works on"');
  assert(project.memberLabels.rosterProjects === 'scope', 'project roster label is "scope"');

  // Fact categories differ
  assert(knowledge.factCategories.includes('tool'), 'knowledge has tool category');
  assert(team.factCategories.includes('process'), 'team has process category');
  assert(project.factCategories.includes('requirement'), 'project has requirement category');
}

function testNewEntities() {
  console.log('\n--- Test: new entities ---');

  const memDriver = createDriver(MEMORY_DB);

  // Insert decisions
  const result1 = store.processExtraction(memDriver, {
    members: [],
    facts: [],
    topics: [],
    decisions: [
      { description: 'Use PostgreSQL instead of MySQL for the new service', participants: 'Alice, Bob', context: 'Need better JSON support', status: 'agreed', tags: 'database, migration' },
      { description: 'Deploy to AWS instead of GCP', participants: 'Alice', context: 'Cost analysis showed 30% savings', status: 'proposed', tags: 'cloud, deployment' },
    ],
    tasks: [
      { description: 'Migrate user service to PostgreSQL', assignee: 'Bob', deadline: '2026-04-15', status: 'open', source_member: 'Alice', tags: 'database' },
    ],
    questions: [
      { question: 'What is the best way to handle database migrations?', asker: 'Bob', answer: 'Use Flyway or Liquibase', answered_by: 'Alice', status: 'answered', tags: 'database, migrations' },
      { question: 'Should we use Kubernetes or ECS?', asker: 'Charlie', answer: null, answered_by: null, status: 'open', tags: 'infrastructure' },
    ],
    events: [
      { name: 'Architecture Review Meeting', description: 'Review migration plan for Q2', event_date: '2026-04-01', location: 'Zoom', attendees: 'Alice, Bob, Charlie', tags: 'meeting, architecture' },
    ],
  }, '2026-03-28');

  assert(result1.totalDecisions === 2, `Inserted ${result1.totalDecisions} decisions (expected 2)`);
  assert(result1.totalTasks === 1, `Inserted ${result1.totalTasks} tasks (expected 1)`);
  assert(result1.totalQuestions === 2, `Inserted ${result1.totalQuestions} questions (expected 2)`);
  assert(result1.totalEvents === 1, `Inserted ${result1.totalEvents} events (expected 1)`);

  // Dedup: insert same decision again
  const result2 = store.processExtraction(memDriver, {
    members: [], facts: [], topics: [],
    decisions: [{ description: 'Use PostgreSQL instead of MySQL for the new service', participants: 'Alice, Bob', context: 'JSON support', status: 'agreed', tags: 'database' }],
    tasks: [],
    questions: [],
    events: [],
  }, '2026-03-28');
  assert(result2.totalDecisions === 0, 'Decision dedup: exact match blocked');

  // FTS search across new entities
  const decisions = store.searchDecisions(memDriver, 'PostgreSQL');
  assert(decisions.length >= 1, `FTS found ${decisions.length} PostgreSQL decisions (expected >= 1)`);

  const tasks = store.searchTasks(memDriver, 'PostgreSQL');
  assert(tasks.length >= 1, `FTS found ${tasks.length} PostgreSQL tasks (expected >= 1)`);

  const questions = store.searchQuestions(memDriver, 'database');
  assert(questions.length >= 1, `FTS found ${questions.length} database questions (expected >= 1)`);

  const events = store.searchEvents(memDriver, 'Architecture');
  assert(events.length >= 1, `FTS found ${events.length} Architecture events (expected >= 1)`);

  // Stats should include new entity counts
  const stats = store.getStats(memDriver);
  assert(stats.decisions >= 2, `Stats shows ${stats.decisions} decisions (expected >= 2)`);
  assert(stats.tasks >= 1, `Stats shows ${stats.tasks} tasks (expected >= 1)`);
  assert(stats.questions >= 2, `Stats shows ${stats.questions} questions (expected >= 2)`);
  assert(stats.events >= 1, `Stats shows ${stats.events} events (expected >= 1)`);
  assert(stats.profile === 'team', `Stats shows profile: ${stats.profile} (expected team)`);

  memDriver.close();
}

function testDynamicPrompt() {
  console.log('\n--- Test: dynamic prompt ---');

  const knowledge = profiles.getProfile('knowledge');
  const prompt = buildPrompt('test messages', knowledge);
  assert(prompt.includes('"members"'), 'knowledge prompt includes members');
  assert(prompt.includes('"facts"'), 'knowledge prompt includes facts');
  assert(prompt.includes('"topics"'), 'knowledge prompt includes topics');
  assert(!prompt.includes('"decisions"'), 'knowledge prompt excludes decisions');
  assert(!prompt.includes('"tasks"'), 'knowledge prompt excludes tasks');
  assert(prompt.includes('tool, technique'), 'knowledge prompt has knowledge categories');

  const team = profiles.getProfile('team');
  const teamPrompt = buildPrompt('test messages', team);
  assert(teamPrompt.includes('"decisions"'), 'team prompt includes decisions');
  assert(teamPrompt.includes('"tasks"'), 'team prompt includes tasks');
  assert(!teamPrompt.includes('"questions"'), 'team prompt excludes questions');
  assert(teamPrompt.includes('process, technical'), 'team prompt has team categories');
  assert(teamPrompt.includes('role/position'), 'team prompt uses role/position label');

  const project = profiles.getProfile('project');
  const projPrompt = buildPrompt('test messages', project);
  assert(projPrompt.includes('"questions"'), 'project prompt includes questions');
  assert(!projPrompt.includes('"topics"'), 'project prompt excludes topics');
  assert(projPrompt.includes('requirement'), 'project prompt has requirement category');

  const full = profiles.getProfile('full');
  const fullPrompt = buildPrompt('test messages', full);
  assert(fullPrompt.includes('"events"'), 'full prompt includes events');
  assert(fullPrompt.includes('"questions"'), 'full prompt includes questions');
  assert(fullPrompt.includes('"decisions"'), 'full prompt includes decisions');
}

function testProfileRoster() {
  console.log('\n--- Test: profile roster ---');

  const memDriver = createDriver(MEMORY_DB);

  // Knowledge roster uses "builds" label
  const knowledgeRoster = store.generateRoster(memDriver, {
    memberLabels: profiles.getProfile('knowledge').memberLabels,
  });
  assert(knowledgeRoster.content.includes('builds:'), 'knowledge roster uses "builds:" label');

  // Team roster uses "works on" label
  const teamRoster = store.generateRoster(memDriver, {
    memberLabels: profiles.getProfile('team').memberLabels,
  });
  assert(teamRoster.content.includes('works on:'), 'team roster uses "works on:" label');

  // Project roster uses "scope" label
  const projectRoster = store.generateRoster(memDriver, {
    memberLabels: profiles.getProfile('project').memberLabels,
  });
  assert(projectRoster.content.includes('scope:'), 'project roster uses "scope:" label');

  memDriver.close();
}

function testMigration() {
  console.log('\n--- Test: migration ---');

  // Create a v0.3-style database (no new tables, no profile meta)
  const V03_DB = path.join(TEST_DIR, 'v03.db');
  if (fs.existsSync(V03_DB)) fs.unlinkSync(V03_DB);
  execSync(`sqlite3 "${V03_DB}"`, {
    input: `
      PRAGMA journal_mode=WAL;
      CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT, expertise TEXT DEFAULT '', projects TEXT DEFAULT '', preferences TEXT DEFAULT '', first_seen TEXT, last_seen TEXT, updated_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE facts (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, content TEXT NOT NULL, source_member_id INTEGER, tags TEXT DEFAULT '', confidence REAL DEFAULT 0.8, message_date TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE topics (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, summary TEXT, participants TEXT DEFAULT '', message_date TEXT, tags TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
      CREATE VIRTUAL TABLE members_fts USING fts5(username, display_name, expertise, projects, preferences, content='members', content_rowid='id');
      CREATE VIRTUAL TABLE facts_fts USING fts5(category, content, tags, content='facts', content_rowid='id');
      CREATE VIRTUAL TABLE topics_fts USING fts5(name, summary, participants, tags, content='topics', content_rowid='id');
      CREATE TABLE extraction_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_processed_id TEXT DEFAULT '0', total_messages_processed INTEGER DEFAULT 0, total_facts_extracted INTEGER DEFAULT 0, total_topics_extracted INTEGER DEFAULT 0, total_members_seen INTEGER DEFAULT 0, last_run_at TEXT, created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO extraction_state (id) VALUES (1);
      CREATE TABLE lizardbrain_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')));
    `,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const driver = createDriver(V03_DB);
  const result = migrate(driver);
  assert(result.migrated === true, 'Migration ran successfully');

  // Verify new tables exist
  const tables = execSync(`sqlite3 "${V03_DB}" ".tables"`, { encoding: 'utf-8' });
  assert(tables.includes('decisions'), 'decisions table created by migration');
  assert(tables.includes('tasks'), 'tasks table created by migration');
  assert(tables.includes('questions'), 'questions table created by migration');
  assert(tables.includes('events'), 'events table created by migration');
  assert(tables.includes('decisions_fts'), 'decisions_fts created by migration');

  // Verify profile defaulted to knowledge
  const profileMeta = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'profile_name'");
  assert(profileMeta[0]?.value === 'knowledge', 'Migration defaults to knowledge profile');

  // Verify schema version set
  const version = driver.read("SELECT value FROM lizardbrain_meta WHERE key = 'schema_version'");
  assert(version[0]?.value === '0.4', 'Schema version set to 0.4');

  // Idempotent: running again should be a no-op
  const result2 = migrate(driver);
  assert(result2.migrated === false, 'Second migration is a no-op');

  driver.close();
}

async function testNewEntityFtsSearch() {
  console.log('\n--- Test: new entity FTS search ---');

  const { search } = require('../src/search');
  const memDriver = createDriver(MEMORY_DB);

  // Search should find results across new entity types
  const res = await search(memDriver, 'PostgreSQL', { limit: 10, ftsOnly: true });
  const sources = res.results.map(r => r.source);
  assert(sources.includes('decision') || sources.includes('task'), 'Search finds new entity types');
  memDriver.close();
}

// --- Run ---

async function runAll() {
  setup();
  testInit();
  testAdapter();
  testJsonlAdapter();
  testProfiles();
  testStore();
  testNewEntities();
  testConfidenceFiltering();
  testRoster();
  testProfileRoster();
  testDynamicPrompt();
  testMigration();
  testConversationFilter();
  testCliDriver();
  testBetterSqliteDriver();
  await testEmbeddings();
  testRRFMerge();
  await testFtsOnlySearch();
  await testNewEntityFtsSearch();
  await testUrlEnrichment();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error(`\nTest crashed: ${err.message}\n${err.stack}`);
  cleanup();
  process.exit(1);
});
