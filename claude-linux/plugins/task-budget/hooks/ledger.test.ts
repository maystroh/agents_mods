import { expect, test } from 'claude-code/testing'

import { LEDGER_ROLL_BYTES, appendLine, liveLine, mergeRow, partsOf, queueLine, resultSizes, rowOf, splitOf, totalOf, type LedgerFs } from './ledger.ts'

// Every dollar amount here was worked out by hand from the price table:
// Opus 5.5 per million tokens: in 4, out 20, cache read 0.2, write 1h 8, write 5m 5.
// Haiku 5.5: in 0.1, out 0.5, read 0.01, 1h 0.2, 5m 0.125, and 5 times that above 100,000 prompt tokens.

const OPUS = 'claude-opus-5-5'

function close(a: number, b: number): void {
  expect(Math.abs(a - b)).toBeLessThan(1e-9)
}

test('the parts of one Opus request add up to the hand count', () => {
  // 1,000 in = $0.004; 2,000 out = $0.04; 100,000 read = $0.02; 10,000 1h = $0.08; 4,000 5m = $0.02
  const p = partsOf({ model: OPUS, in: 1000, out: 2000, cr: 100_000, cw: 14_000, w5: 4000, w1: 10_000, ws: 2, advisor: [], helperUsd: 0.5 })
  close(p.input, 0.004)
  close(p.output, 0.04)
  close(p.read, 0.02)
  close(p.write1h, 0.08)
  close(p.write5m, 0.02)
  close(p.writeUnsplit, 0)
  close(p.web, 0.02)
  close(p.helper, 0.5)
  close(totalOf(p), 0.684)
})

test('a cache write with no split is priced at the 1 hour price and kept apart', () => {
  const p = partsOf({ model: OPUS, in: 0, out: 0, cr: 0, cw: 10_000, w5: null, w1: null, ws: 0, advisor: [], helperUsd: 0 })
  close(p.writeUnsplit, 0.08)
  close(p.write1h, 0)
  expect(splitOf(10_000, null, null).isKnown).toBe(false)
  expect(splitOf(10_000, 0, 0).isKnown).toBe(false)
  expect(splitOf(10_000, 4000, 6000).isKnown).toBe(true)
  expect(splitOf(0, null, null).isKnown).toBe(true)
})

test('advisor calls are priced on their own model and added as one part', () => {
  // advisor on Opus: 50,000 in = $0.20, 1,000 out = $0.02
  const p = partsOf({
    model: OPUS, in: 0, out: 0, cr: 0, cw: 0, w5: 0, w1: 0, ws: 0, helperUsd: 0,
    advisor: [{ model: OPUS, in: 50_000, out: 1000, cr: 0, cw: 0, w5: 0, w1: 0 }],
  })
  close(p.advisor, 0.22)
  close(totalOf(p), 0.22)
})

test('Haiku 5.5 above 100,000 prompt tokens costs five times the table', () => {
  // 120,000 read at 0.01 x 5 = $0.006; 1,000 out at 0.5 x 5 = $0.0025
  const p = partsOf({ model: 'claude-haiku-5-5', in: 0, out: 1000, cr: 120_000, cw: 0, w5: 0, w1: 0, ws: 0, advisor: [], helperUsd: 0 })
  close(totalOf(p), 0.0085)
})

test('a transcript row becomes a ledger row with tools, effort, web searches and advisor', () => {
  const r = rowOf({
    type: 'assistant',
    timestamp: '2026-11-13T10:00:00.000Z',
    effort: 'high',
    message: {
      id: 'msg_1',
      model: OPUS,
      content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: {} }],
      usage: {
        input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 },
        server_tool_use: { web_search_requests: 1 },
        iterations: [{ type: 'message' }, { type: 'advisor_message', model: OPUS, input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      },
    },
  })
  expect(r).not.toBeNull()
  expect(r!.id).toBe('msg_1')
  expect(r!.effort).toBe('high')
  expect(r!.tools).toEqual([{ name: 'Read', id: 'tu1' }])
  expect(r!.ws).toBe(1)
  expect(r!.w1).toBe(40)
  expect(r!.advisor.length).toBe(1)
  expect(r!.t).toBe(Date.parse('2026-11-13T10:00:00.000Z'))
})

