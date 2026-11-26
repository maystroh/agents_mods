// The budget math. Pure code: no engine calls, so every rule here has a unit test.

import type { Ask, BookView, Budget, Estimate, Plan, PlanStep, Profile, Run, RunStep, Todo, TypePath, Units } from '../types'
import { cat, family, kindRows, priceFor, quantile, type Book } from './book.ts'
import { courseOf, nice, START_RATIO } from './estimator.ts'
import { STARTER } from './starter.ts'

// Changed in 0.8.0: Claude never sees the budget. The mod gives Claude no note, no tool and no amount.

export const GOOD = '#16a34a'
export const WARN = '#d97706'
export const BAD = '#dc2626'
export const ACCENT = '#d97757'
export const TRACK = '#8a8f98'

export const HELP =
  'No budget is running. For an estimate and a live count, type /budget and then your task: /budget research our churned members. ' +
  'To add a dollar limit: /budget 3 research our churned members.'

export function usd(n: number): string {
  const v = Math.max(0, n)
  // Under one cent, two digits would print $0.00.
  return v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

/**
 * Added in 0.8.0. The two lines of the mod cost section in the panel.
 * The mod's calls cost cents, so amounts under $0.10 show 3 digits.
 * Session total: the whole bill of the chat, the mod's calls included. It adds up across runs.
 */
export function modLines(mod: number, session: number): [string, string] {
  const fine = (n: number) => {
    const v = Math.max(0, n)
    return v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`
  }
  return [`This mod run cost ${fine(mod)}`, `Session total, mod included ${fine(session)}`]
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function floor2(n: number): number {
  return Math.floor(n * 100 + 1e-6) / 100
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

// ---------- the budget value ----------

/** A value an older version stored is upgraded. Anything that is not a budget reads as none. */
export function live(value: unknown): Budget | null {
  const b = value as (Partial<Omit<Budget, 'v'>> & { v?: number }) | null | undefined
  if (!b || typeof b !== 'object' || (b.v !== 2 && b.v !== 3) || typeof b.limit !== 'number' || !Array.isArray(b.bars)) return null
  const isWhole =
    b.v === 3 &&
    (b.mode === 'guard' || b.mode === 'pace') &&
    (b.phase === 'run' || b.phase === 'landing') &&
    Array.isArray(b.notes) &&
    Array.isArray(b.todos) &&
    typeof b.used === 'object' &&
    b.used !== null &&
    typeof b.pending === 'string' &&
    typeof b.waiting === 'string'
  if (isWhole) return clean(b as unknown as Budget)
  const plan = b.plan && typeof b.plan === 'object' && Array.isArray(b.plan.steps) ? b.plan : null
  return clean({
    ...(b as unknown as Budget),
    v: 3,
    plan,
    pending: typeof b.pending === 'string' ? b.pending : '',
    firstTokens: typeof b.firstTokens === 'number' ? b.firstTokens : 0,
    mode: 'guard',
    estimate: b.estimate ?? null,
    phase: b.phase === 'landing' ? 'landing' : 'run',
    ask: b.ask ?? null,
    askedAt: typeof b.askedAt === 'number' ? b.askedAt : 0,
    waiting: typeof b.waiting === 'string' ? b.waiting : '',
    notes: Array.isArray(b.notes) ? b.notes : [],
    todos: Array.isArray(b.todos) ? b.todos : [],
    used: b.used && typeof b.used === 'object' ? b.used : {},
    lastAt: typeof b.lastAt === 'number' ? b.lastAt : 0,
    lastModel: typeof b.lastModel === 'string' ? b.lastModel : '',
    startedAt: typeof b.startedAt === 'number' ? b.startedAt : 0,
  })
}

/** The questions 0.8.0 still asks. A budget that 0.7 saved can hold an older one. */
const ASKS = new Set(['early', 'small', 'near'])

/**
 * Added in 0.8.0. A budget that an older version saved can hold pace mode, notes for Claude, or a question that is gone.
 * Pace mode is gone, Claude gets no notes, and an old question is dropped.
 */
function clean(b: Budget): Budget {
  const isAskOk = !b.ask || ASKS.has(b.ask.kind)
  if (b.mode === 'guard' && b.notes.length === 0 && isAskOk) return b
  return { ...b, mode: 'guard', notes: [], ask: isAskOk ? b.ask : null }
}

export function newBudget(o: { limit: number; task: string; startCost: number; model: string; isFresh: boolean; id: string; now: number }): Budget {
  return {
    v: 3,
    id: o.id,
    limit: o.limit,
    startCost: o.startCost,
    ownSpend: 0,
    spent: 0,
    isPaused: false,
    isMidTurn: false,
    task: o.task,
    model: o.model,
    isFresh: o.isFresh,
    messages: 0,
    steps: 0,
    lastStep: 0,
    ctxTokens: 0,
    delta: 0,
    mainCost: 0,
    msgStart: 0,
    bars: [],
    helpers: {},
    seen: [],
    similar: null,
    plan: null,
    pending: '',
    firstTokens: 0,
    mode: 'guard',
    estimate: null,
    phase: 'run',
    ask: null,
    askedAt: 0,
    waiting: '',
    notes: [],
    todos: [],
    used: {},
    lastAt: 0,
    lastModel: '',
    startedAt: o.now,
    raised: 0,
  }
}

export function spentOf(b: Budget, sessionCost: number | undefined): number {
  return sessionCost === undefined ? b.ownSpend : Math.max(0, sessionCost - b.startCost)
}

export function share(b: Budget): number {
  return b.limit > 0 ? b.spent / b.limit : 1
}

/**
 * Added in 0.7.4. The one verdict of a task's cost. The badge, the colours, the graph marks, the band, the status line
 * and the finished summary all read it, so they always agree. Amounts are compared in whole cents, as `usd` shows them.
 */
export const VERDICT = { under: 0.9, far: 2, low: 0.7, almost: 0.9, likelyOver: 1.05 } as const
export type VerdictKey = 'stopped' | 'paused' | 'finishing' | 'overLimit' | 'almostOut' | 'runningLow' | 'likelyOver' | 'farOver' | 'pastSafe' | 'overEst' | 'atEst' | 'underEst' | 'onTrack' | 'noLimit'
export type Verdict = { key: VerdictKey; text: string; tint: string }

function cents(n: number): number {
  return Math.round(n * 100)
}

/** The verdict of an amount against an estimate and a limit, with no state of a running task. A finished task uses this. */
export function costVerdict(o: { spent: number; likely?: number; safe?: number; limit?: number | null; course?: number | null }): Verdict {
  const spent = cents(o.spent)
  const limit = o.limit && o.limit > 0 ? cents(o.limit) : 0
  if (limit) {
    if (spent > limit) return { key: 'overLimit', text: 'Over the limit', tint: BAD }
    if (spent >= limit * VERDICT.almost) return { key: 'almostOut', text: 'Almost out', tint: BAD }
    if (spent >= limit * VERDICT.low) return { key: 'runningLow', text: 'Running low', tint: WARN }
    if (o.course !== undefined && o.course !== null && o.course > o.limit! * VERDICT.likelyOver) return { key: 'likelyOver', text: 'Likely over the limit', tint: BAD }
  }
  const likely = o.likely && o.likely > 0 ? cents(o.likely) : 0
  if (likely) {
    if (spent > likely * VERDICT.far) return { key: 'farOver', text: 'Far over the estimate', tint: BAD }
    if (!limit && o.safe && o.safe > 0 && spent > cents(o.safe)) return { key: 'pastSafe', text: 'Past the safe budget', tint: BAD }
    if (spent > likely) return { key: 'overEst', text: 'Over the estimate', tint: WARN }
    if (spent >= likely * VERDICT.under) return { key: 'atEst', text: 'At the estimate', tint: GOOD }
    return { key: 'underEst', text: 'Under the estimate', tint: GOOD }
  }
  return limit ? { key: 'onTrack', text: 'On track', tint: GOOD } : { key: 'noLimit', text: 'No limit', tint: TRACK }
}

/** The verdict of a running budget: its state first (stopped, paused, finishing), then its cost. */
export function verdict(b: Budget): Verdict {
  if (b.isPaused) return { key: 'stopped', text: 'Stopped', tint: BAD }
  if (b.waiting) return { key: 'paused', text: 'Paused', tint: WARN }
  if (b.phase === 'landing') return { key: 'finishing', text: 'Finishing', tint: WARN }
  const f = b.isOpen ? null : forecast(b)
  const cost = b.firstCost ?? b.spent
  const v = costVerdict({ spent: cost, likely: b.estimate?.likely, safe: b.estimate?.safe, limit: b.isOpen ? null : b.limit, course: b.firstCost !== undefined ? null : f?.usd ?? null })
  // A limit the person took away, with no estimate to judge by: the warning colour says the first limit is gone.
  return v.key === 'noLimit' && b.isOpen && !b.isTrack ? { ...v, tint: WARN } : v
}

export function tone(b: Budget): string {
  return verdict(b).tint
}

export function label(b: Budget): string {
  return verdict(b).text
}

export function statusText(b: Budget): string {
  if (b.isPaused) return `Budget stopped: ${usd(b.spent)} / ${usd(b.limit)}`
  if (b.waiting) return `Budget paused: ${usd(b.spent)} / ${usd(b.limit)}`
  if (b.isTrack) return `Task cost ${usd(b.spent)}${b.estimate ? ` · estimate ${usd(b.estimate.likely)} · ${verdict(b).text.toLowerCase()}` : ''} · no limit`
  if (b.isOpen) return `Budget ${usd(b.spent)} spent · no limit (was ${usd(b.limit)})`
  return `Budget ${usd(b.spent)} / ${usd(b.limit)} · ${usd(b.limit - b.spent)} left`
}

// ---------- what one request costs ----------

/** The four token counts of one response, and the model that answered. */
export type Used = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function promptOf(u: Used): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

/** Dollars of one response. The engine's own cost count is used where it exists: this is for the parts it does not split. */
export function priceOf(u: Used, k = 1): number {
  const p = priceFor(u.model, promptOf(u), k)
  return (
    (u.input_tokens * p.in + u.cache_read_input_tokens * p.cr + u.cache_creation_input_tokens * p.w1 + u.output_tokens * p.out) / 1_000_000
  )
}

/** The size of the first request of a new chat, and how we know it. */
export type Fresh = { tokens: number; how: 'folder' | 'measured' | 'guess' }
/** `parts` (added after 0.8.0, fix 3): the engine's count of each part of the chat start (tools, skills, memory files...) when `tokens` was measured. */
export type Base = { n: number; tokens: number; parts?: Parts }
export type Calib = { n: number; idle: number; step: number }
/** Added after 0.8.0 (fix 3). Tokens by row of the engine's breakdown of the chat (the rows of /context), without the chat messages. */
export type Parts = Record<string, number>
/** Used only when the engine cannot measure the chat and no past chat is on file. */
export const FRESH_TOKENS = 183_000
/** Public copy: the chat start to guess before the engine can count it. The median of real chats on this model, from the starter. */
export function startGuess(model = ''): number {
  return (model ? STARTER.start?.[family(model)] : undefined) ?? STARTER.startAll ?? FRESH_TOKENS
}
const IDLE_RATIO = 2
const STEP_RATIO = 1.1

/**
 * Best: what the last chat in this folder really sent. Next: the engine's count now, times this person's ratio. Last: a fixed guess.
 * Changed after 0.8.0 (fix 3): with `parts`, the figure of the folder is dropped when the parts changed since that chat
 * (a connector, skill or file was turned off or on). Then the count now, times the ratio, is used.
 */
export function freshFrom(base: Record<string, Base>, calib: Calib, cwd: string, raw: number, at: 'idle' | 'step', parts?: Parts, model = ''): Fresh {
  const known = base[cwd]
  if (known && known.n > 0 && known.tokens > 0 && !partsChanged(known.parts, parts)) return { tokens: Math.max(known.tokens, raw), how: 'folder' }
  if (raw > 0) {
    const learned = calib.n > 0 ? calib[at] : 0
    const ratio = learned > 0 ? learned : at === 'idle' ? IDLE_RATIO : STEP_RATIO
    return { tokens: Math.round(raw * ratio), how: 'measured' }
  }
  return { tokens: startGuess(model), how: 'guess' }
}

/** Added after 0.8.0 (fix 3). A part changes only when it moves by more than this many tokens and this share. Memory files move a little in every chat. */
const PART_MIN = 2_000
const PART_SHARE = 0.15
/** Rows of the breakdown that are not part of the chat start. They grow with the chat. */
const NOT_START = /^(messages|free space|autocompact buffer)$/i

/** Added after 0.8.0 (fix 3). The parts of a breakdown: every row in use, and the tool schemas that load on demand. */
export function partsOf(rows: readonly { name: string; tokens: number; kind: string }[]): Parts {
  const out: Parts = {}
  for (const r of rows) {
    if ((r.kind !== 'used' && r.kind !== 'deferred') || NOT_START.test(r.name.trim()) || !(r.tokens > 0)) continue
    const key = `${r.kind === 'deferred' ? 'deferred: ' : ''}${r.name.trim()}`
    out[key] = (out[key] ?? 0) + Math.round(r.tokens)
  }
  return out
}

/** Added after 0.8.0 (fix 3). Whether the chat start changed: a part came or went, or a part moved by more than 2K tokens and 15%. No parts on one side: no change seen. */
export function partsChanged(old: Parts | undefined, now: Parts | undefined): boolean {
  if (!old || !now || Object.keys(old).length === 0 || Object.keys(now).length === 0) return false
  for (const key of new Set([...Object.keys(old), ...Object.keys(now)])) {
    const a = old[key] ?? 0
    const b = now[key] ?? 0
    if (a > 0 !== b > 0) return true
    if (Math.abs(a - b) > Math.max(PART_MIN, PART_SHARE * Math.max(a, b))) return true
  }
  return false
}

/**
 * Added after 0.8.0 (fix 3). The figure of a folder after a chat measured its start. The newest measure wins, so a
 * change shows in the next chat. Not settled (the first request only): the first request is a floor, so the old figure
 * stays when it is bigger, unless the parts changed.
 */
export function nextBase(old: Base | undefined, real: number, isSettled: boolean, parts?: Parts): Base {
  const keep = parts && Object.keys(parts).length > 0 ? { parts } : old?.parts ? { parts: old.parts } : {}
  if (isSettled) return { n: Math.max(1, old?.n ?? 0), tokens: Math.round(real), ...keep }
  const floor = old && old.tokens > 0 && !partsChanged(old.parts, parts) ? old.tokens : 0
  return { n: (old?.n ?? 0) + 1, tokens: Math.round(Math.max(floor, real)), ...keep }
}

/** Added after 0.8.0 (fix 3). The ratio of the real start to the engine's count, from the newest settled chat. Not a long average. */
export function nextCalib(c: Calib, real: number, idleRaw: number, stepRaw: number): Calib {
  const ratio = (raw: number, was: number) => (raw > 0 ? Math.min(4, Math.max(0.5, real / raw)) : was)
  return { n: c.n + 1, idle: ratio(idleRaw, c.idle), step: ratio(stepRaw, c.step) }
}

/** Added after 0.8.0 (fix 3). A cache write this big in the first requests of a new chat is the rest of the chat start. */
export const START_JUMP = 40_000
/** Added after 0.8.0 (fix 3). The chat start is settled at this request of the main chat, or at the big write. */
export const START_REQS = 4

/**
 * Added after 0.8.0 (fix 3). The chat start as it is billed. When `/budget` is the first message, the lists of tools,
 * skills and agents and the MCP instructions come later: one big cache write after the first answer. So the start is
 * the first request plus the first write of 40K tokens or more in the first 4 requests.
 */
export type StartTrack = { tokens: number; reqs: number; isJumped: boolean; isDone: boolean }
export function trackStart(t: StartTrack | null, u: Used): StartTrack {
  if (!t) return { tokens: promptOf(u), reqs: 1, isJumped: false, isDone: false }
  if (t.isDone) return t
  const reqs = t.reqs + 1
  const isJump = !t.isJumped && u.cache_creation_input_tokens >= START_JUMP
  return { tokens: isJump ? t.tokens + u.cache_creation_input_tokens : t.tokens, reqs, isJumped: t.isJumped || isJump, isDone: isJump || reqs >= START_REQS }
}

/** Added after 0.8.0 (fix 3). The measured start and the start in the estimate differ by more than this share: the estimate moves. */
export const START_DIFF = 0.1

/**
 * Added after 0.8.0 (fix 3). The estimate with the measured chat start in place of the guess. The work part stays as
 * it was. The first guess stays in `base.guess` for the panel. No question and no note: the numbers move quietly.
 */
export function shiftBase(e: NonNullable<Budget['estimate']>, real: { tokens: number; usd: number }): NonNullable<Budget['estimate']> {
  const was = e.base ?? { tokens: 0, usd: 0 }
  const d = real.usd - was.usd
  const move = (v: number) => round2(Math.max(real.usd, v + d))
  return {
    ...e,
    low: move(e.low),
    likely: move(e.likely),
    safe: Math.max(move(e.likely), nice(e.safe + d)),
    ...(e.usual ? { usual: [move(e.usual[0]), move(e.usual[1])] as [number, number] } : {}),
    base: { tokens: Math.round(real.tokens), usd: round2(real.usd), guess: was.guess ?? { tokens: was.tokens, usd: was.usd } },
  }
}

function whyFresh(f: Fresh): string {
  const k = `${Math.round(f.tokens / 1000)}K`
  if (f.how === 'folder') return `a new chat in this folder loads about ${k} tokens first, measured in your past chats here`
  if (f.how === 'measured') return `a new chat here loads about ${k} tokens of tools, skills and memory files first, measured now`
  return `a new chat loads about ${k} tokens of tools and skills first, a first guess until one chat is measured`
}

export type Est = { cost: number; why: string; later?: number; isCold: boolean }

/** How long the cache keeps the chat. One hour on a normal plan. The mod drops it to five minutes when it sees a cold request sooner. */
export const HOUR = 60 * 60 * 1000

/**
 * The cost of the next request to the main chat, and how we know it.
 * `ctx` is the engine's count of the chat when the budget has not measured one yet.
 */
export function nextCost(
  b: Budget | null,
  model: string,
  o: { ctx: number; now: number; k?: number; fresh?: Fresh | null; ttl?: number },
): Est {
  const k = o.k ?? 1
  if (o.fresh && !(b && b.ctxTokens > 0)) {
    const p = priceFor(model, o.fresh.tokens, k)
    const part = (2000 * p.w1 + 600 * p.out) / 1_000_000
    return {
      // Counted as all new, the dear case. When part of it is still in the cache it costs less.
      cost: (o.fresh.tokens * p.w1) / 1_000_000 + part,
      why: whyFresh(o.fresh),
      later: (o.fresh.tokens * p.cr) / 1_000_000 + part,
      isCold: true,
    }
  }
  const ctx = b && b.ctxTokens > 0 ? b.ctxTokens : o.ctx > 0 ? o.ctx : 60_000
  const p = priceFor(model, ctx, k)
  const part = b && b.delta > 0 ? b.delta : (2000 * p.w1 + 600 * p.out) / 1_000_000
  // The cache is gone after a long wait, and after a change of model: the whole chat is written again.
  const isIdle = Boolean(b && b.lastAt > 0 && o.now - b.lastAt > (o.ttl ?? HOUR))
  const isSwitch = Boolean(b && b.lastModel && family(b.lastModel) !== family(model))
  const isCold = isIdle || isSwitch
  return {
    cost: (ctx * (isCold ? p.w1 : p.cr)) / 1_000_000 + part,
    why: isIdle
      ? 'the chat sat still too long, so it is loaded again in full'
      : isSwitch
        ? 'the model changed, so the chat is loaded again in full'
        : 'the chat so far is read again on every request',
    isCold,
  }
}

/** How many more requests fit in what is left. */
export function fits(b: Budget, est: number, later?: number): number {
  if (est <= 0) return 0
  const left = b.limit - b.spent
  if (later && later > 0) return left < est ? 0 : 1 + Math.floor((left - est) / later)
  return Math.max(0, Math.floor(left / est))
}

/** The money kept back so Claude can always write a last message: two typical requests, inside 3% to 25% of the limit. */
export function reserveOf(limit: number, typical: number): number {
  return Math.min(0.25 * limit, Math.max(2 * typical, 0.03 * limit))
}

/** A response came back: count it. `sessionCost` is the engine's own total, when it has one. */
export function afterStep(b: Budget, u: Used | null, sessionCost: number | undefined, agentId: string | undefined, now: number, k = 1): Budget {
  const cost = u ? priceOf(u, k) : 0
  const ownSpend = b.ownSpend + cost
  const spent = sessionCost === undefined ? ownSpend : Math.max(0, sessionCost - b.startCost)
  const bars = b.bars.length > 0 ? [...b.bars.slice(0, -1), Math.max(0, spent - b.msgStart)] : b.bars
  if (agentId) {
    const fam = family(u?.model)
    const old = b.helpers[fam] ?? { agents: 0, cost: 0 }
    const isNew = !b.seen.includes(agentId)
    return {
      ...b,
      ownSpend,
      spent,
      bars,
      helpers: { ...b.helpers, [fam]: { agents: old.agents + (isNew ? 1 : 0), cost: old.cost + cost } },
      seen: isNew ? [...b.seen, agentId].slice(-300) : b.seen,
    }
  }
  if (!u) return { ...b, ownSpend, spent, bars }
  const p = priceFor(u.model, promptOf(u), k)
  const prompt = promptOf(u)
  // The part of this request that was new. A request that wrote most of the chat to the
  // cache (the first one, or a cold cache) is not typical, so it does not move the average.
  const fresh = (u.cache_creation_input_tokens * p.w1 + u.output_tokens * p.out) / 1_000_000
  const isCold = u.cache_creation_input_tokens > prompt / 2
  const delta = isCold ? b.delta : b.delta > 0 ? b.delta * 0.6 + fresh * 0.4 : fresh
  // The chat start: the first requests of the task that write most of the chat to the cache. That cost is fixed, it does not grow with the work.
  const side = (u.cache_creation_input_tokens * p.w1 + u.cache_read_input_tokens * p.cr + u.input_tokens * p.in) / 1_000_000
  // Changed after 0.8.0 (fix 3): the start is the first request, plus the one big late write of a new chat. When /budget
  // is the first message, the lists of tools and skills come after the first answer (a user's test chat: 73K, then 112K
  // more). 0.8.0 took the first 2 cold requests. In a new chat the first request counts even when it read the start
  // from the cache of an earlier chat.
  const write = u.cache_creation_input_tokens
  const was = b.load
  const isFirst = b.steps === 0 && (isCold || b.isFresh)
  const isJump = b.isFresh && !!was && !was.isSettled && !was.isJumped && b.steps > 0 && b.steps < START_REQS && write >= START_JUMP
  const load: Budget['load'] = isFirst
    ? { tokens: prompt, usd: side, ...(b.isFresh ? {} : { isSettled: true }) }
    : was && isJump
      ? { tokens: was.tokens + write, usd: was.usd + (write * p.w1) / 1_000_000, isJumped: true, isSettled: true }
      : was && !was.isSettled && b.steps + 1 >= START_REQS
        ? { ...was, isSettled: true }
        : was
  // Added after 0.8.0 (fix 3): the estimate had a guess of the start. When the measured start is more than 10% off,
  // the estimate moves by the difference, with no question. The first request is a floor, so it can only move it up.
  // The settled start can move it both ways.
  const e0 = b.estimate
  const off = (l: { tokens: number }) => (e0?.base && e0.base.tokens > 0 ? (l.tokens - e0.base.tokens) / e0.base.tokens : 0)
  const isSettle = !!load?.isSettled && !was?.isSettled
  const isShift = !!(e0?.base && load && (isSettle ? Math.abs(off(load)) > START_DIFF : isFirst && off(load) > START_DIFF))
  const estimate = e0 && load && isShift ? shiftBase(e0, load) : e0
  return {
    ...b,
    ...(load ? { load } : {}),
    ...(estimate ? { estimate } : {}),
    ownSpend,
    spent,
    bars,
    steps: b.steps + 1,
    lastStep: cost,
    ctxTokens: prompt + u.output_tokens,
    delta,
    mainCost: b.mainCost + cost,
    lastAt: now,
    lastModel: u.model,
  }
}

// ---------- the step plan ----------

export function stepsSpent(p: Plan): number {
  return p.steps.reduce((sum, st) => sum + st.spent, 0)
}

/** What the buffer has used: the spend since the plan that no step claimed. */
export function reserveSpent(b: Budget, p: Plan): number {
  return Math.max(0, b.spent - p.base - stepsSpent(p))
}

/** How much one press of - or + changes an amount. */
export function unit(b: Budget): number {
  if (b.limit >= 20) return 1
  return b.limit >= 4 ? 0.25 : 0.1
}

export function isOver(st: PlanStep): boolean {
  return st.spent > st.usd + 0.005
}

export function isPlanDone(p: Plan | null): boolean {
  return Boolean(p && p.status === 'approved' && p.steps.length > 0 && p.steps.every(st => st.state === 'done' || st.state === 'cut'))
}

/**
 * Put new spend on the step that is active.
 * `stuck` is the step that just went far past its amount (twice, and by a real sum), or -1. It is named once.
 */
export function charge(b: Budget, inc: number): { next: Budget; stuck: number } {
  const p = b.plan
  if (!p || !(inc > 0)) return { next: b, stuck: -1 }
  const at = p.steps.findIndex(st => st.state === 'active')
  const cur = p.steps[at]
  if (!cur) return { next: b, stuck: -1 }
  const spent = cur.spent + inc
  const isFar = spent >= 2 * cur.usd && spent - cur.usd >= Math.max(0.25, 0.05 * b.limit)
  // A plan from the estimate is a guide: a small model moves its steps, so a step that runs long asks nothing.
  const isFirst = isFar && !cur.isWarned && p.byTool !== false
  const steps = p.steps.map((st, i) => (i === at ? { ...st, spent, isWarned: st.isWarned || isFirst } : st))
  return { next: { ...b, plan: { ...p, steps } }, stuck: isFirst ? at : -1 }
}

export type EstRow = { name: string; done: string; usd: number; scout?: { items: number; total: number } }

/**
 * Turn the steps of an estimate into the plan of a budget. The rows keep their likely dollars.
 * What the budget has beyond them is one shared buffer. A task of one step gets no plan.
 */
export function planFromEstimate(rows: readonly EstRow[], left: number, base: number): Plan | null {
  if (rows.length < 2 || !(left > 0)) return null
  const total = rows.reduce((sum, r) => sum + r.usd, 0)
  // The steps never take more than 90% of the money: the buffer is what makes the plan hold.
  const k = total > left * 0.9 && total > 0 ? (left * 0.9) / total : 1
  const steps: PlanStep[] = rows.map(r => {
    const st: PlanStep = { name: r.name, usd: k < 1 ? floor2(r.usd * k) : round2(r.usd), spent: 0, state: 'pending', isWarned: false, check: 'open' }
    if (r.done) st.done = r.done
    if (r.scout) st.scout = r.scout
    return st
  })
  const reserve = round2(Math.max(0, left - steps.reduce((sum, st) => sum + st.usd, 0)))
  // The work starts in step 1, so the first spend lands there and not in the buffer.
  if (steps[0]) steps[0].state = 'active'
  return { status: 'approved', steps, reserve, base, isHeard: true, source: 'estimate', byTool: false }
}

/** How much a tool counts as the keeper of Claude's task list. The task list of the app wins over the list of another mod. */
export function listRank(name: string): number {
  return /(^|__)update_plan$|^TodoWrite$|^TaskCreate$|^TaskUpdate$/.test(name) ? 2 : 1
}

/**
 * Claude keeps its own task list: the plan in the panel follows it, so the chat and the panel show the same steps.
 * The steps have no planned dollars, only the real cost. A plan with dollar amounts from Claude stays as it is.
 */
export function planFromTodos(b: Budget, todos: readonly Todo[]): Budget {
  const p = b.plan
  if (todos.length < 2) return b
  if (p && (p.byTool !== false || p.status !== 'approved')) return b
  const old = p && p.source === 'todos' ? p.steps : []
  const rows = todos.slice(0, 12)
  const hasNow = rows.some(t => t.status === 'in_progress')
  const firstOpen = rows.findIndex(t => t.status !== 'completed')
  const steps: PlanStep[] = rows.map((t, i) => {
    const was = old.find(st => st.name === t.text)
    // A step the small model already moved past stays done: the panel never moves back.
    const isKept = was?.state === 'done' && t.status !== 'completed'
    const state: PlanStep['state'] = t.status === 'completed' || isKept ? 'done' : t.status === 'in_progress' || (!hasNow && i === firstOpen) ? 'active' : 'pending'
    return { name: t.text, usd: 0, spent: was ? was.spent : 0, state, isWarned: true, check: 'open' }
  })
  // Only one step is active: the first one that is not done.
  const firstNotDone = steps.findIndex(st => st.state !== 'done')
  const fixed = steps.map((st, i) => (st.state === 'active' && i !== firstNotDone ? { ...st, state: 'pending' as const } : st))
  if (firstNotDone >= 0 && !fixed.some(st => st.state === 'active')) fixed[firstNotDone] = { ...fixed[firstNotDone]!, state: 'active' }
  const ticked = p && p.source === 'todos' ? p.ticked : undefined
  return { ...b, plan: { status: 'approved', steps: fixed, reserve: 0, base: p ? p.base : 0, isHeard: true, source: 'todos', byTool: false, ...(ticked ? { ticked } : {}) } }
}

/** Move a plan from the estimate to the step the work is in: the steps before it are done, the steps after it wait. It never moves back. */
export function atStep(b: Budget, step: number): Budget {
  const p = b.plan
  // Claude often does not update its own task list, so the small model's step moves that list forward too. It never moves back.
  if (!p || p.byTool !== false || p.status !== 'approved' || p.steps.length === 0 || !(step >= 1)) return b
  const now = p.steps.findIndex(st => st.state === 'active')
  const to = Math.max(now, Math.min(p.steps.length, Math.round(step)) - 1)
  if (to === now) return b
  const marked = p.source === 'todos' ? p.steps.filter((st, i) => i < to && st.state !== 'done' && st.state !== 'cut').length : 0
  const steps = p.steps.map((st, i) => (st.state === 'cut' ? st : { ...st, state: i < to ? ('done' as const) : i === to ? ('active' as const) : st.state === 'done' ? ('done' as const) : ('pending' as const) }))
  return { ...b, plan: { ...p, steps, ...(marked > 0 ? { ticked: (p.ticked ?? 0) + marked } : {}) } }
}

/** The task is done: every step of a plan from the estimate is done. */
export function donePlan(p: Plan | null): Plan | null {
  if (!p || p.byTool !== false) return p
  const marked = p.source === 'todos' ? p.steps.filter(st => st.state !== 'done' && st.state !== 'cut').length : 0
  return { ...p, steps: p.steps.map(st => (st.state === 'cut' ? st : { ...st, state: 'done' as const })), ...(marked > 0 ? { ticked: (p.ticked ?? 0) + marked } : {}) }
}

/** One tool call in a few words: the tool and the start of what it was asked to do. */
export function callLine(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  let arg = ''
  for (const key of ['command', 'description', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill', 'subject']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) {
      arg = v.trim().replace(/\s+/g, ' ')
      break
    }
  }
  const short = name.replace(/^mcp__/, '').slice(0, 48)
  return arg ? `${short}: ${arg.slice(0, 110)}` : short
}

/**
 * A scout step is done: it did a few items of bulk work, so the cost of one item is now measured.
 * The steps that are left get the measured price when they did not have a real one yet.
 */
export function repriceAfterScout(b: Budget, at: number): { next: Budget; perItem: number; rest: number } | null {
  const p = b.plan
  const st = p?.steps[at]
  if (!p || !st || !st.scout || !(st.spent > 0) || st.scout.items <= 0) return null
  const perItem = st.spent / st.scout.items
  const left = Math.max(0, st.scout.total - st.scout.items)
  const rest = perItem * left
  const pending = p.steps.filter((x, i) => i > at && x.state === 'pending')
  const old = pending.reduce((sum, x) => sum + x.usd, 0)
  if (pending.length === 0 || !(old > 0) || !(rest > 0)) return { next: b, perItem, rest }
  const k = rest / old
  const steps = p.steps.map((x, i) => (i > at && x.state === 'pending' ? { ...x, usd: round2(x.usd * k) } : x))
  // The limit does not move: the buffer takes the difference, and the forecast says if it is not enough.
  const reserve = round2(b.limit - p.base - steps.reduce((sum, x) => sum + x.usd, 0))
  return { next: { ...b, plan: { ...p, steps, reserve: Math.max(0, reserve) } }, perItem, rest }
}

// ---------- Claude's own task list ----------

const STATES = new Set(['pending', 'in_progress', 'completed'])

function rowsOf(list: unknown): Todo[] | null {
  if (!Array.isArray(list) || list.length === 0) return null
  const out: Todo[] = []
  for (const item of list as unknown[]) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const status = typeof o.status === 'string' ? o.status : ''
    const text = [o.content, o.text, o.subject, o.title, o.name].find(v => typeof v === 'string' && v.trim().length > 0)
    if (!STATES.has(status) || typeof text !== 'string') return null
    out.push({ text: text.slice(0, 80), status: status as Todo['status'] })
  }
  return out.slice(0, 40)
}

/**
 * Claude's task list after one tool call, or null when the call is not about a task list.
 * It reads any tool that sends a whole list of items with a status, and the short forms that move one item.
 */
export function todosFrom(name: string, input: unknown, old: readonly Todo[]): Todo[] | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const key of ['todos', 'items', 'steps', 'tasks']) {
    const rows = rowsOf(o[key])
    if (rows) return rows
  }
  if (old.length === 0) {
    if (name === 'TaskCreate' && typeof o.subject === 'string') return [{ text: o.subject.slice(0, 80), status: 'pending' }]
    return null
  }
  const next = old.map(t => ({ ...t }))
  const firstOf = (status: Todo['status']): Todo | undefined => next.find(t => t.status === status)
  if (o.advance === true) {
    const cur = firstOf('in_progress')
    if (cur) cur.status = 'completed'
    const then = firstOf('pending')
    if (then) then.status = 'in_progress'
    return next
  }
  if (Array.isArray(o.done) || typeof o.start === 'number') {
    for (const n of Array.isArray(o.done) ? (o.done as unknown[]) : []) {
      const t = next[Number(n) - 1]
      if (t) t.status = 'completed'
    }
    const t = typeof o.start === 'number' ? next[o.start - 1] : undefined
    if (t) t.status = 'in_progress'
    return next
  }
  if (name === 'TaskCreate' && typeof o.subject === 'string') return [...next, { text: o.subject.slice(0, 80), status: 'pending' as const }].slice(0, 40)
  if (name === 'TaskUpdate' && typeof o.status === 'string' && STATES.has(o.status)) {
    const t = next[Number(o.taskId) - 1]
    if (!t) return null
    t.status = o.status as Todo['status']
    return next
  }
  return null
}

/** Add the tool calls of one response to the count of real work. */
export function countTools(used: Units, names: readonly string[]): Units {
  if (names.length === 0) return used
  const next: Units = { ...used }
  for (const name of names) {
    const c = cat(name)
    next[c] = (next[c] ?? 0) + 1
  }
  return next
}

// ---------- the forecast ----------

/** `left` (0.7.0): a small model read the chat and said what share of the work is done. */
export type Forecast = { usd: number; basis: 'plan' | 'todos' | 'left' | 'estimate' }

/** The spend marks at which the small model reads the chat, as shares of the reference amount, and how many reads a task gets. */
export const CHECK_MARKS = [0.3, 0.6, 0.9, 1.5] as const

/**
 * The amount the spend marks are shares of. Changed in 0.8.0: the likely cost when it is under the limit.
 * With the limit, a $38 limit on a $6.90 task read the chat first at $11.40, which was too late.
 */
export function checkRef(b: Budget): number {
  const likely = b.estimate?.likely
  if (b.isTrack || b.isOpen) return likely ?? b.limit
  return likely && likely > 0 ? Math.min(b.limit, likely) : b.limit
}

/** Whether the small model must read the chat now: the spend has passed the next mark. */
export function mustCheck(b: Budget): boolean {
  if (b.isPaused || b.phase !== 'run' || b.firstCost !== undefined) return false
  const mark = CHECK_MARKS[b.checks ?? 0]
  const ref = checkRef(b)
  return mark !== undefined && ref > 0 && b.spent >= mark * ref
}

/** How many times the small model may read the chat for one task. */
export const READ_MAX = 24

/**
 * Whether the small model must read the chat again: real money was spent since the last read.
 * One read costs about half a cent, so the gap keeps the reads under a few percent of the task.
 */
export function mustRead(b: Budget): boolean {
  if (b.isPaused || b.phase !== 'run' || b.firstCost !== undefined || !b.task) return false
  if ((b.checks ?? 0) >= READ_MAX) return false
  // Added in 0.8.0: a new step in Claude's task list is read at once.
  if (b.isStepNew) return true
  // Changed in 0.8.0: the gap is 4% of the likely cost, from 8 cents up to 25 cents.
  return b.spent - (b.readAt ?? 0) >= clamp(0.04 * checkRef(b), 0.08, READ_GAP_MAX)
}

/** Added in 0.8.0. The most spend between two reads of the chat. */
export const READ_GAP_MAX = 0.25

/** Added in 0.8.0. Where the steps of Claude's own task list stand: how many are done, and which one is active. */
export function stepMark(todos: readonly Todo[]): string {
  return `${todos.filter(t => t.status === 'completed').length}/${todos.findIndex(t => t.status === 'in_progress')}`
}

/** The step the small model named, from 1. Null when it named none. */
export function parseStep(text: string): number | null {
  const m = /"?step"?\s*[:=]\s*(\d{1,2})/i.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 ? n : null
}

/** The part of the spend that does not grow with the work: the chat start. */
export function fixedOf(b: Budget): number {
  return Math.max(0, Math.min(b.load?.usd ?? 0, b.spent))
}

/** Read the small model's answer about the work that is done: a share from 0 to 100. Null when it is not a number. */
export function parseLeft(text: string): number | null {
  const m = /"?done"?\s*[:=]\s*(\d+(?:\.\d+)?)/i.exec(text) ?? /\b(\d{1,3})\s*%/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n / 100 : null
}

/** Added in 0.8.0. The forecast adds this share to the cost of the work that is left, for mistakes and retries. */
export const LEFT_MARGIN = 0.15

/**
 * Added in 0.8.0. The cost of the whole task when `part` of the work is done (0 to 1). Null when it cannot say.
 * Forecast = spend so far + the cost of the work that is left, plus LEFT_MARGIN.
 * The work that is left is a blend of two numbers:
 *   from the estimate: (likely cost - chat start in the estimate) x (1 - part)
 *   from the real pace: (spend so far - chat start paid) / part x (1 - part)
 * The weight of the pace is `part`: early on the estimate leads, late in the task the real pace leads.
 * With no estimate for this task, only the pace counts, and a part under 10% says too little.
 */
export function courseAt(b: Budget, part: number): number | null {
  if (!(b.spent > 0) || !(part >= 0)) return null
  if (part >= 0.98) return b.spent
  const fixed = fixedOf(b)
  const work = Math.max(0, b.spent - fixed)
  const e = b.estimate && b.firstCost === undefined ? b.estimate : null
  let left: number
  if (e && e.likely > 0) {
    const estLeft = Math.max(0, e.likely - (e.base?.usd ?? fixed)) * (1 - part)
    // part x pace left = work x (1 - part): it stays small when the part is small.
    left = (1 - part) * estLeft + work * (1 - part)
  } else {
    if (!(part >= 0.1)) return null
    left = (work / part) * (1 - part)
  }
  return Math.min(b.spent + left * (1 + LEFT_MARGIN), Math.max(b.limit, b.spent) * 6)
}

/** Save what the small model said. Changed in 0.8.0: the course comes from courseAt. */
export function withLeft(b: Budget, part: number, step?: number): Budget {
  const n = step ? atStep(b, step) : b
  const usd = courseAt(n, part)
  if (usd === null) return n
  return { ...addPoint({ ...n, left: { part, at: n.spent, usd, ...(step ? { step } : {}) } }, part, n.spent) }
}

/** Added after 0.8.0. The most points one run keeps in its cost path. */
export const PATH_MAX = 24

/** Added after 0.8.0. One point of the cost path: the share done and the spend then. A point at the same share replaces the last one. */
export function addPoint(b: Budget, part: number, spend: number): Budget {
  if (!(part >= 0) || !(part <= 1) || !(spend >= 0)) return b
  const pt: [number, number] = [Math.round(part * 100) / 100, round2(spend)]
  const old = b.path ?? []
  const last = old[old.length - 1]
  const list = last && last[0] === pt[0] ? [...old.slice(0, -1), pt] : [...old, pt]
  return { ...b, path: list.length > PATH_MAX ? [list[0]!, ...list.slice(-(PATH_MAX - 1))] : list }
}

/** Added after 0.8.0. The spend when a step of Claude's task list starts: a step that is now in progress, and was not before. */
export function markStepStarts(b: Budget, before: readonly Todo[], after: readonly Todo[]): Budget {
  const at = [...(b.stepAt ?? [])]
  let isNew = false
  after.forEach((t, i) => {
    if (t.status !== 'pending' && before[i]?.status !== 'in_progress' && before[i]?.status !== 'completed' && at[i] === undefined) {
      at[i] = round2(b.spent)
      isNew = true
    }
  })
  return isNew ? { ...b, stepAt: Array.from(at, v => v ?? -1).slice(0, 30) } : b
}

/** Added after 0.8.0. The typical share of the work cost spent at a share done, from the type's path. (0, 0) and (1, 1) are the ends. */
export function typicalShare(tp: TypePath, part: number): number {
  const xs = [0, 0.25, 0.5, 0.75, 1]
  const ys = [0, tp.q[0], tp.q[1], tp.q[2], 1]
  if (part <= 0) return 0
  if (part >= 1) return 1
  for (let i = 1; i < xs.length; i++) {
    if (part <= xs[i]!) {
      const t = (part - xs[i - 1]!) / (xs[i]! - xs[i - 1]!)
      return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!)
    }
  }
  return 1
}

/** Added after 0.8.0. Full weight for the type's path after this many runs with a path. */
export const PATH_FULL = 5

/**
 * Added after 0.8.0. The forecast mixed with how tasks of this type spend. At X% done the whole task costs about
 * chat start + work so far / typical work share at X%. The weight is the runs with a path over PATH_FULL, at most 1.
 * Only from 25% done, or when the typical share is 10% or more: early on the share is too small to divide by.
 */
export function mixPath(b: Budget, usd: number, part: number, spend: number): number {
  const tp = b.typePath
  if (!tp || !(tp.n > 0)) return usd
  const share = typicalShare(tp, part)
  if (part >= 0.98 || !(part >= 0.25 || share >= 0.1) || !(share > 0.02)) return usd
  const fixed = Math.max(0, Math.min(b.load?.usd ?? 0, spend))
  const byPath = fixed + Math.max(0, spend - fixed) / share
  const w = Math.min(1, tp.n / PATH_FULL)
  const mixed = (1 - w) * usd + w * byPath
  return Math.min(Math.max(mixed, b.spent), Math.max(b.limit, b.spent) * 6)
}

/** Added after 0.8.0. The pause point of the task's type: 1, or a little more after false alarms. */
export function easeOf(b: Budget): number {
  const e = b.ease ?? 1
  return e >= 1 && e <= 1.3 ? e : 1
}

/** Added in 0.8.0. The share of Claude's own task list that is done: an active step counts half. Null with fewer than 3 steps. */
export function todoPart(todos: readonly Todo[]): number | null {
  if (todos.length < 3) return null
  return todos.reduce((sum, x) => sum + (x.status === 'completed' ? 1 : x.status === 'in_progress' ? 0.5 : 0), 0) / todos.length
}

/**
 * What the whole task will cost at the rate it runs. Null when nothing says how far the task is.
 * Added in 0.8.0 (subagent fixes): a subagent that Claude started beyond the count of the estimate adds its usual cost at once.
 */
export function forecast(b: Budget): Forecast | null {
  const f = baseForecast(b)
  const extra = extraAhead(b)
  if (!(extra > 0)) return f
  if (f) return { ...f, usd: f.usd + extra }
  return b.spent > 0 ? { usd: b.spent + extra, basis: 'left' } : null
}

/** Added in 0.8.0 (subagent fixes). What the running subagents will still use: their usual cost less what each used so far. */
export function aheadOf(b: Budget): number {
  return round2((b.spawns ?? []).reduce((sum, x) => sum + (x.isRunning ? Math.max(0, x.usd - x.used) : 0), 0))
}

/** Added in 0.8.0 (subagent fixes). The same, only for the subagents beyond the count of the estimate. */
export function extraAhead(b: Budget): number {
  return (b.spawns ?? []).reduce((sum, x) => sum + (x.isRunning && x.isExtra ? Math.max(0, x.usd - x.used) : 0), 0)
}

/**
 * Added in 0.8.0 (subagent fixes). The model a subagent runs on while a /budget task is open.
 * The main chat's model when that is Sonnet or Haiku. Opus or Fable becomes Sonnet. Never Opus or Fable.
 * `route` is the model of the advice, when the person took it: the main chat then runs on it.
 */
export function agentModel(main: string | undefined, route?: string | null): 'sonnet' | 'haiku' {
  return family(route || main) === 'haiku' ? 'haiku' : 'sonnet'
}

/** Added in 0.8.0 (subagent fixes). The highest effort level a subagent runs at while a /budget task is open. */
export const AGENT_EFFORT = 'medium'
const EFFORT_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 }
/** Added in 0.8.0 (subagent fixes). A level above medium comes down to medium. A number is a budget of thinking: it becomes medium too. */
export function cappedEffort(effort: string | number | undefined): string | number | undefined {
  if (effort === undefined) return AGENT_EFFORT
  if (typeof effort === 'number') return AGENT_EFFORT
  return (EFFORT_RANK[effort] ?? 9) > EFFORT_RANK[AGENT_EFFORT]! ? AGENT_EFFORT : effort
}

/** Added in the subagent fixes. Opus and Fable: the models a subagent never runs on. */
export function isBigModel(m: string | undefined): boolean {
  const f = family(m)
  return f === 'opus' || f === 'fable'
}

/**
 * Added in the subagent fixes. The model a new subagent runs on, from what it asked for.
 * - Asked for Opus or Fable (by Claude or by another mod): Sonnet. A big ask means the task needs thought.
 * - Asked for nothing, from an Opus or Fable chat: 'judge', a small model sorts the task into Haiku or Sonnet.
 * - Asked for nothing from a Sonnet or Haiku chat, or asked for Sonnet or Haiku: null, nothing changes.
 */
export function spawnModel(asked: string | undefined, parent: string): 'sonnet' | 'judge' | null {
  if (asked && asked !== 'inherit') return isBigModel(asked) ? 'sonnet' : null
  return isBigModel(parent) ? 'judge' : null
}

/** Added in the subagent fixes. A subagent request, capped: never Opus or Fable, effort medium at most. Haiku with no effort set is left as it is. */
export function helperStep<E extends { model: string; effort?: string | number }>(e: E, pick: string): E {
  const model = isBigModel(e.model) ? pick : e.model
  const keep = family(model) === 'haiku' && e.effort === undefined
  return { ...e, ...(model !== e.model ? { model } : {}), ...(keep ? {} : { effort: cappedEffort(e.effort) }) }
}

/** Added in 0.8.0 (subagent fixes). The estimate grew by `by` dollars: every amount in it moves up by the same sum. */
export function shiftEstimate<E extends { low: number; likely: number; safe: number; usual?: [number, number] }>(e: E, by: number): E {
  if (!(by > 0)) return e
  return {
    ...e,
    low: round2(e.low + by),
    likely: round2(e.likely + by),
    safe: nice(e.safe + by),
    ...(e.usual ? { usual: [round2(e.usual[0] + by), round2(e.usual[1] + by)] as [number, number] } : {}),
  }
}

/** Added in 0.8.0 (subagent fixes). Whether a money question waits: right after an answer, until the spend rises by about 10% of the limit. */
export function isQuiet(b: Budget, spent = b.spent): boolean {
  return (b.quietTo ?? 0) > spent + 1e-9 && spent <= b.limit + 1e-9
}

/** The share of the limit the spend must rise after an answer before the next money question. */
export const QUIET = 0.1

function baseForecast(b: Budget): Forecast | null {
  const p = b.plan
  if (p && p.status === 'approved' && p.steps.length > 0 && p.byTool !== false) {
    const done = p.steps.filter(st => st.state === 'done')
    const planned = done.reduce((sum, st) => sum + st.usd, 0)
    const real = done.reduce((sum, st) => sum + st.spent, 0)
    const active = p.steps.find(st => st.state === 'active')
    // How the finished steps ran against their amounts sets the rate for the rest.
    let ratio = 1
    if (planned > 0.01) ratio = clamp(real / planned, 0.5, 4)
    else if (active && active.usd > 0 && active.spent > active.usd) ratio = clamp(active.spent / active.usd, 1, 4)
    let rest = 0
    for (const st of p.steps) {
      if (st.state === 'pending') rest += st.usd * ratio
      else if (st.state === 'active') rest += Math.max(0, st.usd * ratio - st.spent)
    }
    if (done.length > 0 || active) return { usd: b.spent + rest, basis: 'plan' }
  }
  // Changed in 0.8.0. The work done comes from Claude's own task list when Claude moved a step after the last read of the chat.
  // Else from the small model, which reads that list too: Claude often leaves the list as it was.
  // The read keeps the course it worked out (courseAt at that spend). Reads come at least every 25 cents of spend.
  const tp = todoPart(b.todos)
  const left = b.left && b.firstCost === undefined ? b.left : null
  const isListNewer = tp !== null && (b.todosAt ?? -1) > (left ? left.at : -1)
  // Added after 0.8.0: both mix in how tasks of this type spend, once the memory has paths for the type.
  if (left && !isListNewer) return { usd: Math.max(b.spent, mixPath(b, left.usd, left.part, left.at)), basis: 'left' }
  if (tp !== null && (tp >= 0.25 || (b.estimate && b.firstCost === undefined))) {
    const usd = courseAt(b, tp)
    if (usd !== null) return { usd: Math.max(b.spent, mixPath(b, usd, tp, b.spent)), basis: 'todos' }
  }
  // Only the estimate is known. It is for the first task: a later message is new work that the estimate did not count.
  if (b.estimate && b.firstCost === undefined) return { usd: courseOf(b.estimate, b.spent), basis: 'estimate' }
  return null
}

/** Added in 0.8.0. The early pause: half the limit is spent, and the task is on course for 1.2 times the limit or more. */
export const EARLY = 0.5
export const EARLY_OVER = 1.2

/** Added in 0.8.0. Whether the early pause is due. It holds Claude, and it comes one time in a task. It replaces the 20% question of 0.7. */
export function mustAskEarly(b: Budget, f: Forecast | null): boolean {
  if (!f || b.phase !== 'run' || b.isPaused || b.isOpen || b.isTrack) return false
  if (b.isEarlyAsked || b.nearAt === b.limit || b.ask || isQuiet(b)) return false
  if (b.spent < EARLY * b.limit) return false
  return f.usd >= b.limit * EARLY_OVER * easeOf(b) - 1e-9
}

/** Added in 0.8.0. The default limit is this many times the likely cost. the user set 1.5 on 2026-11-17. */
export const LIMIT_TIMES = 1.5

/** Added in 0.8.0. The floor and the ceiling of the learned multiple. Close history goes down to 1.15, wild history up to 3. */
export const TIMES_FLOOR = 1.15
export const TIMES_CEIL = 3
/** Added in 0.8.0. How many tasks the start value of 1.5 counts as. A few real tasks move it; one odd task does not. */
const TIMES_PRIOR = 3

/**
 * Added in 0.8.0. The multiple for the default limit, learned from the person's finished tasks.
 * It takes real cost over the likely cost that was shown. Most tasks should land under the limit, so it uses the 80th percent mark of those ratios, plus a margin of 10%.
 * It is kept between TIMES_FLOOR and TIMES_CEIL, and blended with 1.5 as if 1.5 were TIMES_PRIOR tasks.
 * The tasks are the same kind when there are 10 of that kind, else all kinds (ownRatios). With none, it is 1.5.
 */
export function learnedTimes(ratios: readonly number[]): { times: number; n: number } {
  const n = ratios.length
  if (n === 0) return { times: LIMIT_TIMES, n: 0 }
  const raw = clamp(quantile(ratios, 0.8) * 1.1, TIMES_FLOOR, TIMES_CEIL)
  const times = (TIMES_PRIOR * LIMIT_TIMES + n * raw) / (TIMES_PRIOR + n)
  return { times: Math.round(clamp(times, TIMES_FLOOR, TIMES_CEIL) * 100) / 100, n }
}

/** Added in 0.8.0. What one read of the chat by the small model and one advice call cost, about. Used until there is history. */
export const MOD_READ_USD = 0.005
export const MOD_PICK_USD = 0.006

/** Added in 0.8.0. Dollars to 4 places: the mod's own calls cost fractions of a cent. */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

/**
 * Added in 0.8.0. The predicted cost of the mod's own calls for a task.
 * From the person's past runs: the middle of this kind when it has 3, else of all runs when they have 3.
 * With no history: the estimate call, one advice call, and one read of the chat for each read gap of the likely cost (24 at most).
 */
export function modGuess(runs: readonly Run[], kind: string, likely: number, estCost: number): number {
  const all = runs.filter(r => typeof r.mod === 'number' && r.mod > 0)
  const same = all.filter(r => r.kind === kind)
  const list = (same.length >= 3 ? same : all.length >= 3 ? all : []).map(r => r.mod ?? 0)
  if (list.length > 0) return round4(quantile(list, 0.5))
  const gap = clamp(0.04 * likely, 0.08, READ_GAP_MAX)
  const reads = Math.min(READ_MAX, Math.ceil(Math.max(0, likely) / gap))
  return round4(Math.max(0, estCost) + MOD_PICK_USD + reads * MOD_READ_USD)
}

/** Added in 0.8.0. The default limit: the learned multiple (1.5 with no history) times the likely cost, rounded up. */
export function defaultLimit(e: { likely: number; times?: number; upTo?: number }): number {
  // Added in the subagent fixes (fix 13): a big task gets its limit from the high end, not from the middle.
  return nice(Math.max((e.times ?? LIMIT_TIMES) * e.likely, e.upTo ?? 0))
}

/** Added in 0.8.0. The model a hand off goes to: one step cheaper. Null on Haiku, which has none. */
export function handoffModel(model: string | undefined): 'sonnet' | 'haiku' | null {
  const fam = family(model)
  if (fam === 'opus' || fam === 'fable') return 'sonnet'
  if (fam === 'sonnet') return 'haiku'
  return null
}

const MODEL_WORD = { sonnet: 'Sonnet', haiku: 'Haiku' } as const

/** The share of the limit at which the mod pauses a task that is on course to pass the limit. */
export const NEAR = 0.8

/** Added in 0.7.0. Whether the 80% pause is due: 80% of the limit is spent, the task is on course to pass the limit, and it was not asked at this limit. */
export function mustAskNear(b: Budget, f: Forecast | null): boolean {
  if (!f || b.phase !== 'run' || b.isPaused || b.isOpen || b.isTrack) return false
  if (b.nearAt === b.limit || b.ask || isQuiet(b)) return false
  if (b.spent < NEAR * b.limit) return false
  return f.usd > b.limit * 1.05 * easeOf(b)
}

// ---------- the gate: must this request wait for the person? ----------

export type Why = { kind: 'paused' | 'hard' | 'cap' } | Ask

/**
 * Checked before every request. `est` is what this request costs, `typical` what a main chat request costs,
 * `inflight` what the requests that are out right now will cost.
 */
export function gateWhy(b: Budget, spent: number, inflight: number, est: number, typical: number, isHelper: boolean): Why | null {
  if (b.isPaused) return { kind: 'paused' }
  // The person chose Keep going: nothing waits now. The count runs on.
  if (b.isOpen) return null
  const need = spent + inflight + est
  // Finishing: the money that was kept back is now in use. Only the limit itself stops a request.
  if (b.phase === 'landing') return need > b.limit + 1e-9 ? { kind: 'hard' } : null
  // A request that would pass the limit always waits.
  if (need > b.limit + 1e-9) return { kind: 'cap' }
  // Added in the subagent fixes: the person just answered. No new soft question until the spend rises by about 10% of the limit.
  // The limit itself (above) still holds.
  if (isQuiet(b, spent)) return null
  // Changed in 0.8.0: the money kept back for the end stops a request only when the task is on course to pass the limit.
  // A task that finishes under the limit is never stopped.
  if (need > b.limit - reserveOf(b.limit, typical) + 1e-9) {
    const f = forecast({ ...b, spent })
    // Added after 0.8.0: a type with false alarms has a higher pause point. The limit above never moves.
    if (f && f.usd > b.limit * easeOf(b) + 1e-9) return { kind: 'cap' }
  }
  if (!isHelper && b.ask) return b.ask
  return null
}

export type Decision =
  | { act: 'add'; usd: number }
  | { act: 'set'; usd: number }
  | { act: 'go' }
  | { act: 'open' }
  | { act: 'handoff' }
  | { act: 'stop' }

export type Question = { text: string; options: string[]; header: string; short: string }

/** Only at the early pause (0.8.0): carry on. The limit stays, and the 80% pause can still come. */
export const KEEP = 'Keep going'
/** Added in 0.8.0. The pause buttons. The raise button carries its amount: "Raise the limit to $6.00". */
export const RAISE = 'Raise the limit'
export const HANDOFF = 'Hand off to a cheaper model'
export const STOP = 'Stop'
/** The panel button and /budget finish. In 0.8.0 it is not a pause button. */
export const LAND = 'Finish now'

/** Where the budget must go so the task can finish, and what that amount is. */
function goalOf(b: Budget, spent: number, f: Forecast | null): { usd: number; why: string } | null {
  if (!f) return null
  // Only the estimate is known: the amount that 3 of 4 tasks which got this far stay under.
  if (f.basis === 'estimate' && b.estimate) return { usd: courseOf(b.estimate, spent, 0.75), why: '3 of 4 tasks that got this far end under it.' }
  return { usd: f.usd, why: 'That is what this task is on course for.' }
}

/** How much to offer when the money runs out: one amount, enough for what the task is on course for. */
export function suggestAdd(b: Budget, est: number, f: Forecast | null, typical = est, spent = b.spent, ahead = aheadOf(b)): number {
  const goal = goalOf(b, spent, f)
  // The gate keeps money back for the last message, so that money goes on top of the goal.
  // Subagent fixes: with no goal, the running subagents come on top, so a new limit does not trip at once.
  const need = goal && goal.usd > b.limit ? goal.usd + reserveOf(goal.usd, typical) - b.limit : Math.max(b.limit * 0.5, est + 5 * typical) + Math.max(0, ahead)
  // A dear next request (a new chat, a cold cache) is paid one time. The requests after it cost `typical`.
  // Added in 0.8.0 (subagent fixes): the raise also covers the work in flight: the requests that are out and the running subagents.
  const least = Math.max(0, ahead) + est + typical + reserveOf(b.limit + need, typical)
  return nice(Math.max(need, least))
}

/** Added in 0.8.0. The limit the raise button sets. `ahead` is what the work in flight still uses. */
export function raiseTo(b: Budget, est: number, f: Forecast | null, typical = est, spent = b.spent, ahead = aheadOf(b)): number {
  return round2(b.limit + suggestAdd(b, est, f, typical, spent, ahead))
}

/**
 * The question the person sees when a request must wait.
 * Changed in 0.8.0: one short line with the main fact, then the buttons. The buttons say what they do.
 */
export function questionFor(why: Why, b: Budget, spent: number, est: number, f: Forecast | null, typical = est, ahead = aheadOf(b)): Question {
  const of = `${usd(spent)} of ${usd(b.limit)}`
  if (why.kind === 'small') {
    const e = b.estimate
    // Raise goes to the default limit of the estimate (0.8.0), never under two times the limit when there is no estimate.
    const to = e ? Math.max(defaultLimit(e), nice(e.likely)) : nice(b.limit * 2)
    return {
      header: 'Budget',
      short: 'the limit is under the estimate',
      text: `Likely ${usd(e?.likely ?? 0)}, over your ${usd(b.limit)} limit. What now?`,
      options: [`${RAISE} to ${usd(to)}`, `Keep ${usd(b.limit)}`, STOP],
    }
  }
  const to = raiseTo(b, est, f, typical, spent, ahead)
  const buttons = [`${RAISE} to ${usd(to)}`, ...(handoffModel(b.lastModel || b.model) ? [HANDOFF] : []), STOP]
  const pct = Math.round((spent / Math.max(0.01, b.limit)) * 100)
  const course = f?.usd ?? b.limit
  if (why.kind === 'early' || why.kind === 'near') {
    return {
      header: 'Budget',
      short: `${pct}% spent, on course for about ${usd(course)}`,
      text: `${pct}% spent. On course for ${usd(course)}, over your ${usd(b.limit)} limit. What now?`,
      options: why.kind === 'early' ? [KEEP, ...buttons] : buttons,
    }
  }
  return {
    header: 'Budget',
    short: `${of} spent`,
    text: `${of} spent. The next request costs about ${usd(est)}. What now?`,
    options: buttons,
  }
}

/** The first dollar amount in a text, or 0. */
export function amountIn(text: string): number {
  const m = /\$?\s*(\d+(?:[.,]\d+)?)/.exec(text)
  if (!m) return 0
  const n = Number((m[1] ?? '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** What the person's answer means. Text typed under Other is read for a dollar amount and a few plain words. */
export function decide(why: Why, answer: string, b: Budget): Decision {
  const a = answer.trim()
  const low = a.toLowerCase()
  const isMoney = why.kind === 'cap' || why.kind === 'hard' || why.kind === 'near'
  if (a === STOP || /^(stop|end|cancel|no|finish)\b/.test(low)) return { act: 'stop' }
  if (a === HANDOFF || /hand ?off|cheap|sonnet|haiku/.test(low)) return handoffModel(b.lastModel || b.model) ? { act: 'handoff' } : { act: 'stop' }
  // The early pause: carry on with the limit. A money pause has no such button: typed words to keep going take the limit away.
  if (a === KEEP || /^(keep|go on|continue|carry on)\b/.test(low)) return isMoney ? { act: 'open' } : { act: 'go' }
  if (!isMoney && /^yes\b/.test(low)) return { act: 'go' }
  const n = amountIn(a)
  if (n > 0) {
    if (/^(raise|set)\b/.test(low)) return n > b.limit ? { act: 'set', usd: n } : { act: 'go' }
    if (/^add\b/.test(low)) return { act: 'add', usd: n }
    // A bare number above the limit is the new limit. Under it, it is what to add.
    return n > b.limit ? { act: 'set', usd: n } : { act: 'add', usd: n }
  }
  // Words the mod cannot read: the money pause stops, the other questions carry on.
  return isMoney || why.kind === 'early' ? { act: 'stop' } : { act: 'go' }
}

// ---------- what Claude reads ----------
// Changed in 0.8.0: no note, no tool and no amount. Only the texts below can reach Claude, and none of them names a budget.

export const LAND_DENY =
  'The user chose to finish this task now, so this tool call did not run. Do not call more tools. ' +
  'Write your final answer now: what is done, what is not done, and where each file or result is.'

export const HELPER_WRAP = 'You have done more than a helper of this kind usually does. Finish with what you have and write your report now.'

export const HELPER_DENY =
  'This helper has used far more than a helper of this kind does, so this tool call did not run. Do not call more tools. Write your report now with what you have, and say what is missing.'

export const HELPER_STOP = 'This helper was stopped: it did more than twice what a helper of this kind usually does. Its work so far is in the chat above. Give it a smaller job, or do this part in the main chat.'

/** Added in 0.8.0 (subagent fixes). A subagent tool call after Stop. */
export const AGENT_STOP_DENY = 'The user stopped this task. Do not call more tools. Write your report now.'
/** Added in 0.8.0 (subagent fixes). A new subagent after Stop or Finish now. */
export const SPAWN_STOP_DENY = 'The user stopped this task. Do not start more subagents. Write your report now.'
/** Added in 0.8.0 (subagent fixes). A fork cannot change its model: on an Opus or Fable chat it is refused. */
export const FORK_DENY = 'Forks are off in this chat. Start a normal subagent.'

/** Added in 0.8.0. What the chat shows, and Claude reads later, when the person chose Stop. */
export const STOPPED = 'Stopped here by the user. No work was lost.'
/** Added in 0.8.0. The same, after a hand off. */
export const HANDED_OFF = 'Stopped here by the user: the work moves to a new chat. No work was lost.'

// ---------- starting a budget in a normal message ----------

export type Inline = { limit: number; isForced: boolean; task: string }

/** The ways to start a budget inside a normal message. */
export function parseInline(text: string): Inline | null {
  const t = text.trim()
  const front =
    t.match(/^\/budget\s+\$?(\d+(?:\.\d+)?)(!?)(?:\s+|$)(.*)$/is) ??
    t.match(/^budget\s+\$(\d+(?:\.\d+)?)(!?)\s*[:,]?\s*(.*)$/is) ??
    t.match(/^budget\s+(\d+(?:\.\d+)?)(!?)\s*:\s*(.*)$/is)
  if (front) {
    const limit = Number(front[1])
    if (!(limit > 0)) return null
    return { limit, isForced: front[2] === '!', task: (front[3] ?? '').trim() }
  }
  const back = t.match(/^\$(\d+(?:\.\d+)?)(!?)\s+budget\b\s*[:,]?\s*(.*)$/is)
  if (!back) return null
  const limit = Number(back[1])
  if (!(limit > 0)) return null
  return { limit, isForced: back[2] === '!', task: (back[3] ?? '').trim() }
}

const BRIEF_START = /^\s*(<system-reminder>|Background \(from the session that started this one\):)/
const BRIEF_TASK = '\nTask:\n'

/**
 * The budget command in a message, and the text in front of it that stays.
 * A session that another session started gets its task after a status note and a background, under the line "Task:".
 * A budget command at the start of that task counts, so a side session can carry a budget.
 */
export function inlineIn(text: string): { inline: Inline; head: string } | null {
  const direct = parseInline(text)
  if (direct) return { inline: direct, head: '' }
  if (!BRIEF_START.test(text)) return null
  let at = text.indexOf(BRIEF_TASK)
  while (at >= 0) {
    const head = text.slice(0, at + BRIEF_TASK.length)
    const inline = parseInline(text.slice(head.length))
    if (inline) return { inline, head }
    at = text.indexOf(BRIEF_TASK, at + 1)
  }
  return null
}

/** Words after "/budget" that are its own commands, not a task. */
const BUDGET_WORDS = /^(panel|open|off|end|done|approve|guard|pace|learn|prices|report|finish|keep|no limit|add|set|estimate|plan|try|status|help)\b/i

export type BudgetCall = { task: string; limit?: number; isForced: boolean }

/**
 * "/budget" typed where the app did not take it as a command: at the end of a message
 * ("summarize my Slack messages /budget", "... /budget 5", "... /budget 5!"), or at the start
 * before the command was in the app's list ("/budget summarize my Slack messages", the first message of a chat).
 * Null for anything else: "/budget" inside a sentence, a short task, a word of the command, or a side session's brief.
 */
export function budgetCall(text: string): BudgetCall | null {
  if (BRIEF_START.test(text)) return null
  const t = text.trim()
  const tail = t.match(/^([\s\S]*\S)\s+\/budget(?:\s+\$?(\d+(?:\.\d+)?)(!?))?$/i)
  const front = tail ? null : t.match(/^\/budget\s+(?!\$?\d)([\s\S]+)$/i)
  const task = (tail?.[1] ?? front?.[1] ?? '').trim()
  if (task.length < 8 || /^\/budget\b/i.test(task)) return null
  if (front && BUDGET_WORDS.test(task)) return null
  const limit = tail?.[2] ? Number(tail[2]) : undefined
  if (limit !== undefined && !(limit > 0)) return null
  return limit === undefined ? { task, isForced: false } : { task, limit, isForced: tail?.[3] === '!' }
}

/** A test mark in a task: `[tb-test:name]`. The gate then takes its answers from a file. */
export function testToken(text: string): { token: string; text: string } {
  const m = /\s*\[tb-test:([a-z0-9_-]{1,40})\]\s*/i.exec(text)
  if (!m) return { token: '', text }
  return { token: m[1] ?? '', text: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).trim() }
}

/**
 * A test run: "/budget try [amount] <task> [tb-test:name]" as a message, or at the start of the task of a side session.
 * It takes the estimate-first path of the slash command, so a test can reach the questions with no person.
 * Without the test mark, or with "!" or "plan", this is null and the message goes its normal way.
 */
export function testInline(text: string): { limit?: number; task: string } | null {
  const bodies = [text]
  if (BRIEF_START.test(text)) {
    let at = text.indexOf(BRIEF_TASK)
    while (at >= 0) {
      bodies.push(text.slice(at + BRIEF_TASK.length))
      at = text.indexOf(BRIEF_TASK, at + 1)
    }
  }
  for (const body of bodies) {
    const m = body.trim().match(/^\/budget\s+try\s+(?:\$?(\d+(?:\.\d+)?)\s+)?(.+)$/is)
    if (!m) continue
    const task = (m[2] ?? '').trim()
    if (/^(plan\b|\$?\d+(?:\.\d+)?!)/i.test(task)) continue
    const mark = testToken(task)
    if (!mark.token || mark.text.length < 8) continue
    const limit = m[1] ? Number(m[1]) : undefined
    if (limit !== undefined && !(limit > 0)) continue
    return limit === undefined ? { task } : { limit, task }
  }
  return null
}

// ---------- the history: runs, and how far estimates were from the truth ----------

/** Per kind of task, and under `all`: real cost over estimate, and how many finished budgets it comes from. */
export type Tune = Record<string, { n: number; ratio: number }>

/** Real tool calls that count as work, as one number. */
function callsOf(u: Units): number {
  let n = 0
  for (const [c, v] of Object.entries(u)) if (c !== 'meta' && c !== 'other' && c !== 'agent') n += v ?? 0
  return n
}

/**
 * Added in 0.7.0. Why the real cost was far from the estimate. Null for a hit: a real cost inside 2 times.
 * It compares the work that was counted before the start with the work that was done.
 */
export function missWhy(b: Budget, cost: number): string | null {
  const e = b.estimate
  if (!e || !(e.likely > 0) || !(cost > 0)) return null
  const r = cost / e.likely
  if (r >= 0.5 && r <= 2) return null
  if (r < 0.5) return 'fewer steps'
  const helpers = Object.values(b.helpers).reduce((sum, h) => sum + h.agents, 0)
  if (helpers > e.helpers) return 'helpers'
  if ((b.used.web ?? 0) > (e.units.web ?? 0) * 1.5 + 2) return 'search'
  if (callsOf(b.used) > callsOf(e.units) * 1.5 + 2) return 'more steps'
  return 'more thinking'
}

export function runOf(b: Budget, outcome: Run['outcome'], at: string): Run {
  const run: Run = {
    id: b.id,
    at,
    task: b.task.slice(0, 200),
    limit: b.limit,
    spent: round2(b.spent),
    messages: b.messages,
    model: b.route ? family(b.route.model) : family(b.model),
    outcome,
    ...((b.modCost ?? 0) > 0 ? { mod: round4(b.modCost ?? 0) } : {}),
    session: round2(b.startCost + b.spent),
    mode: b.mode,
  }
  if (b.estimate) {
    run.kind = b.estimate.kind
    run.estimate = { low: b.estimate.low, likely: b.estimate.likely, safe: b.estimate.safe }
    if (b.estimate.usual) run.estimate.usual = b.estimate.usual
    if (b.estimate.hold) run.estimate.hold = b.estimate.hold
    if (b.estimate.base) run.estimate.base = b.estimate.base
    if (b.estimate.upTo) run.estimate.upTo = b.estimate.upTo
    const why = missWhy(b, b.firstCost ?? b.spent)
    if (why) run.why = why
  }
  const effort = b.route?.effort ?? b.effort
  if (effort) run.effort = effort
  if (b.skill) run.skill = b.skill
  if (b.isTrack) run.isTrack = true
  const ms = Date.parse(at) - b.startedAt
  if (b.startedAt > 0 && Number.isFinite(ms) && ms > 0) run.secs = Math.round(ms / 1000)
  if (b.firstCost !== undefined) run.first = b.firstCost
  if (b.isOpen) run.isOpen = true
  const p = b.plan
  if (p && p.ticked) run.ticked = p.ticked
  if (p && p.steps.length > 0) {
    run.steps = p.steps.map((st): RunStep => ({
      name: st.name,
      usd: st.usd,
      spent: round2(st.spent),
      check: st.state === 'cut' ? 'skipped' : st.state !== 'done' ? 'not done' : (st.check ?? 'open'),
    }))
  }
  const parts = moneyParts(b)
  if (parts.length > 0) run.parts = parts
  if (b.load && b.load.tokens > 0) run.loadTokens = b.load.tokens
  // Added in 0.8.0 (subagent fixes): how many subagents ran and on which model, and every question the mod asked.
  const spawns = b.spawns ?? []
  // Every run from now on says how many, 0 too, so the count learns from tasks with none as well.
  run.agents = spawns.length
  if (spawns.length > 0) run.agentModel = spawns[spawns.length - 1]!.model
  if (b.asks && b.asks.length > 0) run.asks = b.asks.slice(-30)
  // Added after 0.8.0: the cost path ends at the whole spend, done.
  if (b.path && b.path.length > 0) run.path = [...b.path, [1, round2(b.spent)]]
  if (b.stepAt && b.stepAt.length > 0) run.stepAt = b.stepAt
  run.start = round2(fixedOf(b))
  return run
}

/**
 * Where the money of a budget went: the chat start is paid before any work, so it has its own part. Parts under one cent are left out.
 * The parts are the mod's own price of each request. The total is the app's bill, and the bill wins: when the parts add up to more
 * (the mod prices a cache write at the one-hour rate, and the app often pays the five-minute rate), they are scaled down to the bill.
 * When the bill is higher, the rest is its own part: other calls in this chat, such as the small models of mods.
 */
export function moneyParts(b: Budget): { name: string; usd: number }[] {
  const loadUsd = Math.max(0, Math.min(b.load?.usd ?? 0, b.mainCost))
  const all = [
    { name: b.isFresh ? 'Chat start' : 'Chat read again', usd: loadUsd },
    { name: 'Work', usd: Math.max(0, b.mainCost - loadUsd) },
    ...Object.entries(b.helpers)
      .filter(([, st]) => st.agents > 0)
      .map(([fam, st]) => ({ name: `${fam[0]?.toUpperCase() ?? ''}${fam.slice(1)} helpers`, usd: st.cost })),
    // Added in 0.8.0: the mod's own calls have their own part, so they are not counted as other calls.
    { name: 'This mod', usd: b.modCost ?? 0 },
  ]
  const sum = all.reduce((s, x) => s + x.usd, 0)
  const bill = b.spent
  const scaled = sum > bill + 0.005 && sum > 0 ? all.map(x => ({ ...x, usd: (x.usd * bill) / sum })) : all
  const rest = bill - Math.min(sum, bill)
  if (sum > 0 && rest >= 0.01) scaled.push({ name: 'Other calls', usd: rest })
  return scaled.filter(x => x.usd >= 0.01).map(x => ({ name: x.name, usd: round2(x.usd) }))
}

/** How a budget that the person closed ended: under when the first limit held, over when money was added or the limit was taken away. */
export function closeOutcome(b: Budget): Run['outcome'] {
  // A task with no limit from the start passed no limit.
  if (b.isTrack) return 'under'
  return (b.raised ?? 0) > 0.005 || b.isOpen ? 'over' : 'under'
}

/**
 * What the task that the estimate was made for really cost. The estimate is for the first task of a budget.
 * Known when Claude gave its answer to that task, or when the budget closed after one message. Else null.
 */
export function taskCost(run: Run): number | null {
  if (run.first !== undefined) return run.first > 0 ? run.first : null
  const isClosed = run.outcome === 'under' || run.outcome === 'over'
  return isClosed && run.messages <= 1 && run.spent > 0 ? run.spent : null
}

/** A finished task with an estimate moves the ratio a part of the way to what really happened. The same object comes back when nothing is learned. */
export function learnTune(tune: Tune, run: Run): Tune {
  if (!run.estimate || !(run.estimate.likely > 0)) return tune
  // A task that was cut short says little: only a task that ran to its answer counts.
  const cost = taskCost(run)
  if (cost === null) return tune
  const r = clamp(cost / run.estimate.likely, 0.33, 3)
  const next: Tune = { ...tune }
  for (const key of ['all', run.kind ?? '', tuneKey(run.kind ?? '', run.model, run.effort)]) {
    if (!key) continue
    const old = tune[key] ?? { n: 0, ratio: START_RATIO }
    next[key] = { n: old.n + 1, ratio: Math.round(clamp(old.ratio * r ** 0.35, 0.5, 3) * 1000) / 1000 }
  }
  return next
}

/** Added in 0.7.0. The key for one kind of task on one model at one effort level. Empty when a part is not known. */
export function tuneKey(kind: string, model: string | undefined, effort: string | undefined): string {
  return kind && model && effort ? `${kind}|${family(model)}|${effort}` : ''
}

/** The ratio for a new estimate: this kind on this model and effort level when it has runs, else this kind, else all tasks, else the start value. */
export function tuneFor(tune: Tune, kind: string, model?: string, effort?: string): { ratio: number; n: number } {
  const exact = tune[tuneKey(kind, model, effort)]
  if (exact && exact.n >= 3) return exact
  const own = tune[kind]
  if (own && own.n >= 3) return own
  const all = tune.all
  if (all && all.n >= 1) return all
  return { ratio: START_RATIO, n: 0 }
}

/** How good the estimates were, over the tasks that had one and ran to their answer. */
export function scoreOf(runs: readonly Run[]): BookView['score'] {
  const done: { cost: number; e: NonNullable<Run['estimate']> }[] = []
  for (const r of runs) {
    const cost = taskCost(r)
    if (r.estimate && r.estimate.likely > 0 && cost !== null) done.push({ cost, e: r.estimate })
  }
  if (done.length === 0) return null
  const ratios = done.map(d => d.cost / d.e.likely).sort((a, b) => a - b)
  const inRange = done.filter(d => d.cost >= d.e.low * 0.999 && d.cost <= d.e.safe * 1.001).length
  // The runs are kept oldest first, so the end of the list is the newest work.
  const last = done.slice(-20)
  const in2 = last.filter(d => isHit(d.cost, d.e.likely)).length
  return { n: done.length, ratio: Math.round((ratios[Math.floor(ratios.length / 2)] ?? 1) * 100) / 100, inRange, last: last.length, in2 }
}

/** Added in 0.7.0. A hit: the real cost is inside 2 times of the estimate. */
export function isHit(cost: number, likely: number): boolean {
  return likely > 0 && cost >= likely / 2 - 1e-9 && cost <= likely * 2 + 1e-9
}

/** "Your last 20 estimates: 14 inside 2 times." Empty when no task with an estimate has finished. */
export function hitLine(score: BookView['score']): string {
  if (!score || !score.last) return ''
  return `Your last ${score.last} estimate${score.last === 1 ? '' : 's'}: ${score.in2 ?? 0} inside 2 times.`
}

/** The last finished tasks that had an estimate, newest first. */
export function recentOf(runs: readonly Run[], n = 3): Run[] {
  const out: Run[] = []
  for (let i = runs.length - 1; i >= 0 && out.length < n; i--) {
    const r = runs[i]
    if (r && r.estimate && r.estimate.likely > 0 && taskCost(r) !== null) out.push(r)
  }
  return out
}

/**
 * Real cost over estimate for the person's own finished tasks: this kind when it has 10, else every kind.
 * The estimator makes the own range from it.
 */
export function ownRatios(runs: readonly Run[], kind: string): number[] {
  const all: number[] = []
  const same: number[] = []
  for (const r of runs) {
    const cost = taskCost(r)
    if (!r.estimate || !(r.estimate.likely > 0) || cost === null) continue
    const ratio = cost / r.estimate.likely
    all.push(ratio)
    if (r.kind === kind) same.push(ratio)
  }
  return same.length >= 10 ? same : all
}

export function viewOf(book: Book | null, state: BookView['state'], note: string, score: BookView['score'], recent: Run[] = []): BookView {
  return {
    recent,
    state: book && book.tasks > 0 && state === 'none' ? 'ready' : state,
    files: book?.files ?? 0,
    tasks: book?.tasks ?? 0,
    note,
    kinds: book ? kindRows(book).slice(0, 9) : [],
    score,
  }
}

/** Added in 0.7.0. How the person worked in the last days, from the price book: kinds of task, models and effort levels. */
export function profileOf(book: Book | null, now: number, days: number): Profile {
  const from = now - days * 86_400_000
  const turns = (book?.turns ?? []).filter(t => t.t >= from && t.reqs > 0)
  const kinds = new Map<string, number[]>()
  const models = new Map<string, { n: number; usd: number }>()
  const efforts = new Map<string, number>()
  let total = 0
  for (const t of turns) {
    const cost = t.usd + t.hu
    total += cost
    kinds.set(t.kind || 'other', [...(kinds.get(t.kind || 'other') ?? []), cost])
    const fam = family(t.model)
    const m = models.get(fam) ?? { n: 0, usd: 0 }
    models.set(fam, { n: m.n + 1, usd: m.usd + cost })
    if (t.effort) efforts.set(t.effort, (efforts.get(t.effort) ?? 0) + 1)
  }
  const mid = (list: number[]): number => {
    const s = [...list].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)] ?? 0
  }
  return {
    days,
    tasks: turns.length,
    usd: round2(total),
    kinds: [...kinds.entries()]
      .map(([kind, list]) => ({ kind, n: list.length, p50: round2(mid(list)), usd: round2(list.reduce((a, b) => a + b, 0)) }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 6),
    models: [...models.entries()].map(([name, m]) => ({ name, n: m.n, usd: round2(m.usd) })).sort((a, b) => b.usd - a.usd),
    efforts: [...efforts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
  }
}

/** The scan summary in one line, for a toast. */
export function profileLine(p: Profile): string {
  if (p.tasks === 0) return `No tasks were found in the last ${p.days} days. The estimates start from 430 measured tasks.`
  const top = p.kinds[0]
  const model = p.models[0]
  return (
    `Your last ${p.days} days: ${p.tasks} tasks, ${usd(p.usd)} at list prices.` +
    (top ? ` Most money: ${top.kind} tasks (${top.n}, about ${usd(top.p50)} each).` : '') +
    (model ? ` Most used model: ${model.name}.` : '')
  )
}

/** The band of an estimate in words. An estimate from before 0.5.0 has only a range. */
export function bandLine(e: { low: number; safe: number; usual?: [number, number]; upTo?: number }): string {
  // Added in the subagent fixes (fix 13): a big task shows its high end only, so the line stays short.
  if (e.upTo && e.upTo > 0) return `up to ${usd(e.upTo)}`
  return e.usual ? `usually ${usd(e.usual[0])} to ${usd(e.usual[1])}` : `range ${usd(e.low)} to ${usd(e.safe)}`
}

/** The safe amount of an estimate in words, with its proof when it has one. */
export function safeLine(e: { safe: number; hold?: number }): string {
  return e.hold ? `safe budget ${usd(e.safe)}: ${e.hold} of 100 such tasks cost less` : `safe budget ${usd(e.safe)}`
}

/** The estimate in one line. The likely amount leads: it is the estimate. Changed in 0.8.0: no safe budget, the default limit is 1.5 times the likely cost. */
export function estimateLine(e: Estimate): string {
  return `about ${usd(e.likely)}, ${bandLine(e)}`
}
