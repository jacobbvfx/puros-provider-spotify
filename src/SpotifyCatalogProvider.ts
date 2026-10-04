import {
  ProviderApiError,
  providerError,
  type ProviderAlbumBundleV1,
  type ProviderAlbumV1,
  type ProviderArtistBundleV1,
  type ProviderArtistV1,
  type ProviderArtworkResultV1,
  type ProviderEntityRefV1,
  type ProviderPageRequestV1,
  type ProviderPageV1,
  type ProviderPlaylistV1,
  type ProviderSearchRequestV1,
  type ProviderSearchResultsV1,
  type ProviderTrackV1,
} from 'puros-provider-sdk'
import {
  isLikedSongsPlaylistId,
  isMappableTrack,
  isSpotifyId,
  largestImage,
  likedSongsPlaylistId,
  mapAlbum,
  mapArtist,
  mapPlaylist,
  mapTrack,
  playlistItemTrack,
} from './mapping'
import type { SpotifyCatalogClient, SpotifySearchType } from './SpotifyCatalogClient'
import { SPOTIFY_SEARCH_MAX_LIMIT } from './SpotifyWebApiClient'
import type { SpotifyAlbum, SpotifySimplifiedTrack } from './types'

const MAX_ALBUM_TRACKS = 1_000
const PAGE = 50
const MIN_SEARCH_LENGTH = 2

function notFound(what: string): ProviderApiError {
  return new ProviderApiError(providerError('NOT_FOUND', `${what} not found`, { retryable: false }))
}

function requireId(sourceId: string, what: string): string {
  if (!isSpotifyId(sourceId)) throw notFound(what)
  return sourceId
}

function offsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  const value = Number(cursor)
  if (!Number.isInteger(value) || value < 0) throw new ProviderApiError(providerError('INVALID_ARGUMENT', 'Invalid Spotify cursor', { retryable: false }))
  return value
}

function pageLimit(request: ProviderPageRequestV1 | undefined, fallback: number, max: number): number {
  const limit = request?.limit
  return Number.isInteger(limit) && limit! > 0 ? Math.min(max, limit!) : fallback
}

/** Maps catalog reads to v1 DTOs; every returned child belongs to Spotify with its own base62 ID. */
export class SpotifyCatalogProvider {
  constructor(private readonly options: {
    client: SpotifyCatalogClient
    getAccount: () => Promise<{ accountKey: string; userId: string | null } | null>
  }) {}

  private get client() { return this.options.client }

  async search(request: ProviderSearchRequestV1): Promise<ProviderSearchResultsV1> {
    const query = request.query.trim().replace(/\s+/g, ' ')
    const empty: ProviderSearchResultsV1 = { artists: [], albums: [], tracks: [], playlists: [], nextCursor: null }
    // One character matches almost everything and is usually the start of a longer query.
    if ([...query].length < MIN_SEARCH_LENGTH) return empty
    const types: SpotifySearchType[] = request.types?.length
      ? request.types.filter((type): type is SpotifySearchType => ['artist', 'album', 'track', 'playlist'].includes(type))
      : ['track', 'album', 'artist', 'playlist']
    if (types.length === 0) return empty
    const limit = Math.min(SPOTIFY_SEARCH_MAX_LIMIT, Math.max(1, request.limit ?? SPOTIFY_SEARCH_MAX_LIMIT))
    const offset = offsetCursor(request.cursor)
    const result = await this.client.search(query, types, limit, offset)
    const account = await this.options.getAccount()
    const hasMore = [result.artists, result.albums, result.tracks, result.playlists].some((page) => !!page?.next)
    return {
      artists: (result.artists?.items ?? []).filter((item) => isSpotifyId(item?.id)).map((item) => mapArtist(item)),
      albums: (result.albums?.items ?? []).filter((item) => isSpotifyId(item?.id)).map((item) => mapAlbum(item)),
      tracks: (result.tracks?.items ?? []).filter(isMappableTrack).map((item) => mapTrack(item)),
      playlists: (result.playlists?.items ?? [])
        .filter((item): item is NonNullable<typeof item> => !!item && isSpotifyId(item.id))
        .map((item) => mapPlaylist(item, account?.userId ?? null)),
      nextCursor: hasMore ? String(offset + limit) : null,
    }
  }

  async getArtist(sourceId: string): Promise<ProviderArtistV1> {
    return mapArtist(await this.client.getArtist(requireId(sourceId, 'Spotify artist')))
  }

  async getArtistBundle(sourceId: string, request?: ProviderPageRequestV1): Promise<ProviderArtistBundleV1> {
    const id = requireId(sourceId, 'Spotify artist')
    const limit = pageLimit(request, PAGE, PAGE)
    const [artist, albums] = await Promise.all([
      this.client.getArtist(id),
      this.client.getArtistAlbums(id, limit, offsetCursor(request?.cursor)),
    ])
    return {
      artist: mapArtist(artist),
      releases: albums.items.filter((album) => isSpotifyId(album.id)).map((album) => mapAlbum(album)),
      playlists: [],
      // Top tracks and related artists are no longer offered by the Web API.
      topTracks: [],
      relatedArtists: [],
    }
  }

