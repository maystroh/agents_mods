import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { AskLog, BookView, Budget, Card, Plan, Route, Run, Spawn } from '../types'
import { OFFER, PANE, TITLE } from './names.ts'
import { AWK_FILTER, emptyBook, family, helperCap, helperUsd, isUnread, parseBook, priceFor, quantile, settle, similarTurns, type Book, type Match } from './book.ts'
import { aheadOf, agentModel, easeOf, EARLY_OVER, amountIn, shiftEstimate, bandLine, callLine, closeOutcome, decide, defaultLimit, estimateLine, learnedTimes, modGuess, round4, fits, forecast, freshFrom, handoffModel, HANDED_OFF, HELP, HOUR, learnTune, live, mustCheck, mustRead, parseStep, donePlan, newBudget, nextCost, ownRatios, parseLeft, profileLine, profileOf, recentOf, planFromEstimate, priceOf, QUIET, questionFor, reserveOf, round2, runOf, scoreOf, spentOf, statusText, taskCost, testToken, tuneFor, usd, viewOf, withLeft, type Base, type Calib, type Decision, nextBase, nextCalib, partsOf, trackStart, type Parts, type StartTrack, type Used, type Est, type Fresh, type Tune, type Why } from './core.ts'
import { buildPrompt, EST_EFFORT, EST_MODEL, fallbackEstimate, kindLabel, leastOf, nice, oddsLine, ownBand, parseEstimate, priceEstimate, SPEC, tailOf, tightOf, type Facts, type Parsed, type Priced } from './estimator.ts'
import { MODEL_NAMES, asFamily } from './picker.ts'
import { adviceQuestion, asLevel, LOWER_EFFORT, LOWER_MODEL, lowerEffort, lowerModel, overQuestion, parsePick, PICK_EFFORT, PICK_MODEL, pickPrompt, routeName, type Pick } from './picker.ts'
import { findSessions, scanSome, type Io, type SessionFile } from './scan.ts'
import { LEDGER_FILE, liveLine, queueLine, type LiveIn } from './ledger.ts'
import { alarmsOf, asksOf, bigTail, cleanLesson, easeFrom, isBigMiss, lessonPrompt, MEM_DIR, memoryText, parseLines, pickTypes, renderAll, subsOf, typeOf, type MemLine, type MemLite, type MemRun } from './memory.ts'

/** One line for each finished task. A spend review can read it. */
export const TASKS_FILE = 'task-budget-tasks.jsonl'

// Task Budget 0.8.0.
// /budget <task>            estimate the cost with its odds, give model and effort advice, then count the cost live. No limit.
// /budget estimate <task>   only the estimate
// /budget 3 <task>          the same, with a $3 limit. When the likely cost is over the limit, the mod asks before the start.
// /budget 3! <task>         start a $3 budget and the task at once, with no estimate first
// /budget                   what is spent and what is left
// /budget add 2 | set 5     change the limit and keep the spend
// /budget done              the task is finished: close the budget and learn from it
// /budget off               end the budget
// /budget learn             read the last 7 days of chats and show how you work. /budget learn all reads more.
// /budget prices | report | panel | finish
//
// What it does:
// - Reads your past chats on this machine into a price book: what a tool call, a helper
//   and a whole task of each kind really cost you.
// - Before a task: a small model counts the work, and the price book puts dollars on it.
// - While a task runs: code keeps the limit. At 50% and at 80% spent, when the task is on course
//   to pass the limit, the chat pauses and asks you: raise the limit, hand off to a cheaper model, or stop.
// - Claude never sees the budget: no note, no tool, no amount. Command output goes to the transcript as a notice that Claude does not read.

// The engine wants these names written in the file that reads and writes them.
const REF = { plugin: 'task-budget', key: 'budget' } as const
const HIST_REF = { plugin: 'task-budget', key: 'history' } as const
const LAST_REF = { plugin: 'task-budget', key: 'last' } as const
const STOPS_REF = { plugin: 'task-budget', key: 'stops' } as const
const BOOK_REF = { plugin: 'task-budget', key: 'book' } as const
const budget = atom(REF, null)
const stops = atom(STOPS_REF, {})

export const DIR = '.claude/mods-logs'
export const LOG = 'task-budget-history.json'
// The 2 is the format of the book. A chat that still runs an older build keeps its own file and cannot damage this one.
export const BOOK = 'task-budget-book-3.json'
export const LOCK = 'task-budget-book.lock'
export const ANSWERS = 'task-budget-answers.json'
export const NOTIFY = 'task-budget-gate'
/** One pass of the reader stops here. /budget learn reads more. */
export const PASS_FILES = 150
export const PASS_BYTES = 1_500_000_000

/** The history file. `base`: the real size of a first request, by folder. `calib`: real size over the engine's count. `tune`: real cost over estimate. */
/** `scan` (0.7.0): the answer to the first-run question. Not set: the question was not answered yet. */
export type Log = { runs: Run[]; base: Record<string, Base>; calib: Calib; tune: Tune; scan?: 'yes' | 'no'; /** Added in 0.8.0. Loaded from a history file that is there but cannot be read: never saved. */ isBroken?: true }
export type Usage = Awaited<ReturnType<EngineInterface['session']['usage']>>
export type Job = { files: SessionFile[]; read: number; bytes0: number; sid: string; /** Show the summary of this many days when the read is done. */ profile?: number }
/** What an estimate was made from. With it, code prices the same work again for another model or effort level, with no second model call. */
export type Raw = { parsed: Parsed; facts: Facts; matches: Match[]; cost: number; /** Added in fix 13: the memory types the estimate read, and the figures of the first one. */ mem?: { types: string[]; top: MemLite | null } }
export type Made = Priced & { isFallback: boolean; raw?: Raw }
export type Started = { text: string; isSet: boolean }
export type StartOpts = { isInline?: boolean; isForced?: boolean; priced?: Priced | null; /** The model and effort level the task runs on, when the person took the advice. */ route?: Route | null; /** Track only: no limit. */ isTrack?: boolean }

/** What this session holds in memory. It starts over when the mod loads. */
export const mem = {
  idleRaw: 0,
  /** Added after 0.8.0 (fix 3). The engine's breakdown of the chat start by part, before the first request. */
  idleParts: null as Parts | null,
  /** Added after 0.8.0 (fix 3). The engine's count at the first request of a new chat. */
  stepRaw: 0,
  /** Added after 0.8.0 (fix 3). The start of this chat, followed over its first requests. */
  start: null as StartTrack | null,
  isAsked: false,
  isLearned: false,
  book: null as Book | null,
  isBookRead: false,
  ttl: HOUR,
  score: null as BookView['score'],
  job: null as Job | null,
  offer: null as { task: string; made: Priced; route?: Route | null } | null,
  recent: [] as Run[],
  /** A read of the chat by the small model is out. */
  isChecking: false,
  /** Estimated cost of the requests that are out right now, so helpers side by side cannot pass the limit together. */
  inflight: 0,
  /** The one question that is open. A second request that must wait joins it. */
  asking: null as Promise<void> | null,
  /** The effort level the main chat last ran at. The price of a task changes with it. */
  effort: '',
  /** Added in 0.8.0. What the mod's calls cost before the budget of this run started: the estimate and the advice. */
  modPending: 0,
  /** Added in the subagent fixes. Subagents the mod stopped. Their tool calls and requests stay refused for the rest of the session. */
  stopped: new Set<string>(),
  /** The subagents the mod is ending now with TaskStop. Its own tool guard lets these calls through. */
  stopping: new Set<string>(),
  /** The turn id of the main chat's running turn, from turn.start. A stop aborts it. */
  mainTurn: '',
  // Added after 0.8.0: the Handoff mod request file that waits for the main turn to end.
  handoffAsk: '',
  /** A quiet new estimate of a task that grew is out. */
  isRegrowing: false,
  /** Added in the subagent fixes. The model the mod chose for each subagent at its start, so each of its requests keeps it. */
  picks: new Map<string, string>(),
  /** Added in the subagent fixes. The person stopped the main turn (the app's Stop or Escape) while subagents ran.
   * Each subagent request waits here. A message the person types, or the mod's Stop, lets them go. */
  hold: null as { wait: Promise<void>; release: () => void } | null,
}

/** Added in the subagent fixes. Hold the subagents: no new subagent request is sent until releaseAgents. No TaskStop. */
export function holdAgents(): void {
  if (mem.hold) return
  let done = (): void => undefined
  const wait = new Promise<void>(r => {
    done = r
  })
  mem.hold = {
    wait,
    release: () => {
      mem.hold = null
      done()
    },
  }
}

/** Added in the subagent fixes. Let the held subagents go on. */
export function releaseAgents(): void {
  mem.hold?.release()
}
/** What each helper has used: requests and dollars. */
export const helperUse = new Map<string, { n: number; usd: number; model: string }>()
export const helperWarned = new Set<string>()

// ---------- small engine reads ----------

export async function cur($: EngineInterface): Promise<Budget | null> {
  return live((await $.state.get(REF)).value)
}

export async function fileOf($: EngineInterface, name: string): Promise<string> {
  return `${(await homeOf($))}/${DIR}/${name}`
}

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function kOf(model: string | undefined): number {
  return mem.book?.k[family(model)] ?? 1
}

/** The engine's own count of what the chat holds now. Local, so it costs nothing. 0 when it cannot say. */
export async function measure($: EngineInterface): Promise<number> {
  return (await measureParts($)).total
}

/** Added after 0.8.0 (fix 3). The engine's count and its parts (the rows of /context). The 'summary' level is local and free. */
export async function measureParts($: EngineInterface): Promise<{ total: number; parts: Parts | null }> {
  try {
    const bd = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (!bd || !(bd.totalTokens > 0)) return { total: 0, parts: null }
    const parts = partsOf(bd.categories ?? [])
    return { total: bd.totalTokens, parts: Object.keys(parts).length > 0 ? parts : null }
  } catch {
    return { total: 0, parts: null }
  }
}

/** Added after 0.8.0 (fix 3). Count the chat before the first request, once per chat. */
export async function measureIdle($: EngineInterface): Promise<void> {
  if (mem.idleRaw > 0) return
  const m = await measureParts($)
  mem.idleRaw = m.total
  mem.idleParts = m.parts
}

export async function folder($: EngineInterface): Promise<string> {
  try {
    return await $.session.cwd()
  } catch {
    return ''
  }
}

/** A new chat: Claude has not answered yet. A chat that was opened again also starts at $0, so its old answers say it. */
export async function isFreshChat($: EngineInterface, usage: Usage): Promise<boolean> {
  if (usage.cost && usage.cost.usd > 0) return false
  try {
    return !(await $.session.messages()).some(m => m.role === 'assistant')
  } catch {
    return usage.cost ? usage.cost.usd === 0 : false
  }
}

// ---------- the history file ----------

/** Added in 0.8.0. The copy of the last good history. The mod reads it when the main file cannot be read. */
export const LOG_BAK = `${LOG}.bak`

const EMPTY_LOG = (): Log => ({ runs: [], base: {}, calib: { n: 0, idle: 0, step: 0 }, tune: {} })

function logOf(text: string): Log {
  const raw = JSON.parse(text) as Partial<Log>
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a history file')
  return {
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    base: raw.base && typeof raw.base === 'object' ? raw.base : {},
    calib: raw.calib && typeof raw.calib.n === 'number' ? raw.calib : { n: 0, idle: 0, step: 0 },
    tune: raw.tune && typeof raw.tune === 'object' ? raw.tune : {},
    ...(raw.scan === 'yes' || raw.scan === 'no' ? { scan: raw.scan } : {}),
  }
}

/** Added in 0.8.0. Whether a failed read means the file is not there. Any other failure means it is there but broken. */
function isMissing(err: unknown): boolean {
  return /ENOENT|no such file|not found|does not exist/i.test(String((err as Error)?.message ?? err))
}

/**
 * Changed in 0.8.0. A history file that cannot be read used to give an empty log, and the next save wiped the file.
 * Now: a missing or empty file gives a new empty log. A file that is there but cannot be read gives the last good copy (.bak).
 * With no good copy either, the log is empty and marked broken: saveLog then writes nothing, so the file stays for a later read.
 */
export async function loadLog($: EngineInterface): Promise<Log> {
  const path = await fileOf($, LOG)
  let text: string
  try {
    text = await $.fs.read(path)
  } catch (err) {
    if (isMissing(err)) return EMPTY_LOG()
    return fromBak($)
  }
  if (!text.trim()) return EMPTY_LOG()
  try {
    return logOf(text)
  } catch {
    return fromBak($)
  }
}

async function fromBak($: EngineInterface): Promise<Log> {
  try {
    return logOf(await $.fs.read(await fileOf($, LOG_BAK)))
  } catch {
    return { ...EMPTY_LOG(), isBroken: true }
  }
}

