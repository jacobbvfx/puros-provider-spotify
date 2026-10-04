import { randomUUID } from 'node:crypto'
import {
  ProviderApiError,
  providerError,
  type ProviderEventV1,
  type ProviderLibraryRecordV1,
  type ProviderLibrarySyncPageV1,
  type ProviderLibrarySyncRequestV1,
  type ProviderPlaylistTrackV1,
} from 'puros-provider-sdk'
import { LibraryRecordEmitter } from './libraryRecords'
import type { LibrarySnapshotStore } from './librarySnapshot'
import { likedSongsPlaylistId, mapPlaylist, playlistItemTrack } from './mapping'
import type { SpotifyCatalogClient } from './SpotifyCatalogClient'
import {
  albumSubset,
  listFingerprint,
  trackSubset,
  type CachedPlaylistItem,
  type CachedSavedAlbum,
  type PlaylistSnapshotCache,
} from './playlistCache'
import type { SpotifyAlbum, SpotifyPaging, SpotifyPlaylist, SpotifyTrack } from './types'

const API_PAGE = 50
const MAX_SECTION_RESTARTS = 2
const MAX_PLAYLISTS = 10_000
/** Automatic syncs within this long of a complete one replay it; the Sync button always asks Spotify. */
export const LIBRARY_REFRESH_INTERVAL_MS = 12 * 60 * 60_000
/** Cache key of the saved-albums section; never a 22-character Spotify ID. */
const SAVED_ALBUMS_CACHE_ID = 'saved-albums'

function likedFingerprint(page: SpotifyPaging<{ added_at?: string; track: SpotifyTrack | null }>): string {
  return listFingerprint(page.total, page.items.map((item) => `${item.track?.id ?? ''}@${item.added_at ?? ''}`))
}

function savedAlbumsFingerprint(page: SpotifyPaging<{ added_at?: string; album: SpotifyAlbum | null }>): string {
  return listFingerprint(page.total, page.items.map((item) => `${item.album?.id ?? ''}@${item.added_at ?? ''}`))
}

type Phase = 'liked' | 'albums' | 'artists' | 'playlist-list' | 'playlist-items' | 'done'

interface SyncState {
  token: string
  accountKey: string
  userId: string | null
  seq: number
  phase: Phase
  offset: number
  after: string | null
  restarts: number
  /** The current section's list endpoint is exhausted; only queued follow-up work remains. */
  listDone: boolean
  /** Liked Songs / current playlist memberships are held until their list is verified unchanged. */
  heldMemberships: ProviderPlaylistTrackV1[]
  /** Items of Liked Songs or the playlist being paged, saved to the snapshot cache once it is verified. */
  heldItems: CachedPlaylistItem[]
  /** Version of the Liked Songs / saved-albums list seen on its first page. */
  fingerprint: string
  heldAlbums: CachedSavedAlbum[]
  likedSeen: Set<string>
  albumQueue: Array<{ album: SpotifyAlbum; entry: CachedSavedAlbum; offset: number }>
  playlists: SpotifyPlaylist[]
  playlistIndex: number
  pending: ProviderLibraryRecordV1[]
  emitter: LibraryRecordEmitter
  processed: number
  /** Everything handed to the host, saved as the snapshot once the sync completes; null while replaying one. */
  emitted: ProviderLibraryRecordV1[] | null
  /** When the replayed snapshot was synced. */
  replayedFrom: number | null
}

function expired(): ProviderApiError {
  return new ProviderApiError(providerError('INVALID_ARGUMENT', 'Spotify library cursor has expired; start a new sync', { retryable: true }))
}

function changedDuringSync(what: string): ProviderApiError {
  return new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', `${what} kept changing during sync; try again`, { retryable: true }))
}

/**
 * Host-mirror snapshot builder. Pages are produced lazily from bounded API
 * pages; `complete: true` is set only after every section succeeded. Any API
 * failure propagates, so the host never reconciles against a partial snapshot.
 */
export class SpotifyLibrarySync {
  private state: SyncState | null = null

  constructor(private readonly options: {
    client: SpotifyCatalogClient
    getAccount: () => Promise<{ accountKey: string; userId: string | null } | null>
    emit: (event: ProviderEventV1) => Promise<void>
    playlistCache?: PlaylistSnapshotCache
    librarySnapshots?: LibrarySnapshotStore
    /** How long a complete sync is replayed instead of asking Spotify again; `fullResync` always asks. */
    refreshIntervalMs?: number
    now?: () => number
  }) {}

