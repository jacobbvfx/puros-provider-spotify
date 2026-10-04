import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFilePlaylistCache, trackSubset } from './playlistCache'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('file playlist snapshot cache', () => {
  it('round-trips per account and snapshot, keeping only mapped fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'puros-spotify-playlist-cache-'))
    roots.push(root)
    const cache = createFilePlaylistCache(async () => root)
    const track = trackSubset({
      id: '4uLU6hMCjMI75M1A2tKUQC', name: 'One', duration_ms: 1000, popularity: 80,
      artists: [{ id: '0OdUWJ0sBjDrqHygGUXeCF', name: 'Band' }], album: { id: '4aawyAB9vmqN3uQ7FjRGTy', name: 'Album', images: [] },
    } as never)
    expect(Object.hasOwn(track, 'popularity')).toBe(false)
    await cache.save('user-1', 'playlist-1', 'snap-a', [{ position: 3, track }])
    expect(await cache.load('user-1', 'playlist-1', 'snap-a')).toEqual([{ position: 3, track }])
    expect(await cache.load('user-1', 'playlist-1', 'snap-b')).toBeNull()
    expect(await cache.load('user-2', 'playlist-1', 'snap-a')).toBeNull()
    expect(await cache.load('user-1', '../escape', 'snap-a')).toBeNull()
  })
})