/** Changed in 0.8.0. Never saves a log that came from a broken file. Writes the file, then the same text to the .bak copy. */
export async function saveLog($: EngineInterface, log: Log): Promise<void> {
  if (log.isBroken) return
  try {
    const base = Object.fromEntries(Object.entries(log.base).slice(-60))
    const text = JSON.stringify({ runs: log.runs.slice(-200), base, calib: log.calib, tune: log.tune, ...(log.scan ? { scan: log.scan } : {}) }, null, 1)
    await $.fs.write(await fileOf($, LOG), text)
    await $.fs.write(await fileOf($, LOG_BAK), text)
  } catch {
    // the log is best effort: a budget still works without it
  }
}

/** Keep one run in the file. A task that ran to its answer also moves the estimate ratio, one time for each run. */
export async function saveRun($: EngineInterface, run: Run): Promise<Run[]> {
  const log = await loadLog($)
  const wasLearned = Boolean(log.runs.find(r => r.id === run.id)?.learned)
  const tune = wasLearned ? log.tune : learnTune(log.tune, run)
  const kept: Run = wasLearned || tune !== log.tune ? { ...run, learned: true } : run
  const runs = [...log.runs.filter(r => r.id !== run.id), kept]
  await saveLog($, { ...log, runs, tune })
  mem.score = scoreOf(runs)
  mem.recent = recentOf(runs)
  return runs.slice(-8)
}

/**
 * A new chat measured its start: keep it for this folder, and how far the engine's count was from it.
 * Changed after 0.8.0 (fix 3): the newest measure wins (0.8.0 took half old, half new), so a change shows in the next
 * chat. `isSettled` false: the first request only, which is a floor. The parts are kept, so the next chat sees a change.
 */
export async function learn($: EngineInterface, real: number, idleRaw: number, stepRaw: number, isSettled = true, parts?: Parts | null): Promise<void> {
  if (!(real > 0)) return
  const cwd = await folder($)
  const log = await loadLog($)
  const rest = Object.fromEntries(Object.entries(log.base).filter(([key]) => key !== cwd))
  const base = nextBase(log.base[cwd], real, isSettled, parts ?? undefined)
  const calib = isSettled ? nextCalib(log.calib, real, idleRaw, stepRaw) : log.calib
  await saveLog($, { ...log, base: { ...rest, [cwd]: base }, calib })
}

/**
 * Added after 0.8.0 (fix 3). A request of the main chat came back. In a new chat, follow the start over the first
 * requests: the first request, then the big late write. The folder keeps the first request as a floor at once, and the
 * settled start when it is known. The spend is not touched: it is always the billed usage.
 */
export function noteStart($: EngineInterface, isNew: boolean, u: Used | null | undefined, agentId?: string): void {
  if (!u || agentId) return
  if (!isNew && !(mem.start && !mem.start.isDone)) return
  const t = trackStart(isNew ? null : mem.start, u)
  mem.start = t
  if (isNew || t.isDone) void learn($, t.tokens, mem.idleRaw, mem.stepRaw, t.isDone, mem.idleParts).catch(() => undefined)
}

// ---------- the price book: what past chats on this machine cost ----------

export async function loadBook($: EngineInterface, isForced = false): Promise<Book | null> {
  if (mem.isBookRead && !isForced) return mem.book
  mem.isBookRead = true
  try {
    mem.book = parseBook(await $.fs.read(await fileOf($, BOOK))) ?? mem.book
  } catch {
    // no book yet: estimates use the starting sizes
  }
  return mem.book
}

export async function saveBook($: EngineInterface, book: Book): Promise<void> {
  try {
    await $.fs.write(await fileOf($, BOOK), JSON.stringify(book))
  } catch {
    // best effort
  }
}

export async function refreshView($: EngineInterface, state: BookView['state'] = mem.job ? 'reading' : 'none', note = ''): Promise<void> {
  try {
    await $.state.set(BOOK_REF, viewOf(mem.book, state, note, mem.score, mem.recent))
  } catch {
    // the panel shows the old numbers
  }
}

export function ioOf($: EngineInterface): Io {
  return {
    list: async path => (await $.fs.list(path)).map(x => ({ name: x.name, kind: x.kind, size: x.size, mtimeMs: x.mtimeMs })),
    read: path => $.fs.read(path),
    // A big chat does not fit in one read. awk cuts it down to the few fields the book needs.
    stream: async (path, onPiece) => {
      const run = $.process.spawn({ argv: ['awk', AWK_FILTER, path] })
      for (;;) {
        const step = await run.next()
        if (step.done) return step.value.code === 0
        if (step.value.stream === 'stdout') onPiece(step.value.text)
      }
    },
    pause: async () => {
      await $.clock.sleep(15)
    },
  }
}

export function scanSoon($: EngineInterface): void {
  try {
    $.clock.after(80, () => {
      void scanChunk($).catch(() => {
        mem.job = null
      })
    })
  } catch {
    mem.job = null
  }
}

/** Read a few chats, save, and plan the next few. Small parts, so the chat stays quick. */
export async function scanChunk($: EngineInterface): Promise<void> {
  const job = mem.job
  const book = mem.book
  if (!job || !book) {
    mem.job = null
    return
  }
  const lock = await fileOf($, LOCK)
  await $.fs.write(lock, JSON.stringify({ id: job.sid, at: await $.clock.now() })).catch(() => undefined)
  const p = await scanSome(ioOf($), book, job.files, { maxFiles: 4, maxBytes: 48_000_000 })
  job.read += p.read + p.skipped
  settle(book, await $.clock.now())
  await saveBook($, book)
  const isDone = p.left === 0 || p.read + p.skipped === 0 || job.read >= PASS_FILES || book.bytes - job.bytes0 >= PASS_BYTES
  if (!isDone) {
    await refreshView($, 'reading', `Reading your past chats: ${p.left} to go.`)
    scanSoon($)
    return
  }
  mem.job = null
  await $.fs.write(lock, JSON.stringify({ id: '', at: 0 })).catch(() => undefined)
  await refreshView($, 'ready', p.left > 0 ? `${p.left} older chats are not read yet. Type /budget learn all to read more.` : '')
  if (job.profile) await showProfile($, job.profile)
}

/** Put the summary of the last days in the chat: the kinds of task, what each costs, the models and the effort levels. */
export async function showProfile($: EngineInterface, days: number): Promise<void> {
  const now = await $.clock.now()
  const profile = profileOf(mem.book, now, days)
  await placeCard($, `prof-${now}`, { kind: 'profile', profile })
  $.ui.toast(profileLine(profile))
}

/** Save the answer to the first-run question. */
export async function setScan($: EngineInterface, scan: 'yes' | 'no'): Promise<void> {
  const log = await loadLog($)
  await saveLog($, { ...log, scan })
}

/** Start to read the past chats the book has not read. Newest first. Returns a line for the person. */
export async function scanStart($: EngineInterface, opts: { days?: number; profile?: boolean } = {}): Promise<string> {
  if (mem.job) return 'The mod is reading your past chats now.'
  const now = await $.clock.now()
  let sid = ''
  try {
    sid = await $.session.id()
  } catch {
    sid = String(now)
  }
  try {
    const held = JSON.parse(await $.fs.read(await fileOf($, LOCK))) as { id?: string; at?: number }
    if (held.id && held.id !== sid && now - (held.at ?? 0) < 120_000) return 'Another chat is reading your past chats now.'
  } catch {
    // no lock
  }
  const book = (await loadBook($, true)) ?? emptyBook()
  mem.book = book
  const all = await findSessions(ioOf($), `${(await homeOf($))}/.claude/projects`)
  // Not the chat that is open, and not one that still changes.
  const span = opts.days ? opts.days * 86_400_000 : Infinity
  const files = all.filter(f => isUnread(book, f.key, f.mtimeMs) && f.key !== sid && now - f.mtimeMs > 600_000 && now - f.mtimeMs <= span)
  if (files.length === 0) {
    await refreshView($, 'ready', '')
    if (opts.profile && opts.days) await showProfile($, opts.days)
    return book.tasks > 0 ? `The price book is current: ${book.tasks} tasks from ${book.files} chats.` : 'There are no past chats to read yet.'
  }
  mem.job = { files, read: 0, bytes0: book.bytes, sid, ...(opts.profile && opts.days ? { profile: opts.days } : {}) }
  await refreshView($, 'reading', `Reading your past chats: ${files.length} to go.`)
  scanSoon($)
  return `Reading ${files.length} past chats${opts.days ? ` of the last ${opts.days} days` : ''} in the background. The files stay on this computer. Estimates get better as it reads.`
}

// ---------- what a request costs ----------

/** The cost of the next request to the main chat. */
export async function mainEst($: EngineInterface, b: Budget | null, model: string, usage: Usage, now: number, fresh: Fresh | null): Promise<Est> {
  let ctx = usage.context.tokens && usage.context.tokens > 0 ? usage.context.tokens : 0
  if (!(ctx > 0) && !(b && b.ctxTokens > 0) && !fresh) ctx = await measure($)
  return nextCost(b, model, { ctx, now, k: kOf(model), fresh, ttl: mem.ttl })
}

/** The cost of the next request of a helper: its own average so far, or the size of a helper's first request. */
export function helperEst(agentId: string, model: string): number {
  const h = helperUse.get(agentId)
  if (h && h.n > 0) return h.usd / h.n
  const p = priceFor(model, 0, kOf(model))
  return (25_000 * p.w1 + 500 * p.out) / 1_000_000
}

/** How far a helper is past what a helper may use: 1 is the cap. The cap is the person's own dear helpers, or a quarter of the budget. */
export function helperRatio(b: Budget, agentId: string, model: string): number {
  const h = helperUse.get(agentId)
  const used = h?.usd ?? 0
  // A tool call does not name the helper's model: use the model its requests ran on.
  const cap = Math.max(helperCap(mem.book, model || h?.model || ''), 0.25 * b.limit)
  return cap > 0 ? used / cap : 0
}

// ---------- sending a prompt as the person ----------

/** The engine refuses a prompt sent from inside a command, because the command still holds the turn. So it goes out just after. */
export function sendSoon($: EngineInterface, text: string, onSent?: () => Promise<void>): void {
  const go = (tries: number): void => {
    try {
      $.clock.after(tries === 0 ? 80 : 1500, () => {
        void $.prompt
          .submit({ text, asUser: true })
          .then(r => {
            if (r && 'drop' in r && r.drop) $.ui.toast(String(r.drop))
            else if (onSent) void onSent().catch(() => undefined)
          })
          .catch(() => {
            if (tries < 2) go(tries + 1)
            else $.ui.toast('The task did not start. Send it as a normal message.')
          })
      })
    } catch {
      // no timer here: the task stays in `pending` and rides with the next message
    }
  }
  go(0)
}

/** The task went out. A mod does not see its own prompt pass, so the message is counted here. */
export async function markSent($: EngineInterface, text: string): Promise<void> {
  await update($, budget, c0 => {
    const c = live(c0)
    if (!c || c.pending !== text) return c0
    return { ...c, pending: '', messages: c.messages + 1, msgStart: c.spent, bars: [...c.bars, 0].slice(-14) }
  })
  const b = await cur($)
  if (b) await saveRun($, runOf(b, 'open', iso(await $.clock.now())))
}

// ---------- cards in the chat ----------

/** Keep the newest cards, and the estimate that waits. */
export function trim(all: Record<string, Card>): Record<string, Card> {
  const keys = Object.keys(all).filter(k => k !== OFFER)
  if (keys.length <= 12) return all
  const keep = new Set(keys.slice(-12))
  return Object.fromEntries(Object.entries(all).filter(([k]) => k === OFFER || keep.has(k)))
}

export async function placeCard($: EngineInterface, id: string, card: Card, extra: Record<string, Card> = {}): Promise<void> {
  await update($, stops, all => trim({ ...(all ?? {}), ...extra, [id]: card }))
  void $.ui.place({ id }).catch(() => undefined)
}

export async function clearOffer($: EngineInterface): Promise<void> {
  mem.offer = null
  await update($, stops, all => {
    if (!all || !(OFFER in all)) return all
    return Object.fromEntries(Object.entries(all).filter(([k]) => k !== OFFER))
  })
}

// ---------- ending a budget ----------

