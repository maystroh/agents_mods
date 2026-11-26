// The cost estimate that runs before the task.
// A small model reads the task and counts the work: tool calls, helpers, pages.
// It never gives dollars. This file puts the person's own measured prices on the counts.

import type { Estimate, HelperAsk, Mode, Units } from '../types'
import { CATS, KIND_LABEL, family, kindOf, priceWork, quantile, type Book, type Match } from './book.ts'

/** The model and effort of the estimate call. Sonnet at medium is the least that counts work well. */
export const EST_MODEL = 'sonnet'
export const EST_EFFORT = 'medium'

/** What the estimate model is told to look for. Every signal is a thing that makes a task cost money. */
export const SPEC = `You estimate the work in a task for Claude Code before the task runs.
You do not do the task. You do not give dollar amounts: a program puts measured prices on your counts.

Read the task. Check every cost signal below. Then count the tool calls the task needs.

COST SIGNALS
1. Files to read. How many, and how big. A long file needs more than one read call.
2. Searches in files or code: grep, glob, find where a thing is used.
3. Web work. One call per search query and one per page fetched. Items times queries.
4. Connector calls (MCP: mail, calendar, Notion, Stripe, Slack, a CRM, a scraper). One call per record or per page of results.
5. Shell commands: run, test, build, install, git, scripts. Count each run. A test that can fail adds a fix round and a second run.
6. Files to create or change. One call per new file, one to three per changed file. Put the pages of new text (one page is about 400 words or 60 lines of code) in "pages".
7. Helpers (sub-agents). Asked for in words ("use agents", "in parallel", "a workflow"), or needed because the work splits into independent parts. Give the model, the count and the size of each.
8. Bulk. "for each", "all 200", "every row": multiply the work of one item by the item count. Put the item count in "items".
9. Check and repair rounds. "until the tests pass", "verify", "review it": add a second round of reads and commands.
10. Browser or computer use. Each page step is 3 to 6 calls: open, look, click, type, look again.
11. Pictures, video and audio. Each one made or looked at is one call, often with a shell or connector call.
12. What the chat already holds. Do not count it again. The program knows the size of the context. THE LAST ANSWER OF CLAUDE, when it is given, shows what the chat holds.
13. What is not known. A vague scope, an unknown size, an open end ("improve", "explore", "as many as you can"). Name each one in "unsure" and lower "confidence".
14. Hard thinking. Design work, a bug with no clear cause, long writing: add 1 or 2 read or search calls to that step.
15. Back and forth. If the task needs an answer from the user in the middle, say so in "unsure".

RULES
- Give the likely count, not the worst case. The program adds the safety margin.
- The task can point at the chat: "go ahead", "do it", "yes", "fix that", "continue", "the second one". Then the work is what THE LAST ANSWER OF CLAUDE offers or plans. Count that work.
- Claude Code does the work with tools and seldom asks back. Do not make a step that only asks the user or only waits. If you cannot tell what the work is, count the most likely reading and set "confidence" to "low".
- A message that asks for work has tool calls. Give zero tool calls only for a plain question that Claude can answer from the chat.
- When past tasks of this user are given and one is close to this task, lean on its real counts.
- When the learning memory is given, find the type that fits the task. Its sample tasks, subagent counts and lessons show how big such work gets. A type whose runs often start subagents: count those helpers.
- Split the work into 2 to 7 steps, in the order Claude will do them. A small task is 1 step.
- Give each step a "done" check: one plain sentence that is clearly true or false at the end.
- If one unit of work repeats over 8 or more items, make step 1 a scout step that does the first 2 or 3 items, and start its name with "Scout:".
- A helper's own tool calls are not part of the step's counts. Give only the helper.
- "mode" is "pace" when more money gives a better result and the work can stop anywhere (broad research, "as many as you can"). It is "guard" for every task with a fixed result.
- Answer with one JSON object and nothing else. No markdown.

JSON SHAPE
{"mode":"guard","items":0,"confidence":"medium","unsure":["..."],
 "steps":[{"name":"...","done":"...","read":0,"search":0,"edit":0,"bash":0,"web":0,"browser":0,"mcp":0,"pages":0,
           "helpers":[{"model":"sonnet","n":2,"size":"m"}]}]}
"confidence" is "low", "medium" or "high". "size" is "s" (a lookup), "m" (read and report) or "l" (a long job with many calls). "model" is "haiku", "sonnet", "opus" or "same".`

