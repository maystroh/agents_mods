// Tests for the price book, the past-chat reader and the estimate math.
// No engine calls. The expected dollars are worked out by hand from the price table.

import { expect, test } from 'claude-code/testing'
import type { Cat } from '../types'
import {
  ADVISOR_SHARE,
  CATS,
  SEARCH_FEE,
  addSession,
  advisorRate,
  outFactor,
  cat,
  cleanPrompt,
  costOf,
  emptyBook,
  family,
  feed,
  feedEnd,
  helperCap,
  helperUsd,
  ingest,
  isUnread,
  kindOf,
  kindRows,
  newFeed,
  newScan,
  parseBook,
  peerWords,
  priceFor,
  priceWork,
  quantile,
  settle,
  similarTurns,
  talksOut,
  turnsOf,
  words,
  type Book,
  type Match,
  type Turn,
} from './book.ts'
import { BAND, BEFORE_CHARS, HOLD, SPEC, START_RATIO, WARM_RATIO, buildPrompt, courseOf, fallbackEstimate, nice, parseEstimate, priceEstimate, tailOf, tightOf, type Parsed } from './estimator.ts'
import { findSessions, scanSome, type Entry, type Io } from './scan.ts'

const OPUS = 'claude-opus-5-5'

function near(a: number, b: number, by = 1e-9): boolean {
  return Math.abs(a - b) <= by
}

function counts(o: Partial<Record<Cat, number>>): number[] {
  return CATS.map(c => o[c] ?? 0)
}

// ---------- prices ----------

test('priceFor: each model gets its own price line', async () => {
  expect(priceFor('claude-opus-5-5')).toEqual({ in: 4, out: 20, cr: 0.2, w1: 8, w5: 5 })
  expect(priceFor('claude-opus-5')).toEqual({ in: 5, out: 25, cr: 0.5, w1: 10, w5: 6.25 })
  expect(priceFor('claude-sonnet-5-5').cr).toBe(0.1)
  expect(priceFor('claude-sonnet-5').cr).toBe(0.2)
  expect(priceFor('claude-haiku-4-5')).toEqual({ in: 1, out: 5, cr: 0.1, w1: 2, w5: 1.25 })
  expect(priceFor('claude-fable-5-2')).toEqual({ in: 8, out: 40, cr: 0.2, w1: 16, w5: 6 })
  expect(priceFor('claude-fable-5').w5).toBe(10)
})

test('priceFor: a short name is the newest model of its family', async () => {
  expect(priceFor('opus')).toEqual(priceFor('claude-opus-5-5'))
  expect(priceFor('sonnet')).toEqual(priceFor('claude-sonnet-5-5'))
  expect(priceFor('haiku')).toEqual(priceFor('claude-haiku-5-5'))
  expect(priceFor(undefined)).toEqual(priceFor('claude-opus-5-5'))
  expect(priceFor('claude-opus-5-5[1m]')).toEqual(priceFor('claude-opus-5-5'))
})

test('priceFor: Haiku 5 has a higher tier above 100,000 prompt tokens, and k scales a line', async () => {
  expect(priceFor('claude-haiku-5-5', 100_000).in).toBe(0.1)
  expect(priceFor('claude-haiku-5-5', 100_001).in).toBe(0.5)
  expect(priceFor('claude-haiku-4-5', 500_000).in).toBe(1)
  expect(priceFor('claude-opus-5-5', 0, 1.5)).toEqual({ in: 6, out: 30, cr: 0.30000000000000004, w1: 12, w5: 7.5 })
})

test('family and cat sort models and tools', async () => {
  expect(family('claude-haiku-4-5')).toBe('haiku')
  expect(family('Sonnet')).toBe('sonnet')
  expect(family('claude-fable-5-2')).toBe('fable')
  expect(family('mythos')).toBe('fable')
  expect(family('')).toBe('opus')
  expect(family(undefined)).toBe('opus')
  expect(cat('Grep')).toBe('search')
  expect(cat('Write')).toBe('edit')
  expect(cat('Task')).toBe('agent')
  expect(cat('TaskCreate')).toBe('meta')
  expect(cat('mcp__ccd_turn__update_plan')).toBe('meta')
  expect(cat('mcp__claude-in-chrome__navigate')).toBe('browser')
  expect(cat('mcp__stripe__list')).toBe('mcp')
  expect(cat('Foo')).toBe('other')
})

test('costOf prices the five token kinds and web searches', async () => {
  // 1,000 x $4 + 1,000 x $20 + 100,000 x $0.20 + 10,000 x $8 + 10,000 x $5 per million, plus 2 searches.
  expect(near(costOf({ in: 1000, out: 1000, cr: 100_000, w1: 10_000, w5: 10_000, ws: 2 }, OPUS), 0.194)).toBe(true)
  expect(SEARCH_FEE).toBe(0.01)
})

test('quantile picks from the sorted list', async () => {
  expect(quantile([], 0.5)).toBe(0)
  expect(quantile([3, 1, 2], 0.5)).toBe(2)
  expect(quantile([3, 1, 2], 0)).toBe(1)
  expect(quantile([3, 1, 2], 1)).toBe(3)
})

test('helper prices: start values, then the person own helpers', async () => {
  expect(helperUsd(null, 'haiku')).toBe(0.09)
  expect(near(helperUsd(null, 'sonnet', 's'), 0.325)).toBe(true)
  expect(near(helperUsd(null, OPUS, 'l'), 4.32)).toBe(true)
  expect(helperCap(null, OPUS)).toBe(6)
  expect(near(helperCap(null, 'haiku'), 0.225)).toBe(true)

  const book = emptyBook()
  book.help.opus = [1, 2, 3, 4, 5, 6, 7, 8]
  expect(helperUsd(book, OPUS, 'm')).toBe(5)
  expect(helperUsd(book, OPUS, 's')).toBe(3)
  expect(helperUsd(book, OPUS, 'l')).toBe(7)
  // The cap is the higher of the 90% value and twice the middle value.
  expect(helperCap(book, OPUS)).toBe(10)
  // Seven samples are not enough: the start value stays.
  book.help.sonnet = [1, 1, 1, 1, 1, 1, 1]
  expect(helperUsd(book, 'sonnet')).toBe(0.65)
})

// ---------- pricing an amount of work ----------

// With no effort level, a request on Opus writes 960 tokens where the mean request the sizes come from writes 970.
const F = 960 / 970

test('priceWork: the part every task has', async () => {
  // 1.1 requests read 101,400 tokens (0.022308), 2,800 tokens are written (0.0224), 1,700 x F come out (0.034 x F).
  const p = priceWork(null, { units: {} }, { model: OPUS, ctx: 100_000 })
  expect(near(p.usd, 0.044708 + 0.034 * F)).toBe(true)
  expect(near(p.reqs, 1.1)).toBe(true)
  expect(p.adv).toBe(0)
  // A cold chat writes its 100,000 tokens once: $8 in place of $0.20 per million.
  expect(near(priceWork(null, { units: {} }, { model: OPUS, ctx: 100_000, isCold: true }).usd, 0.824708 + 0.034 * F)).toBe(true)
})

test('outFactor: a higher effort level writes more for each request', async () => {
  expect(near(outFactor(null, OPUS), 960 / 970)).toBe(true)
  expect(near(outFactor(null, OPUS, 'low'), 540 / 970)).toBe(true)
  expect(near(outFactor(null, OPUS, 'high'), 930 / 970)).toBe(true)
  expect(near(outFactor(null, OPUS, 'max'), 2300 / 970)).toBe(true)
  expect(near(outFactor(null, 'claude-sonnet-5-5', 'medium'), 360 / 970)).toBe(true)
  // A level with no start value takes the value of the model family.
  expect(near(outFactor(null, 'claude-haiku-5-5', 'high'), 300 / 970)).toBe(true)
  // So the same work costs more at a higher level: only the output part changes.
  const at = (effort: string): number => priceWork(null, { units: { read: 10 } }, { model: OPUS, ctx: 100_000, effort }).usd
  expect(at('low') < at('medium')).toBe(true)
  expect(at('medium') < at('high')).toBe(true)
  expect(at('high') < at('xhigh')).toBe(true)
  expect(at('xhigh') < at('max')).toBe(true)
  expect(near(at('max') - at('low'), (5700 * (2300 - 540) * 20) / 970 / 1e6)).toBe(true)
})

test('outFactor: with a thousand requests read, the person own chats give the factor', async () => {
  const book = emptyBook()
  // 800 requests at high wrote 1,000 tokens each, 400 at low wrote 250 each: the mean request wrote 750.
  book.eff = { 'opus|high': [800, 800_000], 'opus|low': [400, 100_000] }
  expect(near(outFactor(book, OPUS, 'high'), 1000 / 750)).toBe(true)
  expect(near(outFactor(book, OPUS, 'low'), 250 / 750)).toBe(true)
  // A level with few requests of its own takes its start value, on the person own mean.
  expect(near(outFactor(book, OPUS, 'xhigh'), 1050 / 750)).toBe(true)
  // The factor stays between 0.2 and 3.
  expect(outFactor(book, OPUS, 'max')).toBe(3)
  // Under a thousand requests, the start values stay.
  book.eff = { 'opus|high': [300, 300_000] }
  expect(near(outFactor(book, OPUS, 'high'), 930 / 970)).toBe(true)
})

