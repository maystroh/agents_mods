// Tests for the budget math. No engine calls: each test gives numbers in and checks numbers out.
// The expected values are worked out by hand from the price table, not copied from a run.

import { expect, test } from 'claude-code/testing'
import type { Budget, Plan, PlanStep, Run } from '../types'
import {
  addPoint,
  markStepStarts,
  PATH_MAX,
  FRESH_TOKENS,
  HOUR,
  KEEP,
  RAISE,
  HANDOFF,
  HANDED_OFF,
  HELPER_DENY,
  HELPER_STOP,
  HELPER_WRAP,
  LAND_DENY,
  STOPPED,
  defaultLimit,
  LIMIT_TIMES,
  learnedTimes,
  courseAt,
  todoPart,
  stepMark,
  withLeft,
  LEFT_MARGIN,
  TIMES_CEIL,
  TIMES_FLOOR,
  handoffModel,
  mustAskEarly,
  mustAskNear,
  raiseTo,
  LAND,
  STOP,
  afterStep,
  amountIn,
  bandLine,
  charge,
  closeOutcome,
  donePlan,
  countTools,
  decide,
  estimateLine,
  fits,
  floor2,
  forecast,
  freshFrom,
  gateWhy,
  isPlanDone,
  label,
  learnTune,
  live,
  newBudget,
  nextCost,
  parseInline,
  inlineIn,
  planFromEstimate,
  priceOf,
  questionFor,
  repriceAfterScout,
  reserveOf,
  reserveSpent,
  runOf,
  safeLine,
  scoreOf,
  spentOf,
  planFromTodos,
  listRank,
  atStep,
  statusText,
  suggestAdd,
  taskCost,
  testToken,
  todosFrom,
  tone,
  tuneFor,
  unit,
  usd,
} from './core.ts'
import { START_RATIO } from './estimator.ts'

const NOW = 1_800_000_000_000
const OPUS = 'claude-opus-5-5'

function budget(over: Partial<Budget> = {}): Budget {
  return { ...newBudget({ limit: 5.5, task: 'research the claude models', startCost: 0, model: OPUS, isFresh: true, id: 'b1', now: NOW }), ...over }
}

function step(over: Partial<PlanStep> = {}): PlanStep {
  return { name: 'Step', usd: 1, spent: 0, state: 'pending', isWarned: false, ...over }
}

function plan(steps: PlanStep[], over: Partial<Plan> = {}): Plan {
  return { status: 'approved', steps, reserve: 1, base: 0, isHeard: true, byTool: true, ...over }
}

function near(a: number, b: number, by = 1e-9): boolean {
  return Math.abs(a - b) <= by
}

const ESTIMATE = {
  low: 2,
  likely: 3,
  safe: 5,
  kind: 'research',
  mode: 'normal',
  confidence: 'medium',
  basis: 'counted',
  similar: 0,
  unsure: [],
  cost: 0.01,
  units: {},
  helpers: [],
} as unknown as NonNullable<Budget['estimate']>

/** The same estimate as 0.5.0 makes it: with the band that half of such tasks are in, and the proof of the safe amount. */
const BANDED = { ...ESTIMATE, usual: [2.4, 3.9] as [number, number], hold: 95 }

/** One warm main chat request on Opus 5.5: 200,000 tokens read from the cache, 100 tokens out. */
const WARM = { model: OPUS, input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 100 }

test('usd shows two digits, and four under one cent', async () => {
  expect(usd(1.234)).toBe('$1.23')
  expect(usd(0.004)).toBe('$0.0040')
  expect(usd(-1)).toBe('$0.00')
  expect(floor2(0.29)).toBe(0.29)
})

test('live: a value that is not a budget reads as none', async () => {
  expect(live(null)).toBeNull()
  expect(live('x')).toBeNull()
  expect(live({ v: 1, limit: 5, bars: [] })).toBeNull()
  expect(live({ v: 3, limit: '5', bars: [] })).toBeNull()
})

test('live: a 0.3.0 budget is upgraded, and 0.8.0 puts it in guard mode', async () => {
  const old = { v: 2, id: 'b0', limit: 5, spent: 1, bars: [1], plan: null, pending: '', isPaused: false }
  const b = live(old)
  expect(b?.v).toBe(3)
  expect(b?.mode).toBe('guard')
  expect(b?.phase).toBe('run')
  expect(b?.notes).toEqual([])
  expect(b?.todos).toEqual([])
  expect(b?.ask).toBeNull()
  expect(b?.estimate).toBeNull()
  expect(b?.limit).toBe(5)
  expect(b?.spent).toBe(1)
})

test('0.8.0: a budget that 0.7.6 saved in pace mode, with notes and an old question, loses all three', async () => {
  const old = { ...budget({ spent: 2 }), mode: 'pace', notes: ['[Task budget: $3.50 of $5.50 left.]'], ask: { kind: 'forecast' } }
  const b = live(old)
  expect(b?.mode).toBe('guard')
  expect(b?.notes).toEqual([])
  expect(b?.ask).toBeNull()
  expect(b?.spent).toBe(2)
  const stuck = live({ ...budget(), ask: { kind: 'stuck', step: 0 } })
  expect(stuck?.ask).toBeNull()
  // A question that 0.8.0 still asks stays.
  expect(live({ ...budget(), ask: { kind: 'near' } })?.ask).toEqual({ kind: 'near' })
})

test('live: a whole 0.4.0 budget comes back as it is', async () => {
  const b = budget()
  expect(live(b)).toBe(b)
})

test('spentOf uses the session cost when the engine has one', async () => {
  expect(spentOf(budget({ startCost: 2, ownSpend: 0.4 }), 5)).toBe(3)
  expect(spentOf(budget({ startCost: 2, ownSpend: 0.4 }), undefined)).toBe(0.4)
  expect(spentOf(budget({ startCost: 6 }), 5)).toBe(0)
})

test('label and status line follow the state', async () => {
  expect(label(budget({ spent: 1 }))).toBe('On track')
  expect(label(budget({ spent: 4 }))).toBe('Running low')
  expect(label(budget({ spent: 5 }))).toBe('Almost out')
  expect(label(budget({ spent: 1, phase: 'landing' }))).toBe('Finishing')
  expect(label(budget({ spent: 1, waiting: '$1.00 of $5.50 spent' }))).toBe('Paused')
  expect(label(budget({ spent: 1, isPaused: true, waiting: 'x' }))).toBe('Stopped')
  expect(statusText(budget({ spent: 1.47 }))).toBe('Budget $1.47 / $5.50 · $4.03 left')
  expect(statusText(budget({ spent: 1.47, isPaused: true }))).toBe('Budget stopped: $1.47 / $5.50')
  expect(statusText(budget({ spent: 1.47, waiting: 'x' }))).toBe('Budget paused: $1.47 / $5.50')
})

test('priceOf: one warm Opus 5.5 request', async () => {
  // 10 x $4 + 200,000 x $0.20 + 100 x $20, per million.
  expect(near(priceOf(WARM), 0.04204)).toBe(true)
})

test('priceOf: Haiku 5 costs five times more above 100,000 prompt tokens', async () => {
  const big = { model: 'claude-haiku-5-5', input_tokens: 0, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 0 }
  const small = { ...big, cache_read_input_tokens: 50_000 }
  expect(near(priceOf(big), 0.01)).toBe(true)
  expect(near(priceOf(small), 0.0005)).toBe(true)
})

test('freshFrom: past chats in the folder win, then the measured size, then the guess', async () => {
  const none = { n: 0, idle: 0, step: 0 }
  expect(freshFrom({ '/work': { n: 2, tokens: 150_000 } }, none, '/work', 90_000, 'idle')).toEqual({ tokens: 150_000, how: 'folder' })
  expect(freshFrom({}, none, '/work', 90_000, 'idle')).toEqual({ tokens: 180_000, how: 'measured' })
  expect(freshFrom({}, none, '/work', 90_000, 'step')).toEqual({ tokens: 99_000, how: 'measured' })
  expect(freshFrom({}, { n: 11, idle: 2.38, step: 1.28 }, '/work', 100_000, 'idle')).toEqual({ tokens: 238_000, how: 'measured' })
  expect(freshFrom({}, none, '/work', 0, 'idle')).toEqual({ tokens: startGuess(''), how: 'guess' })
})

test('nextCost: the first request of a new chat is priced as all new', async () => {
  const e = nextCost(null, OPUS, { ctx: 0, now: NOW, fresh: { tokens: 200_000, how: 'measured' } })
  // 200,000 x $8 per million, plus 2,000 written and 600 out.
  expect(near(e.cost, 1.628)).toBe(true)
  expect(near(e.later ?? 0, 0.068)).toBe(true)
  expect(e.isCold).toBe(true)
})

test('nextCost: a warm request reads the chat from the cache', async () => {
  const b = budget({ ctxTokens: 200_000, delta: 0.02, lastAt: NOW - 1000, lastModel: OPUS })
  const e = nextCost(b, OPUS, { ctx: 0, now: NOW })
  expect(near(e.cost, 0.06)).toBe(true)
  expect(e.isCold).toBe(false)
})

test('nextCost: a long wait or a model change loads the chat again in full', async () => {
  const idle = budget({ ctxTokens: 200_000, delta: 0.02, lastAt: NOW - 2 * HOUR, lastModel: OPUS })
  const a = nextCost(idle, OPUS, { ctx: 0, now: NOW })
  expect(near(a.cost, 1.62)).toBe(true)
  expect(a.isCold).toBe(true)
  expect(a.why).toContain('sat still')

  const short = budget({ ctxTokens: 200_000, delta: 0.02, lastAt: NOW - 6 * 60_000, lastModel: OPUS })
  expect(nextCost(short, OPUS, { ctx: 0, now: NOW }).isCold).toBe(false)
  expect(nextCost(short, OPUS, { ctx: 0, now: NOW, ttl: 5 * 60_000 }).isCold).toBe(true)

  const moved = budget({ ctxTokens: 200_000, delta: 0.02, lastAt: NOW - 1000, lastModel: 'claude-sonnet-5-5' })
  const c = nextCost(moved, OPUS, { ctx: 0, now: NOW })
  expect(c.isCold).toBe(true)
  expect(c.why).toContain('model changed')
})

test('nextCost: with no budget it uses the size the engine gives', async () => {
  expect(near(nextCost(null, OPUS, { ctx: 0, now: NOW }).cost, 0.04)).toBe(true)
  expect(near(nextCost(null, OPUS, { ctx: 500_000, now: NOW }).cost, 0.128)).toBe(true)
})

test('fits counts the requests that are left', async () => {
  const b = budget({ spent: 1.47 })
  expect(fits(b, 0.06)).toBe(67)
  expect(fits(b, 1.6, 0.06)).toBe(41)
  expect(fits(b, 5, 0.06)).toBe(0)
  expect(fits(b, 0)).toBe(0)
})