export async function finish($: EngineInterface, outcome: Run['outcome']): Promise<Run | null> {
  const b = await cur($)
  if (!b) return null
  const usage = await $.session.usage()
  // The person or the mod says the task is done: every step of the plan is done, even when Claude did not tick its list.
  const isDone = outcome === 'under' || outcome === 'over'
  const run = runOf({ ...b, spent: spentOf(b, usage.cost?.usd), plan: isDone ? donePlan(b.plan) : b.plan }, outcome, iso(await $.clock.now()))
  const recent = await saveRun($, run)
  taskLine($, run, b.spawns)
  // A closed budget never leaves subagents running free: on End or Stop they end first.
  if (outcome === 'ended' || outcome === 'stopped') await stopAgents($, b, { isAbort: false })
  await $.state.set(REF, null)
  await $.state.set(HIST_REF, recent)
  // The panel keeps the summary of this task until the next one starts.
  if (run.spent > 0) await $.state.set(LAST_REF, run)
  $.ui.status(undefined)
  helperUse.clear()
  helperWarned.clear()
  // Subagents held after the person stopped the main turn do not wait for a budget that is gone.
  releaseAgents()
  await refreshView($)
  return run
}

/** Fire and forget: one line for a finished task in the task log. Kind, skill, model, effort, estimate, real cost, time. */
export function taskLine($: EngineInterface, run: Run, spawns?: readonly Spawn[]): void {
  if (!(run.spent > 0)) return
  void (async () => {
    const cost = taskCost(run)
    const line = JSON.stringify({
      at: run.at,
      id: run.id,
      session: await $.session.id().catch(() => ''),
      cwd: await folder($),
      task: run.task,
      kind: run.kind ?? '',
      skill: run.skill ?? '',
      model: run.model,
      effort: run.effort ?? '',
      estimate: run.estimate?.likely ?? null,
      low: run.estimate?.low ?? null,
      safe: run.estimate?.safe ?? null,
      cost: cost ?? run.spent,
      spent: run.spent,
      limit: run.isTrack ? null : run.limit,
      secs: run.secs ?? null,
      messages: run.messages,
      outcome: run.outcome,
      why: run.why ?? '',
      agents: run.agents ?? 0,
      agentModel: run.agentModel ?? '',
      asks: (run.asks ?? []).length,
    })
    const fs = { read: (p: string) => $.fs.read(p) as Promise<string>, write: (p: string, t: string) => $.fs.write(p, t), exists: (p: string) => $.fs.exists(p) }
    await queueLine(fs, await fileOf($, TASKS_FILE), line)
    // Added in the subagent fixes (fix 13): the same task goes into the learning memory.
    const cwd = await folder($)
    await learnRun($, {
      at: run.at,
      type: typeOf(run.task, cwd, run.skill ?? ''),
      task: run.task.replace(/\s+/g, ' ').trim().slice(0, 300),
      model: run.model,
      effort: run.effort ?? '',
      kind: run.kind ?? '',
      ...(run.skill ? { skill: run.skill } : {}),
      ...subsOf(spawns),
      estimate: run.estimate?.likely ?? null,
      low: run.estimate?.low ?? null,
      high: run.estimate?.upTo ?? run.estimate?.safe ?? null,
      cost: cost ?? run.spent,
      limit: run.isTrack ? null : run.limit,
      outcome: run.outcome,
      asks: (run.asks ?? []).length,
      source: 'mod',
      // Added after 0.8.0: the cost path, the step starts, the start cost, and each question.
      ...(run.path && run.path.length > 0 ? { path: run.path } : {}),
      ...(run.stepAt && run.stepAt.length > 0 ? { stepAt: run.stepAt } : {}),
      ...(typeof run.start === 'number' ? { start: run.start } : {}),
      ...((run.asks ?? []).length > 0 ? { qs: asksOf(run.asks, cost ?? run.spent, run.outcome) } : {}),
    })
  })().catch(() => undefined)
}

// ---------- the learning memory (added in the subagent fixes, fix 13) ----------

export const MEM_RUNS = `${MEM_DIR}/runs.jsonl`

/** The text of a file. Undefined: no such file. Null: the file is there but cannot be read. */
async function readSafe($: EngineInterface, path: string): Promise<string | null | undefined> {
  let isThere = false
  try {
    isThere = await $.fs.exists(path)
  } catch {
    return null
  }
  if (!isThere) return undefined
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** Every line of runs.jsonl: the main file, or the .bak copy when it has more lines. `isBroken`: the main file is there but cannot be read. */
export async function memLines($: EngineInterface): Promise<{ lines: MemLine[]; isBroken: boolean }> {
  const path = await fileOf($, MEM_RUNS)
  const main = await readSafe($, path)
  const bak = await readSafe($, `${path}.bak`)
  const a = typeof main === 'string' ? parseLines(main) : []
  const b = typeof bak === 'string' ? parseLines(bak) : []
  return { lines: b.length > a.length ? b : a, isBroken: main === null }
}

/** Write each memory file again from the lines. A file that is there but cannot be read is never saved over. */
export async function rebuildMemory($: EngineInterface, lines: readonly MemLine[]): Promise<void> {
  const files = renderAll(lines, iso(await $.clock.now()))
  for (const [name, text] of Object.entries(files)) {
    const path = await fileOf($, `${MEM_DIR}/${name}`)
    const old = await readSafe($, path)
    if (old === null || old === text) continue
    await $.fs.write(path, text)
  }
}

/** Added after 0.8.0: memory files written before the cost path have no false-alarm count in stats.json. Write them again once. Never fatal. */
export async function upgradeMemory($: EngineInterface): Promise<boolean> {
  try {
    const text = await readSafe($, await fileOf($, `${MEM_DIR}/stats.json`))
    if (typeof text !== 'string') return false
    const stats = JSON.parse(text) as Record<string, { alarms?: unknown }>
    if (Object.values(stats).every(x => typeof x?.alarms === 'number')) return false
    const got = await memLines($)
    if (got.isBroken) return false
    await rebuildMemory($, got.lines)
    return true
  } catch {
    return false
  }
}

/** One write at a time, so two tasks that end together do not lose a line. */
let memChain: Promise<unknown> = Promise.resolve()

/** Add one finished task to runs.jsonl, rebuild the files, and add a lesson after a miss of 2 times or more. */
export function learnRun($: EngineInterface, run: MemRun): Promise<void> {
  const job = memChain.then(() => learnNow($, run)).catch(() => undefined)
  memChain = job
  return job
}

async function appendMem($: EngineInterface, line: MemLine): Promise<MemLine[] | null> {
  const got = await memLines($)
  // The file is there but cannot be read: never save over it. The .bak copy keeps the last good lines.
  if (got.isBroken) return null
  const lines = [...got.lines, line]
  const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  const path = await fileOf($, MEM_RUNS)
  await $.fs.write(path, text)
  await $.fs.write(`${path}.bak`, text)
  return lines
}

async function learnNow($: EngineInterface, run: MemRun): Promise<void> {
  const lines = await appendMem($, run)
  if (!lines) return
  await rebuildMemory($, lines)
  // Added after 0.8.0: after every 2 false alarms in a type, the pause point of the type goes up (stats.json), with one lesson line written by code.
  const fresh = (run.qs ?? []).filter(q => q.falseAlarm).length
  if (fresh > 0) {
    const same = lines.filter((x): x is MemRun => !('lesson' in x) && x.type === run.type)
    const after = alarmsOf(same)
    const before = after - fresh
    if (after >= 2 && Math.floor(after / 2) > Math.floor(before / 2)) {
      const lesson = `${after} questions in this type came before runs that ended under their limit. The pause point is now ${easeFrom(after)} times the usual.`
      const more = await appendMem($, { at: run.at, type: run.type, lesson })
      if (more) await rebuildMemory($, more)
    }
  }
  if (!isBigMiss(run)) return
  try {
    const r = await $.model.complete({ model: EST_MODEL, effort: 'low', prompt: lessonPrompt(run), maxTokens: 120, timeoutMs: 20_000 })
    const lesson = r.isAnswered ? cleanLesson(r.text) : null
    if (!lesson) return
    const more = await appendMem($, { at: run.at, type: run.type, lesson })
    if (more) await rebuildMemory($, more)
  } catch {
    // No lesson this time. The numbers are saved.
  }
}

/** What the estimate reads from the memory: the index and at most 2 type files. A new install with no memory gets the starter figures. */
export async function readMemory($: EngineInterface, task: string, isLogged = true): Promise<{ text: string; types: string[]; top: MemLite | null }> {
  const dir = MEM_DIR
  const index = await readSafe($, await fileOf($, `${dir}/INDEX.md`))
  const statsText = await readSafe($, await fileOf($, `${dir}/stats.json`))
  let stats: Record<string, MemLite> | null = null
  try {
    stats = typeof statsText === 'string' ? (JSON.parse(statsText) as Record<string, MemLite>) : null
  } catch {
    stats = null
  }
  const built = typeof index === 'string' && stats ? null : renderAll([], iso(await $.clock.now()))
  if (built) stats = JSON.parse(built['stats.json'] ?? '{}') as Record<string, MemLite>
  const all = stats ?? {}
  const samples = Object.fromEntries(Object.entries(all).map(([t, s]) => [t, s.samples ?? []]))
  const types = pickTypes(task, await folder($), '', samples, Object.keys(all))
  const files: { type: string; text: string }[] = []
  for (const t of types) {
    const text = built ? built[`types/${t}.md`] : await readSafe($, await fileOf($, `${dir}/types/${t}.md`))
    if (typeof text === 'string') files.push({ type: t, text })
  }
  const indexText = built ? (built['INDEX.md'] ?? '') : (index as string)
  // A log of what the last estimate read, to check the memory is used.
  if (isLogged) void $.fs
    .write(await fileOf($, `${dir}/last-read.json`), JSON.stringify({ at: iso(await $.clock.now()), index: indexText.split('\n').length, types: files.map(f => f.type), isStarter: Boolean(built) }) + '\n')
    .catch(() => undefined)
  return { text: memoryText(indexText, files), types: files.map(f => f.type), top: types[0] ? (all[types[0]] ?? null) : null }
}

/** One finished budget in words: what was spent, and the estimate next to the real cost of the task it was made for. */
export function runLine(run: Run): string {
  const e = run.estimate
  const head = run.isTrack
    ? `Spent ${usd(run.spent)}. No limit was set.`
    : run.isOpen
    ? `Spent ${usd(run.spent)}. The budget was ${usd(run.limit)}, then you chose Keep going.`
    : `Spent ${usd(run.spent)} of ${usd(run.limit)}.`
  if (!e || !(e.likely > 0)) return head
  const est = `about ${usd(e.likely)} (${bandLine(e)})`
  const cost = taskCost(run)
  // The estimate is for the first task. When later messages are in the spend, the first task is named apart.
  if (cost !== null && Math.abs(cost - run.spent) > 0.005) return `${head} The first task cost ${usd(cost)}. Its estimate was ${est}.`
  return `${head} The estimate was ${est}.`
}

/**
 * Claude gave its answer to the first task of the budget: keep what that task cost.
 * The estimate was made for this task, so this number says how good the estimate was.
 */
export async function markFirst($: EngineInterface, b: Budget): Promise<Budget> {
  if (b.firstCost !== undefined || !(b.messages >= 1)) return b
  // A plan that waits for approval: the task is not finished.
  if (b.plan && b.plan.status !== 'approved') return b
  // Added in 0.7.5. A later message can be a "go ahead" for the same task (a plan to approve), or new work.
  // So after more than one message the small model always reads the chat before the task counts as done.
  // Open items in Claude's task list, or an answer that ends with a question: the task can be open or done.
  // Claude often leaves its list as it was, so a small model reads the last message and says which.
  const hasOpen = b.todos.some(t => t.status !== 'completed')
  const asks = /\?\s*$/.test((await lastAnswer($)).trim())
  if (hasOpen || asks || b.messages > 1) {
    const said = await readChat($, b)
    if (!said) return b
    const id = b.id
    let kept = b
    await update($, budget, c0 => {
      const c = live(c0)
      if (!c || c.id !== id) return c0
      // Added in 0.8.0: the read is the mod's own cost.
      const paid = { ...c, modCost: round4((c.modCost ?? 0) + said.usd) }
      kept = said.part !== null && said.part < 0.9 ? withLeft(paid, said.part, said.step ?? undefined) : paid
      return kept
    })
    if (said.part === null || said.part < 0.9) return kept
    b = kept
  }
  const usage = await $.session.usage()
  const spent = spentOf(b, usage.cost?.usd)
  if (!(spent > 0)) return b
  let out = b
  await update($, budget, c0 => {
    const c = live(c0)
    if (!c || c.id !== b.id || c.firstCost !== undefined) return c0
    out = { ...c, spent, firstCost: round2(spent), plan: donePlan(c.plan) }
    return out
  })
  return out
}

/** The person chose Keep going: the limit stops nothing now. The count runs on, so the real cost shows next to the estimate. */
export async function keepGoing($: EngineInterface): Promise<string> {
  const b = await cur($)
  if (!b) return HELP
  const usage = await $.session.usage()
  const spent = spentOf(b, usage.cost?.usd)
  const next: Budget = {
    ...b,
    spent,
    isOpen: true,
    isPaused: false,
    isMidTurn: false,
    waiting: '',
    ask: null,
  }
  await $.state.set(REF, next)
  $.ui.status(statusText(next))
  // Claude was stopped mid-task: carry on without the person typing "go ahead".
  if (b.isPaused && b.isMidTurn) sendSoon($, 'Continue from where you stopped.')
  const e = b.estimate
  return `No limit now. Claude carries on, and the count runs on. ${usd(spent)} spent so far${e ? `, the estimate was about ${usd(e.likely)}` : ''}.`
}

/** End the budget and put the report in the chat. */
export async function closeWithCard($: EngineInterface, outcome: Run['outcome']): Promise<Run | null> {
  const run = await finish($, outcome)
  if (run) await placeCard($, `rep-${run.id}`, { kind: 'report', run })
  return run
}

/** The End budget button. */
export async function endNow($: EngineInterface): Promise<string> {
  const b = await cur($)
  const run = await finish($, b?.isPaused ? 'stopped' : 'ended')
  return run ? `Budget ended. ${runLine(run)}` : HELP
}

/** The Task is done button, and /budget done. */
export async function doneNow($: EngineInterface): Promise<string> {
  const b = await cur($)
  const run = b ? await closeWithCard($, closeOutcome(b)) : null
  return run ? `Budget closed: the task is done. ${runLine(run)} ${learnLine(run)}` : HELP
}

/** What a closed run teaches. Only a task with an estimate that ran to its answer moves the estimate ratio. */
export function learnLine(run: Run): string {
  return run.estimate && run.estimate.likely > 0 && taskCost(run) !== null ? 'The mod learned from this run.' : 'The run is kept in the history.'
}

// ---------- the estimate ----------

/** Count the work of a task with a small model, and put this person's prices on it. */
/** The end of Claude's last answer in this chat. A task like "go ahead" points at it. Empty when there is none. */
async function lastAnswer($: EngineInterface): Promise<string> {
  try {
    const msgs = await $.session.messages()
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m?.role === 'assistant' && m.text.trim()) return tailOf(m.text)
    }
  } catch {
    // No chat to read: the estimate works without it.
  }
  return ''
}