test('priceWork: the advisor part is half the rate of the person newest tasks', async () => {
  const book = emptyBook()
  // 40 tasks of 10 requests. Every fourth task had one advisor call of $1 at a context of 100,000 tokens.
  book.turns = Array.from({ length: 40 }, (_, i) => ({ ...turn(`past task ${i}`, 2), t: 1_000 + i, reqs: 10, ctx: 100_000, ...(i % 4 === 0 ? { an: 1, adv: 1 } : {}) }))
  const rate = advisorRate(book, OPUS)
  // 10 calls in 400 requests, $1 for one call.
  expect(near(rate.perReq, 0.025)).toBe(true)
  expect(near(rate.usd, 1)).toBe(true)
  expect(near(rate.ctx, 100_000)).toBe(true)
  expect(ADVISOR_SHARE).toBe(0.5)
  const p = priceWork(book, { units: { read: 10 } }, { model: OPUS, ctx: 100_000 })
  // 6.1 requests x 0.025 x $1 x half, at a context of 112,400 against 100,000.
  expect(near(p.adv, 0.5 * 6.1 * 0.025 * 1.124)).toBe(true)
  expect(near(p.usd, 0.335528 + 0.114 * F + p.adv)).toBe(true)
  // Another model family has no advisor call in the book, and under 20 tasks say nothing.
  expect(priceWork(book, { units: { read: 10 } }, { model: 'claude-sonnet-5-5', ctx: 100_000 }).adv).toBe(0)
  const few = emptyBook()
  few.turns = book.turns.slice(0, 19)
  expect(priceWork(few, { units: { read: 10 } }, { model: OPUS, ctx: 100_000 }).adv).toBe(0)
})

test('priceWork: ten file reads', async () => {
  const p = priceWork(null, { units: { read: 10 } }, { model: OPUS, ctx: 100_000 })
  expect(near(p.reqs, 6.1)).toBe(true)
  expect(p.w).toBe(24_800)
  expect(near(p.out, 5700 * F, 1e-6)).toBe(true)
  // The output of 5,700 tokens was 0.114 of 0.449528.
  expect(near(p.usd, 0.335528 + 0.114 * F)).toBe(true)
  // A later step has no base part: 0.367, of which 0.08 is output.
  expect(near(priceWork(null, { units: { read: 10 } }, { model: OPUS, ctx: 100_000, withBase: false }).usd, 0.287 + 0.08 * F)).toBe(true)
})

test('priceWork: web searches, pages of text and helpers add their own cost', async () => {
  // 0.205748, of which the 3,620 output tokens are 0.0724.
  expect(near(priceWork(null, { units: { web: 4 } }, { model: OPUS, ctx: 100_000 }).usd, 0.133348 + 0.0724 * F)).toBe(true)
  const base = priceWork(null, { units: {} }, { model: OPUS, ctx: 100_000 }).usd
  // Two pages are 1,800 output tokens at $20 per million.
  expect(near(priceWork(null, { units: {}, pages: 2 }, { model: OPUS, ctx: 100_000 }).usd - base, 0.036)).toBe(true)
  const h = priceWork(null, { units: {}, helpers: [{ model: 'haiku', n: 3, size: 'm' }, { model: 'same', n: 1, size: 'l' }] }, { model: OPUS, ctx: 100_000 })
  expect(near(h.helper, 0.27 + 4.32)).toBe(true)
  expect(near(h.main, base)).toBe(true)
})

test('priceWork: a bigger context and a dearer model cost more, and the book correction is used', async () => {
  const small = priceWork(null, { units: { read: 10 } }, { model: OPUS, ctx: 100_000 }).usd
  expect(priceWork(null, { units: { read: 10 } }, { model: OPUS, ctx: 400_000 }).usd > small).toBe(true)
  expect(priceWork(null, { units: { read: 10 } }, { model: 'claude-fable-5-2', ctx: 100_000 }).usd > small).toBe(true)
  expect(priceWork(null, { units: { read: 10 } }, { model: 'claude-sonnet-5-5', ctx: 100_000 }).usd < small).toBe(true)
  const book = emptyBook()
  book.k.opus = 1.2
  expect(near(priceWork(book, { units: {} }, { model: OPUS, ctx: 100_000 }).usd, (0.044708 + 0.034 * F) * 1.2)).toBe(true)
})

// ---------- what kind of task ----------

test('kindOf names a task by its mix of tool calls', async () => {
  expect(kindOf(counts({}), 0)).toBe('chat')
  expect(kindOf(counts({ meta: 4 }), 0)).toBe('chat')
  expect(kindOf(counts({ read: 3 }), 2)).toBe('delegate')
  expect(kindOf(counts({ read: 3, agent: 2 }), 0)).toBe('delegate')
  expect(kindOf(counts({ read: 3, browser: 3 }), 0)).toBe('browser')
  expect(kindOf(counts({ read: 20, web: 5 }), 0)).toBe('research')
  expect(kindOf(counts({ read: 5, edit: 3, bash: 2 }), 0)).toBe('build')
  expect(kindOf(counts({ read: 9, edit: 1 }), 0)).toBe('edit')
  expect(kindOf(counts({ read: 2, mcp: 4 }), 0)).toBe('connector')
  expect(kindOf(counts({ read: 3, bash: 5 }), 0)).toBe('ops')
  expect(kindOf(counts({ read: 5 }), 0)).toBe('explore')
})

// ---------- reading a transcript ----------

function line(o: unknown): string {
  return JSON.stringify(o)
}

function userLine(text: string, at: string, more: Record<string, unknown> = {}): string {
  return line({ type: 'user', message: { role: 'user', content: text }, timestamp: at, origin: { kind: 'human' }, ...more })
}

function replyLine(id: string, at: string, usage: Record<string, unknown>, tools: string[] = [], more: Record<string, unknown> = {}): string {
  return line({
    type: 'assistant',
    message: {
      id,
      model: OPUS,
      role: 'assistant',
      content: tools.length > 0 ? tools.map((name, i) => ({ type: 'tool_use', id: `${id}-t${i}`, name, input: {} })) : [{ type: 'text', text: 'ok' }],
      usage,
    },
    timestamp: at,
    ...more,
  })
}

const T0 = '2026-11-01T10:00:00.000Z'
const T2 = '2026-11-01T10:10:00.000Z'

/** A chat with two tasks. Task 1: a cold request with two tools and a warm request. Task 2: one small edit. */
const CHAT = [
  userLine('research the claude models and write a report', T0),
  // One response is saved as one line per block, with the same id. The last line has the full output count.
  replyLine('msg_1', '2026-11-01T10:00:05.000Z', { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 }, server_tool_use: { web_search_requests: 1 } }, ['Read']),
  replyLine('msg_1', '2026-11-01T10:00:05.000Z', { input_tokens: 10, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: 100_000, ephemeral_5m_input_tokens: 0 }, server_tool_use: { web_search_requests: 1 } }, ['WebSearch']),
  // A tool result is not a typed message.
  line({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'msg_1-t0', type: 'tool_result', content: 'file text' }] }, timestamp: '2026-11-01T10:00:06.000Z' }),
  replyLine('msg_2', '2026-11-01T10:00:20.000Z', { input_tokens: 5, output_tokens: 400, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } }),
  // Lines that are not the person: a note the engine wrote, a system message, and an answer no model wrote.
  userLine('<system-reminder>hook</system-reminder>', '2026-11-01T10:05:00.000Z', { isMeta: true }),
  line({ type: 'user', message: { role: 'user', content: 'A helper finished.' }, timestamp: '2026-11-01T10:06:00.000Z', promptSource: 'system' }),
  line({ type: 'assistant', message: { id: 'msg_x', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: 0 } }, timestamp: '2026-11-01T10:07:00.000Z' }),
  userLine('thanks, now fix the typo in the report file', T2),
  replyLine('msg_3', '2026-11-01T10:10:05.000Z', { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 103_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } }, ['Edit']),
  // The engine's own cost count of the session.
  line({ type: 'cost-state', modelUsage: { [OPUS]: { inputTokens: 20, outputTokens: 1200, cacheReadInputTokens: 203_000, cacheCreationInputTokens: 103_000, cacheCreationEphemeral1hInputTokens: 103_000, cacheCreationEphemeral5mInputTokens: 0, webSearchRequests: 1, costUSD: 0.9 } } }),
].join('\n')

// Hand math, per million tokens on Opus 5.5 (in 4, out 20, read 0.2, write 8), plus $0.01 for one search:
const COST_1 = (10 * 4 + 600 * 20 + 100_000 * 8) / 1e6 + 0.01 // 0.82204
const COST_2 = (5 * 4 + 400 * 20 + 100_000 * 0.2 + 2000 * 8) / 1e6 // 0.04402
const COST_3 = (5 * 4 + 200 * 20 + 103_000 * 0.2 + 1000 * 8) / 1e6 // 0.03262

function scanOf(text: string): ReturnType<typeof newScan> {
  const scan = newScan()
  ingest(scan, text)
  return scan
}

