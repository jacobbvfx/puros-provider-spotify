import type {
  ProviderLibraryRecordV1,
  ProviderPlaylistTrackV1,
  ProviderPlaylistV1,
} from 'puros-provider-sdk'
import { isMappableTrack, isSpotifyId, mapAlbum, mapArtist, mapTrack } from './mapping'
import type { SpotifyArtist, SpotifySimplifiedAlbum, SpotifySimplifiedArtist, SpotifySimplifiedTrack, SpotifyTrack } from './types'

/**
 * Builds deduplicated snapshot records. Everything in a host-mirror snapshot is
 * library content, so records carry `inLibrary: true`. Only IDs are retained,
 * which keeps memory bounded by the number of distinct entities.
 */
export class LibraryRecordEmitter {
  private readonly artists = new Set<string>()
  private readonly albums = new Set<string>()
  private readonly tracks = new Set<string>()
  private readonly playlists = new Set<string>()

  constructor(private readonly push: (record: ProviderLibraryRecordV1) => void) {}

  get trackCount(): number { return this.tracks.size }

  artist(value: SpotifyArtist | SpotifySimplifiedArtist): void {
    if (!isSpotifyId(value.id) || !value.name?.trim() || this.artists.has(value.id)) return
    this.artists.add(value.id)
    this.push({ type: 'artist', value: mapArtist(value, true) })
  }

  album(value: SpotifySimplifiedAlbum, totalDiscs?: number | null): void {
    if (!isSpotifyId(value.id) || this.albums.has(value.id)) return
    for (const artist of value.artists ?? []) this.artist(artist)
    this.albums.add(value.id)
    this.push({ type: 'album', value: mapAlbum(value, { inLibrary: true, totalDiscs }) })
  }

  /** Returns false for items that have no playable Spotify track identity. */
  track(value: SpotifyTrack | SpotifySimplifiedTrack, album?: SpotifySimplifiedAlbum | null): boolean {
    if (!isMappableTrack(value)) return false
    if (this.tracks.has(value.id!)) return true
    const owner = album ?? (value as SpotifyTrack).album ?? null
    for (const artist of value.artists ?? []) this.artist(artist)
    if (owner) this.album(owner)
    this.tracks.add(value.id!)
    this.push({ type: 'track', value: mapTrack(value, { album: owner, inLibrary: true }) })
    return true
  }

  playlist(value: ProviderPlaylistV1): void {
    if (this.playlists.has(value.sourceId)) return
    this.playlists.add(value.sourceId)
    this.push({ type: 'playlist', value })
  }

  memberships(values: ProviderPlaylistTrackV1[]): void {
    for (const value of values) this.push({ type: 'playlistTrack', value })
  }
}
