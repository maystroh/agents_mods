// Added in the subagent fixes (fix 13). The learning memory of the estimate.
// One index file of at most 200 lines points to one file per type of task. The Sonnet estimate reads the index and
// up to 2 type files every time. Each finished task is one line in runs.jsonl, and every .md file is rebuilt from it.
// Code writes the numbers. A small model writes one lesson line after a miss of 2 times or more.
// Everything here is pure: the reads and writes are in engine.ts.

import { family, priceFor, quantile } from './book.ts'
import { nice } from './estimator.ts'
import { STARTER, type StarterType } from './starter.ts'
import type { TypePath } from '../types'

/** The folder of the memory, under ~/.claude/mods-logs/. */
export const MEM_DIR = 'task-budget-memory'
export const INDEX_MAX = 200
export const TYPE_MAX = 150
/** A type with fewer runs than this is merged into other.md. */
export const RARE = 5
/** After this many runs of a type, the person's own figures take full weight over the starter figures. */
export const OWN_FULL = 10
/** Runs with subagents a type needs before its own subagent figures count. */
export const SUB_MIN = 3

/** One finished task. The true source: every .md file can be rebuilt from these lines. */
export type MemRun = {
  at: string
  type: string
  task: string
  model: string
  effort: string
  kind?: string
  skill?: string
  /** Subagents the task started, their model, and what each cost (dollars). */
  subs?: number
  subModel?: string
  subUsd?: number[]
  estimate?: number | null
  low?: number | null
  high?: number | null
  cost: number
  limit?: number | null
  outcome?: string
  asks?: number
  /** Where the line came from: the mod, or the seed from the spend review (2026-11-16). */
  source?: string
  /** Added after 0.8.0: the cost path. Each point is [share of the task-list done, spend in dollars]. */
  path?: [number, number][]
  /** Added after 0.8.0: the spend when each step of Claude's task list started. -1: no figure. */
  stepAt?: number[]
  /** Added after 0.8.0: the start cost (the chat start) inside the cost. */
  start?: number
  /** Added after 0.8.0: each question with its figures and answer. */
  qs?: MemAsk[]
}
/** One question of a run. `falseAlarm`: a soft question (early, near or cap), and the run then ended under the limit it had at the question. */
export type MemAsk = { kind: string; spent: number; limit: number; course?: number; answer: string; falseAlarm?: boolean }
/** One lesson after a big miss. It lives in runs.jsonl too, so it survives every rebuild. */
export type MemLesson = { at: string; type: string; lesson: string }
export type MemLine = MemRun | MemLesson

export function isLesson(x: MemLine): x is MemLesson {
  return typeof (x as MemLesson).lesson === 'string'
}

// ---------- types of work ----------

/** The types of work, in general words. The starter figures use the same names. */
export const WORK_LABEL: Record<string, string> = {
  claude_tools: 'Building Claude Code tools, skills or plugins',
  writing: 'Writing: scripts, posts, outlines and drafts',
  video_media: 'Video, audio and media',
  notes_docs: 'Notes and documents',
  design: 'Design, slides and web pages',
  research: 'Research',
  code: 'Code, data and automation',
  sales: 'Sales and CRM',
  inbox: 'Inbox and email',
  other: 'Other',
}

