// The price book: what this person's past tasks really cost.
// Pure code, no engine calls: it reads transcript text and adds it to a book.
// The book holds measured sizes in tokens, so any model's prices can be put on them.

import type { Cat, HelperAsk, Units } from '../types'

export const CATS: Cat[] = ['read', 'search', 'edit', 'bash', 'web', 'agent', 'browser', 'mcp', 'meta', 'other']

export type Fam = 'haiku' | 'sonnet' | 'opus' | 'fable'
export const FAMS: Fam[] = ['haiku', 'sonnet', 'opus', 'fable']

/** Dollars for one million tokens: fresh input, output, cache read, cache write for one hour, cache write for five minutes. */
export type Price = { in: number; out: number; cr: number; w1: number; w5: number }

// Fitted on 2026-11-13 against the engine's own cost ledgers in 2,711 transcripts.
// Opus 5.5, Sonnet 5.5, Haiku 4.5 and Opus 5 match their ledgers to the cent. Fable 5.2 is within 2%.
// The first entry whose name opens the model id wins.
const TABLE: [string, Price][] = [
  ['claude-opus-5-5', { in: 4, out: 20, cr: 0.2, w1: 8, w5: 5 }],
  ['claude-opus', { in: 5, out: 25, cr: 0.5, w1: 10, w5: 6.25 }],
  ['claude-sonnet-5-5', { in: 2, out: 10, cr: 0.1, w1: 4, w5: 2.5 }],
  ['claude-sonnet', { in: 2, out: 10, cr: 0.2, w1: 4, w5: 2.5 }],
  ['claude-haiku-4', { in: 1, out: 5, cr: 0.1, w1: 2, w5: 1.25 }],
  ['claude-haiku', { in: 0.1, out: 0.5, cr: 0.01, w1: 0.2, w5: 0.125 }],
  ['claude-fable-5-2', { in: 8, out: 40, cr: 0.2, w1: 16, w5: 6 }],
  ['claude-fable', { in: 8, out: 40, cr: 0.4, w1: 16, w5: 10 }],
]
const NEWEST: Record<Fam, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-2',
}
/** One web search, in dollars. */
export const SEARCH_FEE = 0.01

export function family(model: string | undefined): Fam {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  return 'opus'
}

/** The price line of a model. `promptTokens` picks Haiku 5's higher tier above 100,000 tokens. */
export function priceFor(model: string | undefined, promptTokens = 0, k = 1): Price {
  let id = (model ?? '').toLowerCase().replace(/\[.*$/, '')
  if (!id.startsWith('claude-')) id = NEWEST[family(id)]
  let p: Price = { in: 4, out: 20, cr: 0.2, w1: 8, w5: 5 }
  for (const [name, price] of TABLE) {
    if (id.startsWith(name)) {
      p = price
      break
    }
  }
  const tier = id.startsWith('claude-haiku-5') && promptTokens > 100_000 ? 5 : 1
  const f = tier * k
  return f === 1 ? p : { in: p.in * f, out: p.out * f, cr: p.cr * f, w1: p.w1 * f, w5: p.w5 * f }
}

export type Tokens = { in: number; out: number; cr: number; w1: number; w5: number; ws?: number }

export function costOf(t: Tokens, model: string | undefined, k = 1): number {
  const p = priceFor(model, t.in + t.cr + t.w1 + t.w5, k)
  return (t.in * p.in + t.out * p.out + t.cr * p.cr + t.w1 * p.w1 + t.w5 * p.w5) / 1_000_000 + (t.ws ?? 0) * SEARCH_FEE
}

/** The kind of work a tool call is. */
export function cat(name: string): Cat {
  if (name === 'Read' || name === 'NotebookRead') return 'read'
  if (name === 'Grep' || name === 'Glob' || name === 'LS' || name === 'ToolSearch') return 'search'
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell' || name === 'KillBash' || name === 'Monitor') return 'bash'
  if (name === 'WebSearch' || name === 'WebFetch') return 'web'
  if (name === 'Agent' || name === 'Task' || name === 'Workflow') return 'agent'
  if (/^mcp__(Claude_Browser|claude-in-chrome|computer-use|Control_Chrome|remote-devices)/.test(name)) return 'browser'
  if (
    /^(mcp__ccd_|mcp__helper-desk|mcp__task-budget|Task[A-Z])/.test(name) ||
    ['TodoWrite', 'Skill', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'SendMessage', 'ScheduleWakeup', 'SendUserFile', 'ListAgents'].includes(name)
  ) {
    return 'meta'
  }
  if (name.startsWith('mcp__')) return 'mcp'
  return 'other'
}

// ---------- reading one transcript ----------

export type Req = {
  t: number
  model: string
  in: number
  out: number
  cr: number
  cw: number
  w1: number
  w5: number
  ws: number
  side: boolean
  tools: [string, string][]
  /** The advisor: its dollars and its calls. It reads the chat again on its own model, and no row of its own holds it. */
  adv: number
  an: number
  /** The effort level the request ran at, or '' when the row does not say. */
  effort: string
}
/** isPeer: another Claude session sent the message. It can start a task, see turnsOf. */
export type Prompt = { t: number; isHuman: boolean; text: string; isPeer?: boolean }
/** The engine's own cost count of a session, per model: its dollars, and this book's dollars for the same tokens. */
export type Ledger = Record<string, { usd: number; mine: number; isSplit: boolean }>
export type Scan = { reqs: Map<string, Req>; prompts: Prompt[]; ledger: Ledger | null }

export function newScan(): Scan {
  return { reqs: new Map(), prompts: [], ledger: null }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const c of content as unknown[]) {
    const o = obj(c)
    if (o.type === 'text' && typeof o.text === 'string') parts.push(o.text)
  }
  return parts.join('\n')
}