test('reserveOf keeps two requests back, inside 3% to 25% of the limit', async () => {
  expect(near(reserveOf(5.5, 0.06), 0.165)).toBe(true)
  expect(near(reserveOf(5.5, 0.5), 1)).toBe(true)
  expect(near(reserveOf(5.5, 1), 1.375)).toBe(true)
  expect(near(reserveOf(100, 0.06), 3)).toBe(true)
})

test('afterStep counts a main chat response', async () => {
  const b = budget({ ownSpend: 1, spent: 1, bars: [1, 0], msgStart: 1 })
  const next = afterStep(b, WARM, undefined, undefined, NOW)
  expect(near(next.spent, 1.04204)).toBe(true)
  expect(near(next.bars[1] ?? 0, 0.04204)).toBe(true)
  expect(next.steps).toBe(1)
  expect(next.ctxTokens).toBe(200_110)
  // The new part: 100 tokens out at $20 per million.
  expect(near(next.delta, 0.002)).toBe(true)
  expect(next.lastAt).toBe(NOW)
  expect(next.lastModel).toBe(OPUS)
})

test('afterStep: the typical new part moves slowly, and a cold request does not move it', async () => {
  const b = budget({ delta: 0.02 })
  expect(near(afterStep(b, WARM, undefined, undefined, NOW).delta, 0.0128)).toBe(true)
  const cold = { ...WARM, cache_read_input_tokens: 0, cache_creation_input_tokens: 200_000 }
  expect(afterStep(b, cold, undefined, undefined, NOW).delta).toBe(0.02)
})

test('afterStep: the engine total wins over the own count', async () => {
  const b = budget({ startCost: 2, ownSpend: 1 })
  expect(afterStep(b, WARM, 4.5, undefined, NOW).spent).toBe(2.5)
})

test('afterStep: a helper response goes to its model family and not to the main chat', async () => {
  const u = { model: 'claude-haiku-4-5', input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1000 }
  const one = afterStep(budget(), u, undefined, 'a1', NOW)
  // 1,000 x $1 + 1,000 x $5, per million.
  expect(near(one.helpers.haiku?.cost ?? 0, 0.006)).toBe(true)
  expect(one.helpers.haiku?.agents).toBe(1)
  expect(one.seen).toEqual(['a1'])
  expect(one.steps).toBe(0)
  expect(one.ctxTokens).toBe(0)
  const two = afterStep(one, u, undefined, 'a1', NOW)
  expect(two.helpers.haiku?.agents).toBe(1)
  expect(near(two.helpers.haiku?.cost ?? 0, 0.012)).toBe(true)
  expect(near(two.spent, 0.012)).toBe(true)
})

test('charge puts spend on the active step and names a stuck step once', async () => {
  const b = budget({ plan: plan([step({ name: 'Read', usd: 0.5, spent: 0.4, state: 'active' }), step({ name: 'Write' })]) })
  const a = charge(b, 0.3)
  expect(near(a.next.plan?.steps[0]?.spent ?? 0, 0.7)).toBe(true)
  expect(a.stuck).toBe(-1)
  // 1.1 is twice the amount, and 0.6 over is more than 5% of the limit.
  const far = charge(b, 0.7)
  expect(far.stuck).toBe(0)
  expect(far.next.plan?.steps[0]?.isWarned).toBe(true)
  expect(charge(far.next, 0.5).stuck).toBe(-1)
})

test('charge does nothing with no plan or no active step', async () => {
  const none = budget()
  expect(charge(none, 1).next).toBe(none)
  const idle = budget({ plan: plan([step()]) })
  expect(charge(idle, 1).next).toBe(idle)
  expect(charge(idle, 1).stuck).toBe(-1)
})

test('planFromEstimate keeps the step dollars and puts the rest in one buffer', async () => {
  const p = planFromEstimate(
    [
      { name: 'Read', done: 'all files read', usd: 1 },
      { name: 'Write', done: '', usd: 2 },
    ],
    5,
    0.5,
  )
  expect(p?.status).toBe('approved')
  expect(p?.source).toBe('estimate')
  expect(p?.byTool).toBe(false)
  expect(p?.base).toBe(0.5)
  expect(p?.steps.map(s => s.usd)).toEqual([1, 2])
  expect(p?.steps[0]?.done).toBe('all files read')
  expect(p?.steps[1]?.done).toBeUndefined()
  expect(p?.reserve).toBe(2)
})

test('planFromEstimate: a task of one step gets no plan', async () => {
  expect(planFromEstimate([{ name: 'Do it', done: '', usd: 1 }], 5, 0)).toBeNull()
  expect(planFromEstimate([], 5, 0)).toBeNull()
})

test('planFromEstimate: steps never take more than 90% of the money', async () => {
  const p = planFromEstimate(
    [
      { name: 'A', done: '', usd: 4 },
      { name: 'B', done: '', usd: 6 },
    ],
    5,
    0,
  )
  expect(p?.steps.map(s => s.usd)).toEqual([1.8, 2.7])
  expect(p?.reserve).toBe(0.5)
})

test('repriceAfterScout sets the later steps from the measured price of one item', async () => {
  const b = budget({
    limit: 10,
    plan: plan(
      [
        step({ name: 'Scout: 5 of 50 leads', usd: 0.5, spent: 0.4, state: 'done', scout: { items: 5, total: 50 } }),
        step({ name: 'The other leads', usd: 2 }),
        step({ name: 'Report', usd: 1 }),
      ],
      { reserve: 6.5 },
    ),
  })
  const r = repriceAfterScout(b, 0)
  expect(near(r?.perItem ?? 0, 0.08)).toBe(true)
  // 45 items are left, at $0.08 each.
  expect(near(r?.rest ?? 0, 3.6)).toBe(true)
  expect(r?.next.plan?.steps.map(s => s.usd)).toEqual([0.5, 2.4, 1.2])
  expect(r?.next.plan?.reserve).toBe(5.9)
  expect(r?.next.limit).toBe(10)
})

test('repriceAfterScout: a step that is not a scout gives nothing', async () => {
  const b = budget({ plan: plan([step({ spent: 0.4, state: 'done' }), step()]) })
  expect(repriceAfterScout(b, 0)).toBeNull()
  expect(repriceAfterScout(budget(), 0)).toBeNull()
})

test('todosFrom reads a whole task list from any tool', async () => {
  const rows = todosFrom('TodoWrite', { todos: [{ content: 'Read', status: 'completed' }, { content: 'Write', status: 'in_progress' }] }, [])
  expect(rows).toEqual([
    { text: 'Read', status: 'completed' },
    { text: 'Write', status: 'in_progress' },
  ])
  const items = todosFrom('mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'pending' }] }, [])
  expect(items).toEqual([{ text: 'A', status: 'pending' }])
})

test('todosFrom reads the short forms that move one item', async () => {
  const old = [
    { text: 'A', status: 'in_progress' as const },
    { text: 'B', status: 'pending' as const },
    { text: 'C', status: 'pending' as const },
  ]
  expect(todosFrom('mcp__ccd_turn__update_plan', { advance: true }, old)?.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(todosFrom('mcp__ccd_turn__update_plan', { done: [1, 2], start: 3 }, old)?.map(t => t.status)).toEqual(['completed', 'completed', 'in_progress'])
  expect(todosFrom('TaskUpdate', { taskId: '2', status: 'completed' }, old)?.map(t => t.status)).toEqual(['in_progress', 'completed', 'pending'])
  expect(todosFrom('TaskCreate', { subject: 'D' }, old)).toHaveLength(4)
  // The old list is not changed.
  expect(old[0]?.status).toBe('in_progress')
})

test('todosFrom ignores tools that are not about a task list', async () => {
  expect(todosFrom('Bash', { command: 'ls' }, [])).toBeNull()
  expect(todosFrom('TodoWrite', { todos: [{ content: 'A', status: 'odd' }] }, [])).toBeNull()
  expect(todosFrom('TaskCreate', { subject: 'First' }, [])).toEqual([{ text: 'First', status: 'pending' }])
})

test('countTools sorts tool names into kinds of work', async () => {
  const used = countTools({ read: 1 }, ['Read', 'Bash', 'WebSearch', 'Edit', 'Agent', 'mcp__Claude_Browser__navigate', 'mcp__notion__search', 'TodoWrite'])
  expect(used).toEqual({ read: 2, bash: 1, web: 1, edit: 1, agent: 1, browser: 1, mcp: 1, meta: 1 })
  const same = { read: 1 }
  expect(countTools(same, [])).toBe(same)
})

test('forecast: nothing to go on gives none', async () => {
  expect(forecast(budget({ spent: 1 }))).toBeNull()
})

test('forecast: with only an estimate it is what tasks that got this far cost in the end', async () => {
  // The estimate has three points: 1 task in 10 under $2, half under $3, 9 in 10 under $5.
  // $1 spent: almost every such task passes $1, so the middle stays near $3. By hand: 3.0036.
  const early = forecast(budget({ spent: 1, estimate: ESTIMATE }))
  expect(early?.basis).toBe('estimate')
  expect(near(early?.usd ?? 0, 3.0036, 0.001)).toBe(true)
  // $4 spent: only the dear tasks are left. Half of them end under 4.85 (by hand).
  const late = forecast(budget({ spent: 4, estimate: ESTIMATE }))
  expect(near(late?.usd ?? 0, 4.85, 0.005)).toBe(true)
  // The estimate is for the first task. When that task has its answer, the estimate says nothing about later messages.
  expect(forecast(budget({ spent: 4, estimate: ESTIMATE, firstCost: 2.1 }))).toBeNull()
})

test('forecast: the task list of Claude sets the rate', async () => {
  const todos = [
    { text: 'A', status: 'completed' as const },
    { text: 'B', status: 'in_progress' as const },
    { text: 'C', status: 'pending' as const },
    { text: 'D', status: 'pending' as const },
  ]
  // 1.5 of 4 items are done for $1.50. The work left is 1.50 / 0.375 x 0.625 = 2.50.
  // 0.8.0: plus 15% for mistakes and retries: 1.50 + 2.50 x 1.15 = 4.375.
  expect(forecast(budget({ spent: 1.5, todos }))).toEqual({ usd: 4.375, basis: 'todos' })
  // Under a quarter done and no estimate: too early to say.
  const early = [todos[1]!, todos[2]!, todos[3]!]
  expect(forecast(budget({ spent: 1.5, todos: early }))).toBeNull()
  // 0.8.0: with an estimate, a small part done still gives a course. The estimate leads it.
  // Part 1/6. Estimate work left 3 x 5/6 = 2.50. Left = 5/6 x 2.50 + 1.50 x 5/6 = 3.33. Then 1.50 + 3.33 x 1.15 = 5.33.
  const f = forecast(budget({ spent: 1.5, todos: early, estimate: ESTIMATE }))
  expect(f?.basis).toBe('todos')
  expect(Math.abs((f?.usd ?? 0) - 5.333) < 0.01).toBe(true)
})

test('forecast: a plan Claude reports on sets the rate from its finished steps', async () => {
  const p = plan([step({ usd: 1, spent: 2, state: 'done' }), step({ usd: 1, spent: 0.5, state: 'active' }), step({ usd: 2 })])
  // The finished step ran at twice its amount. Active: 2 - 0.5. Pending: 4. Plus 2.5 spent.
  expect(forecast(budget({ spent: 2.5, plan: p }))).toEqual({ usd: 8, basis: 'plan' })
})

test('forecast: a plan from the estimate does not count until Claude reports a step', async () => {
  const p = plan([step({ usd: 1, spent: 2, state: 'done' }), step({ usd: 2 })], { byTool: false })
  expect(forecast(budget({ spent: 2.5, plan: p }))).toBeNull()
})

test('0.8.0 mustAskEarly: half the limit spent and on course for 1.2 times the limit or more', async () => {
  // The limit is 5.50: half is 2.75, and 1.2 times is 6.60.
  const f = { usd: 6.6, basis: 'todos' as const }
  expect(mustAskEarly(budget({ spent: 2.75 }), f)).toBe(true)
  expect(mustAskEarly(budget({ spent: 2.75 }), { usd: 6.59, basis: 'todos' })).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.74 }), f)).toBe(false)
  // One time in a task.
  expect(mustAskEarly(budget({ spent: 2.75, isEarlyAsked: true }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75, ask: { kind: 'near' } }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 4.6, nearAt: 5.5 }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75, phase: 'landing' }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75, isPaused: true }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75, isOpen: true }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75, isTrack: true }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75 }), null)).toBe(false)
})

