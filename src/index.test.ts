import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderEventV1, ProviderHostV1 } from 'puros-provider-sdk'
import plugin from './index'
import { fakeHelpers } from './testSupport'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function host(secrets: Record<string, string> = {}, script = fakeHelpers()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-spotify-plugin-'))
  roots.push(root)
  const values = new Map(Object.entries(secrets))
  const events: ProviderEventV1[] = []
  const value = {
    settings: { get: vi.fn(async () => undefined) },
    secrets: {
      get: vi.fn(async (key: string) => values.get(key)),
      set: vi.fn(async (key: string, secret: string) => { values.set(key, secret) }),
      delete: vi.fn(async (key: string) => { values.delete(key) }),
      has: vi.fn(async (key: string) => values.has(key)),
    },
    paths: { getCacheRoot: async () => root, getDataRoot: async () => root, getResourceRoot: async () => root },
    cache: { get: vi.fn(async () => null), put: vi.fn(), inspectFormat: vi.fn(), trim: vi.fn() },
    events: { emit: vi.fn(async (event: ProviderEventV1) => { events.push(event) }) },
    helpers: script.helpers,
    logger: { info: vi.fn(async () => {}), warn: vi.fn(async () => {}) },
    openExternal: vi.fn(async () => {}),
  } as unknown as ProviderHostV1
  return { host: value, events, values, processes: script.processes }
}

const catalog = JSON.stringify({
  accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, scopes: [], clientId: 'c'.repeat(32), userId: 'listener', displayName: 'Listener',
})

describe('Spotify plugin composition', () => {
  it('activates without an account and spawns nothing', async () => {
    const { host: value, processes } = host()
    const runtime = await plugin.activate(value)
    expect(await runtime.getStatus()).toMatchObject({
      state: 'ready', authenticated: false, values: { account: 'Not connected', playback: 'Not connected' },
    })
    expect(await runtime.capabilities.auth!.getStatus()).toMatchObject({ authenticated: false })
    await expect(runtime.capabilities['playback.resolve']!.resolve({ sourceId: '4uLU6hMCjMI75M1A2tKUQC', intent: 'playback' }))
      .rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
    expect(processes).toHaveLength(0)
    await runtime.deactivate()
    expect((await runtime.getStatus()).state).toBe('inactive')
  })

  it('reports a connected catalog without playback as degraded, not an error', async () => {
    const { host: value } = host({ catalog })
    const runtime = await plugin.activate(value)
    expect(await runtime.getStatus()).toMatchObject({
      state: 'degraded', authenticated: true, values: { account: 'Connected · Listener', playback: 'Not connected' },
    })
    await runtime.deactivate()
  })

  it('re-validates a stored playback credential after restart', async () => {
    const script = fakeHelpers({
      onRequest(process) {
        process.event({ event: 'authenticated', credentials: { username: 'listener', authType: 1, authData: 'bmV3' }, country: 'PL', product: 'premium' })
        process.event({ event: 'completed' })
        process.exit(0)
      },
    })
    const playback = JSON.stringify({ credentials: { username: 'listener', authType: 1, authData: 'b2xk' }, country: null, product: null, librespotVersion: '0.8.0', verifiedAt: 1 })
    const { host: value, values, events, processes } = host({ catalog, playback }, script)
    const runtime = await plugin.activate(value)
    await vi.waitFor(() => expect(events.some((event) => event.type === 'status.changed')).toBe(true))
    expect(processes[0]!.args).toEqual(['check-session'])
    expect(JSON.parse(values.get('playback')!)).toMatchObject({ credentials: { authData: 'bmV3' }, product: 'premium' })
    expect(await runtime.getStatus()).toMatchObject({ state: 'ready', values: { playback: 'Ready · premium · PL' } })
    await runtime.deactivate()
  })

  it('logout clears secrets and reports the disconnected state', async () => {
    const { host: value, values, events } = host({ catalog })
    const runtime = await plugin.activate(value)
    await runtime.capabilities.auth!.logout()
    expect(values.size).toBe(0)
    expect(events.find((event) => event.type === 'auth.changed')).toMatchObject({ status: { authenticated: false } })
    await runtime.deactivate()
  })

  it('refuses to connect before a Client ID is set', async () => {
    const { host: value } = host()
    const runtime = await plugin.activate(value)
    await expect(runtime.capabilities.auth!.login()).rejects.toThrow(/Client ID/)
    await runtime.deactivate()
  })
})
