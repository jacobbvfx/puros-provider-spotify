import { describe, expect, it, vi } from 'vitest'
import { ProviderApiError, providerError, type ProviderLibraryRecordV1 } from 'puros-provider-sdk'
import type { SpotifyCatalogClient } from './SpotifyCatalogClient'
import { SpotifyLibrarySync } from './SpotifyLibrarySync'
import type { SpotifyPlaylist, SpotifyTrack } from './types'
import type { PlaylistSnapshotCache } from './playlistCache'
import type { LibrarySnapshot, LibrarySnapshotStore } from './librarySnapshot'

const id = (n: number | string) => String(n).padStart(22, '0').replace(/[^0-9A-Za-z]/g, 'x').slice(-22)

function track(n: number, extra: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: id(`t${n}`), name: `Track ${n}`, duration_ms: 1000 * n, track_number: n, disc_number: 1,
    artists: [{ id: id(`ar${n % 3}`), name: `Artist ${n % 3}` }],
    album: { id: id(`al${n % 2}`), name: `Album ${n % 2}`, album_type: 'album', images: [], artists: [{ id: id(`ar${n % 3}`), name: `Artist ${n % 3}` }] },
    external_ids: { isrc: `ISRC${n}` },
    ...extra,
  }
}

function paged<T>(items: T[], limit: number, offset: number) {
  const slice = items.slice(offset, offset + limit)
  return { items: slice, total: items.length, next: offset + limit < items.length ? 'next' : null }
}

function fakeClient(options: {
  liked?: SpotifyTrack[]
  playlists?: SpotifyPlaylist[]
  items?: Record<string, Array<{ item?: unknown; is_local?: boolean }>>
  itemErrors?: Record<string, ProviderApiError>
} = {}) {
  const liked = options.liked ?? [track(1), track(2), track(3)]
  const client: SpotifyCatalogClient = {
    getProfile: vi.fn(),
    search: vi.fn(),
    getArtist: vi.fn(),
    getArtistAlbums: vi.fn(),
    getAlbum: vi.fn(async (albumId: string) => ({ id: albumId, name: 'Big Album', images: [], artists: [] })),
    getAlbumTracks: vi.fn(async (_albumId: string, limit: number, offset: number) => paged(
      Array.from({ length: 60 }, (_, i) => track(100 + i, { album: null })), limit, offset,
    )),
    getTrack: vi.fn(),
    getSavedTracks: vi.fn(async (limit: number, offset: number) => {
      const page = paged(liked, limit, offset)
      return { ...page, items: page.items.map((value) => ({ track: value })) }
    }),
    getSavedAlbums: vi.fn(async () => ({
      items: [{ album: {
        id: id('big'), name: 'Big Album', images: [], artists: [{ id: id('ar9'), name: 'Artist 9' }],
        tracks: { ...paged(Array.from({ length: 60 }, (_, i) => track(100 + i, { album: null })), 50, 0) },
      } }],
      total: 1, next: null,
    })),
    getFollowedArtists: vi.fn(async (_limit: number, after: string | null) => (after
      ? { items: [{ id: id('fol2'), name: 'Followed 2' }], next: null, cursors: { after: null } }
      : { items: [{ id: id('fol1'), name: 'Followed 1' }], next: 'next', cursors: { after: 'cursor-1' } })),
    getMyPlaylists: vi.fn(async (limit: number, offset: number) => paged(options.playlists ?? [], limit, offset)),
    getPlaylist: vi.fn(async (playlistId: string) => (options.playlists ?? []).find((value) => value.id === playlistId)!),
    getPlaylistItems: vi.fn(async (playlistId: string, limit: number, offset: number) => {
      const error = options.itemErrors?.[playlistId]
      if (error) throw error
      return paged(options.items?.[playlistId] ?? [], limit, offset) as never
    }),
  }
  return client
}

async function drain(sync: SpotifyLibrarySync, limit = 25) {
  const records: ProviderLibraryRecordV1[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await sync.enumerate({ cursor, limit })
    records.push(...page.records)
    expect(page.complete).toBe(page.nextCursor === null)
    cursor = page.nextCursor
    pages += 1
  } while (cursor && pages < 1000)
  return records
}

const account = async () => ({ accountKey: 'user-1', userId: 'user-1' })