test('the hand math of the test chat is what it says', async () => {
  expect(near(COST_1, 0.82204)).toBe(true)
  expect(near(COST_2, 0.04402)).toBe(true)
  expect(near(COST_3, 0.03262)).toBe(true)
})

test('ingest: one response on many lines is one request with the last output count', async () => {
  const scan = scanOf(CHAT)
  expect(scan.reqs.size).toBe(3)
  const first = scan.reqs.get('msg_1')
  expect(first?.out).toBe(600)
  expect(first?.w1).toBe(100_000)
  expect(first?.ws).toBe(1)
  expect(first?.tools.map(t => t[0])).toEqual(['Read', 'WebSearch'])
})

test('ingest: only what the person typed is a task', async () => {
  const scan = scanOf(CHAT)
  expect(scan.prompts.filter(p => p.isHuman).map(p => p.text)).toEqual(['research the claude models and write a report', 'thanks, now fix the typo in the report file'])
  // The system message is kept, but it is not a person.
  expect(scan.prompts.filter(p => !p.isHuman).map(p => p.text)).toEqual(['A helper finished.'])
})

test('ingest: the engine cost count is read, with the book own dollars for the same tokens', async () => {
  const row = scanOf(CHAT).ledger?.[OPUS]
  expect(row?.usd).toBe(0.9)
  expect(near(row?.mine ?? 0, COST_1 + COST_2 + COST_3)).toBe(true)
  expect(row?.isSplit).toBe(true)
})

test('ingest: an old transcript with no cache split counts the cache write at the one hour price', async () => {
  const scan = scanOf(replyLine('msg_9', T0, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 }))
  expect(scan.reqs.get('msg_9')?.w1).toBe(5000)
})

test('ingest: broken and short lines do no harm', async () => {
  const scan = scanOf(['{"type":"assistant","message":{"id":"msg_b","model":"claude-opus-5-5","usage":{"input_tok', '{}', '', 'not json at all, but longer than twenty characters', CHAT].join('\n'))
  expect(scan.reqs.size).toBe(3)
})

test('feed: a transcript that comes in pieces reads the same', async () => {
  const f = newFeed()
  for (let i = 0; i < CHAT.length; i += 97) feed(f, CHAT.slice(i, i + 97))
  const scan = feedEnd(f)
  expect(scan.reqs.size).toBe(3)
  expect(scan.prompts).toHaveLength(3)
  expect(scan.reqs.get('msg_1')?.out).toBe(600)
  expect(scan.ledger?.[OPUS]?.usd).toBe(0.9)
})

test('cleanPrompt cuts engine notes and reads a slash command', async () => {
  expect(cleanPrompt('<system-reminder>x</system-reminder>\nfix the bug')).toBe('fix the bug')
  expect(cleanPrompt('<local-command-stdout>ok</local-command-stdout>')).toBe('')
  expect(cleanPrompt('[Request interrupted by user]')).toBe('')
  expect(cleanPrompt('<command-name>/budget</command-name><command-args>5 do it</command-args>')).toBe('/budget 5 do it')
})

test('turnsOf cuts the chat into tasks with their real cost', async () => {
  const turns = turnsOf(scanOf(CHAT), [], {})
  expect(turns).toHaveLength(2)
  const [a, b] = turns
  expect(a?.text).toBe('research the claude models and write a report')
  expect(a?.reqs).toBe(2)
  expect(near(a?.usd ?? 0, COST_1 + COST_2)).toBe(true)
  expect(a?.out).toBe(1000)
  expect(a?.ws).toBe(1)
  expect(a?.ctx).toBe(100_010)
  expect(a?.model).toBe(OPUS)
  // The first request wrote the chat cold. The second wrote 2,005 new tokens warm.
  expect(a?.cold).toBe(100_010)
  expect(a?.w).toBe(2005)
  expect(a?.n).toEqual(counts({ read: 1, web: 1 }))
  expect(a?.kind).toBe('research')
  expect(b?.reqs).toBe(1)
  expect(near(b?.usd ?? 0, COST_3)).toBe(true)
  expect(b?.kind).toBe('edit')
})

test('turnsOf: a helper cost goes to the task that was running when it started', async () => {
  const turns = turnsOf(scanOf(CHAT), [{ t: Date.parse('2026-11-01T10:00:06.000Z'), usd: 0.5 }, { t: Date.parse('2026-11-01T10:10:06.000Z'), usd: 0.25 }], {})
  expect(turns[0]?.hu).toBe(0.5)
  expect(turns[0]?.h).toBe(1)
  expect(turns[1]?.hu).toBe(0.25)
})

test('turnsOf: a request before the first typed message is not a task', async () => {
  const turns = turnsOf(scanOf([replyLine('msg_0', '2026-11-01T09:00:00.000Z', { input_tokens: 5, output_tokens: 5 }), CHAT].join('\n')), [], {})
  expect(turns).toHaveLength(2)
})

// ---------- the book ----------

const HELPER_CHAT = line({
  type: 'assistant',
  isSidechain: true,
  message: { id: 'msg_h1', model: 'claude-haiku-4-5', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1000, output_tokens: 1000 } },
  timestamp: '2026-11-01T10:00:06.000Z',
})

test('addSession adds the tasks, the helper and the cost check of one chat', async () => {
  const book = emptyBook()
  const added = addSession(book, 'k1', 1000, scanOf(CHAT), [scanOf(HELPER_CHAT)])
  expect(added).toBe(2)
  expect(book.tasks).toBe(2)
  expect(book.files).toBe(1)
  // The helper cost 1,000 in and 1,000 out on Haiku 4.5: $0.006.
  expect(book.help.haiku).toEqual([0.006])
  expect(near(book.usd, COST_1 + COST_2 + COST_3 + 0.006)).toBe(true)
  expect(book.kinds.research).toEqual([0.8721])
  expect(book.kinds.edit).toEqual([0.0326])
  expect(book.all).toEqual([0.8721, 0.0326])
  expect(book.nfit).toBe(2)
  expect(book.turns.map(t => t.kind)).toEqual(['research', 'edit'])
  expect(book.turns[0]?.hu).toBe(0.006)
  expect(book.led.opus?.[0]).toBe(0.9)
  expect(near(book.led.opus?.[1] ?? 0, COST_1 + COST_2 + COST_3)).toBe(true)
  expect(book.seen.k1).toEqual([1000, Date.parse(T2)])
  expect(book.newest).toBe(1000)
})

test('addSession: a chat the book has read adds nothing the second time', async () => {
  const book = emptyBook()
  addSession(book, 'k1', 1000, scanOf(CHAT), [scanOf(HELPER_CHAT)])
  const usd = book.usd
  expect(addSession(book, 'k1', 2000, scanOf(CHAT), [scanOf(HELPER_CHAT)])).toBe(0)
  expect(book.tasks).toBe(2)
  expect(book.files).toBe(1)
  expect(book.usd).toBe(usd)
  expect(book.help.haiku).toHaveLength(1)
  expect(book.led.opus?.[0]).toBe(0.9)
  expect(book.seen.k1?.[0]).toBe(2000)
})

test('addSession: a chat that has grown adds only its new task', async () => {
  const book = emptyBook()
  addSession(book, 'k1', 1000, scanOf(CHAT), [])
  const more = [CHAT, userLine('and one more small thing please', '2026-11-01T11:00:00.000Z'), replyLine('msg_4', '2026-11-01T11:00:05.000Z', { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 104_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } })].join('\n')
  expect(addSession(book, 'k1', 3000, scanOf(more), [])).toBe(1)
  expect(book.tasks).toBe(3)
  expect(book.files).toBe(1)
  expect(book.kinds.chat).toHaveLength(1)
})

test('addSession: a task under three cents is counted but not kept as a past task', async () => {
  const book = emptyBook()
  const tiny = [userLine('hi there, quick question for you', T0), replyLine('msg_t', '2026-11-01T10:00:01.000Z', { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 1000 })].join('\n')
  expect(addSession(book, 'k2', 1000, scanOf(tiny), [])).toBe(1)
  expect(book.tasks).toBe(1)
  expect(book.turns).toHaveLength(0)
})

test('isUnread: new files and changed files are read, old ones are not', async () => {
  const book = emptyBook()
  addSession(book, 'k1', 1000, scanOf(CHAT), [])
  expect(isUnread(book, 'k1', 1000)).toBe(false)
  expect(isUnread(book, 'k1', 3000)).toBe(true)
  expect(isUnread(book, 'new', 500)).toBe(true)
  book.floor = 5000
  expect(isUnread(book, 'new', 4000)).toBe(false)
})

test('settle: the price correction comes from the engine cost counts', async () => {
  const book = emptyBook()
  book.led = { opus: [12, 10], sonnet: [10.2, 10], fable: [30, 10], haiku: [0.5, 0.4] }
  settle(book, 777)
  expect(book.k.opus).toBe(1.2)
  // Inside 3% the table is right.
  expect(book.k.sonnet).toBe(1)
  // A wild number is held to 1.6.
  expect(book.k.fable).toBe(1.6)
  // Under one dollar of data is not enough to say.
  expect(book.k.haiku).toBeUndefined()
  expect(book.builtAt).toBe(777)
})

