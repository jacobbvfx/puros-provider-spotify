import manifestJson from '../provider.manifest.json'
import {
  API_VERSION,
  type ProviderAuthStatusV1,
  type ProviderHostV1,
  type ProviderManifestV1,
  type ProviderPluginV1,
  type ProviderRuntimeV1,
  type ProviderStatusV1,
} from 'puros-provider-sdk'
import { createSpotifyRuntimeServices } from './runtimeServices'
import { SPOTIFY_QUALITY_TIERS } from './SpotifyPlaybackRuntime'
import type { SpotifyConnectionStatus } from './SpotifyAuthService'

export const manifest = manifestJson as ProviderManifestV1

type LoginTarget = 'all' | 'catalog' | 'playback'

function loginTarget(value: unknown): LoginTarget {
  const target = value && typeof value === 'object' ? (value as { target?: unknown }).target : undefined
  return target === 'catalog' || target === 'playback' ? target : 'all'
}

function playbackLabel(status: SpotifyConnectionStatus): string {
  switch (status.playback) {
    case 'connected': return `Ready${status.product ? ` · ${status.product}` : ''}${status.country ? ` · ${status.country}` : ''}`
    case 'account-mismatch': return 'Different account than catalog'
    case 'not-premium': return 'Premium required'
    case 'rejected': return 'Sign-in rejected · reconnect playback'
    default: return 'Not connected'
  }
}

function authStatus(status: SpotifyConnectionStatus): ProviderAuthStatusV1 {
  return {
    authenticated: status.catalog === 'connected',
    accountLabel: status.accountLabel,
    expiresAt: status.expiresAt,
    message: status.playbackMessage,
  }
}

function providerStatus(status: SpotifyConnectionStatus, active: boolean): ProviderStatusV1 {
  const catalogConnected = status.catalog === 'connected'
  // The catalog stays usable while audio is unavailable; that is "degraded", not an error.
  const degraded = catalogConnected && status.playback !== 'connected'
  return {
    state: !active ? 'inactive' : degraded ? 'degraded' : 'ready',
    authenticated: catalogConnected,
    ...(degraded ? { message: status.playbackMessage ?? 'Spotify playback is not connected' } : {}),
    updatedAt: Date.now(),
    values: {
      account: catalogConnected ? `Connected · ${status.accountLabel ?? status.userId}` : 'Not connected',
      playback: playbackLabel(status),
    },
  }
}

async function createRuntime(host: ProviderHostV1): Promise<ProviderRuntimeV1> {
  const services = createSpotifyRuntimeServices(host)
  let active = true
  const ensureActive = () => { if (!active) throw new Error('Spotify provider is inactive') }
  const emitStatus = async () => {
    const status = await services.auth.getStatus()
    await host.events.emit({ type: 'auth.changed', status: authStatus(status) })
    await host.events.emit({ type: 'status.changed', status: providerStatus(status, active) })
  }

  await services.playback.cleanupStaleFiles()
  // Re-validate a stored audio credential after restart without blocking activation.
  void (async () => {
    try {
      if (await services.auth.getPlaybackSession()) {
        await services.auth.checkPlayback()
        if (active) await emitStatus()
      }
    } catch (error) {
      await host.logger.warn('Spotify playback session check failed', { message: error instanceof Error ? error.message : String(error) })
    }
  })()

  return {
    capabilities: {
      auth: {
        async getStatus() {
          ensureActive()
          return authStatus(await services.auth.getStatus())
        },
        async login(...args: unknown[]) {
          ensureActive()
          let loginError: unknown = null
          try {
            const result = await services.auth.login((token) => services.client.getProfile(token), loginTarget(args[0]))
            if (result.accountChanged) {
              services.client.clearCache()
              services.library.reset()
              await services.playback.cancelAll()
            }
          } catch (error) {
            loginError = error
          }
          await emitStatus()
          const status = await services.auth.getStatus()
          // Catalog success with a playback failure still connects the account; report the problem.
          if (loginError && status.catalog !== 'connected') throw loginError
          if (loginError) {
            await host.events.emit({
              type: 'warning',
              code: 'spotify-playback-login',
              message: loginError instanceof Error ? loginError.message : 'Spotify playback sign-in failed',
              retryable: true,
            })
          }
          return { status: authStatus(status) }
        },
        async cancelLogin() {
          await services.auth.cancelLogin()
        },
        async logout() {
          ensureActive()
          await services.playback.cancelAll()
          services.library.reset()
          services.client.clearCache()
          await services.auth.logout()
          await emitStatus()
        },
      },
      'catalog.search': {
        async search(request) { ensureActive(); return services.catalog.search(request) },
      },
      'catalog.entities': {
        async getArtist(sourceId) { ensureActive(); return services.catalog.getArtist(sourceId) },
        async getArtistBundle(sourceId, request) { ensureActive(); return services.catalog.getArtistBundle(sourceId, request) },
        async getAlbum(sourceId) { ensureActive(); return services.catalog.getAlbum(sourceId) },
        async getAlbumBundle(sourceId) { ensureActive(); return services.catalog.getAlbumBundle(sourceId) },
        async getTrack(sourceId) { ensureActive(); return services.catalog.getTrack(sourceId) },
      },
      'library.sync': {
        async enumerate(request) { ensureActive(); return services.library.enumerate(request) },
      },
      playlists: {
        async list(request) { ensureActive(); return services.catalog.listPlaylists(request) },
        async get(sourceId) { ensureActive(); return services.catalog.getPlaylist(sourceId) },
        async getTracks(sourceId, request) { ensureActive(); return services.catalog.getPlaylistTracks(sourceId, request) },
      },
      'playback.resolve': {
        async resolve(request) {
          ensureActive()
          try {
            return await services.playback.resolve(request)
          } finally {
            // A rejected credential during playback changes the visible status.
            const status = await services.auth.getStatus()
            if (status.playback !== 'connected' && status.catalog === 'connected') await emitStatus().catch(() => {})
          }
        },
      },
      'playback.prefetch': {
        async prefetch(request) { ensureActive(); return services.playback.prefetch(request) },
      },
      'playback.progressive': {
        async markPlaybackStarted({ sessionId }) { ensureActive(); services.playback.markPlaybackStarted(sessionId) },
        async cancel({ sessionId }) { await services.playback.cancelSession(sessionId) },
      },
      'quality.tiers': {
        async list() {
          return SPOTIFY_QUALITY_TIERS.map((tier) => ({
            id: tier.id, label: tier.label, description: tier.description, rank: tier.rank, lossless: false, hiRes: false,
          }))
        },
        async getSelected() { return services.quality.getSelected() },
        async select({ tierId }) { await services.quality.select(tierId) },
      },
      'metadata.artwork': {
        async getArtwork(ref) { ensureActive(); return services.catalog.getArtwork(ref) },
      },
    },
    async cancelSession(sessionId) {
      return services.playback.cancelSession(sessionId)
    },
    async getStatus() {
      return providerStatus(await services.auth.getStatus(), active)
    },
    async deactivate() {
      active = false
      services.library.reset()
      await services.auth.cancelLogin()
      await services.playback.shutdown()
    },
  }
}

const plugin: ProviderPluginV1 = {
  apiVersion: API_VERSION,
  manifest,
  async activate(host) {
    await host.logger.info('Spotify plugin activated')
    return createRuntime(host)
  },
}

export default plugin