/**
 * The effort level of this chat now. First the app's effort picker: the app hands it to the chat as a setting,
 * and it changes the moment the person picks a level, before any message. Then the level of the last request
 * of this chat. Else '' (not seen yet). Never a guess from past chats, and never the settings file or the
 * CLAUDE_EFFORT variable: on 2026-11-17 both said another level than the picker.
 */
export async function effortNow($: EngineInterface): Promise<string> {
  try {
    const f = (await $.settings.read({ source: 'flag' })) as { effortLevel?: unknown } | undefined
    const level = asLevel(f?.effortLevel)
    if (level) return level
  } catch {
    // No app settings here: the last request of this chat says it.
  }
  if (mem.effort) return mem.effort
  // Added in 0.8.0: the chat file keeps the effort level of each past request, so a reload or a resumed chat still knows it.
  const fromFile = await effortFromFile($)
  if (fromFile) mem.effort = fromFile
  return fromFile
}

/** Added in 0.8.0. The effort level of the last request in this chat's own file, or '' when the file has none. */
export async function effortFromFile($: EngineInterface): Promise<string> {
  try {
    const home = (await homeOf($))
    const id = await $.session.id()
    const slug = (await $.session.cwd()).replace(/[^A-Za-z0-9]/g, '-')
    if (!home || !id) return ''
    const path = `${home}/.claude/projects/${slug}/${id}.jsonl`
    // Read the file, keep the last 2 MB, take the last effort level in it.
    const text = String((await $.fs.read(path).catch(() => '')) ?? '').slice(-2_000_000)
    const all = [...text.matchAll(/"effort":"([a-z]+)"/g)]
    return asLevel(all[all.length - 1]?.[1])
  } catch {
    return ''
  }
}

/** What a price for this chat needs: its model and effort level, how many tokens it holds, and whether the cache has them. */
export async function chatNow($: EngineInterface): Promise<{ model: string; effort: string; ctx: number; isFresh: boolean; isCold: boolean }> {
  const book = await loadBook($)
  const log = await loadLog($)
  const usage = await $.session.usage()
  const model = await $.session.model()
  const b = await cur($)
  const isFresh = b ? b.isFresh && b.steps === 0 : await isFreshChat($, usage)
  let ctx = b && b.ctxTokens > 0 ? b.ctxTokens : (usage.context.tokens ?? 0)
  if (!(ctx > 0) && isFresh) {
    await measureIdle($)
    ctx = freshFrom(log.base, log.calib, await folder($), mem.idleRaw, 'idle', mem.idleParts ?? undefined, await $.session.model()).tokens
  } else if (!(ctx > 0)) {
    ctx = (await measure($)) || 60_000
  }
  const est = await mainEst($, b, model, usage, await $.clock.now(), isFresh ? { tokens: ctx, how: 'measured' } : null)
  return { model, effort: await effortNow($), ctx, isFresh, isCold: est.isCold }
}

/** The model and effort level this chat runs on now. The effort is '' when neither the app picker nor a request of this chat says it. */
export async function routeNow($: EngineInterface): Promise<Route> {
  const model = await $.session.model()
  return { model: family(model), effort: await effortNow($) }
}

/** Price counted work with this person's numbers: the ratio of this kind of task on this model and effort level, and the person's own range. */
async function priceRaw($: EngineInterface, raw0: Raw, facts: Facts): Promise<Priced> {
  const book = await loadBook($)
  const log = await loadLog($)
  // Added in the subagent fixes: subagents run on Sonnet or Haiku in a task with a budget, so they are priced on that model.
  const forced = agentModel(facts.model)
  const raw: Raw = {
    ...raw0,
    parsed: {
      ...raw0.parsed,
      steps: raw0.parsed.steps.map(st => ({ ...st, helpers: st.helpers.map(h => (h.model === 'haiku' ? h : { ...h, model: forced })) })),
    },
  }
  // Priced once to learn the kind of task, then with the ratio of that kind.
  const kind = priceEstimate(book, raw.parsed, facts, raw.matches, { ratio: 1, n: 0 }, raw.cost).estimate.kind
  const ratios = ownRatios(log.runs, kind)
  const own = ownBand(ratios, facts.isCold)
  const tune = tuneFor(log.tune, kind, facts.model, facts.effort)
  const p = withExtras(priceEstimate(book, raw.parsed, facts, raw.matches, tune, raw.cost, own), book, facts, tune.n)
  // Added in 0.8.0: the default limit multiple, learned from the same finished tasks as the own range.
  const learned = learnedTimes(ratios)
  // Added in 0.8.0: the mod's own calls count in the spend, so the estimate holds them too.
  const e = p.estimate
  const mod = modGuess(log.runs, kind, e.likely, raw.cost)
  const withMod = {
    ...e,
    low: round2(e.low + mod),
    likely: round2(e.likely + mod),
    safe: nice(e.safe + mod),
    ...(e.usual ? { usual: [round2(e.usual[0] + mod), round2(e.usual[1] + mod)] as [number, number] } : {}),
    mod,
    times: learned.times,
    timesN: learned.n,
  }
  // Added in the subagent fixes: past tasks of this kind started more subagents than this estimate counts. Add the gap.
  const counts = log.runs.filter(r => r.kind === kind && typeof r.agents === 'number').map(r => r.agents ?? 0)
  if (counts.length >= 3) {
    const typicalAgents = Math.round(quantile(counts, 0.5))
    const gap = typicalAgents - (e.helpers ?? 0)
    if (gap > 0) return withTail({ ...p, estimate: { ...shiftEstimate(withMod, round2(gap * helperUsd(book, forced))), helpers: typicalAgents } }, raw, facts.model, forced)
  }
  return withTail({ ...p, estimate: withMod }, raw, facts.model, forced)
}

/** Added in the subagent fixes (fix 13). A big task gets a high end from the money tail of its type. */
export function withTail(p: Priced, raw: Raw, model: string, subModel: string): Priced {
  const e = p.estimate
  const t = bigTail({ likely: e.likely, safe: e.safe, helpers: e.helpers ?? 0 }, raw.mem?.top ?? null, model, subModel)
  if (!t) return p
  return { ...p, estimate: { ...e, upTo: t.upTo, basis: `${e.basis}. High end ${usd(t.upTo)}: ${t.why}` } }
}

/** How often the advisor ran in the last tasks with real work, and what it cost when it ran. Null with too few tasks. */
export function advisorUse(turns: readonly { t: number; reqs: number; adv?: number; an?: number }[]): { n: number; of: number; usd: number } | null {
  const last = turns
    .filter(t => t.reqs >= 3)
    .sort((a, b) => a.t - b.t)
    .slice(-30)
  if (last.length < 6) return null
  const ran = last.filter(t => (t.an ?? 0) > 0 && (t.adv ?? 0) > 0)
  if (ran.length === 0) return null
  return { n: ran.length, of: last.length, usd: round2(quantile(ran.map(t => t.adv ?? 0), 0.5)) }
}

/**
 * Two things the counted work does not show.
 * The chat start: its tokens and dollars, so the person sees what is paid before any work.
 * The advisor: when it ran in half or more of the last tasks, its usual cost is added. A ratio learned from 3 or more finished tasks holds it already.
 */
export function withExtras(p: Priced, book: Book | null, facts: Facts, tuned: number): Priced {
  let e = p.estimate
  let steps = p.steps
  const adv = book ? advisorUse(book.turns) : null
  if (adv && adv.usd >= 0.01 && adv.n * 2 >= adv.of && tuned < 3) {
    e = {
      ...e,
      low: round2(e.low + adv.usd),
      likely: round2(e.likely + adv.usd),
      safe: nice(e.safe + adv.usd),
      ...(e.usual ? { usual: [round2(e.usual[0] + adv.usd), round2(e.usual[1] + adv.usd)] as [number, number] } : {}),
      advisor: adv.usd,
      basis: `${e.basis}, plus ${usd(adv.usd)} for the advisor (it ran in ${adv.n} of your last ${adv.of} tasks)`,
    }
    steps = [...steps, { name: 'Advisor review', done: '', usd: adv.usd }]
  } else if (adv && adv.usd >= 0.01 && adv.n * 6 >= adv.of) {
    e = { ...e, unsure: [`the advisor: it ran in ${adv.n} of your last ${adv.of} tasks and costs about ${usd(adv.usd)} when it runs`, ...e.unsure] }
  }
  if ((facts.isCold || facts.reload === true) && facts.ctx > 0) {
    const cost = (facts.ctx * priceFor(facts.model, facts.ctx, kOf(facts.model)).w1) / 1_000_000
    e = { ...e, base: { tokens: Math.round(facts.ctx), usd: round2(Math.min(cost, e.likely)) } }
  }
  return { steps, estimate: e }
}

/** "186K": tokens in thousands. */
export function kTokens(n: number): string {
  return `${Math.round(n / 1000)}K`
}

/** The same counted work, priced for another model or effort level. No model call. */
export async function reprice($: EngineInterface, raw: Raw, route: Route): Promise<Priced> {
  // A change of model in a chat that is warm: the new model reads the chat at the full price one time.
  const isSwitch = family(route.model) !== family(raw.facts.model)
  const facts: Facts = { ...raw.facts, model: route.model, ...(route.effort ? { effort: route.effort } : {}), ...(isSwitch && !raw.facts.isCold ? { reload: true } : {}) }
  return priceRaw($, raw, facts)
}

/** Ask a small model which model and effort level fit the task. Null when it gives no usable answer. */
export async function advise($: EngineInterface, task: string, now: Route, paid?: (usd: number) => void): Promise<Pick | null> {
  try {
    const r = await $.model.complete({ model: PICK_MODEL, effort: PICK_EFFORT, prompt: pickPrompt(task, now.model, now.effort), maxTokens: 200, timeoutMs: 30_000 })
    // Added in 0.8.0: the mod counts its own calls.
    if (r.isAnswered && r.usage && paid) paid(priceOf({ model: 'claude-sonnet-5-5', ...r.usage }))
    return r.isAnswered ? parsePick(r.text) : null
  } catch {
    return null
  }
}

