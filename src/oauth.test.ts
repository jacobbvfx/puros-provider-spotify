import { createHash } from 'node:crypto'
import http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { assertCatalogConfig, DEFAULT_REDIRECT_URI, loadSpotifyConfig, parseLoopbackRedirect } from './config'
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  OAuthTokenError,
  refreshAccessToken,
  runPkceFlow,
  startLoopbackListener,
} from './oauth'

async function hit(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => { response.resume(); resolve(response.statusCode ?? 0) }).on('error', reject)
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Spotify PKCE', () => {
  it('derives an S256 challenge from a verifier in the RFC 7636 range', () => {
    const { verifier, challenge } = createPkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('builds an authorize URL with state, challenge and the exact loopback redirect', () => {
    const url = new URL(buildAuthorizeUrl({
      accountsBaseUrl: 'https://accounts.spotify.com', clientId: 'a'.repeat(32),
      redirectUri: 'http://127.0.0.1:5000/callback', scopes: ['user-library-read', 'playlist-read-private'],
      state: 'state-1', challenge: 'challenge-1',
    }))
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code', code_challenge_method: 'S256', code_challenge: 'challenge-1', state: 'state-1',
      redirect_uri: 'http://127.0.0.1:5000/callback', scope: 'user-library-read playlist-read-private',
    })
  })
})

describe('one-shot loopback listener', () => {
  it('ignores other paths, accepts the matching state once and then closes', async () => {
    const listener = await startLoopbackListener({ port: 0, path: '/callback', state: 'expected', timeoutMs: 5_000 })
    expect(listener.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(await hit(listener.redirectUri.replace('/callback', '/other?state=expected&code=x'))).toBe(404)
    expect(await hit(`${listener.redirectUri}?state=expected&code=the-code`)).toBe(200)
    await expect(listener.code).resolves.toBe('the-code')
    await expect(hit(`${listener.redirectUri}?state=expected&code=again`)).rejects.toThrow()
  })

  it('rejects a wrong state, a denial, a timeout and a cancellation', async () => {
    const wrong = await startLoopbackListener({ port: 0, path: '/cb', state: 'expected', timeoutMs: 5_000 })
    expect(await hit(`${wrong.redirectUri}?state=forged&code=x`)).toBe(400)
    await expect(wrong.code).rejects.toMatchObject({ reason: 'state' })

    const denied = await startLoopbackListener({ port: 0, path: '/cb', state: 's', timeoutMs: 5_000 })
    await hit(`${denied.redirectUri}?state=s&error=access_denied`)
    await expect(denied.code).rejects.toMatchObject({ reason: 'denied' })

    const slow = await startLoopbackListener({ port: 0, path: '/cb', state: 's', timeoutMs: 20 })
    await expect(slow.code).rejects.toMatchObject({ reason: 'timeout' })

    const abort = new AbortController()
    const cancelled = await startLoopbackListener({ port: 0, path: '/cb', state: 's', timeoutMs: 5_000, signal: abort.signal })
    abort.abort()
    await expect(cancelled.code).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reports a busy fixed port', async () => {
    const first = await startLoopbackListener({ port: 0, path: '/cb', state: 's', timeoutMs: 5_000 })
    const port = Number(new URL(first.redirectUri).port)
    await expect(startLoopbackListener({ port, path: '/cb', state: 's', timeoutMs: 5_000 })).rejects.toMatchObject({ reason: 'port-busy' })
    first.close()
  })
})

describe('token requests', () => {
  it('exchanges a code and keeps the previous refresh token when Spotify omits a rotated one', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body))
      if (body.get('grant_type') === 'authorization_code') {
        expect(Object.fromEntries(body)).toMatchObject({ code: 'c', code_verifier: 'v', client_id: 'id', redirect_uri: 'http://127.0.0.1:1/cb' })
        return json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 'user-library-read' })
      }
      return json({ access_token: 'a2', expires_in: 3600 })
    })
    const first = await exchangeAuthorizationCode(fetchImpl, {
      accountsBaseUrl: 'https://accounts.spotify.com', clientId: 'id', code: 'c', redirectUri: 'http://127.0.0.1:1/cb', verifier: 'v', timeoutMs: 1_000,
    })
    expect(first).toMatchObject({ accessToken: 'a1', refreshToken: 'r1', scopes: ['user-library-read'] })
    const refreshed = await refreshAccessToken(fetchImpl, { accountsBaseUrl: 'https://accounts.spotify.com', clientId: 'id', refreshToken: 'r1', timeoutMs: 1_000 })
    expect(refreshed).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' })
  })

  it('reports revocation without echoing secrets', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400))
    const error = await refreshAccessToken(fetchImpl, { accountsBaseUrl: 'https://accounts.spotify.com', clientId: 'id', refreshToken: 'secret-refresh', timeoutMs: 1_000 })
      .catch((value: unknown) => value)
    expect(error).toBeInstanceOf(OAuthTokenError)
    expect((error as OAuthTokenError).revoked).toBe(true)
    expect(String((error as Error).message)).not.toContain('secret-refresh')
  })

  it('runs the whole browser flow against the system browser callback', async () => {
    const fetchImpl = vi.fn(async () => json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }))
    const openExternal = vi.fn(async (url: string) => {
      const authorize = new URL(url)
      const redirect = authorize.searchParams.get('redirect_uri')!
      setTimeout(() => { void hit(`${redirect}?state=${authorize.searchParams.get('state')}&code=browser-code`) }, 5)
    })
    const token = await runPkceFlow({
      fetchImpl, openExternal, accountsBaseUrl: 'https://accounts.spotify.com', clientId: 'id',
      scopes: ['streaming'], port: 0, path: '/login', timeoutMs: 5_000,
    })
    expect(token.accessToken).toBe('access')
    const body = new URLSearchParams(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.get('code')).toBe('browser-code')
    expect(body.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/login$/)
  })
})

