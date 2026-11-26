// Tests for the parts that came in 0.7.0: the model and effort advice, the odds of an estimate,
// the 80% pause, the reading of the chat, and the hit count. No engine calls.

import { expect, test } from 'claude-code/testing'
import type { Budget, Run } from '../types'
import { CHECK_MARKS, forecast, hitLine, isHit, missWhy, mustAskNear, mustCheck, newBudget, parseLeft, recentOf, scoreOf, withLeft } from './core.ts'
import { curvePoints, oddsLine, oddsWithin, ofTen, overOdds, ownBand, shareUnder } from './estimator.ts'
import { adviceQuestion, lowerEffort, lowerModel, overQuestion, parsePick, routeName, sameRoute } from './picker.ts'

const EST = {
  low: 0.5,
  likely: 1.2,
  safe: 7,
  kind: 'edit',
  mode: 'guard',
  confidence: 'medium',
  basis: '',
  similar: null,
  unsure: [],
  cost: 0,
  units: { read: 10 },
  helpers: 0,
  usual: [0.64, 2.16] as [number, number],
  hold: 95,
} as unknown as NonNullable<Budget['estimate']>

function budget(over: Partial<Budget> = {}): Budget {
  return { ...newBudget({ limit: 1, task: 'fix the report', startCost: 0, model: 'claude-opus-5-5', isFresh: false, id: 'b1', now: 0 }), ...over }
}

function run(over: Partial<Run> = {}): Run {
  return { id: 'r', at: '2026-11-16T10:00:00.000Z', task: 'fix the report', limit: 5, spent: 1, messages: 1, model: 'claude-opus-5-5', outcome: 'under', estimate: { low: 0.5, likely: 1, safe: 5 }, ...over }
}

// ---------- the advice ----------

test('the picker answer needs a model and an effort level, and max becomes extra high', async () => {
  expect(parsePick('{"model":"sonnet","effort":"medium","why":"a scoped job"}')).toEqual({ model: 'sonnet', effort: 'medium', why: 'a scoped job' })
  expect(parsePick('Here: {"model":"claude-opus-5-5","effort":"max","why":"x"}')?.model).toBe('opus')
  expect(parsePick('{"model":"opus","effort":"max","why":"x"}')?.effort).toBe('xhigh')
  // The answer of the call that counts the work names no model: no advice.
  expect(parsePick('{"mode":"guard","steps":[]}')).toBeNull()
  expect(parsePick('no json')).toBeNull()
  expect(parsePick('{"model":"gpt","effort":"medium"}')).toBeNull()
})

test('a route has a plain name, and one step down is the next cheaper model or effort level', async () => {
  expect(routeName({ model: 'sonnet', effort: 'medium' })).toBe('Sonnet at medium')
  expect(routeName({ model: 'claude-opus-5-5', effort: 'xhigh' })).toBe('Opus at extra high')
  expect(sameRoute({ model: 'claude-opus-5-5', effort: 'high' }, { model: 'opus', effort: 'high' })).toBe(true)
  expect(sameRoute({ model: 'opus', effort: 'high' }, { model: 'opus', effort: 'low' })).toBe(false)
  expect(lowerEffort('high')).toBe('medium')
  expect(lowerEffort('low')).toBeNull()
  expect(lowerModel('claude-opus-5-5')).toBe('sonnet')
  expect(lowerModel('fable')).toBe('opus')
  expect(lowerModel('haiku')).toBeNull()
})

test('0.8.0: the advice question is one short line with both costs, then two choices', async () => {
  const q = adviceQuestion({ model: 'sonnet', effort: 'medium' }, { model: 'claude-opus-5-5', effort: 'high' }, 'a scoped job', { nowUsd: 1.2, toUsd: 0.45, ctx: 20_000 })
  expect(q.text).toBe('Run this on Sonnet at medium: about $0.45, against $1.20 now. Switch?')
  expect(q.options).toEqual(['Switch to Sonnet at medium', 'Keep Opus at high'])
  // No effort level seen: the advice is a target, and no line says the mod cannot see it.
  const blind = adviceQuestion({ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: '' }, '', { nowUsd: 1.2, toUsd: 0.9, ctx: 200_000 })
  expect(blind.text).toBe('Run this on Sonnet at medium: about $0.90, against $1.20 now. Switch?')
  expect(blind.text).not.toContain('cannot see')
  expect(blind.text.split('\n')).toHaveLength(1)
})