/** Fill the fit sums of a book as fifty tasks would: each has 0 to 4 file reads. */
function fitBook(reqs: (reads: number) => number, w: (reads: number) => number, out: (reads: number) => number, n = 50): Book {
  const book = emptyBook()
  for (let i = 0; i < n; i++) {
    const reads = i % 5
    const x = [1, reads]
    for (let a = 0; a < 2; a++) {
      const xa = x[a] ?? 0
      book.xr[a] = (book.xr[a] ?? 0) + xa * reqs(reads)
      book.xw[a] = (book.xw[a] ?? 0) + xa * w(reads)
      book.xo[a] = (book.xo[a] ?? 0) + xa * out(reads)
      const row = book.xtx[a]
      if (row) for (let b = 0; b < 2; b++) row[b] = (row[b] ?? 0) + xa * (x[b] ?? 0)
    }
    book.nfit += 1
  }
  return book
}

test('settle: the size of one tool call is worked out from the person own tasks', async () => {
  const book = fitBook(
    reads => 1 + 2 * reads,
    reads => 1000 + 3000 * reads,
    reads => 500 + 200 * reads,
  )
  settle(book, 1)
  expect(near(book.unit.req[0] ?? 0, 1, 0.001)).toBe(true)
  expect(near(book.unit.req[1] ?? 0, 2, 0.001)).toBe(true)
  expect(near(book.unit.w[0] ?? 0, 1000, 1)).toBe(true)
  expect(near(book.unit.w[1] ?? 0, 3000, 1)).toBe(true)
  expect(near(book.unit.out[0] ?? 0, 500, 1)).toBe(true)
  expect(near(book.unit.out[1] ?? 0, 200, 1)).toBe(true)
  // A kind of work the person never used keeps the starting size.
  const start = emptyBook().unit
  expect(book.unit.req[3]).toBe(start.req[3])
  expect(book.unit.w[5]).toBe(start.w[5])
})

test('settle: a size never comes out negative', async () => {
  // More reads, fewer requests: the data says a read costs less than nothing.
  const book = fitBook(
    reads => 3 - 0.5 * reads,
    () => 1000,
    () => 500,
  )
  settle(book, 1)
  expect(near(book.unit.req[1] ?? 9, 0, 1e-6)).toBe(true)
  // The base then holds the average: 3 - 0.5 x 2.
  expect(near(book.unit.req[0] ?? 0, 2, 0.001)).toBe(true)
})

test('settle: under forty tasks the starting sizes stay', async () => {
  const book = fitBook(
    reads => 1 + 2 * reads,
    () => 1000,
    () => 500,
    39,
  )
  settle(book, 1)
  expect(book.unit).toEqual(emptyBook().unit)
})

test('parseBook reads a saved book and refuses other text', async () => {
  const book = emptyBook()
  addSession(book, 'k1', 1000, scanOf(CHAT), [])
  expect(parseBook(JSON.stringify(book))?.tasks).toBe(2)
  expect(parseBook('{"v":2}')).toBeNull()
  expect(parseBook('not json')).toBeNull()
})

test('kindRows shows the kinds with three tasks or more', async () => {
  const book = emptyBook()
  book.kinds = { build: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], edit: [1, 2], chat: [0.1, 0.2, 0.3] }
  expect(kindRows(book)).toEqual([
    { kind: 'build', n: 10, p25: 3, p50: 6, p90: 10 },
    { kind: 'chat', n: 3, p25: 0.1, p50: 0.2, p90: 0.3 },
  ])
})

// ---------- similar past tasks ----------

function turn(text: string, usd: number, over: Partial<Turn> = {}): Turn {
  return { t: 1, text, usd, hu: 0, h: 0, reqs: 5, n: counts({ read: 3 }), ctx: 100_000, w: 5000, cold: 0, out: 2000, ws: 0, model: OPUS, kind: 'explore', ...over }
}

const PAST = [
  turn('research the claude models and write a report', 2),
  turn('fix the login bug in the checkout page', 1),
  turn('write a linkedin post about the new claude models', 0.5),
  turn('scrape leads from the directory site', 3),
]

test('words keeps the words that carry meaning', async () => {
  expect(words('Testing the leads')).toEqual(['test', 'lead'])
  expect(words('the and for a b cd')).toEqual([])
  expect(words('Claude, claude! CLAUDE?')).toEqual(['claude'])
})

test('similarTurns finds the past tasks with the closest wording', async () => {
  const found = similarTurns(PAST, 'research claude models pricing and make a report')
  expect(found[0]?.turn.text).toBe('research the claude models and write a report')
  expect(found.map(m => m.turn.text)).not.toContain('fix the login bug in the checkout page')
  expect(found.map(m => m.turn.text)).not.toContain('scrape leads from the directory site')
  for (let i = 1; i < found.length; i++) expect((found[i - 1]?.score ?? 0) >= (found[i]?.score ?? 0)).toBe(true)
  expect((found[0]?.score ?? 0) > 0.5).toBe(true)
})

test('similarTurns: no shared words, no text or no past tasks give nothing', async () => {
  expect(similarTurns(PAST, 'zebra unicorn rainbow')).toEqual([])
  expect(similarTurns(PAST, '')).toEqual([])
  expect(similarTurns([], 'research claude models')).toEqual([])
  // A past message of under three words says too little to compare.
  expect(similarTurns([turn('fix it', 1)], 'fix it')).toEqual([])
})

// ---------- the estimate ----------

test('the spec names every cost signal and asks for JSON only', async () => {
  for (let i = 1; i <= 15; i++) expect(SPEC).toContain(`\n${i}. `)
  expect(SPEC).toContain('You do not give dollar amounts')
  expect(SPEC).toContain('Answer with one JSON object and nothing else')
  expect(SPEC).toContain('"Scout:"')
})

test('buildPrompt holds the task, the chat size and the real counts of past tasks', async () => {
  const matches: Match[] = [{ turn: turn(`a past task ${'x'.repeat(300)}`, 2, { reqs: 7, n: counts({ read: 4, bash: 2, meta: 9 }), h: 2 }), score: 0.5 }]
  const text = buildPrompt(`do the thing ${'y'.repeat(7000)}`, { model: OPUS, ctx: 123_456, isCold: false }, matches)
  expect(text).toContain('TASK\ndo the thing yyy')
  expect(text).toContain('Model: opus. Context: about 123K tokens.')
  expect(text).toContain('-> 7 requests, tool calls: read 4, bash 2, helpers 2')
  // The task is cut to 6,000 characters and a past task to 160.
  expect(text.includes('y'.repeat(6001))).toBe(false)
  expect(text.includes('x'.repeat(161))).toBe(false)
  expect(buildPrompt('do it', { model: OPUS, ctx: 0, isCold: false }, [])).not.toContain('PAST TASKS')
})

const ANSWER = {
  mode: 'guard',
  items: 0,
  confidence: 'medium',
  unsure: [],
  steps: [
    { name: 'Read the files', done: 'all files are read', read: 10 },
    { name: 'Write the report', done: 'the report is saved', edit: 2, pages: 2 },
  ],
}

test('parseEstimate reads the JSON, also inside other text', async () => {
  const p = parseEstimate('Here is the count:\n```json\n' + JSON.stringify(ANSWER) + '\n```\nDone.')
  expect(p?.mode).toBe('guard')
  expect(p?.confidence).toBe('medium')
  expect(p?.steps).toEqual([
    { name: 'Read the files', done: 'all files are read', units: { read: 10 }, helpers: [], pages: 0 },
    { name: 'Write the report', done: 'the report is saved', units: { edit: 2 }, helpers: [], pages: 2 },
  ])
})

test('parseEstimate holds wild numbers to a limit and drops bad parts', async () => {
  const p = parseEstimate(
    JSON.stringify({
      mode: 'PACE',
      confidence: 'sure',
      items: 5_000_000,
      unsure: ['a', '', 'b', 'c', 'd', 'e', 7],
      steps: [
        { name: 'Big', read: 99_999, bash: -3, web: 'many', mcp: 2.6, pages: 1000, helpers: [{ model: 'HAIKU', n: 500, size: 'x' }, { n: 0 }, { n: 2 }] },
        { read: 5 },
        ...Array.from({ length: 9 }, (_, i) => ({ name: `Step ${i}` })),
      ],
    }),
  )
  expect(p?.mode).toBe('guard')
  expect(p?.confidence).toBe('medium')
  expect(p?.items).toBe(100_000)
  expect(p?.unsure).toEqual(['a', 'b', 'c', 'd'])
  expect(p?.steps[0]?.units).toEqual({ read: 2000, mcp: 3 })
  expect(p?.steps[0]?.pages).toBe(400)
  expect(p?.steps[0]?.helpers).toEqual([
    { model: 'haiku', n: 200, size: 'm' },
    { model: 'same', n: 2, size: 'm' },
  ])
  // Eight rows are read. The one with no name is dropped.
  expect(p?.steps).toHaveLength(7)
})

