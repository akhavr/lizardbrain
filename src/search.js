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

const DEFAULT_SCORING = {
  base: { decision: 600, topic: 600, task: 600, question: 600, member: 600, event: 600, fact: 600 },
  rankBonusMax: 30,
  rankBonusDecay: 3,
  confidencePenalty: 30,
  confidenceBonus: 40,
  factLikeBonus: 35,
  timeline: { decision: 70, topic: 65, task: 60, event: 55, fact: 40, member: 15 },
  decision: { decision: 85, topic: 35, event: 30, fact: 25, task: 20, question: 10 },
  responsibility: { question: 75, task: 60, member: 45, fact: 35, event: 25, decision: 20, topic: 10 },
};

function mergeScoring(defaults, overrides = {}) {
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (typeof defaults[key] === 'object' && typeof overrides[key] === 'object') {
      result[key] = { ...defaults[key], ...overrides[key] };
    } else if (overrides[key] !== undefined) {
      result[key] = overrides[key];
    }
  }
  return result;
}

function analyzeQueryIntent(query) {
  const normalized = String(query || '').toLowerCase();
  return {
    decision: /\b(decision|decisions|approve|approved|approval|agree|agreed|choice|key decisions?)\b/.test(normalized),
    timeline: /\b(timeline|schedule|deployment|release|launch|roadmap|plan|planning|milestone)\b/.test(normalized),
    responsibility: /\b(responsib(?:le|ility)|owner|ownership)\b/.test(normalized) || /\bwho\b/.test(normalized),
    question: /^\s*(who|what|when|where|why|how)\b/.test(normalized) || /\?$/.test(normalized),
    factLike: /\b(fact|facts|detail|details|note|notes|status|update|information|info)\b/.test(normalized),
  };
}

function scoreFtsResult(source, row, rank, intent, opts = {}) {
  const scoring = mergeScoring(DEFAULT_SCORING, opts.scoring);
  let score = scoring.base[source] || 0;

  score += Math.max(0, scoring.rankBonusMax - (rank * scoring.rankBonusDecay));

  if (source === 'fact') {
    const confidence = Number(row.confidence);
    if (Number.isFinite(confidence)) {
      score += Math.max(0, (confidence - 0.5) * scoring.confidenceBonus);
      score -= Math.max(0, (0.8 - confidence) * scoring.confidencePenalty);
    }
    if (intent.factLike) score += scoring.factLikeBonus;
  }

  if (intent.timeline) score += scoring.timeline[source] || 0;
  if (intent.decision) score += scoring.decision[source] || 0;
  if (intent.responsibility || intent.question) score += scoring.responsibility[source] || 0;

  return score;
}

/**
 * Run FTS5 keyword search across facts, topics, and members.
 *
 * @param {object} driver - lizardbrain driver instance
 * @param {string} query - Search query string
 * @param {number} limit - Max results per table
 * @returns {Array<{key: string, data: object}>}
 */