test('the over-limit question leaves out a choice that cannot be made', async () => {
  const q = overQuestion(6, 5, { model: 'opus', effort: 'high' }, 7.5)
  expect(q.text).toBe('Likely $6.00, over your $5.00 limit. What now?')
  expect(q.options).toEqual(['Raise the limit to $7.50', 'Lower the effort', 'Lower the model', 'Stop'])
  expect(overQuestion(6, 5, { model: 'haiku', effort: 'low' }, 7.5).options).toEqual(['Raise the limit to $7.50', 'Stop'])
})

// ---------- the odds ----------

test('the odds of an estimate come from its measured band', async () => {
  // Half of such tasks land in the usual band, by definition.
  expect(Math.abs(shareUnder(EST, 2.16) - shareUnder(EST, 0.64) - 0.5) < 0.02).toBe(true)
  // 95 of 100 cost the safe amount or less.
  expect(Math.abs(shareUnder(EST, 7) - 0.95) < 0.02).toBe(true)
  // A wider range holds more tasks.
  expect(oddsWithin(EST, 3) > oddsWithin(EST, 2)).toBe(true)
  expect(oddsWithin(EST, 2) > 0.4 && oddsWithin(EST, 2) < 0.8).toBe(true)
  expect(ofTen(0.66)).toBe('7 of 10')
  expect(oddsLine(EST)).toMatch(/^Likely \$1\.20\. About \d+ of 10 tasks like this land between \$0\.60 and \$2\.40\.$/)
})

test('the chance to pass the limit goes up as the spend gets near it', async () => {
  expect(overOdds(EST, 0, 7) < 0.1).toBe(true)
  expect(overOdds(EST, 0, 1.2) > 0.3).toBe(true)
  expect(overOdds(EST, 1.1, 1.2) > overOdds(EST, 0.2, 1.2)).toBe(true)
  expect(overOdds(EST, 1.3, 1.2)).toBe(1)
  // A higher limit is passed less often.
  expect(overOdds(EST, 0.5, 3) < overOdds(EST, 0.5, 1.5)).toBe(true)
})

test('the curve has its top near the likely cost and ends low', async () => {
  const pts = curvePoints(EST, 40)
  expect(pts.length).toBe(41)
  const top = pts.reduce((a, b) => (b.y > a.y ? b : a))
  expect(top.y).toBe(1)
  expect(top.usd > 0.2 && top.usd < 2.4).toBe(true)
  expect((pts[pts.length - 1]?.y ?? 1) < 0.5).toBe(true)
})

test('the band of your own tasks is used only when there are enough of them', async () => {
  expect(ownBand([1, 1.1, 0.9], false)).toBeNull()
  const ratios = Array.from({ length: 12 }, (_, i) => 0.6 + i * 0.1)
  const own = ownBand(ratios, false)
  expect(own).not.toBeNull()
  expect((own?.usual[0] ?? 0) < 1 && (own?.usual[1] ?? 0) > 1).toBe(true)
})

// ---------- the 80% pause ----------

test('the 80% pause is due at 80% of the limit when the task is on course to pass it, one time', async () => {
  const over = { usd: 1.4, basis: 'todos' as const }
  expect(mustAskNear(budget({ spent: 0.85 }), over)).toBe(true)
  // Under 80%: not yet.
  expect(mustAskNear(budget({ spent: 0.7 }), over)).toBe(false)
  // On course to end under the limit: no pause.
  expect(mustAskNear(budget({ spent: 0.85 }), { usd: 0.95, basis: 'todos' })).toBe(false)
  // Asked at this limit before: not again. A new limit can ask again.
  expect(mustAskNear(budget({ spent: 0.85, nearAt: 1 }), over)).toBe(false)
  expect(mustAskNear(budget({ spent: 1.7, limit: 2, nearAt: 1 }), { usd: 2.6, basis: 'todos' })).toBe(true)
  // No limit: nothing to pause for.
  expect(mustAskNear(budget({ spent: 0.85, isTrack: true, isOpen: true }), over)).toBe(false)
  expect(mustAskNear(budget({ spent: 0.85 }), null)).toBe(false)
})

// ---------- the small model reads the chat ----------

