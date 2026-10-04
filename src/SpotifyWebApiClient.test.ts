import { describe, expect, it, vi } from 'vitest'
import { ProviderApiError } from 'puros-provider-sdk'
import { describeWait, SpotifyWebApiClient, type RateLimitBlock } from './SpotifyWebApiClient'

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function client(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, getAccessToken = vi.fn(async () => 'token')) {
  const sleep = vi.fn(async () => {})
  return { sleep, getAccessToken, api: new SpotifyWebApiClient({ baseUrl: 'https://api.spotify.com/v1', getAccessToken, fetchImpl, sleep, maxRetries: 2 }) }
}

describe('Spotify Web API client', () => {
  it('refreshes once on 401 and retries with the new token', async () => {
    const tokens = ['old', 'new']
    const getAccessToken = vi.fn(async (force?: boolean) => (force ? tokens.shift() && tokens[0]! : tokens[0]!))
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => (
      (init?.headers as Record<string, string>).authorization === 'Bearer new' ? json({ id: 'user' }) : json({}, 401)
    ))
    const { api } = client(fetchImpl, getAccessToken)
    await expect(api.getProfile()).resolves.toEqual({ id: 'user' })
    expect(getAccessToken).toHaveBeenCalledWith(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('maps a second 401 to AUTH_EXPIRED', async () => {
    const { api } = client(vi.fn(async () => json({}, 401)))
    await expect(api.getProfile()).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
  })

  it('honours Retry-After for short rate limits and pauses before retrying', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { status: 429, message: 'API rate limit exceeded' } }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json({ id: 'artist' }))
    const { api, sleep } = client(fetchImpl)
    await expect(api.getArtist('0OdUWJ0sBjDrqHygGUXeCF')).resolves.toEqual({ id: 'artist' })
    expect(sleep.mock.calls.some(([ms]) => (ms as number) >= 1_900)).toBe(true)
  })

  it('treats quota exhaustion as RATE_LIMITED without retrying', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { status: 429, message: 'QUOTA_EXCEEDED' } }, 429, { 'retry-after': '30' }))
    const { api } = client(fetchImpl)
    const error = await api.getArtist('0OdUWJ0sBjDrqHygGUXeCF').catch((value: unknown) => value) as ProviderApiError
    expect(error.providerError).toMatchObject({ code: 'RATE_LIMITED', retryable: true, details: { quota: true } })
    expect(error.providerError.retryAfterMs).toBeGreaterThan(29_000)
    expect(error.providerError.message).toMatch(/quota.*try again in about 1 min/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports a long rate-limit block with its wait time and stops asking until it ends', async () => {
    const fetchImpl = vi.fn(async () => json({ error: { status: 429, message: 'API rate limit exceeded' } }, 429, { 'retry-after': '1800' }))
    const { api } = client(fetchImpl)
    const first = await api.getArtist('0OdUWJ0sBjDrqHygGUXeCF').catch((value: unknown) => value) as ProviderApiError
    expect(first.providerError).toMatchObject({ code: 'RATE_LIMITED', details: { quota: false } })
    expect(first.providerError.message).toBe('Spotify is rate-limiting this app; try again in about 30 min')
    const second = await api.getAlbum('4aawyAB9vmqN3uQ7FjRGTy').catch((value: unknown) => value) as ProviderApiError
    expect(second.providerError.code).toBe('RATE_LIMITED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(describeWait(3 * 3_600_000)).toBe('about 3 h')
  })

  it('keeps a quota block across restarts and does not ask Spotify again during it', async () => {
    const saved = new Map<string, RateLimitBlock>()
    const blockStore = {
      scope: async () => 'app-1',
      load: async (scope: string) => saved.get(scope) ?? null,
      save: vi.fn(async (scope: string, block: RateLimitBlock) => { saved.set(scope, block) }),
    }
    const fetchImpl = vi.fn(async () => json({ error: { status: 429, message: 'QUOTA_EXCEEDED' } }, 429, { 'retry-after': '86400' }))
    const options = {
      baseUrl: 'https://api.spotify.com/v1', getAccessToken: async () => 'token',
      fetchImpl, sleep: async () => {}, now: () => 1_000_000, blockStore,
    }
    await expect(new SpotifyWebApiClient(options).getProfile()).rejects.toMatchObject({ providerError: { code: 'RATE_LIMITED' } })
    expect(saved.get('app-1')).toEqual({ until: 1_000_000 + 86_400_000, quota: true })
    const restarted = await new SpotifyWebApiClient(options).getProfile().catch((value: unknown) => value) as ProviderApiError
    expect(restarted.providerError.message).toMatch(/quota.*about 24 h/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not carry one Spotify app\'s block over to another', async () => {
    let scope = 'app-1'
    const saved = new Map<string, RateLimitBlock>()
    const blockStore = {
      scope: async () => scope,
      load: async (key: string) => saved.get(key) ?? null,
      save: vi.fn(async (key: string, block: RateLimitBlock) => { saved.set(key, block) }),
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: { status: 429, message: 'QUOTA_EXCEEDED' } }, 429, { 'retry-after': '86400' }))
      .mockResolvedValueOnce(json({ id: 'user' }))
    const api = new SpotifyWebApiClient({
      baseUrl: 'https://api.spotify.com/v1', getAccessToken: async () => 'token',
      fetchImpl, sleep: async () => {}, now: () => 1_000_000, blockStore,
    })
    await expect(api.getProfile()).rejects.toMatchObject({ providerError: { code: 'RATE_LIMITED' } })
    await expect(api.getProfile()).rejects.toMatchObject({ providerError: { code: 'RATE_LIMITED' } })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    scope = 'app-2'
    await expect(api.getProfile()).resolves.toEqual({ id: 'user' })
    expect(saved.has('app-2')).toBe(false)
  })

  it('paces bursts beyond the token bucket', async () => {
    let now = 1_000_000
    const sleep = vi.fn(async (ms: number) => { now += ms })
    const api = new SpotifyWebApiClient({
      baseUrl: 'https://api.spotify.com/v1', getAccessToken: async () => 'token',
      fetchImpl: vi.fn(async () => json({ items: [], next: null })), sleep, now: () => now,
    })
    for (let index = 0; index < 35; index += 1) await api.getSavedTracks(50, index * 50)
    // 30 immediate, then 5 more at 1/s ≈ 5 s of pacing.
    expect(now - 1_000_000).toBeGreaterThanOrEqual(4_900)
    expect(now - 1_000_000).toBeLessThan(5_500)
  })

  it('keeps search results for hours, per query', async () => {
    let now = 1_000_000
    const fetchImpl = vi.fn(async () => json({ tracks: { items: [], next: null } }))
    const api = new SpotifyWebApiClient({
      baseUrl: 'https://api.spotify.com/v1', getAccessToken: async () => 'token',
      fetchImpl, sleep: async () => {}, now: () => now,
    })
    await api.search('radiohead', ['track'], 10, 0)
    now += 60 * 60_000
    await api.search('radiohead', ['track'], 10, 0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await api.search('radiohead creep', ['track'], 10, 0)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    now += 6 * 60 * 60_000
    await api.search('radiohead', ['track'], 10, 0)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('maps 404, 403 and exhausted 5xx', async () => {
    await expect(client(vi.fn(async () => json({}, 404))).api.getTrack('x')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    await expect(client(vi.fn(async () => json({ error: { message: 'Forbidden' } }, 403))).api.getPlaylistItems('p', 50, 0))
      .rejects.toMatchObject({ providerError: { code: 'PERMISSION_DENIED' } })
    const flaky = vi.fn(async () => json({}, 503))
    await expect(client(flaky).api.getProfile()).rejects.toMatchObject({ providerError: { code: 'PROVIDER_UNAVAILABLE', retryable: true } })
    expect(flaky).toHaveBeenCalledTimes(3)
  })

  it('clamps search to the February 2026 limit and uses /items for playlists', async () => {
    const urls: string[] = []
    const { api } = client(vi.fn(async (url: string) => { urls.push(url); return json({ items: [], next: null }) }))
    await api.search('radiohead', ['track', 'album'], 50, 0)
    await api.getPlaylistItems('37i9dQZF1DXcBWIGoYBM5M', 100, 50)
    const search = new URL(urls[0]!)
    expect(search.pathname).toBe('/v1/search')
    expect(search.searchParams.get('limit')).toBe('10')
    expect(search.searchParams.get('type')).toBe('track,album')
    const items = new URL(urls[1]!)
    expect(items.pathname).toBe('/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/items')
    expect(items.searchParams.get('limit')).toBe('50')
    expect(items.searchParams.get('offset')).toBe('50')
  })

  it('caches entity reads but not library pages', async () => {
    const fetchImpl = vi.fn(async () => json({ items: [], next: null, id: 'a' }))
    const { api } = client(fetchImpl)
    await api.getAlbum('4aawyAB9vmqN3uQ7FjRGTy')
    await api.getAlbum('4aawyAB9vmqN3uQ7FjRGTy')
    await api.getSavedTracks(50, 0)
    await api.getSavedTracks(50, 0)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    api.clearCache()
    await api.getAlbum('4aawyAB9vmqN3uQ7FjRGTy')
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('reports an unreachable API as NETWORK after retries', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    await expect(client(fetchImpl).api.getProfile()).rejects.toMatchObject({ providerError: { code: 'NETWORK', retryable: true } })
  })
})