test('0.8.0: the 80% pause stays as it was', async () => {
  const f = { usd: 5.8, basis: 'todos' as const }
  expect(mustAskNear(budget({ spent: 4.4 }), f)).toBe(true)
  expect(mustAskNear(budget({ spent: 4.39 }), f)).toBe(false)
  expect(mustAskNear(budget({ spent: 4.4 }), { usd: 5.77, basis: 'todos' })).toBe(false)
  expect(mustAskNear(budget({ spent: 4.4, nearAt: 5.5 }), f)).toBe(false)
})

test('0.8.0: the default limit is 1.5 times the likely cost, rounded up', async () => {
  // 1.5 x 3 = 4.50. 1.5 x 3.45 = 5.175, up to the next quarter: 5.25. 1.5 x 0.37 = 0.555, up to 0.60. 1.5 x 13 = 19.50.
  expect(LIMIT_TIMES).toBe(1.5)
  expect(defaultLimit({ likely: 3 })).toBe(4.5)
  expect(defaultLimit({ likely: 3.45 })).toBe(5.25)
  expect(defaultLimit({ likely: 0.37 })).toBe(0.6)
  expect(defaultLimit({ likely: 13 })).toBe(19.5)
  for (const likely of [0.01, 0.2, 0.99, 1.3, 4.1, 9.9, 24.3, 61]) expect(defaultLimit({ likely }) >= 1.5 * likely - 1e-9).toBe(true)
  // It is under the old default, the safe amount, for the estimate of the tests (safe $5, likely $3: 1.5x is $4.50).
  expect(defaultLimit(ESTIMATE)).toBe(4.5)
})

test('0.8.0: the hand off goes one model cheaper, and Haiku has no hand off', async () => {
  expect(handoffModel('claude-opus-5-5')).toBe('sonnet')
  expect(handoffModel('claude-fable-5-2')).toBe('sonnet')
  expect(handoffModel('claude-sonnet-5-5')).toBe('haiku')
  expect(handoffModel('claude-haiku-5-5')).toBeNull()
  // No model known: the chat runs on the default, Opus.
  expect(handoffModel(undefined)).toBe('sonnet')
})

test('0.8.0 gateWhy: the money kept back stops a request only when the task is on course to pass the limit', async () => {
  // The limit is 5.50 and the reserve is 0.165, so the line is 5.335. Nothing says where the task goes.
  const b = budget()
  expect(gateWhy(b, 5.2, 0, 0.06, 0.06, false)).toBeNull()
  expect(gateWhy(b, 5.3, 0, 0.06, 0.06, false)).toBeNull()
  expect(gateWhy(b, 5.44, 0, 0.06, 0.06, false)).toBeNull()
  // A request that would pass the limit always waits.
  expect(gateWhy(b, 5.45, 0, 0.06, 0.06, false)).toEqual({ kind: 'cap' })
  expect(gateWhy(b, 5.2, 0.31, 0.06, 0.06, false)).toEqual({ kind: 'cap' })
  // On course to finish under the limit: it never waits.
  const under = budget({ left: { part: 0.9, at: 5, usd: 5.45 } })
  expect(gateWhy(under, 5.3, 0, 0.06, 0.06, false)).toBeNull()
  // On course to pass it: the money kept back stops the request.
  const over = budget({ left: { part: 0.6, at: 5, usd: 7 } })
  expect(gateWhy(over, 5.3, 0, 0.06, 0.06, false)).toEqual({ kind: 'cap' })
  expect(gateWhy(over, 5.2, 0, 0.06, 0.06, false)).toBeNull()
  // A helper waits at the same line.
  expect(gateWhy(over, 5.3, 0, 0.06, 0.06, true)).toEqual({ kind: 'cap' })
})

test('gateWhy: a stopped budget lets nothing out', async () => {
  expect(gateWhy(budget({ isPaused: true }), 0, 0, 0.01, 0.01, false)).toEqual({ kind: 'paused' })
  expect(gateWhy(budget({ isPaused: true }), 0, 0, 0.01, 0.01, true)).toEqual({ kind: 'paused' })
})

test('gateWhy: while finishing, only the limit itself stops a request', async () => {
  const b = budget({ phase: 'landing' })
  expect(gateWhy(b, 5.4, 0, 0.06, 0.06, false)).toBeNull()
  expect(gateWhy(b, 5.45, 0, 0.06, 0.06, false)).toEqual({ kind: 'hard' })
})

test('gateWhy: an advice question waits for the main chat and not for a helper', async () => {
  const b = budget({ ask: { kind: 'early' } })
  expect(gateWhy(b, 2, 0, 0.06, 0.06, false)).toEqual({ kind: 'early' })
  expect(gateWhy(b, 2, 0, 0.06, 0.06, true)).toBeNull()
})

test('suggestAdd offers one amount: half the budget again, or what the task is on course for', async () => {
  const b = budget()
  // Nothing says where the task goes: half of 5.50 is 2.75.
  expect(suggestAdd(b, 0.06, null)).toBe(2.75)
  // On course for 8. The money kept back at 8 is 3% of it, 0.24. So 8.24 less 5.50 is 2.74, shown as 2.75.
  expect(suggestAdd(b, 0.06, { usd: 8, basis: 'plan' })).toBe(2.75)
  // On course for 12: 12.36 less 5.50 is 6.86, shown as 7.
  expect(suggestAdd(b, 0.06, { usd: 12, basis: 'todos' })).toBe(7)
})

test('suggestAdd: with only an estimate, the amount covers 3 of 4 tasks that got this far', async () => {
  // A $3 budget, $2.90 spent, estimate $2 to $5 with $3 likely.
  // Of the tasks that passed $2.90, 3 in 4 end under 4.607 (by hand, on the three points of the estimate).
  // The money kept back at 4.607 is 3% of it, 0.138. So 4.745 less 3 is 1.745, shown as 1.75.
  const b = budget({ limit: 3, spent: 2.9, estimate: ESTIMATE })
  expect(suggestAdd(b, 0.06, forecast(b))).toBe(1.75)
  // The estimate is far under the limit: it sets no goal, so the amount is half the budget again.
  const roomy = budget({ spent: 0.5, estimate: ESTIMATE })
  expect(suggestAdd(roomy, 0.06, forecast(roomy))).toBe(2.75)
})

test('suggestAdd: a dear first request is paid one time, so the amount stays small', async () => {
  // A $1 budget in a new chat. The first request costs 1.628, and the later ones 0.068.
  // Need: 1.628 + 5 x 0.068 = 1.968, shown as 2.
  const b = budget({ limit: 1, spent: 0, ownSpend: 0 })
  expect(suggestAdd(b, 1.628, null, 0.068)).toBe(2)
  // Without the later cost it took six dear requests: 9.768, shown as 10.
  expect(suggestAdd(b, 1.628, null)).toBe(10)
  const q = questionFor({ kind: 'cap' }, b, 0, 1.628, null, 0.068)
  expect(q.options).toEqual(['Raise the limit to $3.00', HANDOFF, STOP])
  expect(raiseTo(b, 1.628, null, 0.068)).toBe(3)
})

test('0.8.0 questionFor: the pause is one short line, then three buttons: Raise the limit, Hand off and Stop', async () => {
  const q = questionFor({ kind: 'cap' }, budget(), 5.3, 0.06, null)
  expect(q.text).toBe('$5.30 of $5.50 spent. The next request costs about $0.06. What now?')
  expect(q.text.split('\n')).toHaveLength(1)
  expect(q.options).toEqual(['Raise the limit to $8.25', HANDOFF, STOP])
  expect(q.options[0]?.startsWith(RAISE)).toBe(true)
  expect(q.options).not.toContain(KEEP)
  expect(q.options).not.toContain(LAND)
  expect(q.short).toBe('$5.30 of $5.50 spent')
})

test('0.8.0 questionFor: on Sonnet the hand off goes to Haiku, and on Haiku there is no hand off button', async () => {
  const s = questionFor({ kind: 'cap' }, budget({ model: 'claude-sonnet-5-5', lastModel: 'claude-sonnet-5-5' }), 5.3, 0.06, null)
  expect(s.options).toEqual(['Raise the limit to $8.25', HANDOFF, STOP])
  expect(handoffModel('claude-sonnet-5-5')).toBe('haiku')
  const h = questionFor({ kind: 'cap' }, budget({ model: 'claude-haiku-5-5', lastModel: 'claude-haiku-5-5' }), 5.3, 0.06, null)
  expect(h.options).toEqual(['Raise the limit to $8.25', STOP])
})

test('questionFor: with an estimate, the raise covers 3 of 4 tasks that got this far', async () => {
  const b = budget({ limit: 3, spent: 2.9, estimate: ESTIMATE })
  const q = questionFor({ kind: 'cap' }, b, 2.9, 0.06, forecast(b))
  expect(q.options).toEqual(['Raise the limit to $4.75', HANDOFF, STOP])
})