/** The words a person typed, with the engine's own notes cut out. Empty when the line is not a task. */
export function cleanPrompt(raw: string): string {
  let t = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (t.startsWith('<local-command') || t.startsWith('[Request interrupted') || t.startsWith('<task-notification')) return ''
  const cmd = t.match(/<command-name>\/?([^<]*)<\/command-name>/)
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)
    t = `/${(cmd[1] ?? '').trim()} ${(args?.[1] ?? '').trim()}`.trim()
  }
  return t
}

/**
 * The advisor calls in the `iterations` of one usage block: their dollars and their count.
 * The top of the usage block holds only the chat model's own tokens, so the advisor is added from here.
 */
function advisorOf(iterations: unknown): { adv: number; an: number } {
  let adv = 0
  let an = 0
  if (!Array.isArray(iterations)) return { adv, an }
  for (const it of iterations as unknown[]) {
    const o = obj(it)
    if (o.type !== 'advisor_message') continue
    const w5 = num(obj(o.cache_creation).ephemeral_5m_input_tokens)
    const w1 = Math.max(0, num(o.cache_creation_input_tokens) - w5)
    adv += costOf({ in: num(o.input_tokens), out: num(o.output_tokens), cr: num(o.cache_read_input_tokens), w1, w5 }, typeof o.model === 'string' ? o.model : undefined)
    an += 1
  }
  return { adv, an }
}

function putReq(
  scan: Scan,
  id: string,
  f: {
    t: number
    model: string
    side: boolean
    in: number
    out: number
    cr: number
    cw: number
    w1: number
    w5: number
    ws: number
    adv?: number
    an?: number
    effort?: string
  },
  tools: [string, string][],
): void {
  let r = scan.reqs.get(id)
  if (!r) {
    let w1 = f.w1
    if (w1 + f.w5 === 0 && f.cw > 0) w1 = f.cw
    r = { ...f, w1, tools: [], adv: f.adv ?? 0, an: f.an ?? 0, effort: f.effort ?? '' }
    scan.reqs.set(id, r)
  } else {
    if (f.out > r.out) r.out = f.out
    if ((f.adv ?? 0) > r.adv) {
      r.adv = f.adv ?? 0
      r.an = f.an ?? 0
    }
    if (!r.effort && f.effort) r.effort = f.effort
  }
  for (const tool of tools) r.tools.push(tool)
}

function putPrompt(scan: Scan, t: number, isHuman: boolean, raw: string, isPeer = false): void {
  const text = cleanPrompt(raw)
  if (!text) return
  if (isPeer) scan.prompts.push({ t, isHuman, text: text.slice(0, 400), isPeer })
  else scan.prompts.push({ t, isHuman, text: text.slice(0, 400) })
}

const PEER_OPEN = /<cross-session-message\b[^>]*>\n?/
const PEER_CLOSE = '</cross-session-message>'
/** How a line starts, as saved text, when another Claude session sent the message. */
const PEER_HEAD = '"content":"Another Claude session sent a message:\\n<cross-session-message'

/**
 * The words of a message that another Claude session sent. The engine puts a wrapper around them and its own note after them.
 * Empty when the text is no such message. The report of a helper has another wrapper, so it gives nothing.
 */
