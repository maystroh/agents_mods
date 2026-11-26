export type HelperStat = { agents: number; cost: number }

export type Similar = { cost: number; runs: number }

/** guard: Claude sees no dollar numbers. pace: removed in 0.8.0, kept here so old history rows still read. A budget is always guard now. */
export type Mode = 'guard' | 'pace'

/** The kinds of work a task is made of. One tool call is one unit. */
export type Cat = 'read' | 'search' | 'edit' | 'bash' | 'web' | 'agent' | 'browser' | 'mcp' | 'meta' | 'other'

export type Units = Partial<Record<Cat, number>>

/** Helpers a step needs: how many, on which model, and how big each one is. */
export type HelperAsk = { model: string; n: number; size: 's' | 'm' | 'l' }

/** One step of the budget plan: its dollar amount, its check, and what it has used. */
export type PlanStep = {
  name: string
  usd: number
  spent: number
  state: 'pending' | 'active' | 'done' | 'cut'
  /** Whether the stuck question was asked for this step. */
  isWarned: boolean
  /** Added in 0.4.0. The check that says the step is finished. */
  done?: string
  /** What Claude said about the check when it finished the step. */
  check?: 'open' | 'met' | 'unmet'
  /** A scout step does a few items of bulk work, so the rest gets a measured price. */
  scout?: { items: number; total: number }
}

/**
 * The step plan of a budget. The rows add up to the budget:
 * base + every step's usd + reserve = limit.
 * What the reserve has used is not stored: it is the spend no step claimed.
 */
export type Plan = {
  /** asked: Claude must still write it. draft: the person must still approve it. */
  status: 'asked' | 'draft' | 'approved'
  steps: PlanStep[]
  /** The one shared buffer: dollars no step owns. */
  reserve: number
  /** What the budget had spent when the plan was saved. */
  base: number
  /** Whether the person has sent a message since the draft was saved. */
  isHeard: boolean
  /** Added in 0.4.0. Who wrote the plan, and whether Claude marks steps with the step tool. */
  source?: 'estimate' | 'claude' | 'todos'
  byTool?: boolean
  /** Added in 0.7.5. How many steps the mod marked done because Claude did not update its list. */
  ticked?: number
}

/** The cost estimate made before the run. */
export type Estimate = {
  low: number
  likely: number
  safe: number
  kind: string
  mode: Mode
  confidence: 'low' | 'medium' | 'high'
  /** One plain line that says where the numbers come from. */
  basis: string
  /** How many similar past tasks were found, and their median cost. */
  similar: Similar | null
  unsure: string[]
  /** What the estimate itself cost. */
  cost: number
  /** Estimated tool calls, per kind of work. */
  units: Units
  helpers: number
  /** Added in 0.5.0. The band half of such tasks land in: a quarter cost less than the first amount, a quarter cost more than the second. */
  usual?: [number, number]
  /** Added in 0.5.0. Of 100 such tasks in the backtest, how many cost the safe amount or less. */
  hold?: number
  /** Added in 0.7.1. The chat start: the tokens Claude reads before any work, and their dollars. A part of `likely`. */
  base?: { tokens: number; usd: number; /** Added after 0.8.0 (fix 3): the first guess, when the measured start moved the estimate. */ guess?: { tokens: number; usd: number } }
  /** Added in 0.7.1. Dollars added for the advisor, when it ran in half or more of the last tasks. A part of `likely`. */
  advisor?: number
  /** Added in 0.8.0. The default limit is this many times the likely cost. Learned from finished tasks; 1.5 with none. */
  times?: number
  /** Added in 0.8.0. How many finished tasks the multiple was learned from. */
  timesN?: number
  /** Added in 0.8.0. The predicted cost of the mod's own model calls for this task. A part of `likely`. */
  mod?: number
  /** Added in the subagent fixes (fix 13). The high end of a big task, from the money tail of its type. The start line says "up to" it, and the default limit is set from it. */
  upTo?: number
}

/** Added in 0.7.0. A model family and an effort level that the requests of a task run on. */
export type Route = { model: string; effort: string }

/** A question the mod must ask at the next request. `near` (0.7.0): 80% of the limit is spent and the task is on course to pass it. */
/** Changed in 0.8.0: early (the 50% pause) replaces forecast, and stuck is gone. live() drops an old kind. */
export type Ask = { kind: 'early' | 'small' | 'near'; step?: number }

