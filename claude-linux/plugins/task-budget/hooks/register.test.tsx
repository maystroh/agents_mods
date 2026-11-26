import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Budget, Plan } from '../types'
import { startGuess, AGENT_STOP_DENY, FORK_DENY, SPAWN_STOP_DENY, HANDED_OFF, HELPER_DENY, HELPER_STOP, HELPER_WRAP, STOPPED, aheadOf, defaultLimit, forecast, modLines, planFromTodos, raiseTo, runOf } from './core.ts'
import { curveSvg } from './charts.ts'
import { family } from './book.ts'
import { renderAll } from './memory.ts'
import { bandLine as bandLineOf } from './core.ts'

// Hook tests for Task Budget 0.5.0. Each `on` here sits beneath the mod and stands for the engine.
// Every dollar amount and every sentence in an `expect` was worked out by hand from the price table
// (Opus 5.5: in 4, out 20, cache read 0.2, cache write 8 dollars per million tokens), not copied from a run.

const OPUS = 'claude-opus-5-5'
const HOME = '/tmp/task-budget-test'
const T0 = 1_800_000_000_000

function fileAt(name: string): string {
  return `${HOME}/.claude/mods-logs/${name}`
}

const PANE = {
  plugin: 'task-budget',
  component: 'Pane',
  requestId: 'budget',
  props: { title: 'Budget', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'task-budget',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

/** A budget in the middle of a task: $1.47 of $5.50 spent, a warm chat of 200K tokens, each request about $0.06. */
function running(over: Partial<Budget> = {}): Budget {
  return {
    v: 3,
    id: 'b1',
    limit: 5.5,
    startCost: 0,
    ownSpend: 1.47,
    spent: 1.47,
    isPaused: false,
    isMidTurn: false,
    task: 'research the claude models',
    model: OPUS,
    isFresh: true,
    messages: 2,
    steps: 3,
    lastStep: 0.08,
    ctxTokens: 200_000,
    delta: 0.02,
    mainCost: 1.6,
    msgStart: 1.47,
    bars: [1.47, 0.08],
    helpers: { haiku: { agents: 2, cost: 0.02 } },
    seen: ['a1', 'a2'],
    similar: { cost: 2.1, runs: 1 },
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
    lastModel: OPUS,
    startedAt: T0,
    raised: 0,
    ...over,
  }
}

/** A plan on the running budget: 1.47 spent before it, 1 + 2 for the steps, 1.03 spare. Adds up to 5.50. */
function plan(over: Partial<Plan> = {}): Plan {
  return {
    status: 'approved',
    steps: [
      { name: 'Look at the page', usd: 1, spent: 0, state: 'pending', isWarned: false, check: 'open' },
      { name: 'Build the new page', usd: 2, spent: 0, state: 'pending', isWarned: false, check: 'open' },
    ],
    reserve: 1.03,
    base: 1.47,
    isHeard: true,
    source: 'claude',
    byTool: true,
    ...over,
  }
}

/** A store that stands for the engine's state. Returns a reader for one key. */
function store(on: On, seed: Record<string, unknown> = {}): (key: string) => any {
  const cells = new Map<string, { value: unknown; version: number }>()
  for (const [key, value] of Object.entries(seed)) cells.set(key, { value, version: 1 })
  on('state.get', (_: unknown, e: any) => ({ value: cells.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_: unknown, e: any) => {
    const version = (cells.get(e.key)?.version ?? 0) + 1
    cells.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  return key => cells.get(key)?.value
}

type World = {
  /** What the session has cost so far. A test moves it to stand for spend. */
  usd: number
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  writes: { path: string; text: string }[]
  toasts: string[]
  notices: any[]
  cancels: number
  placed: string[]
  /** Every call of the small model, and what it answers. Null: the model does not answer. */
  asked: any[]
  answer: string | null
  /** What the mod put on the clipboard. */
  copied: string[]
}

/** What the mod wrote with $.ui.log since the last /budget. The model never sees this text. */
let logged: string[] = []

type Opts = { model?: string; tokens?: number | null; breakdown?: number; /** Added for fix 3: the rows of each breakdown call, by its number from 0. */ rows?: (i: number) => object[]; cwd?: string; messages?: unknown[]; files?: Record<string, string>; answer?: string | null; hasExists?: boolean; /** Review fix: no clipboard, and writes to paths it matches fail. */ noCopy?: boolean; failWrite?: RegExp }

/**
 * A session that has spent `usd` so far. `tokens: null` is a chat before its first answer.
 * `breakdown` is the engine's own count of the chat. `files` are the mod's files, by short name.
 */
function engine(on: On, usd: number, opts: Opts = {}): World {
  const w: World = {
    usd,
    clock: mock.clock(on, { now: T0 }),
    files: new Map(Object.entries(opts.files ?? {}).map(([name, text]) => [fileAt(name), text])),
    writes: [],
    toasts: [],
    notices: [],
    cancels: 0,
    placed: [],
    asked: [],
    answer: opts.answer ?? null,
    copied: [],
  }
  logged = []
  on('ui.log', ((_: unknown, e: any) => {
    logged.push(String(e.text))
    return { value: undefined }
  }) as never)
  on('ui.copy', ((_: unknown, e: any) => {
    if (opts.noCopy) return { value: { isCopied: false } }
    w.copied.push(String(e.text))
    return { value: { isCopied: true } }
  }) as never)
  const tokens = opts.tokens === undefined ? 200_000 : opts.tokens
  on('command.register', () => ({ value: { command: 'budget' } }))
  on('tool.register', (() => ({ value: undefined })) as never)
  on('session.cwd', (() => ({ value: opts.cwd ?? '/work' })) as never)
  let bdCalls = 0
  on('session.usage', ((_: unknown, e: any) => ({
    value: {
      context: {
        ...(tokens ? { tokens } : {}),
        window: 1_000_000,
        ...(opts.breakdown ? { breakdown: { totalTokens: opts.breakdown, categories: opts.rows && e?.breakdown ? opts.rows(bdCalls++) : [] } } : {}),
      },
      cost: { usd: w.usd },
    },
  })) as never)
  on('session.model', () => ({ value: opts.model ?? OPUS }))
  on('session.messages', (() => ({ value: opts.messages ?? [] })) as never)
  on('session.id', (() => ({ value: 'sess-1' })) as never)
  on('env.get', () => ({ value: HOME }))
  // An empty text reads like a file that is not there: the mod then starts from nothing.
  on('fs.read', ((_: unknown, e: any) => ({ value: w.files.get(e.path) ?? '' })) as never)
  on('fs.write', ((_: unknown, e: any) => {
    if (opts.failWrite?.test(String(e.path))) throw new Error('disk full')
    w.files.set(e.path, String(e.text))
    w.writes.push({ path: e.path, text: String(e.text) })
    return { value: undefined }
  }) as never)
  on('fs.list', (() => ({ value: [] })) as never)
  // Only the ledger asks if a file is there. Most tests leave this out, so the ledger write is skipped in them.
  if (opts.hasExists) on('fs.exists', ((_: unknown, e: any) => ({ value: w.files.has(e.path) })) as never)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ((_: unknown, e: any) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.place', ((_: unknown, e: any) => {
    w.placed.push(String(e.id))
    return { value: { isPlaced: true } }
  }) as never)
  on('ui.notify', ((_: unknown, e: any) => {
    w.notices.push(e)
    return { value: { isSent: true, channel: 'client' } }
  }) as never)
  on('ui.cancelNotify', (() => {
    w.cancels += 1
    return { value: { isSent: true } }
  }) as never)
  on('model.complete', ((_: unknown, e: any) => {
    w.asked.push(e)
    if (w.answer === null) return { value: { isAnswered: false, reason: 'api-error' } }
    return {
      value: {
        isAnswered: true,
        text: w.answer,
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  }) as never)
  return w
}

/** The calls that count the work of a task. The call that picks the model and effort level (0.7.0) is not one of them. */
function counts(w: World): any[] {
  return w.asked.filter(e => !String(e.prompt).startsWith('You read one task'))
}

/** The calls that pick the model and the effort level. */
function picks(w: World): any[] {
  return w.asked.filter(e => String(e.prompt).startsWith('You read one task'))
}

/** Every prompt that reaches the engine, in order. */
function prompts(on: On): any[] {
  const sent: any[] = []
  on('prompt.submit', (_: unknown, e: any) => {
    sent.push(e)
    return { text: e.text }
  })
  return sent
}

/**
 * The person at the question dialog. Each question takes the next answer.
 * `null` is a person who closes the dialog. Other tools run and say "ran".
 */
function person(on: On, answers: (string | null)[], scan: string | null | undefined = 'Not now'): { questions: any[]; tools: any[]; scans: any[] } {
  const seen = { questions: [] as any[], tools: [] as any[], scans: [] as any[] }
  on('tool.call', ((_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') {
      seen.tools.push(e)
      return { result: 'ran' }
    }
    const q = e.questions[0]
    // The first-run question of 0.7.0. Most tests answer Not now, and do not count it.
    if (String(q.question).startsWith('Read your last')) {
      seen.scans.push(q)
      if (scan === null || scan === undefined) return { deny: 'The user closed the question.' }
      return { result: { questions: e.questions, answers: { [q.question]: scan } } }
    }
    seen.questions.push(q)
    const answer = answers.shift()
    if (answer === null || answer === undefined) return { deny: 'The user closed the question.' }
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  }) as never)
  return seen
}

/** The model on the other side of a request. `cost` is what each answer adds to the session cost. */
function model(on: On, w: World, cost = 0, over: (e: any, n: number) => object = () => ({})): any[] {
  const sent: any[] = []
  on('turn.step', async function* (_: unknown, e: any) {
    sent.push(e)
    w.usd = Math.round((w.usd + cost) * 1e6) / 1e6
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: OPUS, input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 100 },
      ...over(e, sent.length),
    } as never
  } as never)
  return sent
}

type Loose = {
  turn: { step: (e: object) => AsyncIterable<unknown> & { result: Promise<any> } }
  command: { run: (e: object) => Promise<any> }
  prompt: { submit: (e: object) => Promise<any> }
}

/** What the last request streamed: this is what the person sees and what the chat keeps. */
let streamed: any[] = []

/** One request to the model, as the app raises it. Returns what the request got back. */
async function request($: unknown, e: object = {}): Promise<any> {
  streamed = []
  const stream = ($ as Loose).turn.step({ turnId: 't1', index: 0, model: OPUS, effort: 'medium', messageCount: 30, ...e }) as any
  const it = stream[Symbol.asyncIterator]()
  for (;;) {
    const step = await it.next()
    if (step.done) return step.value ?? (await stream.result)
    streamed.push(step.value)
  }
}

/** The effort the app picker shows: the app hands it to the chat as a setting. */
function picker(on: On, level: string): void {
  on('settings.read', (() => ({ value: { effortLevel: level } })) as never)
}

/**
 * The person types /budget and then `args`. Since 0.8.0 the reply goes to the person with $.ui.log, so
 * `text` here is what was logged, and `raw` is what the command handed back to the engine (and so to Claude).
 */
async function cmd($: unknown, args: string): Promise<any> {
  logged = []
  const raw = await ($ as Loose).command.run({ command: 'budget', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  return { ...raw, raw, text: logged.join('\n') }
}

/** A message comes in. `kind` says who sent it. */
function say($: unknown, text: string, kind = 'composer'): Promise<any> {
  return ($ as Loose).prompt.submit({ text, wait: false, origin: kind === 'plugin' ? { kind, name: 'task-budget' } : { kind } })
}

/** Added in 0.8.0. Words and amounts that must never reach Claude: a budget, a limit, a cost, or a dollar amount. */
const BUDGET_WORDS = /\$\s?\d|budget|limit|cost|spend|spent|dollar|cheap|pace|guard/i

function near(a: number, b: number, by = 1e-9): boolean {
  return Math.abs(a - b) <= by
}

// ---------- the start, the gate and the estimate ----------

// What each choice of a budget question does. The mod puts one line for each choice in the question.
const STOP_L = 'Stop: Claude stops at once. Nothing more is sent.'
const LAND_L = 'Finish now: Claude starts no new work and writes its final answer.'
const KEEP_L = 'Keep going: Claude carries on with no limit. The count runs on.'
const KEEP_LIMIT_L = 'Keep $5.50: Claude carries on, and pauses when the budget runs out.'
const CHEAPER_L = 'Finish cheaper: Claude sees the budget and works to it.'

test('/budget 3 in a warm chat starts a budget, and the reply reaches the person only', async ($, on) => {
  engine(on, 1.47)
  const get = store(on)
  const out = await cmd($, '3')
  expect(out?.text).toBe(
    'Budget set: $3.00, counted from now. Claude does not see the limit. When the task is on course to pass it, the chat pauses and asks you. ' +
      'Each request costs about $0.07 here (the chat so far is read again on every request), so about 44 fit. ' +
      'Open the panel with /budget panel.',
  )
  // 0.8.0: the command hands the engine no text and no context, so nothing of it reaches Claude.
  expect(out?.raw?.text).toBeUndefined()
  expect(out?.raw?.context).toBeUndefined()
  expect(get('budget')?.limit).toBe(3)
  expect(get('budget')?.startCost).toBe(1.47)
  expect(get('budget')?.mode).toBe('guard')
})

test('the gate holds a request that would pass the limit, and Stop ends the turn with no work lost', async ($, on) => {
  // $5.45 spent and a request of about $0.06: 5.51 is over the $5.50 limit.
  const w = engine(on, 5.45, { files: { 'task-budget-answers.json': JSON.stringify({ cap1: ['Stop'] }) } })
  const get = store(on, { budget: running({ test: 'cap1' }) })
  const sent = model(on, w)
  const r = await request($)
  expect(r?.answer).toBe(STOPPED)
  // The text is streamed and the turn ends as a normal answer: a result alone is shown to nobody.
  expect(JSON.stringify(streamed)).toBe(
    JSON.stringify([
      { kind: 'text', index: 0, text: STOPPED },
      { kind: 'stop', stopReason: 'end_turn', usage: null },
    ]),
  )
  expect(r?.stopReason).toBe('end_turn')
  expect(sent.length).toBe(0)
  expect(get('budget')?.isPaused).toBe(true)
  expect(w.toasts).toContain('Budget stop: $5.45 of $5.50 spent. To go on, raise the limit above the prompt box.')
  expect(w.placed).toContain('stop-b1-3-2')
  expect(w.notices[0]?.title).toBe('Budget pause')
})

test('the gate asks the person: one line, three buttons, and Raise sends the same request on', async ($, on) => {
  const w = engine(on, 5.45)
  const get = store(on, { budget: running() })
  const sent = model(on, w)
  // Nothing shows the course of the task, so the raise is half the limit again: 5.50 + 2.75 = 8.25.
  const p = person(on, ['Raise the limit to $8.25'])
  const r = await request($)
  expect(p.questions.length).toBe(1)
  expect(p.questions[0]?.question).toBe('$5.45 of $5.50 spent. The next request costs about $0.06. What now?')
  expect(p.questions[0]?.options.map((o: any) => o.label)).toEqual(['Raise the limit to $8.25', 'Hand off to a cheaper model', 'Stop'])
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(get('budget')?.limit).toBe(8.25)
  expect(w.toasts).toContain('Budget raised from $5.50 to $8.25. Spent $5.45, $2.80 left.')
})

test('a person who closes the money question stops the budget', async ($, on) => {
  const w = engine(on, 5.45)
  const get = store(on, { budget: running() })
  const sent = model(on, w)
  const p = person(on, [null])
  const r = await request($)
  expect(p.questions.length).toBe(1)
  expect(sent.length).toBe(0)
  expect(get('budget')?.isPaused).toBe(true)
  expect(r?.answer).toBe(STOPPED)
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

test('/budget and a task: Sonnet medium counts the work, then the person picks the budget', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const p = person(on, ['Start, limit $0.70'])
  const out = await cmd($, 'fix the report in the files')
  expect(out?.text).toBe('Estimating the cost. In about 20 seconds you can start with no limit or with a limit. Nothing starts before you pick.')
  expect(w.asked.length).toBe(0)
  await w.clock.advance(100)
  await w.clock.settle()
  expect(counts(w).length).toBe(1)
  expect(counts(w)[0]?.model).toBe('sonnet')
  expect(counts(w)[0]?.effort).toBe('medium')
  // The advice call runs beside it. Its answer here names no model, so the mod gives no advice.
  expect(picks(w).length).toBe(1)
  // Likely: $0.42 of work. In a warm chat, half of such tasks cost 0.53 to 1.8 times the likely amount: 0.22 to 0.75.
  // 0.8.0: plus the mod's own calls, about $0.04 with no history: $0.46, usually $0.26 to $0.79.
  // One line, then the buttons. The suggested limit is 1.5 x 0.46 = 0.69, rounded up to 0.70.
  expect(p.questions[0]?.question).toBe('Likely $0.46, usually $0.26 to $0.79. Start?')
  expect(p.questions[0]?.options.map((o: any) => o.label)).toEqual(['Start, no limit', 'Start, limit $0.70', 'Not now'])
  // The size check does not refuse the default limit, though it is under the safe amount.
  expect(get('budget')?.limit).toBe(0.7)
  expect(near(get('budget')?.estimate?.cost ?? 0, 0.0054)).toBe(true)
})

test('0.8.0: with history that lands close, the start question offers the learned default limit, and the size check takes it', async ($, on) => {
  // Ten finished tasks that cost what their estimate said. The multiple is (3 x 1.5 + 10 x 1.15) / 13 = 1.23.
  const runs = Array.from({ length: 10 }, (_, i) => ({
    id: `r${i}`, at: '2026-11-01T00:00:00.000Z', limit: 2, spent: 1, messages: 1, outcome: 'under', model: 'sonnet', kind: 'edit',
    first: 1, estimate: { low: 0.8, likely: 1, safe: 2 },
  }))
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER), files: { 'task-budget-history.json': JSON.stringify({ runs }) } })
  const get = store(on)
  // 1.23 x 0.46 = 0.57, rounded up to $0.60. That is under 1.5 x 0.46 = $0.70.
  const p = person(on, ['Start, limit $0.60'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(labelsOf(p.questions[0])).toEqual(['Start, no limit', 'Start, limit $0.60', 'Not now'])
  expect(get('budget')?.estimate?.times).toBe(1.23)
  expect(get('budget')?.estimate?.timesN).toBe(10)
  // The size check does not refuse the learned default limit.
  expect(get('budget')?.limit).toBe(0.6)
  expect(get('budget')?.phase).toBe('run')
})

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

// ---------- what the person sees ----------

const EST = {
  low: 0.37,
  likely: 0.67,
  safe: 1.35,
  kind: 'edit',
  mode: 'guard',
  confidence: 'medium',
  basis: '',
  similar: null,
  unsure: [],
  cost: 0.0054,
  units: { read: 10, edit: 2 },
  helpers: 0,
} as any

const OFFER_CARD = {
  kind: 'estimate',
  task: 'fix the report in the files',
  estimate: EST,
  steps: [
    { name: 'Read the files', usd: 0.52 },
    { name: 'Write the report', usd: 0.15 },
  ],
}

const SURFACES = ['terminal', 'desktop'] as const

function card(id: string) {
  return { plugin: 'task-budget', component: 'Placed', props: { plugin: 'task-budget', id } } as const
}

test('the panel with no budget says so and offers a start, on every surface', async ($, on) => {
  store(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Task Budget$/ }))?.text).toBe('Task Budget')
    expect(await ui.find({ type: 'Button', key: 'start3' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'learn' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the panel shows spend, limit, state and where the money went, on every surface', async ($, on) => {
  store(on, { budget: running() })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^\$1\.47$/ }))?.text).toBe('$1.47')
    expect(await ui.find({ type: 'Text', text: /of \$5\.50/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /On track/ })).toBeTruthy()
    // 1.47 of 5.50 is 26.7%. $4.03 is left.
    expect(await ui.find({ type: 'Text', text: /^\$4\.03$/ })).toBeTruthy()
    // Where the money went is one drawing. A terminal shows its short text form.
    if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /Work \$1\.45 · Haiku helpers \$0\.02/ })).toBeTruthy()
    else expect(await ui.find({ type: 'Text', text: /^Where the money went$/ })).toBeTruthy()
    // Subagent fixes: the panel has the pop-up buttons: Raise the limit, Hand off to a cheaper model, Stop.
    expect(await ui.find({ type: 'Button', key: 'raise' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'handoff' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'stop' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'add5' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'land' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'keep' })).toBeFalsy()
    // 0.7.1: the panel has no button that a person does not need. These three are commands only.
    expect(await ui.find({ type: 'Button', key: 'less1' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'guard' })).toBeFalsy()
    expect(await ui.find({ type: 'Button', key: 'end' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /Requests left/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('a stored value that is not a budget is ignored', async ($, on) => {
  store(on, { budget: { limit: 3, spent: 1, startCost: 0 }, history: 'old text', stops: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Task Budget$/ })).toBeTruthy()
  await ui.unmount()
})

test('a budget that 0.3.0 stored still loads, and runs with no mode', async ($, on) => {
  const { mode: _m, phase: _p, ask: _a, askedAt: _s, waiting: _w, notes: _n, todos: _t, used: _u, lastAt: _l, lastModel: _d, startedAt: _b, estimate: _e, ...rest } = running()
  store(on, { budget: { ...rest, v: 2 } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Budget \$1\.47 \/ \$5\.50/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\$4\.03 left/ })).toBeTruthy()
  // 0.8.0: Pace is gone. A budget that a 0.3.0 chat stored in pace mode runs like any other.
  expect(await ui.find({ type: 'Text', text: /Pace/ })).toBeFalsy()
  await ui.unmount()
})

test('after 0.8.0: on the desktop the band is two lines: a picture bar, then the facts as one text; the money names are text under their bar', async ($, on) => {
  store(on, { budget: running({ estimate: { low: 0.6, likely: 1.17, safe: 6.5 } as NonNullable<Budget['estimate']>, load: { tokens: 73_195, usd: 0.5 }, mainCost: 1.47 }) })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Svg' })).toBeTruthy()
  expect(await band.find({ type: 'Text', text: /^\$4\.03 left · estimate about \$1\.17 · / })).toBeTruthy()
  expect(await band.find({ type: 'Button', key: 'panel' })).toBeTruthy()
  await band.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /^73K tokens at the start$/ })).toBeTruthy()
  // One text line holds every name: it wraps at the panel width, so no name runs into the next one.
  expect(await pane.find({ type: 'Text', text: /^● Chat start \$0\.\d\d +● Work \$0\.\d\d +● Haiku helpers \$0\.\d\d$/ })).toBeTruthy()
  await pane.unmount()
})