export async function estimate($: EngineInterface, task: string): Promise<Made> {
  const book = await loadBook($)
  const log = await loadLog($)
  const usage = await $.session.usage()
  const model = await $.session.model()
  const b = await cur($)
  // A budget in a new chat that has sent no request yet: the chat still has its first load to pay.
  const isFresh = b ? b.isFresh && b.steps === 0 : await isFreshChat($, usage)
  let ctx = b && b.ctxTokens > 0 ? b.ctxTokens : (usage.context.tokens ?? 0)
  if (!(ctx > 0) && isFresh && b && b.firstTokens > 0) {
    ctx = b.firstTokens
  } else if (!(ctx > 0) && isFresh) {
    await measureIdle($)
    ctx = freshFrom(log.base, log.calib, await folder($), mem.idleRaw, 'idle', mem.idleParts ?? undefined, await $.session.model()).tokens
  } else if (!(ctx > 0)) {
    ctx = (await measure($)) || 60_000
  }
  const effort = await effortNow($)
  const facts: Facts = { model, ctx, isCold: isFresh, before: await lastAnswer($), ...(effort ? { effort } : {}) }
  const matches = book ? similarTurns(book.turns, task, 5) : []
  // Added in the subagent fixes (fix 13): the learning memory. Never fatal.
  const memo = await readMemory($, task).catch(() => null)
  let paidFor = 0
  try {
    const r = await $.model.complete({
      model: EST_MODEL,
      effort: EST_EFFORT,
      system: SPEC,
      prompt: buildPrompt(task, facts, matches, memo?.text ?? ''),
      maxTokens: 1600,
      timeoutMs: 45_000,
    })
    const parsed = r.isAnswered ? parseEstimate(r.text) : null
    if (r.isAnswered && r.usage) paidFor = priceOf({ model: 'claude-sonnet-5-5', ...r.usage })
    if (parsed && r.isAnswered) {
      const raw: Raw = { parsed, facts, matches, cost: paidFor, ...(memo ? { mem: { types: memo.types, top: memo.top } } : {}) }
      return { ...(await priceRaw($, raw, facts)), isFallback: false, raw }
    }
  } catch {
    // fall through to the cost of past tasks
  }
  const fb = fallbackEstimate(book, matches, facts)
  // Added in 0.8.0: a call that answered with no usable count still cost money.
  return { ...fb, estimate: { ...fb.estimate, cost: paidFor }, isFallback: true }
}

/** Answers for a test run come from a file, in order. Null when none is left. */
export async function testAnswer($: EngineInterface, token: string): Promise<string | null> {
  try {
    const path = await fileOf($, ANSWERS)
    const all = JSON.parse(await $.fs.read(path)) as Record<string, string[]>
    const list = Array.isArray(all[token]) ? all[token] : []
    const first = list[0]
    if (first === undefined) return null
    await $.fs.write(path, JSON.stringify({ ...all, [token]: list.slice(1) }))
    return first
  } catch {
    return null
  }
}

/** Start the budget from the estimate that waits. `track` starts with no limit. */
export async function startOffer($: EngineInterface, pick: 'default' | 'safe' | 'tight' | 'likely' | 'track' | number): Promise<string> {
  const all = (await $.state.get(STOPS_REF)).value
  const card = all ? all[OFFER] : undefined
  if (!card || card.kind !== 'estimate') return 'No estimate waits. Type /budget and then your task.'
  const e = card.estimate
  const isTrack = pick === 'track'
  // Changed in 0.8.0: the default limit is 1.5 times the likely cost. The safe amount stays as the mark of a track-only task.
  const limit = pick === 'default' ? defaultLimit(e) : pick === 'safe' || pick === 'track' ? e.safe : pick === 'tight' ? tightOf(e) : pick === 'likely' ? nice(e.likely) : pick
  const steps = mem.offer ? mem.offer.made.steps : card.steps.map(s => ({ name: s.name, done: '', usd: s.usd }))
  const route = mem.offer?.route ?? card.route ?? null
  const out = await start($, limit, mem.offer?.task ?? card.task, { priced: { estimate: e, steps }, route, isTrack })
  return out.text
}

/** Ask one question. With a test token the answer comes from the answers file. Null when nobody answers. */
async function askOne($: EngineInterface, token: string, text: string, options: string[]): Promise<string | null> {
  if (token) return testAnswer($, token)
  try {
    return await $.ui.ask(text, { options, header: 'Budget' })
  } catch {
    return null
  }
}

/** The first-run question, asked one time: may the mod read the last 7 days of chats? */
export const SCAN_DAYS = 7
export async function firstRun($: EngineInterface, token: string): Promise<void> {
  if (token) return
  const log = await loadLog($)
  if (log.scan) return
  // The chat start is different for each person: measure it now, so the first estimate has the real number.
  let baseLine = ''
  try {
    await measureIdle($)
    const fresh = freshFrom(log.base, log.calib, await folder($), mem.idleRaw, 'idle', mem.idleParts ?? undefined, await $.session.model())
    const model = await $.session.model()
    const fam = asFamily(family(model))
    if (fresh.tokens > 0) {
      const cost = (fresh.tokens * priceFor(model, fresh.tokens, kOf(model)).w1) / 1_000_000
      baseLine = `Measured now: a new chat in this folder starts at about ${kTokens(fresh.tokens)} tokens. ${fam ? `On ${MODEL_NAMES[fam]} that` : 'That'} is about ${usd(cost)} before any work. Each estimate counts it.`
    }
  } catch {
    baseLine = ''
  }
  let answer: string | null = null
  try {
    answer = await $.ui.ask(
      [
        `Read your last ${SCAN_DAYS} days of chats to learn how you work?`,
        'Yes: the mod reads the chat files on this computer. It learns your kinds of task, what each costs, and which models and effort levels you use. Nothing leaves this computer.',
        'Not now: the estimates start from 430 measured tasks. You can run it later with /budget learn.',
        ...(baseLine ? [baseLine] : []),
      ].join('\n'),
      { options: ['Yes', 'Not now'], header: 'Budget' },
    )
  } catch {
    answer = null
  }
  // No answer: the question comes again the next time.
  if (answer === null) return
  const isYes = /^y/i.test(answer.trim())
  await setScan($, isYes ? 'yes' : 'no')
  if (isYes) $.ui.toast(await scanStart($, { days: SCAN_DAYS, profile: true }))
}

/** The estimate in words, with its odds. Only a counted estimate has measured odds. A first guess names its range and no share. */
export function estimateText(e: Priced['estimate'], route: Route | null): string {
  const on = route ? ` on ${routeName(route)}` : ''
  const head = `Estimate for this task${on} (${kindLabel(e.kind)}, ${e.confidence} confidence).`
  const tail = e.base && e.base.usd >= 0.01 ? ` The chat start is ${usd(e.base.usd)} of that (${kTokens(e.base.tokens)} tokens).` : ''
  if (e.usual && e.hold) return `${head} ${oddsLine(e)}${tail}`
  if (e.usual) return `${head} Likely ${usd(e.likely)}. A first guess of the range: ${usd(e.usual[0])} to ${usd(e.usual[1])}.${tail}`
  return `${head} Likely ${usd(e.likely)}. The range is ${usd(e.low)} to ${usd(e.safe)}.${tail}`
}

/** Added in 0.8.0. The one line of the start question: the likely cost and its range. */
export function startLine(e: Priced['estimate']): string {
  return `Likely ${usd(e.likely)}, ${bandLine(e)}.`
}

/**
 * Make the estimate, give the model and effort advice, show the estimate, and ask how to start.
 * With no `limit` the person can start with no limit (track only). With a `limit`, the mod asks first when the likely cost is over it.
 */
export async function offer($: EngineInterface, taskIn: string, isCardOnly: boolean, limit?: number): Promise<void> {
  const { token, text: task } = testToken(taskIn)
  if (!isCardOnly) await firstRun($, token)
  const now = await routeNow($)
  // Added in 0.8.0: a new run. The mod's calls from here on are its own cost.
  if (!isCardOnly) mem.modPending = 0
  let adviceUsd = 0
  // The count of the work and the advice are two small calls that run side by side.
  const [first, pick] = await Promise.all([estimate($, task), isCardOnly ? Promise.resolve(null) : advise($, task, now, usd => (adviceUsd = usd))])
  if (!isCardOnly) mem.modPending = round4(first.estimate.cost + adviceUsd)
  let made: Priced = first
  let route: Route | null = null
  const raw = first.raw
  // The advice: only when the work was counted, and the pick is not what the chat runs on.
  const isOther = pick !== null && (family(pick.model) !== family(now.model) || (now.effort !== '' && asLevel(now.effort) !== pick.effort))
  if (pick && isOther && raw) {
    const to: Route = { model: pick.model, effort: pick.effort }
    const other = await reprice($, raw, to)
    const q = adviceQuestion(to, now, pick.why, { nowUsd: made.estimate.likely, toUsd: other.estimate.likely, ctx: raw.facts.ctx })
    const answer = await askOne($, token, q.text, q.options)
    if (answer !== null && /^(switch|yes)\b/i.test(answer.trim())) {
      route = to
      made = other
    }
  }
  const place = async (): Promise<void> => {
    const card: Card = { kind: 'estimate', task, estimate: made.estimate, steps: made.steps.map(s => ({ name: s.name, usd: s.usd })), ...(route ? { route } : {}) }
    if (!isCardOnly) mem.offer = { task: taskIn, made, route }
    await placeCard($, `est-${await $.clock.now()}`, card, isCardOnly ? {} : { [OFFER]: card })
  }
  if (isCardOnly) {
    await place()
    return
  }

  if (limit !== undefined) {
    // A limit was given. When the likely cost is over it, the person chooses before anything starts.
    let cap = limit
    for (let round = 0; round < 8 && made.estimate.likely > cap && !first.isFallback; round++) {
      const cur: Route = route ?? { model: now.model, effort: now.effort }
      const tight = Math.max(tightOf(made.estimate), nice(made.estimate.likely))
      const q = overQuestion(made.estimate.likely, cap, cur, tight)
      const answer = await askOne($, token, q.text, q.options)
      const low = (answer ?? '').trim().toLowerCase()
      const le = lowerEffort(cur.effort)
      const lm = lowerModel(cur.model)
      if (answer !== null && low.startsWith(LOWER_EFFORT.toLowerCase()) && le && raw) {
        route = { model: cur.model, effort: le }
        made = await reprice($, raw, route)
      } else if (answer !== null && low.startsWith(LOWER_MODEL.toLowerCase()) && lm && raw) {
        route = { model: lm, effort: cur.effort }
        made = await reprice($, raw, route)
      } else if (answer !== null && /^(raise|add|set)\b/.test(low)) {
        cap = amountIn(answer) > cap ? amountIn(answer) : tight
        break
      } else if (answer !== null && /^keep\b/.test(low)) {
        // Typed words: keep the limit as it is. The 80% pause and the limit still guard the task.
        break
      } else if (answer !== null && amountIn(answer) > cap) {
        cap = amountIn(answer)
        break
      } else {
        // Stop, or no answer: nothing starts. The estimate stays in the chat.
        await place()
        await clearOffer($)
        $.ui.toast(`Nothing started. The likely cost is ${usd(made.estimate.likely)} and your limit was ${usd(cap)}.`)
        return
      }
    }
    await place()
    const out = await start($, cap, taskIn, { priced: made, route })
    $.ui.toast(out.text)
    return
  }

  await place()
  const e = made.estimate
  const suggested = defaultLimit(e)
  const labels = ['Start, no limit', `Start, limit ${usd(suggested)}`, 'Not now']
  // Changed in 0.8.0: one short line, then the buttons. The estimate card in the chat keeps the detail.
  // With no effort level seen and the same model, the advice is a target in this line (0.8.0).
  const target = !route && pick && now.effort === '' && family(pick.model) === family(now.model) ? ` Run this at ${pick.effort} effort.` : ''
  const text = `${startLine(e)}${target} Start?`
  const answer = await askOne($, token, text, labels)
  // No answer: the band above the prompt box keeps the Start buttons.
  if (answer === null) return
  const low = answer.trim().toLowerCase()
  if (/^(not now|no|skip|cancel|dismiss)\b/.test(low)) {
    await clearOffer($)
    return
  }
  const amount = amountIn(answer)
  // A button label carries its amount. Typed words can name a limit too.
  // "Start, no limit" holds the word "limit": it is read first (0.8.0).
  const pickOf = amount > 0 ? amount : /\bno limit\b/.test(low) ? 'track' : low.includes('safe') || low.includes('limit') ? 'default' : low.includes('tight') ? 'tight' : low.includes('likely') ? 'likely' : /^(start|yes|go|track)\b/.test(low) ? 'track' : null
  if (pickOf === null) return
  $.ui.toast(await startOffer($, pickOf))
}

const FAIL = 'The estimate did not work. Set an amount yourself: /budget 3! and then your task.'

export function offerSoon($: EngineInterface, task: string, isCardOnly: boolean, limit?: number): void {
  try {
    $.clock.after(60, () => {
      void offer($, task, isCardOnly, limit).catch(() => $.ui.toast(FAIL))
    })
  } catch {
    $.ui.toast(FAIL)
  }
}

// ---------- the live estimate: a small model reads the chat ----------