test('the reading of the chat sets the course', async () => {
  expect(parseLeft('{"done": 40}')).toBe(0.4)
  expect(parseLeft('nothing')).toBeNull()
  const b = withLeft(budget({ spent: 0.5, estimate: EST }), 0.4)
  // 0.8.0: 40% of the work is done for $0.50. Estimate work left: 1.20 x 0.6 = 0.72. Pace part: 0.50 x 0.6 = 0.30.
  // Left = 0.6 x 0.72 + 0.30 = 0.732. With 15% on top: 0.842. The course is 0.50 + 0.842 = 1.34.
  expect(b.left?.part).toBe(0.4)
  expect(Math.abs((b.left?.usd ?? 0) - 1.342) < 0.01).toBe(true)
  expect(forecast(b)?.basis).toBe('left')
  expect(Math.abs((forecast(b)?.usd ?? 0) - 1.342) < 0.01).toBe(true)
})

test('the chat is read at set spend marks, and not twice at one mark', async () => {
  expect(CHECK_MARKS.length).toBe(4)
  // No limit: the marks are shares of the likely cost. 30% of $1.20 is $0.36.
  const track = { limit: 7, isTrack: true, isOpen: true, estimate: EST }
  expect(mustCheck(budget({ ...track, spent: 0.1 }))).toBe(false)
  const at = budget({ ...track, spent: 0.4 })
  expect(mustCheck(at)).toBe(true)
  expect(mustCheck({ ...at, checks: 1 })).toBe(false)
  expect(mustCheck({ ...at, spent: 0.8, checks: 1 })).toBe(true)
  // 0.8.0: with a limit over the likely cost, the marks are shares of the likely cost too. 30% of $1.20 is $0.36.
  expect(mustCheck(budget({ limit: 7, spent: 0.3, estimate: EST }))).toBe(false)
  expect(mustCheck(budget({ limit: 7, spent: 0.4, estimate: EST }))).toBe(true)
  // A limit under the likely cost: shares of the limit. 30% of $1 is $0.30.
  expect(mustCheck(budget({ limit: 1, spent: 0.31, estimate: EST }))).toBe(true)
  // No estimate: shares of the limit. 30% of $7 is $2.10.
  expect(mustCheck(budget({ limit: 7, spent: 0.4 }))).toBe(false)
  expect(mustCheck(budget({ limit: 7, spent: 2.2 }))).toBe(true)
  // A paused budget is not read.
  expect(mustCheck(budget({ limit: 7, spent: 2.2, estimate: EST, isPaused: true }))).toBe(false)
})

// ---------- how good the estimates are ----------

test('a hit is a real cost inside 2 times the estimate, and the line counts the last 20', async () => {
  expect(isHit(1.9, 1)).toBe(true)
  expect(isHit(0.55, 1)).toBe(true)
  expect(isHit(2.1, 1)).toBe(false)
  expect(isHit(0.4, 1)).toBe(false)
  const runs = [run({ id: 'a', spent: 1.5 }), run({ id: 'b', spent: 3 }), run({ id: 'c', spent: 0.8 })]
  const score = scoreOf(runs)
  expect(score?.last).toBe(3)
  expect(score?.in2).toBe(2)
  expect(hitLine(score)).toBe('Your last 3 estimates: 2 inside 2 times.')
  expect(hitLine(null)).toBe('')
  // Newest first, three at most, and only tasks that had an estimate and are finished.
  const many = [...runs, run({ id: 'd', spent: 1 }), run({ id: 'e', outcome: 'open' })]
  expect(recentOf(many).map(r => r.id)).toEqual(['d', 'c', 'b'])
})

test('a miss gets a reason, and a hit gets none', async () => {
  const b = budget({ estimate: { ...EST, units: { read: 10 } }, used: { read: 11 } })
  expect(missWhy(b, 1.3)).toBeNull()
  const more = budget({ estimate: { ...EST, units: { read: 10 } }, used: { read: 40 } })
  expect(typeof missWhy(more, 4)).toBe('string')
})

// ---------- 0.7.1 ----------

import { atStep, callLine, charge, donePlan, mustRead, parseStep, planFromEstimate } from './core.ts'

function guide(): Budget {
  const p = planFromEstimate(
    [
      { name: 'Find the emails', done: '', usd: 1 },
      { name: 'Read and sort', done: '', usd: 1 },
      { name: 'Write the summary', done: '', usd: 0.5 },
    ],
    5,
    0,
  )
  return budget({ limit: 5, spent: 0.5, plan: p })
}