test('parseEstimate: text that is not the JSON gives nothing', async () => {
  expect(parseEstimate('I cannot count this task.')).toBeNull()
  expect(parseEstimate('{"mode":"guard"}')).toBeNull()
  expect(parseEstimate('{"steps":[{"read":3}]}')).toBeNull()
  expect(parseEstimate('{"steps":[{"name":"A"')).toBeNull()
  expect(parseEstimate(JSON.stringify({ ...ANSWER, mode: 'pace' }))?.mode).toBe('pace')
})

const FACTS = { model: OPUS, ctx: 100_000, isCold: false }
const PARSED = parseEstimate(JSON.stringify(ANSWER)) as Parsed

test('priceEstimate puts measured prices on the counted work', async () => {
  // Step 1: ten reads with the base part, $0.448353. The chat grows by 30,441 tokens.
  // Step 2: two edits and two pages at a context of 130,441, $0.131484.
  const { estimate, steps } = priceEstimate(null, PARSED, FACTS, [], { ratio: 1, n: 0 }, 0.01)
  // A warm chat: 0.579837 x 0.72 = 0.417483. Low is x 0.26 = 0.109. Safe is x 5.8 = 2.421, shown as 2.5.
  expect(estimate.likely).toBe(0.42)
  expect(estimate.low).toBe(0.11)
  expect(estimate.safe).toBe(2.5)
  // Half of such tasks cost x 0.53 to x 1.8 of the likely amount, and 95 of 100 cost less than the safe amount.
  expect(estimate.usual).toEqual([0.22, 0.75])
  expect(estimate.hold).toBe(95)
  expect(estimate.kind).toBe('edit')
  expect(estimate.mode).toBe('guard')
  expect(estimate.confidence).toBe('medium')
  expect(estimate.units).toEqual({ read: 10, edit: 2 })
  expect(estimate.helpers).toBe(0)
  expect(estimate.cost).toBe(0.01)
  expect(estimate.similar).toBeNull()
  expect(estimate.basis).toBe('2 steps counted by sonnet and priced with your past chats')
  expect(steps).toEqual([
    { name: 'Read the files', done: 'all files are read', usd: 0.32 },
    { name: 'Write the report', done: 'the report is saved', usd: 0.09 },
  ])
})

test('priceEstimate: the learned ratio scales the estimate and its steps', async () => {
  const { estimate, steps } = priceEstimate(null, PARSED, FACTS, [], { ratio: 1.5, n: 0 }, 0)
  // 0.579837 x 1.5 x 0.72 = 0.626224. The steps: 0.448353 x 1.08 = 0.484 and 0.131484 x 1.08 = 0.142.
  expect(estimate.likely).toBe(0.63)
  expect(steps.map(s => s.usd)).toEqual([0.48, 0.14])
})

test('priceEstimate: the range comes from the measured bands, one for a warm chat and one for a new chat', async () => {
  // The bands were measured on 430 past tasks. What the model says about its confidence did not make them tighter.
  expect(BAND.warm).toEqual({ low: 0.26, usual: [0.53, 1.8], safe: 5.8 })
  expect(BAND.cold).toEqual({ low: 0.5, usual: [0.7, 1.6], safe: 5.5 })
  expect(HOLD).toBe(95)
  expect(START_RATIO).toBe(1)
  expect(WARM_RATIO).toBe(0.72)
  for (const confidence of ['high', 'medium', 'low'] as const) {
    const e = priceEstimate(null, { ...PARSED, confidence }, FACTS, [], { ratio: 1, n: 0 }, 0).estimate
    expect([e.low, e.usual, e.safe]).toEqual([0.11, [0.22, 0.75], 2.5])
    expect(e.confidence).toBe(confidence)
  }
  // Finished budgets move the likely amount through the ratio. They do not make the range tighter.
  expect(priceEstimate(null, PARSED, FACTS, [], { ratio: 1, n: 8 }, 0).estimate.safe).toBe(2.5)
  // A new chat: 1.359837 x 0.5 = 0.68, x 0.7 = 0.95, x 1.6 = 2.18, and x 5.5 = 7.479, shown as 7.5.
  const cold = priceEstimate(null, PARSED, { ...FACTS, isCold: true }, [], { ratio: 1, n: 0 }, 0).estimate
  expect([cold.low, cold.usual, cold.safe]).toEqual([0.68, [0.95, 2.18], 7.5])
})

test('priceEstimate: the effort level of the chat changes the estimate', async () => {
  const at = (effort?: string): number => priceEstimate(null, PARSED, effort ? { ...FACTS, effort } : FACTS, [], { ratio: 1, n: 0 }, 0).estimate.likely
  expect(at('low') < at('high')).toBe(true)
  expect(at('high') < at('max')).toBe(true)
  // Low writes 540 tokens for each request where high writes 930: step 1 alone is 0.114 x 390 / 970 = $0.046 less before the ratio.
  expect(at('low')).toBe(0.37)
  expect(at('max')).toBe(0.58)
})

test('priceEstimate: a cold chat adds the cost to load it once', async () => {
  const warm = priceEstimate(null, PARSED, FACTS, [], { ratio: 1, n: 0 }, 0)
  const cold = priceEstimate(null, PARSED, { ...FACTS, isCold: true }, [], { ratio: 1, n: 0 }, 0)
  // 100,000 tokens at $8 in place of $0.20 per million: $0.78 more, all on step 1.
  expect(cold.estimate.likely).toBe(1.36)
  expect(cold.steps[0]?.usd).toBe(1.23)
  // Step 2 is the same work, 0.131484. Only the warm chat gets the warm factor of 0.72.
  expect(cold.steps[1]?.usd).toBe(0.13)
  expect(warm.steps[1]?.usd).toBe(0.09)
})

test('priceEstimate: three close past tasks pull the number to what such tasks cost', async () => {
  const close: Match[] = [0, 1, 2].map(() => ({ turn: turn('a close past task with words', 1.5, { hu: 0.5 }), score: 0.4 }))
  const { estimate } = priceEstimate(null, PARSED, FACTS, close, { ratio: 1, n: 0 }, 0)
  // The middle of 0.417483 (0.579837 x 0.72, a warm chat) and 2, on a ratio scale: the square root of 0.834966.
  expect(estimate.likely).toBe(0.91)
  expect(estimate.similar).toEqual({ cost: 2, runs: 3 })
  expect(estimate.basis).toContain('and 3 similar past tasks (median $2.00)')
})

test('priceEstimate: a few loose matches are shown but do not move the number', async () => {
  const loose: Match[] = [{ turn: turn('a loose past task with words', 3), score: 0.25 }]
  const { estimate } = priceEstimate(null, PARSED, FACTS, loose, { ratio: 1, n: 0 }, 0)
  expect(estimate.likely).toBe(0.42)
  expect(estimate.similar).toEqual({ cost: 3, runs: 1 })
})

test('priceEstimate: bulk work gets a scout step, and helpers make it helper work', async () => {
  const bulk: Parsed = {
    mode: 'guard',
    items: 50,
    confidence: 'low',
    unsure: ['How big each lead page is'],
    steps: [
      { name: 'Scout: first 3 leads', done: '3 leads are done', units: { web: 6 }, helpers: [], pages: 0 },
      { name: 'The other leads', done: 'all 50 are done', units: {}, helpers: [{ model: 'haiku', n: 3, size: 'm' }], pages: 0 },
    ],
  }
  const { estimate, steps } = priceEstimate(null, bulk, FACTS, [], { ratio: 1, n: 0 }, 0)
  expect(steps[0]?.scout).toEqual({ items: 3, total: 50 })
  expect(steps[1]?.scout).toBeUndefined()
  expect(estimate.kind).toBe('delegate')
  expect(estimate.helpers).toBe(3)
  expect(estimate.unsure).toEqual(['How big each lead page is'])
  // A small job has no scout step, whatever its name.
  const small = priceEstimate(null, { ...bulk, items: 5 }, FACTS, [], { ratio: 1, n: 0 }, 0)
  expect(small.steps[0]?.scout).toBeUndefined()
})

test('fallbackEstimate: a first guess when nothing is known', async () => {
  const { estimate, steps } = fallbackEstimate(null, [], FACTS)
  expect(steps).toEqual([])
  expect(estimate.likely).toBe(2)
  expect(estimate.low).toBe(0.8)
  // No work was counted, so the wider band is used: x 0.53 to x 1.8, and x 5.8 = 11.6, shown as 12.
  expect(estimate.usual).toEqual([1.06, 3.6])
  expect(estimate.safe).toBe(12)
  // This range has no proof, so it names no share of tasks.
  expect(estimate.hold).toBeUndefined()
  expect(estimate.confidence).toBe('low')
  expect(estimate.unsure).toEqual(['The work could not be counted'])
})

test('fallbackEstimate uses similar past tasks, then the middle of all past tasks', async () => {
  const two: Match[] = [
    { turn: turn('one past task with words', 1), score: 0.3 },
    { turn: turn('two past task with words', 3), score: 0.3 },
  ]
  const a = fallbackEstimate(null, two, FACTS).estimate
  expect(a.likely).toBe(3)
  expect(a.similar).toEqual({ cost: 3, runs: 2 })
  const book = emptyBook()
  book.all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const b = fallbackEstimate(book, [], FACTS).estimate
  expect(b.likely).toBe(6)
  expect(b.basis).toContain('the median of your last 10 tasks')
})