const LEFT_SPEC = `You read where a task in Claude Code stands. You say what share of the work is done, and which step the work is in.
You get the task, the steps that were counted before the start, Claude's task list when it has one, the count of tool calls, the last tool calls with what each one did, and the end of Claude's last messages.
Count work that is done, not time. Trust the tool calls more than the task list: Claude often does not update its list.
A task that is in its last check or its final answer is 90 or more. When Claude's last message is the final answer or the report of the task, answer 100.
When the last message asks the user a question before more work, the task is not done.
A task that still finds out what to do is under 20.
"step" is the number of the step the work is in now: a counted step, or an item of Claude's task list when no steps were counted. Use 0 when there are neither.
Claude's task list is often behind: when the tool calls show that later items are being done, the step is the later item.
Answer with one JSON object and nothing else: {"done": 0-100, "step": 0-12}`

/** The message for the small model that reads the chat. */
async function leftPrompt($: EngineInterface, b: Budget): Promise<string> {
  const lines = [`TASK\n${b.task.slice(0, 2000)}`]
  const steps = b.plan?.steps ?? []
  if (steps.length > 0 && b.plan?.source !== 'todos') lines.push('STEPS COUNTED BEFORE THE START\n' + steps.map((st, i) => `${i + 1}. ${st.name} [${st.state}]`).join('\n'))
  if (b.todos.length > 0) lines.push("CLAUDE'S TASK LIST\n" + b.todos.map((t, i) => `${i + 1}. [${t.status}] ${t.text}`).join('\n'))
  const used = Object.entries(b.used).filter(([, n]) => (n ?? 0) > 0).map(([c, n]) => `${c} ${n}`).join(', ')
  const want = b.estimate ? Object.entries(b.estimate.units).filter(([, n]) => (n ?? 0) > 0).map(([c, n]) => `${c} ${n}`).join(', ') : ''
  lines.push(`TOOL CALLS SO FAR\n${used || 'none'}${want ? `\nTOOL CALLS COUNTED BEFORE THE START\n${want}` : ''}`)
  const calls = b.calls ?? []
  if (calls.length > 0) lines.push('THE LAST TOOL CALLS, THE OLDEST FIRST\n' + calls.map(c => `- ${c}`).join('\n'))
  lines.push(`REQUESTS TO THE MODEL SO FAR\n${b.steps}`)
  try {
    const said = (await $.session.messages()).filter(m => m.role === 'assistant' && m.text.trim()).slice(-3)
    if (said.length > 0) lines.push("THE END OF CLAUDE'S LAST MESSAGES\n" + said.map(m => `- ${m.text.trim().slice(-700)}`).join('\n'))
  } catch {
    // no chat to read
  }
  lines.push('What share of the work of the TASK is done, and which counted step is the work in now? Answer with the JSON object only.')
  return lines.join('\n\n')
}

/** Added in the subagent fixes. How the small model sorts a subagent's task. Same idea as the model-router mod: fast work goes to Haiku, the rest to Sonnet. */
export const JUDGE_SPEC = [
  'You sort a task that a helper model will do. Answer with one word: fast or balanced.',
  'fast: simple, mechanical work. Find files, list, read and copy, rename, look up one fact.',
  'balanced: work that needs judgment. Writing, analysis, code changes, many steps, or anything you are not sure of.',
].join('\n')

/**
 * Added in the subagent fixes. A Haiku call picks Haiku or Sonnet for a subagent. Any failure gives Sonnet.
 * In a task with a budget, the call's cost counts as the mod's own cost.
 */
export async function judgeHelper($: EngineInterface, task: string): Promise<'haiku' | 'sonnet'> {
  let pick: 'haiku' | 'sonnet' = 'sonnet'
  let paid = 0
  try {
    const r = await $.model.complete({ model: 'haiku', effort: 'low', system: JUDGE_SPEC, prompt: `The task:\n${task.slice(0, 4000)}`, maxTokens: 10, timeoutMs: 8_000 })
    if (r.isAnswered && /^\W*fast\b/i.test(r.text)) pick = 'haiku'
    if (r.usage) paid = priceOf({ model: 'claude-haiku-5-5', ...r.usage })
  } catch {
    pick = 'sonnet'
  }
  if (paid > 0) {
    await update($, budget, c0 => {
      const c = live(c0)
      return c ? { ...c, modCost: round4((c.modCost ?? 0) + paid) } : c0
    }).catch(() => undefined)
  }
  return pick
}

/** One read of the chat by the small model: the share of the work that is done, and the step. Null when it gives no usable answer. */
async function readChat($: EngineInterface, b: Budget): Promise<{ part: number | null; step: number | null; usd: number } | null> {
  try {
    const r = await $.model.complete({ model: EST_MODEL, effort: 'low', system: LEFT_SPEC, prompt: await leftPrompt($, b), maxTokens: 60, timeoutMs: 30_000 })
    if (!r.isAnswered) return null
    // Added in 0.8.0: the read reports its own cost.
    const usd = r.usage ? priceOf({ model: 'claude-sonnet-5-5', ...r.usage }) : 0
    return { part: parseLeft(r.text), step: parseStep(r.text), usd }
  } catch {
    return null
  }
}

/** Fire and forget. At set spend marks a small model reads the chat and says what share of the work is done. The panel then shows a better course. */
export function checkSoon($: EngineInterface, b: Budget): void {
  if (mem.isChecking || !(mustCheck(b) || mustRead(b))) return
  mem.isChecking = true
  void (async () => {
    // The read is counted first, so a read that fails is not tried again at once.
    await update($, budget, c0 => {
      const c = live(c0)
      return c && c.id === b.id ? { ...c, checks: (c.checks ?? 0) + 1, readAt: c.spent, isStepNew: false } : c0
    })
    const said = await readChat($, b)
    if (!said) return
    await update($, budget, c0 => {
      const c = live(c0)
      if (!c || c.id !== b.id) return c0
      const paid = { ...c, modCost: round4((c.modCost ?? 0) + said.usd) }
      return said.part === null ? paid : withLeft(paid, said.part, said.step ?? undefined)
    })
  })()
    .catch(() => undefined)
    .finally(() => {
      mem.isChecking = false
    })
}

/** A budget that started with an amount: check its size in the background, and ask when it is clearly too small. */
export async function sizeCheck($: EngineInterface, id: string, task: string): Promise<void> {
  const made = await estimate($, task)
  let isSmall = false
  let isKept = false
  await update($, budget, c0 => {
    const c = live(c0)
    if (!c || c.id !== id) return c0
    isKept = true
    // Clearly too small: 3 of 4 such tasks cost more than the budget.
    isSmall = !made.isFallback && leastOf(made.estimate) > c.limit && !c.ask
    return { ...c, estimate: made.estimate, similar: c.similar ?? made.estimate.similar, ask: isSmall ? ({ kind: 'small' } as const) : c.ask, modCost: round4((c.modCost ?? 0) + made.estimate.cost) }
  })
  if (!isKept) return
  $.ui.toast(`Estimate for this task: ${estimateLine(made.estimate)}.` + (isSmall ? ' That is more than your limit, so Claude pauses and asks you.' : ''))
}

/**
 * Added in the subagent fixes. The person added to the task: estimate the whole task again, quietly. The band and the panel
 * take the new numbers. No toast and no question, unless the new estimate passes the limit, and then one time only.
 */
export async function regrow($: EngineInterface, id: string, task: string): Promise<void> {
  const made = await estimate($, task)
  await update($, budget, c0 => {
    const c = live(c0)
    if (!c || c.id !== id) return c0
    const paid = round4((c.modCost ?? 0) + made.estimate.cost)
    if (made.isFallback || !c.estimate || made.estimate.likely <= c.estimate.likely) return { ...c, modCost: paid, regrows: (c.regrows ?? 0) + 1 }
    const isOver = c.limit > 0 && !c.isOpen && !c.isGrowAsked && !c.ask && leastOf(made.estimate) > c.limit
    return {
      ...c,
      estimate: made.estimate,
      modCost: paid,
      regrows: (c.regrows ?? 0) + 1,
      ...(isOver ? { ask: { kind: 'small' } as const, isGrowAsked: true } : {}),
    }
  })
}

/** Added in the subagent fixes. Keep a subagent this budget started, with what it will likely cost on its model. */
export async function addSpawn($: EngineInterface, id: string, agentId: string, model: string): Promise<void> {
  const book = await loadBook($)
  await update($, budget, c0 => {
    const c = live(c0)
    if (!c || c.id !== id || (c.spawns ?? []).some(x => x.id === agentId)) return c0
    const count = (c.spawns ?? []).length
    const sp: Spawn = { id: agentId, model, usd: helperUsd(book, model), used: 0, isRunning: true, isExtra: count >= (c.estimate?.helpers ?? 0) }
    let n: Budget = { ...c, spawns: [...(c.spawns ?? []), sp] }
    // More subagents than the estimate had: the forecast takes each one at once. One question at most, only when the
    // task is now on course to pass the limit well.
    const f = forecast(n)
    if (sp.isExtra && n.limit > 0 && !n.isOpen && !n.isTrack && !n.isGrowAsked && !n.ask && n.phase === 'run' && f && f.usd >= n.limit * 1.2 - 1e-9) {
      n = { ...n, ask: { kind: 'early' }, isGrowAsked: true }
    }
    return n
  })
}

// ---------- starting and changing a budget ----------

/**
 * Start a budget. `isInline` means the task is the message that is on its way in right now:
 * the caller sends it on, so nothing is submitted here and the message is counted at once.
 */
export async function start($: EngineInterface, limitIn: number, taskIn: string, opts: StartOpts = {}): Promise<Started> {
  const isInline = opts.isInline === true
  const { token, text: task } = testToken(taskIn)
  const limit = round2(limitIn)
  const usage = await $.session.usage()
  const model = await $.session.model()
  const now = await $.clock.now()
  const isFresh = await isFreshChat($, usage)
  const log = await loadLog($)
  const book = await loadBook($)
  const hasCount = Boolean(usage.context.tokens && usage.context.tokens > 0)
  let fresh: Fresh | null = null
  if (isFresh && hasCount) {
    fresh = { tokens: usage.context.tokens ?? 0, how: 'measured' }
  } else if (isFresh) {
    await measureIdle($)
    fresh = freshFrom(log.base, log.calib, await folder($), mem.idleRaw, 'idle', mem.idleParts ?? undefined, await $.session.model())
  }
  const route = opts.route ?? null
  const isTrack = opts.isTrack === true
  // The first request runs on the model of the route, when the person took the advice.
  const est = await mainEst($, null, route?.model ?? model, usage, now, fresh)
  const typical = est.later ?? est.cost
  // Added in 0.8.0: the default limit (the learned multiple times the likely cost), or more, is never refused. The estimate counted the chat start in the likely cost.
  const isDefault = Boolean(opts.priced && limit >= defaultLimit(opts.priced.estimate) - 0.005)
  if (!opts.isForced && !isTrack && !isDefault && est.cost > limit - reserveOf(limit, typical)) {
    const least = nice((est.cost + 2 * typical) * 1.25)
    return {
      isSet: false,
      text:
        `${usd(limit)} is too small here. The next request costs about ${usd(est.cost)}, because ${est.why}. ` +
        `Set at least ${usd(least)}, for example /budget ${least}. ` +
        `To set it anyway, type /budget ${limit}! and Claude pauses at the first request.`,
    }
  }
  const old = await finish($, 'replaced')
  const id = String(now)
  const willSend = Boolean(task) && !isInline
  const priced = opts.priced ?? null
  let plan: Plan | null = null
  if (priced) plan = planFromEstimate(priced.steps, limit, 0)
  let similar = priced?.estimate.similar ?? null
  if (!similar && task && book) {
    const close = similarTurns(book.turns, task, 5)
    if (close.length >= 2) similar = { cost: round2(quantile(close.map(m => m.turn.usd + m.turn.hu), 0.5)), runs: close.length }
  }
  // Added in 0.8.0: the estimate and the advice of this run were paid before the start. They count in the spend and the limit.
  const pending = priced ? mem.modPending : 0
  mem.modPending = 0
  const startCost = Math.max(0, (usage.cost?.usd ?? 0) - pending)
  const next: Budget = {
    ...newBudget({ limit, task, startCost, model, isFresh, id, now }),
    // The paid estimate and advice are in the spend from the first second.
    ...(pending > 0 ? { modCost: pending, spent: round4(Math.max(0, (usage.cost?.usd ?? 0) - startCost)) } : {}),
    similar,
    messages: isInline && task ? 1 : 0,
    bars: isInline && task ? [0] : [],
    plan,
    pending: willSend ? task : '',
    firstTokens: fresh?.tokens ?? 0,
    estimate: priced?.estimate ?? null,
  }
  const effort = route?.effort || (await effortNow($))
  if (effort) next.effort = effort
  if (route) next.route = route
  // Added after 0.8.0: how this type of task spends, and its pause point, from the memory. Never fatal.
  if (task) {
    const top = (await readMemory($, task, false).catch(() => null))?.top ?? null
    if (top?.path) next.typePath = top.path
    if (top && (top.ease ?? 1) > 1) next.ease = top.ease
  }
  if (isTrack) {
    // Track only: the count runs and nothing stops the task. The safe amount stays as the mark in the panel.
    next.isTrack = true
    next.isOpen = true
  }
  if (token) next.test = token
  await $.state.set(REF, next)
  await clearOffer($)
  $.ui.status(statusText(next))
  if (willSend) sendSoon($, task, () => markSent($, task))
  // The task rides in the message that goes out now: log the run at once, so a chat that is closed still has it.
  else if (task) await saveRun($, runOf(next, 'open', iso(now))).catch(() => undefined)
  // An amount with no estimate: check the size while Claude starts.
  if (task && !priced) {
    try {
      $.clock.after(300, () => {
        void sizeCheck($, id, task).catch(() => undefined)
      })
    } catch {
      // no timer: the budget runs without a size check
    }
  }
  if (isTrack) {
    const e = priced?.estimate
    const lines = [
      'The count runs from now. No limit is set.',
      e ? `The estimate is ${usd(e.likely)}.` : '',
      route ? `This task runs on ${routeName(route)}. Your settings do not change.` : '',
      old ? `The old budget is closed: ${usd(old.spent)} used.` : '',
      willSend ? 'Your task starts now.' : '',
      'To add a limit, type /budget set 5. Open the panel with /budget panel.',
    ]
    // No note for Claude: Claude does not know that the cost is counted.
    return { isSet: true, text: lines.filter(Boolean).join(' ') }
  }
  const lines = [
    `Budget set: ${usd(limit)}, counted from now.`,
    route ? `This task runs on ${routeName(route)}. Your settings do not change.` : '',
    'Claude does not see the limit. When the task is on course to pass it, the chat pauses and asks you.',
    est.later
      ? `The first request costs about ${usd(est.cost)} (${est.why}). Later requests cost about ${usd(est.later)} each, so about ${fits(next, est.cost, est.later)} fit.`
      : `Each request costs about ${usd(est.cost)} here (${est.why}), so about ${fits(next, est.cost)} fit.`,
    !priced && similar ? `Similar past tasks of yours cost about ${usd(similar.cost)}.` : '',
    plan && plan.steps.length > 0 ? `The estimate gave ${plan.steps.length} steps. The panel shows the cost of each one.` : '',
    old ? `The old budget is closed: ${usd(old.spent)} of ${usd(old.limit)} used.` : '',
    willSend ? 'Your task starts now.' : '',
    'Open the panel with /budget panel.',
  ]
  // No note for Claude (0.8.0): the limit stays with the person and the code.
  return { isSet: true, text: lines.filter(Boolean).join(' ') }
}

