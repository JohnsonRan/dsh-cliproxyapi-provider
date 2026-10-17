import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'

/** Load the browser bundle once and hand back its exported surface. */
async function loadClientPlugin(specifier = '../client.js') {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import(specifier)
  } finally {
    delete globalThis.window
  }
  return definition.factory((id) => {
    assert.equal(id, 'react')
    return {}
  })
}

test('client bundle registers a lifecycle-owned Plugins Settings tab', async () => {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import('../client.js')
    const plugin = definition.factory((id) => {
      assert.equal(id, 'react')
      return {}
    })
    assert.deepEqual(plugin.inject, [
      'remote', 'remote.settings', 'remote.credentials', 'remote.llm',
      'slots', 'locale', 'configForms', 'settingsSchema',
    ])

    const registrations = []
    const injections = []
    const slots = {
      inject(name, callback) {
        injections.push(name)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    }
    const locale = {
      register(namespace, dictionaries) {
        assert.equal(namespace, 'settings.cliProxyApi')
        assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh'])
        return () => {}
      },
      bind(namespace) {
        assert.equal(namespace, 'settings.cliProxyApi')
        return (key) => key
      },
    }
    const settingsSchema = {
      rehydrate(serialized) {
        return serialized
      },
      nodeAtPath(node, path) {
        return node?.[path[0]]
      },
    }
    const configForms = {
      describe() {
        return {
          getSnapshot() {
            return { status: 'idle', view: undefined, error: null }
          },
          subscribe() {
            return () => {}
          },
          ensure() {
            return Promise.resolve()
          },
        }
      },
      get(entryId) {
        assert.equal(entryId, 'llm-pi-ai')
        return {
          getSnapshot() {
            return { status: 'loading', value: undefined, revision: undefined, writable: false }
          },
          subscribe() {
            return () => {}
          },
        }
      },
    }
    let effect
    const remote = { $on() { return () => {} } }
    const ctx = {
      get(name) {
        if (name === 'remote') return remote
        if (name === 'slots') return slots
        if (name === 'locale') return locale
        if (name === 'configForms') return configForms
        if (name === 'settingsSchema') return settingsSchema
        throw new Error(`unexpected service: ${name}`)
      },
      slots,
      locale,
      configForms,
      settingsSchema,
      effect(factory) {
        effect = factory
        return () => {}
      },
    }
    plugin.apply(ctx)
    assert.equal(typeof effect, 'function')
    assert.deepEqual(injections, ['settings.plugins.tab'])
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'settings.plugins.tab')
    assert.equal(registrations[0].options.id, 'cliproxyapi')
    assert.equal(registrations[0].options.order, 30)
    assert.deepEqual(registrations[0].options.inject(), { remote, configForms, settingsSchema })
    assert.equal(typeof registrations[0].component, 'function')
  } finally {
    delete globalThis.window
  }
})