test('questionFor: while Claude finishes, the pause has the same three buttons', async () => {
  const q = questionFor({ kind: 'hard' }, budget({ phase: 'landing' }), 5.45, 0.06, null)
  expect(q.options).toEqual(['Raise the limit to $8.25', HANDOFF, STOP])
  expect(q.text).toBe('$5.45 of $5.50 spent. The next request costs about $0.06. What now?')
})

test('0.8.0 questionFor: the 50% pause, the 80% pause and the size check', async () => {
  const e = questionFor({ kind: 'early' }, budget(), 2.75, 0.06, { usd: 8, basis: 'todos' })
  expect(e.text).toBe('50% spent. On course for $8.00, over your $5.50 limit. What now?')
  expect(e.options).toEqual([KEEP, 'Raise the limit to $8.25', HANDOFF, STOP])

  const n = questionFor({ kind: 'near' }, budget(), 4.5, 0.06, { usd: 6, basis: 'todos' })
  expect(n.text).toBe('82% spent. On course for $6.00, over your $5.50 limit. What now?')
  expect(n.options.length).toBe(3)
  expect(n.options[1]).toBe(HANDOFF)
  expect(n.options[2]).toBe(STOP)
  expect(n.options).not.toContain(KEEP)

  // The size check: Raise goes to the default limit, 1.5 times the likely cost (1.5 x 3 = 4.50).
  const m = questionFor({ kind: 'small' }, budget({ limit: 1, estimate: ESTIMATE }), 0, 0.06, null)
  expect(m.text).toBe('Likely $3.00, over your $1.00 limit. What now?')
  expect(m.options).toEqual([`Raise the limit to $${defaultLimit(ESTIMATE).toFixed(2)}`, 'Keep $1.00', STOP])
  expect(m.options[0]).toBe('Raise the limit to $4.50')
})

test('amountIn finds the first dollar amount', async () => {
  expect(amountIn('Add $2.50')).toBe(2.5)
  expect(amountIn('make it 3,5 please')).toBe(3.5)
  expect(amountIn('none')).toBe(0)
  expect(amountIn('$0')).toBe(0)
})

test('0.8.0 decide: the buttons of the pause', async () => {
  const b = budget()
  const cap = { kind: 'cap' } as const
  const hard = { kind: 'hard' } as const
  const near = { kind: 'near' } as const
  expect(decide(cap, STOP, b)).toEqual({ act: 'stop' })
  expect(decide(cap, HANDOFF, b)).toEqual({ act: 'handoff' })
  expect(decide(near, HANDOFF, b)).toEqual({ act: 'handoff' })
  expect(decide(cap, 'Raise the limit to $8.25', b)).toEqual({ act: 'set', usd: 8.25 })
  expect(decide(hard, 'Raise the limit to $8.25', b)).toEqual({ act: 'set', usd: 8.25 })
  expect(decide(near, 'Raise the limit to $8.25', b)).toEqual({ act: 'set', usd: 8.25 })
  // On Haiku there is no cheaper model: a hand off can only stop.
  expect(decide(cap, HANDOFF, budget({ model: 'claude-haiku-5-5', lastModel: 'claude-haiku-5-5' }))).toEqual({ act: 'stop' })
})

test('0.8.0 decide: the buttons of the 50% pause', async () => {
  const b = budget()
  const early = { kind: 'early' } as const
  // Keep going keeps the limit: the 80% pause can still come.
  expect(decide(early, KEEP, b)).toEqual({ act: 'go' })
  expect(decide(early, 'Raise the limit to $8.25', b)).toEqual({ act: 'set', usd: 8.25 })
  expect(decide(early, HANDOFF, b)).toEqual({ act: 'handoff' })
  expect(decide(early, STOP, b)).toEqual({ act: 'stop' })
})

test('decide: text typed by the person', async () => {
  const b = budget()
  const cap = { kind: 'cap' } as const
  expect(decide(cap, '10', b)).toEqual({ act: 'set', usd: 10 })
  expect(decide(cap, '2', b)).toEqual({ act: 'add', usd: 2 })
  expect(decide(cap, 'raise to 9.50', b)).toEqual({ act: 'set', usd: 9.5 })
  expect(decide(cap, 'add 3', b)).toEqual({ act: 'add', usd: 3 })
  expect(decide(cap, 'set 4', b)).toEqual({ act: 'go' })
  expect(decide(cap, 'hand it off to sonnet', b)).toEqual({ act: 'handoff' })
  expect(decide(cap, 'finish', b)).toEqual({ act: 'stop' })
  expect(decide(cap, 'no', b)).toEqual({ act: 'stop' })
  // Typed words to keep going at a pause take the limit away, as in 0.7.
  expect(decide(cap, 'keep going', b)).toEqual({ act: 'open' })
  expect(decide(cap, 'continue', b)).toEqual({ act: 'open' })
  // "yes" names no choice of a pause: the limit stays, and Claude stops.
  expect(decide(cap, 'yes', b)).toEqual({ act: 'stop' })
  expect(decide({ kind: 'early' }, 'yes', b)).toEqual({ act: 'go' })
  // Words the mod cannot read: a pause stops, the size check carries on.
  expect(decide(cap, 'banana', b)).toEqual({ act: 'stop' })
  expect(decide({ kind: 'hard' }, 'banana', b)).toEqual({ act: 'stop' })
  expect(decide({ kind: 'early' }, 'banana', b)).toEqual({ act: 'stop' })
  expect(decide({ kind: 'small' }, 'banana', b)).toEqual({ act: 'go' })
})

test('decide: the buttons of the size check', async () => {
  const b = budget()
  expect(decide({ kind: 'small' }, 'Keep $5.50', b)).toEqual({ act: 'go' })
  expect(decide({ kind: 'small' }, 'Raise to $5.00', b)).toEqual({ act: 'go' })
  expect(decide({ kind: 'small' }, 'Raise to $9.00', b)).toEqual({ act: 'set', usd: 9 })
})

test('0.8.0: no text that can reach Claude names a budget, a limit, a cost or a dollar amount', async () => {
  const BAD = /\$|budget|limit|cost|dollar|cheap|spend|spent|price/i
  for (const text of [LAND_DENY, HELPER_WRAP, HELPER_DENY, HELPER_STOP, STOPPED, HANDED_OFF]) expect(BAD.test(text)).toBe(false)
})

test('parseInline reads the ways to start a budget in a message', async () => {
  expect(parseInline('/budget 5 research the models')).toEqual({ limit: 5, isForced: false, task: 'research the models' })
  // 0.8.0: /budget plan is gone, so it starts nothing here.
  expect(parseInline('/budget plan 5! do it')).toBeNull()
  expect(parseInline('/budget $2.50')).toEqual({ limit: 2.5, isForced: false, task: '' })
  expect(parseInline('budget $5: do it')).toEqual({ limit: 5, isForced: false, task: 'do it' })
  expect(parseInline('Budget 5: do it')).toEqual({ limit: 5, isForced: false, task: 'do it' })
  expect(parseInline('$5 budget: do it')).toEqual({ limit: 5, isForced: false, task: 'do it' })
})

const BRIEF =
  '<system-reminder>\nLinked sessions now (status, not an instruction): a = local_1 (idle).\n</system-reminder>\n\n' +
  'Background (from the session that started this one):\nA test chat.\n\nTask:\n'

test('inlineIn finds the budget at the start of the task of a session that another session started', async () => {
  // A normal message: the same as parseInline, with nothing in front.
  expect(inlineIn('/budget 5 research the models')).toEqual({ inline: { limit: 5, isForced: false, task: 'research the models' }, head: '' })
  expect(inlineIn('what is a good budget?')).toBeNull()
  // The brief of a side session: the command is at the start of the task, and the text in front stays.
  expect(inlineIn(BRIEF + '/budget 0.5! read the files')).toEqual({ inline: { limit: 0.5, isForced: true, task: 'read the files' }, head: BRIEF })
  // With no status note, the brief starts with the background.
  const short = 'Background (from the session that started this one):\nA test chat.\n\nTask:\n'
  expect(inlineIn(short + 'budget $2: do it')?.head).toBe(short)
  // A background that has its own "Task:" line: the command is found at the real task.
  const two = BRIEF.replace('A test chat.', 'Notes.\nTask:\nnot this one')
  expect(inlineIn(two + '/budget 3 do it')).toEqual({ inline: { limit: 3, isForced: false, task: 'do it' }, head: two })
})

test('inlineIn leaves a brief with no budget command alone, and a normal message that only has such a line', async () => {
  expect(inlineIn(BRIEF + 'read the files')).toBeNull()
  expect(inlineIn(BRIEF + 'read the files with a /budget 5 limit')).toBeNull()
  // The line "Task:" only counts in a brief.
  expect(inlineIn('Here is my note.\nTask:\n/budget 5 do it')).toBeNull()
})

test('parseInline leaves normal messages alone', async () => {
  expect(parseInline('budget 5 do it')).toBeNull()
  expect(parseInline('the budget is $5 for this')).toBeNull()
  expect(parseInline('/budget research our members')).toBeNull()
  expect(parseInline('/budget 0 do it')).toBeNull()
  expect(parseInline('what is a good budget?')).toBeNull()
})

test('testToken takes the test mark out of a task', async () => {
  expect(testToken('do it [tb-test:cap1] now')).toEqual({ token: 'cap1', text: 'do it now' })
  expect(testToken('do it now')).toEqual({ token: '', text: 'do it now' })
})

test('runOf saves the estimate and the result of each step', async () => {
  const p = plan([step({ name: 'A', state: 'done', check: 'met', spent: 0.504 }), step({ name: 'B', state: 'cut' }), step({ name: 'C' })])
  const run = runOf(budget({ spent: 2.468, messages: 3, estimate: ESTIMATE, plan: p }), 'under', '2026-11-13T10:00:00.000Z')
  expect(run.spent).toBe(2.47)
  expect(run.model).toBe('opus')
  expect(run.mode).toBe('guard')
  expect(run.kind).toBe('research')
  expect(run.estimate).toEqual({ low: 2, likely: 3, safe: 5 })
  expect(run.steps?.map(s => s.check)).toEqual(['met', 'skipped', 'not done'])
  expect(run.steps?.[0]?.spent).toBe(0.5)
})

test('runOf keeps the band, the cost of the first task and the open state', async () => {
  const r = runOf(budget({ spent: 7.2, messages: 2, estimate: BANDED, firstCost: 6.1, isOpen: true }), 'over', '2026-11-13T10:00:00.000Z')
  expect(r.estimate).toEqual({ low: 2, likely: 3, safe: 5, usual: [2.4, 3.9], hold: 95 })
  expect(r.first).toBe(6.1)
  expect(r.isOpen).toBe(true)
  const plain = runOf(budget({ spent: 1 }), 'under', '2026-11-13T10:00:00.000Z')
  expect('first' in plain).toBe(false)
  expect('isOpen' in plain).toBe(false)
})

