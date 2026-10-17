import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service, resolveConfig } from '@deepseek-ai/cordis'
import { deepEqual, updateVolatile, volatileEntries } from '@deepseek-ai/cosmokit'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  Config as PiAiConfig,
  apply as applyPiAi,
  inject as piAiInject,
  name as piAiName,
} from '@deepseek-ai/dsh-llm-pi-ai'
// 0.2 replaced the abstract `SettingsProvider` seam with `SettingsForms`, which
// projects the *config editor*'s active entries into per-entry descriptors.
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import {
  Config,
  PLACEHOLDER_AUTHORIZATION,
  PROFILE_SYNC_HEADER,
  apply,
  inject as pluginInject,
  llmPiAiNamespace,
} from '../src/index.js'

const PI_AI_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai'

async function resolvedConfig(overrides = {}) {
  const result = await Config['~standard'].validate(overrides)
  assert.equal(result.issues, undefined)
  return result.value
}

function managedProfile(overrides = {}) {
  return {
    displayName: 'CLIProxyAPI',
    api: 'openai-responses',
    baseURL: 'http://127.0.0.1:8317/v1',
    models: [{ id: 'old', name: 'old', contextWindow: 1000, maxTokens: 100, input: ['text'] }],
    defaultContextWindow: 262144,
    defaultMaxTokens: 32768,
    defaultInput: ['text'],
    headers: {},
    ...overrides,
  }
}

/**
 * Shape one unit-level fake of the 0.2 host seams. The settings namespace is the
 * *config editor entry id* rather than a fixed string, `settings.describe()`
 * answers with descriptors (not sections), and a write announces itself through
 * `settings/document-updated` — exactly what `SettingsForms.write()` does at the
 * end of every successful mutate.
 */
