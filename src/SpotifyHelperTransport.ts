import { randomUUID } from 'node:crypto'
import type { ProviderHelpersHostV1 } from 'puros-provider-sdk'

export const HELPER_PROTOCOL_VERSION = 1
export type SpotifyHelperCommand = 'describe' | 'login' | 'check-session' | 'fetch-track'

/** Bound on one protocol line; events are small, anything longer is a broken helper. */
const MAX_LINE_BYTES = 256 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const CANCEL_GRACE_MS = 1_500

export type SpotifyHelperEvent = Record<string, unknown> & { event: string; requestId?: string }

export class SpotifyHelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'SpotifyHelperError'
  }
}

export interface SpotifyHelperRunOptions {
  onEvent?: (event: SpotifyHelperEvent) => void | Promise<void>
  signal?: AbortSignal
}

/** Strip anything that looks like a credential before a helper message reaches logs or errors. */
export function redact(text: string): string {
  return text
    .replace(/("?(?:authData|auth_data|accessToken|access_token|refreshToken|refresh_token)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+=*/g, '$1 [redacted]')
}

/**
 * Private NDJSON transport for the declared Spotify helper. argv is a fixed
 * command; every variable value travels in the stdin request. stdin stays open
 * for the whole operation so a `cancel` line (or EOF when this process dies)
 * reaches the helper. Nothing here is sent to the renderer.
 */
export class SpotifyHelperTransport {
  private readonly active = new Set<string>()

  constructor(private readonly helpers: ProviderHelpersHostV1) {}

  async run(
    command: SpotifyHelperCommand,
    payload: Record<string, unknown>,
    options: SpotifyHelperRunOptions = {},
  ): Promise<SpotifyHelperEvent[]> {
    if (options.signal?.aborted) throw new SpotifyHelperError('cancelled', 'Spotify helper operation cancelled', false)
    const requestId = randomUUID()
    const { handleId } = await this.helpers.spawn({ binaryId: 'helper', args: [command] })
    this.active.add(handleId)
    const decoder = new TextDecoder()
    const events: SpotifyHelperEvent[] = []
    let buffered = ''
    let stderr = ''
    let terminal: SpotifyHelperEvent | null = null
    let stdinOpen = true
    let cancelTimer: ReturnType<typeof setTimeout> | undefined

    const closeStdin = async () => {
      if (!stdinOpen) return
      stdinOpen = false
      await this.helpers.closeStdin(handleId).catch(() => {})
    }
    const onAbort = () => {
      void (async () => {
        if (stdinOpen) await this.helpers.write({ handleId, data: '{"type":"cancel"}\n' }).catch(() => {})
        await closeStdin()
        cancelTimer = setTimeout(() => { void this.helpers.terminate(handleId).catch(() => {}) }, CANCEL_GRACE_MS)
      })()
    }

    const acceptLine = async (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        throw new SpotifyHelperError('internal', 'Spotify helper wrote a malformed protocol line', false)
      }
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { event?: unknown }).event !== 'string') {
        throw new SpotifyHelperError('internal', 'Spotify helper wrote an unknown protocol value', false)
      }
      const event = parsed as SpotifyHelperEvent
      if (event.version !== HELPER_PROTOCOL_VERSION) {
        throw new SpotifyHelperError('internal', 'Spotify helper protocol version mismatch', false)
      }
      if (event.requestId !== requestId && event.requestId !== 'unknown') return
      events.push(event)
      if (event.event === 'completed' || event.event === 'failed') {
        terminal = event
        await closeStdin()
      } else {
        await options.onEvent?.(event)
      }
    }

    try {
      options.signal?.addEventListener('abort', onAbort, { once: true })
      await this.helpers.write({
        handleId,
        data: `${JSON.stringify({ version: HELPER_PROTOCOL_VERSION, requestId, ...payload })}\n`,
      })
      let exited: { exitCode: number | null; signal: string | null } | null = null
      while (!exited) {
        const output = await this.helpers.read(handleId)
        if (output.type === 'stdout') {
          buffered += decoder.decode(output.data, { stream: true })
          let newline: number
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline)
            buffered = buffered.slice(newline + 1)
            await acceptLine(line)
          }
          if (buffered.length > MAX_LINE_BYTES) throw new SpotifyHelperError('internal', 'Spotify helper protocol line exceeded its bound', false)
        } else if (output.type === 'stderr') {
          stderr = (stderr + decoder.decode(output.data)).slice(-MAX_STDERR_BYTES)
        } else if (output.type === 'error') {
          throw new SpotifyHelperError('internal', `Spotify helper failed: ${output.message}`, false)
        } else if (output.type === 'exit') {
          exited = { exitCode: output.exitCode, signal: output.signal }
        }
      }
      buffered += decoder.decode()
      if (buffered.trim()) await acceptLine(buffered)
      const result = terminal as SpotifyHelperEvent | null
      if (options.signal?.aborted && result?.event !== 'completed') {
        throw new SpotifyHelperError('cancelled', 'Spotify helper operation cancelled', false)
      }
      if (!result) {
        const detail = redact(stderr.trim().split('\n').slice(-3).join(' ')).slice(0, 500)
        throw new SpotifyHelperError(
          'internal',
          `Spotify helper exited without a result (code ${exited.exitCode ?? exited.signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
          false,
        )
      }
      if (result.event === 'failed') {
        throw new SpotifyHelperError(
          typeof result.code === 'string' ? result.code : 'internal',
          redact(typeof result.message === 'string' ? result.message : 'Spotify helper failed'),
          result.retryable === true,
        )
      }
      return events
    } catch (error) {
      await this.helpers.terminate(handleId).catch(() => {})
      throw error
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer)
      options.signal?.removeEventListener('abort', onAbort)
      await closeStdin()
      this.active.delete(handleId)
    }
  }

  /** Terminate every running helper (logout, deactivate). */
  async terminateAll(): Promise<void> {
    await Promise.all([...this.active].map((handleId) => this.helpers.terminate(handleId).catch(() => {})))
  }
}

export function findEvent(events: SpotifyHelperEvent[], name: string): SpotifyHelperEvent {
  const event = events.find((value) => value.event === name)
  if (!event) throw new SpotifyHelperError('internal', `Spotify helper did not report ${name}`, false)
  return event
}