test('closeOutcome: over when money was added or the limit was taken away', async () => {
  expect(closeOutcome(budget())).toBe('under')
  expect(closeOutcome(budget({ raised: 2 }))).toBe('over')
  expect(closeOutcome(budget({ isOpen: true }))).toBe('over')
})

test('Keep going: with no limit nothing waits, and the count runs on', async () => {
  const open = budget({ isOpen: true, spent: 9 })
  // Far past the old limit of 5.50: no request waits.
  expect(gateWhy(open, 9, 0, 0.06, 0.06, false)).toBeNull()
  expect(gateWhy(budget({ isOpen: true, phase: 'landing' }), 9, 0, 0.06, 0.06, false)).toBeNull()
  // A stop still holds everything.
  expect(gateWhy(budget({ isOpen: true, isPaused: true }), 9, 0, 0.06, 0.06, false)).toEqual({ kind: 'paused' })
  expect(mustAskEarly(open, { usd: 20, basis: 'plan' })).toBe(false)
  expect(mustAskNear(open, { usd: 20, basis: 'plan' })).toBe(false)
  expect(label(open)).toBe('No limit')
  expect(statusText(open)).toBe('Budget $9.00 spent · no limit (was $5.50)')
  // The colour is the warning colour, not the stop colour.
  expect(tone(open)).toBe(tone(budget({ spent: 4 })))
  expect(tone(open)).not.toBe(tone(budget({ spent: 5.4 })))
})

function run(over: Partial<Run>): Run {
  return { id: 'r', at: '2026-11-13T10:00:00.000Z', task: 't', limit: 5, spent: 4, messages: 1, model: 'opus', outcome: 'under', kind: 'build', estimate: { low: 1, likely: 2, safe: 3 }, ...over }
}

test('learnTune moves the ratio a part of the way to what really happened', async () => {
  const t = learnTune({}, run({ spent: 4 }))
  // The task cost twice the estimate. 2 to the power 0.35 is 1.2746.
  expect(t.all?.n).toBe(1)
  expect(t.build?.n).toBe(1)
  expect(near(t.all?.ratio ?? 0, START_RATIO * 1.2746, 0.002)).toBe(true)
  expect(t.build?.ratio).toBe(t.all?.ratio)
})

test('learnTune: a cheaper task moves the ratio down', async () => {
  const t = learnTune({}, run({ spent: 1 }))
  expect((t.all?.ratio ?? 9) < START_RATIO).toBe(true)
})

test('learnTune: only a task that ran to its answer counts', async () => {
  const none = {}
  expect(learnTune(none, run({ outcome: 'open' }))).toBe(none)
  expect(learnTune(none, run({ outcome: 'abandoned' }))).toBe(none)
  expect(learnTune(none, run({ outcome: 'ended' }))).toBe(none)
  expect(learnTune(none, run({ estimate: undefined }))).toBe(none)
  // A task that was cut short says little about the estimate, under it or over it.
  expect(learnTune(none, run({ outcome: 'stopped', spent: 1 }))).toBe(none)
  expect(learnTune(none, run({ outcome: 'stopped', spent: 4 }))).toBe(none)
  // Later messages are new work: with two messages and no first cost, the spend is not the cost of the task.
  expect(learnTune(none, run({ messages: 2 }))).toBe(none)
})

test('learnTune: the estimate is for the first task, so its cost is what counts', async () => {
  // The budget ran on for four messages and $9. The first task cost $3: 1.5 times the estimate of $2.
  const t = learnTune({}, run({ spent: 9, messages: 4, first: 3 }))
  // 1.5 to the power 0.35 is 1.1525.
  expect(near(t.all?.ratio ?? 0, START_RATIO * 1.1525, 0.002)).toBe(true)
  // The first task has its answer while the budget is still open: it counts at once.
  expect(learnTune({}, run({ outcome: 'open', first: 3 })).all?.n).toBe(1)
})

test('taskCost: what the first task cost, when that is known', async () => {
  expect(taskCost(run({ first: 3, spent: 9, messages: 4 }))).toBe(3)
  // Closed after one message: the spend is the cost of the task.
  expect(taskCost(run({ spent: 4 }))).toBe(4)
  expect(taskCost(run({ spent: 4, outcome: 'over' }))).toBe(4)
  // Not known: more messages, a task that still runs, or one that was cut short.
  expect(taskCost(run({ spent: 4, messages: 2 }))).toBeNull()
  expect(taskCost(run({ spent: 4, outcome: 'open' }))).toBeNull()
  expect(taskCost(run({ spent: 4, outcome: 'stopped' }))).toBeNull()
  expect(taskCost(run({ spent: 0 }))).toBeNull()
})

test('learnTune: one wild run cannot move the ratio far, and it never passes 3', async () => {
  const one = learnTune({}, run({ spent: 400 }))
  // The step is held to a factor of 3: 3 to the power 0.35 is 1.469.
  expect(near(one.all?.ratio ?? 0, START_RATIO * 1.469, 0.003)).toBe(true)
  let t = {}
  for (let i = 0; i < 30; i++) t = learnTune(t, run({ spent: 400 }))
  expect((t as { all: { ratio: number } }).all.ratio).toBe(3)
})

test('tuneFor uses the kind of task when it has three runs', async () => {
  expect(tuneFor({}, 'build')).toEqual({ ratio: START_RATIO, n: 0 })
  expect(tuneFor({ all: { n: 1, ratio: 1.3 } }, 'build')).toEqual({ n: 1, ratio: 1.3 })
  expect(tuneFor({ all: { n: 5, ratio: 1.3 }, build: { n: 2, ratio: 2 } }, 'build')).toEqual({ n: 5, ratio: 1.3 })
  expect(tuneFor({ all: { n: 5, ratio: 1.3 }, build: { n: 3, ratio: 2 } }, 'build')).toEqual({ n: 3, ratio: 2 })
})

test('scoreOf says how good the estimates were', async () => {
  expect(scoreOf([])).toBeNull()
  expect(scoreOf([run({ outcome: 'open' })])).toBeNull()
  const score = scoreOf([
    run({ spent: 2.5 }), // inside 1 to 3, ratio 1.25
    run({ spent: 4 }), // over the range, ratio 2
    run({ spent: 1.8, outcome: 'over' }), // inside, ratio 0.9
    run({ spent: 9, outcome: 'stopped' }), // not counted
  ])
  // The last 20: 2.5 and 1.8 are inside 2 times the estimate of 2. 4 is 2 times, so it is inside too.
  expect(score).toEqual({ n: 3, ratio: 1.25, inRange: 2, last: 3, in2: 3 })
  // The estimate was for the first task: a budget that ran on to $9 counts with its first $2.20.
  expect(scoreOf([run({ spent: 9, messages: 4, first: 2.2 })])).toEqual({ n: 1, ratio: 1.1, inRange: 1, last: 1, in2: 1 })
})

test('small helpers', async () => {
  // The likely amount leads: it is the estimate. An estimate from before 0.5.0 has only a range.
  expect(estimateLine(ESTIMATE)).toBe('about $3.00, range $2.00 to $5.00')
  // 0.8.0: no safe budget in the line. The default limit is 1.5 times the likely cost.
  expect(estimateLine(BANDED)).toBe('about $3.00, usually $2.40 to $3.90')
  expect(bandLine(ESTIMATE)).toBe('range $2.00 to $5.00')
  expect(bandLine(BANDED)).toBe('usually $2.40 to $3.90')
  expect(safeLine(ESTIMATE)).toBe('safe budget $5.00')
  expect(safeLine(BANDED)).toBe('safe budget $5.00: 95 of 100 such tasks cost less')
  expect(unit(budget({ limit: 3 }))).toBe(0.1)
  expect(unit(budget({ limit: 5.5 }))).toBe(0.25)
  expect(unit(budget({ limit: 20 }))).toBe(1)
  expect(isPlanDone(null)).toBe(false)
  expect(isPlanDone(plan([step({ state: 'done' }), step({ state: 'cut' })]))).toBe(true)
  expect(isPlanDone(plan([step({ state: 'done' }), step()]))).toBe(false)
  expect(isPlanDone(plan([step({ state: 'done' })], { status: 'draft' }))).toBe(false)
  const p = plan([step({ spent: 0.5 }), step({ spent: 0.25 })], { base: 1 })
  // 3 spent, 1 before the plan, 0.75 on steps: the buffer paid 1.25.
  expect(reserveSpent(budget({ spent: 3 }), p)).toBe(1.25)
})

// ---------- 0.7.3 ----------

test('0.7.3: the plan follows the task list of Claude, keeps the real cost of each step, and has no planned dollars', async () => {
  const est = plan([step({ name: 'Read', usd: 1, spent: 0.4, state: 'active' }), step({ name: 'Write', usd: 2 })], { source: 'estimate', byTool: false, base: 1.47 })
  const one = planFromTodos(budget({ plan: est }), [
    { text: 'Find the videos', status: 'in_progress' },
    { text: 'Pull the numbers', status: 'pending' },
    { text: 'Write the report', status: 'pending' },
  ])
  expect(one.plan?.source).toBe('todos')
  expect(one.plan?.base).toBe(1.47)
  expect(one.plan?.steps.map(st => st.name)).toEqual(['Find the videos', 'Pull the numbers', 'Write the report'])
  expect(one.plan?.steps.map(st => st.state)).toEqual(['active', 'pending', 'pending'])
  expect(one.plan?.steps.every(st => st.usd === 0 && st.spent === 0)).toBe(true)
  // The list moves: the cost that a step has stays with the step of the same name.
  const paid = { ...one, plan: { ...one.plan!, steps: one.plan!.steps.map((st, i) => (i === 0 ? { ...st, spent: 0.8 } : st)) } }
  const two = planFromTodos(paid, [
    { text: 'Find the videos', status: 'completed' },
    { text: 'Pull the numbers', status: 'pending' },
    { text: 'Write the report', status: 'pending' },
  ])
  expect(two.plan?.steps.map(st => st.state)).toEqual(['done', 'active', 'pending'])
  expect(two.plan?.steps[0]?.spent).toBe(0.8)
  // 0.7.5: Claude's list is often behind, so the small model moves it on. It never moves back, and a later list keeps those steps done.
  const three = atStep(two, 3)
  expect(three.plan?.steps.map(st => st.state)).toEqual(['done', 'done', 'active'])
  expect(three.plan?.ticked).toBe(1)
  expect(atStep(three, 1)).toBe(three)
  const four = planFromTodos(three, [
    { text: 'Find the videos', status: 'completed' },
    { text: 'Pull the numbers', status: 'in_progress' },
    { text: 'Write the report', status: 'pending' },
  ])
  expect(four.plan?.steps.map(st => st.state)).toEqual(['done', 'done', 'active'])
  expect(four.plan?.ticked).toBe(1)
  // The task is done: every step is ticked, and the run says how many the mod ticked.
  const done = donePlan(four.plan)
  expect(done?.steps.every(st => st.state === 'done')).toBe(true)
  expect(done?.ticked).toBe(2)
})