/** What the mod knows about the chat when the estimate is made. `before` is the end of Claude's last answer in this chat. */
/** `effort` is the effort level of the chat. It is not in the words for the estimate model: it sets the price of a request. */
/** `reload` (0.7.0): the chat is warm, but the task runs on another model, so that model reads the chat at the full price one time. */
export type Facts = { model: string; ctx: number; isCold: boolean; before?: string; effort?: string; reload?: boolean }

/** How much of Claude's last answer the estimate model gets. */
export const BEFORE_CHARS = 2000

/** The end of an answer: the part that says what comes next. A task like "go ahead" points at it. */
export function tailOf(text: string): string {
  const flat = text.trim()
  return flat.length > BEFORE_CHARS ? `...${flat.slice(-BEFORE_CHARS)}` : flat
}

function unitLine(n: readonly number[]): string {
  const parts: string[] = []
  CATS.forEach((c, i) => {
    const v = n[i] ?? 0
    if (v > 0 && c !== 'meta' && c !== 'other') parts.push(`${c} ${v}`)
  })
  return parts.join(', ') || 'no tools'
}

/** The message for the estimate model: the task, the chat as it is, the end of Claude's last answer, and the closest past tasks with their real counts. */
export function buildPrompt(task: string, facts: Facts, matches: readonly Match[], memory = ''): string {
  const lines = [
    `TASK\n${task.slice(0, 6000)}`,
    `THE CHAT NOW\nModel: ${family(facts.model)}. Context: about ${Math.round(facts.ctx / 1000)}K tokens.`,
  ]
  if (facts.before) lines.push(`THE LAST ANSWER OF CLAUDE IN THIS CHAT (its end)\n${facts.before}`)
  if (matches.length > 0) {
    lines.push(
      'PAST TASKS OF THIS USER, WITH REAL COUNTS\n' +
        matches
          .map(
            m =>
              `- "${m.turn.text.replace(/\s+/g, ' ').slice(0, 160)}" -> ${m.turn.reqs} requests, tool calls: ${unitLine(m.turn.n)}` +
              (m.turn.h > 0 ? `, helpers ${m.turn.h}` : ''),
          )
          .join('\n'),
    )
  }
  // Added in the subagent fixes (fix 13): the learning memory. The index of task types and at most 2 type files.
  if (memory.trim()) lines.push(`WHAT PAST TASKS OF THIS USER COST, BY TYPE (the learning memory)\n${memory.trim().slice(0, 24_000)}`)
  lines.push('Count the work of the TASK. Answer with the JSON object only.')
  return lines.join('\n\n')
}

export type EstStep = { name: string; done: string; units: Units; helpers: HelperAsk[]; pages: number }
export type Parsed = { mode: Mode; items: number; steps: EstStep[]; confidence: Estimate['confidence']; unsure: string[] }

const COUNTED = ['read', 'search', 'edit', 'bash', 'web', 'browser', 'mcp'] as const

function count(v: unknown, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.round(n)) : 0
}