test('rows that are not priced requests give null', () => {
  expect(rowOf({ type: 'user', message: {} })).toBeNull()
  expect(rowOf({ type: 'assistant', message: { model: '<synthetic>', usage: {} } })).toBeNull()
  expect(rowOf({ type: 'assistant', message: { model: OPUS } })).toBeNull()
})

test('the rows of one streamed request merge to the largest counts and every tool', () => {
  const a = rowOf({ type: 'assistant', message: { id: 'm', model: OPUS, content: [{ type: 'tool_use', id: 'x', name: 'Bash' }], usage: { input_tokens: 1, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } })!
  const b = rowOf({ type: 'assistant', message: { id: 'm', model: OPUS, content: [{ type: 'tool_use', id: 'y', name: 'Read' }], usage: { input_tokens: 1, output_tokens: 90, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } })!
  const m = mergeRow(a, b)
  expect(m.out).toBe(90)
  expect(m.tools.map(t => t.name)).toEqual(['Bash', 'Read'])
})

test('tool result sizes are read from a user row', () => {
  const s = resultSizes({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'abcde' }, { type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'xyz' }, { type: 'text', text: '12' }] }] },
  })
  expect(s.get('a')).toBe(5)
  expect(s.get('b')).toBe(5)
})

test('a live line keeps the engine bill apart from the parts and marks the unknown split', () => {
  const line = liveLine({
    at: 1, session: 's', turnId: 't', index: 0, effort: 'high', tools: ['WebSearch', 'Read'], advisorCalls: 1,
    usage: { model: OPUS, input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 },
    billBefore: 1, billAfter: 1.2,
  })!
  const o = JSON.parse(line)
  // 0.004 + 0.04 + 0.02 + 0.08 (unsplit write at the 1h price) = 0.144
  expect(o.total).toBe(0.144)
  expect(o.parts.writeUnsplit).toBe(0.08)
  expect(o.split).toBe('unknown')
  expect(o.bill).toEqual({ before: 1, after: 1.2, delta: 0.2 })
  expect(o.webSearchCalls).toBe(1)
  expect(o.advisorCalls).toBe(1)
  expect(o.toolResultChars).toBeNull()
  expect(liveLine({ at: 1, session: 's', turnId: 't', index: 0, tools: [], advisorCalls: 0, usage: null, billBefore: null, billAfter: null })).toBeNull()
})

function memFs(start: Record<string, string> = {}, opts: { failRead?: boolean } = {}): LedgerFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(start))
  return {
    files,
    read: async p => {
      if (opts.failRead) throw new Error('too big')
      const v = files.get(p)
      if (v === undefined) throw new Error('missing')
      return v
    },
    write: async (p, t) => {
      files.set(p, t)
    },
    exists: async p => files.has(p),
  }
}

test('lines are added at the end of the file', async () => {
  const fs = memFs()
  expect(await appendLine(fs, '/l', '{"a":1}')).toBe('added')
  expect(await appendLine(fs, '/l', '{"a":2}')).toBe('added')
  expect(fs.files.get('/l')).toBe('{"a":1}\n{"a":2}\n')
})

test('a read that fails never overwrites the old lines', async () => {
  const fs = memFs({ '/l': 'old\n' }, { failRead: true })
  expect(await appendLine(fs, '/l', 'new')).toBe('skipped')
  expect(fs.files.get('/l')).toBe('old\n')
})

test('a full file is moved to a new name and nothing is lost', async () => {
  const big = 'x'.repeat(LEDGER_ROLL_BYTES)
  const fs = memFs({ '/l': big, '/l.1': 'first roll' })
  expect(await appendLine(fs, '/l', 'new')).toBe('rolled')
  expect(fs.files.get('/l.1')).toBe('first roll')
  expect(fs.files.get('/l.2')).toBe(big)
  expect(fs.files.get('/l')).toBe('new\n')
})

test('writes side by side keep every line', async () => {
  const fs = memFs()
  await Promise.all([1, 2, 3, 4, 5].map(i => queueLine(fs, '/q', `L${i}`)))
  expect(fs.files.get('/q')).toBe('L1\nL2\nL3\nL4\nL5\n')
})
