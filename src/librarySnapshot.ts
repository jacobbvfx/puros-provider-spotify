import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ProviderLibraryRecordV1 } from 'puros-provider-sdk'

/** Bumped whenever the record mapping changes, so an older snapshot is never replayed. */
const SNAPSHOT_VERSION = 1

export interface LibrarySnapshot {
  /** When the snapshot's sync completed, ms since epoch. */
  syncedAt: number
  records: ProviderLibraryRecordV1[]
}

/**
 * The records of the last complete library sync, per account. A sync shortly
 * after it replays them instead of asking Spotify again, so launches and
 * sign-ins cost no Web API requests. Provider-private, in the data root.
 */
export interface LibrarySnapshotStore {
  load(accountKey: string): Promise<LibrarySnapshot | null>
  save(accountKey: string, snapshot: LibrarySnapshot): Promise<void>
}

export function createFileLibrarySnapshotStore(dataRoot: () => Promise<string>): LibrarySnapshotStore {
  const file = async (accountKey: string) => {
    const account = createHash('sha256').update(accountKey).digest('hex').slice(0, 12)
    return path.join(await dataRoot(), 'library-snapshot', `${account}.json`)
  }
  return {
    async load(accountKey) {
      try {
        const parsed = JSON.parse(await fs.readFile(await file(accountKey), 'utf8')) as {
          version?: number; accountKey?: string; syncedAt?: number; records?: ProviderLibraryRecordV1[]
        }
        if (parsed.version !== SNAPSHOT_VERSION || parsed.accountKey !== accountKey) return null
        if (typeof parsed.syncedAt !== 'number' || !Array.isArray(parsed.records)) return null
        return { syncedAt: parsed.syncedAt, records: parsed.records }
      } catch {
        return null
      }
    },
    async save(accountKey, snapshot) {
      const target = await file(accountKey)
      await fs.mkdir(path.dirname(target), { recursive: true })
      const temporary = `${target}.${process.pid}.tmp`
      await fs.writeFile(temporary, JSON.stringify({ version: SNAPSHOT_VERSION, accountKey, ...snapshot }))
      await fs.rename(temporary, target)
    },
  }
}