export function peerWords(raw: string): string {
  const open = PEER_OPEN.exec(raw)
  if (!open) return ''
  const rest = raw.slice(open.index + open[0].length)
  const end = rest.lastIndexOf(PEER_CLOSE)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

/** A tool that sends work or words to another session or to a helper. An answer can come back as a message. */
export function talksOut(name: string): boolean {
  return name === 'Agent' || name === 'Task' || name === 'Workflow' || name === 'SendMessage' || /start_session|hand_off_to_session|send_message|send_to_chat|new_chat/.test(name)
}

function isHumanPrompt(kind: unknown, promptSource: unknown, isSidechain: boolean): boolean {
  return kind === 'human' || (kind === undefined && promptSource !== 'system' && !isSidechain)
}

/** The mark that opens a line the stream filter has cut: its head, what it found in the middle, and its tail. */
const CUT = '\u0001'
const SEP = '\u0002'

/**
 * The filter that makes a big transcript small enough to read. It is an awk program, so it needs no install.
 * It drops tool results and request dumps, which are most of the bytes and hold nothing the book needs.
 * A line that is still long is cut to its head, its tool calls, its usage block and its tail.
 * The usage block is found by name: a tool call line holds a second copy of the tool input after it.
 * A long message from another session has its time in the middle of the line, so the time is added at the end.
 * An advisor call sits far into the usage block, so each one is added as a last field.
 */
export const AWK_FILTER = [
  '/^\\{"type":"api-request/ { next }',
  'index($0, "\\"tool_use_id\\"") { next }',
  'length($0) <= 20000 { print; next }',
  '{',
  '  s = $0; x = ""',
  '  while (match(s, /"type":"tool_use","id":"[^"]*","name":"[^"]*"/)) {',
  '    x = x substr(s, RSTART, RLENGTH) ";"',
  '    s = substr(s, RSTART + RLENGTH)',
  '  }',
  '  if (x == "") {',
  '    s = $0; n = 0',
  '    while (n < 6 && match(s, /"type":"text","text":"/)) {',
  '      x = x substr(s, RSTART + RLENGTH, 500) "\\003"',
  '      s = substr(s, RSTART + RLENGTH); n++',
  '    }',
  '  }',
  '  a = ""; s = $0',
  '  while (match(s, /"type":"advisor_message","model":"[^"]*"/)) {',
  '    b = RSTART - 260; if (b < 1) b = 1',
  '    a = a substr(s, b, RSTART + RLENGTH - b) "\\003"',
  '    s = substr(s, RSTART + RLENGTH)',
  '  }',
  '  u = index($0, "\\"usage\\":{\\"input_tokens\\"")',
  '  ts = ""',
  '  if (index($0, "<cross-session-message") && match($0, /"timestamp":"[^"]*"/)) ts = substr($0, RSTART, RLENGTH)',
  '  printf "\\001%s\\002%s\\002%s\\002%s\\002%s\\002%s\\n", substr($0, 1, 1500), x, (u ? substr($0, u, 900) : ""), substr($0, length($0) - 2500), ts, a',
  '}',
].join('\n')

function unescape(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/** A line the filter has cut. It is not whole JSON any more, so the fields are found by their names. */
function addCut(scan: Scan, line: string): void {
  const [head = '', mid = '', us = '', tail = '', ts = '', advs = ''] = line.slice(1).split(SEP)
  const t = Date.parse(/"timestamp":"([^"]+)"/.exec(tail)?.[1] ?? '') || 0
  const side = head.includes('"isSidechain":true')
  if (head.includes('"role":"assistant"') || tail.includes('"type":"assistant"')) {
    const model = /"model":"([^"]+)"/.exec(head)?.[1] ?? ''
    const id = /"id":"(msg_[^"]+)"/.exec(head)?.[1] ?? /"uuid":"([^"]+)"/.exec(tail)?.[1] ?? ''
    if (!us || !id || !model || model === '<synthetic>') return
    const n = (name: string): number => Number(new RegExp(`"${name}":(\\d+)`).exec(us)?.[1] ?? 0)
    const tools: [string, string][] = []
    for (const m of mid.matchAll(/"type":"tool_use","id":"([^"]*)","name":"([^"]*)"/g)) tools.push([m[2] ?? '', m[1] ?? ''])
    let adv = 0
    let an = 0
    for (const chunk of advs.split('\u0003')) {
      // The chunk can start in the request before the advisor's: its own numbers start at the last opening.
      const at = chunk.lastIndexOf('{"input_tokens"')
      if (at < 0) continue
      const piece = chunk.slice(at)
      const g = (name: string): number => Number(new RegExp(`"${name}":(\\d+)`).exec(piece)?.[1] ?? 0)
      const w5 = g('ephemeral_5m_input_tokens')
      const w1 = Math.max(0, g('cache_creation_input_tokens') - w5)
      adv += costOf({ in: g('input_tokens'), out: g('output_tokens'), cr: g('cache_read_input_tokens'), w1, w5 }, /"model":"([^"]+)"/.exec(piece)?.[1])
      an += 1
    }
    putReq(
      scan,
      id,
      {
        t,
        model,
        side,
        adv,
        an,
        effort: /"effort":"([a-z]+)"/.exec(tail)?.[1] ?? '',
        in: n('input_tokens'),
        out: n('output_tokens'),
        cr: n('cache_read_input_tokens'),
        cw: n('cache_creation_input_tokens'),
        w1: n('ephemeral_1h_input_tokens'),
        w5: n('ephemeral_5m_input_tokens'),
        ws: n('web_search_requests'),
      },
      tools,
    )
    return
  }
  if (!head.includes('"type":"user"')) return
  if (head.includes(PEER_HEAD)) {
    // A message from another Claude session. Its own fields are in the middle of the line, which the filter cut out.
    const at = Date.parse(/"timestamp":"([^"]+)"/.exec(ts)?.[1] ?? '') || t
    const said = peerWords(unescape(/"content":"((?:[^"\\]|\\.)*)/.exec(head)?.[1] ?? ''))
    if (said && at > 0 && !side) putPrompt(scan, at, false, said, true)
    return
  }
  const both = head + tail
  if (both.includes('"isMeta":true') || both.includes('"isCompactSummary":true') || both.includes('"isVisibleInTranscriptOnly":true')) return
  const kind = /"origin":\{"kind":"([^"]+)"/.exec(tail)?.[1]
  const source = /"promptSource":"([^"]+)"/.exec(tail)?.[1]
  // The text is the string content, or the first text block that is the person's own words.
  const typed = /"content":"((?:[^"\\]|\\.)*)/.exec(head)?.[1]
  const blocks = typed === undefined ? mid.split('\u0003') : [typed]
  let text = ''
  for (const block of blocks) {
    const own = cleanPrompt(unescape(/^(?:[^"\\]|\\.)*/.exec(block)?.[0] ?? ''))
    if (own && !own.startsWith('<')) {
      text = own
      break
    }
  }
  putPrompt(scan, t, isHumanPrompt(kind, source, side), text || '(a long message)')
}

function addLine(scan: Scan, line: string): void {
  if (line.startsWith(CUT)) {
    addCut(scan, line)
    return
  }
  if (line.startsWith('{"type":"cost-state"')) {
    try {
      const usage = obj(obj(JSON.parse(line)).modelUsage)
      const ledger: Ledger = {}
      for (const [model, row] of Object.entries(usage)) {
        const u = obj(row)
        const w1 = num(u.cacheCreationEphemeral1hInputTokens)
        const w5 = num(u.cacheCreationEphemeral5mInputTokens)
        const tokens = { in: num(u.inputTokens), out: num(u.outputTokens), cr: num(u.cacheReadInputTokens), w1, w5, ws: num(u.webSearchRequests) }
        // The price is put on the ledger's own token counts: a ledger can cover less than the whole transcript.
        const p = priceFor(model)
        const mine = (tokens.in * p.in + tokens.out * p.out + tokens.cr * p.cr + w1 * p.w1 + w5 * p.w5) / 1_000_000 + tokens.ws * SEARCH_FEE
        ledger[model] = { usd: num(u.costUSD), mine, isSplit: Math.abs(w1 + w5 - num(u.cacheCreationInputTokens)) <= 50 }
      }
      scan.ledger = ledger
    } catch {
      // a cut line
    }
    return
  }
  const head = line.length > 600 ? line.slice(0, 600) : line
  const tail = line.length > 2500 ? line.slice(-2500) : line
  if (head.includes('"role":"assistant"') || tail.includes('"type":"assistant"')) {
    let o: Record<string, unknown>
    try {
      o = obj(JSON.parse(line))
    } catch {
      return
    }
    if (o.type !== 'assistant') return
    const m = obj(o.message)
    const u = obj(m.usage)
    if (!m.usage || m.model === '<synthetic>') return
    const cc = obj(u.cache_creation)
    const advisor = advisorOf(u.iterations)
    const tools: [string, string][] = []
    if (Array.isArray(m.content)) {
      for (const c of m.content as unknown[]) {
        const b = obj(c)
        if (b.type === 'tool_use' && typeof b.name === 'string') tools.push([b.name, String(b.id ?? '')])
      }
    }
    putReq(
      scan,
      typeof m.id === 'string' ? m.id : String(o.uuid ?? ''),
      {
        t: Date.parse(String(o.timestamp ?? '')) || 0,
        model: String(m.model ?? ''),
        side: o.isSidechain === true,
        in: num(u.input_tokens),
        out: num(u.output_tokens),
        cr: num(u.cache_read_input_tokens),
        cw: num(u.cache_creation_input_tokens),
        w1: num(cc.ephemeral_1h_input_tokens),
        w5: num(cc.ephemeral_5m_input_tokens),
        ws: num(obj(u.server_tool_use).web_search_requests),
        adv: advisor.adv,
        an: advisor.an,
        effort: typeof o.effort === 'string' ? o.effort : '',
      },
      tools,
    )
    return
  }
  if ((head.includes('"type":"user"') || tail.includes('"type":"user"')) && !line.includes('"tool_use_id"')) {
    let o: Record<string, unknown>
    try {
      o = obj(JSON.parse(line))
    } catch {
      return
    }
    if (o.type !== 'user' || o.isCompactSummary || o.isVisibleInTranscriptOnly) return
    const content = obj(o.message).content
    const origin = obj(o.origin)
    if (origin.kind === 'peer') {
      // A message from another Claude session. The engine saves it as a note of its own, but it can start a task.
      const said = peerWords(textOf(content))
      const body = typeof origin.body === 'string' && origin.body.trim() ? origin.body : said
      if (said && o.isSidechain !== true) putPrompt(scan, Date.parse(String(o.timestamp ?? '')) || 0, false, body, true)
      return
    }
    if (o.isMeta) return
    const raw = textOf(content) || (Array.isArray(content) ? '(a picture)' : '')
    putPrompt(scan, Date.parse(String(o.timestamp ?? '')) || 0, isHumanPrompt(origin.kind, o.promptSource, o.isSidechain === true), raw)
  }
}

/** Add transcript text to a scan. The text must end at a line end. */
export function ingest(scan: Scan, text: string): void {
  let i = 0
  const n = text.length
  while (i < n) {
    let j = text.indexOf('\n', i)
    if (j < 0) j = n
    if (j - i > 20) addLine(scan, text.slice(i, j))
    i = j + 1
  }
}

/** A scan that takes its text in pieces, as a stream gives them. */
export type Feed = { scan: Scan; parts: string[] }

export function newFeed(): Feed {
  return { scan: newScan(), parts: [] }
}

export function feed(f: Feed, piece: string): void {
  const cut = piece.lastIndexOf('\n')
  if (cut < 0) {
    f.parts.push(piece)
    return
  }
  f.parts.push(piece.slice(0, cut))
  ingest(f.scan, f.parts.join(''))
  f.parts = [piece.slice(cut + 1)]
}

export function feedEnd(f: Feed): Scan {
  if (f.parts.length > 0) ingest(f.scan, f.parts.join(''))
  f.parts = []
  return f.scan
}

function tokensOf(r: Req): Tokens {
  return { in: r.in, out: r.out, cr: r.cr, w1: r.w1, w5: r.w5, ws: r.ws }
}

// ---------- tasks ----------

/** One past task: from one typed prompt to the next. Sizes in tokens, cost in dollars at the prices of its day. */
export type Turn = {
  t: number
  text: string
  /** Main chat dollars, helper dollars, helper count. */
  usd: number
  hu: number
  h: number
  reqs: number
  /** Tool calls per kind of work, in CATS order. */
  n: number[]
  /** Context at the start, tokens written warm, tokens written cold, output tokens. */
  ctx: number
  w: number
  cold: number
  out: number
  ws: number
  model: string
  kind: string
  /** Advisor dollars (a part of `usd`), advisor calls, and the effort level of the first request. */
  adv?: number
  an?: number
  effort?: string
}

/** What kind of task a mix of tool calls is. The same rule names an estimate and a past task. */
export function kindOf(n: readonly number[], helpers: number): string {
  const at = (c: Cat): number => n[CATS.indexOf(c)] ?? 0
  const total = CATS.reduce((sum, c) => sum + (c === 'meta' ? 0 : at(c)), 0)
  if (total === 0) return 'chat'
  if (helpers >= 2 || at('agent') >= 2) return 'delegate'
  if (at('browser') / total >= 0.3) return 'browser'
  if (at('web') / total >= 0.3 || at('web') >= 5) return 'research'
  if (at('edit') >= 3 && (at('edit') + at('bash')) / total >= 0.4) return 'build'
  if (at('edit') >= 1) return 'edit'
  if (at('mcp') / total >= 0.4) return 'connector'
  if (at('bash') / total >= 0.5) return 'ops'
  return 'explore'
}

export const KIND_LABEL: Record<string, string> = {
  chat: 'Question, no tools',
  explore: 'Read and look around',
  edit: 'Small edit',
  build: 'Build or change files',
  research: 'Web research',
  browser: 'Browser work',
  connector: 'Connector work',
  ops: 'Commands',
  delegate: 'Work with helpers',
}

/** A helper of a session: when its first request ran, and what the whole helper cost. */
export type HelperRun = { t: number; usd: number }

/** Cut one scanned transcript into tasks. A helper's dollars go to the task that was running when the helper started. */
export function turnsOf(scan: Scan, helpers: readonly HelperRun[], k: Record<string, number>): Turn[] {
  type Ev = { t: number; p?: Prompt; r?: Req; h?: number }
  const evs: Ev[] = []
  for (const p of scan.prompts) evs.push({ t: p.t, p })
  for (const r of scan.reqs.values()) evs.push({ t: r.t, r })
  for (const h of helpers) evs.push({ t: h.t, h: h.usd })
  evs.sort((a, b) => a.t - b.t)
  const agentAt = CATS.indexOf('agent')
  const out: Turn[] = []
  let cur: Turn | null = null
  // True when the task has sent work or words to another session or to a helper.
  let hasTalked = false
  const close = (): void => {
    if (cur && cur.reqs > 0) {
      cur.h = Math.max(cur.h, cur.n[agentAt] ?? 0)
      cur.kind = kindOf(cur.n, cur.h)
      out.push(cur)
    }
    cur = null
  }
  for (const ev of evs) {
    if (ev.p) {
      // A message from another Claude session starts a task. It does not when it can be the answer to this task's own call.
      if (!ev.p.isHuman && !(ev.p.isPeer === true && !hasTalked)) continue
      close()
      hasTalked = false
      cur = { t: ev.t, text: ev.p.text, usd: 0, hu: 0, h: 0, reqs: 0, n: CATS.map(() => 0), ctx: 0, w: 0, cold: 0, out: 0, ws: 0, model: '', kind: '', adv: 0, an: 0, effort: '' }
      continue
    }
    if (ev.h !== undefined) {
      if (cur) {
        cur.hu += ev.h
        cur.h += 1
      }
      continue
    }
    const r = ev.r
    if (!r || !cur) continue
    const cost = costOf(tokensOf(r), r.model, k[family(r.model)] ?? 1)
    if (r.side) {
      cur.hu += cost + r.adv
      continue
    }
    const ctx = r.in + r.cr + r.cw
    cur.reqs += 1
    cur.usd += cost + r.adv
    cur.adv = (cur.adv ?? 0) + r.adv
    cur.an = (cur.an ?? 0) + r.an
    cur.out += r.out
    cur.ws += r.ws
    if (cur.ctx === 0) {
      cur.ctx = ctx
      cur.model = r.model
      cur.effort = r.effort
    }
    if (r.cr >= 0.5 * ctx) cur.w += r.cw + r.in
    else cur.cold += r.cw + r.in
    for (const [name] of r.tools) {
      const i = CATS.indexOf(cat(name))
      cur.n[i] = (cur.n[i] ?? 0) + 1
      if (talksOut(name)) hasTalked = true
    }
  }
  close()
  return out
}

// ---------- the book ----------

const K = CATS.length + 1
const CAP_TURNS = 500
const CAP_SAMPLES = 400
/** How many task start times the book keeps, to know a task it has counted. */
const CAP_DONE = 8000
/** A task with more tool calls than this does not set the unit sizes: a few giants would. */
const FIT_MAX_CALLS = 150

export type Book = {
  v: 3
  builtAt: number
  files: number
  bytes: number
  tasks: number
  /** Dollars of every task the book has counted, at list prices. */
  usd: number
  skipped: number
  /** The newest and oldest file time the book has read, in ms. */
  newest: number
  oldest: number
  /**
   * Per session file: its change time when the book read it, and the start of the last task counted.
   * A file that has not changed is not read again. A file that has grown adds only its new tasks.
   */
  seen: Record<string, [number, number]>
  /** Files last changed at or before this time are never read again: their rows left `seen` to keep it small. */
  floor: number
  /** Per model family: dollars the engine's ledgers say, dollars this book's prices say. */
  led: Record<string, [number, number]>
  /** The correction on the price table, per family. 1 when the table is right. */
  k: Record<string, number>
  /** Sums for the unit fit: tool calls against requests, written tokens and output tokens. */
  xtx: number[][]
  xr: number[]
  xw: number[]
  xo: number[]
  nfit: number
  /** Per tool call of a kind: requests, tokens written, output tokens. Index 0 is the part every task has. */
  unit: { req: number[]; w: number[]; out: number[] }
  /** Per model family and effort level ('opus|high'): main chat requests, and their output tokens. */
  eff: Record<string, [number, number]>
  /** Dollars one helper cost, per model family. Newest last. */
  help: Record<string, number[]>
  /** Dollars one task cost, per kind and over all. Newest last. */
  kinds: Record<string, number[]>
  all: number[]
  turns: Turn[]
  /**
   * The start time of every task the book has counted, newest last.
   * A chat that was resumed or forked holds a copy of the old tasks in a new file. A copy is not counted again.
   */
  done: number[]
}

export function emptyBook(): Book {
  return {
    v: 3,
    builtAt: 0,
    files: 0,
    bytes: 0,
    tasks: 0,
    usd: 0,
    skipped: 0,
    newest: 0,
    oldest: 0,
    seen: {},
    floor: 0,
    led: {},
    k: {},
    xtx: Array.from({ length: K }, () => Array.from({ length: K }, () => 0)),
    xr: Array.from({ length: K }, () => 0),
    xw: Array.from({ length: K }, () => 0),
    xo: Array.from({ length: K }, () => 0),
    nfit: 0,
    // Measured on 3,948 tasks on 2026-11-13. A new install starts from these until its own chats are read.
    unit: {
      req: [1.1, 0.5, 1.3, 0.4, 1.0, 0.2, 0.6, 0.9, 0.5, 0.3, 0.5],
      w: [2800, 2200, 3500, 1800, 1800, 1600, 3200, 1400, 2900, 1600, 2600],
      out: [1700, 400, 100, 1150, 850, 480, 890, 670, 840, 500, 800],
    },
    eff: {},
    help: {},
    kinds: {},
    all: [],
    turns: [],
    done: [],
  }
}

/** A book as a file holds it. Null when the text is not a book of this version. */
export function parseBook(text: string): Book | null {
  try {
    const b = JSON.parse(text) as Book
    if (!b || b.v !== 3 || !Array.isArray(b.turns) || !Array.isArray(b.done) || !b.unit || !Array.isArray(b.xtx) || !b.eff) return null
    return b
  } catch {
    return null
  }
}

function push(list: number[], value: number, cap: number): void {
  list.push(Math.round(value * 10000) / 10000)
  if (list.length > cap) list.splice(0, list.length - cap)
}

/** Whether the book must read this file: it is new, or it has changed since the book read it. */
export function isUnread(book: Book, key: string, mtimeMs: number): boolean {
  if (mtimeMs <= book.floor) return false
  const row = book.seen[key]
  return !row || mtimeMs > row[0]
}

/**
 * Add one session to the book: the main transcript and its helper transcripts.
 * `key` names the file and `mtimeMs` is its change time. A file the book has read before adds only its newer tasks.
 */
export function addSession(
  book: Book,
  key: string,
  mtimeMs: number,
  main: Scan,
  subs: readonly Scan[],
): number {
  const helpers: HelperRun[] = []
  const tally = (scan: Scan): number => {
    let usd = 0
    for (const r of scan.reqs.values()) usd += costOf(tokensOf(r), r.model) + r.adv
    return usd
  }
  const since = book.seen[key]?.[1] ?? 0
  for (const s of subs) {
    let usd = tally(s)
    let fam: Fam = 'opus'
    let first = Infinity
    for (const r of s.reqs.values()) {
      if (r.t < first) {
        first = r.t
        fam = family(r.model)
      }
    }
    if (usd <= 0 || first === Infinity) continue
    usd *= book.k[fam] ?? 1
    helpers.push({ t: first, usd })
    if (first > since) push((book.help[fam] ??= []), usd, CAP_SAMPLES)
  }
  // The ledger covers the whole session. Use it only when it is new to the book and its cache split is whole.
  if (main.ledger && since === 0) {
    for (const [model, row] of Object.entries(main.ledger)) {
      const fam = family(model)
      // Haiku 5 has two price tiers by request size, and a ledger holds only totals: it cannot check Haiku.
      if (!row.isSplit || row.usd <= 0 || row.mine <= 0 || fam === 'haiku') continue
      const pair = (book.led[fam] ??= [0, 0])
      pair[0] += row.usd
      pair[1] += row.mine
    }
  }
  const turns = turnsOf(main, helpers, book.k)
  let added = 0
  let last = since
  const done = new Set(book.done)
  for (const t of turns) {
    if (t.t <= since) continue
    if (t.t > last) last = t.t
    // The same task in a second file: a resumed or forked chat. It was paid one time.
    if (done.has(t.t)) continue
    done.add(t.t)
    book.done.push(t.t)
    added += 1
    const total = t.usd + t.hu
    book.usd += total
    if (t.reqs > 0 && t.effort) {
      const pair = (book.eff[`${family(t.model)}|${t.effort}`] ??= [0, 0])
      pair[0] += t.reqs
      pair[1] += t.out
    }
    push(book.all, total, 600)
    push((book.kinds[t.kind] ??= []), total, CAP_SAMPLES)
    const calls = t.n.reduce((a, b) => a + b, 0)
    if (calls <= FIT_MAX_CALLS) {
      const x = [1, ...t.n]
      for (let i = 0; i < K; i++) {
        const xi = x[i] ?? 0
        if (xi === 0) continue
        book.xr[i] = (book.xr[i] ?? 0) + xi * t.reqs
        book.xw[i] = (book.xw[i] ?? 0) + xi * t.w
        book.xo[i] = (book.xo[i] ?? 0) + xi * t.out
        const row = book.xtx[i]
        if (!row) continue
        for (let j = 0; j < K; j++) row[j] = (row[j] ?? 0) + xi * (x[j] ?? 0)
      }
      book.nfit += 1
    }
    if (total >= 0.03) book.turns.push({ ...t, text: t.text.slice(0, 200), usd: round4(t.usd), hu: round4(t.hu), adv: round4(t.adv ?? 0) })
  }
  if (book.turns.length > CAP_TURNS) {
    book.turns.sort((a, b) => a.t - b.t)
    book.turns.splice(0, book.turns.length - CAP_TURNS)
  }
  if (book.done.length > CAP_DONE) {
    book.done.sort((a, b) => a - b)
    book.done.splice(0, book.done.length - CAP_DONE)
  }
  book.tasks += added
  book.seen[key] = [mtimeMs, last]
  book.files += since === 0 ? 1 : 0
  if (mtimeMs > book.newest) book.newest = mtimeMs
  if (book.oldest === 0 || mtimeMs < book.oldest) book.oldest = mtimeMs
  const keys = Object.keys(book.seen)
  if (keys.length > 6000) {
    keys.sort((a, b) => (book.seen[a]?.[0] ?? 0) - (book.seen[b]?.[0] ?? 0))
    for (const old of keys.slice(0, keys.length - 5000)) {
      book.floor = Math.max(book.floor, book.seen[old]?.[0] ?? 0)
      delete book.seen[old]
    }
  }
  return added
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** Solve A x = b for a small system. Rows the data does not reach give 0. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i] ?? 0])
  for (let i = 0; i < n; i++) {
    let p = i
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r]?.[i] ?? 0) > Math.abs(m[p]?.[i] ?? 0)) p = r
    const mi = m[p]
    const swap = m[i]
    if (!mi || !swap) continue
    m[p] = swap
    m[i] = mi
    const d = mi[i] ?? 0
    if (Math.abs(d) < 1e-9) continue
    for (let r = 0; r < n; r++) {
      const row = m[r]
      if (r === i || !row) continue
      const f = (row[i] ?? 0) / d
      if (f === 0) continue
      for (let c = i; c <= n; c++) row[c] = (row[c] ?? 0) - f * (mi[c] ?? 0)
    }
  }
  return m.map((row, i) => {
    const d = row[i] ?? 0
    return Math.abs(d) < 1e-9 ? 0 : (row[n] ?? 0) / d
  })
}