function ftsSearch(driver, query, limit, conversationId, opts = {}) {
  const escapedQuery = esc(sanitizeFtsQuery(query));
  const convFilter = conversationId ? ` AND f.conversation_id = '${esc(conversationId)}'` : '';
  const results = [];
  const intent = analyzeQueryIntent(query);

  // Search facts_fts
  const facts = driver.read(
    `SELECT f.id, f.content, f.confidence, f.tags, f.category, m.display_name as member
     FROM facts f
     LEFT JOIN members m ON f.source_member_id = m.id
     WHERE f.id IN (SELECT rowid FROM facts_fts WHERE facts_fts MATCH '${escapedQuery}') AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until >= datetime('now'))${convFilter}
     ORDER BY f.confidence DESC
     LIMIT ${limit}`
  );
  for (const [rank, f] of facts.entries()) {
    results.push({
      key: `fact:${f.id}`,
      score: scoreFtsResult('fact', f, rank, intent, opts),
      rank,
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
  const topicConvFilter = conversationId ? ` AND conversation_id = '${esc(conversationId)}'` : '';
  const topics = driver.read(
    `SELECT id, name, summary, tags, participants
     FROM topics
     WHERE id IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH '${escapedQuery}') AND superseded_by IS NULL${topicConvFilter}
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const [rank, t] of topics.entries()) {
    results.push({
      key: `topic:${t.id}`,
      score: scoreFtsResult('topic', t, rank, intent, opts),
      rank,
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
     WHERE id IN (SELECT rowid FROM members_fts WHERE members_fts MATCH '${escapedQuery}') AND superseded_by IS NULL
     LIMIT ${limit}`
  );
  for (const [rank, m] of members.entries()) {
    results.push({
      key: `member:${m.id}`,
      score: scoreFtsResult('member', m, rank, intent, opts),
      rank,
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
  const decConvFilter = conversationId ? ` AND conversation_id = '${esc(conversationId)}'` : '';
  const decisions = driver.read(
    `SELECT id, description, context, participants, status, tags
     FROM decisions
     WHERE id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH '${escapedQuery}') AND superseded_by IS NULL${decConvFilter}
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const [rank, d] of decisions.entries()) {
    results.push({
      key: `decision:${d.id}`,
      score: scoreFtsResult('decision', d, rank, intent, opts),
      rank,
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
  const taskConvFilter = conversationId ? ` AND t.conversation_id = '${esc(conversationId)}'` : '';
  const tasks = driver.read(
    `SELECT t.id, t.description, t.assignee, t.status, t.tags, m.display_name as member
     FROM tasks t
     LEFT JOIN members m ON t.source_member_id = m.id
     WHERE t.id IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH '${escapedQuery}') AND t.superseded_by IS NULL${taskConvFilter}
     ORDER BY t.created_at DESC
     LIMIT ${limit}`
  );
  for (const [rank, t] of tasks.entries()) {
    results.push({
      key: `task:${t.id}`,
      score: scoreFtsResult('task', t, rank, intent, opts),
      rank,
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
  const qConvFilter = conversationId ? ` AND conversation_id = '${esc(conversationId)}'` : '';
  const questions = driver.read(
    `SELECT id, question, asker, answer, answered_by, status, tags
     FROM questions
     WHERE id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH '${escapedQuery}') AND superseded_by IS NULL${qConvFilter}
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const [rank, q] of questions.entries()) {
    results.push({
      key: `question:${q.id}`,
      score: scoreFtsResult('question', q, rank, intent, opts),
      rank,
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
  const evtConvFilter = conversationId ? ` AND conversation_id = '${esc(conversationId)}'` : '';
  const events = driver.read(
    `SELECT id, name, description, event_date, location, attendees, tags
     FROM events
     WHERE id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH '${escapedQuery}') AND superseded_by IS NULL${evtConvFilter}
     ORDER BY created_at DESC
     LIMIT ${limit}`
  );
  for (const [rank, e] of events.entries()) {
    results.push({
      key: `event:${e.id}`,
      score: scoreFtsResult('event', e, rank, intent, opts),
      rank,
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

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.key.localeCompare(b.key);
  });

  return results;
}

/**
 * Build a Set of entity IDs that were embedded by the given model.
 * Returns null if modelId is falsy (no filtering needed).
 */
function buildModelFilter(db, entityType, modelId) {
  if (!modelId) return null;
  try {
    const rows = db.prepare(
      'SELECT entity_id FROM embedding_metadata WHERE entity_type = ? AND model_id = ?'
    ).all(entityType, modelId);
    return new Set(rows.map(r => r.entity_id));
  } catch (_) {
    return null; // table may not exist on older schemas
  }
}

/**
 * Run vector kNN search across all entity vec tables.
 * Requires driver._db (raw better-sqlite3) and sqlite-vec extension loaded.
 *
 * @param {object} driver - lizardbrain driver instance with ._db
 * @param {number[]} queryEmbedding - Query vector as array of floats
 * @param {number} limit - Max results per table
 * @param {string|null} modelId - Filter to embeddings from this model (null = no filter)
 * @returns {Array<{key: string, data: object}>}
 */
function vecSearch(driver, queryEmbedding, limit, modelId, conversationId) {
  const db = driver._db;
  const embeddingBuffer = new Float32Array(queryEmbedding);
  const results = [];

  // Search facts_vec
  try {
    const fetchLimit = (modelId || conversationId) ? limit * 3 : limit;
    const factRows = db.prepare(
      `SELECT fact_id, distance FROM facts_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'fact', modelId);
    let count = 0;

    for (const row of factRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.fact_id)) continue;
      const fact = db.prepare(
        `SELECT f.id, f.content, f.confidence, f.tags, f.category, f.conversation_id, m.display_name as member
         FROM facts f
         LEFT JOIN members m ON f.source_member_id = m.id
         WHERE f.id = ? AND f.superseded_by IS NULL AND (f.valid_until IS NULL OR f.valid_until >= datetime('now'))`
      ).get(row.fact_id);
      if (fact && (!conversationId || fact.conversation_id === conversationId)) {
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
        count++;
      }
    }
  } catch (_) {
    // facts_vec table may not exist yet
  }

  // Search topics_vec
  try {
    const fetchLimit = (modelId || conversationId) ? limit * 3 : limit;
    const topicRows = db.prepare(
      `SELECT topic_id, distance FROM topics_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'topic', modelId);
    let count = 0;

    for (const row of topicRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.topic_id)) continue;
      const topic = db.prepare(
        `SELECT id, name, summary, tags, participants, conversation_id FROM topics WHERE id = ? AND superseded_by IS NULL`
      ).get(row.topic_id);
      if (topic && (!conversationId || topic.conversation_id === conversationId)) {
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
        count++;
      }
    }
  } catch (_) {
    // topics_vec table may not exist yet
  }

  // Search members_vec (no conversation_id filter — members span conversations)
  try {
    const fetchLimit = modelId ? limit * 3 : limit;
    const memberRows = db.prepare(
      `SELECT member_id, distance FROM members_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'member', modelId);
    let count = 0;

    for (const row of memberRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.member_id)) continue;
      const member = db.prepare(
        `SELECT id, display_name, username, expertise, projects FROM members WHERE id = ? AND superseded_by IS NULL`
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
        count++;
      }
    }
  } catch (_) {
    // members_vec table may not exist yet
  }

  // Search decisions_vec
  try {
    const fetchLimit = (modelId || conversationId) ? limit * 3 : limit;
    const decisionRows = db.prepare(
      `SELECT decision_id, distance FROM decisions_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'decision', modelId);
    let count = 0;

    for (const row of decisionRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.decision_id)) continue;
      const decision = db.prepare(
        `SELECT id, description, context, participants, status, tags, conversation_id FROM decisions WHERE id = ? AND superseded_by IS NULL`
      ).get(row.decision_id);
      if (decision && (!conversationId || decision.conversation_id === conversationId)) {
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
        count++;
      }
    }
  } catch (_) {
    // decisions_vec table may not exist yet
  }

  // Search tasks_vec
  try {
    const fetchLimit = (modelId || conversationId) ? limit * 3 : limit;
    const taskRows = db.prepare(
      `SELECT task_id, distance FROM tasks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'task', modelId);
    let count = 0;

    for (const row of taskRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.task_id)) continue;
      const task = db.prepare(
        `SELECT t.id, t.description, t.assignee, t.status, t.tags, t.conversation_id, m.display_name as member
         FROM tasks t LEFT JOIN members m ON t.source_member_id = m.id WHERE t.id = ? AND t.superseded_by IS NULL`
      ).get(row.task_id);
      if (task && (!conversationId || task.conversation_id === conversationId)) {
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
        count++;
      }
    }
  } catch (_) {
    // tasks_vec table may not exist yet
  }

  // Search questions_vec
  try {
    const fetchLimit = (modelId || conversationId) ? limit * 3 : limit;
    const questionRows = db.prepare(
      `SELECT question_id, distance FROM questions_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'question', modelId);
    let count = 0;

    for (const row of questionRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.question_id)) continue;
      const question = db.prepare(
        `SELECT id, question, asker, answer, answered_by, status, tags, conversation_id FROM questions WHERE id = ? AND superseded_by IS NULL`
      ).get(row.question_id);
      if (question && (!conversationId || question.conversation_id === conversationId)) {
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
        count++;
      }
    }
  } catch (_) {
    // questions_vec table may not exist yet
  }

  // Search events_vec
  try {
    const fetchLimit = (modelId || conversationId) ? limit * 3 : limit;
    const eventRows = db.prepare(
      `SELECT event_id, distance FROM events_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(embeddingBuffer, fetchLimit);
    const modelFilter = buildModelFilter(db, 'event', modelId);
    let count = 0;

    for (const row of eventRows) {
      if (count >= limit) break;
      if (modelFilter && !modelFilter.has(row.event_id)) continue;
      const event = db.prepare(
        `SELECT id, name, description, event_date, location, attendees, tags, conversation_id FROM events WHERE id = ? AND superseded_by IS NULL`
      ).get(row.event_id);
      if (event && (!conversationId || event.conversation_id === conversationId)) {
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
        count++;
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
  const { limit = 10, ftsOnly = false, embeddingConfig = null, conversationId = null, scoring = {} } = options;
  const ftsLimit = limit * 2;
  const ftsOpts = { scoring };

  const ftsResults = ftsSearch(driver, query, ftsLimit, conversationId, ftsOpts);

  const canDoVec = !ftsOnly && driver.capabilities.vectors && embeddingConfig;

  if (canDoVec) {
    try {
      const embeddings = require('./embeddings');
      const { embeddings: vecs } = await embeddings.embedWithRetry([query], embeddingConfig);
      const queryVector = vecs[0];
      const vecResults = vecSearch(driver, queryVector, ftsLimit, embeddingConfig.model, conversationId);
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

  // FTS-only path: use intent-based scores from ftsSearch
  const results = ftsResults.slice(0, limit).map((item) => {
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

  return { mode: 'fts5', results };
}

module.exports = { search, mergeRRF, ftsSearch, vecSearch, DEFAULT_SCORING };