function createContext(initialSection, initialCredential, options = {}) {
  const entryId = options.entryId ?? 'llm-pi-ai'
  const entryName = options.entryName ?? PI_AI_ENTRY_NAME
  let section = initialSection
  let credential = initialCredential
  let revision = 0
  let conflicts = 0
  const discoveries = new Map()
  const listeners = new Map()
  const mutations = []
  const mutationNamespaces = []
  const warnings = []
  const effects = []
  const timeouts = []

  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) || []) listener(...args)
  }

  const ctx = {
    configEditor: {
      // `llmPiAiNamespace()` keys on the composition's own name, not the id.
      entries: () => [{ id: entryId, name: entryName, options: { id: entryId, name: entryName, config: {} } }],
      get documentPath() { return '/tmp/dsh-cliproxyapi-unit-profile.yml' },
    },
    llm: {
      registerModelDiscovery(ns, handler) {
        discoveries.set(String(ns), handler)
        return () => discoveries.delete(String(ns))
      },
      registerConfigurableProviders() {
        throw new Error('the plugin must not own the configurable-provider directory')
      },
    },
    settings: {
      describe() {
        return [{ ns: entryId, revision, applies: 'live', value: section }]
      },
      async mutate(ns, ops, expectedRevision) {
        if (expectedRevision !== undefined && expectedRevision !== revision) {
          conflicts += 1
          throw Object.assign(new Error('settings conflict'), { code: 'SETTINGS_CONFLICT' })
        }
        mutations.push(ops)
        mutationNamespaces.push(ns)
        const providers = { ...(section?.providers || {}) }
        for (const op of ops) {
          assert.equal(op.path[0], 'providers')
          if (op.op === 'set') providers[op.path[1]] = op.value
          else delete providers[op.path[1]]
        }
        section = { ...section, providers }
        revision += 1
        emit('settings/document-updated', ns, revision)
      },
    },
    credentials: {
      async resolve() {
        return credential === undefined ? undefined : { value: credential }
      },
    },
    on(event, listener) {
      const rows = listeners.get(event) || []
      rows.push(listener)
      listeners.set(event, rows)
      return () => listeners.set(event, rows.filter((row) => row !== listener))
    },
    effect(factory) {
      const cleanup = factory()
      const dispose = () => cleanup?.()
      effects.push(dispose)
      return dispose
    },
    timeout(callback, delay) {
      const row = { callback, delay, cancelled: false }
      timeouts.push(row)
      return () => { row.cancelled = true }
    },
    logger: {
      warn(message) {
        warnings.push(String(message))
      },
    },
  }

  return {
    ctx,
    discoveries,
    mutations,
    mutationNamespaces,
    warnings,
    timeouts,
    entryId,
    entryName,
    get section() { return section },
    get conflicts() { return conflicts },
    setSection(value) { section = value },
    setCredential(value) { credential = value },
    emit,
    /** Reproduce the `(ns, revision)` shape of `settings/document-updated`. */
    settingsDocumentUpdated(ns = entryId) {
      revision += 1
      emit('settings/document-updated', ns, revision)
    },
    dispose() {
      for (const effect of effects.reverse()) effect()
    },
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('registers rich discovery without competing for the provider directory', async () => {
  const harness = createContext({ providers: {} })
  apply(harness.ctx, await resolvedConfig())
  assert.deepEqual([...harness.discoveries.keys()], ['llm-cliproxyapi'])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(harness.mutations.length, 0)
  harness.dispose()
})

test('initial discovery requests the fixed rich catalog and returns full capabilities', async () => {
  const previousFetch = globalThis.fetch
  let requestURL
  globalThis.fetch = async (url) => {
    requestURL = String(url)
    return new Response(JSON.stringify({ object: 'list', data: [{
      id: 'gpt-5.6-sol',
      object: 'model',
      name: 'GPT 5.6 Sol',
      context_length: 372000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      reasoning: { supported: true, levels: ['low', 'high'] },
    }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    const models = await harness.discoveries.get('llm-cliproxyapi')({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      apiKey: 'secret-key',
    }, new AbortController().signal)
    assert.equal(
      requestURL,
      'http://127.0.0.1:8317/v1/models',
    )
    assert.deepEqual(models[0], {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 372000,
      maxTokens: 32768,
      input: ['text', 'image'],
      reasoningEfforts: { low: 'low', high: 'high' },
    })
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('discovery honors positional abort signal', async () => {
  const previousFetch = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = async (_url, options) => {
    if (options.signal?.aborted) throw options.signal.reason
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig({ fetchTimeoutMs: 5000 }))
    const discover = harness.discoveries.get('llm-cliproxyapi')
    const discoveryPromise = discover({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
    }, controller.signal)
    controller.abort(new Error('discovery canceled'))
    await assert.rejects(discoveryPromise, /discovery canceled/)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('first profile synchronization restores capabilities stripped by the browser RPC', async () => {
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ object: 'list', data: [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        context_length: 372000,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        reasoning: { supported: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      },
      {
        id: 'gpt-5.6-spark',
        name: 'GPT 5.6 Spark',
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      },
      {
        id: 'text-embedding-3-large',
        architecture: { output_modalities: ['embeddings'] },
        reasoning: { supported: false },
      },
    ] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const discovered = await harness.discoveries.get('llm-cliproxyapi')({
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
    }, new AbortController().signal)
    const bootstrapModels = discovered.map(({ id, name, contextWindow, maxTokens }) => ({
      id, name, contextWindow, maxTokens,
    }))
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({
        models: bootstrapModels,
        headers: {
          [PROFILE_SYNC_HEADER]: 'rich:test',
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    } })
    harness.settingsDocumentUpdated()

    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(fetches, 1)
    assert.equal(profile.headers[PROFILE_SYNC_HEADER], undefined)
    assert.deepEqual(profile.models[0], {
      id: 'gpt-5.6-sol',
      name: 'GPT 5.6 Sol',
      contextWindow: 372000,
      maxTokens: 32768,
      input: ['text', 'image'],
      reasoningEfforts: {
        low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
      },
      compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} },
    })
    assert.deepEqual(profile.models[1].input, ['text'])
    assert.deepEqual(profile.models.map((model) => model.id), ['gpt-5.6-sol', 'gpt-5.6-spark'])
    await waitFor(() => harness.timeouts.some((row) => row.delay === 300000))
    const periodic = harness.timeouts.find((row) => row.delay === 300000)
    periodic.callback()
    await waitFor(() => fetches === 2)
    await waitFor(() => harness.timeouts.filter((row) => row.delay === 300000).length === 2)
    assert.equal(harness.mutations.length, 1)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('credential refresh cannot finalize a pending bootstrap profile early', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
    id: 'vision-model',
    architecture: { input_modalities: ['text', 'image'] },
    reasoning: { supported: true, levels: ['high'] },
  }] }), { status: 200 })
  try {
    const harness = createContext({ providers: {} })
    apply(harness.ctx, await resolvedConfig())
    await new Promise((resolve) => setTimeout(resolve, 0))
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({
        models: [{
          id: 'vision-model', name: 'Vision Model', contextWindow: 262144, maxTokens: 32768,
          input: ['text', 'image'], reasoningEfforts: { high: 'high' },
        }],
        headers: {
          [PROFILE_SYNC_HEADER]: 'rich:test',
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    } })
    harness.setCredential('secret-key')
    harness.emit('credentials/reference-updated', 'DSH_CLIPROXY_API_KEY')

    await waitFor(() => harness.mutations.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    const profile = harness.mutations[0][0].value
    assert.equal(harness.mutations.length, 1)
    assert.equal(profile.headers[PROFILE_SYNC_HEADER], undefined)
    assert.equal(profile.apiKeyEnv, 'DSH_CLIPROXY_API_KEY')
    assert.deepEqual(profile.models[0].input, ['text', 'image'])
    assert.deepEqual(profile.models[0].reasoningEfforts, { high: 'high' })
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('keyless profiles omit apiKeyEnv and receive a non-sensitive placeholder header', async () => {
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig())
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.apiKeyEnv, undefined)
    assert.equal(profile.headers.authorization, PLACEHOLDER_AUTHORIZATION)
    assert.equal(profile.models[0].id, 'model-a')
    harness.settingsDocumentUpdated()
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(harness.mutations.length, 1)
    assert.equal(fetches, 1)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('refreshIntervalMs zero disables healthy periodic refreshes', async () => {
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig({ refreshIntervalMs: 0 }))
    await waitFor(() => fetches === 1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(harness.timeouts.length, 0)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('credential removal regenerates the profile in keyless mode', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 })
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile({
        apiKeyEnv: 'DSH_CLIPROXY_API_KEY',
        headers: {
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    } }, 'secret-key')
    apply(harness.ctx, await resolvedConfig())
    await waitFor(() => harness.mutations.length === 1)
    assert.equal(harness.mutations[0][0].value.apiKeyEnv, 'DSH_CLIPROXY_API_KEY')
    assert.equal(harness.mutations[0][0].value.headers.authorization, undefined)

    harness.mutations.length = 0
    harness.setCredential(undefined)
    harness.emit('credentials/reference-updated', 'DSH_CLIPROXY_API_KEY')
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.apiKeyEnv, undefined)
    assert.equal(profile.headers.authorization, PLACEHOLDER_AUTHORIZATION)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a renamed pi-ai entry keeps its own id as the settings namespace', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] }), { status: 200 })
  try {
    // A deployment may rename the profile entry; `options.name` stays the
    // composition's own name, so the entry (and therefore the write target) is
    // found by name while the namespace is the renamed id.
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } }, undefined, { entryId: 'my-piai' })
    assert.equal(llmPiAiNamespace(harness.ctx), 'my-piai')
    apply(harness.ctx, await resolvedConfig())
    await waitFor(() => harness.mutations.length === 1)
    assert.deepEqual(harness.mutationNamespaces, ['my-piai'])
    assert.equal(harness.mutations[0][0].path[1], 'CLIProxyAPI')
    assert.equal(harness.mutations[0][0].value.baseURL, 'http://127.0.0.1:8317/v1')
    harness.settingsDocumentUpdated('my-piai')
    await new Promise((resolve) => setTimeout(resolve, 25))
    assert.equal(harness.mutations.length, 1)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a newer settings change aborts stale discovery and only installs the latest profile', async () => {
  const previousFetch = globalThis.fetch
  let markFirstStarted
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve })
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('8317')) {
      markFirstStarted()
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig())
    await firstStarted
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({ baseURL: 'http://127.0.0.1:9417/v1' }),
    } })
    harness.settingsDocumentUpdated()
    await waitFor(() => harness.mutations.length === 1)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.baseURL, 'http://127.0.0.1:9417/v1')
    assert.deepEqual(profile.models.map((model) => model.id), ['model-b'])
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a profile edit outside the refresh key during discovery is not reverted', async () => {
  const previousFetch = globalThis.fetch
  let markStarted
  let release
  const started = new Promise((resolve) => { markStarted = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    if (fetches === 1) {
      markStarted()
      await gate
    }
    return new Response(JSON.stringify({ data: [{ id: 'model-b' }] }), { status: 200 })
  }
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig())
    await started
    // timeoutMs is not part of the refresh key, so this edit does not abort
    // the in-flight run; only the revision fence keeps it from being reverted.
    harness.setSection({ providers: {
      CLIProxyAPI: managedProfile({ timeoutMs: 1234 }),
    } })
    harness.settingsDocumentUpdated()
    release()
    await waitFor(() => harness.mutations.length === 1)
    assert.equal(harness.conflicts, 1)
    assert.equal(harness.warnings.length, 0)
    const profile = harness.mutations[0][0].value
    assert.equal(profile.timeoutMs, 1234)
    assert.deepEqual(profile.models.map((model) => model.id), ['model-b'])
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('catalog requests honor timeout and failed refreshes use exponential backoff', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
  try {
    const harness = createContext({ providers: {
      CLIProxyAPI: managedProfile(),
    } })
    apply(harness.ctx, await resolvedConfig({ fetchTimeoutMs: 10, retryInitialMs: 20, retryMaxMs: 80 }))
    await waitFor(() => harness.timeouts.length === 1)
    assert.equal(harness.timeouts[0].delay, 20)
    assert.match(harness.warnings[0], /timed out after 10 ms/)

    harness.timeouts[0].callback()
    await waitFor(() => harness.timeouts.length === 2)
    assert.equal(harness.timeouts[1].delay, 40)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('catalog transport failures keep their actionable host-side diagnostics', async () => {
  const previousFetch = globalThis.fetch
  const harness = createContext({ providers: {} })
  apply(harness.ctx, await resolvedConfig())
  const discover = harness.discoveries.get('llm-cliproxyapi')
  const request = () => ({
    provider: 'CLIProxyAPI',
    baseURL: 'http://127.0.0.1:8317/v1',
    apiKey: 'secret-key',
    signal: new AbortController().signal,
  })
  try {
    globalThis.fetch = async () => new Response('denied', { status: 401 })
    await assert.rejects(discover(request()), /answered 401; save a valid API key in Settings/)

    globalThis.fetch = async () => new Response('denied', { status: 403 })
    await assert.rejects(discover(request()), /answered 403; save a valid API key in Settings/)

    globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 200 })
    await assert.rejects(discover(request()), (error) => {
      assert.match(error.message, /did not return usable JSON/)
      assert.equal(error.cause?.name, 'SyntaxError')
      return true
    })

    // A declared length is refused before the body is read, so a body that never
    // produces a byte still fails fast; a chunked body that never declares one is
    // refused mid-read. Both keep 4 MiB as the ceiling and both reach the caller
    // through the same "usable JSON" wrapper, so the specific reason is asserted
    // on the cause.
    globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })
    await assert.rejects(discover(request()), (error) => {
      assert.match(error.message, /did not return usable JSON/)
      assert.match(String(error.cause?.message), /exceeds 4 MiB/)
      return true
    })

    const oversized = new Uint8Array(4 * 1024 * 1024 + 1)
    globalThis.fetch = async () => new Response(oversized, { status: 200 })
    await assert.rejects(discover(request()), (error) => {
      assert.match(error.message, /did not return usable JSON/)
      assert.match(String(error.cause?.message), /exceeds 4 MiB/)
      return true
    })

    // The Settings page shows only the message, so the reason must reach it.
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [
      { id: 'text-embedding-3-large', architecture: { output_modalities: ['embeddings'] } },
    ] }), { status: 200 })
    await assert.rejects(discover(request()), /no usable chat models \(models that only output embeddings/)

    globalThis.fetch = async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
    await assert.rejects(discover(request()), /Unusable CLIProxyAPI model listing; the response has no "data" array/)
    harness.dispose()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('real Cordis composition leaves llm-pi-ai as the sole directory owner', async () => {
  const previousFetch = globalThis.fetch
  let inferenceAuthorization
  let catalogFetches = 0
  const entryId = 'llm-pi-ai'

  class MemoryCredentials extends CredentialProvider {
    async resolve() { return undefined }
    async describe() { return { configured: false, writable: true } }
    async set() {}
    async unset() {}
  }

  class TimerService extends Service {
    constructor(ctx) {
      super(ctx, 'timer')
      ctx.mixin('timer', ['timeout'])
    }
    timeout(callback, delay) {
      return this.ctx.effect(() => {
        const timer = setTimeout(callback, delay)
        return () => clearTimeout(timer)
      })
    }
  }

  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method === 'GET' && url.endsWith('/models')) {
      catalogFetches += 1
      return new Response(JSON.stringify({ data: [
        { id: 'plain', reasoning: { supported: false } },
        { id: 'think', reasoning: { supported: true, levels: ['none', 'high'] } },
      ] }), { status: 200 })
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value)
    inferenceAuthorization = headers.get('authorization')
    return new Response(JSON.stringify({ error: { message: 'intentional test response' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })
  }

  const ctx = new Context()
  const fibers = []
  try {
    // 0.2 has no `SettingsProvider`: the settings seam is `SettingsForms`, which
    // derives its descriptors from the config editor's active entries. The real
    // editor writes profile YAML, so this composition installs an in-memory
    // editor that reproduces the one step that matters for a live edit: re-resolve
    // the entry's raw config (running the plugin's own `internal/config`
    // waterfall, where llm-pi-ai validates every changed route), commit its
    // volatile references, and announce `loader/volatile-update` exactly as
    // `Loader`'s `_commitVolatile()` does.
    const piEntry = {
      id: entryId,
      name: piAiName,
      options: { id: entryId, name: piAiName, config: { providers: {} } },
      fiber: undefined,
    }
    const cpaEntry = {
      id: 'llm-cliproxyapi',
      name: 'llm-cliproxyapi',
      options: { id: 'llm-cliproxyapi', name: 'llm-cliproxyapi', config: {} },
      fiber: undefined,
    }

    const fakeConfigEditor = {
      entries: () => [cpaEntry, piEntry],
      configuration: () => [
        { entry: cpaEntry, inherited: {}, override: {} },
        { entry: piEntry, inherited: {}, override: structuredClone(piEntry.options.config ?? {}) },
      ],
      get documentPath() { return '/tmp/dsh-cliproxyapi-profile.yml' },
      async edit(entry, change) {
        const current = structuredClone(entry.options.config ?? {})
        const next = change(current, {})
        const fiber = entry.fiber
        if (fiber.state !== 2) throw new Error('Configuration plugin is no longer active')
        const candidate = resolveConfig(
          fiber.runtime,
          fiber.ctx.waterfall(fiber, 'internal/config', next, () => next),
        )
        const paths = volatileEntries(fiber.config).flatMap(({ path, ref }) => {
          const source = path.reduce((value, key) => Reflect.get(value, key), candidate)
          if (deepEqual(ref.get(), source.get(), true)) return []
          updateVolatile(ref, source)
          return [path]
        })
        entry.options.config = next
        if (paths.length) {
          const self = Object.create(fiber.ctx)
          self[Context.filter] = (owner) => owner.fiber === fiber
          fiber.ctx.emit(self, 'loader/volatile-update', paths)
        }
      },
    }

    const infrastructure = ctx.plugin({
      inject: [],
      apply(child) {
        child.provide('loader', { await: async () => {}, entries: () => [] })
        child.provide('profileContext', {
          name: 'test',
          home: '/nonexistent-dsh-cliproxyapi-home',
          dir: '/nonexistent-dsh-cliproxyapi-home',
          patchPath: '/nonexistent-dsh-cliproxyapi-home/profile.yml',
          installAnchor: '/nonexistent-dsh-cliproxyapi-home',
        })
        child.provide('configEditor', fakeConfigEditor)
      },
    })
    fibers.push(
      ctx.plugin(LlmRuntime),
      ctx.plugin(MemoryCredentials),
      ctx.plugin(TimerService),
      ctx.plugin(SettingsForms),
    )
    await Promise.all([infrastructure.await(), ...fibers.map((fiber) => fiber.await())])

    const piFiber = ctx.plugin({
      name: piAiName,
      inject: piAiInject,
      Config: PiAiConfig,
      apply: applyPiAi,
    }, { providers: {} })
    // `ctx.plugin()` hands back an `Object.create(fiber)` wrapper; the fiber the
    // plugin actually runs in is its prototype, which is also what `ctx.fiber`
    // resolves to inside `apply`. Giving it the loader `entry` is what a real
    // profile does, so llm-pi-ai reports the entry id as its settings namespace.
    piEntry.fiber = Object.getPrototypeOf(piFiber)
    piEntry.fiber.entry = piEntry
    fibers.push(piFiber)
    assert.deepEqual([...pluginInject], ['settings', 'credentials', 'llm', 'timer', 'configEditor'])

    const cpaFiber = ctx.plugin({
      name: 'llm-cliproxyapi',
      inject: pluginInject,
      Config,
      apply,
    }, {
      retryInitialMs: 10,
      retryMaxMs: 20,
    })
    fibers.push(cpaFiber)
    await Promise.all([piFiber.await(), cpaFiber.await()])

    const discovered = await ctx.llm.discoverModels('llm-cliproxyapi', {
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
    }, new AbortController().signal)
    // The browser-facing RPC narrows every discovered model to
    // id/name/contextWindow/maxTokens (0.2 also keeps `inputModalities`), so the
    // pi-ai capability fields never survive the round trip.
    assert.equal(discovered[0].input, undefined)
    assert.equal(discovered[1].reasoningEfforts, undefined)
    const bootstrapModels = discovered.map(({ id, name, contextWindow, maxTokens }) => ({
      id, name, contextWindow, maxTokens,
    }))
    await ctx.settings.mutate(entryId, [{
      op: 'set',
      path: ['providers', 'CLIProxyAPI'],
      value: managedProfile({
        models: bootstrapModels,
        headers: {
          [PROFILE_SYNC_HEADER]: 'rich:integration-test',
          authorization: PLACEHOLDER_AUTHORIZATION,
        },
      }),
    }])

    const sectionNow = () => ctx.settings.describe()
      .find((row) => row.ns === entryId)?.value?.providers?.CLIProxyAPI
    // The bootstrap profile the browser RPC shaped already carries the discovered
    // ids, so wait on signals only the host-side synchronization produces: the
    // stripped sync header and the capability map the RPC dropped.
    await waitFor(() => sectionNow()?.headers?.[PROFILE_SYNC_HEADER] === undefined)
    await waitFor(() => sectionNow()?.models?.[1]?.reasoningEfforts?.high === 'high')
    assert.equal(catalogFetches, 1)
    const directories = ctx.llm.listConfigurableProviders().filter((entry) => entry.provider === 'CLIProxyAPI')
    assert.equal(directories.length, 1)
    assert.equal(directories[0].settingsNs, entryId)
    assert.equal(ctx.llm.listProviders().some((provider) => provider.id === 'CLIProxyAPI'), true)
    const models = sectionNow().models
    assert.equal(models[0].reasoningEfforts, undefined)
    assert.deepEqual(models[1].reasoningEfforts, { off: 'none', high: 'high' })

    // Negative control: the very same `internal/config` waterfall the editor
    // above runs, driven with an unserviceable profile, and refused by real
    // llm-pi-ai validation — which is what makes the accepted write above
    // evidence rather than a coincidence.
    assert.throws(
      () => piEntry.fiber.ctx.waterfall(
        piEntry.fiber,
        'internal/config',
        { providers: { CLIProxyAPI: { baseURL: '' } } },
        (value) => value,
      ),
      /empty baseURL/,
    )

    const chunks = []
    for await (const chunk of ctx.llm.stream({
      provider: 'CLIProxyAPI',
      model: 'plain',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'probe' }],
        source: { kind: 'user' },
      })],
    })) chunks.push(chunk)
    assert.equal(inferenceAuthorization, PLACEHOLDER_AUTHORIZATION)
    assert.equal(chunks.at(-1)?.type, 'finish')
    // The keyless placeholder reached the provider and failed on its 503 rather
    // than being short-circuited for a missing credential.
    assert.equal(chunks.at(-1)?.reason?.kind, 'error')
    assert.notEqual(chunks.at(-1)?.reason?.failure?.code, 'MISSING_CREDENTIAL')
  } finally {
    globalThis.fetch = previousFetch
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {})
  }
})