/** Read the estimate model's answer. Null when it is not the JSON the spec asks for. */
export function parseEstimate(text: string): Parsed | null {
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from < 0 || to <= from) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text.slice(from, to + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || !Array.isArray(raw.steps)) return null
  const steps: EstStep[] = []
  for (const item of (raw.steps as unknown[]).slice(0, 8)) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (!name) continue
    const units: Units = {}
    for (const c of COUNTED) {
      const v = count(o[c], 2000)
      if (v > 0) units[c] = v
    }
    const helpers: HelperAsk[] = []
    if (Array.isArray(o.helpers)) {
      for (const h of (o.helpers as unknown[]).slice(0, 6)) {
        const ho = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>
        const n = count(ho.n, 200)
        if (n === 0) continue
        const size = ho.size === 's' || ho.size === 'l' ? ho.size : 'm'
        helpers.push({ model: typeof ho.model === 'string' ? ho.model.toLowerCase() : 'same', n, size })
      }
    }
    steps.push({
      name,
      done: typeof o.done === 'string' ? o.done.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
      units,
      helpers,
      pages: count(o.pages, 400),
    })
  }
  if (steps.length === 0) return null
  const confidence = raw.confidence === 'high' || raw.confidence === 'low' ? raw.confidence : 'medium'
  const unsure = Array.isArray(raw.unsure)
    ? (raw.unsure as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map(u => u.trim().slice(0, 120)).slice(0, 4)
    : []
  return { mode: raw.mode === 'pace' ? 'pace' : 'guard', items: count(raw.items, 100000), steps, confidence, unsure }
}

/**
 * How far the real cost is from the first estimate, as a factor.
 * `ratio` is real cost over estimate, learned from this person's finished budgets. `spread` is how wide the range is.
 */
export type Tune = { ratio: number; n: number }

/**
 * The start value of the ratio, until the person has finished budgets of their own.
 * Measured on 2026-11-13 on 430 past tasks of one Mac. Each task was estimated with only the tasks before it.
 * In a new chat the middle task cost 1.00 times its estimate, so the counted work needs no correction at the start.
 */
export const START_RATIO = 1
/**
 * In a chat that is already warm, the same test gave estimates that were too high.
 * With this factor the middle task of a warm chat costs 1.00 times its estimate.
 */
export const WARM_RATIO = 0.72
/**
 * The range around the likely cost, as factors, for a new chat (cold) and for a chat that already runs (warm).
 * Each number is a point of real cost over likely cost in the same test:
 * 1 task in 10 is under `low`, the middle half is inside `usual`, 95 of 100 are at or under `safe`.
 * The check: each task was left out, the numbers were made from the other tasks, then the task was scored.
 * 95.3% of the tasks were at or under the safe amount, 49.3% were inside the usual band, 89.5% were at or over the low amount.
 * dev/ranges.py makes the numbers and runs the check.
 */
export const BAND = {
  cold: { low: 0.5, usual: [0.7, 1.6], safe: 5.5 },
  warm: { low: 0.26, usual: [0.53, 1.8], safe: 5.8 },
} as const
/** Of 100 such tasks, how many cost the safe amount or less. */
export const HOLD = 95

/** A range around the likely cost, as factors. `n` is set when it comes from the person's own finished tasks. */
export type Band = { low: number; usual: readonly [number, number]; safe: number; n?: number }

/** The least own finished tasks for an own band, and the least for an own safe amount. */
export const OWN_MIN = 10
export const OWN_SAFE_MIN = 20

function pointOf(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 1
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.min(sorted.length - 1, lo + 1)
  const a = sorted[lo] ?? 1
  return a + ((sorted[hi] ?? a) - a) * (pos - lo)
}

/**
 * The band of this person's own finished tasks. `ratios` are real cost over estimate.
 * The learned ratio moves the middle already, so the band is taken around the middle of the ratios.
 * Under 10 tasks: null, and the 430 past tasks set the band. Under 20 tasks the safe factor stays the measured one.
 */
export function ownBand(ratios: readonly number[], isCold: boolean): Band | null {
  const list = ratios.filter(r => Number.isFinite(r) && r > 0).sort((a, b) => a - b)
  if (list.length < OWN_MIN) return null
  const mid = pointOf(list, 0.5) || 1
  const base = isCold ? BAND.cold : BAND.warm
  const low = Math.min(0.9, pointOf(list, 0.1) / mid)
  const u0 = Math.min(0.97, Math.max(low + 0.01, pointOf(list, 0.25) / mid))
  const u1 = Math.max(1.03, pointOf(list, 0.75) / mid)
  const safe = list.length >= OWN_SAFE_MIN ? Math.max(u1 * 1.1, pointOf(list, 0.95) / mid) : base.safe
  return { low, usual: [u0, u1], safe: Math.max(safe, u1 * 1.1), n: list.length }
}

