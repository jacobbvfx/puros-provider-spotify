import type {
  ProviderAlbumV1,
  ProviderArtistCreditV1,
  ProviderArtistV1,
  ProviderPlaylistV1,
  ProviderReleaseTypeV1,
  ProviderTrackV1,
} from 'puros-provider-sdk'
import type {
  SpotifyArtist,
  SpotifyImage,
  SpotifyPlaylist,
  SpotifyPlaylistItem,
  SpotifySimplifiedAlbum,
  SpotifySimplifiedArtist,
  SpotifySimplifiedTrack,
  SpotifyTrack,
} from './types'

const BASE62_ID = /^[0-9A-Za-z]{22}$/

/** Real Spotify entities use their base62 ID as the source ID everywhere. */
export function isSpotifyId(value: string | null | undefined): value is string {
  return typeof value === 'string' && BASE62_ID.test(value)
}

/** Deterministic, account-scoped ID of the synthetic "Liked Songs" playlist; never sent to Spotify. */
export function likedSongsPlaylistId(accountKey: string): string {
  return `liked-songs-${accountKey.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`
}

export function isLikedSongsPlaylistId(sourceId: string): boolean {
  return sourceId.startsWith('liked-songs-')
}

export function openSpotifyUrl(type: 'artist' | 'album' | 'track' | 'playlist', id: string): string {
  return `https://open.spotify.com/${type}/${id}`
}

export function largestImage(images: SpotifyImage[] | null | undefined): string | null {
  if (!images?.length) return null
  return [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ?? null
}

function releaseYear(value: string | null | undefined): number | null {
  const year = Number(String(value ?? '').slice(0, 4))
  return Number.isInteger(year) && year > 0 ? year : null
}

function releaseType(value: string | null | undefined): ProviderReleaseTypeV1 | null {
  switch ((value ?? '').toLowerCase()) {
    case 'album': return 'album'
    case 'single': return 'single'
    case 'compilation': return 'compilation'
    case '': return null
    default: return 'other'
  }
}

export function artistCredits(artists: SpotifySimplifiedArtist[] | null | undefined): ProviderArtistCreditV1[] {
  return (artists ?? [])
    .filter((artist) => artist.name?.trim())
    .map((artist, position) => ({
      artistSourceId: isSpotifyId(artist.id) ? artist.id : null,
      artistName: artist.name,
      role: position === 0 ? 'primary' : 'main',
      position,
    }))
}

export function mapArtist(value: SpotifyArtist | SpotifySimplifiedArtist, inLibrary?: boolean): ProviderArtistV1 {
  const full = value as SpotifyArtist
  return {
    sourceId: value.id!,
    name: value.name,
    artworkUrl: largestImage(full.images),
    genres: full.genres ?? [],
    providerUrl: value.external_urls?.spotify ?? openSpotifyUrl('artist', value.id!),
    ...(inLibrary === undefined ? {} : { inLibrary }),
  }
}

export function mapAlbum(value: SpotifySimplifiedAlbum, options: { inLibrary?: boolean; totalDiscs?: number | null } = {}): ProviderAlbumV1 {
  const credits = artistCredits(value.artists)
  return {
    sourceId: value.id!,
    title: value.name,
    upc: value.external_ids?.upc ?? value.external_ids?.ean ?? null,
    year: releaseYear(value.release_date),
    releaseType: releaseType(value.album_type),
    artworkUrl: largestImage(value.images),
    primaryArtistSourceId: credits[0]?.artistSourceId ?? null,
    primaryArtistName: credits[0]?.artistName ?? null,
    artists: credits,
    genres: value.genres ?? [],
    totalTracks: value.total_tracks ?? null,
    totalDiscs: options.totalDiscs ?? null,
    providerUrl: value.external_urls?.spotify ?? openSpotifyUrl('album', value.id!),
    ...(options.inLibrary === undefined ? {} : { inLibrary: options.inLibrary }),
  }
}

export function mapTrack(value: SpotifyTrack | SpotifySimplifiedTrack, options: {
  album?: SpotifySimplifiedAlbum | null
  inLibrary?: boolean
} = {}): ProviderTrackV1 {
  const credits = artistCredits(value.artists)
  const album = options.album ?? (value as SpotifyTrack).album ?? null
  const albumId = isSpotifyId(album?.id) ? album!.id : null
  return {
    sourceId: value.id!,
    title: value.name,
    isrc: value.external_ids?.isrc ?? null,
    upc: album?.external_ids?.upc ?? null,
    durationMs: Math.max(0, Math.round(value.duration_ms ?? 0)),
    trackNumber: value.track_number ?? null,
    discNumber: value.disc_number ?? null,
    albumSourceId: albumId,
    albumTitle: album?.name ?? null,
    primaryArtistSourceId: credits[0]?.artistSourceId ?? null,
    primaryArtistName: credits[0]?.artistName ?? null,
    artists: credits,
    genres: [],
    artworkUrl: largestImage(album?.images),
    providerUrl: value.external_urls?.spotify ?? openSpotifyUrl('track', value.id!),
    // The source codec is known only once playback resolves it.
    format: null,
    ...(options.inLibrary === undefined ? {} : { inLibrary: options.inLibrary }),
  }
}

export function playlistTotal(value: SpotifyPlaylist): number | null {
  const total = (value.items as { total?: number } | undefined)?.total ?? (value.tracks as { total?: number } | undefined)?.total
  return Number.isFinite(total) ? Number(total) : null
}

export function mapPlaylist(value: SpotifyPlaylist, userId: string | null): ProviderPlaylistV1 {
  const foreignOwner = userId && value.owner?.id && value.owner.id !== userId
    ? value.owner.display_name || value.owner.id
    : null
  return {
    sourceId: value.id,
    title: value.name || 'Spotify Playlist',
    description: value.description || (foreignOwner ? `by ${foreignOwner}` : null),
    artworkUrl: largestImage(value.images),
    trackCount: playlistTotal(value),
    providerUrl: value.external_urls?.spotify ?? openSpotifyUrl('playlist', value.id),
    // Remote writes are not implemented yet; every Spotify playlist is read-only in Puros.
    editable: false,
    collectionRef: { type: 'playlist', sourceId: value.id },
  }
}

/** The playable track of a playlist item, or null for local files, episodes and removed items. */
export function playlistItemTrack(item: SpotifyPlaylistItem): SpotifyTrack | null {
  if (item.is_local) return null
  const value = item.item ?? item.track
  if (!value || (value.type && value.type !== 'track')) return null
  const track = value as SpotifyTrack
  if (!isSpotifyId(track.id) || typeof track.name !== 'string' || track.is_local) return null
  return track
}

/** Tracks without a real Spotify ID (local files) cannot be resolved or played. */
export function isMappableTrack(value: SpotifySimplifiedTrack | null | undefined): value is SpotifySimplifiedTrack {
  return !!value && isSpotifyId(value.id) && !value.is_local && typeof value.name === 'string'
}
