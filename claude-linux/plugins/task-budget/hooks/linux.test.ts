// Linux copy: the home folder, the chat file slug and the effort read.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { effortFromFile, homeOf } from './engine.ts'

function fake(env: Record<string, string>, files: Record<string, string> = {}, cwd = '/home/x/proj'): { $: EngineInterface; reads: string[] } {
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

test('linux: the home folder is HOME', async () => {
  expect(await homeOf(fake({ HOME: '/home/x', USERPROFILE: 'C:\\Users\\x' }).$)).toBe('/home/x')
})

test('linux: with no HOME the home folder is USERPROFILE, with forward slashes', async () => {
  expect(await homeOf(fake({ USERPROFILE: 'C:\\Users\\x' }).$)).toBe('C:/Users/x')
  expect(await homeOf(fake({}).$)).toBe('')
})

test('linux: the chat file is found by the Linux slug, and the last effort level wins', async () => {
  const path = '/home/x/.claude/projects/-home-x-proj/abc.jsonl'
  const { $, reads } = fake({ HOME: '/home/x' }, { [path]: '{"effort":"high"}\n{"effort":"low"}\n' })
  expect(await effortFromFile($)).toBe('low')
  expect(reads).toEqual([path])
})

test('linux: no chat file gives no effort level', async () => {
  expect(await effortFromFile(fake({ HOME: '/home/x' }).$)).toBe('')
})