/** Change the limit and keep the spend. With a plan, the change lands in the buffer. */
export async function changeLimit($: EngineInterface, to: number): Promise<{ isOk: boolean; text: string }> {
  const b = await cur($)
  if (!b) return { isOk: false, text: HELP }
  const usage = await $.session.usage()
  const spent = spentOf(b, usage.cost?.usd)
  const limit = round2(to)
  if (!(limit > 0) || limit < spent) return { isOk: false, text: `The budget cannot go under what is spent: ${usd(spent)}.` }
  let plan = b.plan
  if (plan && plan.steps.length > 0) {
    const reserve = round2(plan.reserve + (limit - b.limit))
    if (reserve < 0) return { isOk: false, text: `Only ${usd(plan.reserve)} is not given to a step. Lower a step amount first.` }
    plan = { ...plan, reserve }
  }
  const isUp = limit > b.limit
  const next: Budget = {
    ...b,
    limit,
    spent,
    plan,
    // A task that had no limit gets its first limit: that is not money added to a limit.
    raised: b.isTrack ? (b.raised ?? 0) : round2((b.raised ?? 0) + Math.max(0, limit - b.limit)),
    // A new limit is a limit again.
    isOpen: false,
    isTrack: false,
    isPaused: isUp ? false : b.isPaused,
    isMidTurn: isUp ? false : b.isMidTurn,
    // More money answers a question about too little money.
    ask: isUp ? null : b.ask,
    isHandedOff: isUp ? false : b.isHandedOff,
  }
  await $.state.set(REF, next)
  $.ui.status(statusText(next))
  // Claude was stopped mid-task: carry on without the person typing "go ahead".
  if (isUp && b.isPaused && b.isMidTurn) sendSoon($, 'Continue from where you stopped.')
  return {
    isOk: true,
    text: b.isTrack
      ? `Limit set: ${usd(limit)}. Spent ${usd(spent)}, ${usd(limit - spent)} left.`
      : `Budget ${isUp ? 'raised' : 'lowered'} from ${usd(b.limit)} to ${usd(limit)}. Spent ${usd(spent)}, ${usd(limit - spent)} left.`,
  }
}

/** Raise the limit: the amount is added to the limit that stands, and the spend is kept. */
export async function raise($: EngineInterface, amount: number): Promise<string | null> {
  const b = await cur($)
  if (!b) return null
  return (await changeLimit($, b.limit + amount)).text
}

/** Change one row of the plan by one press. The budget total follows, so the rows still add up. */
export async function adjust($: EngineInterface, row: number | 'reserve', by: number): Promise<void> {
  const b = await cur($)
  const p = b?.plan
  if (!b || !p || p.steps.length === 0) return
  const was = row === 'reserve' ? p.reserve : p.steps[row]?.usd
  if (was === undefined) return
  const want = round2(Math.max(0, was + by))
  const diff = round2(want - was)
  if (diff === 0) return
  const usage = await $.session.usage()
  const spent = spentOf(b, usage.cost?.usd)
  const limit = round2(b.limit + diff)
  if (limit < spent) {
    $.ui.toast(`The budget cannot go under what is spent: ${usd(spent)}.`)
    return
  }
  const plan: Plan = row === 'reserve' ? { ...p, reserve: want } : { ...p, steps: p.steps.map((st, i) => (i === row ? { ...st, usd: want } : st)) }
  const isUp = diff > 0
  const next: Budget = {
    ...b,
    limit,
    spent,
    plan,
    raised: round2((b.raised ?? 0) + Math.max(0, diff)),
    isOpen: false,
    isTrack: false,
    isPaused: isUp ? false : b.isPaused,
    isMidTurn: isUp ? false : b.isMidTurn,
  }
  await $.state.set(REF, next)
  $.ui.status(statusText(next))
  if (isUp && b.isPaused && b.isMidTurn) sendSoon($, 'Continue from where you stopped.')
}

/** The person chose to finish now: no new work, one last answer. */
export async function land($: EngineInterface): Promise<string> {
  const b = await cur($)
  if (!b) return HELP
  const wasPaused = b.isPaused
  await $.state.set(REF, { ...b, phase: 'landing', isPaused: false, isMidTurn: false, ask: null, waiting: '' })
  if (wasPaused) sendSoon($, 'Finish now. Do not start new work. Write your final answer: what is done, what is not done, and where each file or result is.')
  return 'Claude finishes now: one last answer with what is done and what is not.'
}

export async function openPanel($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
}

export function pricesText(view: BookView | null, book: Book | null): string {
  if (!view || view.tasks === 0 || !book) return 'No past chats are read yet. Type /budget learn to read them.'
  const rows = view.kinds.map(k => `${kindLabel(k.kind)}: about ${usd(k.p50)} (most between ${usd(k.p25)} and ${usd(k.p90)}, ${k.n} tasks)`)
  const helpers = Object.entries(book.help)
    .filter(([, list]) => list.length >= 8)
    .map(([fam, list]) => `${fam} about ${usd(quantile(list, 0.5))}`)
  return (
    `What your tasks cost, from ${view.tasks} tasks in ${view.files} past chats. ${rows.join('. ')}.` +
    (helpers.length > 0 ? ` One helper: ${helpers.join(', ')}.` : '')
  )
}

// ---------- the pause: a request must wait for the person ----------

/** Stop without a question: the turn ends, a row in the chat says why, and the band has the buttons. */
export async function pause($: EngineInterface, b: Budget, spent: number, isInStep = false): Promise<void> {
  await update($, budget, c0 => (live(c0)?.id === b.id ? { ...(live(c0) ?? b), spent, isPaused: true, isMidTurn: true, waiting: '', ask: null } : c0))
  $.ui.status(statusText({ ...b, spent, isPaused: true }))
  $.ui.toast(`Budget stop: ${usd(spent)} of ${usd(b.limit)} spent. To go on, raise the limit above the prompt box.`)
  await placeCard($, `stop-${b.id}-${b.steps}-${b.seen.length}`, { kind: 'stop', spent, limit: b.limit })
  void saveRun($, runOf({ ...b, spent }, 'stopped', iso(await $.clock.now()))).catch(() => undefined)
  await stopAgents($, b, { isAbort: !isInStep })
}

/**
 * Added in the subagent fixes. End this budget's running subagents, then the main turn.
 * TaskStop goes first, one call for each subagent the budget started that still runs. Each call is caught: a refused call
 * leaves that subagent in mem.stopped, and the tool.call and turn.step hooks refuse its next call.
 * The main turn is aborted last, and only when the stop did not come from inside a main request (that request is refused anyway).
 */
export async function stopAgents($: EngineInterface, b: Budget, opts: { isAbort: boolean }): Promise<string[]> {
  // The budget a question was asked with can be older than the last subagents it started. Read the current one.
  const now = await cur($).catch(() => null)
  const spawns = (now && now.id === b.id ? now.spawns : b.spawns) ?? []
  const mine = new Set(spawns.map(s => s.id))
  let running: string[] = []
  try {
    const all = await $.agent.list()
    running = all.filter(a => mine.has(a.id) && (a.status === 'running' || a.status === 'pending' || a.status === 'waiting')).map(a => a.id)
  } catch {
    running = spawns.filter(s => s.isRunning).map(s => s.id)
  }
  for (const id of mine) mem.stopped.add(id)
  // Held requests wake up now, see the stop, and are not sent.
  releaseAgents()
  // The calls are sent in this order and not awaited: a stop can come from inside a subagent request that waits on the
  // question, and TaskStop may wait for that request to end.
  for (const id of running) {
    mem.stopping.add(id)
    // @ts-ignore TS2589: the full tool union is too deep for the type checker. The call shape is the TaskStop input.
    void $.tool.call({ tool: 'TaskStop', task_id: id })
      .catch(() => undefined)
      .finally(() => mem.stopping.delete(id))
  }
  if (opts.isAbort && mem.mainTurn) {
    const turnId = mem.mainTurn
    mem.mainTurn = ''
    void $.turn.abort({ turnId }).catch(() => undefined)
  }
  await update($, budget, c0 => {
    const c = live(c0)
    return c && c.id === b.id && (c.spawns ?? []).some(x => x.isRunning) ? { ...c, spawns: (c.spawns ?? []).map(x => ({ ...x, isRunning: false })) } : c0
  }).catch(() => undefined)
  return running
}

/** Added in the subagent fixes. The Stop button in the panel: stop the task now, its subagents and the main turn too. */
export async function stopNow($: EngineInterface): Promise<string> {
  const b = await cur($)
  if (!b) return HELP
  const usage = await $.session.usage()
  await pause($, b, spentOf(b, usage.cost?.usd))
  return 'Stopped. Claude and its helpers are stopped. Raise the limit, hand off, or end the budget.'
}

/** Whether a question that waited is still true when its turn to be asked comes. */
export function isStill(why: Why, b: Budget): boolean {
  if (why.kind === 'early') {
    const f = forecast(b)
    return Boolean(f && f.usd >= b.limit * EARLY_OVER * easeOf(b) - 1e-9)
  }
  if (why.kind === 'near') {
    const f = forecast(b)
    return Boolean(f && f.usd > b.limit * 1.05 * easeOf(b))
  }
  if (why.kind === 'small') return Boolean(b.estimate && leastOf(b.estimate) > b.limit)
  return true
}