test('0.7.1: a plan from the estimate starts in step 1, and the first spend lands there', async () => {
  const b = guide()
  expect(b.plan?.steps.map(st => st.state)).toEqual(['active', 'pending', 'pending'])
  const c = charge(b, 0.4)
  expect(c.next.plan?.steps[0]?.spent).toBe(0.4)
  // A step of such a plan that runs long asks nothing: the plan is a guide.
  expect(charge(b, 4).stuck).toBe(-1)
})

test('0.7.1: the small model moves the plan to the step the work is in, and never back', async () => {
  expect(parseStep('{"done": 40, "step": 2}')).toBe(2)
  expect(parseStep('{"done": 40, "step": 0}')).toBeNull()
  expect(parseStep('{"done": 40}')).toBeNull()
  const b = withLeft(guide(), 0.4, 2)
  expect(b.plan?.steps.map(st => st.state)).toEqual(['done', 'active', 'pending'])
  expect(b.left?.step).toBe(2)
  expect(atStep(b, 1).plan?.steps.map(st => st.state)).toEqual(['done', 'active', 'pending'])
  // A step past the end is the last step.
  expect(atStep(b, 9).plan?.steps.map(st => st.state)).toEqual(['done', 'done', 'active'])
  // A share under 10% gives no course, but the step still moves.
  const early = withLeft(guide(), 0.05, 2)
  expect(early.left).toBeUndefined()
  expect(early.plan?.steps[1]?.state).toBe('active')
  expect(donePlan(b.plan)?.steps.every(st => st.state === 'done')).toBe(true)
})

test('0.7.1: the chat start is paid one time, so the course does not multiply it', async () => {
  // $3.04 spent, $1.49 of it the chat start, 50% of the work done, no estimate.
  // The work left is 1.55 / 0.5 x 0.5 = 1.55. 0.8.0: with 15% on top, 3.04 + 1.78 = 4.82. Pace on the whole spend would give 6.08 and more.
  const b = withLeft(budget({ limit: 5, spent: 3.04, load: { tokens: 186_000, usd: 1.49 } }), 0.5)
  expect(Math.abs((b.left?.usd ?? 0) - 4.8225) < 0.01).toBe(true)
  // The reading comes before the task list of Claude.
  const todos = [
    { text: 'A', status: 'completed' as const },
    { text: 'B', status: 'pending' as const },
    { text: 'C', status: 'pending' as const },
  ]
  expect(forecast({ ...b, todos })?.basis).toBe('left')
})

test('0.7.1: the chat is read again when real money was spent since the last read', async () => {
  const b = budget({ limit: 5, spent: 0.3, estimate: EST })
  expect(mustRead(b)).toBe(true)
  // 0.8.0: the gap is 4% of the likely cost, from $0.08 to $0.25. 4% of $1.20 is under $0.08, so $0.08.
  expect(mustRead({ ...b, readAt: 0.25 })).toBe(false)
  expect(mustRead({ ...b, spent: 0.36, readAt: 0.25 })).toBe(true)
  // A big task: 4% of $20 is $0.80, kept to $0.25.
  const big = budget({ limit: 38, spent: 2, readAt: 1.8, estimate: { ...EST, likely: 20 } })
  expect(mustRead(big)).toBe(false)
  expect(mustRead({ ...big, spent: 2.06 })).toBe(true)
  // A new step in Claude's task list is read at once.
  expect(mustRead({ ...b, readAt: 0.3, isStepNew: true })).toBe(true)
  expect(mustRead({ ...b, readAt: 0.3, isStepNew: true, checks: 24 })).toBe(false)
  expect(mustRead({ ...b, checks: 24 })).toBe(false)
  expect(mustRead({ ...b, task: '' })).toBe(false)
  expect(mustRead({ ...b, firstCost: 0.3 })).toBe(false)
})

test('0.7.1: one tool call in a few words', async () => {
  expect(callLine('Bash', { command: 'gws gmail   users messages list', description: 'List mail' })).toBe('Bash: gws gmail users messages list')
  expect(callLine('mcp__ccd_turn__update_plan', { advance: true })).toBe('ccd_turn__update_plan')
  expect(callLine('Read', { file_path: '/a/b.md' })).toBe('Read: /a/b.md')
})

test('0.7.1: the advice question says when both costs are about the same', async () => {
  const q = adviceQuestion({ model: 'opus', effort: 'medium' }, { model: 'claude-opus-5-5', effort: 'high' }, 'a clear job', { nowUsd: 2.36, toUsd: 2.32, ctx: 186_000 })
  expect(q.text).toBe('Run this on Opus at medium: about $2.32 either way. Switch?')
})
