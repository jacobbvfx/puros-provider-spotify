import { describe, expect, it } from 'vitest'
import { redact, SpotifyHelperError, SpotifyHelperTransport } from './SpotifyHelperTransport'
import { fakeHelpers, requestOf } from './testSupport'

describe('Spotify helper transport', () => {
  it('sends a fixed argv and variable data only on stdin, then reassembles fragmented events', async () => {
    const progress: unknown[] = []
    const { helpers, processes } = fakeHelpers({
      onRequest(process, request) {
        const line = JSON.stringify({ event: 'progress', version: 1, requestId: request.requestId, bytesCompleted: 5, bytesTotal: 10 })
        process.raw(line.slice(0, 7))
        process.raw(`${line.slice(7)}\n{"event":"completed","version":1,`)
        process.raw(`"requestId":"${request.requestId}"}\n`)
        process.exit(0)
      },
    })
    const events = await new SpotifyHelperTransport(helpers).run('fetch-track', { trackId: '4uLU6hMCjMI75M1A2tKUQC' }, {
      onEvent: (event) => { progress.push(event) },
    })
    expect(processes[0]).toMatchObject({ binaryId: 'helper', args: ['fetch-track'], stdinClosed: true })
    expect(requestOf(processes[0]!)).toMatchObject({ version: 1, trackId: '4uLU6hMCjMI75M1A2tKUQC' })
    expect(progress).toHaveLength(1)
    expect(events.map((event) => event.event)).toEqual(['progress', 'completed'])
  })

  it('keeps stdin open until the terminal event so EOF can mean cancellation', async () => {
    let stdinClosedBeforeResult: boolean | null = null
    const { helpers } = fakeHelpers({
      onRequest(process) {
        stdinClosedBeforeResult = process.stdinClosed
        process.event({ event: 'completed' })
        process.exit(0)
      },
    })
    await new SpotifyHelperTransport(helpers).run('describe', {})
    expect(stdinClosedBeforeResult).toBe(false)
  })

  it('maps failed events to typed errors and redacts credential material', async () => {
    const { helpers } = fakeHelpers({
      onRequest(process) {
        process.event({ event: 'failed', code: 'audio-key', message: 'rejected "authData":"c2VjcmV0" Bearer abc.def', retryable: false })
        process.exit(1)
      },
    })
    const error = await new SpotifyHelperTransport(helpers).run('fetch-track', {}).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(SpotifyHelperError)
    expect(error).toMatchObject({ code: 'audio-key', retryable: false })
    expect((error as Error).message).not.toContain('c2VjcmV0')
    expect((error as Error).message).not.toContain('abc.def')
  })

  it('fails on a crash without result, malformed output and version mismatch', async () => {
    const crash = fakeHelpers({ onRequest(process) { process.push({ type: 'stderr', data: new TextEncoder().encode('panic: boom\n') }); process.exit(101) } })
    await expect(new SpotifyHelperTransport(crash.helpers).run('login', {})).rejects.toThrow(/without a result.*boom/)

    const malformed = fakeHelpers({ onRequest(process) { process.raw('not json\n'); process.exit(0) } })
    await expect(new SpotifyHelperTransport(malformed.helpers).run('login', {})).rejects.toThrow(/malformed/)
    expect(malformed.processes[0]!.terminated).toBe(true)

    const version = fakeHelpers({ onRequest(process) { process.raw('{"event":"completed","version":9}\n'); process.exit(0) } })
    await expect(new SpotifyHelperTransport(version.helpers).run('login', {})).rejects.toThrow(/version/)
  })

  it('bounds a runaway protocol line', async () => {
    const { helpers } = fakeHelpers({ onRequest(process) { process.raw('x'.repeat(300 * 1024)) } })
    await expect(new SpotifyHelperTransport(helpers).run('login', {})).rejects.toThrow(/bound/)
  })

  it('ignores events for other requests', async () => {
    const { helpers } = fakeHelpers({
      onRequest(process) {
        process.raw('{"event":"completed","version":1,"requestId":"someone-else"}\n')
        process.event({ event: 'failed', code: 'network', message: 'offline', retryable: true })
        process.exit(1)
      },
    })
    await expect(new SpotifyHelperTransport(helpers).run('login', {})).rejects.toMatchObject({ code: 'network', retryable: true })
  })

  it('cancels by writing a cancel line, closing stdin and terminating after a grace period', async () => {
    const abort = new AbortController()
    const { helpers, processes } = fakeHelpers({
      onRequest() { abort.abort() },
      onWrite(process, data) {
        if (data.includes('"cancel"')) {
          process.event({ event: 'failed', code: 'cancelled', message: 'operation cancelled', retryable: false })
          process.exit(130)
        }
      },
    })
    await expect(new SpotifyHelperTransport(helpers).run('fetch-track', {}, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(processes[0]!.written[1]).toBe('{"type":"cancel"}\n')
    expect(processes[0]!.stdinClosed).toBe(true)
  })

  it('terminates every running helper', async () => {
    const { helpers, processes } = fakeHelpers()
    const transport = new SpotifyHelperTransport(helpers)
    const running = transport.run('fetch-track', {}).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await transport.terminateAll()
    expect(await running).toBeInstanceOf(Error)
    expect(processes[0]!.terminated).toBe(true)
  })

  it('redacts tokens in free text', () => {
    expect(redact('{"accessToken":"abc","x":1}')).toBe('{"accessToken":"[redacted]","x":1}')
    expect(redact('Authorization: Bearer eyJ.abc-def')).toBe('Authorization: Bearer [redacted]')
  })
})