test('the band shows the numbers and the panel button, and names no mode', async ($, on) => {
  store(on, { budget: running() })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Budget \$1\.47 \/ \$5\.50/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$4\.03 left/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Guard|Pace/ })).toBeFalsy()
    expect(await ui.find({ type: 'Button', text: 'Open Budget Panel' })).toBeTruthy()
    await ui.unmount()
  }
})

test('the band draws nothing when no budget runs and no estimate waits', async ($, on) => {
  store(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Budget/ })).toBeFalsy()
  await ui.unmount()
})

test('the band keeps what another mod draws there', async ($, on) => {
  store(on, { budget: running() })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other band</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /other band/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', text: 'Open Budget Panel' })).toBeTruthy()
  await ui.unmount()
})

test('the stopped band raises the limit with one press, and Claude carries on', async ($, on) => {
  const w = engine(on, 5.3)
  const get = store(on, { budget: running({ isPaused: true, isMidTurn: true, spent: 5.3, ownSpend: 5.3 }) })
  const sent = prompts(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Budget stop/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\$5\.30 of \$5\.50 spent\. No work is lost\./ })).toBeTruthy()
  // Nothing shows the course of the task, so the raise is half the limit again: 5.50 + 2.75 = 8.25.
  expect((await ui.find({ type: 'Button', key: 'raise' }))?.text).toBe('Raise the limit to $8.25')
  expect((await ui.find({ type: 'Button', key: 'handoff' }))?.text).toBe('Hand off to a cheaper model')
  expect(await ui.find({ type: 'Button', key: 'keep' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'land' })).toBeFalsy()
  await ui.press({ key: 'raise' })
  expect(get('budget')?.limit).toBe(8.25)
  expect(get('budget')?.isPaused).toBe(false)
  expect(w.toasts).toContain('Budget raised from $5.50 to $8.25. Spent $5.30, $2.95 left.')
  expect(sent.length).toBe(0)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['Continue from where you stopped.'])
  await ui.unmount()
})

test('Hand off asks the Handoff mod for its panel when that mod is on, and copies no note', async ($, on) => {
  const w = engine(on, 5.3, { hasExists: true })
  w.files.set(`${HOME}/.claude/mods/handoff/hooks/register.tsx`, 'x')
  w.files.set(`${HOME}/.claude/mods/switches.json`, JSON.stringify({ handoff: true, 'handoff:hidden': true }))
  const get = store(on, { budget: running({ isPaused: true, isMidTurn: true, spent: 5.3, ownSpend: 5.3 }) })
  const sent = prompts(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'handoff' })
  expect(w.copied.length).toBe(0)
  expect(w.files.has(`${HOME}/.claude/handoffs/.request-sess-1`)).toBe(true)
  expect(w.files.has(fileAt('task-budget-handoff.md'))).toBe(true)
  expect(w.toasts).toContain('The Handoff panel opens above the prompt box. Press Start new chat there, then pick Sonnet.')
  expect(get('budget')?.isHandedOff).toBe(true)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.length).toBe(0)
  await ui.unmount()
})

test('Hand off keeps the old note when the Handoff mod is switched off', async ($, on) => {
  const w = engine(on, 5.3, { hasExists: true })
  w.files.set(`${HOME}/.claude/mods/handoff/hooks/register.tsx`, 'x')
  w.files.set(`${HOME}/.claude/mods/switches.json`, JSON.stringify({ handoff: false }))
  store(on, { budget: running({ isPaused: true, isMidTurn: true, spent: 5.3, ownSpend: 5.3 }) })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'handoff' })
  expect(w.copied.length).toBe(1)
  expect(w.files.has(`${HOME}/.claude/handoffs/.request-sess-1`)).toBe(false)
  expect(w.toasts).toContain('Handoff note copied. Open a new chat on Sonnet and paste it.')
  await ui.unmount()
})

test('0.8.0: Hand off in the stopped band copies a note, keeps it in a file, and the chat stays stopped', async ($, on) => {
  const w = engine(on, 5.3)
  const todos = [
    { text: 'Read the page', status: 'completed' as const },
    { text: 'Build the new page', status: 'in_progress' as const },
  ]
  const get = store(on, { budget: running({ isPaused: true, isMidTurn: true, spent: 5.3, ownSpend: 5.3, todos, calls: ['Read: /site/index.html', 'Edit: /site/index.html'] }) })
  const sent = prompts(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'handoff' })
  const note = w.copied[0] ?? ''
  expect(w.copied.length).toBe(1)
  expect(note).toContain('Task: research the claude models')
  expect(note).toContain('- [x] Read the page')
  expect(note).toContain('- [~] Build the new page')
  expect(note).toContain('- Edit: /site/index.html')
  // The note goes to a new chat, so it is text Claude reads. It names no budget, limit or dollar amount.
  expect(note).not.toMatch(BUDGET_WORDS)
  expect(w.files.get(fileAt('task-budget-handoff.md'))).toBe(note + '\n')
  expect(w.toasts).toContain('Handoff note copied. Open a new chat on Sonnet and paste it.')
  expect(w.placed.some(id => id.startsWith('hand-b1-'))).toBe(true)
  expect(get('budget')?.isPaused).toBe(true)
  expect(get('budget')?.isHandedOff).toBe(true)
  // Nothing is sent: the work moves to the new chat.
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.length).toBe(0)
  await ui.unmount()
})

test('/budget keep does the same from the prompt box, and names the estimate', async ($, on) => {
  const w = engine(on, 5.3)
  const get = store(on, { budget: running({ isPaused: true, isMidTurn: true, spent: 5.3, ownSpend: 5.3, estimate: EST }) })
  const sent = prompts(on)
  const out = await cmd($, 'keep')
  expect(out?.text).toBe('No limit now. Claude carries on, and the count runs on. $5.30 spent so far, the estimate was about $0.67.')
  expect(get('budget')?.isOpen).toBe(true)
  expect(get('budget')?.isPaused).toBe(false)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['Continue from where you stopped.'])
})

test('the band says when a question waits, and when Claude finishes', async ($, on) => {
  const cells = new Map<string, unknown>()
  cells.set('budget', running({ waiting: '$5.30 of $5.50 spent' }))
  on('state.get', (_: unknown, e: any) => ({ value: { value: cells.get(e.key), version: 1 } }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Budget pause/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^\$5\.30 of \$5\.50 spent$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Answer the question in the chat\. No work is lost\./ })).toBeTruthy()
  await ui.unmount()
  cells.set('budget', running({ phase: 'landing' }))
  const ui2 = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /Finishing/ })).toBeTruthy()
  expect(await ui2.find({ type: 'Text', text: /\$1\.47 \/ \$5\.50\. Claude writes its last answer\. No new work starts\./ })).toBeTruthy()
  await ui2.unmount()
})

test('the band names the step that runs and where the task is on course for', async ($, on) => {
  // Step 1 has used 0.50 of 1.00 and is active. The rest: 0.50 of step 1 and 2.00 of step 2.
  // 1.97 spent plus 2.50 is 4.47.
  const p = plan()
  const steps = [{ ...p.steps[0]!, state: 'active' as const, spent: 0.5 }, p.steps[1]!]
  store(on, { budget: running({ spent: 1.97, ownSpend: 1.97, plan: { ...p, steps } }) })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Step 1\/2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /on course for \$4\.47/ })).toBeTruthy()
  await ui.unmount()
})

test('an estimate that waits shows in the band, and one press starts the budget at the default limit', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000 })
  const get = store(on, { stops: { offer: OFFER_CARD } })
  const sent = prompts(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Estimate ready/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /about \$0\.67, range \$0\.37 to \$1\.35/ })).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'offer-track' }))?.text).toBe('Start, no limit')
  // 1.5 x 0.67 = 1.005, rounded up to the next 5 cents: 1.05.
  expect((await ui.find({ type: 'Button', key: 'offer-default' }))?.text).toBe('Start, limit $1.05')
  await ui.press({ key: 'offer-default' })
  const b = get('budget')
  expect(b?.limit).toBe(1.05)
  expect(b?.limit).toBe(defaultLimit(EST))
  expect(b?.isTrack).toBeFalsy()
  expect(b?.plan?.steps.length).toBe(2)
  expect(b?.plan?.source).toBe('estimate')
  expect(get('stops')?.offer).toBeUndefined()
  expect(w.toasts.some((t: string) => t.startsWith('Budget set: $1.05, counted from now.'))).toBe(true)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['fix the report in the files'])
  await ui.unmount()
})

test('Start, no limit: the count runs, the estimate stays, and nothing stops the task', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000 })
  const get = store(on, { stops: { offer: OFFER_CARD } })
  const sent = prompts(on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'offer-track' })
  const b = get('budget')
  expect(b?.isTrack).toBe(true)
  expect(b?.isOpen).toBe(true)
  expect(b?.estimate?.likely).toBe(0.67)
  expect(get('stops')?.offer).toBeUndefined()
  expect(w.toasts.some((t: string) => t.startsWith('The count runs from now. No limit is set. The estimate is $0.67.'))).toBe(true)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['fix the report in the files'])
  await ui.unmount()
  // A limit can come later.
  const out = await cmd($, 'set 3')
  expect(out?.text).toBe('Limit set: $3.00. Spent $0.00, $3.00 left.')
  expect(get('budget')?.isTrack).toBe(false)
  expect(get('budget')?.isOpen).toBe(false)
})

test('Dismiss drops the estimate that waits', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { stops: { offer: OFFER_CARD } })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'offer-drop' })
  expect(get('stops')?.offer).toBeUndefined()
  expect(get('budget')).toBeFalsy()
  await ui.unmount()
})

test('the cards in the chat: a stop, an estimate and a report, on every surface', async ($, on) => {
  const run = {
    id: 'b1',
    at: '2027-01-15T08:00:00.000Z',
    task: 'research the claude models',
    limit: 5.5,
    spent: 5.3,
    messages: 2,
    model: 'opus',
    outcome: 'stopped',
    mode: 'guard',
    kind: 'research',
    estimate: { low: 1, likely: 2, safe: 4 },
    steps: [{ name: 'Look at the page', usd: 1, spent: 1.4, check: 'met' }],
  }
  store(on, {
    stops: { s1: { kind: 'stop', spent: 5.3, limit: 5.5 }, e1: OFFER_CARD, r1: { kind: 'report', run } },
  })
  for (const surface of SURFACES) {
    const stop = await $.ui.mount({ ...card('s1'), surface })
    expect(await stop.find({ type: 'Text', text: /Budget stop: \$5\.30 of \$5\.50 spent/ })).toBeTruthy()
    expect(await stop.find({ type: 'Text', text: /No work is lost\./ })).toBeTruthy()
    await stop.unmount()

    const est = await $.ui.mount({ ...card('e1'), surface })
    expect(await est.find({ type: 'Text', text: /Estimate: about \$0\.67/ })).toBeTruthy()
    // 1.5 x 0.67 = 1.005: the suggested limit is $1.05.
    expect(await est.find({ type: 'Text', text: /Suggested limit \$1\.05: 1\.5 times the likely cost\. This is a limit, not the estimate\./ })).toBeTruthy()
    expect(await est.find({ type: 'Text', text: /Range \$0\.37 to \$1\.35 · Small edit · medium confidence/ })).toBeTruthy()
    expect(await est.find({ type: 'Text', text: /1\. Read the files/ })).toBeTruthy()
    expect(await est.find({ type: 'Text', text: /^\$0\.52$/ })).toBeTruthy()
    expect(await est.find({ type: 'Text', text: /Suggested mode/ })).toBeFalsy()
    await est.unmount()

    const rep = await $.ui.mount({ ...card('r1'), surface })
    expect(await rep.find({ type: 'Text', text: /Budget report: \$5\.30 of \$5\.50/ })).toBeTruthy()
    expect(await rep.find({ type: 'Text', text: /^Stopped · Almost out$/ })).toBeTruthy()
    // The run was stopped after two messages: nobody knows what the first task cost, so no cost stands next to the estimate.
    expect(await rep.find({ type: 'Text', text: /The estimate was about \$2\.00 \(range \$1\.00 to \$4\.00\)\./ })).toBeTruthy()
    expect(await rep.find({ type: 'Text', text: /The task cost/ })).toBeFalsy()
    expect(await rep.find({ type: 'Text', text: /\$1\.40 of \$1\.00 · check met/ })).toBeTruthy()
    await rep.unmount()
  }
})

test('the report of a task that ran on with no limit puts the real cost next to the estimate', async ($, on) => {
  // One message that ran to its answer: the spend is the cost of the task. 6.20 over 2.00 is 3.1.
  const run = {
    id: 'b2',
    at: '2027-01-15T08:00:00.000Z',
    task: 'research the claude models',
    limit: 5.5,
    spent: 6.2,
    messages: 1,
    model: 'opus',
    outcome: 'over',
    isOpen: true,
    mode: 'guard',
    kind: 'research',
    estimate: { low: 0.52, likely: 2, safe: 11.5, usual: [1.06, 3.6], hold: 95 },
    steps: [],
  }
  store(on, { stops: { r2: { kind: 'report', run } } })
  for (const surface of SURFACES) {
    const rep = await $.ui.mount({ ...card('r2'), surface })
    expect(await rep.find({ type: 'Text', text: /Budget report: \$6\.20 spent · no limit \(was \$5\.50\)/ })).toBeTruthy()
    expect(await rep.find({ type: 'Text', text: /^Done, no limit · Far over the estimate$/ })).toBeTruthy()
    expect(
      await rep.find({ type: 'Text', text: /The estimate was about \$2\.00 \(usually \$1\.06 to \$3\.60\)\.\s*The task cost \$6\.20: 3\.1 times the\s+estimate\./ }),
    ).toBeTruthy()
    await rep.unmount()
  }
})

// ---------- starting a budget ----------

const GONE_TEXT = 'This was removed in version 0.8.0. Type /budget and then your task.'

const HELP_TEXT =
  'No budget is running. For an estimate and a live count, type /budget and then your task: /budget research our churned members. ' +
  'To add a dollar limit: /budget 3 research our churned members.'

const GUARD_LINE = 'Claude does not see the limit. When the task is on course to pass it, the chat pauses and asks you.'

test('/budget 5 and a task in a new chat: the first request is the dear one, and the task goes out', async ($, on) => {
  // Public copy: no count yet, so the first load is the starter's guess for this model: S tokens.
  // First request: S written to the cache at $8 per million, plus 0.028 of new text.
  // Later requests: S read at $0.20 per million, plus 0.028.
  // What is left of the $5 after the first request, over one later request, plus the first one.
  // With the old fixed guess of 183,000: $1.49, $0.06 and 55 fit.
  const S = startGuess(OPUS)
  const first = S * 8e-6 + 0.028
  const later = S * 0.2e-6 + 0.028
  const fit = Math.floor((5 - first) / later) + 1
  const w = engine(on, 0, { tokens: null })
  const get = store(on)
  const sent = prompts(on)
  const out = await cmd($, '5! recreate our landing page')
  expect(out?.text).toBe(
    `Budget set: $5.00, counted from now. ${GUARD_LINE} ` +
      `The first request costs about $${first.toFixed(2)} (a new chat loads about ${Math.round(S / 1000)}K tokens of tools and skills first, a first guess until one chat is measured). ` +
      `Later requests cost about $${later.toFixed(2)} each, so about ${fit} fit. Your task starts now. Open the panel with /budget panel.`,
  )
  // 0.8.0: nothing of the command reaches Claude.
  expect(out?.raw?.text).toBeUndefined()
  expect(out?.raw?.context).toBeUndefined()
  expect(get('budget')?.pending).toBe('recreate our landing page')
  expect(get('budget')?.firstTokens).toBe(S)
  expect(get('budget')?.isFresh).toBe(true)
  expect(sent.length).toBe(0)
  await w.clock.advance(100)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['recreate our landing page'])
  expect(sent[0]?.context ?? []).toEqual([])
  expect(get('budget')?.pending).toBe('')
  expect(get('budget')?.messages).toBe(1)
})

test('the size check runs beside the task, and a model that does not answer gives a first guess', async ($, on) => {
  // Public copy: no answer and no past chats. The guess is $2, but never under 1.5 times the first request.
  // One request with the start sizes: 1.1 x (S + 1,400) tokens read at $0.20 per million, 2,800 written (0.0224),
  // 1,700 x 960 / 970 out (0.033649). The first load adds S x $7.80 per million. S is the starter's guess for this model.
  // The usual band: from the first request to 1.8 times the likely amount.
  // With the old fixed guess of 183,000: about $2.29, usually $1.52 to $4.11.
  const S = startGuess(OPUS)
  const firstReq = 1.1 * (S + 1400) * 0.2e-6 + 0.0224 + 0.033649 + S * 7.8e-6
  const likely = Math.max(2, firstReq * 1.5)
  const w = engine(on, 0, { tokens: null })
  const get = store(on)
  prompts(on)
  await cmd($, '5! recreate our landing page')
  await w.clock.advance(400)
  await w.clock.settle()
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]?.model).toBe('sonnet')
  expect(w.asked[0]?.effort).toBe('medium')
  expect(w.toasts).toContain(`Estimate for this task: about $${likely.toFixed(2)}, usually $${firstReq.toFixed(2)} to $${(likely * 1.8).toFixed(2)}.`)
  expect(get('budget')?.estimate?.confidence).toBe('low')
  expect(get('budget')?.ask).toBeNull()
})

test('the size check with a real estimate says so, and does not ask when the budget is enough', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  prompts(on)
  const p = person(on, [])
  await cmd($, '5! fix the report in the files')
  await w.clock.advance(400)
  await w.clock.settle()
  expect(w.toasts).toContain('Estimate for this task: about $0.46, usually $0.26 to $0.79.')
  expect(get('budget')?.estimate?.likely).toBe(0.46)
  expect(get('budget')?.ask).toBeNull()
  expect(p.questions.length).toBe(0)
})

test('a budget under the first request is refused with the amount that works', async ($, on) => {
  // The chat counts 200,000 tokens. First request: 1.6 + 0.028 = 1.628. Later: 0.04 + 0.028 = 0.068.
  // The least: (1.628 + 2 x 0.068) x 1.25 = 2.205, shown as 2.25.
  engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const out = await cmd($, '1')
  expect(out?.text).toBe(
    '$1.00 is too small here. The next request costs about $1.63, because a new chat here loads about 200K tokens of tools, skills and memory files first, measured now. ' +
      'Set at least $2.25, for example /budget 2.25. To set it anyway, type /budget 1! and Claude pauses at the first request.',
  )
  expect(get('budget')).toBeFalsy()
})

test('/budget 1! sets it anyway, and the first request waits with a small raise', async ($, on) => {
  const w = engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = model(on, w)
  const p = person(on, ['Raise the limit to $3.00'])
  const out = await cmd($, '1!')
  expect(out?.text).toBe(
    `Budget set: $1.00, counted from now. ${GUARD_LINE} ` +
      'The first request costs about $1.63 (a new chat here loads about 200K tokens of tools, skills and memory files first, measured now). ' +
      'Later requests cost about $0.07 each, so about 0 fit. Open the panel with /budget panel.',
  )
  const r = await request($)
  // The dear request is paid one time: 1.628 + 5 x 0.068 = 1.968, shown as 2.00. The limit goes to 1.00 + 2.00.
  expect(p.questions[0]?.question).toBe('$0.00 of $1.00 spent. The next request costs about $1.63. What now?')
  expect(p.questions[0]?.options.map((o: any) => o.label)).toEqual(['Raise the limit to $3.00', 'Hand off to a cheaper model', 'Stop'])
  expect(get('budget')?.limit).toBe(3)
  expect(w.toasts).toContain('Budget raised from $1.00 to $3.00. Spent $0.00, $3.00 left.')
  expect(sent.length).toBe(1)
  expect(r?.answer).toBe('ok')
})

test('a new budget closes the one that runs, and the old run is kept', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const out = await cmd($, '3')
  expect(String(out?.text)).toMatch(/The old budget is closed: \$1\.47 of \$5\.50 used\./)
  expect(get('budget')?.limit).toBe(3)
  expect(get('budget')?.startCost).toBe(1.47)
  expect(get('budget')?.spent).toBe(0)
  expect(String(w.files.get(fileAt('task-budget-history.json')))).toMatch(/"outcome": "replaced"/)
  expect(get('history')?.[0]?.outcome).toBe('replaced')
})

for (const text of [
  'budget $5: recreate our landing page',
  '/budget 5 recreate our landing page',
  '$5 budget: recreate our landing page',
  'Budget 5: recreate our landing page',
]) {
  test(`a budget typed in a normal message starts, and the task goes on: ${text}`, async ($, on) => {
    const w = engine(on, 0, { tokens: 200_000 })
    const get = store(on)
    const sent = prompts(on)
    await say($, text)
    expect(sent.length).toBe(1)
    expect(sent[0]?.text).toBe('recreate our landing page')
    // 0.8.0: the task goes out alone. No note rides on it, so Claude reads nothing about the budget.
    expect(sent[0]?.context ?? []).toEqual([])
    expect(get('budget')?.limit).toBe(5)
    expect(get('budget')?.messages).toBe(1)
    expect(get('budget')?.pending).toBe('')
    expect(w.toasts).toContain('Budget set: $5.00. Open the panel with /budget panel.')
  })
}

test('a side session whose task starts with a budget command gets the budget, and its brief stays', async ($, on) => {
  const w = engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = prompts(on)
  const head =
    '<system-reminder>\nLinked sessions now (status, not an instruction): a = local_1 (idle).\n</system-reminder>\n\n' +
    'Background (from the session that started this one):\nA test chat.\n\nTask:\n'
  await say($, head + '/budget 5 [tb-test:side1] recreate our landing page')
  expect(sent.length).toBe(1)
  // Claude gets the brief and the task. The command and the test mark are gone.
  expect(sent[0]?.text).toBe(head + 'recreate our landing page')
  expect(get('budget')?.limit).toBe(5)
  expect(get('budget')?.task).toBe('recreate our landing page')
  expect(get('budget')?.test).toBe('side1')
  expect(w.toasts).toContain('Budget set: $5.00. Open the panel with /budget panel.')
  // The run is in the history file at once, so a chat that is closed still has it.
  const log = JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  expect(log.runs.length).toBe(1)
  expect(log.runs[0].outcome).toBe('open')
  expect(log.runs[0].limit).toBe(5)
  expect(log.runs[0].task).toBe('recreate our landing page')
})