/** The skill, the folder, and words in the task. The task is all an estimate has. */
const RULES: Record<string, [RegExp, RegExp, RegExp]> = {
  claude_tools: [
    /plugin|^mod|skill-creator|skill-builder|statusline|slash-command|agent-sdk/,
    /\.claude\/(plugins|skills|mods|agents|commands|hooks)|claude-plugins?|claude-mods?/,
    /\b(mods?|plugins?|hooks?|status ?line|slash commands?|mcp servers?|skill\.md|new skills?)\b/,
  ],
  writing: [
    /write|writer|writing|script|outline|copy|blog|newsletter|essay|humanizer|title/,
    /scripts?|writing|drafts?|blog|content|newsletter/,
    /\b(write|rewrite|draft|scripts?|pre-?outlines?|outlines?|teleprompter|blog posts?|posts?|articles?|essays?|copy|newsletters?|titles?|brain ?dump|talking points)\b/,
  ],
  video_media: [
    /video|remotion|caption|reel|motion|animat|audio|music|sound|ffmpeg|clip|transcri/,
    /video|motion|media|footage|audio|podcast/,
    /\b(videos?|video edit|edit(ing)? (the|this) video|render(ing|ed)?|footage|b-?roll|motion graphics?|captions?|clips?|timeline|recording|overlays?|animat\w*|frames?|zoom ?ins?|cuts?|ffmpeg|mp4|audio|podcast)\b/,
  ],
  notes_docs: [
    /notes?|memory|obsidian|notion|file-organi|journal|wiki|consolidate/,
    /notes|docs|documents|vault|wiki|journal|obsidian|second-brain/,
    /\b(notes?|notebook|vault|memory|daily note|journal|wiki|documents?|docs|file (it|this)|organi[sz]e (my )?files|task list|to-?do list)\b/,
  ],
  design: [
    /design|figma|frontend|ui-ux|slides|deck|carousel|marp|infographic|thumbnail|pptx|excalidraw|logo|canvas/,
    /design|landing|website|site|slides|deck/,
    /\b(landing page|website|web ?page|redesign|design system|homepage|hero|ui|slides?|deck|carousel|thumbnails?|infographics?|diagrams?|logo|mock-?ups?|wireframes?)\b/,
  ],
  research: [
    /research|firecrawl|competitor|fact-check|review-mining|search|scrape/,
    /research/,
    /\b(research|find out|look up|compare|which (one|model) is|benchmark|articles?|sources?)\b/,
  ],
  code: [
    /claude-api|mcp-builder|code-review|simplify|tdd|^run$|schedule|^loop|update-config|dashboard|^data:|analytics|sql|dataviz|deploy/,
    /\/(dev|src|code|repos?|git)\b|\/dev-/,
    /\b(code|bug|api|cli|install|automation|routine|scheduled task|cron|python|deploy|dashboard|metrics|analytics|sql|database|spreadsheet|data)\b/,
  ],
  sales: [
    /^sales:|lead|outreach|crm|call-prep|pipeline|prospect|enrich|proposal|deal/,
    /sales|crm|leads/,
    /\b(leads?|prospects?|crm|proposals?|one-?pager|deals?|sales|discovery call|clients?|customers?|outreach|cold e-?mails?)\b/,
  ],
  inbox: [/inbox|gmail|email|mail|outlook/, /inbox|mail/, /\b(inbox|e-?mails?|gmail|outlook|reply to|unread)\b/],
}

/** Points for each type: a skill counts 3, the folder 2, each matching word in the task 1. */
export function typeScores(task: string, cwd = '', skill = ''): Record<string, number> {
  const text = task.toLowerCase()
  const folder = cwd.toLowerCase()
  const sk = skill.toLowerCase()
  const out: Record<string, number> = {}
  for (const [type, [sr, fr, wr]] of Object.entries(RULES)) {
    let n = 0
    if (sk && sr.test(sk)) n += 3
    if (folder && fr.test(folder)) n += 2
    const words = text.match(new RegExp(wr.source, 'g'))
    n += words ? Math.min(4, words.length) : 0
    if (n > 0) out[type] = n
  }
  return out
}

/** The one type of a finished task. None matched: other. */
export function typeOf(task: string, cwd = '', skill = ''): string {
  const s = typeScores(task, cwd, skill)
  let best = 'other'
  let top = 0
  for (const [t, n] of Object.entries(s)) {
    if (n > top) {
      best = t
      top = n
    }
  }
  return best
}

function wordsOf(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter(w => !STOP.has(w)))
}
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'what', 'your', 'they', 'them', 'then', 'into', 'about', 'just', 'like', 'make', 'sure', 'each', 'also', 'when', 'will', 'there', 'their', 'want', 'need', 'please', 'should', 'could', 'would', 'these', 'those', 'which', 'only', 'more'])

/** Share of the task's words that are in a type's sample tasks. 0 to 1. */
export function overlap(task: string, samples: readonly string[]): number {
  const a = wordsOf(task)
  if (a.size === 0 || samples.length === 0) return 0
  const b = wordsOf(samples.join(' '))
  let hit = 0
  for (const w of a) if (b.has(w)) hit += 1
  return hit / a.size
}

/**
 * The type files the estimate reads: at most 2. A cheap match first, with no second model call:
 * the rules on the task, the folder and the skill, plus the words the task shares with each type's sample tasks.
 */
