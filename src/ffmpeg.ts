import type { ProviderHelpersHostV1 } from 'puros-provider-sdk'

/** Exact argv of the manifest's `transcode` helper (Ogg Vorbis → 16-bit FLAC, triangular dither). */
export function transcodeArguments(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-i', input, '-map', '0:a:0', '-vn',
    '-af', 'aresample=osf=s16:dither_method=triangular',
    '-c:a', 'flac', '-compression_level', '5', '-map_metadata', '-1',
    '-f', 'flac', output,
  ]
}

/** Exact argv of the manifest's `probe` helper: decode everything, report the final timestamp. */
export function probeArguments(input: string): string[] {
  return ['-hide_banner', '-nostdin', '-threads', '1', '-i', input, '-map', '0:a:0', '-f', 'null', '-']
}

const MAX_STDERR = 64 * 1024

async function runFfmpeg(
  helpers: ProviderHelpersHostV1,
  binaryId: 'transcode' | 'probe',
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const { handleId } = await helpers.spawn({ binaryId, args })
  const onAbort = () => { void helpers.terminate(handleId).catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  const decoder = new TextDecoder()
  let stderr = ''
  try {
    await helpers.closeStdin(handleId)
    while (true) {
      const event = await helpers.read(handleId)
      if (event.type === 'stderr') stderr = (stderr + decoder.decode(event.data)).slice(-MAX_STDERR)
      else if (event.type === 'error') throw new Error(`ffmpeg failed: ${event.message}`)
      else if (event.type === 'exit') {
        if (signal?.aborted) throw Object.assign(new Error('Spotify audio preparation cancelled'), { name: 'AbortError' })
        if (event.exitCode !== 0) {
          throw new Error(`ffmpeg ${binaryId} exited with ${event.exitCode ?? event.signal}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`)
        }
        return stderr
      }
    }
  } catch (error) {
    await helpers.terminate(handleId).catch(() => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function transcodeToFlac(helpers: ProviderHelpersHostV1, input: string, output: string, signal?: AbortSignal): Promise<void> {
  await runFfmpeg(helpers, 'transcode', transcodeArguments(input, output), signal)
}

/** Parse the last `time=HH:MM:SS.xx` progress stamp ffmpeg printed. */
export function parseFfmpegDurationMs(stderr: string): number | null {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)]
  const last = matches[matches.length - 1]
  if (!last) return null
  return Math.round(((Number(last[1]) * 60 + Number(last[2])) * 60 + Number(last[3])) * 1000)
}

export async function probeDurationMs(helpers: ProviderHelpersHostV1, input: string, signal?: AbortSignal): Promise<number | null> {
  return parseFfmpegDurationMs(await runFfmpeg(helpers, 'probe', probeArguments(input), signal))
}