test('fallbackEstimate: no task costs less than its first request', async () => {
  // A cold chat of one million tokens on Fable: the first request alone is $16.16.
  const e = fallbackEstimate(null, [], { model: 'claude-fable-5-2', ctx: 1_000_000, isCold: true }).estimate
  expect(e.low).toBe(16.16)
  expect(e.likely).toBe(24.24)
  expect(e.safe >= e.likely).toBe(true)
  // The usual range never starts under the first request.
  expect(e.usual?.[0]).toBe(16.16)
})

test('tightOf: the tight limit is the top of the usual range', async () => {
  expect(tightOf({ low: 1, likely: 2, safe: 11, usual: [1.4, 3.2], hold: 95 })).toBe(3.25)
  // An estimate from before 0.5.0 has no usual range: its likely amount is the tight limit.
  expect(tightOf({ low: 1, likely: 2.29, safe: 6.75 })).toBe(2.5)
})

const SPREAD = { low: 1, likely: 2, safe: 11, usual: [1.4, 3.2] as [number, number], hold: 95 }

test('courseOf: before any spend it is the likely amount, and the share lines are the range', async () => {
  expect(near(courseOf(SPREAD, 0), 2, 1e-9)).toBe(true)
  expect(near(courseOf(SPREAD, 0, 0.25), 1.4, 1e-9)).toBe(true)
  expect(near(courseOf(SPREAD, 0, 0.75), 3.2, 1e-9)).toBe(true)
  expect(near(courseOf(SPREAD, 0, 0.95), 11, 1e-9)).toBe(true)
  expect(near(courseOf(SPREAD, 0, 0.1), 1, 1e-9)).toBe(true)
})

test('courseOf: a task that has spent its likely amount is on course for more', async () => {
  // Half of the tasks end under $2. Of the half that pass it, the middle one is the 3 in 4 task: $3.20.
  expect(near(courseOf(SPREAD, 2), 3.2, 1e-9)).toBe(true)
  // The 3 in 4 line of the tasks that passed $2 is the 7 in 8 task of all tasks.
  const q = courseOf(SPREAD, 2, 0.75)
  expect(q > 3.2 && q < 11).toBe(true)
  // The forecast never goes under what is spent, and it grows with the spend.
  let last = 0
  for (const spent of [0.2, 0.5, 1, 2, 3.2, 5, 11, 20, 60]) {
    const f = courseOf(SPREAD, spent)
    expect(f >= spent).toBe(true)
    expect(f > last).toBe(true)
    last = f
  }
  // Far past the safe amount the line goes on: the forecast stays a real number.
  expect(Number.isFinite(courseOf(SPREAD, 5000))).toBe(true)
})

test('courseOf: an estimate from before 0.5.0 has three points, and a broken one gives the likely amount', async () => {
  const old = { low: 1.03, likely: 2.29, safe: 6.75 }
  expect(near(courseOf(old, 0), 2.29, 1e-9)).toBe(true)
  expect(courseOf(old, 2.29) > 2.29).toBe(true)
  expect(courseOf({ low: 0, likely: 0, safe: 0 }, 0)).toBe(0)
  expect(courseOf({ low: 0, likely: 0, safe: 0 }, 3)).toBe(3)
  expect(courseOf({ low: 2, likely: 2, safe: 2 }, 1)).toBe(2)
})

test('nice rounds up to an amount a person would pick', async () => {
  expect(nice(0.01)).toBe(0.05)
  expect(nice(1.162992)).toBe(1.2)
  expect(nice(1.2)).toBe(1.2)
  expect(nice(3.1625)).toBe(3.25)
  expect(nice(12.1)).toBe(12.5)
  expect(nice(51)).toBe(55)
})

// ---------- reading the chat files ----------

type Disk = Record<string, { text?: string; size?: number; mtimeMs?: number; dir?: boolean }>

function diskIo(disk: Disk, o: { noRead?: string[]; noStream?: boolean } = {}): Io & { reads: string[]; streams: string[]; pauses: number } {
  const io = {
    reads: [] as string[],
    streams: [] as string[],
    pauses: 0,
    list: async (path: string): Promise<Entry[]> => {
      const out: Entry[] = []
      let isThere = false
      for (const [full, f] of Object.entries(disk)) {
        if (full === path) isThere = true
        if (!full.startsWith(`${path}/`)) continue
        isThere = true
        const rest = full.slice(path.length + 1)
        if (rest.includes('/')) continue
        out.push({ name: rest, kind: f.dir ? 'dir' : 'file', size: f.size ?? f.text?.length ?? 0, mtimeMs: f.mtimeMs ?? 0 })
      }
      if (!isThere) throw new Error(`no folder ${path}`)
      return out
    },
    read: async (path: string): Promise<string> => {
      io.reads.push(path)
      const f = disk[path]
      if (!f || f.text === undefined || o.noRead?.includes(path)) throw new Error(`cannot read ${path}`)
      return f.text
    },
    stream: async (path: string, onPiece: (text: string) => void): Promise<boolean> => {
      io.streams.push(path)
      const f = disk[path]
      if (o.noStream || !f || f.text === undefined) return false
      for (let i = 0; i < f.text.length; i += 500) onPiece(f.text.slice(i, i + 500))
      return true
    },
    pause: async (): Promise<void> => {
      io.pauses += 1
    },
  }
  return io
}

const ROOT = '/home/.claude/projects'
// Three different chats: the same work on three days. A copy of a chat has the same times, and the book counts it one time.
const CHAT_DAY2 = CHAT.split('2026-11-01').join('2026-11-02')
const CHAT_DAY3 = CHAT.split('2026-11-01').join('2026-11-03')

function disk(): Disk {
  return {
    [`${ROOT}/proj-a`]: { dir: true },
    [`${ROOT}/proj-a/s1.jsonl`]: { text: CHAT, mtimeMs: 3000 },
    [`${ROOT}/proj-a/s1`]: { dir: true },
    [`${ROOT}/proj-a/s1/subagents`]: { dir: true },
    [`${ROOT}/proj-a/s1/subagents/agent-1.jsonl`]: { text: HELPER_CHAT, mtimeMs: 3000 },
    [`${ROOT}/proj-a/s1/subagents/notes.txt`]: { text: 'not a chat', mtimeMs: 3000 },
    [`${ROOT}/proj-a/s2.jsonl`]: { text: CHAT_DAY2, mtimeMs: 2000 },
    [`${ROOT}/proj-a/readme.md`]: { text: 'not a chat', mtimeMs: 9000 },
    [`${ROOT}/proj-b`]: { dir: true },
    [`${ROOT}/proj-b/s3.jsonl`]: { text: CHAT_DAY3, mtimeMs: 4000 },
    [`${ROOT}/loose.jsonl`]: { text: CHAT, mtimeMs: 9000 },
  }
}

test('findSessions lists the main chats of every project, newest first', async () => {
  const files = await findSessions(diskIo(disk()), ROOT)
  expect(files.map(f => f.key)).toEqual(['s3', 's1', 's2'])
  expect(files[1]?.path).toBe(`${ROOT}/proj-a/s1.jsonl`)
  expect(files[1]?.dir).toBe(`${ROOT}/proj-a/s1`)
  expect(await findSessions(diskIo({}), ROOT)).toEqual([])
})

test('scanSome reads the unread chats with their helpers into the book', async () => {
  const io = diskIo(disk())
  const book = emptyBook()
  const files = await findSessions(io, ROOT)
  const steps: number[] = []
  const done = await scanSome(io, book, files, { maxFiles: 10, maxBytes: 1e9 }, p => steps.push(p.read))
  expect(done).toEqual({ read: 3, left: 0, added: 6, skipped: 0 })
  expect(steps).toEqual([1, 2, 3])
  expect(book.tasks).toBe(6)
  expect(book.files).toBe(3)
  expect(book.help.haiku).toEqual([0.006])
  expect(book.bytes).toBe(CHAT.length * 3)
  expect(io.pauses).toBe(3)
  // The second pass has nothing to read.
  expect(await scanSome(io, book, files, { maxFiles: 10, maxBytes: 1e9 })).toEqual({ read: 0, left: 0, added: 0, skipped: 0 })
})

test('scanSome stops at its limits and leaves the rest for the next pass', async () => {
  const io = diskIo(disk())
  const book = emptyBook()
  const files = await findSessions(io, ROOT)
  expect(await scanSome(io, book, files, { maxFiles: 2, maxBytes: 1e9 })).toEqual({ read: 2, left: 1, added: 4, skipped: 0 })
  expect(await scanSome(io, book, files, { maxFiles: 2, maxBytes: 1e9 })).toEqual({ read: 1, left: 0, added: 2, skipped: 0 })
  const other = emptyBook()
  expect((await scanSome(io, other, files, { maxFiles: 10, maxBytes: 1 })).read).toBe(1)
  expect((await scanSome(io, emptyBook(), files, { maxFiles: 10, maxBytes: 1e9, isStopped: () => true })).read).toBe(0)
})

