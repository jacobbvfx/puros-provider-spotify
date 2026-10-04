import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FormatInfoV1, ProviderCachedAudioV1, ProviderEventV1 } from 'puros-provider-sdk'
import { SpotifyHelperTransport } from './SpotifyHelperTransport'
import { PROGRESS_SEGMENT_BYTES, qualityKeyFor, SpotifyPlaybackRuntime } from './SpotifyPlaybackRuntime'
import { fakeHelpers, type FakeHelperScript } from './testSupport'
import type { SpotifyPlaybackSession } from './types'

const TRACK = '4uLU6hMCjMI75M1A2tKUQC'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

const flac: FormatInfoV1 = {
  format: 'FLAC', sampleRate: 44_100, bitDepth: 16, bitrate: 0, channels: 2,
  isLossless: true, isHiRes: false, isMqa: false, isDsd: false,
}

const playbackSession: SpotifyPlaybackSession = {
  credentials: { username: 'listener', authType: 1, authData: 'b3BhcXVl' },
  country: 'PL', product: 'premium', librespotVersion: '0.8.0', verifiedAt: 1,
}

function setup(options: {
  script?: (defaults: Required<Pick<FakeHelperScript, 'onRequest' | 'onSpawn'>>) => FakeHelperScript
  durationMs?: number
  cached?: ProviderCachedAudioV1 | null
  session?: SpotifyPlaybackSession | null
  vorbisPlayable?: boolean
  bitrate?: number
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-spotify-playback-'))
  roots.push(root)
  const defaults = {
    onRequest(process: Parameters<NonNullable<FakeHelperScript['onRequest']>>[0], request: Record<string, unknown>) {
      fs.writeFileSync(String(request.outputPath), 'OggS-fixture')
      process.event({ event: 'progress', bytesCompleted: 50, bytesTotal: 100 })
      process.event({
        event: 'artifact-ready', trackId: request.trackId, path: request.outputPath, codec: 'vorbis',
        bitrateKbps: 320, durationMs: 180_000, bytes: 12,
      })
      process.event({ event: 'completed' })
      process.exit(0)
    },
    onSpawn(process: Parameters<NonNullable<FakeHelperScript['onSpawn']>>[0]) {
      if (process.binaryId === 'transcode') {
        fs.writeFileSync(process.args[process.args.length - 1]!, 'fLaC-fixture')
        process.exit(0)
      } else if (process.binaryId === 'probe') {
        const ms = options.durationMs ?? 180_400
        const stamp = new Date(ms).toISOString().slice(11, 22)
        process.push({ type: 'stderr', data: new TextEncoder().encode(`size=N/A time=00:00:01.00\rsize=N/A time=${stamp} bitrate=N/A\n`) })
        process.exit(0)
      }
    },
  }
  const fake = fakeHelpers(options.script ? options.script(defaults) : defaults)
  const events: ProviderEventV1[] = []
  const cache = {
    get: vi.fn(async () => options.cached ?? null),
    // The real host adds `dsdRate: undefined`, which provider payload validation rejects.
    inspectFormat: vi.fn(async (file: string) => {
      const head = fs.readFileSync(file, 'utf8')
      if (head.startsWith('fLaC')) return { ...flac, dsdRate: undefined }
      if (head.startsWith('OggS')) return { ...flac, format: 'VORBIS' as const, bitDepth: 0, bitrate: 318_000, isLossless: false, dsdRate: undefined }
      return null
    }),
    canPlayFormat: vi.fn(async (format: string) => format === 'VORBIS' && options.vorbisPlayable === true),
    put: vi.fn(async () => {}),
    trim: vi.fn(async () => {}),
  }
  const auth = {
    getPlaybackSession: vi.fn(async () => (options.session === undefined ? playbackSession : options.session)),
    getAccountKey: vi.fn(async () => 'listener'),
    invalidatePlayback: vi.fn(async () => {}),
  }
  const runtime = new SpotifyPlaybackRuntime({
    host: {
      paths: { getCacheRoot: async () => root, getDataRoot: async () => root, getResourceRoot: async () => root },
      cache,
      helpers: fake.helpers,
      logger: { debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {} },
      events: { emit: async (event) => { events.push(event) } },
    },
    auth,
    helper: new SpotifyHelperTransport(fake.helpers),
    getBitrate: async () => options.bitrate ?? 320,
  })
  return { root, runtime, cache, auth, events, processes: fake.processes }
}

describe('Spotify playback runtime', () => {
  it('publishes the exact Ogg Vorbis stream when core can play Vorbis', async () => {
    const { runtime, cache, processes, root } = setup({ vorbisPlayable: true })
    const artifact = await runtime.resolve({ sourceId: TRACK, intent: 'playback' })
    expect(artifact.path).toMatch(new RegExp(`${TRACK}\\.r1\\.320\\.ogg$`))
    expect(artifact.path.startsWith(root)).toBe(true)
    expect(artifact).toEqual({
      path: artifact.path,
      lifecycle: 'complete',
      format: { format: 'VORBIS', sampleRate: 44_100, bitDepth: 0, bitrate: 320, channels: 2, isLossless: false, isHiRes: false, isMqa: false, isDsd: false },
    })
    expect(fs.readFileSync(artifact.path, 'utf8')).toBe('OggS-fixture')
    // No conversion: fetch, then only the length check.
    expect(processes.map((process) => process.binaryId)).toEqual(['helper', 'probe'])
    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({ path: artifact.path, format: artifact.format, resolvedQuality: 'VORBIS_320' }))
    expect(Object.hasOwn((cache.put.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0], 'sourceFormat')).toBe(false)
    expect(fs.readdirSync(path.dirname(artifact.path))).toEqual([path.basename(artifact.path)])
    expect(cache.canPlayFormat).toHaveBeenCalledWith('VORBIS')
  })

  it('does not reuse a cached Ogg once core can no longer play Vorbis', async () => {
    const vorbis: FormatInfoV1 = { ...flac, format: 'VORBIS', bitDepth: 0, bitrate: 320, isLossless: false }
    const played = setup({ vorbisPlayable: true, cached: { path: '/x.ogg', format: vorbis, resolvedSourceId: TRACK } })
    await expect(played.runtime.resolve({ sourceId: TRACK, intent: 'playback' })).resolves.toEqual({ path: '/x.ogg', lifecycle: 'complete', format: vorbis })
    const stale = setup({ vorbisPlayable: false, cached: { path: '/x.ogg', format: vorbis, resolvedSourceId: TRACK } })
    const artifact = await stale.runtime.resolve({ sourceId: TRACK, intent: 'playback' })
    expect(artifact.format.format).toBe('FLAC')
    expect(stale.processes.map((process) => process.binaryId)).toEqual(['helper', 'transcode', 'probe'])
  })

  it('fetches the exact track, converts it to FLAC, verifies it and registers source provenance', async () => {
    const { runtime, cache, events, processes, root } = setup()
    const artifact = await runtime.resolve({ sourceId: TRACK, sessionId: 'session-0001', intent: 'playback' })
    expect(artifact).toMatchObject({
      lifecycle: 'complete',
      format: flac,
      sourceFormat: { format: 'VORBIS', bitrate: 320, isLossless: false, isHiRes: false, sampleRate: 44_100, bitDepth: 0 },
    })
    expect(artifact.path.startsWith(root)).toBe(true)
    expect(fs.readFileSync(artifact.path, 'utf8')).toBe('fLaC-fixture')
    expect(processes.map((process) => process.binaryId)).toEqual(['helper', 'transcode', 'probe'])
    expect(processes[0]!.args).toEqual(['fetch-track'])
    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: TRACK, resolvedSourceId: TRACK, qualityKey: qualityKeyFor('listener', 320), resolvedQuality: 'VORBIS_320',
      sourceFormat: expect.objectContaining({ format: 'VORBIS' }),
    }))
    const put = (cache.put.mock.calls as unknown as Array<[{ format: FormatInfoV1 }]>)[0]![0]
    expect(Object.hasOwn(put.format, 'dsdRate')).toBe(false)
    expect(Object.hasOwn(artifact.format, 'dsdRate')).toBe(false)
    // Intermediate Ogg and temporary FLAC are gone; only the published artifact remains.
    const left = fs.readdirSync(path.dirname(artifact.path))
    expect(left).toEqual([path.basename(artifact.path)])
    expect(events.some((event) => event.type === 'playback.progress' && event.progress.sessionId === 'session-0001')).toBe(true)
  })

  it('serves a cache hit with stored provenance and falls back to Vorbis for entries without it', async () => {
    const { runtime, processes, root } = setup({ cached: { path: '/x.flac', format: flac, resolvedSourceId: TRACK } })
    await expect(runtime.resolve({ sourceId: TRACK, intent: 'playback' })).resolves.toMatchObject({
      path: '/x.flac', sourceFormat: { format: 'VORBIS', isLossless: false },
    })
    expect(processes).toHaveLength(0)
    expect(root).toBeTruthy()
  })

  it('refuses non-Spotify IDs and missing playback sign-in', async () => {
    await expect(setup().runtime.resolve({ sourceId: 'tidal-123', intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    await expect(setup({ session: null }).runtime.resolve({ sourceId: TRACK, intent: 'playback' }))
      .rejects.toMatchObject({ providerError: { code: 'NOT_AUTHENTICATED' } })
  })

  it('rejects an artifact for a different track than requested', async () => {
    const { runtime, cache } = setup({
      script: (defaults) => ({
        ...defaults,
        onRequest(process, request) {
          fs.writeFileSync(String(request.outputPath), 'OggS')
          process.event({ event: 'artifact-ready', trackId: '0000000000000000000000', path: request.outputPath, codec: 'vorbis', bitrateKbps: 320, durationMs: 1 })
          process.event({ event: 'completed' })
          process.exit(0)
        },
      }),
    })
    await expect(runtime.resolve({ sourceId: TRACK, intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'INTERNAL' } })
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('rejects a conversion with the wrong length', async () => {
    const { runtime, cache } = setup({ durationMs: 30_000 })
    await expect(runtime.resolve({ sourceId: TRACK, intent: 'playback' })).rejects.toThrow(/unexpected length/)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('maps helper failures and invalidates a rejected credential', async () => {
    const failing = (code: string) => setup({
      script: (defaults) => ({
        ...defaults,
        onRequest(process) {
          process.event({ event: 'failed', code, message: code, retryable: code === 'network' })
          process.exit(1)
        },
      }),
    })
    const rejected = failing('credentials-rejected')
    await expect(rejected.runtime.resolve({ sourceId: TRACK, intent: 'playback' })).rejects.toMatchObject({ providerError: { code: 'AUTH_EXPIRED' } })
    expect(rejected.auth.invalidatePlayback).toHaveBeenCalledWith('rejected', expect.any(String))
    await expect(failing('audio-key').runtime.resolve({ sourceId: TRACK, intent: 'playback' }))
      .rejects.toMatchObject({ providerError: { code: 'PROVIDER_UNAVAILABLE', retryable: false } })
    await expect(failing('track-unavailable').runtime.resolve({ sourceId: TRACK, intent: 'playback' }))
      .rejects.toMatchObject({ providerError: { code: 'NOT_FOUND' } })
    await expect(failing('network').runtime.resolve({ sourceId: TRACK, intent: 'playback' }))
      .rejects.toMatchObject({ providerError: { code: 'NETWORK', retryable: true } })
  })

  it('coalesces concurrent requests for the same track and cancels by session', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { runtime, processes } = setup({
      script: (defaults) => ({
        ...defaults,
        async onRequest(process, request) {
          void gate.then(() => defaults.onRequest(process, request))
        },
        onWrite(process, data) {
          if (data.includes('"cancel"')) {
            process.event({ event: 'failed', code: 'cancelled', message: 'cancelled', retryable: false })
            process.exit(130)
          }
        },
      }),
    })
    const first = runtime.resolve({ sourceId: TRACK, sessionId: 'session-A001', intent: 'playback' })
    const second = runtime.resolve({ sourceId: TRACK, sessionId: 'session-B001', intent: 'playback' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(processes.filter((process) => process.binaryId === 'helper')).toHaveLength(1)
    expect(await runtime.cancelSession('session-A001')).toBe(true)
    expect(await runtime.cancelSession('unknown-session')).toBe(false)
    expect(await runtime.cancelSession('session-B001')).toBe(true)
    await expect(first).rejects.toMatchObject({ providerError: { code: 'CANCELLED' } })
    await expect(second).rejects.toMatchObject({ providerError: { code: 'CANCELLED' } })
    release()
  })

  it('removes stale partial files on activation', async () => {
    const { runtime, root } = setup()
    const dir = path.join(root, 'audio', 'abc')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${TRACK}.0b8e7c1a-5d2f-4c3b-9a1e-2f3d4c5b6a7e.ogg`), 'x')
    fs.writeFileSync(path.join(dir, `${TRACK}.r1.320.ogg`), 'keep')
    fs.writeFileSync(path.join(dir, `.tmp-${TRACK}.flac`), 'x')
    fs.writeFileSync(path.join(dir, `${TRACK}.r1.320.flac`), 'keep')
    await runtime.cleanupStaleFiles()
    expect(fs.readdirSync(dir).sort()).toEqual([`${TRACK}.r1.320.flac`, `${TRACK}.r1.320.ogg`])
  })

  it('hands over a growing Ogg with a caller session and finalizes it after verification', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const { runtime, events, cache, processes } = setup({
      vorbisPlayable: true,
      script: (defaults) => ({
        ...defaults,
        onRequest(process, request) {
          expect(request).toMatchObject({ progressive: true, readyBytes: 320_000 })
          fs.writeFileSync(String(request.outputPath), 'OggS-partial')
          process.event({ event: 'progress', bytesCompleted: 3 * PROGRESS_SEGMENT_BYTES, bytesTotal: 10 * PROGRESS_SEGMENT_BYTES })
          process.event({ event: 'growing', trackId: request.trackId, path: request.outputPath, codec: 'vorbis', bitrateKbps: 320, durationMs: 180_000, bytes: 320_000 })
          void gate.then(() => defaults.onRequest(process, request))
        },
      }),
    })
    const artifact = await runtime.resolve({ sourceId: TRACK, sessionId: 'session-grow1', intent: 'playback' })
    expect(artifact).toMatchObject({ lifecycle: 'growing', sessionId: 'session-grow1', format: { format: 'VORBIS', bitrate: 320 } })
    expect(artifact.path).toMatch(/\.[0-9a-f-]{36}\.ogg$/)
    expect(fs.existsSync(artifact.path)).toBe(true)
    expect(cache.put).not.toHaveBeenCalled()
    const progress = events.find((event) => event.type === 'playback.progress')
    expect(progress).toMatchObject({ progress: { itemsCompleted: 3, itemsTotal: 10, sessionId: 'session-grow1' } })

    runtime.markPlaybackStarted('session-grow1')
    finish()
    await vi.waitFor(() => expect(events.some((event) => event.type === 'playback.session' && event.session.state === 'completed')).toBe(true))
    const sessions = events.filter((event) => event.type === 'playback.session').map((event) => event.type === 'playback.session' ? event.session : null)
    expect(sessions.map((session) => session!.state)).toEqual(['created', 'running', 'running', 'completed'])
    expect(sessions[2]!.playbackStarted).toBe(true)
    const completed = sessions.at(-1)!
    expect(completed.artifactPath).toMatch(new RegExp(`${TRACK}\\.r1\\.320\\.ogg$`))
    expect(fs.existsSync(completed.artifactPath!)).toBe(true)
    expect(fs.existsSync(artifact.path)).toBe(false)
    // Revisions only grow, across progress and session events.
    const revisions = events.flatMap((event) => event.type === 'playback.session' ? [event.session.revision] : event.type === 'playback.progress' ? [event.progress.revision] : [])
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({ path: completed.artifactPath }))
    expect(processes.map((process) => process.binaryId)).toEqual(['helper', 'probe'])
  })

  it('reports a cancelled progressive session and removes the growing file', async () => {
    const { runtime, events } = setup({
      vorbisPlayable: true,
      script: (defaults) => ({
        ...defaults,
        onRequest(process, request) {
          fs.writeFileSync(String(request.outputPath), 'OggS-partial')
          process.event({ event: 'growing', trackId: request.trackId, path: request.outputPath, codec: 'vorbis', bitrateKbps: 320, durationMs: 1, bytes: 1 })
        },
        onWrite(process, data) {
          if (data.includes('"cancel"')) {
            process.event({ event: 'failed', code: 'cancelled', message: 'cancelled', retryable: false })
            process.exit(130)
          }
        },
      }),
    })
    const artifact = await runtime.resolve({ sourceId: TRACK, sessionId: 'session-stop1', intent: 'playback' })
    expect(await runtime.cancelSession('session-stop1')).toBe(true)
    await vi.waitFor(() => expect(events.some((event) => event.type === 'playback.session' && event.session.state === 'cancelled')).toBe(true))
    expect(fs.existsSync(artifact.path)).toBe(false)
  })

  it('keeps the full-file path without a session and on Macs without a Vorbis decoder', async () => {
    const noSession = setup({ vorbisPlayable: true })
    await expect(noSession.runtime.resolve({ sourceId: TRACK, intent: 'playback' })).resolves.toMatchObject({ lifecycle: 'complete' })
    const noDecoder = setup({ vorbisPlayable: false })
    await expect(noDecoder.runtime.resolve({ sourceId: TRACK, sessionId: 'session-flac1', intent: 'playback' }))
      .resolves.toMatchObject({ lifecycle: 'complete', format: { format: 'FLAC' } })
    expect(noDecoder.events.some((event) => event.type === 'playback.session')).toBe(false)
  })

  it('prefetches finished files and yields to playback of another track', async () => {
    const TRACK_B = '1uLU6hMCjMI75M1A2tKUQC'
    let releasePrefetch!: () => void
    const held = new Promise<void>((resolve) => { releasePrefetch = resolve })
    const { runtime, processes } = setup({
      vorbisPlayable: true,
      script: (defaults) => ({
        ...defaults,
        onRequest(process, request) {
          if (request.trackId === TRACK) void held.then(() => defaults.onRequest(process, request))
          else defaults.onRequest(process, request)
        },
        onWrite(process, data) {
          if (data.includes('"cancel"')) {
            process.event({ event: 'failed', code: 'cancelled', message: 'cancelled', retryable: false })
            process.exit(130)
          }
        },
      }),
    })
    const prefetched = runtime.prefetch({ sourceId: TRACK })
    await vi.waitFor(() => expect(processes.filter((process) => process.binaryId === 'helper')).toHaveLength(1))
    const playing = runtime.resolve({ sourceId: TRACK_B, intent: 'playback' })
    await expect(prefetched).resolves.toBeNull()
    await expect(playing).resolves.toMatchObject({ lifecycle: 'complete' })
    const helperRequests = processes.filter((process) => process.binaryId === 'helper').map((process) => JSON.parse(process.written[0]!).trackId)
    expect(helperRequests).toEqual([TRACK, TRACK_B])
    releasePrefetch()
    // A finished prefetch is a complete artifact usable for gapless queueing.
    await expect(runtime.prefetch({ sourceId: TRACK })).resolves.toMatchObject({ lifecycle: 'complete' })
  })

  it('applies the selected or requested quality tier and makes downgrades visible', async () => {
    const { runtime, events, processes, cache } = setup({
      vorbisPlayable: true,
      bitrate: 160,
      script: (defaults) => ({
        ...defaults,
        onRequest(process, request) {
          fs.writeFileSync(String(request.outputPath), 'OggS')
          process.event({ event: 'artifact-ready', trackId: request.trackId, path: request.outputPath, codec: 'vorbis', bitrateKbps: 96, durationMs: 180_000, bytes: 4 })
          process.event({ event: 'completed' })
          process.exit(0)
        },
      }),
    })
    const artifact = await runtime.resolve({ sourceId: TRACK, intent: 'playback' })
    expect(JSON.parse(processes[0]!.written[0]!).bitrate).toBe(160)
    expect(artifact.format.bitrate).toBe(96)
    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({ qualityKey: qualityKeyFor('listener', 160), resolvedQuality: 'VORBIS_96' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'warning', code: 'spotify-quality-downgrade' }))
    await runtime.resolve({ sourceId: '1uLU6hMCjMI75M1A2tKUQC', qualityTierId: 'vorbis-96', intent: 'playback' })
    expect(JSON.parse(processes.filter((process) => process.binaryId === 'helper')[1]!.written[0]!).bitrate).toBe(96)
  })
})

