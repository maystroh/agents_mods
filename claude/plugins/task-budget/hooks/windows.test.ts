// Windows copy: the home folder, the chat file slug and the effort read. Written by the packaging script.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { effortFromFile, homeOf } from './engine.ts'

function fake(env: Record<string, string>, files: Record<string, string> = {}, cwd = 'C:\\Users\\x\\proj'): { $: EngineInterface; reads: string[] } {
  const reads: string[] = []
  const $ = {
    env: { get: async (k: string) => env[k] },
    session: { id: async () => 'abc', cwd: async () => cwd },
    fs: {
      read: async (p: string) => {
        reads.push(p)
        if (p in files) return files[p]
        throw new Error('no file')
      },
    },
  } as unknown as EngineInterface
  return { $, reads }
}

test('windows: the home folder is USERPROFILE, with forward slashes', async () => {
  expect(await homeOf(fake({ USERPROFILE: 'C:\\Users\\x', HOME: '/home/x' }).$)).toBe('C:/Users/x')
})

test('windows: with no USERPROFILE the home folder is HOME', async () => {
  expect(await homeOf(fake({ HOME: '/home/x' }).$)).toBe('/home/x')
  expect(await homeOf(fake({}).$)).toBe('')
})

test('windows: the chat file is found by the Windows slug, and the last effort level wins', async () => {
  const path = 'C:/Users/x/.claude/projects/C--Users-x-proj/abc.jsonl'
  const { $, reads } = fake({ USERPROFILE: 'C:\\Users\\x' }, { [path]: '{"effort":"high"}\n{"effort":"low"}\n' })
  expect(await effortFromFile($)).toBe('low')
  expect(reads).toEqual([path])
})

test('windows: no chat file gives no effort level', async () => {
  expect(await effortFromFile(fake({ USERPROFILE: 'C:\\Users\\x' }).$)).toBe('')
})