/** The numbers of an estimate that say how such tasks spread. */
export type Spread = { low: number; likely: number; safe: number; usual?: [number, number]; hold?: number }

/** One point of the spread: the share of tasks under an amount (as a logit), and the amount (as a log). */
type Point = [share: number, usd: number]

function curveOf(e: Spread): Point[] {
  const raw: [number, number][] = [[0.1, e.low]]
  if (e.usual) raw.push([0.25, e.usual[0]])
  raw.push([0.5, e.likely])
  if (e.usual) raw.push([0.75, e.usual[1]])
  // An estimate from before 0.5.0 has no proof for its safe amount. It held for about 9 tasks in 10.
  raw.push([(e.hold ?? 90) / 100, e.safe])
  const pts: Point[] = []
  for (const [p, usd] of raw) {
    const last = pts[pts.length - 1]
    if (usd > 0 && (!last || Math.log(usd) > last[1] + 1e-4)) pts.push([Math.log(p / (1 - p)), Math.log(usd)])
  }
  return pts
}

/** Read the curve at `x`. `from` 0 gives the amount for a share, `from` 1 gives the share for an amount. Past the ends the last line goes on. */
function along(pts: readonly Point[], x: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0
  let k = pts.length - 2
  for (let i = 0; i < pts.length - 1; i++) {
    if (x <= (pts[i + 1]?.[from] ?? 0)) {
      k = i
      break
    }
  }
  const a = pts[k] as Point
  const b = pts[k + 1] as Point
  return a[to] + ((b[to] - a[to]) * (x - a[from])) / (b[from] - a[from])
}

/**
 * What the whole task will cost when `spent` dollars are spent and the task still runs.
 * A task that has passed `spent` is one of the tasks that cost more than `spent`.
 * `q` is the share of those tasks that end at or under the answer: 0.5 is the middle, 0.75 is 3 tasks in 4.
 * Checked on 430 past tasks at seven spend marks: 48 to 53 of 100 tasks ended under the 0.5 answer, 73 to 78 under the 0.75 answer.
 */
export function courseOf(e: Spread, spent: number, q = 0.5): number {
  const pts = curveOf(e)
  if (pts.length < 2) return Math.max(spent, e.likely)
  if (!(spent > 0)) return Math.exp(along(pts, Math.log(q / (1 - q)), 0))
  const z = along(pts, Math.log(spent), 1)
  // The share that is left over shrinks by (1 - q). In logit form that is ln((q + e^z) / (1 - q)).
  const next = (z > 30 ? z : Math.log(q + Math.exp(z))) - Math.log(1 - q)
  const out = Math.exp(along(pts, next, 0))
  return Number.isFinite(out) ? Math.max(spent, out) : spent
}

/** The share of such tasks that cost `usd` or less, from 0 to 1. */
export function shareUnder(e: Spread, usd: number): number {
  const pts = curveOf(e)
  if (pts.length < 2 || !(usd > 0)) return usd >= e.likely && e.likely > 0 ? 1 : 0
  const z = along(pts, Math.log(usd), 1)
  return 1 / (1 + Math.exp(-z))
}

/** The share of such tasks that land between the likely cost divided by `factor` and the likely cost times `factor`. */
export function oddsWithin(e: Spread, factor = 2): number {
  if (!(e.likely > 0)) return 0
  return Math.max(0, Math.min(1, shareUnder(e, e.likely * factor) - shareUnder(e, e.likely / factor)))
}

/** The chance that a task which has spent `spent` and still runs ends over `limit`, from 0 to 1. */
export function overOdds(e: Spread, spent: number, limit: number): number {
  if (!(limit > 0) || spent >= limit) return 1
  const over = 1 - shareUnder(e, limit)
  const here = spent > 0 ? 1 - shareUnder(e, spent) : 1
  return here > 1e-9 ? Math.max(0, Math.min(1, over / here)) : 1
}