export function pickTypes(task: string, cwd: string, skill: string, samples: Record<string, readonly string[]>, have: readonly string[]): string[] {
  const s = typeScores(task, cwd, skill)
  const ranked = have
    .map(t => ({ t, n: (s[t] ?? 0) + 4 * overlap(task, samples[t] ?? []) }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n)
  const top = ranked.slice(0, 2).map(x => x.t)
  return top.length > 0 ? top : have.includes('other') ? ['other'] : []
}

// ---------- reading runs.jsonl ----------

/** Every line of runs.jsonl that parses. A broken line is skipped, never fatal. */
export function parseLines(text: string): MemLine[] {
  const out: MemLine[] = []
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t) continue
    try {
      const o = JSON.parse(t) as MemLine
      if (o && typeof o === 'object' && typeof o.type === 'string' && (isLesson(o) || typeof (o as MemRun).cost === 'number')) out.push(o)
    } catch {
      // skip
    }
  }
  return out
}

// ---------- figures ----------

export type Row = { n: number; p50: number; p90: number; max: number; mult: number | null }
export type TypeStats = {
  type: string
  n: number
  p50: number
  p90: number
  max: number
  /** The model family of the run that cost the most. A high end is scaled from it to the chat's model. */
  maxFam: string
  over20: number
  over50: number
  over100: number
  /** Cost by "model effort". */
  rows: Record<string, Row>
  /** Runs that started subagents, the typical count, and what one subagent costs at Sonnet (p50, p90). */
  subRuns: number
  subN: number
  subP50: number
  subP90: number
  last: string
  /** Real cost against the likely estimate (median), where the mod made one. */
  mult: number | null
  /** True when the figures mix in starter figures (fewer than 10 runs of this person). */
  isStarter: boolean
}

const r2 = (n: number): number => Math.round(n * 100) / 100

/** Dollars at one model, from dollars at another, by the price of input tokens. */
export function scaleTo(usd: number, from: string, to: string): number {
  const a = priceFor(from).in
  const b = priceFor(to).in
  return a > 0 ? (usd * b) / a : usd
}

/** A run that ran to its end (under or over the limit). A stopped, ended, handed-off or abandoned run did not, so its
 * real cost says nothing about the estimate. Its cost still counts in the cost figures: the money was spent. */
export function ranToEnd(r: MemRun): boolean {
  return !r.outcome || r.outcome === 'under' || r.outcome === 'over'
}

function rowOf(list: readonly MemRun[]): Row {
  const c = list.map(r => r.cost)
  const ratios = list.filter(r => ranToEnd(r) && (r.estimate ?? 0) > 0).map(r => r.cost / (r.estimate as number))
  return { n: list.length, p50: r2(quantile(c, 0.5)), p90: r2(quantile(c, 0.9)), max: r2(Math.max(0, ...c)), mult: ratios.length > 0 ? r2(quantile(ratios, 0.5)) : null }
}

