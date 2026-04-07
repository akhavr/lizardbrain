# Temporal Validity Windows — Design Spec

## Overview

Add LLM-assigned durability to facts so ephemeral knowledge (sprint blockers, current priorities) expires naturally while durable knowledge (tech stack, architecture) persists indefinitely. Expired facts are hard-filtered from search and context, same as superseded entities.

## Decisions

- **Scope:** Facts only (other entity types have lifecycle management via status fields)
- **Classification:** LLM assigns a `durability` enum during extraction
- **Durability levels:** `ephemeral` (7d), `short` (30d), `medium` (90d), `durable` (no expiration)
- **Default:** `durable` when LLM doesn't return a value (backward-compatible)
- **Expiration behavior:** Hard filter (same pattern as `superseded_by IS NULL`)
- **Mappings:** Hardcoded, not configurable
- **Approach:** Schema column + LLM prompt extension (no separate LLM call)

## 1. Schema Changes

Add `valid_until TEXT` column to the `facts` table. Schema version bumps to `0.9`.

Existing facts get `valid_until = NULL`, meaning "durable" (never expires). No backfill needed.

Migration is idempotent (`ALTER TABLE ... ADD COLUMN` with try/catch), same pattern as v0.7-v0.8.

Durability-to-days mapping (hardcoded):
- `ephemeral` → 7 days
- `short` → 30 days
- `medium` → 90 days
- `durable` / `null` → no expiration (`valid_until` stays NULL)

## 2. LLM Prompt Extension

Add `durability` field to the fact JSON structure in the extraction prompt:
```json
{
  "category": "tool",
  "content": "...",
  "source_member": "...",
  "tags": "...",
  "confidence": 0.9,
  "durability": "durable"
}
```

Add to the fact rules in the prompt:
```
Durability: how long this fact stays relevant.
- "ephemeral": temporary states, current blockers, this-week items (valid ~1 week)
- "short": sprint goals, short-term plans (valid ~1 month)
- "medium": quarterly goals, project phases (valid ~3 months)
- "durable": tech stack, expertise, architecture, permanent knowledge (no expiration)
- Default to "durable" if unsure
```

Add `durability` to the Zod fact schema: `z.enum(['ephemeral', 'short', 'medium', 'durable']).nullable()`.

The durability field is added to the fact prompt fragment in `src/profiles.js` (where `ENTITY_DEFS.facts.promptFragment` is defined) so it's included in all profiles that extract facts.

## 3. Store Changes

`insertFact()` gains a `durability` param from the extracted fact object. It maps durability to days and computes `valid_until` as `datetime(messageDate, '+N days')` in the INSERT SQL. When durability is `durable` or absent, `valid_until` is NULL.

Durability mapping constant:
```javascript
const DURABILITY_DAYS = { ephemeral: 7, short: 30, medium: 90 };
```

Search and context queries filter expired facts using `AND (valid_until IS NULL OR valid_until >= datetime('now'))`. This applies to:
- `searchFacts()` in `store.js`
- `getActiveContext()` facts query in `store.js`
- `ftsSearch()` facts query in `search.js`
- `vecSearch()` facts lookup in `search.js`
- `findContradictionCandidates()` for facts — expired facts shouldn't be contradiction candidates

## 4. Testing

Unit tests:
- `insertFact` with `durability: 'ephemeral'` sets `valid_until` 7 days from message date
- `insertFact` with `durability: 'durable'` or `null` leaves `valid_until` as NULL
- `searchFacts` excludes expired facts (insert with past `valid_until`, verify not returned)
- `searchFacts` includes non-expired facts
- `getActiveContext` excludes expired facts
- Zod schema accepts `durability` field
- Backward compat: facts without `durability` field still insert fine (`valid_until = NULL`)

No integration tests requiring LLM calls.

## 5. Files Changed

- `src/schema.js` — `valid_until` column on facts, v0.9 migration
- `src/store.js` — `insertFact()` computes `valid_until`, search/context filters, `DURABILITY_DAYS` constant
- `src/llm.js` — `durability` in Zod fact schema
- `src/profiles.js` — fact prompt fragment includes `durability` field and rules
- `src/search.js` — `ftsSearch()` and `vecSearch()` filter expired facts
- `test/run.js` — new test cases

No changes needed to `src/extractor.js` — durability flows through the existing extraction → `processExtraction()` → `insertFact()` path.
