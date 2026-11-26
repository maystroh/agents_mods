// Public copy: a new install with no memory and no history uses the general starter. Written by the packaging script.
import { expect, test } from 'claude-code/testing'

import { FRESH_TOKENS, freshFrom, startGuess } from './core.ts'
import { renderAll, typeOf, WORK_LABEL } from './memory.ts'
import { STARTER } from './starter.ts'

const NO_CALIB = { n: 0, idle: 0, step: 0 }

test('new install: the starter has the general type names only', () => {
  const stats = JSON.parse(renderAll([], '2026-11-18T00:00:00.000Z')['stats.json'] ?? '{}') as Record<string, { path?: unknown }>
  for (const t of Object.keys(STARTER.types)) expect(t in WORK_LABEL).toBe(true)
  for (const old of ['mods', 'vault', 'video_script', 'video_edit', 'community', 'skills', 'slides', 'dashboards']) {
    expect(old in STARTER.types).toBe(false)
    expect(old in stats).toBe(false)
  }
  expect(Object.keys(stats).sort()).toEqual(Object.keys(STARTER.types).sort())
})

test('new install: a starter type with a cost path gives that path to the estimate', () => {
  const stats = JSON.parse(renderAll([], '2026-11-18T00:00:00.000Z')['stats.json'] ?? '{}') as Record<string, { path?: unknown }>
  const withPath = Object.entries(STARTER.types).filter(([, s]) => s.path)
  expect(withPath.length > 0).toBe(true)
  for (const [t, s] of withPath) {
    expect(s.path!.n >= 5).toBe(true)
    expect(stats[t]?.path).toEqual(s.path)
  }
})

test('new install: the chat start guess comes from the starter, by model', () => {
  expect(FRESH_TOKENS).toBe(183_000)
  expect(STARTER.start).toEqual({"opus": 152260, "fable": 129383, "sonnet": 179098, "haiku": 101876})
  expect(STARTER.startAll).toBe(150883)
  expect(freshFrom({}, NO_CALIB, '/work', 0, 'idle').tokens).toBe(150883)
  for (const [fam, tokens] of Object.entries(STARTER.start ?? {})) {
    const model = `claude-${fam}-5-5`
    expect(startGuess(model)).toBe(tokens)
    expect(freshFrom({}, NO_CALIB, '/work', 0, 'idle', undefined, model)).toEqual({ tokens, how: 'guess' })
  }
  // No model known: the all-model median.
  expect(startGuess('')).toBe(150883)
  // A count from the engine still wins over the guess, and the person's own chats win over both.
  expect(freshFrom({}, NO_CALIB, '/work', 50_000, 'idle', undefined, 'claude-opus-5-5').how).toBe('measured')
  expect(freshFrom({ '/work': { n: 1, tokens: 42_000 } }, NO_CALIB, '/work', 0, 'idle', undefined, 'claude-opus-5-5')).toEqual({ tokens: 42_000, how: 'folder' })
})

test('new install: plain tasks get the general types', () => {
  expect(typeOf('build a claude code plugin with a status line')).toBe('claude_tools')
  expect(typeOf('write a blog post draft about pricing')).toBe('writing')
  expect(typeOf('cut the clips and add captions to the video')).toBe('video_media')
  expect(typeOf('organise my notes and the daily note')).toBe('notes_docs')
  expect(typeOf('redesign the landing page')).toBe('design')
  expect(typeOf('research and compare three tools')).toBe('research')
  expect(typeOf('fix the bug in the api')).toBe('code')
  expect(typeOf('find leads and update the crm')).toBe('sales')
  expect(typeOf('reply to the unread emails in my inbox')).toBe('inbox')
  expect(typeOf('hello there')).toBe('other')
})
