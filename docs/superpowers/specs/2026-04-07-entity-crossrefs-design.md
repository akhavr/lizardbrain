# Entity Cross-References — Design Spec

## Overview

Add a knowledge graph layer to Lizardbrain via directed, typed links between entities. The LLM creates links during extraction (both within the same batch and to existing entities from context injection), and MCP provides tools for manual link management. Inspired by MemPalace's "tunnels" concept.

## Decisions

- **Use case:** Knowledge graph traversal — "show me all tasks related to this decision"
- **Who creates links:** LLM during extraction + manual via MCP
- **Relation types:** Fixed set — `implements`, `supports`, `relates`, `blocks`, `answers`
- **Direction:** Directional (from → to)
- **Linking scope:** Both same-batch and new-to-existing (via context injection)
- **Approach:** Dedicated `entity_links` junction table

## 1. Schema

New `entity_links` table:

```sql
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

Valid `from_type`/`to_type`: `fact`, `topic`, `decision`, `task`, `question`, `event`, `member` (singular form, matching search result conventions).

Valid `relation`: `implements`, `supports`, `relates`, `blocks`, `answers`.

Schema version bumps to `1.0`.

## 2. Store — Link CRUD

New functions in `store.js`:

- `addLink(driver, fromType, fromId, toType, toId, relation)` — validates types and relation, inserts into `entity_links`. Returns the link ID or `false` if invalid/duplicate.
- `removeLink(driver, linkId)` — deletes by ID. Returns `true`/`false`.
- `getLinks(driver, entityType, entityId, { direction })` — returns all links for an entity. `direction: 'from'` = links where entity is source, `'to'` = where entity is target, `'both'` (default) = all.

Constants:
```javascript
const VALID_LINK_TYPES = ['fact', 'topic', 'decision', 'task', 'question', 'event', 'member'];
const VALID_RELATIONS = ['implements', 'supports', 'relates', 'blocks', 'answers'];
```

## 3. LLM — Links in Extraction Output

Add a `links` array to the extraction schema:

```json
{
  "members": [...],
  "facts": [...],
  "links": [
    { "from": "decision:3", "to": "task:new:0", "relation": "implements" },
    { "from": "fact:new:1", "to": "decision:5", "relation": "supports" }
  ]
}
```

Referencing convention:
- Existing entities (from context): `"type:id"` e.g. `"decision:3"`
- New entities (same batch): `"type:new:index"` e.g. `"task:new:0"` (index in the extracted array)

Zod schema: `z.object({ from: z.string(), to: z.string(), relation: z.enum(['implements', 'supports', 'relates', 'blocks', 'answers']) })`

The `links` section is added to the prompt and schema when `context.enabled` is true OR when multiple entity types are being extracted (same-batch linking).

Prompt rules:
```
Link rules:
- Reference existing entities by type:id (e.g. "decision:3")
- Reference new entities from this batch by type:new:index (e.g. "task:new:0")
- Only create links when there is a clear, explicit relationship
- Do not link entities that are merely mentioned in the same message
```

## 4. Pipeline — Resolving and Storing Links

In `processExtraction()`, after all entities are inserted (and IDs are in `insertedIds`), process the `links` array:

1. Parse each link's `from` and `to` references
2. Resolve `type:new:index` → actual ID via `insertedIds` (e.g. `task:new:0` → `insertedIds.tasks[0]`)
3. Resolve `type:id` → use the ID directly
4. Call `addLink()` for each valid, resolved link
5. Return `totalLinks` count in the result

Entity type mapping for resolution: `tasks` → `task`, `facts` → `fact`, etc. (plural insertedIds key → singular link type).

## 5. MCP Tools

Two new tools in `mcp.js`:

- `add_link` — `{ from_type, from_id, to_type, to_id, relation }` → calls `store.addLink()`
- `get_links` — `{ entity_type, entity_id, direction? }` → calls `store.getLinks()`

## 6. Testing

Unit tests:
- `addLink` creates a link, returns ID
- `addLink` rejects invalid type or relation
- `addLink` rejects duplicate links
- `getLinks` returns links in both directions
- `getLinks` with direction filter
- `removeLink` deletes a link
- Link reference resolution: `type:new:index` maps to correct inserted ID
- Link reference resolution: `type:id` passes through
- Links section in extraction schema validates
- Prompt includes link rules when context enabled
- MCP `add_link` and `get_links` handlers work

## 7. Files Changed

- `src/schema.js` — `entity_links` table, indexes, v1.0 migration
- `src/store.js` — `addLink()`, `removeLink()`, `getLinks()`, link resolution in `processExtraction()`
- `src/llm.js` — link schema, `buildExtractionSchema()` includes links conditionally
- `src/mcp.js` — `add_link`, `get_links` tools
- `test/run.js` — new test cases
