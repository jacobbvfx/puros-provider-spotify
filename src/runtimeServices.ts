import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProviderHostV1 } from 'puros-provider-sdk'
import { loadSpotifyConfig, SPOTIFY_API_BASE_URL } from './config'
import { SpotifyCredentialStore } from './credentialStore'
import type { FetchLike } from './oauth'
import { SpotifyAuthService } from './SpotifyAuthService'
import { SpotifyCatalogProvider } from './SpotifyCatalogProvider'
import { SpotifyHelperTransport } from './SpotifyHelperTransport'
import { LIBRARY_REFRESH_INTERVAL_MS, SpotifyLibrarySync } from './SpotifyLibrarySync'
import { createFileLibrarySnapshotStore } from './librarySnapshot'
import { createFilePlaylistCache } from './playlistCache'
import { DEFAULT_QUALITY_TIER, SpotifyPlaybackRuntime, tierById } from './SpotifyPlaybackRuntime'
import { SpotifyWebApiClient, type RateLimitBlockStore } from './SpotifyWebApiClient'

type SavedBlocks = Record<string, { until?: unknown; quota?: unknown }>

/** Blocks per Spotify app (Client ID); an expired one is dropped on the next save. */
function createFileBlockStore(dataRoot: () => Promise<string>, scope: () => Promise<string>): RateLimitBlockStore {
  const file = async () => path.join(await dataRoot(), 'web-api-blocks.json')
  const read = async (): Promise<SavedBlocks> => {
    try {
      const parsed = JSON.parse(await fs.readFile(await file(), 'utf8')) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SavedBlocks : {}
    } catch {
      return {}
    }
  }
  return {
    scope,
    async load(key) {
      const saved = (await read())[key]
      if (typeof saved?.until !== 'number' || !Number.isFinite(saved.until)) return null
      return { until: saved.until, quota: saved.quota === true }
    },
    async save(key, block) {
      const blocks = await read()
      for (const [other, saved] of Object.entries(blocks)) {
        if (typeof saved?.until !== 'number' || saved.until <= Date.now()) delete blocks[other]
      }
      blocks[key] = block
      const target = await file()
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, JSON.stringify(blocks))
    },
  }
}

/** Construct private provider services using only host-granted secret/helper/navigation operations. */
export function createSpotifyRuntimeServices(host: ProviderHostV1, options: { fetchImpl?: FetchLike } = {}) {
  const helper = new SpotifyHelperTransport(host.helpers)
  const config = () => loadSpotifyConfig(host.settings)
  const auth = new SpotifyAuthService({
    config,
    store: new SpotifyCredentialStore(host.secrets),
    helper,
    openExternal: (url) => host.openExternal(url),
    fetchImpl: options.fetchImpl,
    workDir: async () => {
      const root = path.join(await host.paths.getCacheRoot(), 'work')
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      return root
    },
  })
  const client = new SpotifyWebApiClient({
    baseUrl: SPOTIFY_API_BASE_URL,
    getAccessToken: (forceRefresh) => auth.getAccessToken(forceRefresh),
    fetchImpl: options.fetchImpl,
    // The token's app, which is the one Spotify counts requests against; the setting can differ until reconnecting.
    blockStore: createFileBlockStore(
      () => host.paths.getDataRoot(),
      async () => (await auth.getCatalogSession().catch(() => null))?.clientId ?? (await config()).clientId,
    ),
  })
  const getAccount = async () => {
    const catalog = await auth.getCatalogSession()
    const accountKey = await auth.getAccountKey()
    return accountKey ? { accountKey, userId: catalog?.userId ?? null } : null
  }
  const catalog = new SpotifyCatalogProvider({ client, getAccount })
  const library = new SpotifyLibrarySync({
    client, getAccount, emit: (event) => host.events.emit(event),
    playlistCache: createFilePlaylistCache(() => host.paths.getDataRoot()),
    librarySnapshots: createFileLibrarySnapshotStore(() => host.paths.getDataRoot()),
    refreshIntervalMs: LIBRARY_REFRESH_INTERVAL_MS,
  })
  const quality = {
    async getSelected(): Promise<string> {
      const value = await host.settings.get('quality').catch(() => undefined)
      return tierById(typeof value === 'string' ? value : null)?.id ?? DEFAULT_QUALITY_TIER
    },
    async select(tierId: string): Promise<void> {
      if (!tierById(tierId)) throw new Error(`Unknown Spotify quality tier: ${tierId}`)
      await host.settings.set('quality', tierId)
    },
  }
  const playback = new SpotifyPlaybackRuntime({
    host, auth, helper,
    getBitrate: async () => tierById(await quality.getSelected())!.bitrateKbps,
  })
  return { helper, auth, client, catalog, library, playback, quality }
}