/** The figures of one type from the person's own runs, with no starter mixed in. */
export function ownStats(type: string, runs: readonly MemRun[]): TypeStats {
  const base = rowOf(runs)
  const rows: Record<string, Row> = {}
  const groups = new Map<string, MemRun[]>()
  for (const r of runs) {
    const key = `${family(r.model)} ${r.effort || 'default'}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  for (const [k, list] of groups) rows[k] = rowOf(list)
  const top = runs.reduce<MemRun | null>((a, r) => (!a || r.cost > a.cost ? r : a), null)
  const withSubs = runs.filter(r => (r.subs ?? 0) > 0)
  // 1 or 2 runs with subagents are too few: one odd run (168 tiny subagents in a test) would set the figure.
  // Then the general starter figure counts instead.
  const isSubOk = withSubs.length >= SUB_MIN
  const each = (isSubOk ? withSubs : []).flatMap(r => (r.subUsd ?? []).map(u => scaleTo(u, r.subModel || r.model, 'claude-sonnet-5-5')))
  return {
    type,
    n: runs.length,
    p50: base.p50,
    p90: base.p90,
    max: base.max,
    maxFam: top ? family(top.model) : 'sonnet',
    over20: runs.filter(r => r.cost > 20).length,
    over50: runs.filter(r => r.cost > 50).length,
    over100: runs.filter(r => r.cost > 100).length,
    rows,
    subRuns: withSubs.length,
    subN: isSubOk ? Math.round(quantile(withSubs.map(r => r.subs ?? 0), 0.5)) : 0,
    subP50: each.length > 0 ? r2(quantile(each, 0.5)) : 0,
    subP90: each.length > 0 ? r2(quantile(each, 0.9)) : 0,
    last: runs.reduce((a, r) => (r.at > a ? r.at : a), ''),
    mult: base.mult,
    isStarter: false,
  }
}

/** The person's figures, mixed with the starter figures until the type has 10 runs. */
export function blend(own: TypeStats | null, start: StarterType | undefined, type: string): TypeStats | null {
  if (!start) return own
  const w = own ? Math.min(1, own.n / OWN_FULL) : 0
  if (w >= 1 && own) return own
  const mix = (a: number, b: number): number => r2(w * a + (1 - w) * b)
  const o = own ?? ({ n: 0, p50: 0, p90: 0, max: 0, over20: 0, over50: 0, over100: 0, rows: {}, subRuns: 0, subN: 0, subP50: 0, subP90: 0, last: '', mult: null, maxFam: start.maxFam } as unknown as TypeStats)
  return {
    type,
    n: o.n,
    p50: mix(o.p50, start.p50),
    p90: mix(o.p90, start.p90),
    max: Math.max(o.max, mix(o.max, start.max)),
    maxFam: o.n > 0 && o.max >= start.max ? o.maxFam : start.maxFam,
    over20: o.over20,
    over50: o.over50,
    over100: o.over100,
    rows: Object.keys(o.rows).length > 0 ? o.rows : start.rows,
    subRuns: o.subRuns,
    subN: o.subN > 0 ? o.subN : start.subN,
    subP50: o.subP50 > 0 ? mix(o.subP50, start.subP50) : start.subP50,
    subP90: o.subP90 > 0 ? mix(o.subP90, start.subP90) : start.subP90,
    last: o.last,
    mult: o.mult,
    isStarter: true,
  }
}

/** Runs grouped by type, with types of fewer than 5 runs merged into other. More types than the index can hold: the smallest go to other too. */
export function groupTypes(runs: readonly MemRun[], maxTypes = INDEX_MAX - 20): Map<string, MemRun[]> {
  const by = new Map<string, MemRun[]>()
  for (const r of runs) by.set(r.type || 'other', [...(by.get(r.type || 'other') ?? []), r])
  const out = new Map<string, MemRun[]>()
  const other: MemRun[] = [...(by.get('other') ?? [])]
  const big = [...by.entries()].filter(([t, l]) => t !== 'other' && l.length >= RARE).sort((a, b) => b[1].length - a[1].length)
  for (const [t, l] of by) if (t !== 'other' && l.length < RARE) other.push(...l)
  for (const [t, l] of big.slice(0, maxTypes)) out.set(t, l)
  for (const [, l] of big.slice(maxTypes)) other.push(...l)
  if (other.length > 0) out.set('other', other)
  return out
}

/** All type figures, mixed with the starter where a type has few runs. Starter types the person has no run of are kept too. */
export function allStats(lines: readonly MemLine[]): Map<string, TypeStats> {
  const runs = lines.filter((x): x is MemRun => !isLesson(x))
  const groups = groupTypes(runs)
  const out = new Map<string, TypeStats>()
  for (const [t, l] of groups) {
    const s = blend(ownStats(t, l), STARTER.types[t], t)
    if (s) out.set(t, s)
  }
  for (const [t, st] of Object.entries(STARTER.types)) if (!out.has(t) && !groups.has(t)) out.set(t, blend(null, st, t)!)
  return out
}

// ---------- the big-task tail ----------

/** The few figures of a type the estimate needs, kept in stats.json, so an estimate never reads runs.jsonl. */
export type MemLite = {
  n: number
  max: number
  maxFam: string
  over20: number
  subN: number
  subP90: number
  samples: string[]
  /** Added after 0.8.0: how this type spends, its false alarms and its pause point. */
  path?: TypePath
  alarms?: number
  ease?: number
}

export function liteOf(s: TypeStats, runs: readonly MemRun[]): MemLite {
  const samples: string[] = []
  for (const r of [...runs].sort((a, b) => (a.at < b.at ? 1 : -1))) {
    const t = flat(r.task, 140)
    if (t.length >= 20 && !samples.some(x => x.slice(0, 40) === t.slice(0, 40))) samples.push(t)
    if (samples.length >= 5) break
  }
  // Public copy: a type with fewer than 5 own runs with a cost path uses the general path of the starter.
  const own = typePathOf(runs)
  const path = own && own.n >= 5 ? own : (STARTER.types[s.type]?.path ?? own)
  const alarms = alarmsOf(runs)
  const ease = easeFrom(alarms)
  return { n: s.n, max: s.max, maxFam: s.maxFam, over20: s.over20, subN: s.subN, subP90: s.subP90, samples, ...(path ? { path } : {}), alarms, ...(ease > 1 ? { ease } : {}) }
}

// ---------- the cost path (added after 0.8.0) ----------

/** Share of the work cost (cost less the start) spent at a share done, from the path, between the anchors (0, start) and (1, cost). */
export function workShareAt(r: MemRun, part: number): number | null {
  const start = Math.max(0, r.start ?? 0)
  const work = r.cost - start
  if (!(work > 0) || !r.path || r.path.length === 0) return null
  const inner = r.path.filter(([p]) => p > 0 && p < 1)
  if (inner.length === 0) return null
  const pts: [number, number][] = [[0, start], ...[...inner].sort((a, b) => a[0] - b[0]), [1, r.cost]]
  for (let i = 1; i < pts.length; i++) {
    const [p0, s0] = pts[i - 1] as [number, number]
    const [p1, s1] = pts[i] as [number, number]
    if (part <= p1) {
      const s = p1 > p0 ? s0 + ((s1 - s0) * (part - p0)) / (p1 - p0) : s1
      return Math.min(1, Math.max(0, (s - start) / work))
    }
  }
  return 1
}

/** The typical path of a type: the middle share of the work cost spent by 25%, 50% and 75% done, and per step when 2 or more runs had the same number of steps. */
export function typePathOf(runs: readonly MemRun[]): TypePath | undefined {
  const ok = runs.filter(r => ranToEnd(r) && r.cost > 0 && workShareAt(r, 0.5) !== null)
  if (ok.length === 0) return undefined
  const at = (x: number): number => r2(quantile(ok.map(r => workShareAt(r, x) as number), 0.5))
  const q: [number, number, number] = [at(0.25), at(0.5), at(0.75)]
  const steps: Record<string, number[]> = {}
  const byCount = new Map<number, MemRun[]>()
  for (const r of ok) {
    const n = r.stepAt?.length ?? 0
    if (n >= 3) byCount.set(n, [...(byCount.get(n) ?? []), r])
  }
  for (const [n, list] of byCount) {
    if (list.length < 2) continue
    const row: number[] = []
    for (let i = 0; i < n; i++) {
      const shares = list
        .map(r => {
          const v = r.stepAt?.[i] ?? -1
          const start = Math.max(0, r.start ?? 0)
          return v >= 0 ? Math.min(1, Math.max(0, (v - start) / (r.cost - start))) : null
        })
        .filter((x): x is number => x !== null)
      row.push(shares.length > 0 ? r2(quantile(shares, 0.5)) : -1)
    }
    steps[String(n)] = row
  }
  return { n: ok.length, q, ...(Object.keys(steps).length > 0 ? { steps } : {}) }
}

/** False alarms of a type: soft questions before a run that then ended under the limit it had at the question. */
export function alarmsOf(runs: readonly MemRun[]): number {
  return runs.reduce((n, r) => n + (r.qs ?? []).filter(q => q.falseAlarm).length, 0)
}

/** The pause point of a type: 10% higher for every 2 false alarms, at most 1.3 times. */
export function easeFrom(alarms: number): number {
  return Math.min(1.3, r2(1 + 0.1 * Math.floor(Math.max(0, alarms) / 2)))
}

/** The questions of a finished run, each marked when it was a false alarm. Only a run that ran to its end can mark one. */
export function asksOf(asks: readonly { kind: string; spent: number; limit: number; course?: number; answer: string }[] | undefined, cost: number, outcome: string | undefined): MemAsk[] {
  const isEnd = !outcome || outcome === 'under' || outcome === 'over'
  return (asks ?? []).map(a => {
    const isSoft = a.kind === 'early' || a.kind === 'near' || a.kind === 'cap'
    const isFalse = isSoft && isEnd && cost <= a.limit + 1e-9
    return { kind: a.kind, spent: r2(a.spent), limit: a.limit, ...(typeof a.course === 'number' ? { course: r2(a.course) } : {}), answer: a.answer, ...(isFalse ? { falseAlarm: true } : {}) }
  })
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

/** The "How it spends" lines of a type file. */
export function pathLines(runs: readonly MemRun[]): string[] {
  const tp = typePathOf(runs)
  const alarms = alarmsOf(runs)
  const out: string[] = []
  if (tp) {
    out.push(`- ${tp.n} run${tp.n === 1 ? '' : 's'} with a cost path. Middle share of the work cost spent by 25% done: ${pct(tp.q[0])}, by 50%: ${pct(tp.q[1])}, by 75%: ${pct(tp.q[2])}.`)
    for (const [n, row] of Object.entries(tp.steps ?? {}).slice(0, 3)) {
      out.push(`- Runs with ${n} steps: share spent at the start of each step: ${row.slice(0, 12).map(x => (x < 0 ? 'none' : pct(x))).join(', ')}.`)
    }
  } else {
    out.push('- No cost path yet.')
  }
  const ease = easeFrom(alarms)
  if (alarms > 0) out.push(`- False alarms: ${alarms}. ${ease > 1 ? `The pause point is ${ease} times the usual.` : 'The pause point is the usual.'}`)
  return out
}

/** stats.json: the lite figures of every type. */
export function statsJson(lines: readonly MemLine[]): Record<string, MemLite> {
  const groups = groupTypes(lines.filter((x): x is MemRun => !isLesson(x)))
  const out: Record<string, MemLite> = {}
  for (const [t, s] of allStats(lines)) out[t] = liteOf(s, groups.get(t) ?? [])
  return out
}

/**
 * A big task gets a high end from the money tail, not the middle. It applies when Claude is expected to start 3 or more
 * subagents, or when the task is large for its type (likely $5 or more) and the type has fewer than 5 runs over $20.
 * High end: the most of the current safe amount, the type's highest cost at the chat's model, and the expected subagents
 * times what 9 in 10 subagents cost at the model the mod sets.
 */
export function bigTail(
  e: { likely: number; safe: number; helpers: number },
  stats: MemLite | null,
  model: string,
  subModel: string,
): { upTo: number; why: string } | null {
  const isMany = (e.helpers ?? 0) >= 3
  const isBig = e.likely >= 5 && (stats ? stats.over20 : 0) < 5
  if (!isMany && !isBig) return null
  const top = stats && stats.max > 0 ? scaleTo(stats.max, stats.maxFam, model) : 0
  const p90 = stats && stats.subP90 > 0 ? stats.subP90 : (STARTER.subP90 ?? 1.5)
  const subs = (e.helpers ?? 0) * scaleTo(p90, 'claude-sonnet-5-5', subModel)
  const upTo = nice(Math.max(e.safe, top, subs))
  if (!(upTo > 0)) return null
  return { upTo, why: isMany ? `${e.helpers} subagents expected` : 'large for its type' }
}

// ---------- the files ----------

const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : n > 0 && n < 0.01 ? 'under $0.01' : `$${n.toFixed(2)}`)
const day = (iso: string): string => (iso ? iso.slice(0, 10) : 'unknown')
const flat = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n)

/** The index. At most 200 lines: a how-to block of 6 lines, one line per type, the money tail. */
export function renderIndex(stats: Map<string, TypeStats>, runs: readonly MemRun[], now: string): string {
  const head = [
    '# Task Budget memory',
    '',
    'How to use this file:',
    '- Each row is one type of task this person ran. Costs are list price in dollars, for the whole task with its subagents.',
    '- typical: the middle cost. 9 in 10: what 9 in 10 runs cost or less. highest: the most one run cost.',
    '- The file of the type that fits the new task has sample tasks, costs by model and effort, subagents and lessons.',
    '- A task with many subagents, or larger than most of its type, can cost near the highest. Do not count it by the typical.',
    '- (starter) marks a type with under 10 runs of this person: its figures mix in general figures.',
    '',
    '| type | file | runs | typical | 9 in 10 | highest | subagents | updated |',
    '|---|---|---|---|---|---|---|---|',
  ]
  const sorted = [...stats.values()].sort((a, b) => b.n - a.n || a.type.localeCompare(b.type))
  const rows = sorted.map(
    s =>
      `| ${s.type}${s.isStarter ? ' (starter)' : ''} | types/${s.type}.md | ${s.n} | ${money(s.p50)} | ${money(s.p90)} | ${money(s.max)} | ${s.subRuns > 0 && s.subN === 0 ? `in ${s.subRuns} run${s.subRuns === 1 ? "" : "s"}, too few to count: use one at Sonnet ${money(s.subP90 || STARTER.subP90)} or less` : s.subRuns > 0 ? `in ${s.subRuns} run${s.subRuns === 1 ? "" : "s"}, ${s.subN} each (median), one at Sonnet ${money(s.subP90)} or less (9 in 10)` : s.subN > 0 ? `starter: ${s.subN} each, one at Sonnet ${money(s.subP90)} or less` : 'none seen'} | ${day(s.last)} |`,
  )
  const tail = `Money tail: ${runs.filter(r => r.cost > 20).length} runs over $20, ${runs.filter(r => r.cost > 50).length} over $50, ${runs.filter(r => r.cost > 100).length} over $100, of ${runs.length} runs. Built ${day(now)}.`
  const room = INDEX_MAX - head.length - 2
  const kept = rows.slice(0, room)
  const groups = groupTypes(runs)
  // Added after 0.8.0: one line per type with a cost path, only when the whole section fits in the line limit.
  const paths = sorted
    .map(s => ({ s, tp: typePathOf(groups.get(s.type) ?? []) }))
    .filter((x): x is { s: TypeStats; tp: TypePath } => Boolean(x.tp))
    .map(({ s, tp }) => `- ${s.type}: ${tp.n} run${tp.n === 1 ? '' : 's'}. Share of the work cost by 25% done ${pct(tp.q[0])}, by 50% ${pct(tp.q[1])}, by 75% ${pct(tp.q[2])}.`)
  const section = paths.length > 0 ? ['', '## How each type spends', ...paths] : []
  const body = head.length + kept.length + 2 + section.length <= INDEX_MAX ? [...kept, ...section] : kept
  return [...head, ...body, '', tail].join('\n') + '\n'
}

/** One type file. At most 150 lines. */
export function renderType(s: TypeStats, runs: readonly MemRun[], lessons: readonly MemLesson[]): string {
  const mine = [...runs].sort((a, b) => (a.at < b.at ? 1 : -1))
  const samples: string[] = []
  for (const r of mine) {
    const t = flat(r.task, 140)
    if (t.length >= 20 && !samples.some(x => x.slice(0, 40) === t.slice(0, 40))) samples.push(t)
    if (samples.length >= 5) break
  }
  const out = [
    `# ${s.type}: ${WORK_LABEL[s.type] ?? s.type}`,
    '',
    `${s.n} runs. Typical ${money(s.p50)}, 9 in 10 under ${money(s.p90)}, highest ${money(s.max)} (on ${s.maxFam}).${s.isStarter ? ' Mixed with starter figures.' : ''}${s.mult !== null ? ` Real cost against the estimate: ${s.mult} times (median).` : ''}`,
    '',
    '## Sample tasks',
    ...(samples.length > 0 ? samples.map(x => `- "${x}"`) : ['- none yet']),
    '',
    '## Cost by model and effort',
    '| model and effort | runs | typical | 9 in 10 | highest | real against estimate |',
    '|---|---|---|---|---|---|',
    ...Object.entries(s.rows)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 20)
      .map(([k, r]) => `| ${k} | ${r.n} | ${money(r.p50)} | ${money(r.p90)} | ${money(r.max)} | ${r.mult === null ? 'none' : `${r.mult} times`} |`),
    '',
    '## Subagents',
    s.subRuns > 0 || s.subN > 0
      ? `- In ${s.subRuns} of ${s.n} runs. ${s.subN > 0 ? `Typical count ${s.subN}.` : "Too few runs to count: the figures below are general."} One subagent at Sonnet: typical ${money(s.subP50)}, 9 in 10 under ${money(s.subP90)}.`
      : '- None seen.',
    '',
    '## How it spends',
    ...pathLines(runs),
    '',
    '## Lessons',
    ...(lessons.length > 0 ? lessons.slice(-5).map(l => `- ${flat(l.lesson, 200)} (${day(l.at)})`) : ['- none yet']),
    '',
    '## Last 30 runs',
    ...mine
      .slice(0, 30)
      .map(r => `- ${day(r.at)} ${family(r.model)} ${r.effort || 'default'} ${money(r.cost)}${(r.estimate ?? 0) > 0 ? ` (estimate ${money(r.estimate as number)})` : ''}${(r.subs ?? 0) > 0 ? `, ${r.subs} subagents` : ''}: ${flat(r.task, 90)}`),
  ]
  return out.slice(0, TYPE_MAX).join('\n') + '\n'
}

