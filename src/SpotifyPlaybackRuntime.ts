import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PROVIDER_SESSION_ID_PATTERN,
  ProviderApiError,
  providerError,
  type FormatInfoV1,
  type PlaybackArtifactV1,
  type PlaybackResolveRequestV1,
  type ProviderErrorCodeV1,
  type ProviderErrorV1,
  type ProviderEventV1,
  type ProviderHostV1,
  type ProviderPlaybackSessionStateV1,
} from 'puros-provider-sdk'
import { probeDurationMs, transcodeToFlac } from './ffmpeg'
import { isSpotifyId } from './mapping'
import type { SpotifyAuthService } from './SpotifyAuthService'
import { SpotifyHelperError, findEvent, type SpotifyHelperEvent, type SpotifyHelperTransport } from './SpotifyHelperTransport'

/** Bump when the preparation pipeline changes so old artifacts are not reused. */
export const PREPARATION_REVISION = 1
const DURATION_TOLERANCE_MS = 3_000
const AUDIO_DIR = 'audio'
const WORK_DIR = 'work'
/** Seconds of audio that must be on disk before a growing file is handed to core. */
const GROWING_READY_SECONDS = 8
/**
 * Core resumes a starved progressive track after two more "segments" (or 8 MiB).
 * At Vorbis bitrates 8 MiB is minutes of audio, so progress is reported in
 * virtual segments of this size (~6.5 s at 320 kb/s).
 */
export const PROGRESS_SEGMENT_BYTES = 256 * 1024

type Auth = Pick<SpotifyAuthService, 'getPlaybackSession' | 'getAccountKey' | 'invalidatePlayback'>
type Helper = Pick<SpotifyHelperTransport, 'run' | 'terminateAll'>
/** Partial download written by the helper before verification: `<id>.<uuid>.ogg`. */
const PARTIAL_OGG = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ogg$/

type Host = Pick<ProviderHostV1, 'paths' | 'cache' | 'helpers' | 'logger'> & { events: Pick<ProviderHostV1['events'], 'emit'> }
type Intent = 'playback' | 'prefetch'

export interface SpotifyQualityTier {
  id: string
  bitrateKbps: 320 | 160 | 96
  label: string
  description: string
  rank: number
}

/** Only the Ogg Vorbis variants the pinned librespot backend can fetch. */
export const SPOTIFY_QUALITY_TIERS: SpotifyQualityTier[] = [
  { id: 'vorbis-320', bitrateKbps: 320, label: 'Very high', description: 'Ogg Vorbis 320 kb/s (lossy)', rank: 3 },
  { id: 'vorbis-160', bitrateKbps: 160, label: 'High', description: 'Ogg Vorbis 160 kb/s (lossy)', rank: 2 },
  { id: 'vorbis-96', bitrateKbps: 96, label: 'Normal', description: 'Ogg Vorbis 96 kb/s (lossy)', rank: 1 },
]
export const DEFAULT_QUALITY_TIER = 'vorbis-320'

export function tierById(id: string | null | undefined): SpotifyQualityTier | null {
  return SPOTIFY_QUALITY_TIERS.find((tier) => tier.id === id) ?? null
}

export function accountHash(accountKey: string): string {
  return createHash('sha256').update(accountKey).digest('hex').slice(0, 12)
}

export function qualityKeyFor(accountKey: string, bitrateKbps: number): string {
  return `vorbis-${bitrateKbps}-r${PREPARATION_REVISION}-${accountHash(accountKey)}`
}

/** Keep only the v1 fields; a host value may carry `undefined` members that payload validation rejects. */
export function plainFormat(format: FormatInfoV1): FormatInfoV1 {
  return {
    format: format.format,
    sampleRate: format.sampleRate,
    bitDepth: format.bitDepth,
    bitrate: Number.isFinite(format.bitrate) ? Math.round(format.bitrate) : 0,
    channels: format.channels,
    isLossless: format.isLossless,
    isHiRes: format.isHiRes,
    isMqa: format.isMqa,
    isDsd: format.isDsd,
    ...(typeof format.dsdRate === 'number' ? { dsdRate: format.dsdRate } : {}),
  }
}

