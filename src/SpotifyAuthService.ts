import { ProviderApiError, providerError } from 'puros-provider-sdk'
import { assertCatalogConfig, parseLoopbackRedirect } from './config'
import type { SpotifyCredentialStore } from './credentialStore'
import { OAuthTokenError, refreshAccessToken, runPkceFlow, type FetchLike } from './oauth'
import { findEvent, SpotifyHelperError, type SpotifyHelperTransport } from './SpotifyHelperTransport'
import type {
  SpotifyCatalogSession,
  SpotifyConfig,
  SpotifyPlaybackCredentials,
  SpotifyPlaybackSession,
  SpotifyUserProfile,
} from './types'

const LOGIN_STEP_TIMEOUT_MS = 2 * 60_000
const REFRESH_MARGIN_MS = 60_000

export interface SpotifyConnectionStatus {
  catalog: 'connected' | 'not-connected'
  playback: 'connected' | 'not-connected' | 'account-mismatch' | 'not-premium' | 'rejected'
  accountLabel: string | null
  userId: string | null
  expiresAt: number | null
  product: string | null
  country: string | null
  playbackMessage: string | null
}

type PlaybackProblem = Exclude<SpotifyConnectionStatus['playback'], 'connected' | 'not-connected'>

function sameAccount(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/**
 * Two credentials, one account: a Web API token for the catalog (the user's own
 * Client ID, PKCE) and a librespot access-point credential for audio. Both are
 * host secrets; neither is ever returned to the renderer.
 */
export class SpotifyAuthService {
  private catalogSession: SpotifyCatalogSession | null | undefined
  private playbackSession: SpotifyPlaybackSession | null | undefined
  private playbackProblem: { kind: PlaybackProblem; message: string } | null = null
  private refreshing: Promise<SpotifyCatalogSession> | null = null
  private loginAbort: AbortController | null = null
  /** Bumped on logout/account change; cache keys and in-flight work compare against it. */
  private generation = 0

  constructor(private readonly options: {
    config: () => Promise<SpotifyConfig>
    store: SpotifyCredentialStore
    helper: SpotifyHelperTransport
    openExternal: (url: string) => Promise<void>
    fetchImpl?: FetchLike
    workDir: () => Promise<string>
  }) {}

  private get fetchImpl(): FetchLike { return this.options.fetchImpl ?? ((input, init) => fetch(input, init)) }

  get accountGeneration(): number { return this.generation }

  async getCatalogSession(): Promise<SpotifyCatalogSession | null> {
    if (this.catalogSession === undefined) this.catalogSession = await this.options.store.loadCatalog()
    return this.catalogSession
  }

  async getPlaybackSession(): Promise<SpotifyPlaybackSession | null> {
    if (this.playbackSession === undefined) this.playbackSession = await this.options.store.loadPlayback()
    return this.playbackSession
  }

  /** Stable per-account key for cache entries and synthetic IDs. */
  async getAccountKey(): Promise<string | null> {
    return (await this.getCatalogSession())?.userId ?? (await this.getPlaybackSession())?.credentials.username ?? null
  }

  async getStatus(): Promise<SpotifyConnectionStatus> {
    const catalog = await this.getCatalogSession()
    const playback = await this.getPlaybackSession()
    const label = catalog ? (catalog.displayName || catalog.userId) : playback?.credentials.username ?? null
    return {
      catalog: catalog ? 'connected' : 'not-connected',
      playback: this.playbackProblem?.kind ?? (playback ? 'connected' : 'not-connected'),
      accountLabel: label,
      userId: catalog?.userId ?? playback?.credentials.username ?? null,
      expiresAt: catalog?.expiresAt ?? null,
      product: playback?.product ?? null,
      country: playback?.country ?? null,
      playbackMessage: this.playbackProblem?.message ?? null,
    }
  }

  /** Current Web API access token, refreshed once for all concurrent callers. */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const session = await this.getCatalogSession()
    if (!session) throw new ProviderApiError(providerError('NOT_AUTHENTICATED', 'Spotify is not connected', { retryable: false }))
    if (!forceRefresh && session.expiresAt - REFRESH_MARGIN_MS > Date.now()) return session.accessToken
    this.refreshing ??= this.refresh(session).finally(() => { this.refreshing = null })
    return (await this.refreshing).accessToken
  }

  private async refresh(session: SpotifyCatalogSession): Promise<SpotifyCatalogSession> {
    const generation = this.generation
    try {
      const config = await this.options.config()
      const token = await refreshAccessToken(this.fetchImpl, {
        accountsBaseUrl: config.accountsBaseUrl,
        clientId: session.clientId,
        refreshToken: session.refreshToken,
        timeoutMs: config.requestTimeoutMs,
      })
      if (generation !== this.generation) throw new ProviderApiError(providerError('CANCELLED', 'Spotify account changed during refresh', { retryable: true }))
      const next: SpotifyCatalogSession = {
        ...session,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? session.refreshToken,
        expiresAt: token.expiresAt,
        scopes: token.scopes.length ? token.scopes : session.scopes,
      }
      // Persist before use so a rotated refresh token is never lost.
      await this.options.store.saveCatalog(next)
      this.catalogSession = next
      return next
    } catch (error) {
      if (error instanceof OAuthTokenError && (error.revoked || error.status === 400 || error.status === 401)) {
        throw new ProviderApiError(providerError('AUTH_EXPIRED', 'Spotify access was revoked or expired; connect again', { retryable: false }))
      }
      throw error
    }
  }

  async cancelLogin(): Promise<void> {
    this.loginAbort?.abort()
  }

  /**
   * Sign in to the catalog (browser + PKCE) and then to playback (librespot).
   * `target` limits the flow to one half; playback failure leaves the catalog usable.
   */
  async login(
    fetchProfile: (accessToken: string) => Promise<SpotifyUserProfile>,
    target: 'all' | 'catalog' | 'playback' = 'all',
  ): Promise<{ accountChanged: boolean }> {
    this.loginAbort?.abort()
    const abort = new AbortController()
    this.loginAbort = abort
    try {
      const previousAccount = await this.getAccountKey()
      if (target !== 'playback') {
        const config = await this.options.config()
        assertCatalogConfig(config)
        const redirect = config.redirectUri ? parseLoopbackRedirect(config.redirectUri) : { port: 0, path: '/callback' }
        const token = await runPkceFlow({
          fetchImpl: this.fetchImpl,
          openExternal: this.options.openExternal,
          accountsBaseUrl: config.accountsBaseUrl,
          clientId: config.clientId,
          scopes: config.catalogScopes,
          port: redirect.port,
          path: redirect.path,
          timeoutMs: LOGIN_STEP_TIMEOUT_MS,
          signal: abort.signal,
        })
        if (!token.refreshToken) throw new Error('Spotify did not return a refresh token')
        const profile = await fetchProfile(token.accessToken)
        const session: SpotifyCatalogSession = {
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          scopes: token.scopes,
          clientId: config.clientId,
          userId: profile.id,
          displayName: profile.display_name ?? null,
        }
        const playback = await this.getPlaybackSession()
        if (playback && !sameAccount(playback.credentials.username, session.userId)) {
          // Another account's audio credential must never serve this catalog.
          await this.options.store.clearPlayback()
          this.playbackSession = null
        }
        await this.options.store.saveCatalog(session)
        this.catalogSession = session
      }
      if (target !== 'catalog') await this.loginPlayback(abort.signal)
      const accountChanged = previousAccount !== null && previousAccount !== (await this.getAccountKey())
      if (accountChanged) this.generation += 1
      return { accountChanged }
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null
    }
  }

  private async loginPlayback(signal: AbortSignal): Promise<void> {
    this.playbackProblem = null
    const described = findEvent(await this.options.helper.run('describe', {}, { signal }), 'described')
    const clientId = String(described.clientId ?? '')
    const scopes = Array.isArray(described.scopes) ? described.scopes.map(String) : []
    const redirectPath = String(described.redirectPath ?? '/login')
    if (!/^[0-9a-f]{32}$/i.test(clientId) || scopes.length === 0 || !redirectPath.startsWith('/')) {
      throw new Error('Spotify helper returned an invalid playback login description')
    }
    const config = await this.options.config()
    const token = await runPkceFlow({
      fetchImpl: this.fetchImpl,
      openExternal: this.options.openExternal,
      accountsBaseUrl: config.accountsBaseUrl,
      clientId,
      scopes,
      port: 0,
      path: redirectPath,
      timeoutMs: LOGIN_STEP_TIMEOUT_MS,
      signal,
    })
    const events = await this.options.helper.run('login', {
      accessToken: token.accessToken,
      workDir: await this.options.workDir(),
    }, { signal })
    await this.acceptPlaybackCredentials(findEvent(events, 'authenticated'), String(described.librespotVersion ?? '') || null)
  }

  /** Re-validate the stored audio credential (after restart); stores a rotated credential. */
  async checkPlayback(): Promise<boolean> {
    const playback = await this.getPlaybackSession()
    if (!playback) return false
    try {
      const events = await this.options.helper.run('check-session', {
        credentials: playback.credentials,
        workDir: await this.options.workDir(),
      })
      await this.acceptPlaybackCredentials(findEvent(events, 'authenticated'), playback.librespotVersion)
      return true
    } catch (error) {
      if (error instanceof SpotifyHelperError && (error.code === 'credentials-rejected' || error.code === 'not-authenticated')) {
        this.playbackProblem = { kind: 'rejected', message: 'Spotify rejected the playback sign-in; reconnect playback' }
        await this.options.store.clearPlayback()
        this.playbackSession = null
        return false
      }
      if (error instanceof SpotifyHelperError && error.code === 'not-premium') {
        this.playbackProblem = { kind: 'not-premium', message: 'Spotify Premium is required for playback' }
        return false
      }
      throw error
    }
  }

  private async acceptPlaybackCredentials(event: Record<string, unknown>, librespotVersion: string | null): Promise<void> {
    const credentials = event.credentials as SpotifyPlaybackCredentials | undefined
    if (!credentials || typeof credentials.username !== 'string' || typeof credentials.authData !== 'string' || typeof credentials.authType !== 'number') {
      throw new Error('Spotify helper returned invalid playback credentials')
    }
    const catalog = await this.getCatalogSession()
    if (catalog && !sameAccount(catalog.userId, credentials.username)) {
      this.playbackProblem = {
        kind: 'account-mismatch',
        message: 'Playback was signed in with a different Spotify account than the catalog',
      }
      throw new ProviderApiError(providerError('PERMISSION_DENIED', this.playbackProblem.message, { retryable: false }))
    }
    const product = typeof event.product === 'string' ? event.product : null
    const session: SpotifyPlaybackSession = {
      credentials,
      country: typeof event.country === 'string' && event.country ? event.country : null,
      product,
      librespotVersion,
      verifiedAt: Date.now(),
    }
    await this.options.store.savePlayback(session)
    this.playbackSession = session
    this.playbackProblem = product && product !== 'premium'
      ? { kind: 'not-premium', message: 'Spotify Premium is required for playback' }
      : null
  }

  /** Mark the stored audio credential unusable after a helper rejection during playback. */
  async invalidatePlayback(kind: PlaybackProblem, message: string): Promise<void> {
    this.playbackProblem = { kind, message }
    if (kind === 'rejected') {
      await this.options.store.clearPlayback()
      this.playbackSession = null
    }
  }

  async logout(): Promise<void> {
    this.loginAbort?.abort()
    this.generation += 1
    this.catalogSession = null
    this.playbackSession = null
    this.playbackProblem = null
    await this.options.store.clear()
  }
}