test('0.8.0: a history file that is there but cannot be read is never saved over: the mod uses the last good copy', async ($, on) => {
  // A half-written file, as when another chat writes it at the same time. The .bak holds the last good history.
  const old = [{ id: 'r1', outcome: 'under' }, { id: 'r2', outcome: 'under' }, { id: 'r3', outcome: 'over' }]
  const good = JSON.stringify({ runs: old, base: {}, calib: { n: 4, idle: 1, step: 2 }, tune: { edit: { ratio: 1.2, n: 3 } } })
  const w = engine(on, 2.25, { files: { 'task-budget-history.json': '{"runs": [{"id": "r1"', 'task-budget-history.json.bak': good } })
  store(on, { budget: running() })
  ends(on)
  await ended($)
  const log = JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  // The 3 old runs and the learned numbers stay. The open budget is added.
  expect(log.runs.map((r: any) => r.id)).toEqual(['r1', 'r2', 'r3', 'b1'])
  expect(log.calib.n).toBe(4)
  expect(log.tune.edit.n).toBe(3)
  // The .bak copy gets the same new text.
  expect(w.files.get(fileAt('task-budget-history.json.bak'))).toBe(w.files.get(fileAt('task-budget-history.json')))
})

test('0.8.0: with no good copy either, the broken history file is left as it is', async ($, on) => {
  const broken = '{"runs": [{"id": "r1"'
  const w = engine(on, 2.25, { files: { 'task-budget-history.json': broken } })
  store(on, { budget: running() })
  ends(on)
  await ended($)
  expect(w.files.get(fileAt('task-budget-history.json'))).toBe(broken)
  expect(w.writes.some(x => x.path.includes('task-budget-history.json'))).toBe(false)
})

test('0.8.0: a new history file is written with its .bak copy', async ($, on) => {
  const w = engine(on, 2.25)
  store(on, { budget: running() })
  ends(on)
  await ended($)
  const text = w.files.get(fileAt('task-budget-history.json'))
  expect(JSON.parse(String(text)).runs.length).toBe(1)
  expect(w.files.get(fileAt('task-budget-history.json.bak'))).toBe(text)
})

test('the end of a turn keeps the spend of an open budget in the history file', async ($, on) => {
  // The session cost is 2.25 and the budget started at 0, so 2.25 is spent.
  const w = engine(on, 2.25)
  const get = store(on, { budget: running() })
  ends(on)
  await ended($)
  const log = JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  expect(log.runs.length).toBe(1)
  expect(log.runs[0].id).toBe('b1')
  expect(log.runs[0].outcome).toBe('open')
  expect(log.runs[0].spent).toBe(2.25)
  // The budget itself stays open.
  expect(get('budget')?.id).toBe('b1')
})

test('a budget in a message that is too small is not sent, and the person reads why', async ($, on) => {
  engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = prompts(on)
  const r = await say($, 'budget $1: recreate our landing page')
  expect(String(r?.drop)).toMatch(/^\$1\.00 is too small here\./)
  expect(sent.length).toBe(0)
  expect(get('budget')).toBeFalsy()
})

test('a budget in a message with no task sets the budget and sends nothing', async ($, on) => {
  engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = prompts(on)
  const r = await say($, 'budget $5')
  expect(String(r?.drop)).toMatch(/^Budget set: \$5\.00, counted from now\./)
  expect(sent.length).toBe(0)
  expect(get('budget')?.limit).toBe(5)
  expect(get('budget')?.messages).toBe(0)
})

test('a message from a mod is never read as a budget command', async ($, on) => {
  engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = prompts(on)
  await say($, 'budget $5: recreate our landing page', 'plugin')
  expect(sent[0]?.text).toBe('budget $5: recreate our landing page')
  expect(get('budget')).toBeFalsy()
})

test('/budget with nothing to show gives the help text', async ($, on) => {
  engine(on, 1.47)
  store(on)
  expect((await cmd($, ''))?.text).toBe(HELP_TEXT)
  expect((await cmd($, 'status'))?.text).toBe(HELP_TEXT)
  expect((await cmd($, 'hi'))?.text).toBe(HELP_TEXT)
  expect((await cmd($, 'off'))?.text).toBe(HELP_TEXT)
  expect((await cmd($, 'done'))?.text).toBe(HELP_TEXT)
  expect((await cmd($, 'add 2'))?.text).toBe(HELP_TEXT)
  expect((await cmd($, '0'))?.text).toBe('Give a budget above $0, for example /budget 3.')
  expect((await cmd($, 'estimate hi'))?.text).toBe('Put the task after it: /budget estimate research our churned members.')
  expect((await cmd($, 'report'))?.text).toBe('No budget has finished yet.')
  expect((await cmd($, 'prices'))?.text).toBe('No past chats are read yet. Type /budget learn to read them.')
  // 0.8.0: the commands of Pace and of the plan are gone, and say so.
  for (const gone of ['approve', 'guard', 'pace', 'plan 5 redo the page']) expect((await cmd($, gone))?.text).toBe(GONE_TEXT)
})

/** The end of a turn of the main chat. */
async function ended($: unknown, over: Record<string, unknown> = {}): Promise<{ text?: string } | undefined> {
  const end = ($ as any).turn.complete as (input: unknown) => Promise<{ text?: string } | undefined>
  return end({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', ...over })
}

/** One message of a chat, as a compaction gets and gives it. */
const SHORT = { role: 'user', text: 'The chat so far, in short.', toolUses: [] }

/** What sits beneath the mod for the end of a turn, a compaction, the end of a chat and a new helper. */
function ends(on: On): { spawns: any[] } {
  const seen = { spawns: [] as any[] }
  on('turn.complete', ((_: unknown, e: any) => ({ text: e.answer })) as never)
  on('session.compact', (() => ({ messages: [SHORT] })) as never)
  on('session.end', ((_: unknown, e: any) => ({ sessionId: e.sessionId })) as never)
  on('agent.spawn', ((_: unknown, e: any) => {
    seen.spawns.push(e)
    return { model: e.model ?? 'inherit', agentId: 'h-new' }
  }) as never)
  return seen
}

/** A tool call, as the app raises it. With `agentId` a helper makes the call. */
function tool($: unknown, input: Record<string, unknown>): Promise<any> {
  return (($ as any).tool.call as (e: unknown) => Promise<any>)({ tool: 'Read', file_path: '/a', ...input })
}

// ---------- changing the budget ----------

test('/budget add raises the limit and keeps the spend', async ($, on) => {
  engine(on, 0.45)
  const get = store(on, { budget: running({ limit: 0.5, spent: 0.45, ownSpend: 0.45 }) })
  const out = await cmd($, 'add 5')
  expect(out?.text).toBe('Budget raised from $0.50 to $5.50. Spent $0.45, $5.05 left.')
  // Guard mode: Claude is not told about the money.
  expect(out?.context).toBeUndefined()
  expect(get('budget')?.limit).toBe(5.5)
  expect(get('budget')?.raised).toBe(5)
  expect(get('budget')?.notes).toEqual([])
})

test('/budget set lowers the limit, but never under what is spent', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running() })
  expect((await cmd($, 'set 3'))?.text).toBe('Budget lowered from $5.50 to $3.00. Spent $1.47, $1.53 left.')
  expect(get('budget')?.limit).toBe(3)
  expect((await cmd($, 'set 1'))?.text).toBe('The budget cannot go under what is spent: $1.47.')
  expect(get('budget')?.limit).toBe(3)
})

test('with a plan, a change of the limit lands in the buffer', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ plan: plan() }) })
  // 1.03 of buffer plus 0.50 more.
  await cmd($, 'set 6')
  expect(get('budget')?.plan?.reserve).toBe(1.53)
  // Down to 4 takes 2.00 from a buffer of 1.53: not possible.
  expect((await cmd($, 'set 4'))?.text).toBe('Only $1.53 is not given to a step. Lower a step amount first.')
  expect(get('budget')?.limit).toBe(6)
})

test('the panel sets the limit from the input and from the buttons', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'limit', text: '8' })
  expect(get('budget')?.limit).toBe(8)
  expect(w.toasts).toContain('Budget raised from $5.50 to $8.00. Spent $1.47, $6.53 left.')
  // Subagent fixes: one Raise button, with the amount the task needs, as in the pop-up.
  const raise = await ui.find({ type: 'Button', key: 'raise' })
  expect(String(raise?.props?.label)).toMatch(/^Raise the limit to \$\d+\.\d\d$/)
  await ui.press({ key: 'raise' })
  expect(get('budget')?.limit).toBe(Number(String(raise?.props?.label).replace(/^.*\$/, '')))
  await ui.unmount()
})

test('the panel shows the plan, and - and + move one amount and the total with it', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ plan: plan() }) })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /1\. Look at the page/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /2\. Build the new page/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Buffer$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'plus-0' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'minus-r' })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // A budget of 5.50 moves in steps of 0.25.
  await ui.press({ key: 'plus-0' })
  expect(get('budget')?.plan?.steps[0]?.usd).toBe(1.25)
  expect(get('budget')?.limit).toBe(5.75)
  await ui.press({ key: 'minus-r' })
  expect(get('budget')?.plan?.reserve).toBe(0.78)
  expect(get('budget')?.limit).toBe(5.5)
  await ui.unmount()
})

test('the panel shows a plan from the estimate, with no approve button', async ($, on) => {
  const cells = new Map<string, unknown>()
  cells.set('budget', running({ plan: plan({ source: 'estimate', byTool: false }) }))
  on('state.get', (_: unknown, e: any) => ({ value: { value: cells.get(e.key), version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1\. Look at the page/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeFalsy()
  await ui.unmount()
})

// ---------- the gate ----------

test('a request that fits goes out and is counted', async ($, on) => {
  // The answer read 200,000 tokens from the cache (0.04), sent 10 new (0.00004) and wrote 100 out (0.002): 0.04204.
  // New text: 0.002. The average of new text moves 40% of the way: 0.02 x 0.6 + 0.002 x 0.4 = 0.0128.
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const sent = model(on, w, 0.05)
  const p = person(on, [])
  const r = await request($)
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(p.questions.length).toBe(0)
  const b = get('budget')
  expect(near(b?.spent, 1.52)).toBe(true)
  expect(near(b?.bars[0], 1.47)).toBe(true)
  expect(near(b?.bars[1], 0.05)).toBe(true)
  expect(b?.steps).toBe(4)
  expect(b?.ctxTokens).toBe(200_110)
  expect(near(b?.delta, 0.0128)).toBe(true)
  expect(near(b?.lastStep, 0.04204)).toBe(true)
  expect(near(b?.mainCost, 1.64204)).toBe(true)
  expect(b?.lastAt).toBe(T0)
  expect(b?.lastModel).toBe(OPUS)
})

test('with no budget a request passes untouched', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on)
  const sent = model(on, w, 0.05)
  const r = await request($)
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(get('budget')).toBeFalsy()
})

test('the ledger adds one line per request and changes nothing the person or Claude sees', async ($, on) => {
  const w = engine(on, 1.47, { hasExists: true })
  const get = store(on)
  const sent = model(on, w, 0.05)
  const r = await request($)
  // the write runs after the step returned: let it finish
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(get('budget')).toBeFalsy()
  expect(w.toasts.length).toBe(0)
  const text = w.files.get(fileAt('task-budget-ledger.jsonl')) ?? ''
  const lines = text.trim().split('\n')
  expect(lines.length).toBe(1)
  const o = JSON.parse(lines[0]!)
  // 10 in = $0.00004, 200,000 read = $0.04, 100 out = $0.002: $0.04204 in all
  expect(o.total).toBe(0.04204)
  expect(o.model).toBe(OPUS)
  expect(o.effort).toBe('medium')
  // the bill is the engine's own session cost before and after: 1.47 then 1.52
  expect(o.bill).toEqual({ before: 1.47, after: 1.52, delta: 0.05 })
  expect(o.session).toBe('sess-1')
})

// 3% of 5.50 is 0.165, more than two requests (0.12). So the line is 5.335, and a request costs 0.06.
test('just under the kept-back money a request goes out: 5.27 + 0.06 = 5.33', async ($, on) => {
  const w = engine(on, 5.27)
  store(on, { budget: running({ spent: 5.27, ownSpend: 5.27 }) })
  const sent = model(on, w)
  const p = person(on, [null])
  await request($)
  expect(sent.length).toBe(1)
  expect(p.questions.length).toBe(0)
})

test('0.8.0: one cent later the request waits, but only when the task is on course to pass the limit', async ($, on) => {
  // 5.28 + 0.06 = 5.34 is in the money kept back for the last answer. A small model read the chat: on course for $7.
  const w = engine(on, 5.28)
  store(on, { budget: running({ spent: 5.28, ownSpend: 5.28, left: { part: 0.75, at: 5.2, usd: 7 } }) })
  const sent = model(on, w)
  const p = person(on, [null])
  await request($)
  expect(sent.length).toBe(0)
  expect(p.questions.length).toBe(1)
})

test('0.8.0: a task on course to finish under the limit is never stopped by the money kept back', async ($, on) => {
  // The same request, 5.28 + 0.06 = 5.34. The small model says the task is on course for $5.45: under the $5.50 limit.
  const w = engine(on, 5.28)
  store(on, { budget: running({ spent: 5.28, ownSpend: 5.28, left: { part: 0.97, at: 5.2, usd: 5.45 } }) })
  const sent = model(on, w)
  const p = person(on, [null])
  await request($)
  expect(sent.length).toBe(1)
  expect(p.questions.length).toBe(0)
})

test('0.8.0: with nothing that shows the course, the money kept back stops no request', async ($, on) => {
  const w = engine(on, 5.28)
  store(on, { budget: running({ spent: 5.28, ownSpend: 5.28 }) })
  const sent = model(on, w)
  const p = person(on, [null])
  await request($)
  expect(sent.length).toBe(1)
  expect(p.questions.length).toBe(0)
})

test('four rounds of too little money, then the budget stops without a fifth question', async ($, on) => {
  // 0.8.0: no money is kept back when nothing shows the course, so the request must itself pass the limit.
  // $5.49 spent and a request of about $0.06: 5.55. Each answer adds one cent: 5.51, 5.52, 5.53, 5.54. The request still does not fit.
  const w = engine(on, 5.49)
  const get = store(on, { budget: running({ spent: 5.49, ownSpend: 5.49 }) })
  const sent = model(on, w)
  const p = person(on, ['add 0.01', 'add 0.01', 'add 0.01', 'add 0.01', 'add 0.01'])
  const r = await request($)
  expect(p.questions.length).toBe(4)
  expect(sent.length).toBe(0)
  expect(get('budget')?.limit).toBe(5.54)
  expect(get('budget')?.isPaused).toBe(true)
  // 0.8.0: the text in the chat names no amount.
  expect(r?.answer).toBe(STOPPED)
  expect(STOPPED).not.toMatch(BUDGET_WORDS)
})

test('Finish now from the prompt box: one last answer, no new tool calls, and the budget closes with a report', async ($, on) => {
  // 0.8.0: Finish now is not a pause button. It stays as /budget finish and as a panel button.
  const w = engine(on, 5.3)
  const get = store(on, { budget: running({ spent: 5.3, ownSpend: 5.3 }) })
  const sent = model(on, w)
  const p = person(on, [])
  ends(on)
  await cmd($, 'finish')
  expect(get('budget')?.phase).toBe('landing')
  const r = await request($)
  expect(r?.answer).toBe('ok')
  // While it finishes, only the limit itself stops a request: 5.36 is under 5.50.
  expect(sent.length).toBe(1)
  const call = ($ as any).tool.call as (input: unknown) => Promise<unknown>
  const denied = JSON.stringify(await call({ tool: 'Bash', tool_use_id: 'x1', command: 'ls' }))
  expect(denied).toContain('The user chose to finish this task now, so this tool call did not run.')
  expect(denied).not.toMatch(BUDGET_WORDS)
  expect(p.tools.length).toBe(0)
  await ended($)
  expect(get('budget')).toBeFalsy()
  expect(w.toasts).toContain('Budget closed. Spent $5.30 of $5.50.')
  expect(w.placed).toContain('rep-b1')
  expect(get('history')?.[0]?.outcome).toBe('stopped')
})

const finishing = (): Budget => running({ spent: 5.46, ownSpend: 5.46, phase: 'landing' })

test('while Claude finishes, a request that would pass the limit asks with the same three buttons', async ($, on) => {
  // 5.46 + 0.06 is more than 5.50. The mod refuses every tool call while Claude finishes, but its own question must reach the person.
  const w = engine(on, 5.46)
  const get = store(on, { budget: finishing() })
  const sent = model(on, w)
  const p = person(on, [null])
  const r = await request($)
  expect(p.questions.length).toBe(1)
  expect(p.questions[0]?.question).toBe('$5.46 of $5.50 spent. The next request costs about $0.06. What now?')
  expect(labelsOf(p.questions[0])).toEqual(['Raise the limit to $8.25', 'Hand off to a cheaper model', 'Stop'])
  // The person closed the question: nothing is sent.
  expect(sent.length).toBe(0)
  expect(get('budget')?.isPaused).toBe(true)
  expect(r?.answer).toBe(STOPPED)
})

test('while Claude finishes, Keep going takes the limit away and Claude still finishes', async ($, on) => {
  const w = engine(on, 5.46)
  const get = store(on, { budget: finishing() })
  const sent = model(on, w)
  const p = person(on, ['Keep going'])
  const r = await request($)
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(get('budget')?.isOpen).toBe(true)
  expect(get('budget')?.isPaused).toBe(false)
  expect(get('budget')?.phase).toBe('landing')
  expect(w.toasts).toContain('No limit now. Claude carries on, and the count runs on. $5.46 spent so far.')
  // Claude is still finishing: its own tool calls stay refused.
  const denied = JSON.stringify(await tool($, { tool: 'Bash', tool_use_id: 'x1', command: 'ls' }))
  expect(denied).toContain('The user chose to finish this task now, so this tool call did not run.')
  expect(p.tools.length).toBe(0)
})

test('while Claude finishes, Add raises the limit and the request goes out', async ($, on) => {
  const w = engine(on, 5.46)
  const get = store(on, { budget: finishing() })
  const sent = model(on, w)
  person(on, ['Add $2.75'])
  const r = await request($)
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(get('budget')?.limit).toBe(8.25)
  expect(get('budget')?.phase).toBe('landing')
})

test('a budget that is stopped sends no request until the person acts', async ($, on) => {
  const w = engine(on, 5.3)
  store(on, { budget: running({ spent: 5.3, ownSpend: 5.3, isPaused: true, isMidTurn: true }) })
  const sent = model(on, w)
  const p = person(on, ['Raise the limit to $10.00'])
  const r = await request($)
  expect(sent.length).toBe(0)
  expect(p.questions.length).toBe(0)
  expect(r?.answer).toBe(STOPPED)
})

test('0.8.0: a chat that was handed off sends no request, and says the work moved', async ($, on) => {
  const w = engine(on, 5.3)
  store(on, { budget: running({ spent: 5.3, ownSpend: 5.3, isPaused: true, isMidTurn: true, isHandedOff: true }) })
  const sent = model(on, w)
  const r = await request($)
  expect(sent.length).toBe(0)
  expect(r?.answer).toBe(HANDED_OFF)
  expect(HANDED_OFF).not.toMatch(BUDGET_WORDS)
})

test('a new message from the person ends a stop, and the next request asks again', async ($, on) => {
  const w = engine(on, 5.45)
  const get = store(on, { budget: running({ spent: 5.45, ownSpend: 5.45, isPaused: true, isMidTurn: true }) })
  const sent = model(on, w)
  const out = prompts(on)
  const p = person(on, ['Raise the limit to $8.25'])
  await say($, 'go on please')
  expect(get('budget')?.isPaused).toBe(false)
  // 0.8.0: no note rides on the message.
  expect(out[0]?.context ?? []).toEqual([])
  await request($)
  expect(p.questions.length).toBe(1)
  expect(sent.length).toBe(1)
  expect(get('budget')?.limit).toBe(8.25)
})

test('after 0.8.0: a task with its own model is priced on that model, not the picker model, so it does not pause', async ($, on) => {
  // a user's second run: Opus at medium for the task, the picker on Fable at high. $0.96 of $2.25 spent, 185K in the chat.
  // Priced on Fable it looked like a model change: the whole chat written again, about $3.34. Sent on Opus it reads the
  // chat from the cache, about $0.04, and the task is on course under the limit.
  const w = engine(on, 0.96, { tokens: 185_000 })
  const base = { limit: 2.25, spent: 0.96, ownSpend: 0.96, msgStart: 0.96, bars: [0.96], ctxTokens: 185_000, lastModel: OPUS, lastAt: T0, isFresh: false }
  const get = store(on, { budget: running({ ...base, route: { model: 'opus', effort: 'medium' } }) })
  const sent = model(on, w)
  const p = person(on, [])
  await request($, { model: 'claude-fable-5-2', effort: 'high' })
  expect(p.questions.length).toBe(0)
  expect(sent.length).toBe(1)
  expect(family(sent[0].model)).toBe('opus')
  expect(get('budget')?.isPaused).toBe(false)
})

test('after 0.8.0: with no task model, a real change to Fable at 185K still asks first', async ($, on) => {
  const w = engine(on, 0.96, { tokens: 185_000 })
  store(on, { budget: running({ limit: 2.25, spent: 0.96, ownSpend: 0.96, msgStart: 0.96, bars: [0.96], ctxTokens: 185_000, lastModel: OPUS, lastAt: T0, isFresh: false }) })
  model(on, w)
  const p = person(on, ['Stop'])
  await request($, { model: 'claude-fable-5-2', effort: 'high' })
  expect(p.questions.length).toBe(1)
})

test('after 0.8.0 item 6: a second run of a type with a known path does not pause when it is on course under the limit', async ($, on) => {
  // The same numbers as the 50% pause test: $2.95 spent, 1 of 4 steps done. The plain course is $13.13, so that test pauses.
  // This type spends 60% of its work cost by 25% done (5 runs with a path, full weight). Course: 2.95 / 0.6 = $4.92, under $5.50.
  const w = engine(on, 2.9)
  const get = store(on, { budget: running({ spent: 2.9, ownSpend: 2.9, typePath: { n: 5, q: [0.6, 0.8, 0.92] } }) })
  const todos = T4.map(t => ({ content: t.text, status: t.status }))
  const sent = model(on, w, 0.05, () => ({ toolUses: [{ id: 'u1', name: 'TodoWrite', input: { todos } }] }))
  const p = person(on, ['Keep going'])
  await request($)
  await request($)
  expect(p.questions.length).toBe(0)
  expect(get('budget')?.ask).toBeNull()
  expect(sent.length).toBe(2)
  // The cost path keeps the step move: 25% done at $2.95, and the spend when step 1 started.
  expect(get('budget')?.path).toEqual([[0.25, 2.95]])
  expect(get('budget')?.stepAt).toEqual([2.95])
})

test('after 0.8.0 item 6: a new budget takes the typical path and the pause point of its type from the memory', async ($, on) => {
  const lite = { n: 6, max: 3, maxFam: 'opus', over20: 0, subN: 0, subP90: 0, samples: ['write the pre-outline for the next video'], path: { n: 6, q: [0.6, 0.8, 0.92] }, alarms: 2, ease: 1.1 }
  const files: Record<string, string> = {
    'task-budget-answers.json': JSON.stringify({ path1: ['Keep'] }),
    'task-budget-memory/INDEX.md': '# Task Budget memory\n',
    'task-budget-memory/stats.json': JSON.stringify({ video_script: lite, other: { ...lite, path: undefined, alarms: 0, ease: undefined, samples: [] } }),
  }
  const w = engine(on, 0, { model: SONNET, tokens: null, answer: JSON.stringify(THREE_OPUS), files, hasExists: true })
  const get = store(on)
  prompts(on)
  model(on, w, 0.05)
  await say($, '/budget try 30 write the pre-outline and the hooks for the next video [tb-test:path1]')
  await w.clock.advance(400)
  await w.clock.settle()
  expect(get('budget')?.limit).toBe(30)
  expect(get('budget')?.typePath).toEqual({ n: 6, q: [0.6, 0.8, 0.92] })
  expect(get('budget')?.ease).toBe(1.1)
})

test('after 0.8.0 item 6: with only 2 runs with a path the mix is partial, so the same task still pauses', async ($, on) => {
  // Weight 2 / 5 = 0.4: 0.6 x 13.13 + 0.4 x 4.92 = $9.84, over 1.2 x $5.50 = $6.60.
  const w = engine(on, 2.9)
  const get = store(on, { budget: running({ spent: 2.9, ownSpend: 2.9, typePath: { n: 2, q: [0.6, 0.8, 0.92] } }) })
  const todos = T4.map(t => ({ content: t.text, status: t.status }))
  model(on, w, 0.05, (_e, n) => (n === 1 ? { toolUses: [{ id: 'u1', name: 'TodoWrite', input: { todos } }] } : {}))
  const p = person(on, ['Keep going'])
  await request($)
  expect(get('budget')?.ask).toEqual({ kind: 'early' })
  await request($)
  expect(p.questions[0]?.question).toBe('54% spent. On course for $9.84, over your $5.50 limit. What now?')
  // The question keeps its course, so the memory can tell a false alarm later.
  expect(get('budget')?.asks?.at(-1)?.course).toBe(9.84)
})

// ---------- helpers ----------

const SONNET = 'claude-sonnet-5-5'

/** A helper's answer. Sonnet 5.5 pays $10 for a million tokens out, so 170,000 tokens out is $1.70. */
function helperOut(tokens: number): object {
  return { usage: { model: SONNET, input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: tokens } }
}

test('a helper that uses too much is told to finish, then loses its tools, then is stopped', async ($, on) => {
  // With no price book a Sonnet helper may use 0.65 x 2.5 = 1.625. A quarter of the budget is less: 1.375.
  // Three answers cost 1.70, 0.80 and 0.80. That is 1.05, 1.54 and 2.03 times 1.625.
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const sent = model(on, w, 0, (_e, n) => helperOut(n === 1 ? 170_000 : 80_000))
  const p = person(on, [])
  const ask = { agentId: 'h-wrap', model: SONNET }

  // Before it has used anything, the helper works as normal.
  expect((await tool($, { tool_use_id: 'r0', agentId: 'h-wrap' }))?.context).toBeUndefined()

  await request($, ask)
  // 1.05 times: the next tool result carries the note, one time.
  expect((await tool($, { tool_use_id: 'r1', agentId: 'h-wrap' }))?.context).toEqual([HELPER_WRAP])
  // 0.8.0: Claude reads these texts, so none of them names a budget, a limit or an amount.
  for (const t of [HELPER_WRAP, HELPER_DENY, HELPER_STOP]) expect(t).not.toMatch(BUDGET_WORDS)
  expect((await tool($, { tool_use_id: 'r2', agentId: 'h-wrap' }))?.context).toBeUndefined()

  await request($, ask)
  // 1.54 times: its tool calls do not run.
  const refused = JSON.stringify(await tool($, { tool_use_id: 'r3', agentId: 'h-wrap' }))
  expect(refused).toContain(HELPER_DENY)
  expect(p.tools.length).toBe(3)
  // Another helper is not touched.
  expect((await tool($, { tool_use_id: 'r4', agentId: 'h-other' }))?.result).toBe('ran')

  // Under 2 times, its requests still go out.
  await request($, ask)
  expect(sent.length).toBe(3)
  // 2.03 times: the next request does not go out.
  const stopped = await request($, ask)
  expect(sent.length).toBe(3)
  expect(stopped?.answer).toBe(HELPER_STOP)
  expect(p.questions.length).toBe(0)
  // The panel counts the helper one time, with all it cost.
  expect(get('budget')?.helpers?.sonnet?.agents).toBe(1)
  expect(near(get('budget')?.helpers?.sonnet?.cost, 3.3)).toBe(true)
  expect(get('budget')?.seen).toContain('h-wrap')
  // The main chat was not counted as a request.
  expect(get('budget')?.steps).toBe(3)
})

test('while Claude finishes, a helper cannot start new tool calls', async ($, on) => {
  engine(on, 1.47)
  store(on, { budget: running({ phase: 'landing' }) })
  const p = person(on, [])
  const out = JSON.stringify(await tool($, { tool_use_id: 'r1', agentId: 'h-land' }))
  expect(out).toContain('Do not call more tools. Write your report now with what you have, and say what is missing.')
  expect(p.tools.length).toBe(0)
})

test('with no budget, tool calls and helpers are not touched', async ($, on) => {
  const w = engine(on, 1.47)
  store(on)
  const sent = model(on, w, 0, () => helperOut(900_000))
  const p = person(on, [])
  await request($, { agentId: 'h-free', model: SONNET })
  await request($, { agentId: 'h-free', model: SONNET })
  expect(sent.length).toBe(2)
  expect((await tool($, { tool_use_id: 'r1', agentId: 'h-free' }))?.result).toBe('ran')
  expect((await tool($, { tool_use_id: 'r2' }))?.result).toBe('ran')
  expect(p.tools.length).toBe(2)
})

// ---------- the notes for Claude ----------

test('a task given with /budget that did not arrive goes to Claude with the next message', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ pending: 'fix the report in the files' }) })
  const out = prompts(on)
  await say($, 'did you start?')
  const lost = '[The user gave this task in a command, and it did not reach you: "fix the report in the files". This message is about it.]'
  expect(out[0]?.context).toEqual([lost])
  expect(lost).not.toMatch(BUDGET_WORDS)
  expect(get('budget')?.pending).toBe('')
  await say($, 'and now?')
  // 0.8.0: no note on the messages after it.
  expect(out[1]?.context ?? []).toEqual([])
})