/** Least squares with no negative sizes: a kind of work that comes out negative is taken out and the rest is solved again. */
function fit(xtx: number[][], xty: number[]): number[] {
  const live = xty.map((_, i) => (xtx[i]?.[i] ?? 0) > 0)
  for (let round = 0; round < K; round++) {
    const idx = live.map((on, i) => (on ? i : -1)).filter(i => i >= 0)
    const a = idx.map(i => idx.map(j => (xtx[i]?.[j] ?? 0) + (i === j ? 1e-6 : 0)))
    const sol = solve(
      a,
      idx.map(i => xty[i] ?? 0),
    )
    let worst = -1
    let low = -1e-9
    sol.forEach((v, at) => {
      if (v < low) {
        low = v
        worst = idx[at] ?? -1
      }
    })
    if (worst < 0) {
      const out = xty.map(() => 0)
      idx.forEach((i, at) => (out[i] = sol[at] ?? 0))
      return out
    }
    live[worst] = false
  }
  return xty.map(() => 0)
}

/** Work out the unit sizes and the price corrections from what the book has added so far. */
export function settle(book: Book, now: number): void {
  if (book.nfit >= 40) {
    const req = fit(book.xtx, book.xr)
    const w = fit(book.xtx, book.xw)
    const out = fit(book.xtx, book.xo)
    // A kind of work the person never used keeps the starting size.
    const keep = (solved: number[], start: number[]): number[] =>
      solved.map((v, i) => ((book.xtx[i]?.[i] ?? 0) >= 5 ? v : (start[i] ?? 0)))
    const start = emptyBook().unit
    book.unit = { req: keep(req, start.req), w: keep(w, start.w), out: keep(out, start.out) }
  }
  for (const fam of FAMS) {
    const pair = book.led[fam]
    if (!pair || pair[1] < 1) continue
    const k = pair[0] / pair[1]
    // Inside 3% the table is right. Outside it, trust the ledger, within limits.
    book.k[fam] = Math.abs(k - 1) <= 0.03 ? 1 : Math.min(1.6, Math.max(0.6, Math.round(k * 1000) / 1000))
  }
  book.builtAt = now
}

