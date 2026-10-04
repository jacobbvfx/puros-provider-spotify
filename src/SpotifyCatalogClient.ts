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

export type SpotifySearchType = 'artist' | 'album' | 'track' | 'playlist'

/**
 * Private catalog adapter. The Web API client implements it today; an
 * internal-API variant could replace it without changing the plugin's DTOs.
 */
export interface SpotifyCatalogClient {
  getProfile(accessToken?: string): Promise<SpotifyUserProfile>
  search(query: string, types: SpotifySearchType[], limit: number, offset: number): Promise<SpotifySearchResponse>
  getArtist(id: string): Promise<SpotifyArtist>
  getArtistAlbums(id: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifySimplifiedAlbum>>
  getAlbum(id: string): Promise<SpotifyAlbum>
  getAlbumTracks(id: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifySimplifiedTrack>>
  getTrack(id: string): Promise<SpotifyTrack>
  getSavedTracks(limit: number, offset: number): Promise<SpotifyPaging<{ added_at?: string; track: SpotifyTrack | null }>>
  getSavedAlbums(limit: number, offset: number): Promise<SpotifyPaging<{ added_at?: string; album: SpotifyAlbum | null }>>
  getFollowedArtists(limit: number, after: string | null): Promise<SpotifyCursorPaging<SpotifyArtist>>
  getMyPlaylists(limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylist | null>>
  getPlaylist(id: string): Promise<SpotifyPlaylist>
  getPlaylistItems(id: string, limit: number, offset: number): Promise<SpotifyPaging<SpotifyPlaylistItem>>
}