/** Spend by week and by model. */
export function renderUsage(runs: readonly MemRun[]): string {
  const week = (iso: string): string => {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return 'unknown'
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000)
    return monday.toISOString().slice(0, 10)
  }
  const by = (key: (r: MemRun) => string): [string, number, number][] => {
    const m = new Map<string, [number, number]>()
    for (const r of runs) {
      const k = key(r)
      const v = m.get(k) ?? [0, 0]
      m.set(k, [v[0] + 1, v[1] + r.cost])
    }
    return [...m.entries()].map(([k, [n, u]]) => [k, n, u] as [string, number, number]).sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }
  return [
    '# Task Budget usage',
    '',
    '## By week (from Monday)',
    '| week | runs | spend |',
    '|---|---|---|',
    ...by(r => week(r.at)).slice(0, 26).map(([k, n, u]) => `| ${k} | ${n} | ${money(u)} |`),
    '',
    '## By model',
    '| model | runs | spend |',
    '|---|---|---|',
    ...by(r => family(r.model)).map(([k, n, u]) => `| ${k} | ${n} | ${money(u)} |`),
    '',
    'Plan quota: unknown. The mod sees list prices, not the plan.',
  ].join('\n') + '\n'
}

/** Every file of the memory, by path under the memory folder. */
export function renderAll(lines: readonly MemLine[], now: string): Record<string, string> {
  const runs = lines.filter((x): x is MemRun => !isLesson(x))
  const lessons = lines.filter(isLesson)
  const groups = groupTypes(runs)
  const stats = allStats(lines)
  const files: Record<string, string> = { 'INDEX.md': renderIndex(stats, runs, now), 'usage.md': renderUsage(runs), 'stats.json': JSON.stringify(statsJson(lines)) + '\n' }
  for (const [t, s] of stats) {
    const own = groups.get(t) ?? []
    const merged = new Set(own.map(r => r.type))
    files[`types/${t}.md`] = renderType(s, own, lessons.filter(l => l.type === t || merged.has(l.type)))
  }
  return files
}