export function quantile(list: readonly number[], q: number): number {
  if (list.length === 0) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))] ?? 0
}

const HELPER_START: Record<Fam, number> = { haiku: 0.09, sonnet: 0.65, opus: 2.4, fable: 3 }

/** Dollars one helper of this size costs on this model, from the person's own helpers when there are enough. */
export function helperUsd(book: Book | null, model: string, size: 's' | 'm' | 'l' = 'm'): number {
  const fam = family(model)
  const list = book?.help[fam] ?? []
  if (list.length >= 8) return quantile(list, size === 's' ? 0.25 : size === 'l' ? 0.8 : 0.5)
  return HELPER_START[fam] * (size === 's' ? 0.5 : size === 'l' ? 1.8 : 1)
}

/** The most one helper should cost before it is told to wrap up. */
export function helperCap(book: Book | null, model: string): number {
  const fam = family(model)
  const list = book?.help[fam] ?? []
  if (list.length >= 8) return Math.max(quantile(list, 0.9), 2 * quantile(list, 0.5))
  return HELPER_START[fam] * 2.5
}

export type Work = { units: Units; helpers?: HelperAsk[]; pages?: number }
export type Priced = { usd: number; main: number; helper: number; reqs: number; w: number; out: number; adv: number }

/**
 * Output tokens of one main chat request, per model family and effort level.
 * Measured on 66,000 requests on 2026-11-13. A new install starts from these until its own chats are read.
 */
