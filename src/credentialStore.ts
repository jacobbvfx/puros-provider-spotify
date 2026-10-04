import type { ProviderSecretsHostV1 } from 'puros-provider-sdk'
import type { SpotifyCatalogSession, SpotifyPlaybackSession } from './types'

const CATALOG_KEY = 'catalog'
const PLAYBACK_KEY = 'playback'

function parse<T>(raw: string | undefined, valid: (value: Partial<T>) => boolean): T | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<T>
    return value && typeof value === 'object' && valid(value) ? value as T : null
  } catch {
    return null
  }
}

/** Spotify-private session adapter; encryption and provider scoping stay with the host. */
export class SpotifyCredentialStore {
  constructor(private readonly secrets: ProviderSecretsHostV1) {}

  async loadCatalog(): Promise<SpotifyCatalogSession | null> {
    return parse<SpotifyCatalogSession>(await this.secrets.get(CATALOG_KEY), (value) => (
      typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
      && typeof value.userId === 'string' && typeof value.clientId === 'string'
    ))
  }

  async saveCatalog(session: SpotifyCatalogSession): Promise<void> {
    await this.secrets.set(CATALOG_KEY, JSON.stringify(session))
  }

  async loadPlayback(): Promise<SpotifyPlaybackSession | null> {
    return parse<SpotifyPlaybackSession>(await this.secrets.get(PLAYBACK_KEY), (value) => (
      !!value.credentials && typeof value.credentials.username === 'string'
      && typeof value.credentials.authData === 'string' && typeof value.credentials.authType === 'number'
    ))
  }

  async savePlayback(session: SpotifyPlaybackSession): Promise<void> {
    await this.secrets.set(PLAYBACK_KEY, JSON.stringify(session))
  }

  async clearPlayback(): Promise<void> {
    await this.secrets.delete(PLAYBACK_KEY)
  }

  async clear(): Promise<void> {
    await Promise.all([this.secrets.delete(CATALOG_KEY), this.secrets.delete(PLAYBACK_KEY)])
  }
}
