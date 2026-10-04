/** Spotify-private types. Nothing here crosses the provider boundary unmapped. */

export interface SpotifyConfig {
  /** Web API app registered by the user (Authorization Code + PKCE, no secret). */
  clientId: string
  /** Loopback redirect registered in the Spotify app; empty means a dynamic port on `/callback`. */
  redirectUri: string
  apiBaseUrl: string
  accountsBaseUrl: string
  catalogScopes: string[]
  requestTimeoutMs: number
  maxRetries: number
  /** Target Ogg Vorbis bitrate requested from the helper; the actual one comes back in the result. */
  bitrateKbps: 320 | 160 | 96
}

export interface SpotifyCatalogSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  clientId: string
  userId: string
  displayName: string | null
}

/** Reusable access-point credential produced by librespot; opaque to TypeScript. */
export interface SpotifyPlaybackCredentials {
  username: string
  authType: number
  authData: string
}

export interface SpotifyPlaybackSession {
  credentials: SpotifyPlaybackCredentials
  country: string | null
  product: string | null
  librespotVersion: string | null
  verifiedAt: number
}

export interface SpotifyOAuthToken {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  scopes: string[]
}

// ---- Web API response subsets (fields we read; everything optional where Spotify may omit it) ----

export interface SpotifyImage { url: string; width?: number | null; height?: number | null }

export interface SpotifySimplifiedArtist {
  id: string | null
  name: string
  type?: string
  external_urls?: { spotify?: string }
}

export interface SpotifyArtist extends SpotifySimplifiedArtist {
  genres?: string[]
  images?: SpotifyImage[]
}

export interface SpotifySimplifiedAlbum {
  id: string | null
  name: string
  album_type?: string | null
  total_tracks?: number | null
  release_date?: string | null
  release_date_precision?: string | null
  images?: SpotifyImage[]
  artists?: SpotifySimplifiedArtist[]
  external_urls?: { spotify?: string }
  external_ids?: { upc?: string; ean?: string }
  genres?: string[]
}

export interface SpotifySimplifiedTrack {
  id: string | null
  name: string
  type?: string
  duration_ms: number
  track_number?: number | null
  disc_number?: number | null
  artists?: SpotifySimplifiedArtist[]
  is_local?: boolean
  is_playable?: boolean
  external_urls?: { spotify?: string }
  external_ids?: { isrc?: string }
}

export interface SpotifyTrack extends SpotifySimplifiedTrack {
  album?: SpotifySimplifiedAlbum | null
}

export interface SpotifyAlbum extends SpotifySimplifiedAlbum {
  tracks?: SpotifyPaging<SpotifySimplifiedTrack>
}

export interface SpotifyPaging<T> {
  items: T[]
  total?: number
  limit?: number
  offset?: number
  next: string | null
}

export interface SpotifyCursorPaging<T> {
  items: T[]
  total?: number
  next: string | null
  cursors?: { after?: string | null }
}

export interface SpotifyPlaylist {
  id: string
  name: string
  description?: string | null
  images?: SpotifyImage[] | null
  owner?: { id?: string; display_name?: string | null }
  collaborative?: boolean
  public?: boolean | null
  snapshot_id?: string
  external_urls?: { spotify?: string }
  /** February 2026 rename of `tracks`; both are accepted. */
  items?: { total?: number } | SpotifyPaging<SpotifyPlaylistItem>
  tracks?: { total?: number } | SpotifyPaging<SpotifyPlaylistItem>
}

export interface SpotifyPlaylistItem {
  added_at?: string | null
  is_local?: boolean
  /** February 2026 rename of `track`; both are accepted. */
  item?: SpotifyTrack | { type?: string; id?: string | null } | null
  track?: SpotifyTrack | { type?: string; id?: string | null } | null
}

export interface SpotifyUserProfile {
  id: string
  display_name?: string | null
  images?: SpotifyImage[]
}

export interface SpotifySearchResponse {
  artists?: SpotifyPaging<SpotifyArtist>
  albums?: SpotifyPaging<SpotifySimplifiedAlbum>
  tracks?: SpotifyPaging<SpotifyTrack>
  playlists?: SpotifyPaging<SpotifyPlaylist | null>
}
