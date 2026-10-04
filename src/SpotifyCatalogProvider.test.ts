import { describe, expect, it, vi } from 'vitest'
import type { SpotifyCatalogClient } from './SpotifyCatalogClient'
import { SpotifyCatalogProvider } from './SpotifyCatalogProvider'
import type { SpotifyAlbum, SpotifyTrack } from './types'

const TRACK = '4uLU6hMCjMI75M1A2tKUQC'
const ALBUM = '4aawyAB9vmqN3uQ7FjRGTy'
const ARTIST = '0OdUWJ0sBjDrqHygGUXeCF'

const album: SpotifyAlbum = {
  id: ALBUM, name: 'Double Album', album_type: 'album', release_date: '1999-03-01', total_tracks: 3,
  images: [{ url: 'small', width: 64 }, { url: 'large', width: 640 }],
  artists: [{ id: ARTIST, name: 'Band' }, { id: null, name: 'Guest' }],
  external_ids: { upc: '0123' },
  tracks: {
    items: [
      { id: TRACK, name: 'One', duration_ms: 1000, disc_number: 1, track_number: 1, artists: [{ id: ARTIST, name: 'Band' }] },
      { id: null, name: 'Local', duration_ms: 1000, is_local: true },
    ],
    next: 'more',
  },
}

function client(overrides: Partial<SpotifyCatalogClient> = {}): SpotifyCatalogClient {
  return {
    getProfile: vi.fn(),
    search: vi.fn(async () => ({
      tracks: { items: [{ ...album.tracks!.items[0]!, album } as SpotifyTrack, { id: null, name: 'local', duration_ms: 1, is_local: true } as SpotifyTrack], next: 'n' },
      artists: { items: [{ id: ARTIST, name: 'Band', genres: ['rock'] }], next: null },
      albums: { items: [album], next: null },
      playlists: { items: [null, { id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Hits', owner: { id: 'spotify', display_name: 'Spotify' }, items: { total: 50 } }], next: null },
    })),
    getArtist: vi.fn(async () => ({ id: ARTIST, name: 'Band', genres: ['rock'], images: [] })),
    getArtistAlbums: vi.fn(async () => ({ items: [album], next: null })),
    getAlbum: vi.fn(async () => album),
    getAlbumTracks: vi.fn(async () => ({ items: [{ id: '1uLU6hMCjMI75M1A2tKUQC', name: 'Two', duration_ms: 2000, disc_number: 2, track_number: 1 }], next: null })),
    getTrack: vi.fn(async (id: string) => ({ ...album.tracks!.items[0]!, id, album })),
    getSavedTracks: vi.fn(async () => ({ items: [{ track: { ...album.tracks!.items[0]!, album } as SpotifyTrack }], total: 1, next: null })),
    getSavedAlbums: vi.fn(),
    getFollowedArtists: vi.fn(),
    getMyPlaylists: vi.fn(async () => ({ items: [], next: null })),
    getPlaylist: vi.fn(),
    getPlaylistItems: vi.fn(),
    ...overrides,
  }
}

const provider = (value = client()) => new SpotifyCatalogProvider({ client: value, getAccount: async () => ({ accountKey: 'me', userId: 'me' }) })

describe('Spotify catalog provider', () => {
  it('does not search Spotify for a single character and collapses whitespace', async () => {
    const value = client()
    const results = await provider(value).search({ query: ' r ' })
    expect(results.tracks).toEqual([])
    expect(value.search).not.toHaveBeenCalled()
    await provider(value).search({ query: '  never   gonna ' })
    expect(value.search).toHaveBeenCalledWith('never gonna', expect.any(Array), expect.any(Number), 0)
  })

  it('maps search results to Spotify-owned DTOs and pages by offset', async () => {
    const results = await provider().search({ query: 'band', limit: 50 })
    expect(results.tracks).toHaveLength(1)
    expect(results.tracks[0]).toMatchObject({
      sourceId: TRACK, albumSourceId: ALBUM, primaryArtistSourceId: ARTIST, format: null, artworkUrl: 'large',
      providerUrl: `https://open.spotify.com/track/${TRACK}`,
    })
    expect(results.albums[0]).toMatchObject({ sourceId: ALBUM, year: 1999, releaseType: 'album', upc: '0123' })
    expect(results.albums[0]!.artists).toEqual([
      { artistSourceId: ARTIST, artistName: 'Band', role: 'primary', position: 0 },
      { artistSourceId: null, artistName: 'Guest', role: 'main', position: 1 },
    ])
    expect(results.playlists[0]).toMatchObject({ trackCount: 50, description: 'by Spotify', editable: false })
    expect(results.nextCursor).toBe('10')
    expect(await provider().search({ query: '  ' })).toMatchObject({ tracks: [], nextCursor: null })
  })

  it('pages album tracks, skips local files and derives disc count', async () => {
    const bundle = await provider().getAlbumBundle(ALBUM)
    expect(bundle.tracks.map((track) => track.sourceId)).toEqual([TRACK, '1uLU6hMCjMI75M1A2tKUQC'])
    expect(bundle.album.totalDiscs).toBe(2)
    expect(bundle.tracks.every((track) => track.albumSourceId === ALBUM)).toBe(true)
  })

  it('never answers for foreign or mismatched IDs', async () => {
    await expect(provider().getTrack('__missing__')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    await expect(provider().getTrack('123456')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    const relinked = client({ getTrack: vi.fn(async () => ({ ...album.tracks!.items[0]!, id: '9uLU6hMCjMI75M1A2tKUQC' })) })
    await expect(provider(relinked).getTrack(TRACK)).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
  })

  it('exposes Liked Songs as an account-scoped synthetic playlist', async () => {
    const listed = await provider().listPlaylists()
    expect(listed.items[0]).toMatchObject({ sourceId: 'liked-songs-me', title: 'Liked Songs', trackCount: 1 })
    const tracks = await provider().getPlaylistTracks('liked-songs-me')
    expect(tracks.items.map((track) => track.sourceId)).toEqual([TRACK])
    await expect(provider().getPlaylistTracks('liked-songs-someone-else')).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
  })

  it('returns no top tracks or related artists now that the Web API has none', async () => {
    const bundle = await provider().getArtistBundle(ARTIST)
    expect(bundle).toMatchObject({ topTracks: [], relatedArtists: [], playlists: [] })
    expect(bundle.releases).toHaveLength(1)
  })
})