test('scanSome leaves out the chat that is open now', async () => {
  const io = diskIo(disk())
  const book = emptyBook()
  const files = await findSessions(io, ROOT)
  const done = await scanSome(io, book, files, { maxFiles: 10, maxBytes: 1e9, skip: f => f.key === 's3' })
  expect(done.read).toBe(2)
  expect(book.seen.s3).toBeUndefined()
})

test('scanSome: a big file is read as a stream, and a file that cannot be read is skipped once', async () => {
  const d = disk()
  d[`${ROOT}/proj-b/s3.jsonl`] = { text: CHAT_DAY3, size: 9_000_000, mtimeMs: 4000 }
  const io = diskIo(d, { noRead: [`${ROOT}/proj-a/s2.jsonl`] })
  const book = emptyBook()
  const files = await findSessions(io, ROOT)
  const done = await scanSome(io, book, files, { maxFiles: 10, maxBytes: 1e12 })
  // s3 is over the read limit, so no plain read is tried. s2 fails the plain read and falls to the stream.
  expect(io.reads).not.toContain(`${ROOT}/proj-b/s3.jsonl`)
  expect(io.streams).toContain(`${ROOT}/proj-b/s3.jsonl`)
  expect(io.streams).toContain(`${ROOT}/proj-a/s2.jsonl`)
  expect(done).toEqual({ read: 3, left: 0, added: 6, skipped: 0 })

  const dead = diskIo(d, { noRead: [`${ROOT}/proj-a/s2.jsonl`], noStream: true })
  const second = emptyBook()
  const out = await scanSome(dead, second, files, { maxFiles: 10, maxBytes: 1e12 })
  expect(out.skipped).toBe(2)
  expect(out.read).toBe(1)
  expect(second.skipped).toBe(2)
  // A skipped file is marked as seen, so the next pass does not try it again.
  expect((await scanSome(dead, second, files, { maxFiles: 10, maxBytes: 1e12 })).skipped).toBe(0)
})

// ---------- a task that is in two files ----------

// Hand math for the new task, on Opus 5.5: (5 x 4 + 200 x 20 + 104,000 x 0.2 + 1,000 x 8) / 1,000,000
const COST_4 = 0.03282
const T4 = '2026-11-01T11:00:00.000Z'
const RESUMED = [
  CHAT,
  userLine('and one more small thing please', T4),
  replyLine('msg_4', '2026-11-01T11:00:05.000Z', { input_tokens: 5, output_tokens: 200, cache_read_input_tokens: 104_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } }),
].join('\n')

test('addSession: a resumed chat holds a copy of the old tasks, and a copy is not counted again', async () => {
  const book = emptyBook()
  expect(addSession(book, 'k1', 1000, scanOf(CHAT), [])).toBe(2)
  // The new file has the two old tasks again, and one new task.
  expect(addSession(book, 'k2', 2000, scanOf(RESUMED), [])).toBe(1)
  expect(book.tasks).toBe(3)
  expect(book.files).toBe(2)
  expect(near(book.usd, 0.82204 + 0.04402 + 0.03262 + COST_4)).toBe(true)
  expect(book.turns).toHaveLength(3)
  expect(book.all).toHaveLength(3)
  expect(book.done).toEqual([Date.parse(T0), Date.parse(T2), Date.parse(T4)])
  // The file is read to its end, so it is not read again.
  expect(book.seen.k2).toEqual([2000, Date.parse(T4)])
})

test('addSession: the copy can come first, the first file read is the one that counts', async () => {
  const book = emptyBook()
  expect(addSession(book, 'k2', 2000, scanOf(RESUMED), [])).toBe(3)
  const usd = book.usd
  expect(addSession(book, 'k1', 1000, scanOf(CHAT), [])).toBe(0)
  expect(book.tasks).toBe(3)
  expect(book.usd).toBe(usd)
  expect(book.turns).toHaveLength(3)
})

test('parseBook refuses a book of the old version, which counted copies', async () => {
  const book = emptyBook()
  addSession(book, 'k1', 1000, scanOf(CHAT), [])
  expect(parseBook(JSON.stringify({ ...book, v: 1 }))).toBeNull()
  expect(parseBook(JSON.stringify({ ...book, done: undefined }))).toBeNull()
  expect(parseBook(JSON.stringify(book))?.done).toHaveLength(2)
})

test('scanSome: a forked chat on the disk adds no task a second time', async () => {
  const d = disk()
  // s3 is now a fork of s1: the same lines, in a new file.
  d[`${ROOT}/proj-b/s3.jsonl`] = { text: CHAT, mtimeMs: 4000 }
  const io = diskIo(d)
  const book = emptyBook()
  const done = await scanSome(io, book, await findSessions(io, ROOT), { maxFiles: 10, maxBytes: 1e9 })
  expect(done).toEqual({ read: 3, left: 0, added: 4, skipped: 0 })
  expect(book.tasks).toBe(4)
  // The newest file is read first. Here that is the fork, and a fork has no helper files of the old tasks.
  // So the helper dollars of the copied task are not counted. On 743 real chats this lost 52 of 1,818 helper runs.
  expect(near(book.usd, 2 * (0.82204 + 0.04402 + 0.03262))).toBe(true)
  expect(book.help.haiku).toEqual([0.006])
})

// ---------- a task that points at the chat ----------

test('tailOf keeps a short answer whole and the end of a long answer', async () => {
  expect(tailOf('  Want me to go ahead?  ')).toBe('Want me to go ahead?')
  const cut = tailOf(`${'a'.repeat(3000)}THE END`)
  expect(cut.length).toBe(BEFORE_CHARS + 3)
  expect(cut.startsWith('...a')).toBe(true)
  expect(cut.endsWith('THE END')).toBe(true)
  expect(tailOf('   ')).toBe('')
})

test('buildPrompt gives the end of the last answer when the chat has one', async () => {
  const before = 'Plan: 1. Read the 12 files. 2. Fix them. Go ahead?'
  const text = buildPrompt('go ahead', { model: OPUS, ctx: 50_000, isCold: false, before }, [])
  expect(text).toContain(`THE LAST ANSWER OF CLAUDE IN THIS CHAT (its end)\n${before}`)
  // The task is first. The last answer comes after the chat size.
  expect(text.indexOf('TASK\ngo ahead')).toBe(0)
  expect(text.indexOf('THE CHAT NOW') < text.indexOf('THE LAST ANSWER')).toBe(true)
  expect(buildPrompt('go ahead', { model: OPUS, ctx: 50_000, isCold: false }, [])).not.toContain('THE LAST ANSWER')
  expect(buildPrompt('go ahead', { model: OPUS, ctx: 50_000, isCold: false, before: '' }, [])).not.toContain('THE LAST ANSWER')
})

test('the spec says what to do with a task that points at the chat', async () => {
  expect(SPEC).toContain('"go ahead"')
  expect(SPEC).toContain('Count that work.')
  expect(SPEC).toContain('Do not make a step that only asks the user')
  expect(SPEC).toContain('Give zero tool calls only for a plain question')
})

// ---------- an estimate with no tool call ----------

const NO_TOOLS = parseEstimate(JSON.stringify({ confidence: 'high', steps: [{ name: 'Answer the question', done: 'the answer is given' }] })) as Parsed

test('priceEstimate: an estimate with no tool call has low confidence, whatever the model said', async () => {
  // One request at a context of 100,000 on Opus 5.5, with the start sizes:
  // 1.1 x 101,400 tokens read (0.022308), 2,800 written (0.0224), 1,682 out (0.033649): 0.078357.
  // A warm chat: 0.078357 x 0.72 = 0.056417.
  // Low is x 0.26 = 0.015. Safe is x 5.8 = 0.327, shown as 0.35.
  const e = priceEstimate(null, NO_TOOLS, FACTS, [], { ratio: 1, n: 0 }, 0).estimate
  expect(NO_TOOLS.confidence).toBe('high')
  expect(e.confidence).toBe('low')
  expect(e.likely).toBe(0.06)
  expect(e.low).toBe(0.01)
  expect(e.safe).toBe(0.35)
  expect(e.units).toEqual({})
})

test('priceEstimate: the safe amount of such an estimate is never under a middle task of the person', async () => {
  const book = emptyBook()
  // Ten past tasks. The middle one is the sixth: $6.
  book.all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const e = priceEstimate(book, NO_TOOLS, FACTS, [], { ratio: 1, n: 0 }, 0).estimate
  expect(e.confidence).toBe('low')
  expect(e.safe).toBe(6)
  expect(e.likely < 1).toBe(true)
  // Nine past tasks are too few to say what a middle task costs.
  book.all = [1, 2, 3, 4, 5, 6, 7, 8, 9]
  expect(priceEstimate(book, NO_TOOLS, FACTS, [], { ratio: 1, n: 0 }, 0).estimate.safe < 1).toBe(true)
  // An estimate with tool calls keeps its own range.
  book.all = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const counted = priceEstimate(book, PARSED, FACTS, [], { ratio: 1, n: 0 }, 0).estimate
  expect(counted.confidence).toBe('medium')
  expect(counted.safe < 6).toBe(true)
})

// ---------- a task that another Claude session sends ----------

