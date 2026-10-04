import { ProviderApiError, providerError } from 'puros-provider-sdk'
import type { FetchLike } from './oauth'
import type { SpotifyCatalogClient, SpotifySearchType } from './SpotifyCatalogClient'
import type {
  SpotifyAlbum,
  SpotifyArtist,
  SpotifyCursorPaging,
  SpotifyPaging,
  SpotifyPlaylist,
  SpotifyPlaylistItem,
  SpotifySearchResponse,
  SpotifySimplifiedAlbum,
  SpotifySimplifiedTrack,
  SpotifyTrack,
  SpotifyUserProfile,
} from './types'

const MAX_CONCURRENT_REQUESTS = 4
const MAX_RETRY_AFTER_MS = 60_000
/**
 * Request pacing: 30 per 30 s — bursts of 30, then 1 request/s. Development-mode
 * apps have a low, unpublished limit; this is the rate Music Assistant settled on
 * for a user's own Client ID.
 */
const BUCKET_CAPACITY = 30
const BUCKET_REFILL_PER_SECOND = 1
const CACHE_TTL_MS = 5 * 60_000
/** Search results barely change within hours, and a retyped query is the common repeat. */
const SEARCH_CACHE_TTL_MS = 6 * 60 * 60_000
const CACHE_ENTRIES = 512
/** February 2026: search `limit` is at most 10. */
export const SPOTIFY_SEARCH_MAX_LIMIT = 10

export interface RateLimitBlock { until: number; quota: boolean }

/**
 * Keeps a long 429 block across restarts: asking again during it only extends it.
 * The quota belongs to one Spotify app, so blocks are scoped to the Client ID the
 * token was issued for; another app starts unblocked.
 */
export interface RateLimitBlockStore {
  scope(): Promise<string>
  load(scope: string): Promise<RateLimitBlock | null>
  save(scope: string, block: RateLimitBlock): Promise<void>
}

export interface SpotifyWebApiClientOptions {
  baseUrl: string
  getAccessToken: (forceRefresh?: boolean) => Promise<string>
  fetchImpl?: FetchLike
  timeoutMs?: number
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  blockStore?: RateLimitBlockStore
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** "about 3 min", "about 2 h" — for messages the user reads. */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 90) return `about ${minutes} min`
  return `about ${Math.round(minutes / 60)} h`
}