test('the task itself, when it arrives, is not named as lost', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ pending: 'fix the report in the files' }) })
  const out = prompts(on)
  await say($, 'fix the report in the files', 'plugin')
  expect(out[0]?.context ?? []).toEqual([])
  expect(get('budget')?.pending).toBe('')
})

test('a note from a background task is not counted as a message, and does not end a stop', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ isPaused: true }) })
  prompts(on)
  await say($, 'a helper finished', 'task-notification')
  expect(get('budget')?.messages).toBe(2)
  expect(get('budget')?.bars).toEqual([1.47, 0.08])
  expect(get('budget')?.isPaused).toBe(true)
})

test('subagent fixes: in a task with a budget, a subagent that asks for Opus runs on Sonnet, and Fable does too', async ($, on) => {
  engine(on, 4)
  const get = store(on, { budget: running({ spent: 4, ownSpend: 4, model: SONNET }) })
  const seen = ends(on)
  await ($ as any).agent.spawn({ prompt: 'look up the prices', model: 'opus', parentModel: SONNET, fork: false })
  await ($ as any).agent.spawn({ prompt: 'look up the prices', model: 'fable', parentModel: OPUS, fork: false })
  await ($ as any).agent.spawn({ prompt: 'read a page', model: 'haiku', parentModel: 'claude-haiku-5-5', fork: false })
  expect(seen.spawns.map(e => e.model)).toEqual(['sonnet', 'sonnet', 'haiku'])
  // The budget keeps the subagent and what it will likely cost.
  expect(get('budget')?.spawns?.[0]?.model).toBe('sonnet')
  expect(get('budget')?.spawns?.[0]?.usd).toBeGreaterThan(0)
})

// ---------- compaction, the end of a chat, the end of a task ----------

test('before a compaction, a request at $4.95 fits: 4.95 + 0.06 = 5.01', async ($, on) => {
  const w = engine(on, 4.95, { tokens: 50_000, breakdown: 50_000 })
  store(on, { budget: running({ spent: 4.95, ownSpend: 4.95 }) })
  const sent = model(on, w)
  const p = person(on, [null])
  await request($)
  expect(sent.length).toBe(1)
  expect(p.questions.length).toBe(0)
})

test('after a compaction the short chat is written to the cache again, so the same request waits', async ($, on) => {
  // 50,000 tokens written at $8 per million is 0.40, plus 0.028 of new text: 0.428. 5.10 + 0.428 = 5.528, over the $5.50 limit.
  // A request with a warm cache costs about $0.06, and 5.16 fits.
  const w = engine(on, 5.1, { tokens: 50_000, breakdown: 50_000 })
  const get = store(on, { budget: running({ spent: 5.1, ownSpend: 5.1 }) })
  const sent = model(on, w)
  const p = person(on, [null])
  ends(on)
  await ($ as any).session.compact({ trigger: 'manual', messages: [SHORT, SHORT] })
  expect(get('budget')?.ctxTokens).toBe(0)
  expect(get('budget')?.lastAt).toBe(0)
  await request($)
  expect(sent.length).toBe(0)
  expect(p.questions.length).toBe(1)
})

test('a compaction that was skipped changes nothing', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ lastAt: T0 - 1000 }) })
  on('session.compact', (() => ({ skip: 'off' })) as never)
  await ($ as any).session.compact({ trigger: 'manual', messages: [SHORT, SHORT] })
  expect(get('budget')?.ctxTokens).toBe(200_000)
  expect(get('budget')?.lastAt).toBe(T0 - 1000)
})

test('a chat that closes with a budget open is kept in the history as abandoned', async ($, on) => {
  const w = engine(on, 2.2)
  const get = store(on, { budget: running() })
  ends(on)
  await ($ as any).session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  const file = String(w.files.get(fileAt('task-budget-history.json')))
  expect(file).toMatch(/"outcome": "abandoned"/)
  // The spend in the file is the session's real number, not the last one the mod saw.
  expect(file).toMatch(/"spent": 2\.2[,\n]/)
  // The budget itself stays, for when the chat is opened again.
  expect(get('budget')?.id).toBe('b1')
})

const DONE_STEPS = [
  { name: 'Look at the page', usd: 1, spent: 0.5, state: 'done' as const, isWarned: false, check: 'open' as const },
  { name: 'Build the new page', usd: 2, spent: 1.2, state: 'done' as const, isWarned: false, check: 'open' as const },
]

test('when every step is marked and Claude answers, the budget closes with a report', async ($, on) => {
  const w = engine(on, 3.17)
  const get = store(on, { budget: running({ spent: 3.17, ownSpend: 3.17, plan: plan({ steps: DONE_STEPS }) }) })
  ends(on)
  const r = await ended($)
  // The answer of Claude is not changed.
  expect(r?.text).toBe('done')
  expect(get('budget')).toBeFalsy()
  expect(w.toasts).toContain('Task done. Spent $3.17 of $5.50.')
  expect(w.placed).toContain('rep-b1')
  expect(get('history')?.[0]?.outcome).toBe('under')
})

test('a task that needed more money than the first budget closes as over', async ($, on) => {
  engine(on, 3.17)
  const get = store(on, { budget: running({ spent: 3.17, ownSpend: 3.17, raised: 2, plan: plan({ steps: DONE_STEPS }) }) })
  ends(on)
  await ended($)
  expect(get('history')?.[0]?.outcome).toBe('over')
})

const STAYS_OPEN: [string, Partial<Budget>, Record<string, unknown>][] = [
  ['the person stopped the turn', { plan: plan({ steps: DONE_STEPS }) }, { reason: 'aborted', isAborted: true }],
  ['a helper ended its turn', { plan: plan({ steps: DONE_STEPS }) }, { agentId: 'h1' }],
  ['a step is still open', { plan: plan() }, {}],
  ['the plan came from the estimate, and Claude marked no step', { plan: plan({ steps: DONE_STEPS, byTool: false, source: 'estimate' }) }, {}],
  ['the budget is stopped', { plan: plan({ steps: DONE_STEPS }), isPaused: true }, {}],
  ['there is no plan', {}, {}],
]
for (const [name, over, end] of STAYS_OPEN) {
  test(`the budget stays open at the end of a turn when ${name}`, async ($, on) => {
    const w = engine(on, 1.47)
    const get = store(on, { budget: running(over) })
    ends(on)
    await ended($, end)
    expect(get('budget')?.id).toBe('b1')
    expect(w.placed).toEqual([])
  })
}

// ---------- the size of a new chat ----------

test('the first request of a new chat is measured and kept for the folder', async ($, on) => {
  // The engine counts 180,000 tokens. The request really sent 10 + 200,000 = 200,010. 200,010 / 180,000 = 1.111167.
  const w = engine(on, 0, { tokens: null, breakdown: 180_000 })
  store(on)
  model(on, w)
  prompts(on)
  await say($, 'hello')
  await request($, { messageCount: 2 })
  // The mod saves this in the background: wait for the file.
  for (let i = 0; i < 50 && !w.files.has(fileAt('task-budget-history.json')); i++) await flush()
  let log = JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  expect(log.base['/work']).toEqual({ n: 1, tokens: 200_010 })
  // Changed after 0.8.0 (fix 3): the ratio is learned when the start is settled, at the 4th request with no late write.
  expect(log.calib.n).toBe(0)
  for (let i = 0; i < 3; i++) await request($, { messageCount: 4 + i })
  for (let i = 0; i < 50 && JSON.parse(String(w.files.get(fileAt('task-budget-history.json')))).calib.n === 0; i++) await flush()
  log = JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  expect(log.base['/work']).toEqual({ n: 1, tokens: 200_010 })
  expect(log.calib.n).toBe(1)
  expect(near(log.calib.step, 1.111167, 1e-5)).toBe(true)
  expect(near(log.calib.idle, 1.111167, 1e-5)).toBe(true)
})

test('after 0.8.0: a /budget chat is measured too, though the estimate calls of the mod cost money first', async ($, on) => {
  const w = engine(on, 0.02, { tokens: null, breakdown: 180_000 })
  store(on)
  model(on, w)
  prompts(on)
  await say($, 'hello')
  await request($, { messageCount: 2 })
  for (let i = 0; i < 50 && !w.files.has(fileAt('task-budget-history.json')); i++) await flush()
  const log = JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  expect(log.base['/work']).toEqual({ n: 1, tokens: 200_010 })
})

test('a chat that was opened again is not measured as a new chat', async ($, on) => {
  const w = engine(on, 0, { tokens: null, breakdown: 180_000 })
  store(on)
  model(on, w)
  await request($, { messageCount: 240 })
  await flush()
  expect(w.files.get(fileAt('task-budget-history.json'))).toBeUndefined()
})

// ---------- fix 3 (after 0.8.0): the start of every chat ----------

const HISTORY = (tokens: number) => JSON.stringify({ runs: [], base: { '/work': { n: 3, tokens } }, calib: { n: 3, idle: 2.5, step: 2.5 }, tune: {} })
const at = (tokens: number) => ({ usage: { model: OPUS, input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 100 } })

test('fix 3: a folder whose start was 180K and is now 120K keeps 120K for the next chat', async ($, on) => {
  const w = engine(on, 0, { tokens: null, breakdown: 70_000, files: { 'task-budget-history.json': HISTORY(180_000) } })
  store(on)
  model(on, w, 0, () => at(120_000))
  prompts(on)
  await say($, 'hello')
  for (let i = 0; i < 4; i++) await request($, { messageCount: 2 + 2 * i })
  const read = () => JSON.parse(String(w.files.get(fileAt('task-budget-history.json'))))
  for (let i = 0; i < 50 && read().base['/work'].tokens !== 120_010; i++) await flush()
  expect(read().base['/work'].tokens).toBe(120_010)
})

test('fix 3: a /budget chat whose start comes late moves the estimate with no question, toast or note', async ($, on) => {
  const w = engine(on, 0.2, { tokens: null, breakdown: 74_000 })
  const est = { ...EST, low: 1.4, likely: 2, safe: 4, base: { tokens: 124_282, usd: 0.99 } } as NonNullable<Budget['estimate']>
  const get = store(on, { budget: running({ steps: 0, spent: 0.2, ownSpend: 0.2, msgStart: 0.2, bars: [0.2], ctxTokens: 0, estimate: est, limit: 10 }) })
  const r1 = { model: OPUS, input_tokens: 2, cache_read_input_tokens: 73_193, cache_creation_input_tokens: 0, output_tokens: 400 }
  const r2 = { ...r1, cache_creation_input_tokens: 112_147, output_tokens: 300 }
  const asked = person(on, [])
  model(on, w, 0.05, (_, n) => ({ usage: n === 1 ? r1 : r2 }))
  await request($, { messageCount: 2 })
  await request($, { messageCount: 4 })
  const e = get('budget')?.estimate
  expect(e?.base?.tokens).toBe(185_342)
  expect(e?.base?.guess).toEqual({ tokens: 124_282, usd: 0.99 })
  expect(get('budget')?.load?.tokens).toBe(185_342)
  expect(asked.questions).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.notices).toEqual([])
})

test('fix 3: the folder keeps the parts from before the chat, not the bigger count at the first request', async ($, on) => {
  const idle = [
    { name: 'System prompt', tokens: 12_500, kind: 'used' },
    { name: 'MCP tools', tokens: 19_500, kind: 'used' },
  ]
  // At the first request more rows are in. Compared with the stored parts of before the chat, they would look like a change.
  const later = [...idle, { name: 'Skills', tokens: 9_900, kind: 'used' }]
  const w = engine(on, 0, { tokens: null, breakdown: 70_000, rows: i => (i === 0 ? idle : later) })
  store(on)
  model(on, w, 0, () => at(120_000))
  prompts(on)
  await say($, 'hello')
  for (let i = 0; i < 4; i++) await request($, { messageCount: 2 + 2 * i })
  const read = () => JSON.parse(String(w.files.get(fileAt('task-budget-history.json')) ?? '{"calib":{"n":0}}'))
  for (let i = 0; i < 50 && read().calib.n === 0; i++) await flush()
  expect(read().base['/work'].parts).toEqual({ 'System prompt': 12_500, 'MCP tools': 19_500 })
})

test('fix 3: an estimate moved up past the limit by the measured start asks nothing', async ($, on) => {
  const w = engine(on, 0.2, { tokens: null, breakdown: 74_000 })
  // The guess priced the start at $0.30. The real start costs more, so the estimate moves up past the $2.30 limit.
  const est = { ...EST, low: 1.4, likely: 2, safe: 4, base: { tokens: 124_282, usd: 0.3 } } as NonNullable<Budget['estimate']>
  const get = store(on, { budget: running({ steps: 0, spent: 0.2, ownSpend: 0.2, msgStart: 0.2, bars: [0.2], ctxTokens: 0, estimate: est, limit: 2.3 }) })
  const r1 = { model: OPUS, input_tokens: 2, cache_read_input_tokens: 73_193, cache_creation_input_tokens: 0, output_tokens: 400 }
  const r2 = { ...r1, cache_creation_input_tokens: 112_147, output_tokens: 300 }
  const asked = person(on, [])
  model(on, w, 0.05, (_, n) => ({ usage: n === 1 ? r1 : r2 }))
  await request($, { messageCount: 2 })
  await request($, { messageCount: 4 })
  const e = get('budget')?.estimate
  expect(e?.likely).toBeGreaterThan(2.3)
  expect(get('budget')?.limit).toBe(2.3)
  expect(get('budget')?.ask ?? null).toBe(null)
  expect(asked.questions).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.notices).toEqual([])
})

// ---------- the questions that are not about money ----------

const labelsOf = (q: any): string[] => (q?.options ?? []).map((o: any) => o.label)

/** Four to-dos, one done. At $2.00 spent, the whole task is on course for 2.00 / 0.25 = $8.00. */
const T4 = [
  { text: 'Read the page', status: 'completed' as const },
  { text: 'Plan the sections', status: 'pending' as const },
  { text: 'Write the page', status: 'pending' as const },
  { text: 'Check the page', status: 'pending' as const },
]
// 0.8.0: past half of the limit, and on course for more than 1.2 times it. The 50% pause is due.
const onCourse = (): Budget => running({ spent: 3, ownSpend: 3, ask: { kind: 'early' }, todos: T4 })

test('0.8.0: the 50% pause: one line, four buttons, and Keep going keeps the limit', async ($, on) => {
  // $3.00 of $5.50 is 55%. 1 of 4 to-dos is done: the work left is 3.00 / 0.25 x 0.75 = 9.00.
  // 0.8.0: with 15% on top, 3.00 + 10.35 = 13.35, more than 1.2 x 5.50 = 6.60.
  const w = engine(on, 3)
  const get = store(on, { budget: onCourse() })
  const sent = model(on, w)
  const p = person(on, ['Keep going'])
  await request($)
  expect(p.questions[0]?.question).toBe('55% spent. On course for $13.35, over your $5.50 limit. What now?')
  expect(labelsOf(p.questions[0])).toEqual(['Keep going', 'Raise the limit to $14.00', 'Hand off to a cheaper model', 'Stop'])
  expect(p.questions[0]?.question).not.toMatch(/\n/)
  expect(sent.length).toBe(1)
  expect(get('budget')?.limit).toBe(5.5)
  expect(get('budget')?.ask).toBeNull()
  expect(get('budget')?.isEarlyAsked).toBe(true)
  expect(get('budget')?.isOpen).toBeFalsy()
})

test('0.8.0: the 50% pause comes one time in a task', async ($, on) => {
  const w = engine(on, 3)
  const get = store(on, { budget: onCourse() })
  const sent = model(on, w)
  const p = person(on, ['Keep going', 'Keep going'])
  await request($)
  await request($)
  await request($)
  expect(p.questions.length).toBe(1)
  expect(sent.length).toBe(3)
  expect(get('budget')?.ask).toBeNull()
})

