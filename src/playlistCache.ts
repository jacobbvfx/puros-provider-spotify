import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { SpotifySimplifiedAlbum, SpotifySimplifiedArtist, SpotifyTrack } from './types'

const CACHE_VERSION = 1

export interface CachedPlaylistItem {
  position: number
  track: SpotifyTrack
}

/** One saved album with its tracks, as the albums section of a sync emits it. */
export interface CachedSavedAlbum {
  album: SpotifySimplifiedAlbum
  totalDiscs: number | null
  tracks: SpotifyTrack[]
}

/**
 * Collection contents keyed by a version: a playlist's `snapshot_id`, or for
 * Liked Songs and saved albums a fingerprint of the total and first page. An
 * unchanged collection is rebuilt from disk instead of re-paging it, which is
 * most of a sync's Web API traffic. Provider-private, per account, in the
 * provider data root.
 */
export interface PlaylistSnapshotCache {
  load<T = CachedPlaylistItem>(accountKey: string, collectionId: string, snapshotId: string): Promise<T[] | null>
  save<T = CachedPlaylistItem>(accountKey: string, collectionId: string, snapshotId: string, items: T[]): Promise<void>
}

/** Version of a list that Spotify gives no snapshot for; a change anywhere moves the total or the newest page. */
export function listFingerprint(total: number | null | undefined, firstPage: string[]): string {
  return `${total ?? '?'}:${createHash('sha256').update(firstPage.join('\n')).digest('hex').slice(0, 16)}`
}

function artistSubset(artist: SpotifySimplifiedArtist): SpotifySimplifiedArtist {
  return { id: artist.id, name: artist.name, ...(artist.external_urls ? { external_urls: artist.external_urls } : {}) }
}

export function albumSubset(album: SpotifySimplifiedAlbum | null | undefined): SpotifySimplifiedAlbum | null {
  if (!album) return null
  return {
    id: album.id,
    name: album.name,
    album_type: album.album_type ?? null,
    total_tracks: album.total_tracks ?? null,
    release_date: album.release_date ?? null,
    images: album.images ?? [],
    artists: (album.artists ?? []).map(artistSubset),
    ...(album.external_urls ? { external_urls: album.external_urls } : {}),
    ...(album.external_ids ? { external_ids: album.external_ids } : {}),
  }
}

/** Only the fields the library mapping reads. */
export function trackSubset(track: SpotifyTrack): SpotifyTrack {
  return {
    id: track.id,
    name: track.name,
    duration_ms: track.duration_ms,
    track_number: track.track_number ?? null,
    disc_number: track.disc_number ?? null,
    artists: (track.artists ?? []).map(artistSubset),
    album: albumSubset(track.album),
    ...(track.external_urls ? { external_urls: track.external_urls } : {}),
    ...(track.external_ids ? { external_ids: track.external_ids } : {}),
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

export function createFilePlaylistCache(dataRoot: () => Promise<string>): PlaylistSnapshotCache {
  const file = async (accountKey: string, collectionId: string) => {
    const account = createHash('sha256').update(accountKey).digest('hex').slice(0, 12)
    return path.join(await dataRoot(), 'playlist-cache', account, `${safeName(collectionId)}.json`)
  }
  return {
    async load<T>(accountKey: string, collectionId: string, snapshotId: string) {
      try {
        const parsed = JSON.parse(await fs.readFile(await file(accountKey, collectionId), 'utf8')) as {
          version?: number; snapshotId?: string; items?: T[]
        }
        if (parsed.version !== CACHE_VERSION || parsed.snapshotId !== snapshotId || !Array.isArray(parsed.items)) return null
        return parsed.items
      } catch {
        return null
      }
    },
    async save<T>(accountKey: string, collectionId: string, snapshotId: string, items: T[]) {
      const target = await file(accountKey, collectionId)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, snapshotId, items }))
      await fs.rename(temporary, target)
    },
  }
}