function rateLimitError(untilMs: number, now: number, quota: boolean): ProviderApiError {
  const wait = Math.max(0, untilMs - now)
  const message = quota
    ? `Spotify Web API quota for this app is exhausted; try again in ${describeWait(wait)}`
    : `Spotify is rate-limiting this app; try again in ${describeWait(wait)}`
  return new ProviderApiError(providerError('RATE_LIMITED', message, { retryable: true, retryAfterMs: Math.round(wait), details: { quota } }))
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

/** Spotify Web API with shared throttling, Retry-After, 401 refresh and a small response cache. */
export class SpotifyWebApiClient implements SpotifyCatalogClient {
  private readonly fetchImpl: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>()
  private running = 0
  private readonly waiting: Array<() => void> = []
  /** A 429 pauses every request until this time, not just the one that saw it. */
  private pausedUntil = 0
  private pausedForQuota = false
  private tokens = BUCKET_CAPACITY
  private tokensAt = 0
  private restoring: { scope: string; done: Promise<void> } | null = null

  constructor(private readonly options: SpotifyWebApiClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  clearCache(): void { this.cache.clear() }

  /** Picks up the saved block of the current Spotify app, once per app; returns that app's scope. */
  private async restoreBlock(): Promise<string | null> {
    const store = this.options.blockStore
    if (!store) return null
    const scope = await store.scope().catch(() => '')
    if (this.restoring?.scope !== scope) {
      // A different app: the previous app's pause does not apply to it.
      this.pausedUntil = 0
      this.pausedForQuota = false
      this.restoring = {
        scope,
        done: store.load(scope).then((block) => {
          if (!block || block.until <= this.now() || this.restoring?.scope !== scope) return
          this.pausedUntil = Math.max(this.pausedUntil, block.until)
          this.pausedForQuota ||= block.quota
        }, () => {}),
      }
    }
    await this.restoring.done
    return scope
  }

  /** Wait for a request token; refills continuously. */
  private async takeToken(): Promise<void> {
    for (;;) {
      const now = this.now()
      if (this.tokensAt === 0) this.tokensAt = now
      this.tokens = Math.min(BUCKET_CAPACITY, this.tokens + ((now - this.tokensAt) / 1000) * BUCKET_REFILL_PER_SECOND)
      this.tokensAt = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / BUCKET_REFILL_PER_SECOND) * 1000))
    }
  }

  private async acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT_REQUESTS) {
      this.running += 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.running -= 1
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}${path}`)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    return url.toString()
  }

  /** `cache`: `true` keeps the response for 5 min, a number for that many ms. */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}, options: { cache?: boolean | number; accessToken?: string } = {}): Promise<T> {
    const url = this.url(path, query)
    if (options.cache) {
      const hit = this.cache.get(url)
      if (hit && hit.expiresAt > this.now()) return hit.value as T
    }
    await this.acquire()
    try {
      const value = await this.request<T>(url, options.accessToken)
      if (options.cache) {
        const ttl = typeof options.cache === 'number' ? options.cache : CACHE_TTL_MS
        if (this.cache.size >= CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(url, { expiresAt: this.now() + ttl, value })
      }
      return value
    } finally {
      this.release()
    }
  }

  private async request<T>(url: string, fixedToken?: string): Promise<T> {
    const maxRetries = this.options.maxRetries ?? 3
    let refreshed = false
    const scope = await this.restoreBlock()
    for (let attempt = 0; ; attempt += 1) {
      const wait = this.pausedUntil - this.now()
      // A long block is not waited out in-process; asking again would only extend it.
      if (wait > MAX_RETRY_AFTER_MS) throw rateLimitError(this.pausedUntil, this.now(), this.pausedForQuota)
      if (wait > 0) await this.sleep(wait)
      await this.takeToken()
      let response: Response
      try {
        const token = fixedToken ?? await this.options.getAccessToken(false)
        response = await this.fetchImpl(url, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        })
      } catch (error) {
        if (error instanceof ProviderApiError) throw error
        if (attempt < maxRetries) {
          await this.sleep(500 * 2 ** attempt)
          continue
        }
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new ProviderApiError(providerError(timedOut ? 'TIMEOUT' : 'NETWORK', 'Spotify Web API is unreachable', { retryable: true }))
      }
      if (response.ok) {
        if (response.status === 204) return undefined as T
        return await response.json() as T
      }
      let body: { error?: { status?: number; message?: string; reason?: string } | string } = {}
      try { body = await response.json() as typeof body } catch { /* empty body */ }
      const message = typeof body.error === 'string' ? body.error : body.error?.message ?? ''
      const reason = typeof body.error === 'object' ? body.error?.reason ?? '' : ''
      if (response.status === 401 && !refreshed && !fixedToken) {
        refreshed = true
        await this.options.getAccessToken(true)
        continue
      }
      if (response.status === 401) {
        throw new ProviderApiError(providerError('AUTH_EXPIRED', 'Spotify access expired; connect again', { retryable: false }))
      }
      if (response.status === 429) {
        const after = retryAfterMs(response) ?? 1_000 * 2 ** attempt
        const quota = /quota/i.test(`${message} ${reason}`)
        const now = this.now()
        // A late answer for a previous app does not pause the current one.
        const current = scope === null || scope === this.restoring?.scope
        if (current) {
          // An expired earlier quota block does not make this one a quota block.
          this.pausedForQuota = (this.pausedUntil > now && this.pausedForQuota) || quota
          this.pausedUntil = Math.max(this.pausedUntil, now + after)
        }
        if ((quota || after > MAX_RETRY_AFTER_MS) && scope !== null) {
          // Only this response's own block, under the app that sent the request.
          void this.options.blockStore?.save(scope, { until: now + after, quota }).catch(() => {})
        }
        if (quota || after > MAX_RETRY_AFTER_MS || attempt >= maxRetries) {
          // Long blocks and quota exhaustion fail now and say when to try again.
          throw rateLimitError(current ? this.pausedUntil : now + after, now, quota)
        }
        continue
      }
      if (response.status === 404) throw new ProviderApiError(providerError('NOT_FOUND', 'Spotify item was not found', { retryable: false }))
      if (response.status === 403) {
        throw new ProviderApiError(providerError('PERMISSION_DENIED', message
          ? `Spotify refused the request: ${message}`
          : 'Spotify refused the request (the app may lack access to this endpoint)', { retryable: false, details: { status: 403 } }))
      }
      if (response.status >= 500 && attempt < maxRetries) {
        await this.sleep(500 * 2 ** attempt)
        continue
      }
      throw new ProviderApiError(providerError(response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'INTERNAL',
        `Spotify Web API request failed (${response.status})`, { retryable: response.status >= 500, details: { status: response.status } }))
    }
  }

  getProfile(accessToken?: string): Promise<SpotifyUserProfile> {
    return this.get('/me', {}, { accessToken })
  }

  search(query: string, types: SpotifySearchType[], limit: number, offset: number): Promise<SpotifySearchResponse> {
    return this.get('/search', {
      q: query,
      type: types.join(','),
      limit: clamp(limit, 1, SPOTIFY_SEARCH_MAX_LIMIT),
      offset: clamp(offset, 0, 1000),
      market: 'from_token',
    }, { cache: SEARCH_CACHE_TTL_MS })
  }

  getArtist(id: string): Promise<SpotifyArtist> {
    return this.get(`/artists/${encodeURIComponent(id)}`, {}, { cache: true })
  }

  getArtistAlbums(id: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifySimplifiedAlbum>> {
    return this.get(`/artists/${encodeURIComponent(id)}/albums`, {
      include_groups: 'album,single,compilation',
      limit: clamp(limit, 1, 50),
      offset: Math.max(0, offset),
      market: 'from_token',
    }, { cache: true })
  }

  getAlbum(id: string): Promise<SpotifyAlbum> {
    return this.get(`/albums/${encodeURIComponent(id)}`, { market: 'from_token' }, { cache: true })
  }

  getAlbumTracks(id: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifySimplifiedTrack>> {
    return this.get(`/albums/${encodeURIComponent(id)}/tracks`, {
      limit: clamp(limit, 1, 50), offset: Math.max(0, offset), market: 'from_token',
    }, { cache: true })
  }

  getTrack(id: string): Promise<SpotifyTrack> {
    return this.get(`/tracks/${encodeURIComponent(id)}`, { market: 'from_token' }, { cache: true })
  }

  getSavedTracks(limit: number, offset: number) {
    return this.get<SpotifyPaging<{ added_at?: string; track: SpotifyTrack | null }>>('/me/tracks', {
      limit: clamp(limit, 1, 50), offset: Math.max(0, offset), market: 'from_token',
    })
  }

  getSavedAlbums(limit: number, offset: number) {
    return this.get<SpotifyPaging<{ added_at?: string; album: SpotifyAlbum | null }>>('/me/albums', {
      limit: clamp(limit, 1, 50), offset: Math.max(0, offset), market: 'from_token',
    })
  }

  async getFollowedArtists(limit: number, after: string | null): Promise<SpotifyCursorPaging<SpotifyArtist>> {
    const response = await this.get<{ artists: SpotifyCursorPaging<SpotifyArtist> }>('/me/following', {
      type: 'artist', limit: clamp(limit, 1, 50), after: after ?? undefined,
    })
    return response.artists
  }

  getMyPlaylists(limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylist | null>> {
    return this.get('/me/playlists', { limit: clamp(limit, 1, 50), offset: Math.max(0, offset) })
  }

  getPlaylist(id: string): Promise<SpotifyPlaylist> {
    // Metadata only; items are paged separately so large playlists stay bounded.
    return this.get(`/playlists/${encodeURIComponent(id)}`, {
      fields: 'id,name,description,images,owner(id,display_name),collaborative,public,snapshot_id,external_urls,items(total),tracks(total)',
    })
  }

  getPlaylistItems(id: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylistItem>> {
    return this.get(`/playlists/${encodeURIComponent(id)}/items`, {
      limit: clamp(limit, 1, 50), offset: Math.max(0, offset), market: 'from_token', additional_types: 'track',
    })
  }
}
