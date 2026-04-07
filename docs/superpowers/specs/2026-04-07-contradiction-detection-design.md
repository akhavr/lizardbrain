# Contradiction Detection — Design Spec

## Overview

Detect when newly extracted entities contradict existing knowledge and mark the old entities as superseded. Inspired by MemPalace's contradiction detection, adapted to Lizardbrain's architecture.

## Decisions

- **Scope:** All 7 entity types (facts, topics, decisions, tasks, questions, events, members)
- **Action on contradiction:** Flag both — old entity gets `superseded_by` pointing to the new entity's ID. Both are preserved for history.
- **Candidate finding:** Hybrid — kNN vectors when available, FTS fallback on core tier
- **LLM judgment:** Separate API call (not integrated into extraction prompt)
- **Activation:** Opt-in via `contradiction.enabled` in config
- **Pipeline position:** Post-insertion (same pattern as semantic dedup)

## 1. Schema Changes

Add `superseded_by INTEGER` column to all 7 entity tables: `facts`, `topics`, `decisions`, `tasks`, `questions`, `events`, `members`.

Schema version bumps to `0.8`. Migration is idempotent (`ALTER TABLE ... ADD COLUMN` with try/catch), same pattern as v0.5-v0.7 migrations.

Search queries add `WHERE superseded_by IS NULL` by default. An `includeSuperseded` flag allows callers to see superseded entities when needed.

## 2. Candidate Finding

New function `findContradictionCandidates(driver, entityType, content, config)` in `store.js`.

Hybrid strategy:
- **Vectors available:** kNN search on the entity's vec0 table (e.g. `facts_vec`), return top N nearest neighbors (default 5, configurable via `maxCandidates`)
- **FTS fallback:** Extract 2-3 keywords via existing `extractKeywords()`, search the entity's FTS table, return top N matches
- **Filter:** Exclude entities already superseded (`superseded_by IS NULL`), exclude the entity itself

Returns `{ id, content }[]` — candidates for LLM judgment.

Content field varies by entity type:
- facts: `content`
- topics: `name` + `summary`
- decisions: `description` + `context`
- tasks: `description`
- questions: `question` + `answer`
- events: `name` + `description`
- members: `display_name` + `expertise` + `projects`

## 3. LLM Contradiction Judgment

New function `checkContradictions(newEntity, candidates, config)` in `llm.js`.

Prompt template:
```
Given NEW entities and EXISTING entities of the same type, identify which existing
entities are contradicted/superseded by a new one.

NEW ENTITIES:
  [new:1] {content}
  [new:2] {content}

EXISTING ENTITIES:
  [id:3] {content}
  [id:7] {content}
  [id:12] {content}

Return JSON: { "contradictions": [{ "new_index": 1, "superseded_ids": [3] }] }
Only include entries where a new entity genuinely contradicts or replaces an old one.
Do NOT flag entities that are merely related or complementary.
```

Zod schema: `z.object({ contradictions: z.array(z.object({ new_index: z.number(), superseded_ids: z.array(z.number()) })) })`

Uses the same LLM provider/model as extraction (`config.llm`). Temperature 0.1. Low `maxTokens` (256).

Error handling: if the call fails, log a warning and skip — non-fatal.

## 4. Pipeline Integration

In `extractor.js`, after the semantic dedup block (~line 194), add a contradiction detection block:

```javascript
if (config.contradiction?.enabled) {
  try {
    // For each entity type with insertions this batch:
    //   1. findContradictionCandidates()
    //   2. checkContradictions() via LLM
    //   3. markSuperseded() — SET superseded_by = newId
    // Log count
  } catch (err) {
    log(`Contradiction check failed (non-fatal): ${err.message}`);
  }
}
```

Batching: one LLM call per entity type per batch. Each call sends all new entities of that type alongside their respective candidates. If a batch produces 5 new facts and 2 new decisions, that's 2 LLM calls — one for facts (5 new + their candidates), one for decisions (2 new + their candidates). The prompt and schema handle multiple new entities per call.

`processExtraction` needs to return inserted IDs for all entity types. Currently only returns `insertedFactIds`. Extend to `insertedIds: { facts: [...], topics: [...], decisions: [...], tasks: [...], questions: [...], events: [...] }`.

Add `totalSuperseded` to extraction summary and `extraction_state` table.

## 5. Config

Config in `lizardbrain.json`:
```json
{
  "contradiction": {
    "enabled": true,
    "maxCandidates": 5
  }
}
```

Opt-in, off by default. `maxCandidates` controls how many existing entities to compare against (default 5).

## 6. CLI and Search

CLI extraction output includes superseded count:
```
Extracted: 3 members, 5 facts, 2 topics, 1 superseded
```

`npm run stats` shows total superseded count.

All search functions in `store.js` filter `WHERE superseded_by IS NULL` by default.

MCP tools (`search`, `get_context`) automatically exclude superseded entities. Context injection (`getActiveContext`) also excludes them.

## 7. Testing

Unit tests:
- `findContradictionCandidates` returns FTS matches when vectors unavailable
- `findContradictionCandidates` excludes already-superseded entities
- `markSuperseded` sets `superseded_by` on the correct entity
- Search functions exclude superseded entities by default
- Search functions include superseded entities when `includeSuperseded: true`
- `getActiveContext` excludes superseded entities
- Contradiction detection skipped when `contradiction.enabled` is false/absent

Integration tests:
- Full pipeline: insert "uses Postgres", then "migrated to MySQL" — old fact gets `superseded_by` set
- Non-contradiction: two related but non-contradictory facts — neither gets superseded
- Graceful failure: LLM call fails — entities remain unflagged, extraction completes
- Works across all entity types (at least facts + one other)

## Files Changed

- `src/schema.js` — `superseded_by` columns, v0.8 migration
- `src/store.js` — `findContradictionCandidates()`, `markSuperseded()`, search filters, extended `processExtraction` return
- `src/llm.js` — `checkContradictions()`
- `src/extractor.js` — post-insertion contradiction block
- `src/mcp.js` — search/context exclude superseded (via store changes)
- `test/run.js` — new test cases
