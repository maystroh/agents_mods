// The model and effort advice. Added in 0.7.0: it came from the Model Selector mod, version 0.4.0.
// A small model reads the task and names the model and the effort level that fit it.
// Pure code: no engine calls. The engine file makes the call and asks the person.

import type { Route } from '../types'
import { family } from './book.ts'

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Cheapest first. */
export const FAMILIES: readonly Family[] = ['haiku', 'sonnet', 'opus', 'fable']
export const LEVELS: readonly Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const MODEL_NAMES: Record<Family, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
export const LEVEL_WORDS: Record<Level, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' }

/** The model that reads the task and picks. */
export const PICK_MODEL = 'sonnet'
export const PICK_EFFORT = 'medium'
/** The advice never names max: max only adds cost. */
export const TOP_EFFORT: Level = 'xhigh'
/** Above this chat size the question says what a model change costs. */
export const CACHE_WARN_TOKENS = 60_000

export const RULES = `You read one task a person gives to Claude and you answer two things: which Claude model fits it, and which effort level fits it.

MODEL. Check in this order and stop at the first one that fits.
1. haiku: the task is simple, repetitive and easy to check. Summarization, classification, routing, tagging, pulling fields. Not for judgment calls.
2. sonnet: you can say exactly what done looks like in one sentence. A scoped job, a job the person repeats, or a skill with a clear, fixed workflow.
3. fable: the job is big and open-ended, and judgment and accuracy really matter. Both must be true. Fable costs twice as much as Opus.
4. opus: most tasks, and whenever you are not sure. Opus on medium effort is the right answer most of the time.

EFFORT. Ask these four questions in order and stop at the first yes.
1. Is it back and forth with Claude, or a simple task? -> low
2. Would a hidden mistake cost money, a client or a wrong decision? -> high
3. Is it a long, hard and critical job that the person hands off and walks away from? All three must be true. -> xhigh
4. Everything else -> medium
Never answer max.`

export type Pick = { model: Family; effort: Level; why: string }

export function asFamily(v: unknown): Family | '' {
  if (typeof v !== 'string') return ''
  const t = v.toLowerCase()
  return FAMILIES.find(f => t.includes(f)) ?? ''
}

export function asLevel(v: unknown): Level | '' {
  if (typeof v !== 'string') return ''
  const t = v.toLowerCase().replace(/[^a-z]/g, '')
  const n = t === 'extrahigh' ? 'xhigh' : t
  return (LEVELS as readonly string[]).includes(n) ? (n as Level) : ''
}

function clean(raw: string): string {
  return raw
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\bship(s|ped|ping)?\b/gi, 'publish')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`\s]+|["'`\s.]+$/g, '')
    .slice(0, 100)
}

/** The message for the picker model. */
export function pickPrompt(task: string, nowModel: string, nowEffort: string): string {
  return `${RULES}

The chat runs on: ${nowModel || 'unknown'}, effort ${nowEffort || 'unknown'}

The task:
<task>
${task.slice(0, 4000)}
</task>

Reply with JSON only: {"model": "haiku|sonnet|opus|fable", "effort": "low|medium|high|xhigh", "why": "the reason in under 12 plain words"}`
}

/** Read the picker's answer. Null when it does not name a model and an effort level: then the mod gives no advice. */
export function parsePick(text: string): Pick | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { model?: unknown; effort?: unknown; why?: unknown }
    const model = asFamily(j.model)
    let effort = asLevel(j.effort)
    if (!model || !effort) return null
    if (LEVELS.indexOf(effort) > LEVELS.indexOf(TOP_EFFORT)) effort = TOP_EFFORT
    return { model, effort, why: clean(typeof j.why === 'string' ? j.why : '') }
  } catch {
    return null
  }
}

/** "Sonnet at medium". */
export function routeName(r: Route): string {
  const fam = asFamily(r.model)
  const lvl = asLevel(r.effort)
  const name = fam ? MODEL_NAMES[fam] : r.model || 'this model'
  if (!lvl && !r.effort) return name
  return `${name} at ${lvl ? LEVEL_WORDS[lvl] : r.effort}`
}

/** Whether two routes name the same model family and effort level. */
export function sameRoute(a: Route, b: Route): boolean {
  return family(a.model) === family(b.model) && (asLevel(a.effort) || a.effort) === (asLevel(b.effort) || b.effort)
}

/** One effort level down. Null at the lowest level. */
export function lowerEffort(effort: string): Level | null {
  const i = LEVELS.indexOf(asLevel(effort) || 'medium')
  return i > 0 ? (LEVELS[i - 1] ?? null) : null
}

/** One model down. Null at the cheapest model, and for a model the mod does not know. */
export function lowerModel(model: string): Family | null {
  const i = FAMILIES.indexOf(family(model) as Family)
  return i > 0 ? (FAMILIES[i - 1] ?? null) : null
}

export const SWITCH = 'Switch'
export const KEEP_ROUTE = 'Keep'

/** The advice question: "This task fits Sonnet at medium. You are on Opus at high. Switch?" */
export function adviceQuestion(to: Route, now: Route, why: string, o: { nowUsd: number; toUsd: number; ctx: number }): { text: string; options: string[] } {
  const money = (n: number): string => `$${n.toFixed(2)}`
  // Changed in 0.8.0: one short line, then the buttons. With no effort level seen, the advice is a target,
  // and the line says nothing about what the mod cannot see.
  const isSame = Math.abs(o.toUsd - o.nowUsd) <= 0.05 * Math.max(o.toUsd, o.nowUsd, 0.01)
  const cost = isSame ? `about ${money(o.toUsd)} either way` : `about ${money(o.toUsd)}, against ${money(o.nowUsd)} now`
  void why
  return {
    text: `Run this on ${routeName(to)}: ${cost}. Switch?`,
    options: [`${SWITCH} to ${routeName(to)}`, `${KEEP_ROUTE} ${routeName(now)}`],
  }
}

export const RAISE = 'Raise the limit'
export const LOWER_EFFORT = 'Lower the effort'
export const LOWER_MODEL = 'Lower the model'

/** The question before the start, when the likely cost is over the limit. A choice that cannot be made is left out. */
export function overQuestion(likely: number, limit: number, now: Route, tight: number): { text: string; options: string[] } {
  const money = (n: number): string => `$${n.toFixed(2)}`
  const le = lowerEffort(now.effort)
  const lm = lowerModel(now.model)
  // Changed in 0.8.0: one short line, then the buttons.
  const options = [`${RAISE} to ${money(tight)}`]
  if (le) options.push(LOWER_EFFORT)
  if (lm) options.push(LOWER_MODEL)
  options.push('Stop')
  return { text: `Likely ${money(likely)}, over your ${money(limit)} limit. What now?`, options }
}
