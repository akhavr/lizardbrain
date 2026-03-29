/**
 * search.js — Hybrid search combining FTS5 keyword search with vector kNN.
 * Merges results via Reciprocal Rank Fusion (RRF).
 * Falls back to FTS5-only when vectors aren't available.
 */

const { esc, sanitizeFtsQuery } = require('./driver');

/**
 * Merge multiple ranked result sets using Reciprocal Rank Fusion.
 *
 * @param {Array<Array<{key: string, data: object}>>} resultSets - Each set ranked best-first
 * @param {number} K - RRF constant (default 60)
 * @returns {Array<{key: string, score: number, data: object}>} Merged results sorted by score desc
 */
function mergeRRF(resultSets, K = 60) {
  const scores = new Map(); // key -> cumulative score
  const dataMap = new Map(); // key -> data (last writer wins, but overlap items share key)

  for (const resultSet of resultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const { key, data } = resultSet[rank];
      const score = 1 / (K + rank + 1);
      scores.set(key, (scores.get(key) || 0) + score);
      // Keep data from the first set that introduces a key (FTS data for overlap items)
      if (!dataMap.has(key)) {
        dataMap.set(key, data);
      }
    }
  }

  const merged = [];
  for (const [key, score] of scores) {
    merged.push({ key, score, data: dataMap.get(key) });
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

/**
 * Run FTS5 keyword search across facts, topics, and members.
 *
 * @param {object} driver - lizardbrain driver instance
 * @param {string} query - Search query string
 * @param {number} limit - Max results per table
 * @returns {Array<{key: string, data: object}>}
 */
function ftsSearch(driver, query, limit) {
  const escapedQuery = esc(sanitizeFtsQuery(query));
  const results = [];

  // Search facts_fts
  const facts = driver.read(
    `SELECT f.id, f.content, f.confidence, f.tags, f.category, m.display_name as member
     FROM facts f
     LEFT JOIN members m ON f.source_member_id = m.id
     WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${escapedQuery}')
     ORDER BY f.confidence DESC
     LIMIT ${limit}`
  );
  for (const f of facts) {
    results.push({
      key: `fact:${f.id}`,
      data: {
        source: 'fact',
        id: f.id,
        text: f.content,
        confidence: f.confidence,
        member: f.member || null,
        tags: f.tags || '',
        category: f.category,
      },
    });
  }

  // Search topics_fts
  const topics = driver.read(
    `SELECT id, name, summary, tags, participants
     FROM topics
     WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${escapedQuery}')
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const t of topics) {
    results.push({
      key: `topic:${t.id}`,
      data: {
        source: 'topic',
        id: t.id,
        text: t.summary || t.name,
        tags: t.tags || '',
        participants: t.participants || '',
      },
    });
  }

  // Search members_fts
  const members = driver.read(
    `SELECT id, display_name, username, expertise, projects
     FROM members
     WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${escapedQuery}')
     LIMIT ${limit}`
  );
  for (const m of members) {
    results.push({
      key: `member:${m.id}`,
      data: {
        source: 'member',
        id: m.id,
        text: m.display_name || m.username,
        expertise: m.expertise || '',
        projects: m.projects || '',
      },
    });
  }

  // Search decisions_fts
  const decisions = driver.read(
    `SELECT id, description, context, participants, status, tags
     FROM decisions
     WHERE id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${escapedQuery}')
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const d of decisions) {
    results.push({
      key: `decision:${d.id}`,
      data: {
        source: 'decision',
        id: d.id,
        text: d.description,
        context: d.context || '',
        participants: d.participants || '',
        status: d.status || 'proposed',
        tags: d.tags || '',
      },
    });
  }

  // Search tasks_fts
  const tasks = driver.read(
    `SELECT t.id, t.description, t.assignee, t.status, t.tags, m.display_name as member
     FROM tasks t
     LEFT JOIN members m ON t.source_member_id = m.id
     WHERE t.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${escapedQuery}')
     ORDER BY t.created_at DESC
     LIMIT ${limit}`
  );
  for (const t of tasks) {
    results.push({
      key: `task:${t.id}`,
      data: {
        source: 'task',
        id: t.id,
        text: t.description,
        assignee: t.assignee || '',
        member: t.member || null,
        status: t.status || 'open',
        tags: t.tags || '',
      },
    });
  }

  // Search questions_fts
  const questions = driver.read(
    `SELECT id, question, asker, answer, answered_by, status, tags
     FROM questions
     WHERE id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${escapedQuery}')
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const q of questions) {
    results.push({
      key: `question:${q.id}`,
      data: {
        source: 'question',
        id: q.id,
        text: q.question,
        answer: q.answer || '',
        asker: q.asker || '',
        answered_by: q.answered_by || '',
        status: q.status || 'open',
        tags: q.tags || '',
      },
    });
  }

  // Search events_fts
  const events = driver.read(
    `SELECT id, name, description, event_date, location, attendees, tags
     FROM events
     WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${escapedQuery}')
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const e of events) {
    results.push({
      key: `event:${e.id}`,
      data: {
        source: 'event',
        id: e.id,
        text: e.name,
        description: e.description || '',
        event_date: e.event_date || '',
        location: e.location || '',
        attendees: e.attendees || '',
        tags: e.tags || '',
      },
    });
  }

  return results;
}

/**
 * Run vector kNN search across facts_vec, topics_vec, and members_vec.
 * Requires driver._db (raw better-sqlite3) and sqlite-vec extension loaded.
 *
 * @param {object} driver - lizardbrain driver instance with ._db
 * @param {number[]} queryEmbedding - Query vector as array of floats
 * @param {number} limit - Max results per table
 * @returns {Array<{key: string, data: object}>}
 */
function vecSearch(driver, queryEmbedding, limit) {
  const db = driver._db;
  const embeddingBuffer = new Float32Array(queryEmbedding);
  const results = [];

  // Search facts_vec
  try {
    const factRows = db.prepare(
      `SELECT fact_id, distance FROM facts_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of factRows) {
      const fact = db.prepare(
        `SELECT f.id, f.content, f.confidence, f.tags, f.category, m.display_name as member
         FROM facts f
         LEFT JOIN members m ON f.source_member_id = m.id
         WHERE f.id = ?`
      ).get(row.fact_id);
      if (fact) {
        results.push({
          key: `fact:${fact.id}`,
          data: {
            source: 'fact',
            id: fact.id,
            text: fact.content,
            confidence: fact.confidence,
            member: fact.member || null,
            tags: fact.tags || '',
            category: fact.category,
          },
        });
      }
    }
  } catch (_) {
    // facts_vec table may not exist yet
  }

  // Search topics_vec
  try {
    const topicRows = db.prepare(
      `SELECT topic_id, distance FROM topics_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of topicRows) {
      const topic = db.prepare(
        `SELECT id, name, summary, tags, participants FROM topics WHERE id = ?`
      ).get(row.topic_id);
      if (topic) {
        results.push({
          key: `topic:${topic.id}`,
          data: {
            source: 'topic',
            id: topic.id,
            text: topic.summary || topic.name,
            tags: topic.tags || '',
            participants: topic.participants || '',
          },
        });
      }
    }
  } catch (_) {
    // topics_vec table may not exist yet
  }

  // Search members_vec
  try {
    const memberRows = db.prepare(
      `SELECT member_id, distance FROM members_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of memberRows) {
      const member = db.prepare(
        `SELECT id, display_name, username, expertise, projects FROM members WHERE id = ?`
      ).get(row.member_id);
      if (member) {
        results.push({
          key: `member:${member.id}`,
          data: {
            source: 'member',
            id: member.id,
            text: member.display_name || member.username,
            expertise: member.expertise || '',
            projects: member.projects || '',
          },
        });
      }
    }
  } catch (_) {
    // members_vec table may not exist yet
  }

  // Search decisions_vec
  try {
    const decisionRows = db.prepare(
      `SELECT decision_id, distance FROM decisions_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of decisionRows) {
      const decision = db.prepare(
        `SELECT id, description, context, participants, status, tags FROM decisions WHERE id = ?`
      ).get(row.decision_id);
      if (decision) {
        results.push({
          key: `decision:${decision.id}`,
          data: {
            source: 'decision',
            id: decision.id,
            text: decision.description,
            context: decision.context || '',
            participants: decision.participants || '',
            status: decision.status || 'proposed',
            tags: decision.tags || '',
          },
        });
      }
    }
  } catch (_) {
    // decisions_vec table may not exist yet
  }

  // Search tasks_vec
  try {
    const taskRows = db.prepare(
      `SELECT task_id, distance FROM tasks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of taskRows) {
      const task = db.prepare(
        `SELECT t.id, t.description, t.assignee, t.status, t.tags, m.display_name as member
         FROM tasks t LEFT JOIN members m ON t.source_member_id = m.id WHERE t.id = ?`
      ).get(row.task_id);
      if (task) {
        results.push({
          key: `task:${task.id}`,
          data: {
            source: 'task',
            id: task.id,
            text: task.description,
            assignee: task.assignee || '',
            member: task.member || null,
            status: task.status || 'open',
            tags: task.tags || '',
          },
        });
      }
    }
  } catch (_) {
    // tasks_vec table may not exist yet
  }

  // Search questions_vec
  try {
    const questionRows = db.prepare(
      `SELECT question_id, distance FROM questions_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of questionRows) {
      const question = db.prepare(
        `SELECT id, question, asker, answer, answered_by, status, tags FROM questions WHERE id = ?`
      ).get(row.question_id);
      if (question) {
        results.push({
          key: `question:${question.id}`,
          data: {
            source: 'question',
            id: question.id,
            text: question.question,
            answer: question.answer || '',
            asker: question.asker || '',
            answered_by: question.answered_by || '',
            status: question.status || 'open',
            tags: question.tags || '',
          },
        });
      }
    }
  } catch (_) {
    // questions_vec table may not exist yet
  }

  // Search events_vec
  try {
    const eventRows = db.prepare(
      `SELECT event_id, distance FROM events_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, limit);

    for (const row of eventRows) {
      const event = db.prepare(
        `SELECT id, name, description, event_date, location, attendees, tags FROM events WHERE id = ?`
      ).get(row.event_id);
      if (event) {
        results.push({
          key: `event:${event.id}`,
          data: {
            source: 'event',
            id: event.id,
            text: event.name,
            description: event.description || '',
            event_date: event.event_date || '',
            location: event.location || '',
            attendees: event.attendees || '',
            tags: event.tags || '',
          },
        });
      }
    }
  } catch (_) {
    // events_vec table may not exist yet
  }

  return results;
}

/**
 * Main search function — hybrid FTS5 + vector kNN, or FTS5-only fallback.
 *
 * @param {object} driver - lizardbrain driver instance
 * @param {string} query - Search query string
 * @param {object} options
 * @param {number} [options.limit=10] - Max results to return
 * @param {boolean} [options.ftsOnly=false] - Skip vector search
 * @param {object|null} [options.embeddingConfig=null] - Embedding config ({ baseUrl, apiKey, model, ... })
 * @returns {Promise<{mode: 'hybrid'|'fts5', results: Array}>}
 */
async function search(driver, query, options = {}) {
  const { limit = 10, ftsOnly = false, embeddingConfig = null } = options;
  const ftsLimit = limit * 2;

  const ftsResults = ftsSearch(driver, query, ftsLimit);

  const canDoVec = !ftsOnly && driver.capabilities.vectors && embeddingConfig;

  if (canDoVec) {
    try {
      const embeddings = require('./embeddings');
      const { embeddings: vecs } = await embeddings.embedWithRetry([query], embeddingConfig);
      const queryVector = vecs[0];
      const vecResults = vecSearch(driver, queryVector, ftsLimit);
      const merged = mergeRRF([ftsResults, vecResults]);

      const results = merged.slice(0, limit).map(item => {
        const d = item.data;
        const out = {
          source: d.source,
          id: d.id,
          text: d.text,
          score: item.score,
        };
        if (d.confidence !== undefined) out.confidence = d.confidence;
        if (d.member !== undefined) out.member = d.member;
        if (d.tags !== undefined) out.tags = d.tags;
        return out;
      });

      return { mode: 'hybrid', results };
    } catch (err) {
      console.error(`[lizardbrain:search] Hybrid search failed, falling back to FTS5: ${err.message}`);
    }
  }

  // FTS-only path: assign pseudo-RRF scores based on rank
  const results = ftsResults.slice(0, limit).map((item, rank) => {
    const d = item.data;
    const out = {
      source: d.source,
      id: d.id,
      text: d.text,
      score: 1 / (60 + rank + 1),
    };
    if (d.confidence !== undefined) out.confidence = d.confidence;
    if (d.member !== undefined) out.member = d.member;
    if (d.tags !== undefined) out.tags = d.tags;
    return out;
  });

  return { mode: 'fts5', results };
}

module.exports = { search, mergeRRF, ftsSearch, vecSearch };