test('client owns only its Settings slot and keeps the configuration accessible', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setInterval\s*\(/)
  assert.doesNotMatch(source, /document\./)
  assert.doesNotMatch(source, /MutationObserver/)
  assert.doesNotMatch(source, /querySelector(All)?\s*\(/)
  assert.doesNotMatch(source, /modelsHeading|configuredRows|BOOTSTRAP_ATTRIBUTE|HIDDEN_ATTRIBUTE/)
  assert.match(source, /settings\.plugins\.tab/)
  assert.match(source, /ctx\.configForms/)
  assert.match(source, /settingsNamespaceOf/)
  assert.match(source, /slots\.inject\(SETTINGS_SLOT/)
  assert.match(source, /expectedRevision/)
  assert.match(source, /scope\.subscribe\(/)
  assert.doesNotMatch(source, /remote\.\$on\('settings\/document-updated'/)
  assert.match(source, /remote\.\$on\('credentials\/reference-updated'/)
  assert.match(source, /role: 'status'/)
  assert.match(source, /baseURLDirty/)
  assert.match(source, /apiKeyDirty/)
  assert.match(source, /!baseURLDirty/)
  assert.match(source, /!apiKeyDirty/)
})

for (const apiKey of ['', 'test-api-key']) {
test(`initial profile uses Remote and waits for complete capabilities (${apiKey ? 'with key' : 'keyless'})`, async () => {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import(`../client.js?initial-profile-sync-test=${apiKey}`)
    const plugin = definition.factory((id) => {
      assert.equal(id, 'react')
      return {}
    })
    const scopeListeners = []
    let currentNamespace = {
      ns: 'llm-pi-ai', revision: 1, value: { providers: {} },
    }
    let scopeSnapshot = {
      status: 'ready', revision: 1, value: {
        providers: {
          CLIProxyAPI: {
            baseURL: 'http://127.0.0.1:8317/v1',
            headers: { authorization: 'Bearer dsh-cliproxyapi-no-key' },
          },
        },
      }, writable: true,
    }
    let bootstrap
    let discoveryRequest
    let storedKey
    const ok = (value) => ({ ok: true, value })
    const remote = {
      settings: {
        async describe(...args) {
          assert.deepEqual(args, [])
          return ok({ writable: true, hasDocument: true, namespaces: [currentNamespace] })
        },
        async mutate(ns, ops, expectedRevision) {
          assert.equal(ns, 'llm-pi-ai')
          assert.equal(expectedRevision, 1)
          assert.equal(storedKey, apiKey || undefined)
          bootstrap = ops[0].value
          currentNamespace = {
            ns: 'llm-pi-ai', revision: 2, value: { providers: { CLIProxyAPI: bootstrap } },
          }
          return ok(currentNamespace)
        },
      },
      credentials: {
        async describe(refs) {
          assert.deepEqual(refs, ['DSH_CLIPROXY_API_KEY'])
          return ok({ DSH_CLIPROXY_API_KEY: { configured: false } })
        },
        async set(ref, value) {
          assert.equal(ref, 'DSH_CLIPROXY_API_KEY')
          assert.equal(value, apiKey)
          storedKey = value
          return ok(undefined)
        },
      },
      llm: {
        async discoverModels(settingsNs, request) {
          assert.equal(settingsNs, 'llm-cliproxyapi')
          discoveryRequest = request
          return ok([{
            id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', contextWindow: 372000, maxTokens: 32768,
          }])
        },
      },
    }
    const scope = {
      getSnapshot() {
        return scopeSnapshot
      },
      subscribe(listener) {
        scopeListeners.push(listener)
        return () => scopeListeners.splice(scopeListeners.indexOf(listener), 1)
      },
    }
    const messages = {
      noModels: 'no models',
      syncTimeout: 'sync timeout',
    }
    let settled = false
    const installing = plugin.installInitialProfile(
      remote, scope, 'http://127.0.0.1:8317/v1', apiKey, messages,
    ).then((profile) => {
      settled = true
      return profile
    })

    for (let attempt = 0; !bootstrap && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.ok(bootstrap)
    assert.deepEqual(discoveryRequest, {
      provider: 'CLIProxyAPI',
      baseURL: 'http://127.0.0.1:8317/v1',
      api: 'openai-responses',
      ...(apiKey ? { apiKey } : {}),
    })
    assert.equal(bootstrap.apiKeyEnv, apiKey ? 'DSH_CLIPROXY_API_KEY' : undefined)
    assert.equal(bootstrap.headers.authorization, apiKey ? undefined : 'Bearer dsh-cliproxyapi-no-key')
    assert.equal(bootstrap.models[0].input, undefined)
    assert.equal(bootstrap.models[0].reasoningEfforts, undefined)
    assert.match(bootstrap.headers['x-dsh-provider-cpa-sync'], /^rich:/)
    const validated = await PiAiConfig['~standard'].validate({
      providers: { CLIProxyAPI: bootstrap },
    })
    assert.equal(validated.issues, undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(settled, false)

    const synchronized = {
      ...bootstrap,
      headers: { authorization: 'Bearer dsh-cliproxyapi-no-key' },
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        contextWindow: 372000,
        maxTokens: 32768,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', high: 'high' },
      }],
    }
    currentNamespace = {
      ns: 'llm-pi-ai', revision: 3, value: { providers: { CLIProxyAPI: synchronized } },
    }
    scopeSnapshot = {
      status: 'ready', revision: 3, value: currentNamespace.value, writable: true,
    }
    for (const listener of [...scopeListeners]) listener()

    const profile = await installing
    assert.deepEqual(profile.models[0].input, ['text', 'image'])
    assert.deepEqual(profile.models[0].reasoningEfforts, { low: 'low', high: 'high' })
    assert.equal(scopeListeners.length, 0)
  } finally {
    delete globalThis.window
  }
})
}

test('initial profile preserves Remote errors without continuing the save', async () => {
  let definition
  globalThis.window = { __ModuleLoader__: { load(value) { definition = value } } }
  try {
    await import('../client.js?remote-error-test')
    const plugin = definition.factory(() => ({}))
    const remote = {
      settings: {
        async describe() {
          return { ok: false, error: { code: 'settings/unavailable', message: 'Settings unavailable' } }
        },
      },
    }
    await assert.rejects(
      plugin.installInitialProfile(remote, {}, 'http://127.0.0.1:8317/v1', '', {}),
      { message: 'Settings unavailable' },
    )
  } finally {
    delete globalThis.window
  }
})

test('resolves the provider entry id from the live providers form field', async () => {
  const plugin = await loadClientPlugin('../client.js?namespace-resolution-test')
  const settingsSchema = {
    rehydrate(serialized) {
      return serialized
    },
    nodeAtPath(node, path) {
      return node?.[path[0]]
    },
  }

  const configured = {
    namespaces: [
      { ns: 'ui-settings-general', schema: { theme: {} }, value: { theme: 'dark' } },
      { ns: 'llm-piai', schema: { providers: {} }, value: { providers: {} } },
      {
        ns: 'llm-pi-ai',
        schema: { providers: {} },
        value: { providers: { CLIProxyAPI: { baseURL: 'http://127.0.0.1:8317/v1' } } },
      },
    ],
  }
  assert.equal(plugin.settingsNamespaceOf(configured, settingsSchema), 'llm-pi-ai')

  const renamed = { namespaces: [{ ns: 'my-piai', schema: { providers: {} }, value: { providers: {} } }] }
  assert.equal(plugin.settingsNamespaceOf(renamed, settingsSchema), 'my-piai')

  const ownProfileOnlyInUserLayer = {
    namespaces: [{ ns: 'renamed-piai', schema: { providers: {} }, user: { providers: { CLIProxyAPI: {} } } }],
  }
  assert.equal(plugin.settingsNamespaceOf(ownProfileOnlyInUserLayer, settingsSchema), 'renamed-piai')

  const unshaped = { namespaces: [{ ns: 'llm-pi-ai', schema: { providers: {} } }] }
  const shapelessSchema = { ...settingsSchema, nodeAtPath: () => undefined }
  assert.equal(plugin.settingsNamespaceOf(unshaped, shapelessSchema), 'llm-pi-ai')

  assert.equal(plugin.settingsNamespaceOf({ namespaces: [] }, settingsSchema), undefined)
  assert.equal(plugin.settingsNamespaceOf(undefined, settingsSchema), undefined)
})

test('initial profile writes the provider entry the page resolved', async () => {
  const plugin = await loadClientPlugin('../client.js?explicit-namespace-test')
  const writes = []
  const listeners = []
  let namespaceView = { ns: 'piai-renamed', revision: 7, value: { providers: {} } }
  let scopeSnapshot = { status: 'ready', revision: 7, value: namespaceView.value, writable: true }
  const remote = {
    settings: {
      async describe() {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [namespaceView] } }
      },
      async mutate(ns, ops, expectedRevision) {
        writes.push({ ns, ops, expectedRevision })
        namespaceView = { ns, revision: 8, value: { providers: { CLIProxyAPI: ops[0].value } } }
        return { ok: true, value: namespaceView }
      },
    },
    credentials: {
      async describe() {
        return { ok: true, value: {} }
      },
      async set() {
        return { ok: true, value: undefined }
      },
    },
    llm: {
      async discoverModels(settingsNs, request) {
        assert.equal(settingsNs, 'llm-cliproxyapi')
        assert.equal(request.baseURL, 'http://127.0.0.1:8317/v1')
        return { ok: true, value: [{ id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' }] }
      },
    },
  }
  const scope = {
    getSnapshot() {
      return scopeSnapshot
    },
    subscribe(listener) {
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
  }
  const installing = plugin.installInitialProfile(
    remote,
    scope,
    'http://127.0.0.1:8317/v1',
    '',
    { noModels: 'no models', syncTimeout: 'sync timeout', namespaceUnavailable: 'unavailable' },
    'piai-renamed',
  )

  for (let attempt = 0; !writes.length && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, 'piai-renamed')
  assert.equal(writes[0].expectedRevision, 7)
  assert.deepEqual(writes[0].ops[0].path, ['providers', 'CLIProxyAPI'])
  assert.match(writes[0].ops[0].value.headers['x-dsh-provider-cpa-sync'], /^rich:/)

  const settled = {
    ...writes[0].ops[0].value,
    models: [{
      id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', contextWindow: 262144, maxTokens: 32768, input: ['text'],
    }],
    headers: {},
  }
  scopeSnapshot = { status: 'ready', revision: 9, value: { providers: { CLIProxyAPI: settled } }, writable: true }
  for (const listener of [...listeners]) listener()

  const profile = await installing
  assert.deepEqual(profile.headers, {})
  assert.equal(profile.models[0].id, 'gpt-5.6-sol')
})

test('initial profile refuses an entry the Host does not serve', async () => {
  const plugin = await loadClientPlugin('../client.js?missing-namespace-test')
  const remote = {
    settings: {
      async describe() {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } }
      },
    },
  }
  await assert.rejects(
    plugin.installInitialProfile(
      remote,
      {},
      'http://127.0.0.1:8317/v1',
      '',
      { namespaceUnavailable: 'The llm-pi-ai provider settings are unavailable in this profile.' },
      undefined,
    ),
    { message: 'The llm-pi-ai provider settings are unavailable in this profile.' },
  )
})