const OUT_START: Record<string, number> = {
  'opus|low': 540,
  'opus|medium': 890,
  'opus|high': 930,
  'opus|xhigh': 1050,
  'opus|max': 2300,
  'sonnet|low': 190,
  'sonnet|medium': 360,
  'sonnet|high': 700,
  'sonnet|xhigh': 715,
  'fable|medium': 1050,
  'fable|high': 1530,
  'fable|xhigh': 1650,
  'haiku|low': 250,
}
const OUT_FAMILY: Record<Fam, number> = { haiku: 300, sonnet: 480, opus: 960, fable: 1400 }
/** The mean of the requests the starting unit sizes were fit on. */
const OUT_BASE = 970

/**
 * How much more or less a request writes on this model and effort than the mean request the unit sizes come from.
 * It uses the person's own chats when they hold enough requests at this model and effort.
 */
export function outFactor(book: Book | null, model: string, effort?: string): number {
  const fam = family(model)
  const key = `${fam}|${effort ?? ''}`
  const eff = book?.eff ?? {}
  let reqs = 0
  let out = 0
  let famReqs = 0
  let famOut = 0
  for (const [k, pair] of Object.entries(eff)) {
    reqs += pair[0]
    out += pair[1]
    if (k.startsWith(`${fam}|`)) {
      famReqs += pair[0]
      famOut += pair[1]
    }
  }
  const hasOwn = reqs >= 1000 && out > 0
  const base = hasOwn ? out / reqs : OUT_BASE
  const own = eff[key]
  let mean: number
  if (hasOwn && own && own[0] >= 200) mean = own[1] / own[0]
  else if (OUT_START[key]) mean = OUT_START[key] ?? base
  else if (hasOwn && famReqs >= 200) mean = famOut / famReqs
  else mean = OUT_FAMILY[fam]
  return Math.min(3, Math.max(0.2, mean / base))
}

