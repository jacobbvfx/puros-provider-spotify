import type { ProviderHelperOutputV1, ProviderHelpersHostV1 } from 'puros-provider-sdk'

/** Test-only fake of one helper process spawned through `host.helpers`. */
export interface FakeHelperProcess {
  binaryId: string
  args: string[]
  written: string[]
  stdinClosed: boolean
  terminated: boolean
  push(output: ProviderHelperOutputV1): void
  /** Write one protocol event line (version and requestId filled in). */
  event(value: Record<string, unknown>): void
  raw(text: string): void
  exit(code?: number): void
}

export interface FakeHelperScript {
  /** Called once per spawn right away (ffmpeg helpers get no request line). */
  onSpawn?(process: FakeHelperProcess): void | Promise<void>
  /** Called when the Spotify helper receives its JSON request line. */
  onRequest?(process: FakeHelperProcess, request: Record<string, unknown>): void | Promise<void>
  onWrite?(process: FakeHelperProcess, data: string): void | Promise<void>
  onClose?(process: FakeHelperProcess): void | Promise<void>
}

export function fakeHelpers(script: FakeHelperScript = {}) {
  const processes: FakeHelperProcess[] = []
  const byHandle = new Map<string, { process: FakeHelperProcess; items: ProviderHelperOutputV1[]; waiters: Array<(value: ProviderHelperOutputV1) => void> }>()
  let next = 0
  const helpers: ProviderHelpersHostV1 = {
    async spawn({ binaryId, args = [] }) {
      const handleId = `h${++next}`
      const entry = { items: [] as ProviderHelperOutputV1[], waiters: [] as Array<(value: ProviderHelperOutputV1) => void>, process: null as unknown as FakeHelperProcess }
      let requestId = 'unknown'
      const process: FakeHelperProcess = {
        binaryId, args, written: [], stdinClosed: false, terminated: false,
        push(output) {
          const waiter = entry.waiters.shift()
          if (waiter) waiter(output)
          else entry.items.push(output)
        },
        event(value) { process.raw(`${JSON.stringify({ version: 1, requestId, ...value })}\n`) },
        raw(text) { process.push({ type: 'stdout', data: new TextEncoder().encode(text) }) },
        exit(code = 0) { process.push({ type: 'exit', exitCode: code, signal: null }) },
      }
      entry.process = process
      ;(process as unknown as { setRequestId(id: string): void }).setRequestId = (id) => { requestId = id }
      byHandle.set(handleId, entry)
      processes.push(process)
      await script.onSpawn?.(process)
      return { handleId }
    },
    async write({ handleId, data }) {
      const { process } = byHandle.get(handleId)!
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      const first = process.written.length === 0
      process.written.push(text)
      if (first) {
        const request = JSON.parse(text) as Record<string, unknown>
        ;(process as unknown as { setRequestId(id: string): void }).setRequestId(String(request.requestId))
        await script.onRequest?.(process, request)
      } else {
        await script.onWrite?.(process, text)
      }
    },
    async closeStdin(handleId) {
      const { process } = byHandle.get(handleId)!
      process.stdinClosed = true
      await script.onClose?.(process)
    },
    async read(handleId) {
      const entry = byHandle.get(handleId)!
      const item = entry.items.shift()
      if (item) return item
      return new Promise((resolve) => entry.waiters.push(resolve))
    },
    async terminate(handleId) {
      const entry = byHandle.get(handleId)
      if (!entry || entry.process.terminated) return
      entry.process.terminated = true
      entry.process.push({ type: 'exit', exitCode: null, signal: 'SIGTERM' })
    },
  }
  return { helpers, processes }
}

export function requestOf(process: FakeHelperProcess): Record<string, unknown> {
  return JSON.parse(process.written[0]!) as Record<string, unknown>
}
