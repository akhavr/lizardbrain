/**
 * profiles.js — Profile definitions, entity metadata, and prompt fragments.
 * Profiles control what entities are extracted and how member fields are interpreted.
 */

const ALL_ENTITIES = ['members', 'facts', 'topics', 'decisions', 'tasks', 'questions', 'events'];

const PROFILES = {
  knowledge: {
    description: 'community, interest group',
    entities: ['members', 'facts', 'topics'],
    factCategories: ['tool', 'technique', 'opinion', 'experience', 'resource', 'announcement'],
    memberLabels: {
      expertise: 'skills/knowledge areas',
      projects: 'tools they build/use',
      rosterExpertise: 'expertise',
      rosterProjects: 'builds',
    },
  },
  team: {
    description: 'team, workplace',
    entities: ['members', 'facts', 'topics', 'decisions', 'tasks'],
    factCategories: ['process', 'technical', 'status', 'policy', 'opinion', 'resource'],
    memberLabels: {
      expertise: 'role/position',
      projects: 'current responsibilities or projects',
      rosterExpertise: 'role',
      rosterProjects: 'works on',
    },
  },
  project: {
    description: 'client, project group',
    entities: ['members', 'facts', 'decisions', 'tasks', 'questions'],
    factCategories: ['requirement', 'constraint', 'preference', 'feedback', 'resource', 'update'],
    memberLabels: {
      expertise: 'company and role',
      projects: 'scope of work',
      rosterExpertise: 'role',
      rosterProjects: 'scope',
    },
  },
  full: {
    description: 'everything (all entity types)',
    entities: ALL_ENTITIES.slice(),
    factCategories: ['tool', 'technique', 'opinion', 'experience', 'resource', 'announcement',
      'process', 'requirement', 'update'],
    memberLabels: {
      expertise: 'skills, role, or background',
      projects: 'projects, responsibilities, or scope',
      rosterExpertise: 'expertise',
      rosterProjects: 'builds',
    },
  },
};

const PROFILE_NAMES = Object.keys(PROFILES);

const ENTITY_DEFS = {
  members: {
    ftsColumns: ['username', 'display_name', 'expertise', 'projects'],
    embeddingText: (row) => `${row.display_name} -- ${row.expertise} | ${row.projects}`,
    promptFragment: (labels) => `  "members": [
    {
      "username": "string or null",
      "display_name": "string",
      "expertise": "comma-separated ${labels.expertise} demonstrated",
      "projects": "comma-separated ${labels.projects}"
    }
  ]`,
    rules: (labels) => `Member rules:
- "expertise": only list ${labels.expertise} where the person shows SUBSTANTIVE knowledge, not casual mentions
- "projects": only list ${labels.projects} a person ACTIVELY participates in. Casual mentions don't count
- Only include members who shared genuine expertise or project info`,
  },

  facts: {
    ftsColumns: ['content', 'tags', 'category'],
    embeddingText: (row) => row.content,
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
  },

  topics: {
    ftsColumns: ['name', 'summary', 'participants', 'tags'],
    embeddingText: (row) => `${row.name}: ${row.summary}`,
    promptFragment: () => `  "topics": [
    {
      "name": "short topic title",
      "summary": "1-2 sentence summary of the discussion",
      "participants": "comma-separated display_names",
      "tags": "comma-separated relevant tags"
    }
  ]`,
    rules: () => `Topic rules:
- Only create topics for substantial discussions, not single messages
- Participants should be display_names of people who actively contributed`,
  },

  decisions: {
    ftsColumns: ['description', 'context', 'participants', 'tags'],
    embeddingText: (row) => `${row.description}. Context: ${row.context || ''}`,
    promptFragment: () => `  "decisions": [
    {
      "description": "what was decided, 1-2 sentences",
      "participants": "comma-separated display_names involved",
      "context": "why this decision was made, brief",
      "status": "one of: proposed, agreed, revisited",
      "tags": "comma-separated relevant tags"
    }
  ]`,
    rules: () => `Decision rules:
- Only extract explicit decisions, not casual suggestions
- "proposed" = someone suggested it; "agreed" = group consensus or authority confirmed; "revisited" = previously decided, now being reconsidered
- Include who participated in the decision`,
  },

  tasks: {
    ftsColumns: ['description', 'assignee', 'tags'],
    embeddingText: (row) => `${row.description} -- assigned to ${row.assignee || 'unassigned'}`,
    promptFragment: () => `  "tasks": [
    {
      "description": "what needs to be done, 1-2 sentences",
      "assignee": "display_name of person assigned, or null",
      "deadline": "ISO date string if mentioned, or null",
      "status": "one of: open, done, blocked",
      "source_member": "display_name of who created/mentioned the task",
      "tags": "comma-separated relevant tags"
    }
  ]`,
    rules: () => `Task rules:
- Only extract concrete action items, not vague intentions
- "open" = needs to be done; "done" = explicitly completed; "blocked" = waiting on something
- Capture assignee and deadline only when explicitly stated`,
  },

  questions: {
    ftsColumns: ['question', 'answer', 'asker', 'tags'],
    embeddingText: (row) => `${row.question}${row.answer ? ' -> ' + row.answer : ''}`,
    promptFragment: () => `  "questions": [
    {
      "question": "the question asked",
      "asker": "display_name of who asked",
      "answer": "the answer given, or null if unanswered",
      "answered_by": "display_name of who answered, or null",
      "status": "one of: open, answered",
      "tags": "comma-separated relevant tags"
    }
  ]`,
    rules: () => `Question rules:
- Only extract substantive questions, not rhetorical or greeting questions
- Include the answer if one was given in the same batch of messages
- "open" = no answer yet; "answered" = answer was provided`,
  },

  events: {
    ftsColumns: ['name', 'description', 'attendees', 'tags'],
    embeddingText: (row) => `${row.name}: ${row.description || ''}`,
    promptFragment: () => `  "events": [
    {
      "name": "event name or title",
      "description": "what the event is about, 1-2 sentences",
      "event_date": "ISO date string if mentioned, or null",
      "location": "location or URL if mentioned, or null",
      "attendees": "comma-separated display_names planning to attend",
      "tags": "comma-separated relevant tags"
    }
  ]`,
    rules: () => `Event rules:
- Only extract events with a specific name or date, not vague future plans
- Include location/URL and date when mentioned`,
  },
};

function getProfile(name) {
  if (name === 'custom') {
    return { ...PROFILES.full, entities: [...PROFILES.full.entities], description: 'custom entity selection' };
  }
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(`Unknown profile "${name}". Valid profiles: ${PROFILE_NAMES.join(', ')}, custom`);
  }
  return { ...profile, entities: [...profile.entities], factCategories: [...profile.factCategories] };
}

function getEntityDef(name) {
  const def = ENTITY_DEFS[name];
  if (!def) {
    throw new Error(`Unknown entity type "${name}". Valid types: ${ALL_ENTITIES.join(', ')}`);
  }
  return def;
}

function buildCustomProfile(entities) {
  const invalid = entities.filter(e => !ENTITY_DEFS[e]);
  if (invalid.length) {
    throw new Error(`Unknown entity types: ${invalid.join(', ')}. Valid: ${ALL_ENTITIES.join(', ')}`);
  }
  return {
    description: 'custom entity selection',
    entities: entities.slice(),
    factCategories: PROFILES.full.factCategories,
    memberLabels: PROFILES.full.memberLabels,
  };
}

module.exports = {
  PROFILES,
  PROFILE_NAMES,
  ALL_ENTITIES,
  ENTITY_DEFS,
  getProfile,
  getEntityDef,
  buildCustomProfile,
};