test('0.7.3: a list of one item, and a plan that Claude wrote with dollars, are left alone', async () => {
  const own = budget({ plan: plan([step({ name: 'Read' }), step({ name: 'Write' })], { source: 'claude', byTool: true }) })
  const list = [
    { text: 'A', status: 'pending' as const },
    { text: 'B', status: 'pending' as const },
  ]
  expect(planFromTodos(own, list)).toBe(own)
  const none = budget({ plan: null })
  expect(planFromTodos(none, [{ text: 'A', status: 'pending' }])).toBe(none)
  expect(planFromTodos(none, list).plan?.source).toBe('todos')
})

test('0.7.3: the task list of the app wins over the list of another mod', async () => {
  expect(listRank('mcp__ccd_turn__update_plan')).toBe(2)
  expect(listRank('TodoWrite')).toBe(2)
  expect(listRank('TaskUpdate')).toBe(2)
  expect(listRank('mcp__helper-desk__plan')).toBe(1)
})

// ---------- 0.7.4: one verdict for the badge, the colours and the graph ----------

import { costVerdict, verdict } from './core.ts'

// The real run of 2026-11-16: plain /budget, estimate $4.06, usual $2.84 to $6.49, safe $22.50.
const REAL_EST = { low: 1.5, likely: 4.06, safe: 22.5, usual: [2.84, 6.49] as [number, number], hold: 95, kind: 'research', mode: 'guard', confidence: 'medium', basis: '', similar: null, units: {}, steps: [] } as unknown as Budget['estimate']
function track(spent: number, over: Partial<Budget> = {}): Budget {
  return budget({ isTrack: true, isOpen: true, limit: 22.5, spent, estimate: REAL_EST, ...over })
}

test('0.7.4: with no limit the verdict follows the estimate, and $4.38 against $4.06 is over it', () => {
  expect(verdict(track(2)).key).toBe('underEst')
  expect(verdict(track(3.9)).key).toBe('atEst')
  expect(verdict(track(4.06)).key).toBe('atEst')
  expect(verdict(track(4.064)).key).toBe('atEst') // shows as $4.06: compared in cents
  expect(verdict(track(4.38)).key).toBe('overEst') // 1.08 times: the bug the user saw
  expect(verdict(track(4.38)).text).toBe('Over the estimate')
  expect(verdict(track(4.38)).tint).toBe(tone(track(4.38)))
  expect(label(track(4.38))).toBe('Over the estimate')
  expect(verdict(track(8.2)).key).toBe('farOver')
  expect(verdict(track(30, { estimate: { ...REAL_EST!, likely: 20 } })).key).toBe('pastSafe')
  expect(statusText(track(4.38))).toContain('over the estimate')
})

test('0.7.4: with a limit the limit states come first, then the course, then the estimate', () => {
  const e = { ...REAL_EST!, likely: 2, usual: [1.4, 3.2] as [number, number] }
  const with5 = (spent: number, over: Partial<Budget> = {}) => budget({ limit: 5, spent, estimate: e, ...over })
  expect(verdict(with5(1)).key).toBe('underEst')
  expect(verdict(with5(2.16)).key).toBe('overEst') // under the limit, over the estimate: not green
  expect(verdict(with5(3.6)).key).toBe('runningLow')
  expect(verdict(with5(4.6)).key).toBe('almostOut')
  expect(verdict(with5(5.2)).key).toBe('overLimit')
  expect(verdict(with5(1, { left: { part: 0.1, at: 1, usd: 9 } })).key).toBe('likelyOver')
  expect(verdict(with5(1, { isPaused: true })).key).toBe('stopped')
  expect(verdict(with5(1, { waiting: 'q' })).key).toBe('paused')
  expect(verdict(with5(1, { phase: 'landing' })).key).toBe('finishing')
  expect(verdict(budget({ spent: 1 })).key).toBe('onTrack')
})

test('0.7.4: a finished task keeps the verdict of its last running state', () => {
  for (const spent of [2, 4.06, 4.38, 8.2]) {
    const b = track(spent, { firstCost: spent })
    const run = runOf(b, closeOutcome(b), '2026-11-16T19:18:31.254Z')
    const e = run.estimate!
    expect(costVerdict({ spent: taskCost(run) ?? run.spent, likely: e.likely, safe: e.safe, limit: null }).key).toBe(verdict(b).key)
  }
  const b = budget({ limit: 5, spent: 4.6, firstCost: 4.6, estimate: { ...REAL_EST!, likely: 2 } })
  const run = runOf(b, closeOutcome(b), '2026-11-16T19:18:31.254Z')
  expect(costVerdict({ spent: taskCost(run) ?? run.spent, likely: 2, safe: 22.5, limit: run.limit }).key).toBe(verdict(b).key)
})


// ---------- 0.7.6 ----------

import { budgetCall, moneyParts } from './core.ts'

test('0.7.6: budgetCall finds /budget at the end of a message, and at its start', () => {
  expect(budgetCall('summarize my Slack messages /budget')).toEqual({ task: 'summarize my Slack messages', isForced: false })
  expect(budgetCall('summarize my Slack messages /budget 5')).toEqual({ task: 'summarize my Slack messages', limit: 5, isForced: false })
  expect(budgetCall('summarize my Slack messages /budget $2.5!')).toEqual({ task: 'summarize my Slack messages', limit: 2.5, isForced: true })
  expect(budgetCall('Can you summarize my Slack messages in the last 24 hours? What needs my attention? /budget')?.task).toBe(
    'Can you summarize my Slack messages in the last 24 hours? What needs my attention?',
  )
  expect(budgetCall('/budget summarize my Slack messages')).toEqual({ task: 'summarize my Slack messages', isForced: false })
})

test('0.7.6: budgetCall leaves other messages alone', () => {
  expect(budgetCall('how does /budget work in this mod')).toBeNull()
  expect(budgetCall('fix it /budget')).toBeNull()
  expect(budgetCall('/budget panel')).toBeNull()
  expect(budgetCall('/budget estimate the landing page')).toBeNull()
  expect(budgetCall('/budget 5 recreate the page')).toBeNull()
  expect(budgetCall('read ~/notes/budget')).toBeNull()
  expect(budgetCall('summarize my Slack messages /budget 0')).toBeNull()
  expect(budgetCall('<system-reminder>x</system-reminder>\nTask:\nsummarize my Slack messages /budget')).toBeNull()
})

test('0.7.6: the money parts add up to the bill', () => {
  // The Slack run of 2026-11-16: the mod priced the requests at $0.77, the bill was $0.57.
  const over = moneyParts(budget({ spent: 0.57, mainCost: 0.77, load: { tokens: 181_846, usd: 0.45 }, isFresh: false }))
  expect(over.map(x => x.name)).toEqual(['Chat read again', 'Work'])
  expect(Math.abs(over.reduce((s, x) => s + x.usd, 0) - 0.57)).toBeLessThanOrEqual(0.011)
  // A bill above the parts: the rest is its own part.
  const under = moneyParts(budget({ spent: 1, mainCost: 0.8, isFresh: true }))
  expect(under).toEqual([
    { name: 'Work', usd: 0.8 },
    { name: 'Other calls', usd: 0.2 },
  ])
})

// ---------- 0.8.0: the default limit learns ----------

test('with no history the default limit is 1.5 times the likely cost', () => {
  expect(learnedTimes([])).toEqual({ times: 1.5, n: 0 })
  expect(defaultLimit({ likely: 4 })).toBe(6)
  expect(defaultLimit({ likely: 4, times: 1.5 })).toBe(6)
})

test('history that lands close to the estimate pulls the multiple down, toward 1x plus a margin', () => {
  const close = [0.92, 0.95, 0.97, 1, 1, 1.01, 1.02, 1.03, 1.04, 1.05]
  const t = learnedTimes(close)
  // The 80% mark is 1.04. With 10% on top that is 1.144, so the floor of 1.15 holds. Blended with 1.5 as 3 tasks: (4.5 + 11.5) / 13 = 1.23.
  expect(t).toEqual({ times: 1.23, n: 10 })
  expect(t.times).toBeLessThan(LIMIT_TIMES)
  // Many more close tasks go on down to the floor.
  const many = learnedTimes(Array.from({ length: 200 }, () => 1))
  expect(many.times).toBeGreaterThanOrEqual(TIMES_FLOOR)
  expect(many.times).toBeLessThan(1.18)
})

test('history that overshoots the estimate pushes the multiple up, to a ceiling', () => {
  const over = [1.4, 1.6, 1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.5, 2.8]
  const t = learnedTimes(over)
  // The 80% mark is 2.5. With 10% on top: 2.75. Blended: (4.5 + 27.5) / 13 = 2.46.
  expect(t).toEqual({ times: 2.46, n: 10 })
  expect(t.times).toBeGreaterThan(LIMIT_TIMES)
  const wild = learnedTimes(Array.from({ length: 200 }, () => 9)).times
  expect(wild).toBeGreaterThan(2.95)
  expect(wild).toBeLessThanOrEqual(TIMES_CEIL)
})

test('one odd task does not swing the multiple far', () => {
  // A single task at 3 times its estimate: raw 3, blended with 1.5 as 3 tasks: (4.5 + 3) / 4 = 1.88.
  expect(learnedTimes([3]).times).toBe(1.88)
})

test('the low-confidence $6.90 task gets a default limit near $10.35, not the wide safe amount of $38', () => {
  const e = { likely: 6.9, safe: 38, times: 1.5 }
  // 1.5 x 6.90 = 10.35, rounded up to the next 50 cents: $10.50.
  expect(defaultLimit(e)).toBe(10.5)
  expect(defaultLimit(e)).toBeLessThan(e.safe)
})

test('the default limit uses the multiple stored on the estimate', () => {
  // a user's history on 2026-11-17: 10 finished tasks give 1.38.
  // 2 x 1.38 = 2.76, rounded up to the next 25 cents: $3.00.
  expect(defaultLimit({ likely: 2, times: 1.38 })).toBe(3)
  expect(defaultLimit({ likely: 2, times: 2.46 })).toBe(5)
})

// ---------- 0.8.0: the forecast is spend so far plus the cost of the work that is left ----------

/** The task in a user's screenshot of 2026-11-17: a $38 limit, an estimate of $6.90 with a chat start of $1.55, and a real chat start of $1.10. */
function shot(over: Partial<Budget> = {}): Budget {
  const estimate = { ...ESTIMATE, low: 3, likely: 6.9, safe: 38, base: { tokens: 186_000, usd: 1.55 }, confidence: 'low' as const }
  return budget({ limit: 38, spent: 1.26, load: { tokens: 186_000, usd: 1.1 }, estimate, ...over })
}