/** The text the estimate gets: the index and at most 2 type files. */
export function memoryText(index: string, types: readonly { type: string; text: string }[]): string {
  const parts = [`INDEX.md\n${index.trim()}`]
  for (const t of types.slice(0, 2)) parts.push(`types/${t.type}.md\n${t.text.trim()}`)
  return parts.join('\n\n')
}

/** The sample tasks of a type file, read back for the cheap match. */
export function samplesOf(typeFile: string): string[] {
  const at = typeFile.indexOf('## Sample tasks')
  if (at < 0) return []
  const block = typeFile.slice(at).split('\n## ')[0] ?? ''
  return block
    .split('\n')
    .filter(l => l.startsWith('- "'))
    .map(l => l.slice(3, -1))
}

/** A finished task that missed by 2 times or more, either way. */
export function isBigMiss(run: MemRun): boolean {
  const e = run.estimate ?? 0
  if (!ranToEnd(run)) return false
  if (!(e > 0) || !(run.cost > 0)) return false
  const k = run.cost / e
  return k >= 2 || k <= 0.5
}

/** The prompt for one lesson line, for the small model. */
export function lessonPrompt(run: MemRun): string {
  return [
    'A task was estimated before it ran. The estimate missed by 2 times or more.',
    `Task: ${flat(run.task, 600)}`,
    `Type: ${run.type}. Model: ${family(run.model)} ${run.effort || ''}.`,
    `Estimate: ${money(run.estimate ?? 0)}. Real: ${money(run.cost)}. Subagents: ${run.subs ?? 0}.`,
    'Write one lesson for the next estimate of this type, in one sentence of at most 25 words. Say what to count. Plain words.',
  ].join('\n')
}

export function cleanLesson(text: string): string | null {
  const t = flat(text.replace(/^[-*"\s]+|["\s]+$/g, ''), 200)
  return t.length >= 10 ? t : null
}

/** Where the subagents of a run ran, for the run line. */
export function subsOf(spawns: readonly { model: string; used?: number; usd?: number }[] | undefined): Pick<MemRun, 'subs' | 'subModel' | 'subUsd'> {
  const list = spawns ?? []
  if (list.length === 0) return { subs: 0 }
  return { subs: list.length, subModel: list[0]?.model ?? 'sonnet', subUsd: list.map(s => r2(s.used ?? 0)) }
}

export { r2 as round2Mem }