test('0.8.0: Hand off at the 50% pause copies the note and stops the chat', async ($, on) => {
  const w = engine(on, 3)
  const get = store(on, { budget: onCourse() })
  const sent = model(on, w)
  person(on, ['Hand off to a cheaper model'])
  const r = await request($)
  expect(sent.length).toBe(0)
  expect(w.copied.length).toBe(1)
  expect(w.copied[0]).not.toMatch(BUDGET_WORDS)
  expect(w.toasts).toContain('Handoff note copied. Open a new chat on Sonnet and paste it.')
  expect(get('budget')?.isHandedOff).toBe(true)
  expect(get('budget')?.isPaused).toBe(true)
  expect(r?.answer).toBe(HANDED_OFF)
})

test('0.8.0: no 50% pause when the task is on course to finish under 1.2 times the limit', async ($, on) => {
  // 3 of 4 to-dos are done at $4.00: 4.00 / 0.75 = 5.33, under 6.60. No question, and the request goes out.
  const w = engine(on, 4)
  const todos = T4.map((t, i) => (i < 3 ? { ...t, status: 'completed' as const } : t))
  store(on, { budget: running({ spent: 4, ownSpend: 4, todos }) })
  const sent = model(on, w)
  const p = person(on, [null])
  await request($)
  expect(p.questions.length).toBe(0)
  expect(sent.length).toBe(1)
})

const RAISES: [string, number, string][] = [
  ['Raise the limit to $9.25', 9.25, 'Budget raised from $5.50 to $9.25. Spent $3.00, $6.25 left.'],
  // Typed under Other. A bare number above the limit is the new limit. Under it, it is what to add.
  ['12', 12, 'Budget raised from $5.50 to $12.00. Spent $3.00, $9.00 left.'],
  ['$7', 7, 'Budget raised from $5.50 to $7.00. Spent $3.00, $4.00 left.'],
  ['3', 8.5, 'Budget raised from $5.50 to $8.50. Spent $3.00, $5.50 left.'],
  ['add 2', 7.5, 'Budget raised from $5.50 to $7.50. Spent $3.00, $4.50 left.'],
]
for (const [answer, limit, toast] of RAISES) {
  test(`the answer "${answer}" to the 50% pause sets the limit to $${limit}`, async ($, on) => {
    const w = engine(on, 3)
    const get = store(on, { budget: onCourse() })
    const sent = model(on, w)
    person(on, [answer])
    await request($)
    expect(get('budget')?.limit).toBe(limit)
    expect(w.toasts).toContain(toast)
    // $7.00 is still under the course of $13.35. The person chose it, so the 50% pause does not come back.
    expect(get('budget')?.ask).toBeNull()
    expect(get('budget')?.isEarlyAsked).toBe(true)
    expect(sent.length).toBe(1)
  })
}

test('a 50% pause that the person closes stops the work, like the other pauses', async ($, on) => {
  const w = engine(on, 3)
  const get = store(on, { budget: onCourse() })
  const sent = model(on, w)
  const p = person(on, [null])
  const r = await request($)
  expect(p.questions.length).toBe(1)
  expect(r?.answer).toBe(STOPPED)
  expect(sent.length).toBe(0)
  expect(get('budget')?.isPaused).toBe(true)
  expect(get('budget')?.isEarlyAsked).toBe(true)
})

test('Stop on the 50% pause stops the budget, with a card in the chat', async ($, on) => {
  const w = engine(on, 3)
  const get = store(on, { budget: onCourse() })
  const sent = model(on, w)
  person(on, ['Stop'])
  const r = await request($)
  expect(sent.length).toBe(0)
  expect(r?.answer).toBe(STOPPED)
  expect(get('budget')?.isPaused).toBe(true)
  expect(w.toasts).toContain('Budget stop: $3.00 of $5.50 spent. To go on, raise the limit above the prompt box.')
  expect(w.placed).toEqual(['stop-b1-3-2'])
})

test('a forecast question that is not true any more is dropped', async ($, on) => {
  // Every to-do is done: the task is on course for what is spent.
  const w = engine(on, 2)
  const get = store(on, { budget: running({ spent: 3, ownSpend: 3, ask: { kind: 'early' }, todos: T4.map(t => ({ ...t, status: 'completed' as const })) }) })
  const sent = model(on, w)
  const p = person(on, ['Stop here'])
  await request($)
  expect(p.questions.length).toBe(0)
  expect(sent.length).toBe(1)
  expect(get('budget')?.ask).toBeNull()
})

test('a to-do list that shows the task will pass the limit sets the 50% pause for the next request', async ($, on) => {
  // $2.90 spent, and the first request costs 0.05: 2.95, past half of $5.50.
  // 1 of 4 to-dos is done: 2.95 + 8.85 x 1.15 = 13.13, more than 1.2 x 5.50 = 6.60.
  const w = engine(on, 2.9)
  const get = store(on, { budget: running({ spent: 2.9, ownSpend: 2.9 }) })
  const todos = T4.map(t => ({ content: t.text, status: t.status }))
  const sent = model(on, w, 0.05, (_e, n) => (n === 1 ? { toolUses: [{ id: 'u1', name: 'TodoWrite', input: { todos } }] } : {}))
  const p = person(on, ['Keep going'])
  await request($)
  expect(p.questions.length).toBe(0)
  expect(get('budget')?.todos).toEqual(T4)
  expect(get('budget')?.ask).toEqual({ kind: 'early' })
  await request($)
  expect(p.questions[0]?.question).toBe('54% spent. On course for $13.13, over your $5.50 limit. What now?')
  expect(labelsOf(p.questions[0])[0]).toBe('Keep going')
  expect(sent.length).toBe(2)
})

test('a to-do list with too little done says nothing yet', async ($, on) => {
  // 1 of 8 is done: under a quarter, so there is no course to name.
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const todos = [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ content: `Part ${n}`, status: n === 1 ? 'completed' : 'pending' }))
  model(on, w, 0.05, () => ({ toolUses: [{ id: 'u1', name: 'TodoWrite', input: { todos } }] }))
  person(on, [])
  await request($)
  expect(get('budget')?.todos.length).toBe(8)
  expect(get('budget')?.ask).toBeNull()
})

const ACTIVE = [
  { name: 'Look at the page', usd: 1, spent: 0.9, state: 'active' as const, isWarned: false, check: 'open' as const },
  { name: 'Build the new page', usd: 2, spent: 0, state: 'pending' as const, isWarned: false, check: 'open' as const },
]

const underEstimate = (): Budget => running({ estimate: { ...EST, low: 6, likely: 8, safe: 12 } as Budget['estimate'], ask: { kind: 'small' } })

test('a limit under the estimate: Claude waits, and Raise sets the default limit', async ($, on) => {
  // Likely $8.00: the default limit is 1.5 x 8.00 = $12.00.
  const w = engine(on, 1.47)
  const get = store(on, { budget: underEstimate() })
  const sent = model(on, w)
  const p = person(on, ['Raise the limit to $12.00'])
  await request($)
  expect(p.questions[0]?.question).toBe('Likely $8.00, over your $5.50 limit. What now?')
  expect(labelsOf(p.questions[0])).toEqual(['Raise the limit to $12.00', 'Keep $5.50', 'Stop'])
  expect(get('budget')?.limit).toBe(12)
  expect(w.toasts).toContain('Budget raised from $5.50 to $12.00. Spent $1.47, $10.53 left.')
  expect(sent.length).toBe(1)
})

test('a budget under the estimate: Keep carries on with the same budget, and is not asked again', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: underEstimate() })
  const sent = model(on, w)
  const p = person(on, ['Keep $5.50'])
  await request($)
  await request($)
  expect(p.questions.length).toBe(1)
  expect(sent.length).toBe(2)
  expect(get('budget')?.limit).toBe(5.5)
  expect(get('budget')?.ask).toBeNull()
})

test('the money question raises to the course of the whole task when a to-do list shows it', async ($, on) => {
  // 0.8.0: 5.30 + 15.90 x 1.15 = 23.59. With the money kept back for the end, rounded up: $24.50.
  const w = engine(on, 5.3)
  const get = store(on, { budget: running({ spent: 5.3, ownSpend: 5.3, todos: T4 }) })
  const sent = model(on, w)
  const p = person(on, ['Raise the limit to $24.50'])
  await request($)
  expect(p.questions[0]?.question).toBe('$5.30 of $5.50 spent. The next request costs about $0.06. What now?')
  expect(labelsOf(p.questions[0])).toEqual(['Raise the limit to $24.50', 'Hand off to a cheaper model', 'Stop'])
  expect(get("budget")?.limit).toBe(24.5)
  expect(sent.length).toBe(1)
})

test('"Keep going" typed when the money is out takes the limit away, and the count runs on', async ($, on) => {
  // 0.8.0: the money pause has no Keep going button. The words typed under Other still work.
  // $5.45 spent and a request of about $0.06: 5.51 is over the $5.50 limit.
  const w = engine(on, 5.45)
  const get = store(on, { budget: running({ spent: 5.45, ownSpend: 5.45 }) })
  // Each answer adds $0.50 to the cost of the chat.
  const sent = model(on, w, 0.5)
  const p = person(on, ['Keep going'])
  const r = await request($)
  expect(r?.answer).toBe('ok')
  expect(sent.length).toBe(1)
  expect(get('budget')?.isOpen).toBe(true)
  expect(get('budget')?.isPaused).toBe(false)
  expect(get('budget')?.limit).toBe(5.5)
  expect(w.toasts).toContain('No limit now. Claude carries on, and the count runs on. $5.45 spent so far.')
  // The next requests go out with no question, and the spend passes the old limit: 5.45 + 3 x 0.50 = 6.95.
  await request($)
  await request($)
  expect(sent.length).toBe(3)
  expect(p.questions.length).toBe(1)
  expect(near(get('budget')?.spent ?? 0, 6.95)).toBe(true)
})

test('with an estimate, "Keep going" says that the real cost will show next to it', async ($, on) => {
  const w = engine(on, 5.45)
  const banded = { ...EST, low: 0.52, likely: 2, safe: 11.5, usual: [1.06, 3.6], hold: 95 } as Budget['estimate']
  store(on, { budget: running({ spent: 5.45, ownSpend: 5.45, estimate: banded }) })
  model(on, w)
  const p = person(on, ['Keep going'])
  await request($)
  expect(p.questions.length).toBe(1)
  expect(w.toasts).toContain('No limit now. Claude carries on, and the count runs on. $5.45 spent so far, the estimate was about $2.00.')
})

test('a task that ran on with no limit closes at its answer, and the report says so', async ($, on) => {
  const w = engine(on, 6.8)
  ends(on)
  const get = store(on, { budget: running({ spent: 6.8, ownSpend: 6.8, isOpen: true }) })
  await ended($)
  expect(get('budget')).toBeFalsy()
  expect(w.toasts).toContain('Task done. Spent $6.80. The budget was $5.50, then you chose Keep going.')
  expect(w.placed).toContain('rep-b1')
  expect(get('history')?.[0]?.outcome).toBe('over')
  expect(get('history')?.[0]?.isOpen).toBe(true)
})

test('the first answer of a task keeps what the task cost, and says it next to the estimate one time', async ($, on) => {
  const w = engine(on, 0.9)
  ends(on)
  // A budget with no task of its own (the person set an amount and then chats): it stays open.
  const get = store(on, { budget: running({ task: '', spent: 0.9, ownSpend: 0.9, msgStart: 0, messages: 1, estimate: EST }) })
  await ended($)
  expect(get('budget')?.firstCost).toBe(0.9)
  expect(w.toasts).toContain('Task done: $0.90. The estimate was about $0.67.')
  // A later answer in the same budget is not the first task: the kept cost stays.
  w.usd = 1.4
  await ended($)
  expect(get('budget')?.firstCost).toBe(0.9)
  expect(w.toasts.filter((t: string) => t.startsWith('Task done:')).length).toBe(1)
})

// ---------- the estimate, and the pick of a budget ----------

test('Not now puts the estimate away and starts nothing', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const p = person(on, ['Not now'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.questions.length).toBe(1)
  expect(get('budget')).toBeFalsy()
  expect(get('stops')?.offer).toBeUndefined()
  // The estimate card stays in the chat.
  expect(w.placed.length).toBe(1)
  expect(w.placed[0]).toMatch(/^est-/)
})

test('a pick question that the person closes leaves the Start buttons above the prompt box', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  person(on, [null])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(get('budget')).toBeFalsy()
  expect(get('stops')?.offer?.kind).toBe('estimate')
  expect(get('stops')?.offer?.estimate?.safe).toBe(2.75)
})

test('an amount typed as the answer starts the budget at that amount', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const out = prompts(on)
  person(on, ['2'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  await w.clock.advance(100)
  await w.clock.settle()
  expect(get('budget')?.limit).toBe(2)
  expect(get('budget')?.task).toBe('fix the report in the files')
  expect(get('budget')?.estimate?.likely).toBe(0.46)
  expect(get('stops')?.offer).toBeUndefined()
  // The task goes to Claude one time.
  expect(out.map(e => e.text)).toEqual(['fix the report in the files'])
})

test('when the estimate call does not answer, the person still gets a first guess to pick from', async ($, on) => {
  // No answer and no past chats: the guess is $2.00. A first guess of the range: 2 x 0.53 = 1.06 to 2 x 1.8 = 3.60.
  // 0.8.0: the default limit is 1.5 x 2.00 = $3.00.
  const w = engine(on, 1.47, { tokens: 100_000 })
  store(on)
  const p = person(on, ['Not now'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.questions[0]?.question).toBe('Likely $2.00, usually $1.06 to $3.60. Start?')
  expect(labelsOf(p.questions[0])).toEqual(['Start, no limit', 'Start, limit $3.00', 'Not now'])
})

test('/budget estimate shows the estimate in the chat and asks nothing', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const p = person(on, ['Start, limit $2.50'])
  const out = await cmd($, 'estimate fix the report in the files')
  expect(out?.text).toBe('Estimating the cost. The estimate shows in the chat in about 20 seconds. Nothing starts.')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(w.asked.length).toBe(1)
  expect(p.questions.length).toBe(0)
  expect(w.placed.length).toBe(1)
  expect(w.placed[0]).toMatch(/^est-/)
  expect(get('stops')?.offer).toBeUndefined()
  expect(get('budget')).toBeFalsy()
  expect((await cmd($, 'estimate hi'))?.text).toBe('Put the task after it: /budget estimate research our churned members.')
})

test('a limit under the estimate: the size check says so, and the next request asks', async ($, on) => {
  // A warm chat of 100,000 tokens: a request costs 0.048, so $0.20 can start.
  // Half of such tasks cost $0.26 to $0.79, so 3 of 4 cost more than $0.20: the limit is clearly too small.
  // The raise goes to the default limit: 1.5 x 0.46 = 0.69, rounded up to $0.70.
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  prompts(on)
  const sent = model(on, w)
  const p = person(on, ['Raise the limit to $0.70'])
  await cmd($, '0.2! fix the report in the files')
  await w.clock.advance(400)
  await w.clock.settle()
  expect(w.toasts).toContain('Estimate for this task: about $0.46, usually $0.26 to $0.79. That is more than your limit, so Claude pauses and asks you.')
  expect(get('budget')?.ask).toEqual({ kind: 'small' })
  await request($)
  expect(p.questions[0]?.question).toBe('Likely $0.46, over your $0.20 limit. What now?')
  expect(labelsOf(p.questions[0])).toEqual(['Raise the limit to $0.70', 'Keep $0.20', 'Stop'])
  expect(get('budget')?.limit).toBe(0.7)
  expect(w.toasts).toContain('Budget raised from $0.20 to $0.70. Spent $0.00, $0.70 left.')
  expect(sent.length).toBe(1)
})

test('a test tag on the task answers the questions from a file, with no dialog', async ($, on) => {
  const w = engine(on, 1.47, {
    tokens: 100_000,
    answer: JSON.stringify(ANSWER),
    files: { 'task-budget-answers.json': JSON.stringify({ small1: ['Keep $0.20'] }) },
  })
  const get = store(on)
  const out = prompts(on)
  const sent = model(on, w)
  const p = person(on, ['Stop here'])
  await cmd($, '0.2! fix the report in the files [tb-test:small1]')
  await w.clock.advance(400)
  await w.clock.settle()
  // The tag does not reach Claude or the task text.
  expect(get('budget')?.task).toBe('fix the report in the files')
  expect(out.map(e => e.text)).toEqual(['fix the report in the files'])
  expect(get('budget')?.ask).toEqual({ kind: 'small' })
  await request($)
  expect(p.questions.length).toBe(0)
  expect(sent.length).toBe(1)
  expect(get('budget')?.limit).toBe(0.2)
  expect(get('budget')?.ask).toBeNull()
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-answers.json'))))).toEqual({ small1: [] })
})

// ---------- the commands ----------

const PACE_START =
  'The user set a budget of $5.50 for this task, counted from now, and asked you to pace the work to it. Code stops a request that would pass it. ' +
  'Real costs in this chat: every request to you (each reply, and each round of tool calls) costs about $0.06, so about 67 requests fit. ' +
  'Similar past tasks cost about $2.10 (1 run). ' +
  'How to spend well: put tool calls that do not depend on each other in one message. Read only what the task needs. ' +
  'For bulk lookups and sorting, where a mistake is easy to see, use helpers on model haiku or sonnet. Keep judgment and final edits in the main chat. ' +
  'Do the most useful part first. Do not lower the quality of what you deliver: if the work cannot fit, say what is left.'

const GUARD_START =
  'A cost guard runs on this task. The user set it and code enforces it, so you do not manage cost. ' +
  'Rules: 1. Do the task in full, at your normal quality. ' +
  '2. Never skip, shrink or simplify a step to save cost, and never stop early. Only the user cuts scope. ' +
  '3. A tool result can end with a line that starts with "Budget note:". It comes from the user\'s cost guard: follow it.'

const ENDED = ['The cost guard for this task has ended. Work as normal.']

test('/budget with a budget that runs says the spend, what is left and the mode', async ($, on) => {
  // One request: 200,000 tokens read at $0.20 per million is 0.04, plus 0.02 of new text: 0.06.
  // 5.50 - 1.47 = 4.03 is left, and 4.03 / 0.06 is 67.
  engine(on, 1.47)
  store(on, { budget: running() })
  const text = 'Spent $1.47 of $5.50. $4.03 left, about 67 more requests. Open the panel with /budget panel.'
  expect((await cmd($, ''))?.text).toBe(text)
  expect((await cmd($, 'status'))?.text).toBe(text)
})

test('/budget names the course of the task when a to-do list shows it', async ($, on) => {
  // 5.50 - 3.00 = 2.50 is left, and 2.50 / 0.06 is 41. One of four to-dos is done at $3.00: 3.00 + 9.00 x 1.15 = 13.35.
  engine(on, 3)
  store(on, { budget: onCourse() })
  expect((await cmd($, ''))?.text).toBe(
    'Spent $3.00 of $5.50. $2.50 left, about 41 more requests. The task is on course for about $13.35. Open the panel with /budget panel.',
  )
})

test('/budget lists the estimate and the steps of the plan', async ($, on) => {
  // 5.50 - 1.77 = 3.73 is left, and 3.73 / 0.06 is 62.
  // The plan began at 1.47 and no step has spend yet, so the buffer has used 1.77 - 1.47 = 0.30.
  engine(on, 1.77)
  store(on, { budget: running({ mode: 'pace', estimate: EST, plan: plan() }) })
  expect((await cmd($, ''))?.text).toBe(
    'Spent $1.77 of $5.50. $3.73 left, about 62 more requests. Estimate: about $0.67, range $0.37 to $1.35. ' +
      'Steps: 1. Look at the page $0.00 of $1.00; 2. Build the new page $0.00 of $2.00; buffer $0.30 of $1.03. Open the panel with /budget panel.',
  )
})

test('/budget done closes the budget, puts the report in the chat and keeps the run', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const out = await cmd($, 'done')
  // No estimate was made for this task, so there is nothing to learn from.
  expect(out?.text).toBe('Budget closed: the task is done. Spent $1.47 of $5.50. The run is kept in the history.')
  expect(out?.raw?.context).toBeUndefined()
  expect(get('budget')).toBeFalsy()
  expect(get('history')?.[0]?.outcome).toBe('under')
  expect(get('history')?.[0]?.spent).toBe(1.47)
  await flush()
  expect(w.placed).toEqual(['rep-b1'])
})

test('/budget done names the estimate, and a budget that was raised closes as over', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ estimate: EST, raised: 2 }) })
  // Two messages went into this spend and the cost of the first task was not kept: the estimate cannot be checked.
  expect((await cmd($, 'done'))?.text).toBe(
    'Budget closed: the task is done. Spent $1.47 of $5.50. The estimate was about $0.67 (range $0.37 to $1.35). The run is kept in the history.',
  )
  expect(get('history')?.[0]?.outcome).toBe('over')
})

test('/budget done after one message with an estimate: the mod learns from the run', async ($, on) => {
  engine(on, 1.47)
  const get = store(on, { budget: running({ estimate: EST, messages: 1 }) })
  expect((await cmd($, 'done'))?.text).toBe(
    'Budget closed: the task is done. Spent $1.47 of $5.50. The estimate was about $0.67 (range $0.37 to $1.35). The mod learned from this run.',
  )
  expect(get('history')?.[0]?.outcome).toBe('under')
})

test('/budget off ends the budget with no report in the chat', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const out = await cmd($, 'off')
  expect(out?.text).toBe('Budget ended. Spent $1.47 of $5.50.')
  expect(out?.raw?.context).toBeUndefined()
  expect(get('budget')).toBeFalsy()
  expect(get('history')?.[0]?.outcome).toBe('ended')
  await flush()
  expect(w.placed).toEqual([])
})

test('/budget report shows the last budget that finished', async ($, on) => {
  const w = engine(on, 1.47)
  store(on, { budget: running() })
  expect((await cmd($, 'report'))?.text).toBe('No budget has finished yet.')
  await cmd($, 'end')
  expect((await cmd($, 'report'))?.text).toBe('The last budget: research the claude models. Spent $1.47 of $5.50.')
  await flush()
  expect(w.placed).toEqual(['rep-b1'])
})

test('/budget finish on a chat that is stopped sends Claude on to write its last answer', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running({ isPaused: true, isMidTurn: true }) })
  const sent = prompts(on)
  expect((await cmd($, 'finish'))?.text).toBe('Claude finishes now: one last answer with what is done and what is not.')
  expect(get('budget')?.phase).toBe('landing')
  expect(get('budget')?.isPaused).toBe(false)
  expect(sent.length).toBe(0)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual([
    'Finish now. Do not start new work. Write your final answer: what is done, what is not done, and where each file or result is.',
  ])
  expect(get('budget')?.phase).toBe('landing')
})