/** A share as people say it: "7 of 10". */
export function ofTen(share: number): string {
  return `${Math.max(0, Math.min(10, Math.round(share * 10)))} of 10`
}

/** The estimate with its odds: "Likely $1.20. About 7 of 10 tasks like this land between $0.60 and $2.40." */
export function oddsLine(e: Spread): string {
  const money = (n: number): string => `$${n.toFixed(2)}`
  return `Likely ${money(e.likely)}. About ${ofTen(oddsWithin(e))} tasks like this land between ${money(e.likely / 2)} and ${money(e.likely * 2)}.`
}

/** Points of the spread for a drawing: how common each amount is. `x` is the amount, `y` is the height from 0 to 1. */
export function curvePoints(e: Spread, n = 40): { usd: number; y: number }[] {
  const top = Math.max(e.safe, e.likely * 2.2)
  const out: { usd: number; y: number }[] = []
  let max = 0
  for (let i = 0; i <= n; i++) {
    const usd = (top * i) / n
    const step = top / n / 2
    const y = i === 0 ? 0 : Math.max(0, shareUnder(e, usd + step) - shareUnder(e, Math.max(1e-6, usd - step)))
    max = Math.max(max, y)
    out.push({ usd, y })
  }
  return out.map(p => ({ usd: p.usd, y: max > 0 ? p.y / max : 0 }))
}

