import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { SpotifyOAuthToken } from './types'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface PkcePair { verifier: string; challenge: string }

export function createPkcePair(): PkcePair {
  // 64 random bytes → 86 base64url chars, inside RFC 7636's 43–128 range.
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function createState(): string {
  return randomBytes(24).toString('base64url')
}

export function buildAuthorizeUrl(options: {
  accountsBaseUrl: string
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string
  challenge: string
}): string {
  const url = new URL('/authorize', options.accountsBaseUrl)
  url.search = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: options.challenge,
    state: options.state,
    scope: options.scopes.join(' '),
  }).toString()
  return url.toString()
}

export class OAuthCallbackError extends Error {
  constructor(readonly reason: 'denied' | 'timeout' | 'cancelled' | 'state' | 'port-busy' | 'invalid', message: string) {
    super(message)
    this.name = reason === 'cancelled' ? 'AbortError' : 'OAuthCallbackError'
  }
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

const RESPONSE_PAGE = (title: string) => `<!doctype html><meta charset="utf-8"><title>Puros</title>
<body style="font:15px -apple-system,system-ui;padding:3em;text-align:center">${title}<br>You can close this tab and return to Puros.</body>`

export interface LoopbackListener {
  redirectUri: string
  /** Resolves with the authorization code once; the server closes itself either way. */
  code: Promise<string>
  close(): void
}

/**
 * One-shot `127.0.0.1` listener. Accepts exactly one request on `path` with a
 * matching `state`, then closes. Everything else gets 404 and is ignored.
 */
export async function startLoopbackListener(options: {
  port: number
  path: string
  state: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<LoopbackListener> {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void }
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  code.catch(() => {})
  let done = false
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (done || request.method !== 'GET' || url.pathname !== options.path) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    const state = url.searchParams.get('state') ?? ''
    if (!sameSecret(state, options.state)) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(RESPONSE_PAGE('This sign-in link is not the one Puros is waiting for.'))
      finish(new OAuthCallbackError('state', 'Spotify sign-in returned an unexpected state; try connecting again'))
      return
    }
    const error = url.searchParams.get('error')
    const received = url.searchParams.get('code')
    if (error || !received) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(RESPONSE_PAGE('Spotify sign-in was not completed.'))
      finish(error === 'access_denied'
        ? new OAuthCallbackError('denied', 'Spotify access was denied')
        : new OAuthCallbackError('invalid', 'Spotify sign-in did not return an authorization code'))
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(RESPONSE_PAGE('Spotify is connected.'))
    finish(null, received)
  })
  const timer = setTimeout(() => finish(new OAuthCallbackError('timeout', 'Spotify sign-in timed out')), options.timeoutMs)
  const onAbort = () => finish(new OAuthCallbackError('cancelled', 'Spotify sign-in was cancelled'))
  function finish(error: Error | null, value?: string) {
    if (done) return
    done = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections?.()
    if (error) settle.reject(error)
    else settle.resolve(value!)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      done = true
      reject(error.code === 'EADDRINUSE'
        ? new OAuthCallbackError('port-busy', `Port ${options.port} on 127.0.0.1 is already in use`)
        : error)
    })
    server.listen(options.port, '127.0.0.1', () => resolve())
  })
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })
  const { port } = server.address() as AddressInfo
  return {
    redirectUri: `http://127.0.0.1:${port}${options.path}`,
    code,
    close: () => finish(new OAuthCallbackError('cancelled', 'Spotify sign-in was cancelled')),
  }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

export class OAuthTokenError extends Error {
  constructor(readonly status: number, readonly oauthError: string | null, message: string) {
    super(message)
    this.name = 'OAuthTokenError'
  }

  /** The refresh token was revoked or expired; the user must sign in again. */
  get revoked(): boolean { return this.oauthError === 'invalid_grant' }
}

async function tokenRequest(
  fetchImpl: FetchLike,
  accountsBaseUrl: string,
  body: Record<string, string>,
  previousRefreshToken: string | null,
  timeoutMs: number,
): Promise<SpotifyOAuthToken> {
  const response = await fetchImpl(new URL('/api/token', accountsBaseUrl).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let payload: TokenResponse = {}
  try { payload = await response.json() as TokenResponse } catch { /* non-JSON error body */ }
  if (!response.ok || !payload.access_token) {
    // Never include request bodies (codes, verifiers, refresh tokens) in messages.
    throw new OAuthTokenError(response.status, payload.error ?? null, `Spotify token request failed (${response.status}${payload.error ? ` ${payload.error}` : ''})`)
  }
  const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 3600
  return {
    accessToken: payload.access_token,
    // Spotify may omit a rotated refresh token; the previous one stays valid then.
    refreshToken: payload.refresh_token ?? previousRefreshToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000,
    scopes: (payload.scope ?? '').split(/\s+/).filter(Boolean),
  }
}

export function exchangeAuthorizationCode(fetchImpl: FetchLike, options: {
  accountsBaseUrl: string
  clientId: string
  code: string
  redirectUri: string
  verifier: string
  timeoutMs: number
}): Promise<SpotifyOAuthToken> {
  return tokenRequest(fetchImpl, options.accountsBaseUrl, {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: options.redirectUri,
    client_id: options.clientId,
    code_verifier: options.verifier,
  }, null, options.timeoutMs)
}

export function refreshAccessToken(fetchImpl: FetchLike, options: {
  accountsBaseUrl: string
  clientId: string
  refreshToken: string
  timeoutMs: number
}): Promise<SpotifyOAuthToken> {
  return tokenRequest(fetchImpl, options.accountsBaseUrl, {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  }, options.refreshToken, options.timeoutMs)
}

/** Full Authorization Code + PKCE round trip through the system browser. */
export async function runPkceFlow(options: {
  fetchImpl: FetchLike
  openExternal: (url: string) => Promise<void>
  accountsBaseUrl: string
  clientId: string
  scopes: string[]
  port: number
  path: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<SpotifyOAuthToken> {
  const pkce = createPkcePair()
  const state = createState()
  const listener = await startLoopbackListener({
    port: options.port, path: options.path, state, timeoutMs: options.timeoutMs, signal: options.signal,
  })
  try {
    await options.openExternal(buildAuthorizeUrl({
      accountsBaseUrl: options.accountsBaseUrl,
      clientId: options.clientId,
      redirectUri: listener.redirectUri,
      scopes: options.scopes,
      state,
      challenge: pkce.challenge,
    }))
    const code = await listener.code
    return await exchangeAuthorizationCode(options.fetchImpl, {
      accountsBaseUrl: options.accountsBaseUrl,
      clientId: options.clientId,
      code,
      redirectUri: listener.redirectUri,
      verifier: pkce.verifier,
      timeoutMs: 15_000,
    })
  } finally {
    listener.close()
  }
}