export function vorbisSourceFormat(bitrateKbps: number, sampleRate: number, channels: number): FormatInfoV1 {
  return {
    format: 'VORBIS', sampleRate, bitDepth: 0, bitrate: bitrateKbps, channels,
    isLossless: false, isHiRes: false, isMqa: false, isDsd: false,
  }
}

const HELPER_ERROR_CODES: Record<string, { code: ProviderErrorCodeV1; message?: string }> = {
  'not-authenticated': { code: 'AUTH_EXPIRED', message: 'Spotify playback is not signed in; reconnect playback' },
  'credentials-rejected': { code: 'AUTH_EXPIRED', message: 'Spotify rejected the playback sign-in; reconnect playback' },
  'not-premium': { code: 'PERMISSION_DENIED', message: 'Spotify Premium is required for playback' },
  'track-not-found': { code: 'NOT_FOUND' },
  'track-unavailable': { code: 'NOT_FOUND' },
  'no-supported-file': { code: 'NOT_SUPPORTED' },
  // Audio key refusal means the backend is not usable for this account; never retry in a loop.
  'audio-key': { code: 'PROVIDER_UNAVAILABLE' },
  network: { code: 'NETWORK' },
  timeout: { code: 'TIMEOUT' },
  cancelled: { code: 'CANCELLED' },
  'invalid-request': { code: 'INVALID_ARGUMENT' },
}

function toProviderError(error: unknown): unknown {
  if (!(error instanceof SpotifyHelperError)) return error
  const mapped = HELPER_ERROR_CODES[error.code] ?? { code: 'INTERNAL' as const }
  return new ProviderApiError(providerError(mapped.code, mapped.message ?? error.message, {
    retryable: error.code === 'audio-key' ? false : error.retryable,
    details: { helperCode: error.code },
  }))
}

function errorShape(error: unknown): ProviderErrorV1 {
  const mapped = toProviderError(error)
  if (mapped instanceof ProviderApiError) return mapped.providerError
  return providerError('INTERNAL', mapped instanceof Error ? mapped.message : 'Spotify playback preparation failed', { retryable: false })
}