export type AdvisorRate = { perReq: number; usd: number; ctx: number }
const NO_ADVISOR: AdvisorRate = { perReq: 0, usd: 0, ctx: 0 }
/**
 * The part of the advisor rate that goes into an estimate.
 * An estimate counts more requests than a big task really makes, so the full rate gave twice the real advisor dollars.
 * Half the rate matched them, per size of task, on 430 past tasks (2026-11-13): $0.82 real against $0.82 for 40 to 80 requests.
 */
export const ADVISOR_SHARE = 0.5

let rateMemo: { book: Book; at: number; n: number; rates: Record<string, AdvisorRate> } | null = null

/**
 * How often the advisor ran in the newest tasks on this model family: calls for each request, dollars for one call,
 * and the context those calls had. Zero when the person's newest tasks have no advisor call.
 */
export function advisorRate(book: Book | null, model: string): AdvisorRate {
  if (!book) return NO_ADVISOR
  const fam = family(model)
  if (!rateMemo || rateMemo.book !== book || rateMemo.at !== book.builtAt || rateMemo.n !== book.turns.length) {
    rateMemo = { book, at: book.builtAt, n: book.turns.length, rates: {} }
  }
  const hit = rateMemo.rates[fam]
  if (hit) return hit
  const turns = book.turns.filter(t => family(t.model) === fam).sort((a, b) => a.t - b.t).slice(-200)
  let reqs = 0
  let calls = 0
  let usd = 0
  let ctx = 0
  for (const t of turns) {
    reqs += t.reqs
    const an = t.an ?? 0
    if (an > 0) {
      calls += an
      usd += t.adv ?? 0
      ctx += t.ctx * an
    }
  }
  const rate: AdvisorRate = turns.length >= 20 && reqs >= 200 && calls > 0 ? { perReq: calls / reqs, usd: usd / calls, ctx: ctx / calls } : NO_ADVISOR
  rateMemo.rates[fam] = rate
  return rate
}