const PEER_NOTE = '\n\nThis came from another Claude session, not typed by your user.'

function peerText(words: string, tag = 'cross-session-message'): string {
  return `Another Claude session sent a message:\n<${tag} from="local_1" from-name="Main chat">\n${words}\n</${tag}>${PEER_NOTE}`
}

/** The engine saves a message from another session as a note of its own: isMeta, origin peer, source system. */
function peerLine(words: string, at: string, more: Record<string, unknown> = {}, origin: Record<string, unknown> = { body: words }): string {
  return line({ type: 'user', message: { role: 'user', content: peerText(words) }, isMeta: true, timestamp: at, origin: { kind: 'peer', from: 'local_1', name: 'Main chat', ...origin }, promptSource: 'system', ...more })
}

const READY = line({ type: 'user', message: { role: 'user', content: 'Reply with the single word ready' }, timestamp: T0, promptSource: 'sdk' })
const R1 = replyLine('msg_r1', '2026-11-01T10:00:05.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 } })
const R2_USAGE = { input_tokens: 5, output_tokens: 300, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 } }
const T_PEER = '2026-11-01T10:01:00.000Z'
const T_AFTER = '2026-11-01T10:01:05.000Z'
// Hand math on Opus 5.5 (in 4, out 20, read 0.2, write 8 per million tokens):
const COST_R1 = (10 * 4 + 5 * 20 + 20_000 * 8) / 1e6 // 0.16014
const COST_R2 = (5 * 4 + 300 * 20 + 20_000 * 0.2 + 1000 * 8) / 1e6 // 0.01802

test('peerWords takes the words of another session out of the wrapper', async () => {
  expect(peerWords(peerText('Build the page.\nUse the blue theme.'))).toBe('Build the page.\nUse the blue theme.')
  // A long line is cut, so the end tag is gone: the words go to the end.
  expect(peerWords('Another Claude session sent a message:\n<cross-session-message from="local_1">\nBuild the long')).toBe('Build the long')
  // The words can hold the end tag as text. The last end tag is the one the engine wrote.
  expect(peerWords(peerText('Tell me what </cross-session-message> is.'))).toBe('Tell me what </cross-session-message> is.')
  // The report of a helper has another wrapper, and a typed message has none.
  expect(peerWords(peerText('[Subagent hand-back] The report.', 'agent-message'))).toBe('')
  expect(peerWords('fix the bug')).toBe('')
})

test('talksOut knows the tools that send work to another session or to a helper', async () => {
  for (const name of ['Agent', 'Task', 'Workflow', 'SendMessage', 'mcp__ccd_session__start_session', 'mcp__ccd_session__hand_off_to_session', 'mcp__ccd_session_mgmt__send_message', 'mcp__chat-relay__send_to_chat', 'mcp__chat-relay__new_chat']) {
    expect(talksOut(name)).toBe(true)
  }
  for (const name of ['Read', 'Bash', 'WebSearch', 'mcp__ccd_session_mgmt__list_sessions', 'TaskStop']) expect(talksOut(name)).toBe(false)
})

test('the hand math of the two small requests is what it says', async () => {
  expect(near(COST_R1, 0.16014)).toBe(true)
  expect(near(COST_R2, 0.01802)).toBe(true)
})

test('a task that another Claude session sends is a task of its own', async () => {
  const words = 'Build the churn report from the support tickets.'
  const scan = scanOf([READY, R1, peerLine(words, T_PEER), replyLine('msg_r2', T_AFTER, R2_USAGE, ['Read'])].join('\n'))
  expect(scan.prompts.map(p => [p.text, p.isHuman, p.isPeer === true])).toEqual([
    ['Reply with the single word ready', true, false],
    [words, false, true],
  ])
  const turns = turnsOf(scan, [], {})
  expect(turns).toHaveLength(2)
  // Before, the cost of the sent task was put on the "ready" message.
  expect(turns[0]?.text).toBe('Reply with the single word ready')
  expect(near(turns[0]?.usd ?? 0, COST_R1)).toBe(true)
  expect(turns[1]?.text).toBe(words)
  expect(turns[1]?.t).toBe(Date.parse(T_PEER))
  expect(near(turns[1]?.usd ?? 0, COST_R2)).toBe(true)
  expect(turns[1]?.n).toEqual(counts({ read: 1 }))
})

test('a sent task can be the first task of a chat, and an old line with no body gives the words between the tags', async () => {
  const scan = scanOf([peerLine('Redesign the landing page.', T_PEER, {}, {}), replyLine('msg_r2', T_AFTER, R2_USAGE, ['Read'])].join('\n'))
  const turns = turnsOf(scan, [], {})
  expect(turns).toHaveLength(1)
  expect(turns[0]?.text).toBe('Redesign the landing page.')
  expect(near(turns[0]?.usd ?? 0, COST_R2)).toBe(true)
})

test('a message that can be the answer to the task own call is not a new task', async () => {
  for (const tool of ['SendMessage', 'mcp__ccd_session__start_session', 'Agent']) {
    const chat = [
      userLine('ask the other chat to add the tab to the doc', T0),
      replyLine('msg_r1', '2026-11-01T10:00:05.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 } }, [tool]),
      peerLine('Done: the tab is in the doc.', T_PEER),
      replyLine('msg_r2', T_AFTER, R2_USAGE),
    ].join('\n')
    const turns = turnsOf(scanOf(chat), [], {})
    expect(turns).toHaveLength(1)
    expect(turns[0]?.text).toBe('ask the other chat to add the tab to the doc')
    expect(near(turns[0]?.usd ?? 0, COST_R1 + COST_R2)).toBe(true)
  }
})

test('after the next typed message, a message from another session starts a task again', async () => {
  const chat = [
    userLine('ask the other chat to add the tab to the doc', T0),
    replyLine('msg_r1', '2026-11-01T10:00:05.000Z', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 20_000, cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 0 } }, ['SendMessage']),
    userLine('thanks', '2026-11-01T10:00:30.000Z'),
    replyLine('msg_r3', '2026-11-01T10:00:35.000Z', R2_USAGE),
    peerLine('Now write the summary of the doc.', T_PEER),
    replyLine('msg_r2', T_AFTER, R2_USAGE),
  ].join('\n')
  expect(turnsOf(scanOf(chat), [], {}).map(t => t.text)).toEqual(['ask the other chat to add the tab to the doc', 'thanks', 'Now write the summary of the doc.'])
})

test('the report of a helper, a line of a helper chat and a prompt that a mod sent do not start a task', async () => {
  const report = line({ type: 'user', message: { role: 'user', content: peerText('[Subagent hand-back] The report.', 'agent-message') }, isMeta: true, timestamp: T_PEER, origin: { kind: 'peer', name: 'general-purpose', body: '[Subagent hand-back] The report.' }, promptSource: 'system' })
  const side = peerLine('Count the files.', T_PEER, { isSidechain: true })
  const mod = line({ type: 'user', message: { role: 'user', content: 'What is up?' }, timestamp: T_PEER, origin: { kind: 'plugin' }, promptSource: 'system' })
  for (const extra of [report, side, mod]) {
    const scan = scanOf([READY, R1, extra, replyLine('msg_r2', T_AFTER, R2_USAGE)].join('\n'))
    expect(scan.prompts.some(p => p.isPeer === true)).toBe(false)
    const turns = turnsOf(scan, [], {})
    expect(turns).toHaveLength(1)
    expect(near(turns[0]?.usd ?? 0, COST_R1 + COST_R2)).toBe(true)
  }
})

test('a long message from another session, cut by the stream filter, is still a task with its time', async () => {
  const words = `Write the long report. ${'More detail. '.repeat(200)}`
  const whole = peerLine(words, T_PEER, { parentUuid: 'p1', sessionId: 's1' })
  // The line as the engine saves it: the type and the message come first, the time and the origin are in the middle.
  const saved = JSON.stringify({ parentUuid: 'p1', isSidechain: false, type: 'user', message: { role: 'user', content: peerText(words) }, isMeta: true, uuid: 'u1', timestamp: T_PEER, origin: { kind: 'peer', from: 'local_1', name: 'Main chat', body: words, hostInjected: true }, promptSource: 'system', sessionId: 's1' })
  expect(whole.length).toBeGreaterThan(4000)
  const cut = (withTime: boolean): string => ['\u0001' + saved.slice(0, 1500), '', '', saved.slice(-2500), withTime ? `"timestamp":"${T_PEER}"` : ''].join('\u0002')
  expect(saved.slice(0, 1500).includes('"timestamp"')).toBe(false)
  expect(saved.slice(-2500).includes('"timestamp"')).toBe(false)
  const scan = scanOf(cut(true))
  expect(scan.prompts).toHaveLength(1)
  expect(scan.prompts[0]?.isPeer).toBe(true)
  expect(scan.prompts[0]?.t).toBe(Date.parse(T_PEER))
  expect(scan.prompts[0]?.text.startsWith('Write the long report. More detail.')).toBe(true)
  expect(scan.prompts[0]?.text).toHaveLength(400)
  // With no time, the task has no place in the chat: it is left out.
  expect(scanOf(cut(false)).prompts).toHaveLength(0)
})