describe('Spotify configuration', () => {
  it('accepts only literal loopback redirects', () => {
    expect(parseLoopbackRedirect('http://127.0.0.1/callback')).toEqual({ port: 0, path: '/callback' })
    expect(parseLoopbackRedirect('http://127.0.0.1:43821/cb')).toEqual({ port: 43821, path: '/cb' })
    expect(() => parseLoopbackRedirect('http://localhost:43821/cb')).toThrow(/localhost/)
    expect(() => parseLoopbackRedirect('https://127.0.0.1/cb')).toThrow()
    expect(() => parseLoopbackRedirect('http://127.0.0.1:81/cb')).toThrow(/port/)
  })

  it('defaults to the fixed loopback redirect the Spotify dashboard accepts', async () => {
    const settings = { get: async () => undefined, set: async () => {}, delete: async () => {} }
    expect((await loadSpotifyConfig(settings)).redirectUri).toBe(DEFAULT_REDIRECT_URI)
    expect(parseLoopbackRedirect(DEFAULT_REDIRECT_URI)).toEqual({ port: 43821, path: '/callback' })
    const custom = { ...settings, get: async (key: string) => (key === 'redirect-uri' ? ' http://127.0.0.1:50000/cb ' : undefined) }
    expect((await loadSpotifyConfig(custom)).redirectUri).toBe('http://127.0.0.1:50000/cb')
  })

  it('requires a Client ID before connecting', () => {
    const base = { clientId: '', redirectUri: '', apiBaseUrl: '', accountsBaseUrl: '', catalogScopes: [], requestTimeoutMs: 1, maxRetries: 0, bitrateKbps: 320 as const }
    expect(() => assertCatalogConfig(base)).toThrow(/Client ID/)
    expect(() => assertCatalogConfig({ ...base, clientId: 'f'.repeat(32) })).not.toThrow()
  })
})
