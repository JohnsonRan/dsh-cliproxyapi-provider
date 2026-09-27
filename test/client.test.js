import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'

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
      'slots', 'locale', 'settingsScope',
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
    const scope = {
      getSnapshot() {
        return { status: 'loading', value: undefined, revision: undefined, writable: false }
      },
      subscribe() {
        return () => {}
      },
    }
    const settingsScope = {
      bind(spec) {
        assert.deepEqual(spec, { namespace: 'llm-pi-ai' })
        return scope
      },
    }
    let effect
    const remote = { $on() { return () => {} } }
    const ctx = {
      get(name) {
        if (name === 'remote') return remote
        if (name === 'slots') return slots
        if (name === 'locale') return locale
        if (name === 'settingsScope') return settingsScope
        throw new Error(`unexpected service: ${name}`)
      },
      slots,
      locale,
      settingsScope,
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
    assert.deepEqual(registrations[0].options.inject(), { remote, scope })
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
  assert.match(source, /ctx\.settingsScope/)
  assert.match(source, /slots\.inject\(SETTINGS_SLOT/)
  assert.match(source, /expectedRevision/)
  assert.match(source, /scope\.subscribe\(/)
  assert.doesNotMatch(source, /remote\.\$on\('settings\/document-updated'/)
  assert.match(source, /remote\.\$on\('credentials\/reference-updated'/)
  assert.match(source, /role: 'status'/)
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