test('/budget finish on a chat that still works sends nothing, and the next tool call does not run', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const sent = prompts(on)
  const p = person(on, [])
  await cmd($, 'finish')
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.length).toBe(0)
  expect(get('budget')?.phase).toBe('landing')
  expect(String((await tool($, {}))?.deny)).toMatch(/^The user chose to finish this task now, so this tool call did not run\./)
  expect(p.tools.length).toBe(0)
})

test('/budget add on a budget that is stopped sends Claude on', async ($, on) => {
  const w = engine(on, 0.45)
  const get = store(on, { budget: running({ limit: 0.5, spent: 0.45, ownSpend: 0.45, isPaused: true, isMidTurn: true }) })
  const sent = prompts(on)
  expect((await cmd($, 'add 5'))?.text).toBe('Budget raised from $0.50 to $5.50. Spent $0.45, $5.05 left.')
  expect(get('budget')?.isPaused).toBe(false)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['Continue from where you stopped.'])
})

for (const args of ['finish', 'end', 'set 3']) {
  test(`/budget ${args} with no budget gives the help text`, async ($, on) => {
    engine(on, 1.47)
    store(on)
    expect((await cmd($, args))?.text).toBe(HELP_TEXT)
  })
}

test('/budget panel opens the panel, and /budget learn with no past chats says so', async ($, on) => {
  engine(on, 1.47)
  store(on)
  expect((await cmd($, 'panel'))?.text).toBe('Budget panel opened.')
  expect((await cmd($, 'open'))?.text).toBe('Budget panel opened.')
  expect((await cmd($, 'learn'))?.text).toBe('There are no past chats to read yet.\nAn estimate now sends the model up to 5 short pieces (160 characters each) of your past prompts that look like the new task, from any project. /budget learn off stops that.')
})

async function planTool($: unknown, input: Record<string, unknown>): Promise<string> {
  return String((await tool($, { tool: 'mcp__task-budget__plan', ...input }))?.result)
}

/** Claude marks a step. Returns the text Claude gets back. */
async function stepTool($: unknown, step: unknown, status: unknown, over: Record<string, unknown> = {}): Promise<string> {
  return String((await tool($, { tool: 'mcp__task-budget__step', step, status, ...over }))?.result)
}

// ---------- the estimate sees the end of the last answer ----------

test('the estimate call gets the end of the last answer of Claude, so "go ahead" can be counted', async ($, on) => {
  const messages = [
    { role: 'user', text: 'plan the fix', toolUses: [] },
    { role: 'assistant', text: 'Plan: read the 12 report files, then fix each one. Want me to go ahead?', toolUses: [] },
    // A message with tool calls only has no text: the answer before it is the one that counts.
    { role: 'assistant', text: '', toolUses: [] },
  ]
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER), messages })
  store(on)
  person(on, ['Start at $1.20'])
  await cmd($, 'go ahead with the plan')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(counts(w).length).toBe(1)
  expect(counts(w)[0]?.prompt).toContain('TASK\ngo ahead with the plan')
  expect(counts(w)[0]?.prompt).toContain('THE LAST ANSWER OF CLAUDE IN THIS CHAT (its end)\nPlan: read the 12 report files, then fix each one. Want me to go ahead?')
})

test('a chat with no answer of Claude sends no last answer', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER), messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  store(on)
  person(on, ['Start at $1.20'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(counts(w).length).toBe(1)
  expect(counts(w)[0]?.prompt).not.toContain('THE LAST ANSWER')
})

// ---------- 0.7.0: the first-run question, the advice, and the limit that is under the estimate ----------

/** One answer that both small calls can read: the count of the work, and the pick of the model and effort level. */
const BOTH = { ...ANSWER, model: 'sonnet', effort: 'medium', why: 'a scoped job' }

test('the first /budget asks one time to read the last 7 days of chats, and keeps the answer', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const p = person(on, ['Not now', 'Not now'], 'Yes')
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.scans.length).toBe(1)
  expect(String(p.scans[0]?.question).split('\n')[0]).toBe('Read your last 7 days of chats to learn how you work?')
  expect(p.scans[0]?.options.map((o: any) => o.label)).toEqual(['Yes', 'Not now'])
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-history.json')))).scan).toBe('yes')
  // The estimate still comes, and the second /budget does not ask again.
  expect(p.questions.length).toBe(1)
  await cmd($, 'fix the other report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.scans.length).toBe(1)
  expect(p.questions.length).toBe(2)
  expect(get('budget')).toBeFalsy()
})

test('Not now on the first-run question is kept, and /budget learn turns the reading on', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  store(on)
  const p = person(on, ['Not now'], 'Not now')
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.scans.length).toBe(1)
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-history.json')))).scan).toBe('no')
  await cmd($, 'learn')
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-history.json')))).scan).toBe('yes')
})

test('the advice: Switch runs the requests of this task on the model and effort level that fit', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(BOTH) })
  const get = store(on)
  prompts(on)
  const sent = model(on, w)
  const p = person(on, ['Switch to Sonnet at medium', 'Start, no limit'])
  picker(on, 'high')
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(String(p.questions[0]?.question)).toMatch(/^Run this on Sonnet at medium: about \$\d+\.\d\d(, against \$\d+\.\d\d now| either way)\. Switch\?$/)
  expect(labelsOf(p.questions[0])[0]).toBe('Switch to Sonnet at medium')
  expect(labelsOf(p.questions[0]).length).toBe(2)
  // The work was counted one time. The new price comes from code.
  expect(counts(w).length).toBe(1)
  expect(String(p.questions[1]?.question)).toMatch(/^Likely \$\d+\.\d\d, usually .* Start\?$/)
  const b = get('budget')
  expect(b?.route).toEqual({ model: 'sonnet', effort: 'medium' })
  expect(b?.isTrack).toBe(true)
  // The new price is in the question and in the budget. It holds one full read of the chat on the new model.
  expect(String(p.questions[0]?.question)).toContain(`about $${(b?.estimate?.likely ?? 0).toFixed(2)}`)
  expect(String(p.questions[1]?.question)).toContain(`Likely $${(b?.estimate?.likely ?? 0).toFixed(2)},`)
  expect(b?.estimate?.likely).not.toBe(0.46)
  await request($)
  expect(sent[0]?.model).toBe('sonnet')
  expect(sent[0]?.effort).toBe('medium')
  // A helper keeps its own model.
  await request($, { agentId: 'a1', model: 'claude-haiku-5-5' })
  expect(sent[1]?.model).toBe('claude-haiku-5-5')
})

test('the advice: Keep changes nothing', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(BOTH) })
  const get = store(on)
  prompts(on)
  const sent = model(on, w)
  person(on, ['Keep Opus', 'Start, no limit'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(get('budget')?.route).toBeUndefined()
  expect(get('budget')?.estimate?.likely).toBe(0.46)
  await request($)
  expect(sent[0]?.model).not.toBe('sonnet')
})

test('a limit under the likely cost: the person chooses before anything starts, and Stop starts nothing', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const sent = prompts(on)
  const p = person(on, ['Stop'])
  picker(on, 'high')
  const out = await cmd($, '0.2 fix the report in the files')
  expect(out?.text).toMatch(/^Estimating the cost\. In about 20 seconds the task starts with a limit of \$0\.20\./)
  await w.clock.advance(100)
  await w.clock.settle()
  expect(String(p.questions[0]?.question)).toBe('Likely $0.45, over your $0.20 limit. What now?')
  expect(labelsOf(p.questions[0])).toEqual(['Raise the limit to $0.80', 'Lower the effort', 'Lower the model', 'Stop'])
  expect(get('budget')).toBeFalsy()
  expect(w.toasts).toContain('Nothing started. The likely cost is $0.45 and your limit was $0.20.')
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.length).toBe(0)
})

test('a limit under the likely cost: Raise starts the task at the new limit', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const sent = prompts(on)
  person(on, ['Raise the limit to $0.80'])
  await cmd($, '0.2 fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(get('budget')?.limit).toBe(0.8)
  expect(get('budget')?.estimate?.likely).toBe(0.46)
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['fix the report in the files'])
})

test('a limit under the likely cost: Lower the model estimates again with no new count of the work', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  prompts(on)
  // Lower the model each time it is still over. Haiku has no model under it, so the last answer is Raise.
  const p = person(on, ['Lower the model', 'Lower the model', 'Raise the limit'])
  await cmd($, '0.1 fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(counts(w).length).toBe(1)
  expect(p.questions.length >= 1).toBe(true)
  const b = get('budget')
  expect(b).toBeTruthy()
  expect(['sonnet', 'haiku']).toContain(b?.route?.model)
  expect((b?.estimate?.likely ?? 9) < 0.46).toBe(true)
})

test('a limit over the likely cost starts the task with no question', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const sent = prompts(on)
  const p = person(on, [])
  await cmd($, '5 fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.questions.length).toBe(0)
  expect(get('budget')?.limit).toBe(5)
  expect(get('budget')?.estimate?.likely).toBe(0.46)
  expect(get('budget')?.isTrack).toBeFalsy()
  await w.clock.advance(200)
  await w.clock.settle()
  expect(sent.map(e => e.text)).toEqual(['fix the report in the files'])
})

// ---------- 0.7.1 ----------

test('0.7.1: the first answer of a task with an estimate closes the budget with the real cost', async ($, on) => {
  const w = engine(on, 0.9)
  ends(on)
  const get = store(on, { budget: running({ spent: 0.9, ownSpend: 0.9, msgStart: 0, messages: 1, estimate: EST }) })
  await ended($)
  expect(get('budget')).toBeFalsy()
  expect(w.toasts.some((t: string) => t.startsWith('Task done.'))).toBe(true)
  const runs = get('history') as any[]
  expect(runs[runs.length - 1]?.spent).toBe(0.9)
})

test('0.7.1: open items in the task list of Claude do not keep a task open when the small model says it is done', async ($, on) => {
  const todos = [
    { text: 'Read the inbox', status: 'in_progress' as const },
    { text: 'Write the summary', status: 'pending' as const },
  ]
  const w = engine(on, 0.9, { answer: '{"done": 100, "step": 2}' })
  ends(on)
  const get = store(on, { budget: running({ spent: 0.9, ownSpend: 0.9, msgStart: 0, messages: 1, estimate: EST, todos }) })
  await ended($)
  expect(w.asked.length).toBe(1)
  expect(get('budget')).toBeFalsy()
})

test('0.7.1: when the small model says the task is not done, the budget stays open and the plan moves to the step', async ($, on) => {
  const todos = [{ text: 'Read the inbox', status: 'in_progress' as const }]
  const steps = plan({ source: 'estimate', byTool: false }).steps.map((st, i) => ({ ...st, state: i === 0 ? ('active' as const) : ('pending' as const) }))
  const w = engine(on, 0.9, { answer: '{"done": 40, "step": 2}' })
  ends(on)
  const get = store(on, { budget: running({ spent: 0.9, ownSpend: 0.9, msgStart: 0, messages: 1, estimate: EST, todos, plan: plan({ source: 'estimate', byTool: false, steps }) }) })
  await ended($)
  expect(w.asked.length).toBe(1)
  expect(get('budget')?.firstCost).toBeUndefined()
  expect(get('budget')?.left?.part).toBe(0.4)
  expect(get('budget')?.plan?.steps.map((st: any) => st.state)).toEqual(['done', 'active'])
})

test('0.7.1: the panel shows a plan from the estimate with the step that runs now, and no - or + buttons', async ($, on) => {
  engine(on, 1.47)
  const steps = plan().steps.map((st, i) => ({ ...st, spent: i === 0 ? 0.8 : 0.2, state: i === 0 ? ('done' as const) : ('active' as const) }))
  store(on, { budget: running({ estimate: EST, plan: plan({ source: 'estimate', byTool: false, steps }), left: { part: 0.6, at: 1.47, usd: 2.45, step: 2 } }) })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^step 2 of 2$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$0\.20 of \$2\.00 · now/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /About 60% of the work is done · step 2 of 2/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'plus-0' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^Buffer$/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('0.7.1: the badge says Likely over when the course is over the limit', async ($, on) => {
  engine(on, 1.47)
  store(on, { budget: running({ estimate: EST, left: { part: 0.2, at: 1.47, usd: 7.35 } }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Likely over/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /On track/ })).toBeFalsy()
  await ui.unmount()
})

test('0.7.1: the panel names the chat start as its own part of the spend', async ($, on) => {
  engine(on, 1.47)
  store(on, { budget: running({ isFresh: true, load: { tokens: 186_000, usd: 0.9 } }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Chat start \$0\.82 · Work \$0\.64/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^186K tokens at the start$/ })).toBeTruthy()
  await ui.unmount()
})

test('0.7.1: the small text beside the model picker names the model and effort level of the task', async ($, on) => {
  engine(on, 1.47)
  const mode = { plugin: 'task-budget', component: 'SessionMode', props: { modes: ['MODES'] } } as const
  const cells = new Map<string, unknown>()
  on('state.get', (_: unknown, e: any) => ({ value: { value: cells.get(e.key), version: 1 } }))
  cells.set('budget', running({ route: { model: 'sonnet', effort: 'medium' } }))
  const ui = await $.ui.mount({ ...mode, surface: 'desktop' })
  expect(await ui.find({ text: /^This task: Sonnet at medium$/ })).toBeTruthy()
  await ui.unmount()
  // A task on the model of the chat: no text.
  cells.set('budget', running())
  const ui2 = await $.ui.mount({ ...mode, surface: 'desktop' })
  expect(await ui2.find({ text: /This task/ })).toBeFalsy()
  await ui2.unmount()
})

test('0.7.2: after a task the panel keeps its summary: cost, estimate, each step, where the money went, and the next task parts', async ($, on) => {
  engine(on, 0)
  store(on, {
    budget: null,
    last: {
      id: 'r1',
      at: '2026-11-17T00:00:00.000Z',
      task: 'find the common patterns in the newsletters',
      limit: 10,
      spent: 3.8,
      messages: 1,
      model: 'opus',
      effort: 'medium',
      outcome: 'under',
      first: 3.8,
      secs: 207,
      estimate: { low: 1.73, likely: 3.46, safe: 10 },
      steps: [
        { name: 'Scout', usd: 2.06, spent: 1.47, check: 'open' },
        { name: 'Build the report', usd: 0.33, spent: 2.1, check: 'open' },
      ],
      parts: [
        { name: 'Chat read again', usd: 1 },
        { name: 'Work', usd: 2.8 },
      ],
      loadTokens: 195_000,
    },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Task done/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Ran on Opus at medium · 3 min 27 s · 1 message$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Limit not used$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^For the estimate score this is a hit: the real cost is inside 2 times the estimate\.$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^What each step cost$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\$2\.10 of \$0\.33/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Not in a step/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Chat read again \$1\.00 · Work \$2\.80/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^195K tokens at the start$/ })).toBeTruthy()
  // The parts for the next task stay below the summary.
  expect(await ui.find({ type: 'Text', text: /^Or start now$/ })).toBeTruthy()
  await ui.unmount()
})

test('0.7.2: with no finished task in this chat the panel shows its title and no summary', async ($, on) => {
  engine(on, 0)
  store(on, { budget: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Task Budget$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /What each step cost/ })).toBeFalsy()
  await ui.unmount()
})

// ---------- 0.7.3 ----------

test('0.7.3: the plan of the panel follows the task list of Claude, and the list of another mod does not replace it', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running() })
  const items = [
    { content: 'Find the videos', status: 'in_progress' },
    { content: 'Write the report', status: 'pending' },
  ]
  const other = [
    { text: 'Other list, row 1', status: 'in_progress' },
    { text: 'Other list, row 2', status: 'pending' },
  ]
  model(on, w, 0.05, (_e, n) =>
    n === 1
      ? { stopReason: 'tool_use', toolUses: [{ id: 'u1', name: 'mcp__ccd_turn__update_plan', input: { items } }, { id: 'u2', name: 'mcp__helper-desk__plan', input: { steps: other } }] }
      : n === 2
        ? { stopReason: 'tool_use', toolUses: [{ id: 'u3', name: 'mcp__helper-desk__plan', input: { steps: other } }, { id: 'u4', name: 'mcp__ccd_turn__update_plan', input: { advance: true } }] }
        : {},
  )
  await request($)
  let p = get('budget')?.plan
  expect(p?.source).toBe('todos')
  expect(p?.steps.map((st: any) => st.name)).toEqual(['Find the videos', 'Write the report'])
  expect(p?.steps.map((st: any) => st.state)).toEqual(['active', 'pending'])
  expect(get('budget')?.todoTool).toBe('mcp__ccd_turn__update_plan')
  await request($)
  p = get('budget')?.plan
  expect(p?.steps.map((st: any) => st.name)).toEqual(['Find the videos', 'Write the report'])
  expect(p?.steps.map((st: any) => st.state)).toEqual(['done', 'active'])
  // The second request was paid while step 1 was the active step.
  expect(near(p?.steps[0]?.spent, 0.05, 1e-6)).toBe(true)
  expect(p?.steps.every((st: any) => st.usd === 0)).toBe(true)
})

test('0.7.3: the panel shows the task list of Claude with the real cost of each step, and the chat start of the estimate', async ($, on) => {
  engine(on, 1.47)
  const steps = [
    { name: 'Find the videos', usd: 0, spent: 0.8, state: 'done' as const, isWarned: true, check: 'open' as const },
    { name: 'Write the report', usd: 0, spent: 0.2, state: 'active' as const, isWarned: true, check: 'open' as const },
    { name: 'Log the work', usd: 0, spent: 0, state: 'pending' as const, isWarned: true, check: 'open' as const },
  ]
  store(on, { budget: running({ estimate: { ...EST, base: { tokens: 186_000, usd: 0.3 } }, plan: plan({ source: 'todos', byTool: false, steps, reserve: 0 }) }) })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Claude's task list/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^step 2 of 3 · real cost$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\$0\.80$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$0\.20 · now/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /of \$0\.00/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /about \$0\.00/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /In the estimate: chat start 186K tokens, \$0\.30\. Work \$0\.37\./ })).toBeTruthy()
    await ui.unmount()
  }
})

// ---------- 0.7.4: the badge, the line under the graph and the band agree ----------

const REAL = { ...EST, low: 1.5, likely: 4.06, safe: 22.5, usual: [2.84, 6.49], hold: 95 }

test('0.7.4: plain /budget at $4.38 against $4.06 says Over the estimate in the panel and the band', async ($, on) => {
  engine(on, 4.38)
  const cells = new Map<string, unknown>()
  on('state.get', (_: unknown, e: any) => ({ value: { value: cells.get(e.key), version: 1 } }))
  cells.set('budget', running({ isTrack: true, isOpen: true, limit: 22.5, spent: 4.38, ownSpend: 4.38, estimate: REAL }))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^● Over the estimate$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Spent so far \$4\.38 against an estimate of \$4\.06: over the estimate\./ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Tracking|On track|At the estimate/ })).toBeFalsy()
    await ui.unmount()
  }
  const band = await $.ui.mount({ plugin: 'task-budget', component: 'AbovePrompt', props: {}, surface: 'terminal' } as any)
  expect(await band.find({ type: 'Text', text: /^Over the estimate$/ })).toBeTruthy()
  await band.unmount()
  // The cost moves with no step change: the badge moves with it.
  cells.set('budget', running({ isTrack: true, isOpen: true, limit: 22.5, spent: 3.95, ownSpend: 3.95, estimate: REAL }))
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /^● At the estimate$/ })).toBeTruthy()
  await ui2.unmount()
})

test('0.7.4: /budget 5 under its limit but over the estimate is not On track', async ($, on) => {
  engine(on, 0.8)
  store(on, { budget: running({ limit: 5, spent: 0.8, ownSpend: 0.8, estimate: EST }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^● Over the estimate$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /On track/ })).toBeFalsy()
  await ui.unmount()
})

// ---------- 0.7.5: the list Claude did not tick ----------

const LIST = [
  { text: 'Read the rules', status: 'completed' as const },
  { text: 'Propose the plan', status: 'completed' as const },
  { text: 'Pull the numbers', status: 'in_progress' as const },
  { text: 'Analyze them', status: 'pending' as const },
  { text: 'Build the report', status: 'pending' as const },
]

test('0.7.5: a task with two messages closes when the small model says it is done, and every step is ticked', async ($, on) => {
  const w = engine(on, 8.03, { answer: '{"done": 100, "step": 5}' })
  ends(on)
  const b = planFromTodos(running({ isTrack: true, isOpen: true, limit: 22.5, spent: 8.03, ownSpend: 8.03, msgStart: 0, messages: 2, estimate: REAL }), LIST)
  const get = store(on, { budget: { ...b, todos: LIST } })
  await ended($)
  expect(w.asked.length).toBe(1)
  expect(get('budget')).toBeFalsy()
  const last = get('last')
  expect(last?.steps.map((st: any) => st.check)).toEqual(['open', 'open', 'open', 'open', 'open'])
  expect(last?.ticked).toBe(3)
  expect(last?.first).toBe(8.03)
})

test('0.7.5: a task with two messages that is not done stays open, and the list moves on to the step of the small model', async ($, on) => {
  const w = engine(on, 6, { answer: '{"done": 70, "step": 4}' })
  ends(on)
  const b = planFromTodos(running({ isTrack: true, isOpen: true, limit: 22.5, spent: 6, ownSpend: 6, msgStart: 0, messages: 2, estimate: REAL }), LIST)
  const get = store(on, { budget: { ...b, todos: LIST } })
  await ended($)
  expect(w.asked.length).toBe(1)
  expect(get('budget')?.firstCost).toBeUndefined()
  expect(get('budget')?.plan?.steps.map((st: any) => st.state)).toEqual(['done', 'done', 'done', 'active', 'pending'])
  expect(get('budget')?.plan?.ticked).toBe(1)
})

test('0.7.5: Task is done ticks every step, and the summary says the mod ticked them', async ($, on) => {
  engine(on, 8.03)
  const b = planFromTodos(running({ isTrack: true, isOpen: true, limit: 22.5, spent: 8.03, ownSpend: 8.03, messages: 2, estimate: REAL }), LIST)
  const get = store(on, { budget: { ...b, todos: LIST } })
  await cmd($, 'done')
  const last = get('last')
  expect(last?.ticked).toBe(3)
  expect(last?.steps.every((st: any) => st.check !== 'not done')).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Claude did not tick 3 steps in its list\. The mod marked them done\./ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Task done · Over the estimate/ })).toBeTruthy()
  await ui.unmount()
})

