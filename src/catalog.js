// Reads CLIProxyAPI's plain OpenAI-style `GET /models` listing. The listing
// only states what CPA knows about a model and omits the rest, unlike the
// Codex client catalog, which fills undeclared capabilities from a template.

const CANONICAL_REASONING_LEVELS = new Set([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

// CPA's level -> thinking-budget conversion for budget-only models
// (internal/thinking/convert.go), in ascending order.
const BUDGET_LEVELS = [
  ['minimal', 512],
  ['low', 1024],
  ['medium', 8192],
  ['high', 24576],
  ['xhigh', 32768],
  ['max', 128000],
]

function positiveInteger(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
}

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
}

function lowerStrings(values) {
  if (!Array.isArray(values)) return undefined
  return values.map((value) => nonEmptyString(value)?.toLowerCase()).filter(Boolean)
}

function normalizeReasoningLevel(value) {
  const wire = nonEmptyString(value)?.toLowerCase()
  if (!wire) return undefined
  if (wire === 'none' || wire === 'off') return { canonical: 'off', wire: 'none' }
  if (wire === 'ultra') return { canonical: 'max', wire }
  if (!CANONICAL_REASONING_LEVELS.has(wire)) return undefined
  return { canonical: wire, wire }
}

/**
 * Levels a budget-only model can tell apart. CPA converts a level to its
 * budget and clamps it into [min, max], so a level below `min` collapses onto
 * `min`, while the first level above `max` still selects `max` itself.
 */
function budgetLevelsOf(budget) {
  const min = Number.isFinite(budget?.min) ? Math.max(0, budget.min) : 0
  const max = Number.isFinite(budget?.max) ? budget.max : 0
  if (max <= 0) return []
  const levels = []
  let highest = 0
  for (const [level, tokens] of BUDGET_LEVELS) {
    if (tokens < min) continue
    if (tokens <= max) {
      levels.push(level)
      highest = tokens
    } else {
      if (highest < max) levels.push(level)
      break
    }
  }
  return levels
}

/**
 * Map a listing entry's `reasoning` object onto llm-pi-ai reasoning efforts.
 * @returns `undefined` when reasoning is unknown or unsupported, otherwise a
 *   canonical-level to wire-value map.
 */
export function reasoningEffortsOf(entry) {
  const reasoning = entry?.reasoning
  if (!reasoning || typeof reasoning !== 'object' || reasoning.supported !== true) return undefined
  const efforts = {}
  if (Array.isArray(reasoning.levels)) {
    for (const raw of reasoning.levels) {
      const normalized = normalizeReasoningLevel(raw)
      if (normalized && !(normalized.canonical in efforts)) efforts[normalized.canonical] = normalized.wire
    }
  } else if (reasoning.budget && typeof reasoning.budget === 'object') {
    if (reasoning.budget.zero_allowed === true) efforts.off = 'none'
    for (const level of budgetLevelsOf(reasoning.budget)) efforts[level] = level
  }
  // llm-pi-ai rejects a capability map that offers only "off". Omitting the
  // field correctly describes a non-reasoning model for a hand-declared route.
  if (Object.keys(efforts).every((level) => level === 'off')) return undefined
  return efforts
}

function inputModalitiesOf(entry, fallback) {
  const declared = lowerStrings(entry?.architecture?.input_modalities)
  const modalities = [...new Set(declared?.filter((value) => value === 'text' || value === 'image'))]
  return modalities.length ? modalities : [...fallback]
}

/** Whether the entry declares outputs and none of them is text a chat can use. */
function isNonChatModel(entry) {
  const outputs = lowerStrings(entry?.architecture?.output_modalities)
  return outputs !== undefined && outputs.length > 0 && !outputs.includes('text')
}

export function modelProfileOf(entry, options = {}) {
  const id = nonEmptyString(entry?.id)
  if (!id || isNonChatModel(entry)) return undefined
  const reasoningEfforts = reasoningEffortsOf(entry)
  return {
    id,
    name: nonEmptyString(entry?.name, id),
    contextWindow: positiveInteger(entry?.context_length, options.defaultContextWindow),
    maxTokens: positiveInteger(entry?.top_provider?.max_completion_tokens, options.defaultMaxTokens),
    input: inputModalitiesOf(entry, options.defaultInput ?? ['text']),
    ...(reasoningEfforts ? { reasoningEfforts } : {}),
  }
}

export function readModelListing(body, options = {}) {
  if (!body || !Array.isArray(body.data)) throw new TypeError('CLIProxyAPI model listing has no "data" array')
  const models = []
  const seen = new Set()
  for (const entry of body.data) {
    const model = modelProfileOf(entry, options)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  if (!models.length) throw new TypeError('CLIProxyAPI model listing contains no usable chat models')
  return models
}

export function catalogURL(baseURL) {
  const base = String(baseURL ?? '').trim().replace(/\/+$/, '')
  if (!base) throw new TypeError('CLIProxyAPI baseURL must not be empty')
  return base + '/models'
}