describe('Spotify host-mirror library sync', () => {
  it('builds a complete deduplicated snapshot over bounded pages', async () => {
    const own: SpotifyPlaylist = { id: id('pl1'), name: 'Mine', owner: { id: 'user-1' }, snapshot_id: 's1', items: { total: 5 } }
    const client = fakeClient({
      playlists: [own],
      items: {
        [own.id]: [
          { item: track(1) },
          { is_local: true, item: { id: null, type: 'track' } },
          { item: { type: 'episode', id: id('ep') } },
          { item: track(2) },
          { item: track(1) },
        ],
      },
    })
    const emit = vi.fn(async () => {})
    const records = await drain(new SpotifyLibrarySync({ client, getAccount: account, emit }))
    const tracks = records.filter((record) => record.type === 'track')
    expect(new Set(tracks.map((record) => record.value.sourceId)).size).toBe(tracks.length)
    expect(tracks.length).toBe(3 + 60)
    expect(records.filter((record) => record.type === 'artist').map((record) => record.value.sourceId)).toEqual(
      expect.arrayContaining([id('fol1'), id('fol2'), id('ar9')]),
    )
    // Liked Songs: synthetic, account-scoped playlist in saved order.
    const liked = records.find((record) => record.type === 'playlist' && record.value.title === 'Liked Songs')
    expect(liked?.value.sourceId).toBe('liked-songs-user-1')
    const memberships = records.filter((record) => record.type === 'playlistTrack').map((record) => record.value)
    expect(memberships.filter((value) => value.playlistSourceId === 'liked-songs-user-1').map((value) => value.position)).toEqual([0, 1, 2])
    // Playlist keeps original positions (gaps for local/episode) and repeats.
    expect(memberships.filter((value) => value.playlistSourceId === own.id)).toEqual([
      { playlistSourceId: own.id, trackSourceId: id('t1'), position: 0 },
      { playlistSourceId: own.id, trackSourceId: id('t2'), position: 3 },
      { playlistSourceId: own.id, trackSourceId: id('t1'), position: 4 },
    ])
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'library.sync.progress', label: 'Spotify library fetched' }))
  })

  it('keeps foreign playlists whose items are not readable as metadata only, with a warning', async () => {
    const foreign: SpotifyPlaylist = { id: id('pl2'), name: 'Editorial', owner: { id: 'spotify' }, items: { total: 50 } }
    const emit = vi.fn(async () => {})
    const records = await drain(new SpotifySyncFactory(fakeClient({
      playlists: [foreign],
      itemErrors: { [foreign.id]: new ProviderApiError(providerError('PERMISSION_DENIED', 'Forbidden', { retryable: false })) },
    }), emit).sync)
    expect(records.some((record) => record.type === 'playlist' && record.value.sourceId === foreign.id)).toBe(true)
    expect(records.some((record) => record.type === 'playlistTrack' && record.value.playlistSourceId === foreign.id)).toBe(false)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', code: 'spotify-playlist-items-unavailable' }))
  })

  it('fails closed on a later page error and never reports completion', async () => {
    const own: SpotifyPlaylist = { id: id('pl1'), name: 'Mine', owner: { id: 'user-1' } }
    const sync = new SpotifyLibrarySync({
      client: fakeClient({ playlists: [own], itemErrors: { [own.id]: new ProviderApiError(providerError('NETWORK', 'offline', { retryable: true })) } }),
      getAccount: account,
      emit: async () => {},
    })
    await expect(drain(sync)).rejects.toMatchObject({ providerError: { code: 'NETWORK' } })
  })

  it('rejects stale, replayed or foreign-account cursors', async () => {
    const sync = new SpotifyLibrarySync({ client: fakeClient(), getAccount: account, emit: async () => {} })
    const first = await sync.enumerate({ limit: 2 })
    expect(first.nextCursor).toBeTruthy()
    await sync.enumerate({ cursor: first.nextCursor, limit: 2 })
    await expect(sync.enumerate({ cursor: first.nextCursor, limit: 2 })).rejects.toMatchObject({ providerError: { code: 'INVALID_ARGUMENT' } })
    await expect(sync.enumerate({ cursor: 'forged.1', limit: 2 })).rejects.toMatchObject({ providerError: { code: 'INVALID_ARGUMENT' } })

    let key = 'user-1'
    const switching = new SpotifyLibrarySync({ client: fakeClient(), getAccount: async () => ({ accountKey: key, userId: key }), emit: async () => {} })
    const page = await switching.enumerate({ limit: 2 })
    key = 'user-2'
    await expect(switching.enumerate({ cursor: page.nextCursor, limit: 2 })).rejects.toMatchObject({ providerError: { code: 'INVALID_ARGUMENT' } })
  })

  it('restarts a playlist whose snapshot changed while paging and holds memberships until verified', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ item: track(i + 1) }))
    const own: SpotifyPlaylist = { id: id('pl1'), name: 'Mine', owner: { id: 'user-1' }, snapshot_id: 'v1' }
    const client = fakeClient({ playlists: [own], items: { [own.id]: items } })
    let snapshots = ['v2', 'v2']
    client.getPlaylist = vi.fn(async () => ({ ...own, snapshot_id: snapshots.shift() ?? 'v2' }))
    const records = await drain(new SpotifyLibrarySync({ client, getAccount: account, emit: async () => {} }))
    const positions = records.filter((record) => record.type === 'playlistTrack' && record.value.playlistSourceId === own.id)
      .map((record) => (record.value as { position: number }).position)
    expect(positions).toEqual(Array.from({ length: 60 }, (_, i) => i))
    snapshots = []
  })

  it('rebuilds unchanged playlists from the snapshot cache and refetches changed ones', async () => {
    const cache = memoryCache()
    const own: SpotifyPlaylist = { id: id('pl1'), name: 'Mine', owner: { id: 'user-1' }, snapshot_id: 'v1' }
    const items = [{ item: track(1) }, { is_local: true, item: null }, { item: track(2) }, { item: track(1) }]
    const client = fakeClient({ playlists: [own], items: { [own.id]: items } })
    const run = async () => drain(new SpotifyLibrarySync({ client, getAccount: account, emit: async () => {}, playlistCache: cache }))
    const memberships = (records: ProviderLibraryRecordV1[]) => records
      .filter((record) => record.type === 'playlistTrack' && record.value.playlistSourceId === own.id)
      .map((record) => record.value)

    const first = await run()
    expect(client.getPlaylistItems).toHaveBeenCalledTimes(1)
    const second = await run()
    expect(client.getPlaylistItems).toHaveBeenCalledTimes(1)
    // Same positions (with the local-file gap), repeats, and track records as a fetched sync.
    expect(memberships(second)).toEqual(memberships(first))
    expect(second.filter((record) => record.type === 'track').map((record) => record.value.sourceId).sort())
      .toEqual(first.filter((record) => record.type === 'track').map((record) => record.value.sourceId).sort())

    own.snapshot_id = 'v2'
    await run()
    expect(client.getPlaylistItems).toHaveBeenCalledTimes(2)
  })

  it('rebuilds unchanged Liked Songs and saved albums from the cache and refetches them after a change', async () => {
    const cache = memoryCache()
    const liked = Array.from({ length: 120 }, (_, i) => track(i + 1))
    const client = fakeClient({ liked })
    const run = async () => drain(new SpotifyLibrarySync({ client, getAccount: account, emit: async () => {}, playlistCache: cache }))
    const byType = (records: ProviderLibraryRecordV1[], type: 'track' | 'album') => records
      .filter((record) => record.type === type)
      .map((record) => record.value as { sourceId: string })
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    const snapshot = (records: ProviderLibraryRecordV1[]) => ({
      likes: records.filter((record) => record.type === 'playlistTrack').map((record) => record.value),
      tracks: byType(records, 'track'),
      albums: byType(records, 'album'),
    })

    const first = await run()
    // Three pages of likes plus one check that the list did not change while paging.
    expect(client.getSavedTracks).toHaveBeenCalledTimes(4)
    expect(client.getAlbumTracks).toHaveBeenCalledTimes(1)
    expect(client.getAlbum).not.toHaveBeenCalled()

    const second = await run()
    expect(client.getSavedTracks).toHaveBeenCalledTimes(5)
    expect(client.getSavedAlbums).toHaveBeenCalledTimes(2)
    expect(client.getAlbumTracks).toHaveBeenCalledTimes(1)
    expect(snapshot(second)).toEqual(snapshot(first))

    liked.unshift(track(500))
    const third = await run()
    expect(client.getSavedTracks).toHaveBeenCalledTimes(5 + 4)
    expect(snapshot(third).likes[0]).toEqual({ playlistSourceId: 'liked-songs-user-1', trackSourceId: id('t500'), position: 0 })
  })

  it('restarts Liked Songs when the list changes while paging', async () => {
    const liked = Array.from({ length: 60 }, (_, i) => track(i + 1))
    const client = fakeClient({ liked })
    const original = client.getSavedTracks
    let changed = false
    client.getSavedTracks = vi.fn(async (limit: number, offset: number) => {
      if (offset === 50 && !changed) {
        changed = true
        liked.unshift(track(500))
      }
      return original(limit, offset)
    })
    const records = await drain(new SpotifyLibrarySync({ client, getAccount: account, emit: async () => {} }))
    const positions = records.filter((record) => record.type === 'playlistTrack').map((record) => record.value)
    expect(positions).toHaveLength(61)
    expect(positions[0]).toEqual({ playlistSourceId: 'liked-songs-user-1', trackSourceId: id('t500'), position: 0 })
  })

  it('replays a recent complete sync without asking Spotify, unless a full resync is requested', async () => {
    let now = 1_000_000
    const saved = new Map<string, LibrarySnapshot>()
    const librarySnapshots: LibrarySnapshotStore = {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, snapshot) => { saved.set(key, structuredClone(snapshot)) },
    }
    const client = fakeClient()
    const sync = new SpotifyLibrarySync({
      client, getAccount: account, emit: async () => {}, librarySnapshots,
      refreshIntervalMs: 12 * 3_600_000, now: () => now,
    })
    const calls = () => vi.mocked(client.getSavedTracks).mock.calls.length
    const first = await drain(sync)
    expect(calls()).toBe(1)
    expect(saved.get('user-1')?.syncedAt).toBe(1_000_000)

    now += 11 * 3_600_000
    const replayed = await drain(sync)
    expect(calls()).toBe(1)
    expect(replayed).toEqual(first)

    const forced = await sync.enumerate({ limit: 500, fullResync: true })
    expect(forced.complete).toBe(true)
    expect(calls()).toBe(2)
    expect(saved.get('user-1')?.syncedAt).toBe(now)

    now += 12 * 3_600_000
    await drain(sync)
    expect(calls()).toBe(3)
  })

  it('does not keep a snapshot of a sync that failed part-way', async () => {
    const saved = new Map<string, LibrarySnapshot>()
    const own: SpotifyPlaylist = { id: id('pl1'), name: 'Mine', owner: { id: 'user-1' } }
    const sync = new SpotifyLibrarySync({
      client: fakeClient({ playlists: [own], itemErrors: { [own.id]: new ProviderApiError(providerError('RATE_LIMITED', 'slow down', { retryable: true })) } }),
      getAccount: account,
      emit: async () => {},
      librarySnapshots: { load: async (key) => saved.get(key) ?? null, save: async (key, snapshot) => { saved.set(key, snapshot) } },
      refreshIntervalMs: 12 * 3_600_000,
    })
    await expect(drain(sync)).rejects.toMatchObject({ providerError: { code: 'RATE_LIMITED' } })
    expect(saved.size).toBe(0)
  })

  it('requires a connected account', async () => {
    const sync = new SpotifyLibrarySync({ client: fakeClient(), getAccount: async () => null, emit: async () => {} })
    await expect(sync.enumerate({})).rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
  })
})

function memoryCache(): PlaylistSnapshotCache {
  const store = new Map<string, unknown[]>()
  return {
    load: async <T,>(accountKey: string, collectionId: string, snapshotId: string) =>
      (store.get(`${accountKey}/${collectionId}/${snapshotId}`) as T[] | undefined) ?? null,
    save: async <T,>(accountKey: string, collectionId: string, snapshotId: string, items: T[]) => {
      store.set(`${accountKey}/${collectionId}/${snapshotId}`, structuredClone(items))
    },
  }
}

class SpotifySyncFactory {
  readonly sync: SpotifyLibrarySync
  constructor(client: SpotifyCatalogClient, emit: (event: unknown) => Promise<void>) {
    this.sync = new SpotifyLibrarySync({ client, getAccount: account, emit: emit as never })
  }
}