  private now(): number { return (this.options.now ?? Date.now)() }

  private nextPlaylist(state: SyncState): void {
    state.playlistIndex += 1
    state.offset = 0
    state.restarts = 0
    state.heldMemberships = []
    state.heldItems = []
  }

  reset(): void { this.state = null }

  async enumerate(request: ProviderLibrarySyncRequestV1): Promise<ProviderLibrarySyncPageV1> {
    const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(500, request.limit!)) : 100
    const account = await this.options.getAccount()
    if (!account) throw new ProviderApiError(providerError('NOT_AUTHENTICATED', 'Spotify is not connected', { retryable: false }))
    let state: SyncState
    if (!request.cursor) {
      state = this.start(account)
      if (!request.fullResync) await this.replayRecent(state)
    } else {
      const current = this.state
      if (!current || request.cursor !== `${current.token}.${current.seq}` || current.accountKey !== account.accountKey) {
        this.state = null
        throw expired()
      }
      state = current
    }
    try {
      while (state.pending.length < limit && state.phase !== 'done') await this.step(state)
    } catch (error) {
      this.state = null
      throw error
    }
    const records = state.pending.splice(0, limit)
    state.processed += records.length
    state.emitted?.push(...records)
    const complete = state.phase === 'done' && state.pending.length === 0
    await this.options.emit({
      type: 'library.sync.progress',
      processed: state.processed,
      label: complete ? 'Spotify library fetched' : 'Fetching Spotify library',
    })
    if (complete) {
      this.state = null
      const syncedAt = state.replayedFrom ?? this.now()
      if (state.emitted && this.options.librarySnapshots) {
        await this.options.librarySnapshots.save(state.accountKey, { syncedAt, records: state.emitted }).catch(() => {})
      }
      return { records, nextCursor: null, complete: true, checkpoint: Math.floor(syncedAt / 1000) }
    }
    state.seq += 1
    return { records, nextCursor: `${state.token}.${state.seq}`, complete: false }
  }

  private start(account: { accountKey: string; userId: string | null }): SyncState {
    const pending: ProviderLibraryRecordV1[] = []
    const state: SyncState = {
      token: randomUUID().replace(/-/g, ''),
      accountKey: account.accountKey,
      userId: account.userId,
      seq: 0,
      phase: 'liked',
      offset: 0,
      after: null,
      restarts: 0,
      listDone: false,
      heldMemberships: [],
      heldItems: [],
      fingerprint: '',
      heldAlbums: [],
      likedSeen: new Set(),
      albumQueue: [],
      playlists: [],
      playlistIndex: 0,
      pending,
      emitter: new LibraryRecordEmitter((record) => pending.push(record)),
      processed: 0,
      emitted: [],
      replayedFrom: null,
    }
    state.emitter.playlist({
      sourceId: likedSongsPlaylistId(account.accountKey),
      title: 'Liked Songs',
      description: 'Your saved Spotify tracks',
      editable: false,
    })
    this.state = state
    return state
  }

  /** A complete sync younger than the refresh interval is handed over again without asking Spotify. */
  private async replayRecent(state: SyncState): Promise<void> {
    const interval = this.options.refreshIntervalMs ?? 0
    if (interval <= 0 || !this.options.librarySnapshots) return
    const snapshot = await this.options.librarySnapshots.load(state.accountKey).catch(() => null)
    const age = snapshot ? this.now() - snapshot.syncedAt : Infinity
    if (!snapshot || age < 0 || age >= interval) return
    state.pending.splice(0, state.pending.length, ...snapshot.records)
    state.phase = 'done'
    state.emitted = null
    state.replayedFrom = snapshot.syncedAt
  }

  private advance(state: SyncState, phase: Phase): void {
    state.phase = phase
    state.offset = 0
    state.after = null
    state.restarts = 0
    state.listDone = false
    state.heldMemberships = []
    state.heldItems = []
    state.fingerprint = ''
    state.heldAlbums = []
  }

  private async loadCached<T>(state: SyncState, collectionId: string, version: string): Promise<T[] | null> {
    return await this.options.playlistCache?.load<T>(state.accountKey, collectionId, version).catch(() => null) ?? null
  }

  private async saveCached<T>(state: SyncState, collectionId: string, version: string, items: T[]): Promise<void> {
    await this.options.playlistCache?.save<T>(state.accountKey, collectionId, version, items).catch(() => {})
  }

  /**
   * Saved under the version seen on the first page: a change while paging moves
   * the total or the newest page, so that version is never matched again.
   */
  private async finishAlbums(state: SyncState): Promise<void> {
    await this.saveCached(state, SAVED_ALBUMS_CACHE_ID, state.fingerprint, state.heldAlbums)
    this.advance(state, 'artists')
  }

  private async step(state: SyncState): Promise<void> {
    const { client } = this.options
    switch (state.phase) {
      case 'liked': {
        const page = await client.getSavedTracks(API_PAGE, state.offset)
        const likedId = likedSongsPlaylistId(state.accountKey)
        if (state.offset === 0) {
          // Unchanged since the last sync: rebuild from the cache instead of paging every like.
          state.fingerprint = likedFingerprint(page)
          const cached = await this.loadCached<CachedPlaylistItem>(state, likedId, state.fingerprint)
          if (cached) {
            const memberships: ProviderPlaylistTrackV1[] = []
            for (const item of cached) {
              if (state.emitter.track(item.track)) {
                memberships.push({ playlistSourceId: likedId, trackSourceId: item.track.id!, position: item.position })
              }
            }
            state.emitter.memberships(memberships)
            this.advance(state, 'albums')
            return
          }
        }
        page.items.forEach((item, index) => {
          const track = item.track
          if (!track || !state.emitter.track(track)) return
          // A like added mid-sync shifts offsets; a track appears in Liked Songs at most once.
          if (state.likedSeen.has(track.id!)) return
          state.likedSeen.add(track.id!)
          state.heldMemberships.push({ playlistSourceId: likedId, trackSourceId: track.id!, position: state.offset + index })
          state.heldItems.push({ position: state.offset + index, track: trackSubset(track) })
        })
        state.offset += page.items.length
        if (page.next && page.items.length > 0) return
        // A single page is one consistent response; a longer list must not have changed while paging.
        if (state.offset > API_PAGE && likedFingerprint(await client.getSavedTracks(API_PAGE, 0)) !== state.fingerprint) {
          if (++state.restarts > MAX_SECTION_RESTARTS) throw changedDuringSync('Liked Songs')
          state.offset = 0
          state.likedSeen.clear()
          state.heldMemberships = []
          state.heldItems = []
          return
        }
        state.emitter.memberships(state.heldMemberships)
        await this.saveCached(state, likedId, state.fingerprint, state.heldItems)
        this.advance(state, 'albums')
        return
      }
      case 'albums': {
        const queued = state.albumQueue[0]
        if (queued) {
          const page = await client.getAlbumTracks(queued.album.id!, API_PAGE, queued.offset)
          for (const track of page.items) {
            if (state.emitter.track(track, queued.album)) queued.entry.tracks.push(trackSubset(track as SpotifyTrack))
          }
          queued.offset += page.items.length
          if (!page.next || page.items.length === 0) state.albumQueue.shift()
          if (state.albumQueue.length === 0 && state.listDone) await this.finishAlbums(state)
          return
        }
        if (state.listDone) {
          await this.finishAlbums(state)
          return
        }
        const page = await client.getSavedAlbums(API_PAGE, state.offset)
        if (state.offset === 0) {
          state.fingerprint = savedAlbumsFingerprint(page)
          const cached = await this.loadCached<CachedSavedAlbum>(state, SAVED_ALBUMS_CACHE_ID, state.fingerprint)
          if (cached) {
            for (const entry of cached) {
              state.emitter.album(entry.album, entry.totalDiscs)
              for (const track of entry.tracks) state.emitter.track(track, entry.album)
            }
            this.advance(state, 'artists')
            return
          }
        }
        for (const item of page.items) {
          const album = item.album
          if (!album?.id) continue
          const tracks = album.tracks?.items ?? []
          const discs = tracks.reduce((max, track) => Math.max(max, track.disc_number ?? 1), 1)
          const totalDiscs = album.tracks?.next ? null : discs
          state.emitter.album(album, totalDiscs)
          const entry: CachedSavedAlbum = { album: albumSubset(album)!, totalDiscs, tracks: [] }
          state.heldAlbums.push(entry)
          for (const track of tracks) {
            if (state.emitter.track(track, album)) entry.tracks.push(trackSubset(track as SpotifyTrack))
          }
          if (album.tracks?.next) state.albumQueue.push({ album, entry, offset: tracks.length })
        }
        state.offset += page.items.length
        if (!page.next || page.items.length === 0) {
          state.listDone = true
          if (state.albumQueue.length === 0) await this.finishAlbums(state)
        }
        return
      }
      case 'artists': {
        const page = await client.getFollowedArtists(API_PAGE, state.after)
        for (const artist of page.items) state.emitter.artist(artist)
        const after = page.cursors?.after ?? null
        if (!page.next || !after || page.items.length === 0) this.advance(state, 'playlist-list')
        else state.after = after
        return
      }
      case 'playlist-list': {
        const page = await client.getMyPlaylists(API_PAGE, state.offset)
        for (const playlist of page.items) {
          if (playlist?.id) state.playlists.push(playlist)
        }
        if (state.playlists.length > MAX_PLAYLISTS) {
          throw new ProviderApiError(providerError('INTERNAL', 'Spotify returned more playlists than Puros can mirror', { retryable: false }))
        }
        state.offset += page.items.length
        if (!page.next || page.items.length === 0) {
          this.advance(state, 'playlist-items')
          state.playlistIndex = 0
        }
        return
      }
      case 'playlist-items': {
        const playlist = state.playlists[state.playlistIndex]
        if (!playlist) {
          this.advance(state, 'done')
          return
        }
        if (state.offset === 0 && state.restarts === 0) {
          state.emitter.playlist(mapPlaylist(playlist, state.userId))
          // Unchanged since the last sync: rebuild from the snapshot cache without paging.
          const cached = playlist.snapshot_id
            ? await this.options.playlistCache?.load(state.accountKey, playlist.id, playlist.snapshot_id).catch(() => null)
            : null
          if (cached) {
            const memberships: ProviderPlaylistTrackV1[] = []
            for (const item of cached) {
              if (state.emitter.track(item.track)) {
                memberships.push({ playlistSourceId: playlist.id, trackSourceId: item.track.id!, position: item.position })
              }
            }
            state.emitter.memberships(memberships)
            this.nextPlaylist(state)
            return
          }
        }
        let page
        try {
          page = await client.getPlaylistItems(playlist.id, API_PAGE, state.offset)
        } catch (error) {
          // Since February 2026 only the user's own playlists expose items; others stay metadata-only.
          const code = error instanceof ProviderApiError ? error.providerError.code : null
          const foreign = playlist.owner?.id && playlist.owner.id !== state.userId && !playlist.collaborative
          if (state.offset === 0 && foreign && (code === 'PERMISSION_DENIED' || code === 'NOT_FOUND')) {
            await this.options.emit({
              type: 'warning',
              code: 'spotify-playlist-items-unavailable',
              message: `Tracks of "${playlist.name}" are not available to this Spotify app`,
              retryable: false,
            })
            this.nextPlaylist(state)
            return
          }
          throw error
        }
        page.items.forEach((item, index) => {
          const track = playlistItemTrack(item)
          // Unsupported items keep their original position as a gap; nothing shifts.
          if (!track || !state.emitter.track(track)) return
          state.heldMemberships.push({ playlistSourceId: playlist.id, trackSourceId: track.id!, position: state.offset + index })
          state.heldItems.push({ position: state.offset + index, track: trackSubset(track) })
        })
        state.offset += page.items.length
        if (page.next && page.items.length > 0) return
        if (state.offset > API_PAGE && playlist.snapshot_id) {
          const current = await client.getPlaylist(playlist.id)
          if (current.snapshot_id && current.snapshot_id !== playlist.snapshot_id) {
            if (++state.restarts > MAX_SECTION_RESTARTS) throw changedDuringSync(`Playlist "${playlist.name}"`)
            playlist.snapshot_id = current.snapshot_id
            state.offset = 0
            state.heldMemberships = []
            state.heldItems = []
            return
          }
        }
        state.emitter.memberships(state.heldMemberships)
        if (playlist.snapshot_id && this.options.playlistCache) {
          await this.options.playlistCache.save(state.accountKey, playlist.id, playlist.snapshot_id, state.heldItems).catch(() => {})
        }
        this.nextPlaylist(state)
        return
      }
      case 'done':
        return
    }
  }
}