test('0.8.0: the screenshot case, 12% done for $1.26, is on course for about the estimate, not $2.41', () => {
  // The old way: 1.10 + 0.16 / 0.12 = 2.43. It took the slow start as the pace of the whole task.
  // Estimate work left: (6.90 - 1.55) x 0.88 = 4.71. Pace part: 0.16 x 0.88 = 0.14.
  // Left = 0.88 x 4.71 + 0.14 = 4.28. With 15% on top: 4.93. The course is 1.26 + 4.93 = 6.19.
  const b = withLeft(shot(), 0.12)
  const f = forecast(b)
  expect(f?.basis).toBe('left')
  expect(Math.abs((f?.usd ?? 0) - 6.187) < 0.01).toBe(true)
  expect(f?.usd ?? 0).toBeGreaterThan(5.5)
  expect(f?.usd ?? 0).toBeLessThan(8.5)
  expect(LEFT_MARGIN).toBe(0.15)
})

test('0.8.0: a replayed task at 10%, 50% and 90% done', () => {
  // The work runs at the pace of the estimate: $5.35 of work on a real chat start of $1.10. It ends at $6.45.
  const at = (part: number) => forecast(withLeft(shot({ spent: 1.1 + 5.35 * part }), part))?.usd ?? 0
  // At that pace the work left is the true work left, plus 15%.
  expect(Math.abs(at(0.1) - 7.172) < 0.01).toBe(true)
  expect(Math.abs(at(0.5) - 6.851) < 0.01).toBe(true)
  expect(Math.abs(at(0.9) - 6.530) < 0.01).toBe(true)
  // Done: the course is the spend.
  expect(Math.abs(at(1) - 6.45) < 0.001).toBe(true)
})

test('0.8.0: a part under 10% with no estimate gives no course; with an estimate the estimate leads', () => {
  expect(courseAt(budget({ spent: 1 }), 0.05)).toBeNull()
  // Part 0: the work left is all the estimate work, plus the $0.16 of work that bought nothing yet.
  // 1.26 + (5.35 + 0.16) x 1.15 = 7.60.
  expect(Math.abs((courseAt(shot(), 0) ?? 0) - 7.5965) < 0.01).toBe(true)
  // Never more than 6 times the limit.
  expect(courseAt(budget({ spent: 5, limit: 1 }), 0.1)).toBe(30)
})

test('0.8.0: a task that ends under its default limit never meets a pause or a forecast over the limit', () => {
  // Likely $4.00 with a chat start of $1.00. The task really costs 1.1 times that: $4.40.
  // Read at every 25 cents with the true share done. Default limits from the floor (1.15) to 1.5 times.
  for (const times of [1.15, 1.23, 1.38, 1.5]) {
    const estimate = { ...ESTIMATE, likely: 4, base: { tokens: 100_000, usd: 1 }, times }
    const limit = defaultLimit(estimate)
    for (let spent = 1.05; spent <= 4.4 + 1e-9; spent += 0.05) {
      const part = (spent - 1) / 3.4
      const b = withLeft(budget({ limit, spent, load: { tokens: 100_000, usd: 1 }, estimate }), part)
      const f = forecast(b)
      expect(f !== null && f.usd < limit).toBe(true)
      expect(mustAskEarly(b, f)).toBe(false)
      expect(mustAskNear(b, f)).toBe(false)
    }
  }
})

test("0.8.0: Claude's own task list leads when Claude moved a step after the last read", () => {
  const todos = [
    { text: 'A', status: 'completed' as const },
    { text: 'B', status: 'completed' as const },
    { text: 'C', status: 'in_progress' as const },
    { text: 'D', status: 'pending' as const },
  ]
  expect(todoPart(todos)).toBe(0.625)
  expect(todoPart(todos.slice(0, 2))).toBeNull()
  // The read was at $1.26.
  const read = withLeft(shot({ todos }), 0.12)
  // The read is newer than the last move in the list: it leads.
  expect(forecast({ ...read, spent: 1.4, todosAt: 1.2 })?.basis).toBe('left')
  // Claude moved a step at $1.40, after the read: the list leads.
  const f = forecast({ ...read, spent: 1.4, todosAt: 1.4 })
  expect(f?.basis).toBe('todos')
  // Part 0.625. Estimate work left: 5.35 x 0.375 = 2.01. Left = 0.375 x 2.01 + 0.30 x 0.375 = 0.86. Then 1.40 + 0.86 x 1.15 = 2.39.
  expect(Math.abs((f?.usd ?? 0) - 2.3946) < 0.01).toBe(true)
  // A list that is never ticked says nothing; the read stands.
  const idle = todos.map(t => ({ ...t, status: 'pending' as const }))
  expect(forecast({ ...withLeft(shot({ todos: idle }), 0.3) })?.basis).toBe('left')
})

test('0.8.0: the step mark changes when a step is done or a new step is active', () => {
  const a = [
    { text: 'A', status: 'in_progress' as const },
    { text: 'B', status: 'pending' as const },
  ]
  expect(stepMark(a)).toBe('0/0')
  expect(stepMark([{ ...a[0]!, status: 'completed' }, { ...a[1]!, status: 'in_progress' }])).toBe('1/1')
  expect(stepMark(a)).toBe(stepMark([...a]))
})

// ---------- 0.8.0: the mod counts its own cost ----------

import { modGuess, modLines } from './core.ts'

test('0.8.0: the predicted mod cost with no history is the estimate call, one advice call and the reads', () => {
  // $0.42: gap $0.08, 6 reads. 0.005 + 0.006 + 0.030 = 0.041.
  expect(modGuess([], 'edit', 0.42, 0.005)).toBe(0.041)
  // $20: gap $0.25 (4% is $0.80), 80 reads, kept to 24.
  expect(modGuess([], 'edit', 20, 0.005)).toBe(0.131)
})

test('0.8.0: the predicted mod cost moves toward the real numbers: the same kind first, then all runs', () => {
  const run = (kind: string, mod: number) => ({ id: 'r', at: '', limit: 1, spent: 1, messages: 1, outcome: 'ended', model: 'sonnet', kind, mod }) as Run
  // Two runs are too few: the guess.
  expect(modGuess([run('edit', 0.01), run('edit', 0.01)], 'edit', 0.42, 0.005)).toBe(0.041)
  // Three runs of any kind: their middle value.
  expect(modGuess([run('ops', 0.01), run('edit', 0.012), run('ops', 0.2)], 'edit', 0.42, 0.005)).toBe(0.012)
  // Three runs of this kind win over the rest.
  const mixed = [run('edit', 0.02), run('edit', 0.02), run('edit', 0.03), run('ops', 0.5), run('ops', 0.5)]
  expect(modGuess(mixed, 'edit', 0.42, 0.005)).toBe(0.02)
})

test('0.8.0: a run keeps its mod cost and the whole bill of the chat', () => {
  const r = runOf(budget({ spent: 1.2, startCost: 0.8, modCost: 0.034 }), 'ended', '2026-11-17T00:00:00.000Z')
  expect(r.mod).toBe(0.034)
  expect(r.session).toBe(2)
  // No mod calls: no mod field.
  expect(runOf(budget({ spent: 1 }), 'ended', '2026-11-17T00:00:00.000Z').mod).toBeUndefined()
})

test('0.8.0: the mod cost lines use the exact labels, with 3 digits under $0.10', () => {
  expect(modLines(0.0314, 1.4712)).toEqual(['This mod run cost $0.031', 'Session total, mod included $1.47'])
  expect(modLines(0.25, 0.05)).toEqual(['This mod run cost $0.25', 'Session total, mod included $0.050'])
})

test('after 0.8.0 item 6: the forecast mixes in the typical path of the type, and a raised pause point needs more', async () => {
  const todos = [
    { text: 'A', status: 'completed' as const },
    { text: 'B', status: 'completed' as const },
    { text: 'C', status: 'pending' as const },
    { text: 'D', status: 'pending' as const },
  ]
  // Half done for $1.30 at a $2.25 limit. Plain course: 1.30 + 1.30 x 1.15 = $2.80, over 1.2 x 2.25 = $2.70: the early pause.
  const plain = budget({ limit: 2.25, spent: 1.3, todos })
  expect(near(forecast(plain)!.usd, 2.795, 0.001)).toBe(true)
  expect(mustAskEarly(plain, forecast(plain))).toBe(true)
  // A front-loaded type: 75% of the work cost by half done. Course 1.30 / 0.75 = $1.73: no pause.
  const front = budget({ limit: 2.25, spent: 1.3, todos, typePath: { n: 5, q: [0.55, 0.75, 0.9] } })
  expect(near(forecast(front)!.usd, 1.733, 0.001)).toBe(true)
  expect(mustAskEarly(front, forecast(front))).toBe(false)
  // A back-loaded type: 25% by half done. Course 1.30 / 0.25 = $5.20: the path can raise the course too.
  const back = budget({ limit: 2.25, spent: 1.3, todos, typePath: { n: 5, q: [0.1, 0.25, 0.5] } })
  expect(near(forecast(back)!.usd, 5.2, 0.001)).toBe(true)
  // Under 5 runs the weight is part: 1 run gives 0.8 x 2.795 + 0.2 x 1.733.
  const one = budget({ limit: 2.25, spent: 1.3, todos, typePath: { n: 1, q: [0.55, 0.75, 0.9] } })
  expect(near(forecast(one)!.usd, 0.8 * 2.795 + 0.2 * 1.7333, 0.001)).toBe(true)
  // Under 25% done with a typical share under 10% (3% at 12.5% done): no mix, nothing safe to divide by.
  const early = [{ text: 'A', status: 'in_progress' as const }, ...todos.slice(2), { text: 'E', status: 'pending' as const }]
  const tiny = budget({ limit: 2.25, spent: 0.3, todos: early, estimate: ESTIMATE, typePath: { n: 5, q: [0.06, 0.3, 0.7] } })
  const noPath = budget({ limit: 2.25, spent: 0.3, todos: early, estimate: ESTIMATE })
  expect(forecast(tiny)!.usd).toBe(forecast(noPath)!.usd)
  // The pause point after false alarms: 1.2 times the usual needs a course of 1.2 x 1.2 x 5.50 = $7.92.
  const f = { usd: 6.6, basis: 'todos' as const }
  expect(mustAskEarly(budget({ spent: 2.75 }), f)).toBe(true)
  expect(mustAskEarly(budget({ spent: 2.75, ease: 1.2 }), f)).toBe(false)
  expect(mustAskEarly(budget({ spent: 2.75, ease: 1.2 }), { usd: 7.92, basis: 'todos' })).toBe(true)
  // A pause point out of range is not used.
  expect(mustAskEarly(budget({ spent: 2.75, ease: 5 }), f)).toBe(true)
})