/** Ask the person, and do what they chose. The chat waits, and loses nothing. */
export async function askGate($: EngineInterface, b: Budget, why: Why, spent: number, est: number, typical = est, isMainStep = false): Promise<void> {
  // The raise covers what is out now: the requests in flight and the running subagents at their usual cost.
  const q = questionFor(why, { ...b, spent }, spent, est, forecast({ ...b, spent }), typical, aheadOf(b) + mem.inflight)
  await update($, budget, c0 => {
    const c = live(c0)
    return c && c.id === b.id ? { ...c, spent, waiting: q.short } : c0
  })
  $.ui.status(statusText({ ...b, spent, waiting: q.short }))
  // A person who is away gets a notice after a short wait.
  void $.ui.notify(q.text, { title: 'Budget pause', key: NOTIFY, delayMs: 20_000 }).catch(() => undefined)
  let answer: string | null = null
  if (b.test) {
    answer = await testAnswer($, b.test)
  } else {
    try {
      answer = await $.ui.ask(q.text, { options: q.options, header: q.header })
    } catch {
      answer = null
    }
  }
  void $.ui.cancelNotify(NOTIFY).catch(() => undefined)
  // Added in the subagent fixes: every question goes in the history, with the answer. After an answer the gate stays quiet
  // until the spend rises by about 10% of the limit.
  // Added after 0.8.0: the course at the question, so the memory can tell a false alarm later.
  const course = forecast({ ...b, spent })?.usd
  const said: AskLog = { kind: why.kind, spent: round2(spent), limit: b.limit, answer: answer ?? 'none', at: iso(await $.clock.now()), ...(typeof course === 'number' && course > 0 ? { course: round2(course) } : {}) }
  await update($, budget, c0 => {
    const c = live(c0)
    return c && c.id === b.id ? { ...c, asks: [...(c.asks ?? []), said].slice(-30), ...(answer !== null ? { quietTo: round2(spent + QUIET * Math.max(c.limit, b.limit)) } : {}) } : c0
  })
  const isMoney = why.kind === 'cap' || why.kind === 'hard' || why.kind === 'near'
  // The 80% pause is asked one time at a limit, and the 50% pause one time in a task, whatever the answer is.
  if (why.kind === 'near' || why.kind === 'early') {
    await update($, budget, c0 => {
      const c = live(c0)
      if (!c || c.id !== b.id) return c0
      const ask = c.ask?.kind === why.kind ? null : c.ask
      return why.kind === 'near' ? { ...c, nearAt: c.limit, ask } : { ...c, isEarlyAsked: true, ask }
    })
  }
  // No answer: a pause stops, the size question carries on.
  const d: Decision = answer === null ? (isMoney || why.kind === 'early' ? { act: 'stop' } : { act: 'go' }) : decide(why, answer, b)

  if (d.act === 'open') {
    const now = await cur($)
    if (!now || now.id !== b.id) return
    $.ui.toast(await keepGoing($))
    return
  }

  if (d.act === 'add' || d.act === 'set') {
    const now = await cur($)
    if (!now || now.id !== b.id) return
    const out = await changeLimit($, d.act === 'add' ? now.limit + d.usd : d.usd)
    await update($, budget, c0 => {
      const c = live(c0)
      if (!c || c.id !== b.id) return c0
      // The person saw the course and chose this limit: the forecast question is not asked again at it.
      return { ...c, waiting: '', ask: out.isOk ? null : c.ask }
    })
    $.ui.toast(out.text)
    return
  }
  if (d.act === 'stop') {
    await pause($, b, spent, isMainStep)
    return
  }
  if (d.act === 'handoff') {
    await handoff($, b, spent, isMainStep)
    return
  }
  // Keep going at the 50% pause, or carry on after the size question: the limit stays.
  let shown: Budget | null = null
  await update($, budget, c0 => {
    const c = live(c0)
    if (!c || c.id !== b.id) return c0
    let n: Budget = { ...c, waiting: '', ask: null }
    if (why.kind === 'near') n = { ...n, nearAt: c.limit }
    if (why.kind === 'early') n = { ...n, isEarlyAsked: true }
    shown = n
    return n
  })
  const after = shown as Budget | null
  if (after) $.ui.status(statusText(after))
}

// ---------- the hand off (0.8.0) ----------
// No mod call opens a new chat on a model the mod picks. So the mod writes a note, copies it, and stops the chat.
// The person opens a new chat on the cheaper model and pastes the note.

export const HANDOFF_FILE = 'task-budget-handoff.md'
const MODEL_WORDS = { sonnet: 'Sonnet', haiku: 'Haiku' } as const

/** The handoff note. It holds the work, never the budget: no amount, no limit, no cost. */
export function handoffNote(b: Budget, last: string): string {
  const todos = b.todos.map(t => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.text}`)
  const calls = (b.calls ?? []).slice(-10).map(c => `- ${c}`)
  const tail = last.trim().slice(-1200)
  return [
    'Carry on with a task that another chat started. Read this note first.',
    '',
    `Task: ${b.task || 'see the chat this note came from'}`,
    ...(todos.length > 0 ? ['', 'Progress (x is done, ~ is in progress):', ...todos] : []),
    ...(calls.length > 0 ? ['', 'The last actions of the other chat:', ...calls] : []),
    ...(tail ? ['', 'Where the other chat stopped (the end of its last message):', tail] : []),
    '',
    'Pick up where it stopped. Check the files named above before you change them, and do not redo finished steps.',
  ].join('\n')
}

/**
 * Added after 0.8.0: the Handoff mod (~/.claude/mods/handoff) writes a full handoff of the chat in its own panel,
 * with a summary, the files, skills and connectors used, and a prompt that opens a new chat. The mod asks it to run
 * the same way Cache Clock does: one request file that the Handoff mod reads every 5 seconds. The path, or '' when the
 * Handoff mod is not installed or its switch in ~/.claude/mods/switches.json is off. Then the old note is used.
 */
/** True when the Handoff mod is installed: as a local mod, or from any plugin marketplace (~/.claude/plugins/cache/<pack>/handoff/<version>). */
async function handoffInstalled($: EngineInterface, home: string): Promise<boolean> {
  const has = (p: string) => $.fs.exists(p).catch(() => false)
  if (await has(`${home}/.claude/mods/handoff/hooks/register.tsx`)) return true
  const cache = `${home}/.claude/plugins/cache`
  const packs = await $.fs.list(cache).catch(() => [])
  for (const pack of packs) {
    if (pack.kind !== 'dir') continue
    const vers = await $.fs.list(`${cache}/${pack.name}/handoff`).catch(() => [])
    for (const v of vers) if (v.kind === 'dir' && (await has(`${cache}/${pack.name}/handoff/${v.name}/hooks/register.tsx`))) return true
  }
  return false
}

export async function handoffRequest($: EngineInterface): Promise<string> {
  try {
    const home = (await homeOf($))
    if (!home) return ''
    if (!(await handoffInstalled($, home))) return ''
    const raw = String(await $.fs.read(`${home}/.claude/mods/switches.json`).catch(() => '') || '{}')
    const sw = JSON.parse(raw) as Record<string, unknown>
    if (sw['handoff'] === false) return ''
    const sid = await $.session.id()
    return sid ? `${home}/.claude/handoffs/.request-${sid}` : ''
  } catch {
    return ''
  }
}

/** Write the request file. The Handoff mod forks the chat, so the file waits until the main turn has ended. */
export async function askHandoff($: EngineInterface): Promise<void> {
  const path = mem.handoffAsk
  if (!path || mem.mainTurn) return
  mem.handoffAsk = ''
  await $.fs.write(path, String(await $.clock.now())).catch(() => undefined)
}

/** Hand off: ask the Handoff mod for its panel, or write the note, copy it, keep a copy in a file. Then stop the chat. */
export async function handoff($: EngineInterface, b: Budget, spent: number, isInStep = false): Promise<void> {
  const to = handoffModel(b.lastModel || b.model)
  const word = to ? MODEL_WORDS[to] : 'a cheaper model'
  const note = handoffNote(b, await lastAnswer($))
  const request = await handoffRequest($)
  if (request) {
    // The note stays in a file as a spare. The Handoff panel has its own Copy and Start new chat.
    const file = await fileOf($, HANDOFF_FILE)
    await $.fs.write(file, note + '\n').catch(() => undefined)
    await update($, budget, c0 => (live(c0)?.id === b.id ? { ...(live(c0) ?? b), spent, isPaused: true, isMidTurn: true, isHandedOff: true, waiting: '', ask: null } : c0))
    $.ui.status(statusText({ ...b, spent, isPaused: true }))
    $.ui.toast(`The Handoff panel opens above the prompt box. Press Start new chat there, then pick ${word}.`)
    await placeCard($, `hand-${b.id}-${b.steps}`, { kind: 'handoff', note, model: word, isCopied: false, file, isPanel: true })
    void saveRun($, runOf({ ...b, spent }, 'stopped', iso(await $.clock.now()))).catch(() => undefined)
    mem.handoffAsk = request
    await stopAgents($, b, { isAbort: !isInStep })
    await askHandoff($)
    return
  }
  let isCopied = false
  try {
    isCopied = (await $.ui.copy({ text: note })).isCopied
  } catch {
    isCopied = false
  }
  if (!isCopied) {
    try {
      // Linux copy: Wayland, then X11; whichever clipboard tool is installed answers.
      for (const cmd of [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']]) {
        try {
          const r = await $.process.run(cmd, { stdin: note })
          if (r.exitCode === 0) {
            isCopied = true
            break
          }
        } catch {
          continue
        }
      }
    } catch {
      isCopied = false
    }
  }
  const file = await fileOf($, HANDOFF_FILE)
  await $.fs.write(file, note + '\n').catch(() => undefined)
  await update($, budget, c0 => (live(c0)?.id === b.id ? { ...(live(c0) ?? b), spent, isPaused: true, isMidTurn: true, isHandedOff: true, waiting: '', ask: null } : c0))
  $.ui.status(statusText({ ...b, spent, isPaused: true }))
  $.ui.toast(isCopied ? `Handoff note copied. Open a new chat on ${word} and paste it.` : `The copy did not work. The note is in ${file}. Open a new chat on ${word} and paste it.`)
  await placeCard($, `hand-${b.id}-${b.steps}`, { kind: 'handoff', note, model: word, isCopied, file })
  void saveRun($, runOf({ ...b, spent }, 'stopped', iso(await $.clock.now()))).catch(() => undefined)
  await stopAgents($, b, { isAbort: !isInStep })
}

/**
 * The answer a request gets when it was not sent. The text is streamed, so the person sees it and the chat keeps it:
 * a result alone is read by the hooks above and shown to nobody, and the engine then counts the turn as failed.
 */
export async function* unsent(e: { turnId: string; index: number }, answer: string) {
  yield { kind: 'text' as const, index: 0, text: answer }
  yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
}


// ---------- the ledger ----------
// One line per request in ~/.claude/mods-logs/task-budget-ledger.jsonl. It shows nothing and changes nothing:
// every call is caught, and the write runs after the step has returned.

/** The engine's own session cost now, or null when the host has none. */
export async function billNow($: EngineInterface): Promise<number | null> {
  try {
    const u = await $.session.usage()
    return typeof u.cost?.usd === 'number' ? u.cost.usd : null
  } catch {
    return null
  }
}

type StepIn = { turnId: string; index: number; effort?: string | number; agentId?: string }
type StepOut = { usage: LiveIn['usage']; toolUses: readonly { name: string }[]; serverToolUses?: readonly { name: string }[] }

/** Fire and forget: the line for one request that came back. */
export function ledgerAfter($: EngineInterface, e: StepIn, r: StepOut, billBefore: number | null): void {
  if (!r.usage) return
  void (async () => {
    const billAfter = await billNow($)
    const line = liveLine({
      at: await $.clock.now(),
      session: await $.session.id(),
      ...(e.agentId ? { agentId: e.agentId } : {}),
      turnId: e.turnId,
      index: e.index,
      ...(e.effort !== undefined ? { effort: e.effort } : {}),
      usage: r.usage,
      tools: r.toolUses.map(t => t.name),
      advisorCalls: (r.serverToolUses ?? []).filter(t => t.name === 'advisor').length,
      billBefore,
      billAfter,
    })
    if (!line) return
    const fs = { read: (p: string) => $.fs.read(p) as Promise<string>, write: (p: string, t: string) => $.fs.write(p, t), exists: (p: string) => $.fs.exists(p) }
    await queueLine(fs, await fileOf($, LEDGER_FILE), line)
  })().catch(() => undefined)
}

/** The Hand off button in the band or the panel: the same as the answer in the pause question. */
export async function handoffNow($: EngineInterface): Promise<string> {
  const b = await cur($)
  if (!b) return HELP
  if (!handoffModel(b.lastModel || b.model)) return 'This task already runs on the cheapest model. Choose Raise the limit or Stop.'
  const usage = await $.session.usage()
  await handoff($, b, spentOf(b, usage.cost?.usd))
  return mem.handoffAsk || (await handoffRequest($)) ? 'The Handoff panel opens above the prompt box.' : 'Handoff note copied. Open a new chat on a cheaper model and paste it.'
}


/** Linux copy: the home folder is HOME, with USERPROFILE as the fallback. Backslashes become forward slashes. */
export async function homeOf($: EngineInterface): Promise<string> {
  const v = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined)) || ''
  return v.replace(/\\/g, '/')
}
