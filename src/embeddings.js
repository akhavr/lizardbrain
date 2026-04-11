/**
 * embeddings.js — OpenAI-compatible embedding client for lizardbrain.
 * Handles token-aware batching, retry, vec0 table management,
 * model change detection, and backfill logic.
 */

'use strict';

const { esc } = require('./driver');

// --- Utility functions ---

/**
 * Rough token estimate: 1 token ≈ 4 characters.
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Groups an array of texts into batches that each fit within batchTokenLimit.
 * Uses character length as a proxy for tokens (batchTokenLimit is a character budget).
 * Texts that individually exceed the limit are placed in their own batch.
 */
function splitIntoBatches(texts, batchTokenLimit) {
  const batches = [];
  let currentBatch = [];
  let currentLen = 0;

  for (const text of texts) {
    const len = (text || '').length;
    if (currentBatch.length > 0 && currentLen + len > batchTokenLimit) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLen = 0;
    }
    currentBatch.push(text);
    currentLen += len;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// --- API client ---

/**
 * POST to config.baseUrl + '/embeddings' with Bearer auth.
 * Returns { embeddings: [[...], ...], dimensions: N }
 */
async function embed(texts, config) {
  const url = config.baseUrl.replace(/\/$/, '') + '/embeddings';
  const body = JSON.stringify({
    model: config.model,
    input: texts,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`Embedding API error ${response.status}: ${text}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const embeddings = data.data.map(item => item.embedding);
  const dimensions = embeddings.length > 0 ? embeddings[0].length : (config.dimensions || 0);

  return { embeddings, dimensions };
}

/**
 * Retries embed() on 429 with exponential backoff (1s, 2s, 4s).
 */
async function embedWithRetry(texts, config, maxRetries = 3) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await embed(texts, config);
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw err;
    }
  }
}

// --- Metadata helpers ---

/**
 * Reads a value from lizardbrain_meta table.
 */
function getMeta(driver, key) {
  const rows = driver.read(
    `SELECT value FROM lizardbrain_meta WHERE key = '${esc(key)}'`
  );
  return rows.length > 0 ? rows[0].value : null;
}

/**
 * Writes a value to lizardbrain_meta table (INSERT OR REPLACE).
 */
function setMeta(driver, key, value) {
  driver.write(
    `INSERT OR REPLACE INTO lizardbrain_meta (key, value, updated_at) VALUES ('${esc(key)}', '${esc(String(value))}', datetime('now'))`
  );
}

/**
 * Compares stored embedding_model against config.model.
 * Returns { ok: true } if consistent, or { ok: false, error: '...' } if not.
 */
function checkModelConsistency(driver, config) {
  const stored = getMeta(driver, 'embedding_model');
  if (!stored) {
    // No model stored yet — considered consistent (first run)
    return { ok: true };
  }
  if (stored !== config.model) {
    return {
      ok: false,
      error: `Model mismatch: stored='${stored}', config='${config.model}'. Use rebuild option to re-embed with new model.`,
    };
  }
  return { ok: true };
}

// --- Vec0 management ---

/**
 * Creates facts_vec, topics_vec, members_vec using vec0.
 * Throws if driver.capabilities.vectors is false.
 */
function createVecTables(driver, dimensions) {
  if (!driver.capabilities.vectors) {
    throw new Error('Vector capability not available on this driver (sqlite-vec not loaded)');
  }

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(
      fact_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS topics_vec USING vec0(
      topic_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS members_vec USING vec0(
      member_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_vec USING vec0(
      decision_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS tasks_vec USING vec0(
      task_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS questions_vec USING vec0(
      question_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);

  driver.write(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_vec USING vec0(
      event_id INTEGER PRIMARY KEY,
      embedding FLOAT[${dimensions}]
    );
  `);
}

/**
 * Returns coverage stats: total vs embedded for each table, plus model and dimensions.
 */
function getEmbeddingStats(driver) {
  const model = getMeta(driver, 'embedding_model') || null;
  const dimensions = getMeta(driver, 'embedding_dimensions');

  function count(table) {
    const rows = driver.read(`SELECT COUNT(*) as c FROM ${table}`);
    return parseInt(rows[0]?.c) || 0;
  }

  const factsTotal = count('facts');
  const topicsTotal = count('topics');
  const membersTotal = count('members');
  const decisionsTotal = count('decisions');
  const tasksTotal = count('tasks');
  const questionsTotal = count('questions');
  const eventsTotal = count('events');

  // Vec tables may not exist yet; driver.read returns [] on missing table
  const factsEmbedded = count('facts_vec');
  const topicsEmbedded = count('topics_vec');
  const membersEmbedded = count('members_vec');
  const decisionsEmbedded = count('decisions_vec');
  const tasksEmbedded = count('tasks_vec');
  const questionsEmbedded = count('questions_vec');
  const eventsEmbedded = count('events_vec');

  // Per-model counts from embedding_metadata (if table exists)
  let modelCounts = [];
  const metaRows = driver.read(
    `SELECT model_id, COUNT(*) as c FROM embedding_metadata GROUP BY model_id`
  );
  if (metaRows.length > 0) {
    modelCounts = metaRows.map(r => ({ model: r.model_id, count: parseInt(r.c) || 0 }));
  }

  return {
    model,
    dimensions: dimensions ? parseInt(dimensions) : null,
    facts: { total: factsTotal, embedded: factsEmbedded },
    topics: { total: topicsTotal, embedded: topicsEmbedded },
    members: { total: membersTotal, embedded: membersEmbedded },
    decisions: { total: decisionsTotal, embedded: decisionsEmbedded },
    tasks: { total: tasksTotal, embedded: tasksEmbedded },
    questions: { total: questionsTotal, embedded: questionsEmbedded },
    events: { total: eventsTotal, embedded: eventsEmbedded },
    modelCounts,
  };
}

// --- Backfill pipeline ---

/**
 * Embeds all unembedded facts, topics, and members.
 *
 * Steps:
 * 1. Check driver.capabilities.vectors — skip if unavailable
 * 2. Check model consistency (unless options.rebuild)
 * 3. Determine dimensions (config → stored meta → auto-detect via probe)
 * 4. If rebuild: drop existing vec tables, clear meta
 * 5. Create vec tables if needed
 * 6. Store meta (model, dimensions, baseUrl)
 * 7. Embed unembedded facts, topics, members
 * 8. Return { ok: true, totalEmbedded }
 *
 * @param {object} driver
 * @param {object} config - { baseUrl, apiKey, model, dimensions?, batchTokenLimit? }
 * @param {object} [options] - { rebuild?, batchTokenLimit? }
 */
async function backfill(driver, config, options = {}) {
  if (!driver.capabilities.vectors) {
    console.warn('[lizardbrain:embeddings] Skipping backfill — vector capability unavailable');
    return { ok: false, skipped: true, reason: 'vectors_unavailable' };
  }

  // Model consistency check
  if (!options.rebuild) {
    const consistency = checkModelConsistency(driver, config);
    if (!consistency.ok) {
      return { ok: false, error: consistency.error };
    }
  }

  // Determine dimensions
  let dimensions = config.dimensions ? parseInt(config.dimensions) : null;

  if (!dimensions) {
    const storedDims = getMeta(driver, 'embedding_dimensions');
    if (storedDims) {
      dimensions = parseInt(storedDims);
    }
  }

  if (!dimensions) {
    // Auto-detect via probe call
    console.log('[lizardbrain:embeddings] Detecting dimensions via probe embedding...');
    const probe = await embedWithRetry(['probe'], config);
    dimensions = probe.dimensions;
  }

  // Rebuild: drop existing vec tables and clear meta
  if (options.rebuild) {
    for (const table of ['facts_vec', 'topics_vec', 'members_vec', 'decisions_vec', 'tasks_vec', 'questions_vec', 'events_vec']) {
      driver.write(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const key of ['embedding_model', 'embedding_dimensions', 'embedding_base_url']) {
      driver.write(`DELETE FROM lizardbrain_meta WHERE key = '${esc(key)}'`);
    }
  }

  // Create vec tables if they don't exist
  createVecTables(driver, dimensions);

  // Store meta
  setMeta(driver, 'embedding_model', config.model);
  setMeta(driver, 'embedding_dimensions', String(dimensions));
  setMeta(driver, 'embedding_base_url', config.baseUrl);

  const batchTokenLimit = options.batchTokenLimit || config.batchTokenLimit || 8000;
  let totalEmbedded = 0;

  // Prepare embedding_metadata insert (if table exists)
  let metaStmt = null;
  try {
    metaStmt = driver._db.prepare(
      'INSERT OR REPLACE INTO embedding_metadata (entity_type, entity_id, model_id, embedded_at) VALUES (?, ?, ?, datetime(\'now\'))'
    );
  } catch (_) {
    // Table may not exist on older schemas — skip metadata tracking
  }

  // --- Embed facts ---
  {
    const rows = driver.read(
      `SELECT f.id, f.content FROM facts f
       LEFT JOIN facts_vec fv ON f.id = fv.fact_id
       WHERE fv.fact_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r => r.content || '');
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO facts_vec (fact_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('fact', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed topics ---
  {
    const rows = driver.read(
      `SELECT t.id, t.name, t.summary FROM topics t
       LEFT JOIN topics_vec tv ON t.id = tv.topic_id
       WHERE tv.topic_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r => `${r.name || ''}: ${r.summary || ''}`);
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO topics_vec (topic_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('topic', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed members ---
  {
    const rows = driver.read(
      `SELECT m.id, m.display_name, m.expertise, m.projects FROM members m
       LEFT JOIN members_vec mv ON m.id = mv.member_id
       WHERE mv.member_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r =>
        `${r.display_name || ''} — ${r.expertise || ''} | ${r.projects || ''}`
      );
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO members_vec (member_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('member', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed decisions ---
  {
    const rows = driver.read(
      `SELECT d.id, d.description, d.context FROM decisions d
       LEFT JOIN decisions_vec dv ON d.id = dv.decision_id
       WHERE dv.decision_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r =>
        `${r.description || ''}. Context: ${r.context || ''}`
      );
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO decisions_vec (decision_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('decision', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed tasks ---
  {
    const rows = driver.read(
      `SELECT t.id, t.description, t.assignee FROM tasks t
       LEFT JOIN tasks_vec tv ON t.id = tv.task_id
       WHERE tv.task_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r =>
        `${r.description || ''} -- assigned to ${r.assignee || 'unassigned'}`
      );
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO tasks_vec (task_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('task', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed questions ---
  {
    const rows = driver.read(
      `SELECT q.id, q.question, q.answer FROM questions q
       LEFT JOIN questions_vec qv ON q.id = qv.question_id
       WHERE qv.question_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r =>
        `${r.question || ''}${r.answer ? ' -> ' + r.answer : ''}`
      );
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO questions_vec (question_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('question', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  // --- Embed events ---
  {
    const rows = driver.read(
      `SELECT e.id, e.name, e.description FROM events e
       LEFT JOIN events_vec ev ON e.id = ev.event_id
       WHERE ev.event_id IS NULL`
    );

    if (rows.length > 0) {
      const texts = rows.map(r =>
        `${r.name || ''}: ${r.description || ''}`
      );
      const batches = splitIntoBatches(texts, batchTokenLimit);
      let offset = 0;

      for (const batch of batches) {
        const result = await embedWithRetry(batch, config);
        driver.transaction(() => {
          const insertStmt = driver._db.prepare(
            'INSERT OR REPLACE INTO events_vec (event_id, embedding) VALUES (?, ?)'
          );
          for (let i = 0; i < batch.length; i++) {
            const row = rows[offset + i];
            insertStmt.run(BigInt(row.id), new Float32Array(result.embeddings[i]));
            if (metaStmt) metaStmt.run('event', row.id, config.model);
          }
        });
        offset += batch.length;
        totalEmbedded += batch.length;
      }
    }
  }

  return { ok: true, totalEmbedded };
}

/**
 * Prune orphaned, stale, or model-specific embeddings.
 */
function prune(driver, options = {}) {
  const { orphaned = false, stale = false, model = null } = options;
  let totalPruned = 0;

  const entityMap = [
    { type: 'fact', vecTable: 'facts_vec', idCol: 'fact_id', parentTable: 'facts' },
    { type: 'topic', vecTable: 'topics_vec', idCol: 'topic_id', parentTable: 'topics' },
    { type: 'member', vecTable: 'members_vec', idCol: 'member_id', parentTable: 'members' },
    { type: 'decision', vecTable: 'decisions_vec', idCol: 'decision_id', parentTable: 'decisions' },
    { type: 'task', vecTable: 'tasks_vec', idCol: 'task_id', parentTable: 'tasks' },
    { type: 'question', vecTable: 'questions_vec', idCol: 'question_id', parentTable: 'questions' },
    { type: 'event', vecTable: 'events_vec', idCol: 'event_id', parentTable: 'events' },
  ];

  if (orphaned) {
    for (const { type, vecTable, idCol, parentTable } of entityMap) {
      try {
        const orphans = driver.read(
          `SELECT v.${idCol} FROM ${vecTable} v LEFT JOIN ${parentTable} p ON v.${idCol} = p.id WHERE p.id IS NULL`
        );
        for (const row of orphans) {
          driver._db.prepare(`DELETE FROM ${vecTable} WHERE ${idCol} = ?`).run(row[idCol]);
          driver.write(`DELETE FROM embedding_metadata WHERE entity_type = '${type}' AND entity_id = ${row[idCol]}`);
          totalPruned++;
        }
      } catch (_) {
        // vec table may not exist
      }
    }
  }

  if (stale) {
    for (const { type, vecTable, idCol, parentTable } of entityMap) {
      try {
        const staleRows = driver.read(
          `SELECT em.entity_id FROM embedding_metadata em JOIN ${parentTable} p ON em.entity_id = p.id WHERE em.entity_type = '${type}' AND p.updated_at IS NOT NULL AND em.embedded_at < p.updated_at`
        );
        for (const row of staleRows) {
          try {
            driver._db.prepare(`DELETE FROM ${vecTable} WHERE ${idCol} = ?`).run(row.entity_id);
          } catch (_) { /* vec table may not exist */ }
          driver.write(`DELETE FROM embedding_metadata WHERE entity_type = '${type}' AND entity_id = ${row.entity_id}`);
          totalPruned++;
        }
      } catch (_) {
        // table may not have updated_at
      }
    }
  }

  if (model) {
    const { esc } = require('./driver');
    const metaRows = driver.read(
      `SELECT entity_type, entity_id FROM embedding_metadata WHERE model_id = '${esc(model)}'`
    );
    for (const row of metaRows) {
      const entry = entityMap.find(e => e.type === row.entity_type);
      if (entry) {
        try {
          driver._db.prepare(`DELETE FROM ${entry.vecTable} WHERE ${entry.idCol} = ?`).run(row.entity_id);
        } catch (_) { /* vec table may not exist */ }
      }
      driver.write(`DELETE FROM embedding_metadata WHERE entity_type = '${esc(row.entity_type)}' AND entity_id = ${row.entity_id}`);
      totalPruned++;
    }
  }

  return { totalPruned };
}

module.exports = {
  estimateTokens,
  splitIntoBatches,
  embed,
  embedWithRetry,
  getMeta,
  setMeta,
  checkModelConsistency,
  createVecTables,
  getEmbeddingStats,
  backfill,
  prune,
};