test('0.7.5: the curve puts each label at its own mark, and a far safe budget does not squeeze it', () => {
  const pts = Array.from({ length: 41 }, (_, i) => ({ usd: (22.5 * i) / 40, y: Math.exp(-(((22.5 * i) / 40 - 4) ** 2) / 4) }))
  const svg = curveSvg(pts, { likely: 4.06, band: [2.03, 8.12], spent: 8.03, tint: '#d97706', safe: 22.5 }, 400)
  expect(svg).toContain('>now $8.03<')
  expect(svg).toContain('>likely $4.06<')
  expect(svg).not.toContain('safe $22.50')
  // The likely label is on the top row and the spend label on the bottom row.
  expect(/y="12"[^>]*>likely \$4\.06</.test(svg)).toBe(true)
  expect(/y="86"[^>]*>now \$8\.03</.test(svg)).toBe(true)
  // A near safe budget is drawn.
  expect(curveSvg(pts, { likely: 4.06, spent: 3, safe: 9 }, 400)).toContain('safe $9.00')
})


// ---------- 0.7.6 ----------

test('0.7.6: the advice names the effort of the app picker, and says so when it cannot see it', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(BOTH) })
  store(on)
  prompts(on)
  const p = person(on, ['Keep Opus', 'Not now'])
  picker(on, 'medium')
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  // 0.8.0: one line. The price now is for the effort of the picker.
  expect(String(p.questions[0]?.question)).toMatch(/^Run this on Sonnet at medium: about \$\d+\.\d\d(, against \$\d+\.\d\d now| either way)\. Switch\?$/)
  expect(String(p.questions[0]?.question)).not.toMatch(/cannot see/)
})

test('0.7.6: with no picker and no request in this chat, the advice names no effort level', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(BOTH) })
  store(on)
  prompts(on)
  const p = person(on, ['Keep Opus', 'Not now'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  const q = String(p.questions[0]?.question)
  // 0.8.0: no "cannot see" line. The advice is a target.
  expect(q).toMatch(/^Run this on Sonnet at medium: /)
  expect(q).not.toMatch(/cannot see|Opus at (low|medium|high)/)
})

test('0.7.6: each request of the chat tells the budget its real effort level, unless the advice set one', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running({ effort: 'high' }) })
  model(on, w)
  await request($, { effort: 'medium' })
  expect(get('budget')?.effort).toBe('medium')
})

test('0.7.6: a budget that took the advice keeps the effort of the advice', async ($, on) => {
  const w = engine(on, 1.47)
  const get = store(on, { budget: running({ effort: 'low', route: { model: 'sonnet', effort: 'low' } }) })
  model(on, w)
  await request($, { effort: 'high' })
  expect(get('budget')?.effort).toBe('low')
})

test('0.7.6: /budget at the end of a message estimates first, and Claude gets the task without it', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  const sent = prompts(on)
  person(on, ['Start, no limit'])
  const r = await say($, 'fix the report in the files /budget')
  expect(r?.drop).toBe('Estimating the cost. In about 20 seconds you can start with no limit or with a limit. Nothing starts before you pick.')
  expect(sent.length).toBe(0)
  await w.clock.advance(100)
  await w.clock.settle()
  await w.clock.advance(200)
  await w.clock.settle()
  expect(get('budget')?.isTrack).toBe(true)
  expect(get('budget')?.task).toBe('fix the report in the files')
  for (const s of sent) {
    expect(String(s.text)).not.toContain('/budget')
    expect(/\$\d/.test(String(s.text) + ' ' + String((s.context ?? []).join(' ')))).toBe(false)
  }
})

test('0.7.6: /budget 5 at the end of a message estimates first with that limit', async ($, on) => {
  engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  store(on)
  const sent = prompts(on)
  const r = await say($, 'fix the report in the files /budget 5')
  expect(String(r?.drop)).toMatch(/^Estimating the cost\. In about 20 seconds the task starts with a limit of \$5\.00\./)
  expect(sent.length).toBe(0)
})

test('0.7.6: /budget 5! at the end of a message starts at once, and Claude gets the task without the command or the amount', async ($, on) => {
  engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = prompts(on)
  await say($, 'recreate our landing page /budget 5!')
  expect(sent.length).toBe(1)
  expect(sent[0]?.text).toBe('recreate our landing page')
  expect(get('budget')?.limit).toBe(5)
})

test('0.7.6: /budget at the start of a message, before the app listed the command, estimates first', async ($, on) => {
  engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  store(on)
  const sent = prompts(on)
  const r = await say($, '/budget fix the report in the files')
  expect(r?.drop).toBe('Estimating the cost. In about 20 seconds you can start with no limit or with a limit. Nothing starts before you pick.')
  expect(sent.length).toBe(0)
})

for (const text of ['how does /budget work in this mod', 'fix it /budget', 'please read ~/notes/budget']) {
  test(`0.7.6: a message that only names /budget goes on as it is: ${text}`, async ($, on) => {
    engine(on, 0, { tokens: 200_000 })
    const get = store(on)
    const sent = prompts(on)
    await say($, text)
    expect(sent.length).toBe(1)
    expect(sent[0]?.text).toBe(text)
    expect(get('budget')).toBeFalsy()
  })
}

test('0.7.6: a message from a mod that ends with /budget is not a budget', async ($, on) => {
  engine(on, 0, { tokens: 200_000 })
  const get = store(on)
  const sent = prompts(on)
  await say($, 'fix the report in the files /budget', 'plugin')
  expect(sent.length).toBe(1)
  expect(get('budget')).toBeFalsy()
})

test('0.8.0: with no effort level seen, the advice for the same model is a target in the start line', async ($, on) => {
  // No picker, no request in this chat and no chat file: the effort level is unknown. The advice is Opus at medium.
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify({ ...ANSWER, model: 'opus', effort: 'medium', why: 'a scoped job' }) })
  store(on)
  prompts(on)
  const p = person(on, ['Not now'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  const q = String(p.questions[0]?.question)
  expect(q).toMatch(/^Likely \$\d+\.\d\d, usually .*\. Run this at medium effort\. Start\?$/)
  expect(q).not.toMatch(/cannot see/)
})

// ---------- 0.8.0: the small model reads the chat often enough ----------

/** The read of the chat runs in the background: let it finish. */
async function readDone(w: World): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flush()
    await w.clock.settle()
  }
}

test('0.8.0: when Claude never ticks its list, the small model reads the chat each time the spend grows by the gap, and its reading sets the course', async ($, on) => {
  // No estimate: the gap is 4% of the $5.50 limit, $0.22. Each request costs $0.15.
  const idle = T4.map(t => ({ ...t, status: 'pending' as const }))
  const w = engine(on, 1, { answer: '{"done": 30, "step": 1}' })
  const get = store(on, { budget: running({ spent: 1, ownSpend: 1, readAt: 0, checks: 0, todos: idle }) })
  model(on, w, 0.15)
  await request($)
  await readDone(w)
  // $1.15: $1.15 since the last read. One read.
  expect(w.asked.length).toBe(1)
  expect(get('budget')?.left?.part).toBe(0.3)
  expect(get('budget')?.readAt).toBe(1.15)
  await request($)
  await readDone(w)
  // $1.30: only $0.15 since the last read. No read.
  expect(w.asked.length).toBe(1)
  await request($)
  await readDone(w)
  // $1.45: $0.30 since the last read. A second read.
  expect(w.asked.length).toBe(2)
  expect(get('budget')?.readAt).toBe(1.45)
})

test('0.8.0: a new step in Claude\'s task list makes the small model read the chat at once', async ($, on) => {
  const idle = T4.map(t => ({ ...t, status: 'pending' as const }))
  const w = engine(on, 1, { answer: '{"done": 30, "step": 2}' })
  const get = store(on, { budget: running({ spent: 1, ownSpend: 1, readAt: 1, checks: 1, todos: idle }) })
  const todos = T4.map((t, i) => ({ content: t.text, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending' }))
  model(on, w, 0.05, () => ({ toolUses: [{ id: 'u1', name: 'TodoWrite', input: { todos } }] }))
  await request($)
  await readDone(w)
  // Only $0.05 since the last read, but a step moved: one read.
  expect(w.asked.length).toBe(1)
  expect(get('budget')?.isStepNew).toBe(false)
  expect(get('budget')?.todosAt).toBe(1.05)
  // The same list again: no step moved, and no read.
  await request($)
  await readDone(w)
  expect(w.asked.length).toBe(1)
})

// ---------- 0.8.0: the mod counts its own cost ----------

test('0.8.0: one run shows the mod cost section: what the mod calls cost and the whole bill of the chat', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  person(on, ['Start, no limit'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  const b = get('budget')
  // The estimate and the advice were paid before the start. They are this run's mod cost, and they count in the spend.
  expect(b?.modCost ?? 0).toBeGreaterThan(b?.estimate?.cost ?? 0)
  expect(near(b?.spent ?? 0, b?.modCost ?? 0, 1e-4)).toBe(true)
  // The whole bill of the chat stays what it was: $1.47.
  expect(near((b?.startCost ?? 0) + (b?.spent ?? 0), 1.47, 1e-4)).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Mod cost$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^This mod run cost \$0\.0\d\d$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Session total, mod included \$1\.47$/ })).toBeTruthy()
  await ui.unmount()
})

test('0.8.0: two runs add up: the session total carries the first run, and each run has its own mod cost', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  person(on, ['Start, no limit', 'Start, no limit'])
  model(on, w, 0.5)
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  const mod1 = get('budget')?.modCost ?? 0
  await request($)
  await readDone(w)
  await cmd($, 'end')
  const first = get('last')
  // The first run closed at a chat bill of $1.97.
  expect(first?.session).toBe(1.97)
  expect((first?.mod ?? 0) >= mod1).toBe(true)
  await cmd($, 'add a summary to the report')
  await w.clock.advance(100)
  await w.clock.settle()
  await request($)
  await readDone(w)
  const b = get('budget')
  // The second run: its own mod cost, and the session total holds the first run too: $1.97 + $0.50 = $2.47.
  expect(b?.modCost ?? 0).toBeGreaterThan(0)
  expect(near((b?.startCost ?? 0) + (b?.spent ?? 0), 2.47, 1e-4)).toBe(true)
  const [modLine, sessionLine] = modLines(b?.modCost ?? 0, (b?.startCost ?? 0) + (b?.spent ?? 0))
  expect(sessionLine).toBe('Session total, mod included $2.47')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: modLine })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: sessionLine })).toBeTruthy()
  await ui.unmount()
})

test('0.8.0: the estimate holds the predicted mod cost: with no history, the estimate call, one advice call and a read for each read gap', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  const get = store(on)
  person(on, ['Start, no limit'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  const e = get('budget')?.estimate
  // $0.42 of work. The read gap is $0.08, so 6 reads at $0.005, plus $0.006 of advice, plus what the estimate cost.
  expect(near(e?.mod ?? 0, Math.round(((e?.cost ?? 0) + 0.006 + 6 * 0.005) * 10_000) / 10_000, 1e-4)).toBe(true)
  expect(near(e?.likely ?? 0, Math.round((0.42 + (e?.mod ?? 0)) * 100) / 100, 0.011)).toBe(true)
})

test('0.8.0: the predicted mod cost learns from past runs', async ($, on) => {
  // Three past runs where the mod cost $0.01, $0.02 and $0.09. The middle one is $0.02.
  const runs = [0.01, 0.02, 0.09].map((mod, i) => ({
    id: `r${i}`, at: '2026-11-01T00:00:00.000Z', limit: 2, spent: 1, messages: 1, outcome: 'ended', model: 'sonnet', kind: 'ops', mod,
  }))
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER), files: { 'task-budget-history.json': JSON.stringify({ runs }) } })
  const get = store(on)
  person(on, ['Start, no limit'])
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(get('budget')?.estimate?.mod).toBe(0.02)
  expect(get('budget')?.estimate?.likely).toBe(0.44)
})

test('0.8.0: each read of the chat adds its cost to the mod cost of the run', async ($, on) => {
  const idle = T4.map(t => ({ ...t, status: 'pending' as const }))
  const w = engine(on, 1, { answer: '{"done": 30, "step": 1}' })
  const get = store(on, { budget: running({ spent: 1, ownSpend: 1, readAt: 0, checks: 0, todos: idle, modCost: 0.01 }) })
  model(on, w, 0.15)
  await request($)
  await readDone(w)
  expect(w.asked.length).toBe(1)
  expect((get('budget')?.modCost ?? 0) > 0.01).toBe(true)
})


// ---------- subagent fixes (2026-11-17) ----------

/** The engine's agent list, TaskStop and turn.abort, as the app answers them. */
function agents(on: On, list: { id: string; status: string }[]): { stops: string[]; aborts: string[]; order: string[] } {
  const seen = { stops: [] as string[], aborts: [] as string[], order: [] as string[] }
  on('agent.list', (() => ({ value: list.map(a => ({ ...a, description: 'x', type: 'general-purpose' })) })) as never)
  on('turn.abort', ((_: unknown, e: any) => {
    seen.aborts.push(String(e.turnId))
    seen.order.push(`abort:${e.turnId}`)
    return { value: undefined }
  }) as never)
  on('tool.call', ((_: unknown, e: any) => {
    if (e.tool === 'TaskStop') {
      seen.stops.push(String(e.task_id))
      seen.order.push(`stop:${e.task_id}`)
      return { result: { message: 'stopped', task_id: e.task_id, task_type: 'agent' } }
    }
    return { result: 'ran' }
  }) as never)
  on('turn.start', ((_: unknown, e: any) => ({ turnId: e.turnId })) as never)
  return seen
}

