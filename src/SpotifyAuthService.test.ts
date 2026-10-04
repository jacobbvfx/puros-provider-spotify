import http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderSecretsHostV1 } from 'puros-provider-sdk'
import { SpotifyCredentialStore } from './credentialStore'
import { SpotifyAuthService } from './SpotifyAuthService'
import { SpotifyHelperTransport } from './SpotifyHelperTransport'
import { fakeHelpers, requestOf } from './testSupport'
import type { SpotifyCatalogSession, SpotifyConfig } from './types'

const config: SpotifyConfig = {
  clientId: 'c'.repeat(32), redirectUri: '', apiBaseUrl: 'https://api.spotify.com/v1', accountsBaseUrl: 'https://accounts.spotify.com',
  catalogScopes: ['user-library-read'], requestTimeoutMs: 1_000, maxRetries: 0, bitrateKbps: 320,
}

function secrets(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const host: ProviderSecretsHostV1 = {
    async has(key) { return values.has(key) },
    async get(key) { return values.get(key) },
    async set(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
  }
  return { host, values }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function catalogSession(overrides: Partial<SpotifyCatalogSession> = {}): SpotifyCatalogSession {
  return {
    accessToken: 'expired-access', refreshToken: 'refresh-1', expiresAt: Date.now() - 1, scopes: ['user-library-read'],
    clientId: config.clientId, userId: 'listener', displayName: 'Listener', ...overrides,
  }
}

/** Simulates the browser: follows the authorize URL's redirect with the right state. */
async function browser(url: string) {
  const authorize = new URL(url)
  const redirect = authorize.searchParams.get('redirect_uri')!
  setTimeout(() => {
    http.get(`${redirect}?state=${authorize.searchParams.get('state')}&code=code-${authorize.searchParams.get('client_id')!.slice(0, 4)}`, (response) => response.resume())
  }, 2)
}

function service(options: { secrets: ProviderSecretsHostV1; fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>; helper?: SpotifyHelperTransport }) {
  return new SpotifyAuthService({
    config: async () => config,
    store: new SpotifyCredentialStore(options.secrets),
    helper: options.helper ?? new SpotifyHelperTransport(fakeHelpers().helpers),
    openExternal: browser,
    fetchImpl: options.fetchImpl,
    workDir: async () => '/tmp',
  })
}

function playbackHelper(username: string, product = 'premium') {
  return fakeHelpers({
    onRequest(process, request) {
      if (process.args[0] === 'describe') {
        process.event({ event: 'described', clientId: 'd'.repeat(32), scopes: ['streaming'], redirectPath: '/login', librespotVersion: '0.8.0' })
      } else {
        expect(request.accessToken ?? request.credentials).toBeTruthy()
        process.event({ event: 'authenticated', credentials: { username, authType: 1, authData: 'b3BhcXVl' }, country: 'PL', product })
      }
      process.event({ event: 'completed' })
      process.exit(0)
    },
  })
}

describe('Spotify auth service', () => {
  it('refreshes once for concurrent callers and persists a rotated refresh token before use', async () => {
    const store = secrets({ catalog: JSON.stringify(catalogSession()) })
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return json({ access_token: 'fresh', refresh_token: 'refresh-2', expires_in: 3600 })
    })
    const auth = service({ secrets: store.host, fetchImpl })
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()])
    expect(tokens).toEqual(['fresh', 'fresh', 'fresh'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store.values.get('catalog')!)).toMatchObject({ accessToken: 'fresh', refreshToken: 'refresh-2' })
  })

  it('turns a revoked refresh token into AUTH_EXPIRED', async () => {
    const store = secrets({ catalog: JSON.stringify(catalogSession()) })
    const auth = service({ secrets: store.host, fetchImpl: vi.fn(async () => json({ error: 'invalid_grant' }, 400)) })
    await expect(auth.getAccessToken()).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    await expect(service({ secrets: secrets().host }).getAccessToken()).rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
  })

  it('signs in to catalog and playback for the same account', async () => {
    const store = secrets()
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      return json({ access_token: `access-${body.get('client_id')!.slice(0, 1)}`, refresh_token: 'refresh', expires_in: 3600 })
    })
    const { helpers, processes } = playbackHelper('Listener')
    const auth = service({ secrets: store.host, fetchImpl, helper: new SpotifyHelperTransport(helpers) })
    const result = await auth.login(async (token) => {
      expect(token).toBe('access-c')
      return { id: 'listener', display_name: 'Listener' }
    })
    expect(result.accountChanged).toBe(false)
    expect(requestOf(processes[1]!)).toMatchObject({ accessToken: 'access-d', workDir: '/tmp' })
    expect(await auth.getStatus()).toMatchObject({ catalog: 'connected', playback: 'connected', product: 'premium', country: 'PL' })
    expect(JSON.parse(store.values.get('playback')!)).toMatchObject({ credentials: { username: 'Listener', authType: 1 } })
  })

  it('refuses a playback credential for a different account', async () => {
    const store = secrets({ catalog: JSON.stringify(catalogSession({ expiresAt: Date.now() + 3_600_000 })) })
    const fetchImpl = vi.fn(async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
    const auth = service({ secrets: store.host, fetchImpl, helper: new SpotifyHelperTransport(playbackHelper('someone-else').helpers) })
    await expect(auth.login(async () => ({ id: 'listener' }), 'playback')).rejects.toMatchObject({ providerError: { code: 'PERMISSION_DENIED' } })
    expect(store.values.has('playback')).toBe(false)
    expect(await auth.getStatus()).toMatchObject({ catalog: 'connected', playback: 'account-mismatch' })
  })

  it('drops another account\'s audio credential when the catalog account changes', async () => {
    const store = secrets({
      catalog: JSON.stringify(catalogSession({ userId: 'old-user' })),
      playback: JSON.stringify({ credentials: { username: 'old-user', authType: 1, authData: 'eA==' }, country: null, product: 'premium', librespotVersion: null, verifiedAt: 1 }),
    })
    const fetchImpl = vi.fn(async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }))
    const auth = service({ secrets: store.host, fetchImpl })
    const before = auth.accountGeneration
    const result = await auth.login(async () => ({ id: 'new-user' }), 'catalog')
    expect(result.accountChanged).toBe(true)
    expect(auth.accountGeneration).toBe(before + 1)
    expect(store.values.has('playback')).toBe(false)
  })

  it('marks a rejected stored credential after restart and clears it', async () => {
    const store = secrets({ playback: JSON.stringify({ credentials: { username: 'u', authType: 1, authData: 'eA==' }, country: null, product: null, librespotVersion: null, verifiedAt: 1 }) })
    const { helpers } = fakeHelpers({
      onRequest(process) {
        process.event({ event: 'failed', code: 'credentials-rejected', message: 'rejected', retryable: false })
        process.exit(1)
      },
    })
    const auth = service({ secrets: store.host, helper: new SpotifyHelperTransport(helpers) })
    expect(await auth.checkPlayback()).toBe(false)
    expect(store.values.has('playback')).toBe(false)
    expect((await auth.getStatus()).playback).toBe('rejected')
  })

  it('logout clears both secrets and bumps the account generation', async () => {
    const store = secrets({ catalog: JSON.stringify(catalogSession()), playback: '{}' })
    const auth = service({ secrets: store.host })
    await auth.logout()
    expect(store.values.size).toBe(0)
    expect(await auth.getStatus()).toMatchObject({ catalog: 'not-connected', playback: 'not-connected' })
  })
})