  private async albumTracks(album: SpotifyAlbum): Promise<SpotifySimplifiedTrack[]> {
    const tracks = [...(album.tracks?.items ?? [])]
    let next = album.tracks?.next ?? null
    while (next && tracks.length < MAX_ALBUM_TRACKS) {
      const page = await this.client.getAlbumTracks(album.id!, PAGE, tracks.length)
      if (page.items.length === 0) break
      tracks.push(...page.items)
      next = page.next
    }
    return tracks
  }

  async getAlbum(sourceId: string): Promise<ProviderAlbumV1> {
    const album = await this.client.getAlbum(requireId(sourceId, 'Spotify album'))
    const tracks = album.tracks?.next ? null : album.tracks?.items ?? null
    return mapAlbum(album, { totalDiscs: tracks ? Math.max(1, ...tracks.map((track) => track.disc_number ?? 1)) : null })
  }

  async getAlbumBundle(sourceId: string): Promise<ProviderAlbumBundleV1> {
    const album = await this.client.getAlbum(requireId(sourceId, 'Spotify album'))
    const tracks = (await this.albumTracks(album)).filter(isMappableTrack)
    const totalDiscs = tracks.length ? Math.max(1, ...tracks.map((track) => track.disc_number ?? 1)) : null
    return {
      album: mapAlbum(album, { totalDiscs }),
      tracks: tracks.map((track) => mapTrack(track, { album })),
    }
  }

  async getTrack(sourceId: string): Promise<ProviderTrackV1> {
    const track = await this.client.getTrack(requireId(sourceId, 'Spotify track'))
    if (!isMappableTrack(track) || track.id !== sourceId) throw notFound('Spotify track')
    return mapTrack(track)
  }

  // ---- playlists (read-only) ----

  private async likedPlaylist(): Promise<ProviderPlaylistV1 | null> {
    const account = await this.options.getAccount()
    if (!account) return null
    const total = (await this.client.getSavedTracks(1, 0)).total ?? null
    return {
      sourceId: likedSongsPlaylistId(account.accountKey),
      title: 'Liked Songs',
      description: 'Your saved Spotify tracks',
      trackCount: total,
      editable: false,
    }
  }

  async listPlaylists(request?: ProviderPageRequestV1): Promise<ProviderPageV1<ProviderPlaylistV1>> {
    const offset = offsetCursor(request?.cursor)
    const limit = pageLimit(request, PAGE, PAGE)
    const account = await this.options.getAccount()
    const page = await this.client.getMyPlaylists(limit, offset)
    const items = page.items
      .filter((item): item is NonNullable<typeof item> => !!item && isSpotifyId(item.id))
      .map((item) => mapPlaylist(item, account?.userId ?? null))
    if (offset === 0) {
      const liked = await this.likedPlaylist()
      if (liked) items.unshift(liked)
    }
    return { items, nextCursor: page.next && page.items.length > 0 ? String(offset + page.items.length) : null }
  }

  async getPlaylist(sourceId: string): Promise<ProviderPlaylistV1> {
    if (isLikedSongsPlaylistId(sourceId)) {
      const liked = await this.likedPlaylist()
      if (!liked || liked.sourceId !== sourceId) throw notFound('Spotify playlist')
      return liked
    }
    const account = await this.options.getAccount()
    return mapPlaylist(await this.client.getPlaylist(requireId(sourceId, 'Spotify playlist')), account?.userId ?? null)
  }

  async getPlaylistTracks(sourceId: string, request?: ProviderPageRequestV1): Promise<ProviderPageV1<ProviderTrackV1>> {
    const offset = offsetCursor(request?.cursor)
    const limit = pageLimit(request, PAGE, PAGE)
    if (isLikedSongsPlaylistId(sourceId)) {
      const account = await this.options.getAccount()
      if (!account || likedSongsPlaylistId(account.accountKey) !== sourceId) throw notFound('Spotify playlist')
      const page = await this.client.getSavedTracks(limit, offset)
      return {
        items: page.items.map((item) => item.track).filter(isMappableTrack).map((track) => mapTrack(track)),
        nextCursor: page.next && page.items.length > 0 ? String(offset + page.items.length) : null,
      }
    }
    const page = await this.client.getPlaylistItems(requireId(sourceId, 'Spotify playlist'), limit, offset)
    return {
      // Order and repeats are preserved; local files and episodes are skipped.
      items: page.items.map(playlistItemTrack).filter((track): track is NonNullable<typeof track> => !!track).map((track) => mapTrack(track)),
      nextCursor: page.next && page.items.length > 0 ? String(offset + page.items.length) : null,
    }
  }

  async getArtwork(ref: ProviderEntityRefV1): Promise<ProviderArtworkResultV1 | null> {
    let url: string | null = null
    if (ref.entityType === 'artist' && isSpotifyId(ref.sourceId)) url = largestImage((await this.client.getArtist(ref.sourceId)).images)
    else if (ref.entityType === 'album' && isSpotifyId(ref.sourceId)) url = largestImage((await this.client.getAlbum(ref.sourceId)).images)
    else if (ref.entityType === 'track' && isSpotifyId(ref.sourceId)) url = largestImage((await this.client.getTrack(ref.sourceId)).album?.images)
    else if (ref.entityType === 'playlist' && isSpotifyId(ref.sourceId)) url = largestImage((await this.client.getPlaylist(ref.sourceId)).images)
    return url ? { url } : null
  }
}