function cancelled(): SpotifyHelperError {
  return new SpotifyHelperError('cancelled', 'Spotify fetch cancelled', false)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

interface ProgressiveSession {
  sessionId: string
  revision: number
  playbackStarted: boolean
  state: ProviderPlaybackSessionStateV1
  growingPath: string | null
}

/** One download of one track at one quality; callers join it instead of fetching twice. */
interface Job {
  key: string
  sourceId: string
  intent: Intent
  abort: AbortController
  /** Caller sessions interested in this job; cancelling the last one stops it. */
  sessions: Set<string>
  /** First usable artifact: a growing file (progressive) or the finished one. */
  artifact: ReturnType<typeof deferred<PlaybackArtifactV1>>
  /** The finished, verified, cached artifact. */
  done: ReturnType<typeof deferred<PlaybackArtifactV1>>
  progressive: ProgressiveSession | null
  started: boolean
}

/**
 * File-artifact playback: librespot writes the exact Ogg Vorbis stream.
 *
 * - When core can play Vorbis (AudioToolbox on recent macOS) that file is the
 *   artifact. With a caller session it is handed over while still growing and
 *   finalized when the download is verified (`playback.progressive`).
 * - Otherwise the packaged ffmpeg decodes the finished stream into a 16-bit
 *   FLAC artifact that carries the lossy source as `sourceFormat`.
 *
 * Downloads run one at a time per account. Playback always goes first: a
 * running prefetch for another track is cancelled, and queued prefetches wait.
 */
export class SpotifyPlaybackRuntime {
  private readonly jobs = new Map<string, Job>()
  private readonly sessions = new Map<string, Job>()
  private readonly queue: Array<{ job: Job; start: () => void }> = []
  private running: Job | null = null
  private active = true
  private vorbisSupport: Promise<boolean> | null = null

  constructor(private readonly options: {
    host: Host
    auth: Auth
    helper: Helper
    /** Currently selected target bitrate; the actual one comes back from the helper. */
    getBitrate: () => Promise<number>
  }) {}

  private get host() { return this.options.host }

  /** Remove partial files a crashed previous run may have left behind. */
  async cleanupStaleFiles(): Promise<void> {
    const root = await this.host.paths.getCacheRoot()
    const audio = path.join(root, AUDIO_DIR)
    const entries = await fs.readdir(audio, { recursive: true, withFileTypes: true }).catch(() => [])
    await Promise.all(entries
      .filter((entry) => entry.isFile() && (PARTIAL_OGG.test(entry.name) || entry.name.endsWith('.part') || entry.name.startsWith('.tmp-')))
      .map((entry) => fs.unlink(path.join(entry.parentPath, entry.name)).catch(() => {})))
    await fs.rm(path.join(root, WORK_DIR), { recursive: true, force: true }).catch(() => {})
  }

  async resolve(request: PlaybackResolveRequestV1): Promise<PlaybackArtifactV1> {
    const context = await this.context(request.sourceId, request.qualityTierId)
    const cached = await this.cached(request.sourceId, context.qualityKey, context.bitrateKbps)
    if (cached) return cached
    const sessionId = request.intent === 'playback' && request.sessionId && PROVIDER_SESSION_ID_PATTERN.test(request.sessionId)
      ? request.sessionId
      : undefined
    const job = this.join(request.sourceId, context, request.intent, sessionId)
    try {
      return await job.artifact.promise
    } catch (error) {
      throw toProviderError(error)
    }
  }

  /** Download the next track in the background; `null` when skipped for playback or on failure. */
  async prefetch(request: Omit<PlaybackResolveRequestV1, 'intent'>): Promise<PlaybackArtifactV1 | null> {
    const context = await this.context(request.sourceId, request.qualityTierId)
    const cached = await this.cached(request.sourceId, context.qualityKey, context.bitrateKbps)
    if (cached) return cached
    const job = this.join(request.sourceId, context, 'prefetch', undefined)
    try {
      // Gapless queueing needs a finished file, never a growing one.
      return await job.done.promise
    } catch (error) {
      const code = errorShape(error).code
      if (code !== 'CANCELLED') {
        await this.host.logger.info('Spotify prefetch skipped', { sourceId: request.sourceId, code }).catch(() => {})
      }
      return null
    }
  }

  markPlaybackStarted(sessionId: string): void {
    const job = this.sessions.get(sessionId)
    if (!job?.progressive || job.progressive.playbackStarted) return
    job.progressive.playbackStarted = true
    void this.emitSession(job)
  }

  /** Cancel the work a caller session waits on; shared work stops once no session remains. */
  async cancelSession(sessionId: string): Promise<boolean> {
    const job = this.sessions.get(sessionId)
    if (!job) return false
    this.sessions.delete(sessionId)
    job.sessions.delete(sessionId)
    if (job.sessions.size === 0) job.abort.abort()
    return true
  }

  async cancelAll(): Promise<void> {
    for (const job of this.jobs.values()) job.abort.abort()
    await this.options.helper.terminateAll()
  }

  async shutdown(): Promise<void> {
    this.active = false
    await this.cancelAll()
  }

  // ---- request context and cache ----

  private async context(sourceId: string, qualityTierId: string | null | undefined) {
    if (!this.active) throw new ProviderApiError(providerError('PROVIDER_UNAVAILABLE', 'Spotify provider is inactive', { retryable: true }))
    if (!isSpotifyId(sourceId)) throw new ProviderApiError(providerError('NOT_FOUND', 'Spotify track not found', { retryable: false }))
    const accountKey = await this.options.auth.getAccountKey()
    const playback = await this.options.auth.getPlaybackSession()
    if (!accountKey || !playback) {
      throw new ProviderApiError(providerError('NOT_AUTHENTICATED', 'Connect Spotify playback in Settings → Accounts', { retryable: false }))
    }
    const bitrateKbps = tierById(qualityTierId)?.bitrateKbps ?? await this.options.getBitrate()
    return { accountKey, bitrateKbps, qualityKey: qualityKeyFor(accountKey, bitrateKbps) }
  }

  private async cached(sourceId: string, qualityKey: string, bitrateKbps: number): Promise<PlaybackArtifactV1 | null> {
    const cached = await this.host.cache.get({ sourceId, qualityKey })
    // A cached Ogg is only usable while core can still play it (e.g. not after moving the cache to an older Mac).
    if (!cached || cached.resolvedSourceId !== sourceId) return null
    if (cached.format.format === 'VORBIS' && !await this.canPlayVorbis()) return null
    const format = plainFormat(cached.format)
    if (format.format === 'VORBIS') return { path: cached.path, lifecycle: 'complete', format }
    return {
      path: cached.path,
      lifecycle: 'complete',
      format,
      sourceFormat: cached.sourceFormat ? plainFormat(cached.sourceFormat) : vorbisSourceFormat(bitrateKbps, format.sampleRate, format.channels),
    }
  }

  /** Asked once per activation; the host probes the system decoder itself. */
  private canPlayVorbis(): Promise<boolean> {
    this.vorbisSupport ??= Promise.resolve().then(() => this.host.cache.canPlayFormat('VORBIS')).catch(() => false)
    return this.vorbisSupport
  }

  // ---- scheduling ----

  private join(
    sourceId: string,
    context: { accountKey: string; bitrateKbps: number; qualityKey: string },
    intent: Intent,
    sessionId: string | undefined,
  ): Job {
    const key = `${context.qualityKey}:${sourceId}`
    let job = this.jobs.get(key)
    if (!job) {
      job = {
        key, sourceId, intent, abort: new AbortController(), sessions: new Set(),
        artifact: deferred(), done: deferred(), progressive: null, started: false,
      }
      const created = job
      this.jobs.set(key, created)
      this.enqueue(created, () => {
        void this.run(created, context, sessionId).finally(() => {
          if (this.jobs.get(key) === created) this.jobs.delete(key)
          for (const session of created.sessions) if (this.sessions.get(session) === created) this.sessions.delete(session)
        })
      })
    } else if (intent === 'playback' && job.intent === 'prefetch') {
      // Someone is listening now: the job may no longer be preempted.
      job.intent = 'playback'
      this.sortQueue()
    }
    if (sessionId) {
      job.sessions.add(sessionId)
      this.sessions.set(sessionId, job)
    }
    if (intent === 'playback') this.preemptPrefetch(job)
    return job
  }

  private enqueue(job: Job, start: () => void): void {
    this.queue.push({ job, start })
    this.sortQueue()
    this.pump()
  }

  private sortQueue(): void {
    // Stable: playback before prefetch, FIFO within each.
    const rank = (entry: { job: Job }) => (entry.job.intent === 'playback' ? 0 : 1)
    this.queue.sort((a, b) => rank(a) - rank(b))
  }

  private pump(): void {
    if (this.running) return
    const next = this.queue.shift()
    if (!next) return
    if (next.job.abort.signal.aborted) {
      next.job.artifact.reject(cancelled())
      next.job.done.reject(cancelled())
      this.jobs.delete(next.job.key)
      this.pump()
      return
    }
    this.running = next.job
    next.job.started = true
    next.start()
  }

  private preemptPrefetch(except: Job): void {
    const running = this.running
    if (running && running !== except && running.intent === 'prefetch') {
      void this.host.logger.info('Spotify prefetch preempted by playback', { sourceId: running.sourceId }).catch(() => {})
      running.abort.abort()
    }
  }

  private finish(job: Job): void {
    if (this.running === job) this.running = null
    this.pump()
  }

  // ---- events ----

  private async emit(event: ProviderEventV1): Promise<void> {
    await this.host.events.emit(event).catch(() => {})
  }

  private async emitSession(job: Job, artifactPath?: string, error?: ProviderErrorV1, format?: FormatInfoV1): Promise<void> {
    const session = job.progressive
    if (!session) return
    session.revision += 1
    await this.emit({
      type: 'playback.session',
      session: {
        sessionId: session.sessionId,
        sourceId: job.sourceId,
        state: session.state,
        playbackStarted: session.playbackStarted,
        revision: session.revision,
        ...(artifactPath ? { artifactPath } : {}),
        ...(format ? { format } : {}),
        ...(error ? { error } : {}),
      },
    })
  }

  // ---- the download ----

  private async run(job: Job, context: { accountKey: string; bitrateKbps: number; qualityKey: string }, sessionId: string | undefined): Promise<void> {
    const { accountKey, bitrateKbps: requestedKbps, qualityKey } = context
    const sourceId = job.sourceId
    const signal = job.abort.signal
    const root = await this.host.paths.getCacheRoot()
    const directory = path.join(root, AUDIO_DIR, accountHash(accountKey))
    const workDir = path.join(root, WORK_DIR)
    const unique = randomUUID()
    const oggPath = path.join(directory, `${sourceId}.${unique}.ogg`)
    const temporaryFlac = path.join(directory, `.tmp-${sourceId}.${unique}.flac`)
    const finalFlac = path.join(directory, `${sourceId}.r${PREPARATION_REVISION}.${requestedKbps}.flac`)
    const finalOgg = path.join(directory, `${sourceId}.r${PREPARATION_REVISION}.${requestedKbps}.ogg`)
    const startedAt = Date.now()
    let progressRevision = 0

    const reportProgress = async (bytesCompleted: number, bytesTotal: number | null, state: 'running' | 'completed' = 'running') => {
      const target = job.progressive?.sessionId ?? sessionId
      if (!target) return
      progressRevision = Math.max(progressRevision + 1, (job.progressive?.revision ?? 0) + 1)
      if (job.progressive) job.progressive.revision = progressRevision
      const elapsed = Math.max(1, Date.now() - startedAt)
      const bytesPerSecond = Math.round((bytesCompleted / elapsed) * 1000)
      await this.emit({
        type: 'playback.progress',
        progress: {
          sessionId: target, sourceId, state, bytesCompleted, bytesTotal,
          itemsCompleted: Math.floor(bytesCompleted / PROGRESS_SEGMENT_BYTES),
          itemsTotal: bytesTotal ? Math.max(1, Math.ceil(bytesTotal / PROGRESS_SEGMENT_BYTES)) : null,
          percent: bytesTotal ? Math.min(100, (bytesCompleted / bytesTotal) * 100) : null,
          bytesPerSecond,
          estimatedRemainingMs: bytesTotal && bytesPerSecond > 0 ? Math.round(((bytesTotal - bytesCompleted) / bytesPerSecond) * 1000) : null,
          playbackStarted: job.progressive?.playbackStarted ?? false,
          revision: progressRevision,
        },
      })
    }

    try {
      if (signal.aborted) throw cancelled()
      await fs.mkdir(directory, { recursive: true })
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
      // Another job may have finished this track while this one waited in the queue.
      const cached = await this.cached(sourceId, qualityKey, requestedKbps)
      if (cached) {
        job.artifact.resolve(cached)
        job.done.resolve(cached)
        return
      }
      const playback = await this.options.auth.getPlaybackSession()
      if (!playback || (await this.options.auth.getAccountKey()) !== accountKey) {
        throw new ProviderApiError(providerError('CANCELLED', 'Spotify account changed during playback preparation', { retryable: true }))
      }
      const direct = await this.canPlayVorbis()
      const progressive = direct && !!sessionId && job.intent === 'playback'
      if (progressive) {
        job.progressive = { sessionId: sessionId!, revision: 0, playbackStarted: false, state: 'created', growingPath: null }
        await this.emitSession(job)
      }

      let events: SpotifyHelperEvent[]
      try {
        events = await this.options.helper.run('fetch-track', {
          sessionId: sessionId ?? null,
          credentials: playback.credentials,
          trackId: sourceId,
          outputPath: oggPath,
          workDir,
          bitrate: requestedKbps,
          progressive,
          ...(progressive ? { readyBytes: Math.round((requestedKbps * 1000 / 8) * GROWING_READY_SECONDS) } : {}),
        }, {
          signal,
          onEvent: async (event) => {
            if (event.event === 'progress') {
              await reportProgress(Number(event.bytesCompleted) || 0, Number(event.bytesTotal) || null)
            } else if (event.event === 'growing' && job.progressive) {
              await this.acceptGrowing(job, event, oggPath, requestedKbps)
            }
          },
        })
      } catch (error) {
        if (error instanceof SpotifyHelperError) {
          if (error.code === 'credentials-rejected' || error.code === 'not-authenticated') {
            await this.options.auth.invalidatePlayback('rejected', 'Spotify rejected the playback sign-in; reconnect playback')
          } else if (error.code === 'not-premium') {
            await this.options.auth.invalidatePlayback('not-premium', 'Spotify Premium is required for playback')
          }
        }
        throw error
      }
      const ready = findEvent(events, 'artifact-ready')
      // Exact-source contract: the helper must report the requested track and path.
      if (ready.trackId !== sourceId || ready.path !== oggPath || ready.codec !== 'vorbis') {
        throw new ProviderApiError(providerError('INTERNAL', 'Spotify helper returned a different artifact than requested', { retryable: false }))
      }
      const actualKbps = Number(ready.bitrateKbps) || requestedKbps
      const expectedDurationMs = Number(ready.durationMs) || 0
      if (actualKbps < requestedKbps) {
        await this.emit({
          type: 'warning',
          code: 'spotify-quality-downgrade',
          message: `Spotify delivered ${actualKbps} kb/s instead of the selected ${requestedKbps} kb/s for this track`,
          retryable: false,
        })
      }
      if (signal.aborted) throw cancelled()

      const artifact = direct
        ? await this.finalizeOgg(oggPath, finalOgg, finalFlac, expectedDurationMs, actualKbps, signal)
        : await this.finalizeFlac(oggPath, temporaryFlac, finalFlac, finalOgg, expectedDurationMs, actualKbps, signal)
      await this.host.cache.put({
        sourceId,
        qualityKey,
        path: artifact.path,
        format: artifact.format,
        ...(artifact.sourceFormat ? { sourceFormat: artifact.sourceFormat } : {}),
        resolvedSourceId: sourceId,
        resolvedQuality: `VORBIS_${actualKbps}`,
      })
      await this.host.cache.trim().catch(() => {})
      await reportProgress(1, 1, 'completed')
      if (job.progressive) {
        job.progressive.state = 'completed'
        await this.emitSession(job, artifact.path, undefined, artifact.format)
      }
      // Intermediates are gone before anyone sees the result.
      await fs.unlink(oggPath).catch(() => {})
      await fs.unlink(temporaryFlac).catch(() => {})
      job.artifact.resolve(artifact)
      job.done.resolve(artifact)
    } catch (error) {
      const aborted = signal.aborted || errorShape(error).code === 'CANCELLED'
      if (job.progressive && job.progressive.state !== 'completed') {
        job.progressive.state = aborted ? 'cancelled' : 'failed'
        await this.emitSession(job, undefined, aborted ? undefined : errorShape(error))
      }
      const failure = aborted && !(error instanceof ProviderApiError) ? cancelled() : error
      job.artifact.reject(failure)
      job.done.reject(failure)
    } finally {
      await fs.unlink(oggPath).catch(() => {})
      await fs.unlink(temporaryFlac).catch(() => {})
      this.finish(job)
    }
  }

  /** Hand the growing Ogg to core once its header decodes and enough audio is on disk. */
  private async acceptGrowing(job: Job, event: SpotifyHelperEvent, oggPath: string, requestedKbps: number): Promise<void> {
    const session = job.progressive!
    if (session.growingPath || event.path !== oggPath || event.trackId !== job.sourceId || event.codec !== 'vorbis') return
    const inspected = await this.host.cache.inspectFormat(oggPath).catch(() => null)
    const probed = inspected ? plainFormat(inspected) : null
    // An undecodable header keeps the job on the full-file path; `artifact-ready` still resolves it.
    if (!probed || probed.format !== 'VORBIS' || probed.sampleRate <= 0 || probed.channels <= 0) return
    session.growingPath = oggPath
    session.state = 'running'
    await this.emitSession(job)
    job.artifact.resolve({
      path: oggPath,
      lifecycle: 'growing',
      format: vorbisSourceFormat(Number(event.bitrateKbps) || requestedKbps, probed.sampleRate, probed.channels),
      sessionId: session.sessionId,
    })
  }

  private async verifyDuration(file: string, expectedDurationMs: number, signal: AbortSignal): Promise<void> {
    const durationMs = await probeDurationMs(this.host.helpers, file, signal)
    if (durationMs === null || (expectedDurationMs > 0
      && Math.abs(durationMs - expectedDurationMs) > Math.max(DURATION_TOLERANCE_MS, expectedDurationMs * 0.02))) {
      throw new ProviderApiError(providerError('INTERNAL', 'Prepared Spotify audio has an unexpected length', {
        retryable: true, details: { expectedDurationMs, durationMs },
      }))
    }
  }

  /** Core decodes Vorbis itself: publish the exact stream, no conversion. */
  private async finalizeOgg(
    oggPath: string, finalOgg: string, finalFlac: string, expectedDurationMs: number, kbps: number, signal: AbortSignal,
  ): Promise<PlaybackArtifactV1> {
    const inspected = await this.host.cache.inspectFormat(oggPath)
    const probed = inspected ? plainFormat(inspected) : null
    if (!probed || probed.format !== 'VORBIS' || probed.sampleRate <= 0 || probed.channels <= 0) {
      throw new ProviderApiError(providerError('INTERNAL', 'Downloaded Spotify audio is not a valid Ogg Vorbis file', { retryable: false }))
    }
    await this.verifyDuration(oggPath, expectedDurationMs, signal)
    if (signal.aborted) throw cancelled()
    // A reader that opened the growing path keeps its inode; the session event names the final path.
    await fs.rename(oggPath, finalOgg)
    await fs.unlink(finalFlac).catch(() => {})
    return { path: finalOgg, lifecycle: 'complete', format: vorbisSourceFormat(kbps, probed.sampleRate, probed.channels) }
  }

  /** Older macOS without a Vorbis decoder: decode into a 16-bit FLAC artifact. */
  private async finalizeFlac(
    oggPath: string, temporaryFlac: string, finalFlac: string, finalOgg: string,
    expectedDurationMs: number, kbps: number, signal: AbortSignal,
  ): Promise<PlaybackArtifactV1> {
    await transcodeToFlac(this.host.helpers, oggPath, temporaryFlac, signal)
    const inspected = await this.host.cache.inspectFormat(temporaryFlac)
    const format = inspected ? plainFormat(inspected) : null
    if (!format || (format.format !== 'FLAC' && format.format !== 'FLAC_HIRES') || format.sampleRate <= 0 || format.channels <= 0) {
      throw new ProviderApiError(providerError('INTERNAL', 'Converted Spotify audio is not a valid FLAC file', { retryable: false }))
    }
    await this.verifyDuration(temporaryFlac, expectedDurationMs, signal)
    if (signal.aborted) throw cancelled()
    await fs.rename(temporaryFlac, finalFlac)
    await fs.unlink(finalOgg).catch(() => {})
    return { path: finalFlac, lifecycle: 'complete', format, sourceFormat: vorbisSourceFormat(kbps, format.sampleRate, format.channels) }
  }
}