test('after 0.8.0 item 6: the cost path keeps at most 24 points, and a step start is kept once', async () => {
  let b = budget()
  for (let i = 1; i <= 40; i++) b = addPoint(b, i / 41, i * 0.1)
  expect(b.path!.length).toBe(PATH_MAX)
  expect(b.path![0]).toEqual([0.02, 0.1])
  // The same share again replaces the last point.
  const c = addPoint(addPoint(budget(), 0.5, 1), 0.5, 1.2)
  expect(c.path).toEqual([[0.5, 1.2]])
  const before = [{ text: 'A', status: 'in_progress' as const }, { text: 'B', status: 'pending' as const }, { text: 'C', status: 'pending' as const }]
  const after = [{ text: 'A', status: 'completed' as const }, { text: 'B', status: 'pending' as const }, { text: 'C', status: 'in_progress' as const }]
  const d = markStepStarts(budget({ spent: 0.7 }), before, after)
  // Step A was already going: no figure. Step C starts now.
  expect(d.stepAt).toEqual([-1, -1, 0.7])
  const e = markStepStarts({ ...d, spent: 0.9 }, after, after)
  expect(e.stepAt).toEqual([-1, -1, 0.7])
  // The finished run carries the path with its end point, the step starts and the start cost.
  const r = runOf({ ...budget({ spent: 1.4 }), path: [[0.5, 0.6]], stepAt: [0.1] }, 'under', '2026-11-17T10:00:00.000Z')
  expect(r.path).toEqual([[0.5, 0.6], [1, 1.4]])
  expect(r.stepAt).toEqual([0.1])
})

// ---------- fix 3 (after 0.8.0): the chat start, measured in every chat ----------

import { startGuess, FRESH_TOKENS as SEED, afterStep as stepOf, freshFrom as startOf, nextBase, nextCalib, partsChanged, partsOf, trackStart, START_REQS } from './core.ts'

/** The parts of a user's chat start as the desktop context panel showed them on 2026-11-17. */
const PANEL = { 'MCP tools': 19_500, 'System tools': 17_300, 'Memory files': 13_100, 'System prompt': 12_500, Skills: 9_900, 'Custom agents': 4_500, 'MCP instructions': 2_000 }

test('fix 3: a folder whose start drops from 180K to 120K uses about 120K in the next chat', async () => {
  const none = { n: 0, idle: 0, step: 0 }
  let base = nextBase(undefined, 180_000, true, PANEL)
  expect(startOf({ '/work': base }, none, '/work', 70_000, 'idle', PANEL)).toEqual({ tokens: 180_000, how: 'folder' })
  // The next chat measured 120K: the newest measure wins. 0.8.0 took half old, half new: 150K.
  base = nextBase(base, 120_000, true, PANEL)
  expect(base.tokens).toBe(120_000)
  expect(startOf({ '/work': base }, none, '/work', 70_000, 'idle', PANEL)).toEqual({ tokens: 120_000, how: 'folder' })
})

test('fix 3: a new install with no chats uses the seed', async () => {
  const none = { n: 0, idle: 0, step: 0 }
  expect(startOf({}, none, '/work', 0, 'idle')).toEqual({ tokens: startGuess(''), how: 'guess' })
  expect(SEED).toBe(183_000)
})

test('fix 3: the first request alone is a floor, so a /budget chat cut short does not drop a good figure', async () => {
  const base = nextBase(undefined, 185_340, true, PANEL)
  // The next chat sent 73K on its first request, and then ended. The figure stays.
  expect(nextBase(base, 73_193, false, PANEL)).toEqual({ n: 2, tokens: 185_340, parts: PANEL })
  // A bigger first request raises it at once.
  expect(nextBase(base, 200_000, false, PANEL).tokens).toBe(200_000)
})

test('fix 3: the parts tell a real change from the small moves of every chat', async () => {
  // Memory files move a little in every chat: no change.
  expect(partsChanged(PANEL, { ...PANEL, 'Memory files': 13_900 })).toBe(false)
  // The connectors were turned off: the MCP tools part fell from 19.5K to 3K.
  expect(partsChanged(PANEL, { ...PANEL, 'MCP tools': 3_000 })).toBe(true)
  // A part came or went.
  const { 'Custom agents': _gone, ...noAgents } = PANEL
  expect(partsChanged(PANEL, noAgents)).toBe(true)
  // No parts on one side: no change seen.
  expect(partsChanged(undefined, PANEL)).toBe(false)
})

test('fix 3: when the parts changed, the old figure of the folder is dropped and the count now is used', async () => {
  const base = { '/work': nextBase(undefined, 185_000, true, PANEL) }
  const calib = nextCalib({ n: 0, idle: 0, step: 0 }, 185_000, 74_000, 74_000)
  expect(near(calib.idle, 2.5, 1e-9)).toBe(true)
  const fewer = { ...PANEL, 'MCP tools': 3_000 }
  // 57,500 counted now x 2.5 = 143,750. The old 185K is not used.
  expect(startOf(base, calib, '/work', 57_500, 'idle', fewer)).toEqual({ tokens: 143_750, how: 'measured' })
  // The next chat saves the new parts, so the chat after it uses the folder figure again.
  const next = nextBase(base['/work'], 120_000, true, fewer)
  expect(startOf({ '/work': next }, calib, '/work', 57_500, 'idle', fewer)).toEqual({ tokens: 120_000, how: 'folder' })
})

test('fix 3: partsOf keeps the start rows and leaves out the chat, free space and buffer', async () => {
  const rows = [
    { name: 'System prompt', tokens: 12_500, kind: 'used' },
    { name: 'MCP tools', tokens: 19_500, kind: 'used' },
    { name: 'MCP tools', tokens: 90_000, kind: 'deferred' },
    { name: 'Messages', tokens: 4_000, kind: 'used' },
    { name: 'Free space', tokens: 800_000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
  ]
  expect(partsOf(rows)).toEqual({ 'System prompt': 12_500, 'MCP tools': 19_500, 'deferred: MCP tools': 90_000 })
})

const R1 = { model: OPUS, input_tokens: 2, cache_read_input_tokens: 73_193, cache_creation_input_tokens: 0, output_tokens: 400 }
const R2 = { model: OPUS, input_tokens: 2, cache_read_input_tokens: 73_193, cache_creation_input_tokens: 112_147, output_tokens: 300 }
const R3 = { model: OPUS, input_tokens: 2, cache_read_input_tokens: 185_340, cache_creation_input_tokens: 1_874, output_tokens: 300 }

test("fix 3: a user's test chat: the start is the first request plus the late 112K write", async () => {
  let t = trackStart(null, R1)
  expect(t).toEqual({ tokens: 73_195, reqs: 1, isJumped: false, isDone: false })
  t = trackStart(t, R2)
  expect(t).toEqual({ tokens: 185_342, reqs: 2, isJumped: true, isDone: true })
  // Settled: later requests do not move it.
  expect(trackStart(t, R2)).toBe(t)
})

test('fix 3: a chat with no late write settles on its first request after 4 requests', async () => {
  let t = trackStart(null, { ...R1, cache_read_input_tokens: 180_000 })
  for (let i = 1; i < START_REQS; i++) t = trackStart(t, R3)
  expect(t).toEqual({ tokens: 180_002, reqs: START_REQS, isJumped: false, isDone: true })
})

test('fix 3: the measured start moves the estimate quietly, and the forecast counts the late write as start', async () => {
  const est = { ...BANDED, likely: 2, low: 1.4, safe: 4, usual: [1.6, 2.6] as [number, number], base: { tokens: 124_282, usd: 0.99 } }
  let b = budget({ estimate: est, steps: 0 })
  // Request 1 sent 73K: below the guess. The first request is a floor, so the estimate does not move down yet.
  b = stepOf(b, R1, undefined, undefined, NOW)
  expect(b.load?.tokens).toBe(73_195)
  expect(b.estimate).toEqual(est)
  // Request 2 wrote 112K more: the start is 185K, 49% over the guess. The estimate moves by the difference.
  b = stepOf(b, R2, undefined, undefined, NOW)
  expect(b.load?.tokens).toBe(185_342)
  expect(b.load?.isSettled).toBe(true)
  const e = b.estimate!
  const real = Math.round(b.load!.usd * 100) / 100
  expect(e.base).toEqual({ tokens: 185_342, usd: real, guess: { tokens: 124_282, usd: 0.99 } })
  // The work part of the estimate stays the same.
  expect(near(e.likely - real, 2 - 0.99, 0.011)).toBe(true)
  // No question: the shift asks nothing.
  expect(b.ask ?? null).toBe(null)
  // A later request does not move it again.
  expect(stepOf(b, R3, undefined, undefined, NOW).estimate).toEqual(e)
})

test('fix 3: a measured start within 10% of the guess leaves the estimate as it is', async () => {
  const est = { ...BANDED, base: { tokens: 180_000, usd: 1.2 } }
  let b = budget({ estimate: est, steps: 0 })
  b = stepOf(b, R1, undefined, undefined, NOW)
  b = stepOf(b, R2, undefined, undefined, NOW)
  expect(b.load?.tokens).toBe(185_342)
  expect(b.estimate).toEqual(est)
})

test('fix 3: the spend is the billed usage, not the start figure', async () => {
  let b = budget({ estimate: { ...BANDED, base: { tokens: 124_282, usd: 0.99 } }, steps: 0 })
  b = stepOf(b, R1, 0.05, undefined, NOW)
  b = stepOf(b, R2, 0.9, undefined, NOW)
  // The engine's bill says $0.90. The spend is $0.90, whatever the start or the estimate says.
  expect(b.spent).toBe(0.9)
})

test('fix 3: a start that settles under the guess moves the estimate down', async () => {
  const est = { ...BANDED, likely: 3, low: 2, safe: 5, usual: [2.4, 3.9] as [number, number], base: { tokens: 180_000, usd: 1.2 } }
  let b = budget({ estimate: est, steps: 0 })
  // A new chat whose first request wrote 120K: no late write follows.
  b = stepOf(b, { ...R1, cache_read_input_tokens: 0, cache_creation_input_tokens: 120_000 }, undefined, undefined, NOW)
  // The first request is a floor: no move down yet.
  expect(b.estimate).toEqual(est)
  for (let i = 1; i < START_REQS; i++) b = stepOf(b, R3, undefined, undefined, NOW)
  expect(b.load?.isSettled).toBe(true)
  expect(b.estimate?.base?.tokens).toBe(120_002)
  expect(b.estimate?.base?.guess).toEqual({ tokens: 180_000, usd: 1.2 })
  expect(b.estimate!.likely).toBeLessThan(3)
  expect(near(b.estimate!.likely - b.estimate!.base!.usd, 3 - 1.2, 0.011)).toBe(true)
})
