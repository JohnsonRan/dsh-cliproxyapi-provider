import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogURL, modelProfileOf, readModelListing, reasoningEffortsOf } from '../src/catalog.js'

const defaults = { defaultContextWindow: 262144, defaultMaxTokens: 32768, defaultInput: ['text'] }

test('maps declared reasoning levels to Harness canonical levels', () => {
  assert.deepEqual(reasoningEffortsOf({ reasoning: {
    supported: true, levels: ['none', 'minimal', 'auto', 'high', 'ultra'],
  } }), { off: 'none', minimal: 'minimal', high: 'high', max: 'ultra' })
})

test('unknown, unsupported and off-only reasoning yield no capability', () => {
  assert.equal(reasoningEffortsOf({}), undefined)
  assert.equal(reasoningEffortsOf({ reasoning: { supported: false } }), undefined)
  assert.equal(reasoningEffortsOf({ reasoning: { supported: true, levels: ['none', 'auto'] } }), undefined)
})

test('derives levels CPA can tell apart from a budget-only declaration', () => {
  // gemini-2.5-pro: 128..32768, dynamic, no zero budget.
  assert.deepEqual(reasoningEffortsOf({ reasoning: {
    supported: true, budget: { min: 128, max: 32768, zero_allowed: false, dynamic_allowed: true },
  } }), { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' })
  // A ceiling between two levels keeps the next level, which clamps to it.
  assert.deepEqual(reasoningEffortsOf({ reasoning: {
    supported: true, budget: { min: 1024, max: 64000, zero_allowed: true, dynamic_allowed: false },
  } }), { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
})

test('maps a fully declared listing entry', () => {
  assert.deepEqual(modelProfileOf({
    id: 'gpt-5.5',
    object: 'model',
    name: 'GPT 5.5',
    context_length: 400000,
    top_provider: { max_completion_tokens: 128000 },
    architecture: {
      input_modalities: ['text', 'image', 'audio'],
      output_modalities: ['text'],
      modality: 'text+image+audio->text',
    },
    reasoning: { supported: true, levels: ['none', 'low', 'medium', 'high', 'xhigh'] },
  }, defaults), {
    id: 'gpt-5.5',
    name: 'GPT 5.5',
    contextWindow: 400000,
    maxTokens: 128000,
    input: ['text', 'image'],
    reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
  })
})

test('an undeclared entry uses the configured fallbacks and claims no reasoning', () => {
  assert.deepEqual(modelProfileOf({ id: 'my-compat-model', object: 'model' }, defaults), {
    id: 'my-compat-model',
    name: 'my-compat-model',
    contextWindow: 262144,
    maxTokens: 32768,
    input: ['text'],
  })
})

test('skips models whose declared outputs are not text, and deduplicates ids', () => {
  const models = readModelListing({ data: [
    { id: 'chat', architecture: { output_modalities: ['text'] } },
    { id: 'chat', context_length: 2000 },
    { id: 'unknown' },
    { id: 'text-embedding-3-large', architecture: { output_modalities: ['embeddings'] } },
    { id: 'reranker', architecture: { output_modalities: ['RERANK'] } },
    { id: 'jev', architecture: { output_modalities: ['decisions'] } },
    { id: 'gpt-image-2', architecture: { output_modalities: ['image'] } },
    { id: 'image-and-text', architecture: { output_modalities: ['text', 'image'] } },
  ] }, defaults)
  assert.deepEqual(models.map((model) => model.id), ['chat', 'unknown', 'image-and-text'])
})

test('builds the plain model listing URL', () => {
  assert.equal(catalogURL('http://127.0.0.1:8317/v1/'), 'http://127.0.0.1:8317/v1/models')
})

test('rejects malformed and empty listings', () => {
  assert.throws(() => readModelListing({ models: [] }), /no "data" array/)
  assert.throws(() => readModelListing({ data: [] }), /no usable chat models/)
  assert.throws(() => readModelListing({ data: [
    { id: 'embed', architecture: { output_modalities: ['embeddings'] } },
  ] }), /no usable chat models/)
})