function sumUnits(steps: readonly EstStep[]): Units {
  const total: Units = {}
  for (const st of steps) for (const c of CATS) if (st.units[c]) total[c] = (total[c] ?? 0) + (st.units[c] ?? 0)
  return total
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** A dollar amount a person would pick: two digits under $2, then quarter steps, then whole dollars. */
export function nice(n: number): number {
  if (n < 2) return Math.max(0.05, Math.ceil(n * 20 - 1e-9) / 20)
  if (n < 10) return Math.ceil(n * 4 - 1e-9) / 4
  if (n < 50) return Math.ceil(n * 2 - 1e-9) / 2
  return Math.ceil(n / 5 - 1e-9) * 5
}

/** A tight limit for an estimate: 3 of 4 such tasks cost less. An estimate from before 0.5.0 has only its likely amount. */
export function tightOf(e: Spread): number {
  return nice(e.usual ? e.usual[1] : e.likely)
}

/** The amount that 3 of 4 such tasks cost more than. An estimate with no band has only its low end. */
export function leastOf(e: Spread): number {
  return e.usual ? e.usual[0] : e.low
}

export type Priced = { estimate: Estimate; steps: { name: string; done: string; usd: number; scout?: { items: number; total: number } }[] }

/** Put the person's measured prices on the counted work, and make the range: low, likely, safe. */
export function priceEstimate(
  book: Book | null,
  parsed: Parsed,
  facts: Facts,
  matches: readonly Match[],
  tune: Tune,
  cost: number,
  own: Band | null = null,
): Priced {
  let ctx = facts.ctx
  const rows = parsed.steps.map((st, i) => {
    const p = priceWork(book, { units: st.units, helpers: st.helpers, pages: st.pages }, { model: facts.model, ctx, isCold: i === 0 && (facts.isCold || facts.reload === true), withBase: i === 0, effort: facts.effort })
    // The chat grows as the task runs, so each later step reads a bigger context.
    ctx += p.w + p.out
    return { st, usd: p.usd }
  })
  const raw = rows.reduce((sum, r) => sum + r.usd, 0)
  const units = sumUnits(parsed.steps)
  const helpers = parsed.steps.reduce((sum, st) => sum + st.helpers.reduce((s, h) => s + h.n, 0), 0)
  const kind = kindOf(
    CATS.map(c => (c === 'agent' ? helpers : (units[c] ?? 0))),
    helpers,
  )
  let likely = raw * tune.ratio * (facts.isCold ? 1 : WARM_RATIO)
  let basis = `${rows.length} step${rows.length === 1 ? '' : 's'} counted by ${EST_MODEL} and priced with your past chats`
  let similar: Estimate['similar'] = null
  // Close past tasks pull the number toward what such tasks really cost.
  const close = matches.filter(m => m.score >= 0.3).map(m => m.turn.usd + m.turn.hu)
  if (close.length >= 3) {
    const median = quantile(close, 0.5)
    similar = { cost: round2(median), runs: close.length }
    likely = Math.sqrt(likely * Math.max(0.02, median))
    basis += `, and ${close.length} similar past tasks (median $${median.toFixed(2)})`
  } else if (matches.length > 0) {
    const all = matches.map(m => m.turn.usd + m.turn.hu)
    similar = { cost: round2(quantile(all, 0.5)), runs: all.length }
  }
  // An estimate with no tool call says the task is a plain question. When that is wrong, the real cost is much higher.
  const calls = CATS.reduce((sum, c) => sum + (units[c] ?? 0), 0) + helpers
  const confidence: Estimate['confidence'] = calls === 0 ? 'low' : parsed.confidence
  // The person's own finished tasks set the range when there are enough of them. Else the 430 past tasks do.
  const band: Band = own ?? (facts.isCold ? BAND.cold : BAND.warm)
  if (own) basis += `, range from your own ${own.n ?? 0} finished tasks`
  const low = likely * band.low
  let safe = likely * band.safe
  // So the safe amount of such an estimate is never under what a middle task of this person costs.
  if (calls === 0 && book && book.all.length >= 10) safe = Math.max(safe, quantile(book.all, 0.5))
  const k = raw > 0 ? likely / raw : 1
  const steps = rows.map(r => {
    const out: Priced['steps'][number] = { name: r.st.name, done: r.st.done, usd: round2(r.usd * k) }
    if (/^scout\b/i.test(r.st.name) && parsed.items >= 8) {
      const done = Number(/\b(\d+)\b/.exec(r.st.name)?.[1] ?? 3)
      out.scout = { items: Math.max(1, Math.min(done, parsed.items)), total: parsed.items }
    }
    return out
  })
  return {
    steps,
    estimate: {
      low: round2(low),
      likely: round2(likely),
      safe: nice(safe),
      kind,
      mode: parsed.mode,
      confidence,
      basis,
      similar,
      unsure: parsed.unsure,
      cost,
      units,
      helpers,
      usual: [round2(likely * band.usual[0]), round2(likely * band.usual[1])],
      hold: HOLD,
    },
  }
}

/** When the estimate call fails: the cost of similar past tasks, or of an average task, with low confidence. */
export function fallbackEstimate(book: Book | null, matches: readonly Match[], facts: Facts): Priced {
  const close = matches.map(m => m.turn.usd + m.turn.hu)
  const all = book?.all ?? []
  let likely = 2
  let basis = 'a first guess: no estimate could be made and no past chats are read yet'
  let similar: Estimate['similar'] = null
  if (close.length >= 2) {
    likely = quantile(close, 0.5)
    similar = { cost: round2(likely), runs: close.length }
    basis = `${close.length} similar past tasks of yours (the estimate call did not answer)`
  } else if (all.length >= 10) {
    likely = quantile(all, 0.5)
    basis = `the median of your last ${all.length} tasks (the estimate call did not answer)`
  }
  // The price of one request here is a floor: no task costs less than its first request.
  const first = priceWork(book, { units: {} }, { model: facts.model, ctx: facts.ctx, isCold: facts.isCold }).usd
  likely = Math.max(likely, first * 1.5)
  const low = Math.max(first, likely * 0.4)
  // No work was counted, so this range has no proof: it takes the wider of the two measured bands, and says no share.
  return {
    steps: [],
    estimate: {
      low: round2(low),
      likely: round2(likely),
      safe: nice(likely * BAND.warm.safe),
      usual: [round2(Math.max(low, likely * BAND.warm.usual[0])), round2(likely * BAND.warm.usual[1])],
      kind: 'explore',
      mode: 'guard',
      confidence: 'low',
      basis,
      similar,
      unsure: ['The work could not be counted'],
      cost: 0,
      units: {},
      helpers: 0,
    },
  }
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}