function dot(a: readonly number[], x: readonly number[]): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += (a[i] ?? 0) * (x[i] ?? 0)
  return s
}

/**
 * Put dollars on an amount of work.
 * `ctx` is the context the chat has now, in tokens. `isCold` adds the price of writing it to the cache once.
 * `withBase` adds the part every task has: the first request and the last answer.
 * `effort` is the effort level of the chat: a higher level writes more for each request.
 * The advisor's part is added at the rate the person's newest tasks had it.
 */
export function priceWork(
  book: Book | null,
  work: Work,
  o: { model: string; ctx: number; isCold?: boolean; withBase?: boolean; effort?: string },
): Priced {
  const unit = (book ?? emptyBook()).unit
  const x = [o.withBase === false ? 0 : 1, ...CATS.map(c => Math.max(0, work.units[c] ?? 0))]
  const reqs = Math.max(o.withBase === false ? 0 : 1, dot(unit.req, x))
  const w = Math.max(0, dot(unit.w, x))
  const out = Math.max(0, dot(unit.out, x)) * outFactor(book, o.model, o.effort) + (work.pages ?? 0) * 900
  const k = book?.k[family(o.model)] ?? 1
  const p = priceFor(o.model, o.ctx, k)
  let main = (reqs * (o.ctx + w / 2) * p.cr + w * p.w1 + out * p.out) / 1_000_000
  if (o.isCold) main += (o.ctx * (p.w1 - p.cr)) / 1_000_000
  main += (work.units.web ?? 0) * SEARCH_FEE * 0.5
  const rate = advisorRate(book, o.model)
  const adv = rate.perReq > 0 ? ADVISOR_SHARE * reqs * rate.perReq * rate.usd * Math.min(2, Math.max(0.3, (o.ctx + w / 2) / Math.max(1, rate.ctx))) : 0
  main += adv
  let helper = 0
  for (const h of work.helpers ?? []) {
    const model = !h.model || h.model === 'same' ? o.model : h.model
    helper += Math.max(0, h.n) * helperUsd(book, model, h.size)
  }
  return { usd: main + helper, main, helper, reqs, w, out, adv }
}

// ---------- similar past tasks ----------

const STOP = new Set(
  'the and for with that this from have has are was were will would could should can not you your our their them they then than into onto over under about what when where which while also just like make made need want please use using used new all any each every some more most very here there been being its it is in on at to of a an or as by be do if so we i me my'.split(
    ' ',
  ),
)

export function words(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue
    // A light stem, so "leads" meets "lead" and "testing" meets "test".
    const w = raw.length > 5 && raw.endsWith('ing') ? raw.slice(0, -3) : raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw
    seen.add(w)
    if (seen.size >= 60) break
  }
  return [...seen]
}

export type Match = { turn: Turn; score: number }

/** The past tasks whose wording is closest to this text. Rare words count for more. */
export function similarTurns(turns: readonly Turn[], text: string, max = 5, least = 0.22): Match[] {
  const mine = words(text)
  if (mine.length === 0 || turns.length === 0) return []
  const bags = turns.map(t => words(t.text))
  const df = new Map<string, number>()
  for (const bag of bags) for (const w of bag) df.set(w, (df.get(w) ?? 0) + 1)
  const idf = (w: string): number => Math.log(1 + turns.length / (1 + (df.get(w) ?? 0)))
  const norm = (bag: readonly string[]): number => Math.sqrt(bag.reduce((s, w) => s + idf(w) ** 2, 0))
  const mineSet = new Set(mine)
  const mineNorm = norm(mine)
  const out: Match[] = []
  bags.forEach((bag, i) => {
    const turn = turns[i]
    if (!turn || bag.length < 3) return
    let common = 0
    for (const w of bag) if (mineSet.has(w)) common += idf(w) ** 2
    const score = common / (mineNorm * norm(bag) || 1)
    if (score >= least) out.push({ turn, score })
  })
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, max)
}

/** The rows the panel shows: what each kind of task cost. */
export function kindRows(book: Book): { kind: string; n: number; p25: number; p50: number; p90: number }[] {
  return Object.entries(book.kinds)
    .filter(([, list]) => list.length >= 3)
    .map(([kind, list]) => ({ kind, n: list.length, p25: quantile(list, 0.25), p50: quantile(list, 0.5), p90: quantile(list, 0.9) }))
    .sort((a, b) => b.n - a.n)
}