const SPAWNS = [
  { id: 'sub-1', model: 'sonnet', usd: 0.65, used: 0.2, isRunning: true, isExtra: false },
  { id: 'sub-2', model: 'sonnet', usd: 0.65, used: 0.1, isRunning: true, isExtra: false },
  { id: 'sub-3', model: 'sonnet', usd: 0.65, used: 0.6, isRunning: false, isExtra: false },
]

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('subagent fixes: Stop ends every running subagent with TaskStop, then aborts the main turn', async ($, on) => {
  const w = engine(on, 2)
  const get = store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  ends(on)
  const seen = agents(on, [
    { id: 'sub-1', status: 'running' },
    { id: 'sub-2', status: 'waiting' },
    { id: 'sub-3', status: 'completed' },
    { id: 'other', status: 'running' },
  ])
  await ($ as any).turn.start({ text: 'go', turnId: 'main-1' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  await settle()
  // Only this budget's subagents that still run. A subagent of another task is left alone.
  expect(seen.stops).toEqual(['sub-1', 'sub-2'])
  expect(seen.aborts).toEqual(['main-1'])
  expect(seen.order).toEqual(['stop:sub-1', 'stop:sub-2', 'abort:main-1'])
  expect(get('budget')?.isPaused).toBe(true)
  expect(w.toasts.some(t => /helpers are stopped/.test(t))).toBe(true)
})

test('subagent fixes: after Stop a subagent gets no tool call, no request and no new subagent, and the texts name no budget', async ($, on) => {
  const w = engine(on, 2)
  store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  const spawned = ends(on)
  agents(on, [{ id: 'sub-1', status: 'running' }])
  const sent = model(on, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  const refused = await tool($, { tool_use_id: 's1', agentId: 'sub-1' })
  expect(refused?.deny).toBe(AGENT_STOP_DENY)
  // A subagent this budget did not start is refused too while the task is stopped.
  expect((await tool($, { tool_use_id: 's2', agentId: 'stray' }))?.deny).toBe(AGENT_STOP_DENY)
  const r = await request($, { agentId: 'sub-1', model: SONNET })
  expect(sent.length).toBe(0)
  expect(r.answer).toBe(STOPPED)
  const sp = await ($ as any).agent.spawn({ prompt: 'one more', model: 'sonnet', parentModel: SONNET, fork: false }).catch((err: unknown) => ({ deny: String(err) }))
  expect(spawned.spawns.length).toBe(0)
  expect(JSON.stringify(sp)).toContain('Do not start more subagents')
  for (const text of [AGENT_STOP_DENY, SPAWN_STOP_DENY, FORK_DENY, STOPPED]) expect(text).not.toMatch(BUDGET_WORDS)
})

test('subagent fixes: a peer message does not end a stop; a typed one does, and a stopped subagent stays refused', async ($, on) => {
  engine(on, 2)
  const get = store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  ends(on)
  agents(on, [{ id: 'sub-1', status: 'running' }])
  prompts(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  for (const kind of ['peer', 'peer-send-message', 'bridge', 'channel', 'task-notification']) {
    await say($, 'a message from somewhere else', kind)
    expect(get('budget')?.isPaused).toBe(true)
  }
  await say($, 'go on with the work please')
  expect(get('budget')?.isPaused).toBe(false)
  expect((await tool($, { tool_use_id: 's3', agentId: 'sub-1' }))?.deny).toBe(AGENT_STOP_DENY)
})

test('subagent fixes: End budget stops the subagents before the budget closes, and they send no request after', async ($, on) => {
  const w = engine(on, 2)
  const get = store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  ends(on)
  const seen = agents(on, [{ id: 'sub-2', status: 'running' }])
  const sent = model(on, w)
  await cmd($, 'off')
  await settle()
  expect(get('budget')).toBeNull()
  expect(seen.stops).toEqual(['sub-2'])
  await request($, { agentId: 'sub-2', model: SONNET })
  expect(sent.length).toBe(0)
})

test('subagent fixes: 5 subagent requests near the limit give 1 question, and none is sent while it is open', async ($, on) => {
  const w = engine(on, 5.45)
  const get = store(on, { budget: running({ spent: 5.45, ownSpend: 5.45, spawns: SPAWNS.slice(0, 2) }) })
  ends(on)
  const questions: any[] = []
  let sentWhileOpen = 0
  let isOpen = false
  on('tool.call', ((_: unknown, e: any) => {
    if (e.tool !== 'AskUserQuestion') return { result: 'ran' }
    questions.push(e.questions[0])
    isOpen = true
    const pick = e.questions[0].options[0].label ?? e.questions[0].options[0]
    return Promise.resolve().then(() => {
      isOpen = false
      return { result: { questions: e.questions, answers: { [e.questions[0].question]: pick } } }
    })
  }) as never)
  const sent = model(on, w, 0, () => {
    if (isOpen) sentWhileOpen += 1
    return {}
  })
  await Promise.all([1, 2, 3, 4, 5].map(i => request($, { agentId: `par-${i}`, model: SONNET, turnId: `p${i}` })))
  expect(questions.length).toBe(1)
  expect(String(questions[0].options[0].label ?? questions[0].options[0])).toMatch(/^Raise the limit to/)
  expect(sentWhileOpen).toBe(0)
  expect(sent.length).toBe(5)
  // The question is in the history, with its answer.
  expect(get('budget')?.asks?.length).toBe(1)
  expect(get('budget')?.asks?.[0]?.answer).toMatch(/^Raise the limit/)
  expect(get('budget')?.limit).toBeGreaterThan(5.5)
})

test('subagent fixes: after an answer no new soft question comes until the spend rises by 10% of the limit', async ($, on) => {
  const w = engine(on, 3.5)
  store(on, { budget: running({ spent: 3.5, ownSpend: 3.5, limit: 10, quietTo: 4.5, ask: { kind: 'early' } }) })
  ends(on)
  const p = person(on, ['Keep going'])
  model(on, w, 0.3)
  await request($)
  expect(p.questions.length).toBe(0)
})

test('subagent fixes: the raise covers the running subagents at their usual cost', async () => {
  const b = running({ spent: 5.4, ownSpend: 5.4, spawns: [0, 1, 2, 3].map(i => ({ id: `r${i}`, model: 'sonnet', usd: 0.65, used: 0.05, isRunning: true, isExtra: false })) })
  expect(Math.abs(aheadOf(b) - 2.4)).toBeLessThan(1e-6)
  const alone = raiseTo(b, 0.1, null, 0.1, 5.4, 0)
  const withFour = raiseTo(b, 0.1, null, 0.1, 5.4)
  expect(withFour - alone).toBeGreaterThanOrEqual(2.4 - 0.5)
})

test('subagent fixes: a subagent request runs at medium effort at most, and never on Opus', async ($, on) => {
  const w = engine(on, 1)
  store(on, { budget: running({ spent: 1, ownSpend: 1, model: SONNET }) })
  ends(on)
  const sent = model(on, w)
  await request($, { agentId: 'eff-1', model: OPUS, effort: 'high' })
  await request($, { agentId: 'eff-2', model: SONNET, effort: 'low' })
  expect(sent[0].model).toBe('sonnet')
  expect(sent[0].effort).toBe('medium')
  expect(sent[1].effort).toBe('low')
})

test('subagent fixes: a fork on an Opus chat is refused; on a Sonnet chat it runs', async ($, on) => {
  engine(on, 1)
  store(on, { budget: running({ spent: 1, ownSpend: 1 }) })
  const seen = ends(on)
  const out = await ($ as any).agent.spawn({ prompt: 'fork it', parentModel: OPUS, fork: true, subagentType: 'fork' }).catch((err: unknown) => ({ deny: String(err) }))
  expect(JSON.stringify(out)).toContain('Forks are off in this chat')
  expect(seen.spawns.length).toBe(0)
  await ($ as any).agent.spawn({ prompt: 'fork it', parentModel: SONNET, fork: true, subagentType: 'fork' })
  expect(seen.spawns.length).toBe(1)
})

test('subagent fixes: each subagent past the estimate moves the forecast up at once', async ($, on) => {
  engine(on, 1)
  const get = store(on, { budget: running({ spent: 1, ownSpend: 1, estimate: { low: 0.8, likely: 1.2, safe: 2.4, kind: 'research', mode: 'guard', confidence: 'medium', basis: 'test', similar: null, unsure: [], cost: 0.02, units: {} as never, helpers: 0 } as never }) })
  const before = forecast(get('budget'))?.usd ?? 0
  on('agent.spawn', ((_: unknown, e: any) => ({ model: e.model, agentId: 'grow-1' })) as never)
  await ($ as any).agent.spawn({ prompt: 'more', model: 'sonnet', parentModel: SONNET, fork: false })
  const after = forecast(get('budget'))?.usd ?? 0
  expect(get('budget')?.spawns?.[0]?.isExtra).toBe(true)
  expect(after).toBeGreaterThan(before)
})

test('subagent fixes: the person adds to a running task, and the estimate is made again with no pop-up', async ($, on) => {
  const w = engine(on, 0.5, { answer: JSON.stringify({ ...ANSWER, helpers: 3, steps: [{ name: 'Read the calls', done: 'all calls are read', read: 40 }] }) })
  const get = store(on, { budget: running({ spent: 0.5, ownSpend: 0.5, messages: 1, firstCost: undefined, estimate: { low: 0.8, likely: 1.2, safe: 2.4, kind: 'research', mode: 'guard', confidence: 'medium', basis: 'test', similar: null, unsure: [], cost: 0.02, units: {} as never, helpers: 0 } as never }) })
  ends(on)
  prompts(on)
  const p = person(on, [])
  const before = get('budget')?.estimate?.likely ?? 0
  await say($, 'also read the full transcripts of all ten calls')
  for (let i = 0; i < 20 && (get('budget')?.regrows ?? 0) === 0; i++) {
    await w.clock.advance(100)
    await w.clock.settle()
  }
  expect(get('budget')?.regrows).toBe(1)
  expect(p.questions.length).toBe(0)
  expect(counts(w).length).toBe(1)
  expect(get('budget')?.estimate?.likely ?? 0).toBeGreaterThanOrEqual(before)
})

test('subagent fixes: a task with a stop logs each question with its answer, and the run keeps the subagent count', async () => {
  const run = runOf(running({ spawns: SPAWNS, asks: [{ kind: 'cap', spent: 5.4, limit: 5.5, answer: 'Stop', at: '2026-11-17T10:00:00Z' }] }), 'stopped', '2026-11-17T10:01:00Z')
  expect(run.agents).toBe(3)
  expect(run.agentModel).toBe('sonnet')
  expect(run.asks?.[0]?.answer).toBe('Stop')
})

test('subagent fixes: the report shows only the cost of a step that had no planned amount', async ($, on) => {
  engine(on, 1)
  const run = {
    id: 'r9', at: '2026-11-17T10:00:00Z', task: 'read the calls', limit: 5, spent: 1.2, messages: 1, model: 'sonnet',
    outcome: 'done', isOpen: false, mode: 'guard', kind: 'research',
    estimate: { low: 0.5, likely: 1, safe: 3, usual: [0.6, 1.8], hold: 95 },
    steps: [{ name: 'Read the calls', usd: 0, spent: 0.42, check: '' }],
  }
  store(on, { stops: { r9: { kind: 'report', run } } })
  for (const surface of SURFACES) {
    const rep = await $.ui.mount({ ...card('r9'), surface })
    expect(await rep.find({ type: 'Text', text: /^\$0\.42$/ })).toBeTruthy()
    expect(await rep.find({ type: 'Text', text: /of \$0\.00/ })).toBeFalsy()
    await rep.unmount()
  }
})

// ---------- fix 8 in every chat: subagents on Sonnet or Haiku ----------

const spawn = ($: unknown, e: object): Promise<any> =>
  ($ as any).agent.spawn({ prompt: 'look up the prices', fork: false, ...e }).catch((err: unknown) => ({ deny: String(err) }))

test('fix 8 every chat: with no budget, an Opus or Fable ask runs on Sonnet; a model-router pick of Opus is capped too; Sonnet and Haiku asks stay', async ($, on) => {
  const w = engine(on, 1)
  store(on)
  const seen = ends(on)
  await spawn($, { model: 'opus', parentModel: SONNET })
  // The model-router mod is the outer hook: its deep pick reaches this mod as a full id.
  await spawn($, { model: 'claude-opus-5-5', parentModel: OPUS })
  await spawn($, { model: 'claude-fable-5-2', parentModel: SONNET })
  await spawn($, { model: 'haiku', parentModel: OPUS })
  await spawn($, { model: 'sonnet', parentModel: OPUS })
  await spawn($, { parentModel: SONNET })
  expect(seen.spawns.map(e => e.model)).toEqual(['sonnet', 'sonnet', 'sonnet', 'haiku', 'sonnet', undefined])
  // A clear ask needs no judge call.
  expect(w.asked.length).toBe(0)
})

test('fix 8 every chat: no model asked under an Opus chat: the Haiku judge picks; fast gives Haiku, any other or failed answer gives Sonnet', async ($, on) => {
  const w = engine(on, 1)
  store(on)
  const seen = ends(on)
  for (const answer of ['fast', 'balanced', 'not sure', null]) {
    w.answer = answer as never
    await spawn($, { prompt: 'list the files in the notes folder', parentModel: OPUS })
  }
  expect(seen.spawns.map(e => e.model)).toEqual(['haiku', 'sonnet', 'sonnet', 'sonnet'])
  expect(w.asked.length).toBe(4)
  expect(w.asked.every(a => a.model === 'haiku')).toBe(true)
  expect(String(w.asked[0].prompt)).toContain('list the files in the notes folder')
})

test('fix 8 every chat: with no budget, each subagent request is capped too; the main chat is not touched', async ($, on) => {
  const w = engine(on, 1)
  store(on)
  ends(on)
  const sent = model(on, w)
  w.answer = 'fast'
  await spawn($, { prompt: 'list the files', parentModel: OPUS })
  // The subagent started on Haiku. A request that still says Opus (an agent file, say) keeps Haiku, at medium at most.
  await request($, { agentId: 'h-new', model: OPUS, effort: 'high' })
  await request($, { agentId: 'other', model: OPUS, effort: 'xhigh' })
  await request($, { agentId: 'small', model: 'claude-haiku-5-5', effort: undefined })
  await request($, { model: OPUS, effort: 'high' })
  expect(sent.map(e => [e.model, e.effort])).toEqual([
    ['haiku', 'medium'],
    ['sonnet', 'medium'],
    ['claude-haiku-5-5', undefined],
    [OPUS, 'high'],
  ])
})

test('fix 8 every chat: a fork on an Opus chat is refused with no budget too, in words with no money in them', async ($, on) => {
  engine(on, 1)
  store(on)
  const seen = ends(on)
  const out = await spawn($, { prompt: 'fork it', parentModel: OPUS, fork: true, subagentType: 'fork' })
  expect(JSON.stringify(out)).toContain('Forks are off in this chat. Start a normal subagent.')
  expect(FORK_DENY).not.toMatch(BUDGET_WORDS)
  expect(seen.spawns.length).toBe(0)
  await spawn($, { prompt: 'fork it', parentModel: SONNET, fork: true, subagentType: 'fork' })
  expect(seen.spawns.length).toBe(1)
})

test('fix 8 setting off: with no budget nothing changes', { options: { forceHelperModel: false } }, async ($, on) => {
  const w = engine(on, 1)
  store(on)
  const seen = ends(on)
  const sent = model(on, w)
  await spawn($, { model: 'opus', parentModel: SONNET })
  await spawn($, { prompt: 'fork it', parentModel: OPUS, fork: true, subagentType: 'fork' })
  await request($, { agentId: 'a1', model: OPUS, effort: 'high' })
  expect(seen.spawns.map(e => e.model)).toEqual(['opus', undefined])
  expect([sent[0].model, sent[0].effort]).toEqual([OPUS, 'high'])
})

test('fix 8 setting off: in a /budget task the cap still holds', { options: { forceHelperModel: false } }, async ($, on) => {
  engine(on, 1)
  store(on, { budget: running({ spent: 1, ownSpend: 1, model: SONNET }) })
  const seen = ends(on)
  await spawn($, { model: 'opus', parentModel: SONNET })
  expect(seen.spawns.map(e => e.model)).toEqual(['sonnet'])
})

// ---------- fix 1 per user feedback: Escape holds the subagents, the mod's Stop ends them ----------

test('fix 1 Escape: an aborted main turn holds the subagents with no TaskStop; a held request waits until the person types', async ($, on) => {
  const w = engine(on, 2)
  const get = store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  ends(on)
  const seen = agents(on, [{ id: 'sub-1', status: 'running' }, { id: 'sub-2', status: 'running' }])
  const sent = model(on, w)
  prompts(on)
  await ($ as any).turn.start({ text: 'go', turnId: 'main-1' })
  await ended($, { turnId: 'main-1', isAborted: true, reason: 'aborted', answer: '' })
  await settle()
  expect(seen.stops).toEqual([])
  expect(seen.aborts).toEqual([])
  expect(get('budget')?.isPaused).toBe(false)
  expect(w.toasts.some(t => /subagents wait/.test(t))).toBe(true)
  let isBack = false
  const held = request($, { agentId: 'sub-1', model: SONNET, effort: 'low' }).then(r => {
    isBack = true
    return r
  })
  await settle()
  expect(sent.length).toBe(0)
  expect(isBack).toBe(false)
  // A peer message does not let them go, and opening the panel does not either. A typed message does.
  await say($, 'a message from another session', 'peer')
  await say($, '/budget panel')
  await cmd($, 'panel')
  await settle()
  expect(sent.length).toBe(0)
  expect(isBack).toBe(false)
  await say($, 'go on please')
  const r = await held
  expect(sent.length).toBe(1)
  expect(r.answer).toBe('ok')
  expect(seen.stops).toEqual([])
})

test('fix 1 Escape then the mod Stop: held subagents end with TaskStop, the held request is not sent, and a typed message after does not wake them', async ($, on) => {
  const w = engine(on, 2)
  const get = store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  ends(on)
  const seen = agents(on, [{ id: 'sub-1', status: 'running' }, { id: 'sub-2', status: 'running' }])
  const sent = model(on, w)
  prompts(on)
  await ($ as any).turn.start({ text: 'go', turnId: 'main-1' })
  await ended($, { turnId: 'main-1', isAborted: true, reason: 'aborted', answer: '' })
  const held = request($, { agentId: 'sub-1', model: SONNET })
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'stop' })
  await ui.unmount()
  const r = await held
  expect(r.answer).toBe(STOPPED)
  expect(seen.stops).toEqual(['sub-1', 'sub-2'])
  expect(get('budget')?.isPaused).toBe(true)
  // Fix 4: after the mod's Stop, a typed message ends the stop of the main chat, but the subagents stay ended.
  await say($, 'ok go on')
  expect((await request($, { agentId: 'sub-2', model: SONNET })).answer).toBe(STOPPED)
  expect(sent.length).toBe(0)
})

test('fix 1 Escape: End budget while held lets no held request through', async ($, on) => {
  const w = engine(on, 2)
  store(on, { budget: running({ spent: 2, ownSpend: 2, spawns: SPAWNS }) })
  ends(on)
  agents(on, [{ id: 'sub-1', status: 'running' }])
  const sent = model(on, w)
  await ($ as any).turn.start({ text: 'go', turnId: 'main-1' })
  await ended($, { turnId: 'main-1', isAborted: true, reason: 'aborted', answer: '' })
  const held = request($, { agentId: 'sub-1', model: SONNET })
  await settle()
  await cmd($, 'off')
  expect((await held).answer).toBe(STOPPED)
  expect(sent.length).toBe(0)
})

// ---------- fix 13: the learning memory, end to end ----------

const THREE_OPUS = {
  mode: 'guard',
  items: 0,
  confidence: 'medium',
  unsure: [],
  steps: [
    { name: 'Start 3 helpers', done: 'the 3 parts are written', read: 1, helpers: [{ model: 'opus', n: 3, size: 'm' }] },
    { name: 'Join the parts', done: 'summary.md is saved', read: 3, edit: 1, pages: 1 },
  ],
}

const PAID_TASK =
  'Use the Agent tool to start 3 subagents at the same time, in one message, each with model "opus". Subagent 1 reads note-01.txt to note-04.txt, ' +
  'subagent 2 reads note-05.txt to note-08.txt, subagent 3 reads note-09.txt to note-12.txt. Each subagent reads its files one at a time, then writes a ' +
  'one-paragraph summary of each file into its own file part-N.md, then reads part-N.md back and fixes any mistakes. When all 3 are done, join the parts into summary.md.'

test('dry run of the paid test: the estimate reads the memory, 3 helpers get a high end, and Keep starts the $0.60 limit', async ($, on) => {
  const memRuns = Array.from({ length: 6 }, (_, i) => ({ at: '2026-11-16T10:00:00.000Z', type: 'other', task: `read the notes ${i} and write a summary of each file`, model: OPUS, effort: 'high', cost: 1 + i }))
  const files: Record<string, string> = { 'task-budget-answers.json': JSON.stringify({ dry: ['Keep $0.60'] }) }
  for (const [p, t] of Object.entries(renderAll(memRuns, '2026-11-17T09:00:00.000Z'))) files[`task-budget-memory/${p}`] = t
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(THREE_OPUS), files, hasExists: true })
  const get = store(on)
  prompts(on)
  await say($, `/budget try 0.6 ${PAID_TASK} [tb-test:dry]`)
  await w.clock.advance(400)
  await w.clock.settle()
  const estCall = w.asked.find(a => String(a.prompt ?? '').includes('Count the work of the TASK'))
  expect(String(estCall?.prompt)).toContain('INDEX.md\n# Task Budget memory')
  expect(String(estCall?.prompt)).toContain('types/other.md')
  const b = get('budget')
  expect(b?.limit).toBe(0.6)
  expect(b?.estimate?.helpers).toBe(3)
  expect((b?.estimate?.upTo ?? 0) >= (b?.estimate?.safe ?? 1)).toBe(true)
  expect(bandLineOf(b?.estimate)).toMatch(/^up to \$/)
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-answers.json'))))).toEqual({ dry: [] })
  expect(String(w.files.get(fileAt('task-budget-memory/last-read.json')))).toContain('"other"]')
  logged.push(`dry run: likely ${b?.estimate?.likely} safe ${b?.estimate?.safe} upTo ${b?.estimate?.upTo}`)
  ;(globalThis as { console?: { log: (s: unknown) => void } }).console?.log(logged.at(-1))
})

test('dry run of the paid test as it runs: a fresh chat on Sonnet takes the $1.20 limit and starts', async ($, on) => {
  const memRuns = Array.from({ length: 6 }, (_, i) => ({ at: '2026-11-16T10:00:00.000Z', type: 'other', task: `read the notes ${i} and write a summary of each file`, model: OPUS, effort: 'high', cost: 1 + i }))
  const files: Record<string, string> = { 'task-budget-answers.json': JSON.stringify({ dry2: ['Keep $1.20'] }) }
  for (const [p, t] of Object.entries(renderAll(memRuns, '2026-11-17T09:00:00.000Z'))) files[`task-budget-memory/${p}`] = t
  const w = engine(on, 0, { model: SONNET, tokens: null, answer: JSON.stringify(THREE_OPUS), files, hasExists: true })
  const get = store(on)
  prompts(on)
  await say($, `/budget try 1.2 ${PAID_TASK} [tb-test:dry2]`)
  await w.clock.advance(400)
  await w.clock.settle()
  const b = get('budget')
  logged.push(`dry run fresh sonnet: limit ${b?.limit} likely ${b?.estimate?.likely} safe ${b?.estimate?.safe} upTo ${b?.estimate?.upTo} toasts ${JSON.stringify(w.toasts)}`)
  ;(globalThis as { console?: { log: (s: unknown) => void } }).console?.log(logged.at(-1))
  expect(b?.limit).toBe(1.2)
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-answers.json'))))).toEqual({ dry2: [] })
})

test('a finished task with subagents writes one memory line, with the subagent count and what each one cost', async ($, on) => {
  const files: Record<string, string> = { 'task-budget-answers.json': JSON.stringify({ mem1: ['Keep'] }) }
  const w = engine(on, 0, { model: SONNET, tokens: null, answer: JSON.stringify(THREE_OPUS), files, hasExists: true })
  const get = store(on)
  prompts(on)
  let n = 0
  on('agent.spawn', ((_: unknown, e: any) => {
    n += 1
    return { model: e.model ?? 'inherit', agentId: `sub-${n}` }
  }) as never)
  model(on, w, 0.05)
  await say($, `/budget try 30 ${PAID_TASK} [tb-test:mem1]`)
  await w.clock.advance(400)
  await w.clock.settle()
  expect(get('budget')?.limit).toBe(30)
  await request($, { turnId: 'main-1' })
  for (let i = 0; i < 2; i++) await ($ as any).agent.spawn({ prompt: `part ${i + 1}`, model: 'opus', parentModel: SONNET, fork: false })
  for (const i of [1, 2]) await request($, { agentId: `sub-${i}`, model: SONNET, turnId: `s${i}` })
  await cmd($, 'done')
  await w.clock.advance(400)
  await w.clock.settle()
  await settle()
  const text = String(w.files.get(fileAt('task-budget-memory/runs.jsonl')) ?? '')
  const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const runs = lines.filter(l => !l.lesson)
  const last = runs.at(-1)
  logged.push(`memory line: ${JSON.stringify(last)}`)
  expect(runs.length).toBe(1)
  // Cost $0.15 against a likely $2.94: a miss of 2 times or more, so one lesson line follows.
  expect(lines.filter(l => l.lesson).length).toBe(1)
  expect(last.source).toBe('mod')
  expect(last.subs).toBe(2)
  expect(last.subUsd.length).toBe(2)
  expect(last.subUsd.every((u: number) => u > 0)).toBe(true)
  expect(last.cost > 0).toBe(true)
  expect(String(w.files.get(fileAt('task-budget-memory/runs.jsonl.bak')))).toBe(text)
})

test('a test run typed as the slash command: "try" and the amount never reach Claude (found in the paid test)', async ($, on) => {
  const files: Record<string, string> = { 'task-budget-answers.json': JSON.stringify({ dry4: ['Keep $1.20'] }) }
  const w = engine(on, 0, { model: SONNET, tokens: null, answer: JSON.stringify(THREE_OPUS), files, hasExists: true })
  const get = store(on)
  const sent = prompts(on)
  await cmd($, `try 1.2 ${PAID_TASK} [tb-test:dry4]`)
  await w.clock.advance(400)
  await w.clock.settle()
  expect(get('budget')?.limit).toBe(1.2)
  const task = sent.filter(e => e.origin?.kind === 'plugin')
  expect(task.length).toBe(1)
  expect(task[0].text.startsWith(PAID_TASK.slice(0, 20))).toBe(true)
  expect(/\btry\b|1\.2|tb-test/.test(task[0].text)).toBe(false)
  expect(BUDGET_WORDS.test(task[0].text)).toBe(false)
})

test('dry run of the paid test, real order: a big first request, 3 subagents, one question, and Stop ends all 3 and the main turn', async ($, on) => {
  const memRuns = Array.from({ length: 6 }, (_, i) => ({ at: '2026-11-16T10:00:00.000Z', type: 'other', task: `read the notes ${i} and write a summary of each file`, model: OPUS, effort: 'high', cost: 1 + i }))
  const files: Record<string, string> = { 'task-budget-answers.json': JSON.stringify({ dry3: ['Keep $1.20'] }) }
  for (const [p, t] of Object.entries(renderAll(memRuns, '2026-11-17T09:00:00.000Z'))) files[`task-budget-memory/${p}`] = t
  const w = engine(on, 0, { model: SONNET, tokens: null, answer: JSON.stringify(THREE_OPUS), files, hasExists: true })
  const get = store(on)
  prompts(on)
  const seen = agents(on, [
    { id: 'sub-1', status: 'running' },
    { id: 'sub-2', status: 'running' },
    { id: 'sub-3', status: 'running' },
  ])
  let n = 0
  const spawned: any[] = []
  on('agent.spawn', ((_: unknown, e: any) => {
    spawned.push(e)
    n += 1
    return { model: e.model ?? 'inherit', agentId: `sub-${n}` }
  }) as never)
  const sent = model(on, w, 0)
  await say($, `/budget try 1.2 ${PAID_TASK} [tb-test:dry3]`)
  await w.clock.advance(400)
  await w.clock.settle()
  expect(get('budget')?.limit).toBe(1.2)
  // The answer for the next question: Stop.
  w.files.set(fileAt('task-budget-answers.json'), JSON.stringify({ dry3: ['Stop'] }))
  await ($ as any).turn.start({ text: 'go', turnId: 'main-1' })
  // The first request of a fresh chat costs about $0.75 and asks for 3 subagents on Opus.
  w.usd = 0.75
  // Subagents skip the soft 50% and 80% questions. They wait only near the limit, when the course passes it.
  w.usd = 1.1
  for (let i = 0; i < 3; i++) await ($ as any).agent.spawn({ prompt: `part ${i + 1}`, model: 'opus', parentModel: SONNET, fork: false })
  expect(spawned.map(s => s.model)).toEqual(['sonnet', 'sonnet', 'sonnet'])
  const results = await Promise.all([1, 2, 3].map(i => request($, { agentId: `sub-${i}`, model: SONNET, turnId: `s${i}` })))
  await settle()
  const b = get('budget')
  logged.push(`dry run real order: asks ${JSON.stringify(b?.asks?.map((a: any) => a.answer))} stops ${JSON.stringify(seen.stops)} aborts ${JSON.stringify(seen.aborts)} sent ${sent.length} answers ${JSON.stringify(results.map(r => String(r?.answer ?? '').slice(0, 40)))} `)
  ;(globalThis as { console?: { log: (s: unknown) => void } }).console?.log(logged.at(-1))
  expect(b?.asks?.length).toBe(1)
  expect(seen.stops.sort()).toEqual(['sub-1', 'sub-2', 'sub-3'])
  expect(seen.aborts).toEqual(['main-1'])
})

test('review fix: with no clipboard and no file, the handoff card holds the note and the toast says so', async ($, on) => {
  const w = engine(on, 5.3, { noCopy: true, failWrite: /task-budget-handoff\.md$/ })
  store(on, { budget: running({ isPaused: true, isMidTurn: true, spent: 5.3, ownSpend: 5.3 }) })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'handoff' })
  expect(w.files.has(fileAt('task-budget-handoff.md'))).toBe(false)
  expect(w.toasts).toContain('The copy and the save did not work. The note is in the card in the chat. Open a new chat on Sonnet and paste it.')
  // The last word the person sees is the real result, not "copied".
  expect(w.toasts[w.toasts.length - 1]).toBe('The copy and the save did not work. The note is in the card in the chat. Open a new chat on Sonnet and paste it.')
  expect(w.toasts.some(t => t.startsWith('Handoff note copied'))).toBe(false)
  expect(w.placed.some(id => id.startsWith('hand-b1-'))).toBe(true)
  await ui.unmount()
})

test('review fix: a yes saved before 0.8.1 asks again, and sends no past prompts until then', async ($, on) => {
  const w = engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER), files: { 'task-budget-history.json': JSON.stringify({ runs: [], scan: 'yes' }) } })
  store(on)
  const p = person(on, ['Not now'], 'Not now')
  await cmd($, 'fix the report in the files')
  await w.clock.advance(100)
  await w.clock.settle()
  expect(p.scans.length).toBe(1)
  expect(String(p.scans[0]?.question)).toContain('up to 5 short pieces')
  expect(JSON.parse(String(w.files.get(fileAt('task-budget-history.json')))).scan).toBe('no')
  expect(w.asked.every(a => !String(a.prompt ?? '').includes('PAST TASKS OF THIS USER, WITH REAL COUNTS'))).toBe(true)
})

test('review fix: /budget learn says that estimates send pieces of past prompts', async ($, on) => {
  engine(on, 1.47, { tokens: 100_000, answer: JSON.stringify(ANSWER) })
  store(on)
  const out = await cmd($, 'learn')
  expect(out?.text).toContain('up to 5 short pieces')
})
