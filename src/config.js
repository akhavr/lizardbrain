/**
 * config.js — Load lizardbrain configuration from file or env vars.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  memoryDbPath: './lizardbrain.db',
  batchSize: 40,
  minMessages: 5,
  batchOverlap: 0,
  rosterPath: null,
  context: {
    enabled: false,
    tokenBudget: 1000,
    recencyDays: 30,
    maxItems: { decisions: 5, tasks: 10, questions: 5, facts: 5, topics: 3 },
  },
  llm: {
    provider: null, // null = auto-detect, 'openai', 'anthropic'
    baseUrl: '',
    apiKey: '',
    model: '',
    promptTemplate: null,
  },
  source: {
    type: 'sqlite',
    // rest depends on adapter
  },
  embedding: {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    dimensions: null,
    batchTokenLimit: 8000,
  },
  dedup: {
    semantic: false,
    threshold: 0.15,
  },
  profile: null,
  entities: null,
  factCategories: null,
  sourceAgent: null,
  conversationType: null,
};

function loadEnv(dir) {
  const envPath = path.join(dir, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2];
      }
    }
  }
}

function load(configPath) {
  // Load .env from config directory
  if (configPath) {
    loadEnv(path.dirname(configPath));
  } else {
    loadEnv(process.cwd());
  }

  let fileConfig = {};

  // Try loading config file
  if (configPath && fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw);
  } else {
    // Try default locations
    for (const name of ['lizardbrain.json', 'lizardbrain.config.json']) {
      const p = path.join(process.cwd(), name);
      if (fs.existsSync(p)) {
        fileConfig = JSON.parse(fs.readFileSync(p, 'utf-8'));
        break;
      }
    }
  }

  // Merge with priority: env vars > config file > defaults
  const config = {
    memoryDbPath: process.env.LIZARDBRAIN_DB_PATH || fileConfig.memoryDbPath || DEFAULTS.memoryDbPath,
    batchSize: parseInt(process.env.LIZARDBRAIN_BATCH_SIZE) || fileConfig.batchSize || DEFAULTS.batchSize,
    minMessages: parseInt(process.env.LIZARDBRAIN_MIN_MESSAGES) || fileConfig.minMessages || DEFAULTS.minMessages,
    batchOverlap: parseInt(process.env.LIZARDBRAIN_BATCH_OVERLAP) || fileConfig.batchOverlap || DEFAULTS.batchOverlap,
    rosterPath: process.env.LIZARDBRAIN_ROSTER_PATH || fileConfig.rosterPath || DEFAULTS.rosterPath,
    context: {
      enabled: fileConfig.context?.enabled ?? DEFAULTS.context.enabled,
      tokenBudget: fileConfig.context?.tokenBudget || DEFAULTS.context.tokenBudget,
      recencyDays: fileConfig.context?.recencyDays || DEFAULTS.context.recencyDays,
      maxItems: { ...DEFAULTS.context.maxItems, ...fileConfig.context?.maxItems },
    },
    profile: process.env.LIZARDBRAIN_PROFILE || fileConfig.profile || DEFAULTS.profile,
    entities: fileConfig.entities || DEFAULTS.entities,
    factCategories: fileConfig.factCategories || DEFAULTS.factCategories,
    sourceAgent: process.env.LIZARDBRAIN_SOURCE_AGENT || fileConfig.sourceAgent || DEFAULTS.sourceAgent,
    conversationType: process.env.LIZARDBRAIN_CONVERSATION_TYPE || fileConfig.conversationType || DEFAULTS.conversationType,
    llm: {
      provider: process.env.LIZARDBRAIN_LLM_PROVIDER || fileConfig.llm?.provider || DEFAULTS.llm.provider,
      baseUrl: process.env.LIZARDBRAIN_LLM_BASE_URL || process.env.LLM_BASE_URL || fileConfig.llm?.baseUrl || DEFAULTS.llm.baseUrl,
      apiKey: process.env.LIZARDBRAIN_LLM_API_KEY || process.env.LLM_API_KEY || fileConfig.llm?.apiKey || DEFAULTS.llm.apiKey,
      model: process.env.LIZARDBRAIN_LLM_MODEL || process.env.LLM_MODEL || fileConfig.llm?.model || DEFAULTS.llm.model,
      promptTemplate: fileConfig.llm?.promptTemplate || DEFAULTS.llm.promptTemplate,
    },
    source: fileConfig.source || DEFAULTS.source,
    embedding: {
      enabled: fileConfig.embedding?.enabled || false,
      baseUrl: process.env.LIZARDBRAIN_EMBEDDING_BASE_URL || fileConfig.embedding?.baseUrl || DEFAULTS.embedding.baseUrl,
      apiKey: process.env.LIZARDBRAIN_EMBEDDING_API_KEY || fileConfig.embedding?.apiKey || DEFAULTS.embedding.apiKey,
      model: process.env.LIZARDBRAIN_EMBEDDING_MODEL || fileConfig.embedding?.model || DEFAULTS.embedding.model,
      dimensions: fileConfig.embedding?.dimensions || DEFAULTS.embedding.dimensions,
      batchTokenLimit: parseInt(process.env.LIZARDBRAIN_EMBEDDING_BATCH_LIMIT) || fileConfig.embedding?.batchTokenLimit || DEFAULTS.embedding.batchTokenLimit,
    },
    dedup: {
      semantic: fileConfig.dedup?.semantic || DEFAULTS.dedup.semantic,
      threshold: fileConfig.dedup?.threshold || DEFAULTS.dedup.threshold,
    },
  };

  return config;
}

module.exports = { load, DEFAULTS };