/** One item of Claude's own task list, as the mod last saw it. */
export type Todo = { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** One running budget. `v` marks the shape: a value an older version stored is upgraded by `live()`. */
export type Budget = {
  v: 3
  id: string
  limit: number
  startCost: number
  ownSpend: number
  spent: number
  isPaused: boolean
  isMidTurn: boolean
  task: string
  model: string
  isFresh: boolean
  messages: number
  steps: number
  lastStep: number
  ctxTokens: number
  delta: number
  mainCost: number
  msgStart: number
  bars: number[]
  helpers: Record<string, HelperStat>
  seen: string[]
  similar: Similar | null
  plan: Plan | null
  /** A task given with /budget that has not reached Claude yet. */
  pending: string
  /** The size of the first request of this chat in tokens, as estimated at the start. 0 when not a new chat. */
  firstTokens: number
  /** Added in 0.4.0. */
  mode: Mode
  estimate: Estimate | null
  /** run: normal. landing: the person chose to finish now, so new tool calls are refused. */
  phase: 'run' | 'landing'
  /** The question that waits for the next request, if any. */
  ask: Ask | null
  /** The limit at which the forecast question was last asked, so it is not asked twice. */
  askedAt: number
  /** What the person is being asked right now, shown in the band. Empty when nothing waits. */
  waiting: string
  /** Hidden notes for Claude. Always empty since 0.8.0: Claude never sees the budget. Kept so old values read. */
  notes: string[]
  todos: Todo[]
  /** Added in 0.7.3. The tool that keeps Claude's task list in this chat. A second list tool does not replace the list. */
  todoTool?: string
  /** Real tool calls of this run, per kind of work. */
  used: Units
  /** When the last request ended, in ms, and on which model. For the cold cache price. */
  lastAt: number
  lastModel: string
  startedAt: number
  /** Dollars the person added to the limit after the start. */
  raised?: number
  /** A test token: gate answers then come from a file, not from a dialog. */
  test?: string
  /** Added in 0.5.0. The person chose Keep going: the limit stops nothing now, and the count runs on. */
  isOpen?: boolean
  /** Added in 0.5.0. What the first task of this budget cost: the task the estimate was made for. Set when Claude gives its answer. */
  firstCost?: number
  /** Added in 0.7.0. Track only: the task has an estimate and a live count, and no limit. */
  isTrack?: boolean
  /** The person took the advice: every main chat request of this task runs on this model and effort level. */
  route?: Route
  /** The effort level the task runs at. */
  effort?: string
  /** What a small model said when it read the chat: the share of the work that is done, the spend then, and the cost the whole task is on course for. */
  left?: { part: number; at: number; usd: number; step?: number }
  /** Added in 0.7.1. The last tool calls of the main chat, one short line each. The small model reads them. */
  calls?: string[]
  /** Added in 0.7.1. The spend at the last read of the chat. */
  readAt?: number
  /** Added in 0.7.1. What the chat start cost: the first requests, which wrote most of the chat to the cache. */
  load?: { tokens: number; usd: number; /** Added after 0.8.0 (fix 3): the late big write of a new chat was added. */ isJumped?: boolean; /** Added after 0.8.0 (fix 3): the start is final. */ isSettled?: boolean }
  /** How many times the small model has read the chat for this task. */
  checks?: number
  /** Added in 0.8.0. The spend when Claude last moved a step in its own task list. */
  todosAt?: number
  /** Added in 0.8.0. Claude moved a step in its task list, so the small model reads the chat at the next request. */
  isStepNew?: boolean
  /** Added in 0.8.0. What the mod's own model calls cost for this run: the estimate, the advice, the size check and the reads of the chat. A part of `spent`. */
  modCost?: number
  /** The first skill the task used, when it used one. */
  skill?: string
  /** The limit at which the 80% pause was last asked, so it is not asked twice. */
  nearAt?: number
  /** Added in 0.8.0. The 50% pause was asked. It comes one time in a task. */
  isEarlyAsked?: boolean
  /** Added in 0.8.0. The person chose Hand off: the chat stopped, and the note is on the clipboard. */
  isHandedOff?: boolean
  /** Added in 0.8.0 (subagent fixes). The subagents this budget let start: the expected cost of each, what it used, and if it is still running. */
  spawns?: Spawn[]
  /** Added in 0.8.0 (subagent fixes). No new money question until the spend reaches this amount (about 10% of the limit after an answer). */
  quietTo?: number
  /** Added in 0.8.0 (subagent fixes). Every question the mod asked in this task. */
  asks?: AskLog[]
  /** Added in 0.8.0 (subagent fixes). How many times the task was estimated again because it grew. */
  regrows?: number
  /** Added in 0.8.0 (subagent fixes). The one question for a task that grew past the limit was asked. */
  isGrowAsked?: boolean
  /** Added after 0.8.0. The cost path: [share done, spend] at each step move in Claude's task list and at each read of the chat. */
  path?: [number, number][]
  /** Added after 0.8.0. The spend when each step of Claude's task list started, by its place in the list. */
  stepAt?: number[]
  /** Added after 0.8.0. How tasks of this type spend, from the learning memory: the forecast mixes it in. */
  typePath?: TypePath
  /** Added after 0.8.0. The pause point of this type: 1, or a little more after false alarms. The limit itself never moves. */
  ease?: number
}

/** Added after 0.8.0. The middle share of the work cost spent by 25%, 50% and 75% done, from `n` finished runs of a type. */
export type TypePath = { n: number; q: [number, number, number]; steps?: Record<string, number[]> }

/** Added in 0.8.0 (subagent fixes). One subagent this budget let start. `usd` is what such a subagent usually costs on its model. */
export type Spawn = { id: string; model: string; usd: number; used: number; isRunning: boolean; isExtra: boolean }

/** Added in 0.8.0 (subagent fixes). One question the mod asked: its kind, the spend and the limit then, the answer, and the time. */
export type AskLog = { kind: string; spent: number; limit: number; answer: string; at: string; /** Added after 0.8.0. The cost the task was on course for. */ course?: number }

/** One step of a finished budget, as the report shows it. */
export type RunStep = { name: string; usd: number; spent: number; check: string }

/** One finished or still open budget, as the history file keeps it. */
export type Run = {
  id: string
  at: string
  task: string
  limit: number
  spent: number
  messages: number
  model: string
  outcome: 'open' | 'ended' | 'stopped' | 'replaced' | 'under' | 'over' | 'abandoned'
  /** Added in 0.8.0. What the mod's own model calls cost for this run. */
  mod?: number
  /** Added in 0.8.0. The whole bill of the chat when the run closed, the mod's calls included. */
  session?: number
  /** Added in 0.4.0. */
  mode?: Mode
  kind?: string
  estimate?: { low: number; likely: number; safe: number; usual?: [number, number]; hold?: number; base?: { tokens: number; usd: number; /** Added after 0.8.0: the guess, when the first request measured the start. */ guess?: { tokens: number; usd: number } }; upTo?: number }
  steps?: RunStep[]
  /** Added in 0.5.0. What the first task cost: the number that is compared with the estimate. */
  first?: number
  /** Added in 0.7.5. How many steps the mod marked done because Claude did not update its list. */
  ticked?: number
  /** Added in 0.5.0. The person chose Keep going, so the limit stopped nothing. */
  isOpen?: boolean
  /** Added in 0.5.0. The estimate ratio has learned from this run. A run teaches it one time. */
  learned?: boolean
  /** Added in 0.7.0. The effort level the task ran at. */
  effort?: string
  /** Why the real cost was far from the estimate: more steps, fewer steps, more thinking, helpers or search. Not set for a hit. */
  why?: string
  /** How long the task ran, in seconds. */
  secs?: number
  /** The first skill the task used. */
  skill?: string
  /** The task had no limit from the start. */
  isTrack?: boolean
  /** Added in 0.7.2. Where the money went: the chat start, the work, the helpers. */
  parts?: { name: string; usd: number }[]
  /** Added in 0.7.2. The tokens of the chat at the start of the task. */
  loadTokens?: number
  /** Added in 0.8.0 (subagent fixes). How many subagents the task started, and the model they ran on. */
  agents?: number
  agentModel?: string
  /** Added in 0.8.0 (subagent fixes). Every question the mod asked in this task. */
  asks?: AskLog[]
  /** Added after 0.8.0. The cost path, the spend at each step start, and what the chat start cost. */
  path?: [number, number][]
  stepAt?: number[]
  start?: number
}

/** Added in 0.7.0. What the scan of the last days found: how this person works. */
export type Profile = {
  days: number
  tasks: number
  usd: number
  kinds: { kind: string; n: number; p50: number; usd: number }[]
  models: { name: string; n: number; usd: number }[]
  efforts: { name: string; n: number }[]
}

/** A row the mod places in the chat. */
export type Card =
  | { kind: 'stop'; spent: number; limit: number }
  | { kind: 'estimate'; task: string; estimate: Estimate; steps: { name: string; usd: number }[]; /** Added in 0.7.0. The model and effort level the estimate is priced for. */ route?: Route }
  | { kind: 'report'; run: Run }
  | { kind: 'profile'; profile: Profile }
  /** Added in 0.8.0. The hand off: the note, the model to open, and whether the copy worked. */
  | { kind: 'handoff'; note: string; model: string; isCopied: boolean; file: string; isPanel?: boolean }

/** What the panel shows about the price book. */
export type BookView = {
  state: 'none' | 'reading' | 'ready'
  files: number
  tasks: number
  note: string
  kinds: { kind: string; n: number; p25: number; p50: number; p90: number }[]
  /** Median real cost over estimate, and how many finished budgets it comes from. */
  /** `last` and `in2` (0.7.0): of the last estimates (20 at most), how many had a real cost inside 2 times. */
  score: { n: number; ratio: number; inRange: number; last?: number; in2?: number } | null
  /** Added in 0.7.0. The last finished tasks that had an estimate, newest first, 3 at most. */
  recent?: Run[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-budget': {
      budget: Budget | null
      history: Run[]
      stops: Record<string, Card>
      book: BookView | null
      /** Added in 0.7.2. The task that finished last in this chat: the panel keeps its summary. */
      last: Run | null
    }
  }
}
