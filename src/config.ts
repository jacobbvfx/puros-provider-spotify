import type { ProviderSettingsHostV1 } from 'puros-provider-sdk'
import type { SpotifyConfig } from './types'

export const SPOTIFY_API_BASE_URL = 'https://api.spotify.com/v1'
export const SPOTIFY_ACCOUNTS_BASE_URL = 'https://accounts.spotify.com'
/** Read-only scopes for catalog, saved library and playlists. */
export const SPOTIFY_CATALOG_SCOPES = [
  'user-read-private',
  'user-library-read',
  'user-follow-read',
  'playlist-read-private',
  'playlist-read-collaborative',
]

const CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/i
/**
 * The developer dashboard rejects a port-less loopback redirect as "not secure",
 * so the default uses a fixed port the user registers verbatim.
 */
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:43821/callback'

/** A loopback redirect is `http://127.0.0.1[:port]/path`; `localhost` is not accepted by Spotify. */
export function parseLoopbackRedirect(value: string): { port: number; path: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Spotify redirect URI must be a URL like http://127.0.0.1:43821/callback')
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.search || url.hash || url.username || url.password) {
    throw new Error('Spotify redirect URI must use http://127.0.0.1 (not localhost) without query or fragment')
  }
  const port = url.port ? Number(url.port) : 0
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || (port > 0 && port < 1024)) {
    throw new Error('Spotify redirect URI port must be 1024–65535')
  }
  return { port, path: url.pathname || '/' }
}

async function readText(settings: ProviderSettingsHostV1, key: string): Promise<string> {
  const value = await settings.get(key)
  return typeof value === 'string' ? value.trim() : ''
}

export async function loadSpotifyConfig(settings: ProviderSettingsHostV1): Promise<SpotifyConfig> {
  const [clientId, redirectUri] = await Promise.all([
    readText(settings, 'client-id'),
    readText(settings, 'redirect-uri'),
  ])
  return {
    clientId,
    redirectUri: redirectUri || DEFAULT_REDIRECT_URI,
    apiBaseUrl: SPOTIFY_API_BASE_URL,
    accountsBaseUrl: SPOTIFY_ACCOUNTS_BASE_URL,
    catalogScopes: SPOTIFY_CATALOG_SCOPES,
    requestTimeoutMs: 15_000,
    maxRetries: 3,
    bitrateKbps: 320,
  }
}

export function assertCatalogConfig(config: SpotifyConfig): void {
  if (!CLIENT_ID_PATTERN.test(config.clientId)) {
    throw new Error('Set your Spotify app Client ID in Settings → Accounts → Spotify before connecting')
  }
  if (config.redirectUri) parseLoopbackRedirect(config.redirectUri)
}
