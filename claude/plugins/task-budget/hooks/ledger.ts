// The ledger: one line per request, with the cost split into its parts.
// Pure code plus one write helper. It shows nothing to the user and nothing to Claude.
//
// Parts of one request, in dollars:
//   read      context read from the cache
//   write5m   cache write at the 5 minute price
//   write1h   cache write at the 1 hour price
//   writeUnsplit  cache write whose 5m / 1h split the source does not give. Priced at the 1 hour price,
//                 and the line says `split: 'unknown'`, so a reader knows this part is not exact.
//   input     input that was not cached
//   output    output (thinking is inside output: the API counts it there)
//   web       web search fee
//   advisor   the advisor calls inside this request (a second model; its tokens are not in the top usage)
//   helper    helper dollars that a caller adds to this line (0 for a live line: a helper's own steps get their own lines)
//
// The bill to check a ledger against is NOT made here. On past chats it is the engine's own `cost-state` rows.
// Live, it is the engine's session cost (`$.session.usage().cost.usd`) before and after the step, kept on the line.

import { SEARCH_FEE, priceFor } from './book.ts'

export const LEDGER_FILE = 'task-budget-ledger.jsonl'
/** `$.fs.read` rejects files over 4 MiB. Past this size the file is moved aside and a new one starts. */
export const LEDGER_ROLL_BYTES = 3_000_000

export type Call = { in: number; out: number; cr: number; cw: number; w5: number | null; w1: number | null; model: string }

export type LedgerIn = {
  model: string
  in: number
  out: number
  cr: number
  cw: number
  /** The 5 minute and 1 hour parts of `cw`. null: the source does not say. */
  w5: number | null
  w1: number | null
  ws: number
  advisor: Call[]
  helperUsd: number
}

export type Parts = {
  read: number
  write5m: number
  write1h: number
  writeUnsplit: number
  input: number
  output: number
  web: number
  advisor: number
  helper: number
}

export const PART_NAMES: (keyof Parts)[] = ['read', 'write5m', 'write1h', 'writeUnsplit', 'input', 'output', 'web', 'advisor', 'helper']

function n(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

/** The cache write split. When the two parts do not add up to the whole write, the split is not known. */
export function splitOf(cw: number, w5: number | null, w1: number | null): { w5: number; w1: number; rest: number; isKnown: boolean } {
  if (w5 === null || w1 === null) return { w5: 0, w1: 0, rest: cw, isKnown: cw === 0 }
  if (w5 + w1 === cw) return { w5, w1, rest: 0, isKnown: true }
  // Old rows carry the whole write with a zero split.
  if (w5 + w1 === 0) return { w5: 0, w1: 0, rest: cw, isKnown: cw === 0 }
  return { w5, w1, rest: Math.max(0, cw - w5 - w1), isKnown: false }
}

function callParts(c: Call): { read: number; write5m: number; write1h: number; writeUnsplit: number; input: number; output: number } {
  const p = priceFor(c.model, c.in + c.cr + c.cw)
  const s = splitOf(c.cw, c.w5, c.w1)
  return {
    read: (c.cr * p.cr) / 1e6,
    write5m: (s.w5 * p.w5) / 1e6,
    write1h: (s.w1 * p.w1) / 1e6,
    writeUnsplit: (s.rest * p.w1) / 1e6,
    input: (c.in * p.in) / 1e6,
    output: (c.out * p.out) / 1e6,
  }
}

export function partsOf(x: LedgerIn): Parts {
  const main = callParts(x)
  let advisor = 0
  for (const a of x.advisor) {
    const q = callParts(a)
    advisor += q.read + q.write5m + q.write1h + q.writeUnsplit + q.input + q.output
  }
  return { ...main, web: n(x.ws) * SEARCH_FEE, advisor, helper: n(x.helperUsd) }
}

export function totalOf(p: Parts): number {
  let s = 0
  for (const k of PART_NAMES) s += p[k]
  return s
}

// ---------- reading one transcript row ----------

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function maybe(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** One usage block of the API (top level or one advisor iteration) as a priced call. */
export function callOf(u: Record<string, unknown>, model: string): Call {
  const cc = u.cache_creation === undefined ? null : obj(u.cache_creation)
  return {
    model,
    in: n(u.input_tokens),
    out: n(u.output_tokens),
    cr: n(u.cache_read_input_tokens),
    cw: n(u.cache_creation_input_tokens),
    w5: cc ? maybe(cc.ephemeral_5m_input_tokens) : null,
    w1: cc ? maybe(cc.ephemeral_1h_input_tokens) : null,
  }
}

export type Row = LedgerIn & { id: string; t: number; effort: string; tools: { name: string; id: string }[]; isSide: boolean }

/** An assistant row of a chat file, as the ledger input. null for any other row or a row with no usage. */
export function rowOf(o: Record<string, unknown>): Row | null {
  if (o.type !== 'assistant') return null
  const m = obj(o.message)
  const model = typeof m.model === 'string' ? m.model : ''
  const u = obj(m.usage)
  if (!model || model === '<synthetic>' || m.usage === undefined) return null
  const top = callOf(u, model)
  const advisor: Call[] = []
  if (Array.isArray(u.iterations)) {
    for (const it of u.iterations as unknown[]) {
      const i = obj(it)
      if (i.type === 'advisor_message') advisor.push(callOf(i, typeof i.model === 'string' ? i.model : model))
    }
  }
  const tools: { name: string; id: string }[] = []
  if (Array.isArray(m.content)) {
    for (const c of m.content as unknown[]) {
      const b = obj(c)
      if (b.type === 'tool_use') tools.push({ name: String(b.name ?? ''), id: String(b.id ?? '') })
    }
  }
  const effortRaw = o.effort ?? obj(o.metadata).effort
  return {
    ...top,
    ws: n(obj(u.server_tool_use).web_search_requests),
    advisor,
    helperUsd: 0,
    id: String(m.id ?? o.uuid ?? ''),
    t: Date.parse(String(o.timestamp ?? '')) || 0,
    effort: typeof effortRaw === 'string' ? effortRaw : '',
    tools,
    isSide: o.isSidechain === true,
  }
}

/** The same request is written in several rows while it streams. Keep the largest counts of each part. */
export function mergeRow(a: Row, b: Row): Row {
  const adv = b.advisor.length > a.advisor.length ? b.advisor : a.advisor
  const seen = new Set(a.tools.map(t => t.id))
  return {
    ...a,
    out: Math.max(a.out, b.out),
    in: Math.max(a.in, b.in),
    cr: Math.max(a.cr, b.cr),
    cw: Math.max(a.cw, b.cw),
    w5: a.w5 ?? b.w5,
    w1: a.w1 ?? b.w1,
    ws: Math.max(a.ws, b.ws),
    advisor: adv,
    effort: a.effort || b.effort,
    tools: [...a.tools, ...b.tools.filter(t => !seen.has(t.id))],
  }
}

/** The size in characters of each tool result in one user row: tool_use_id -> chars. */
export function resultSizes(o: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>()
  if (o.type !== 'user') return out
  const content = obj(o.message).content
  if (!Array.isArray(content)) return out
  for (const c of content as unknown[]) {
    const b = obj(c)
    if (b.type !== 'tool_result') continue
    let chars = 0
    if (typeof b.content === 'string') chars = b.content.length
    else if (Array.isArray(b.content)) {
      for (const x of b.content as unknown[]) {
        const y = obj(x)
        if (typeof y.text === 'string') chars += y.text.length
        else if (y.type === 'image') chars += 1 // an image: its tokens are not its characters; counted as present only
      }
    }
    out.set(String(b.tool_use_id ?? ''), chars)
  }
  return out
}

// ---------- the live line ----------

export type LiveIn = {
  at: number
  session: string
  agentId?: string
  turnId: string
  index: number
  effort?: string | number
  usage: { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null
  tools: string[]
  advisorCalls: number
  billBefore: number | null
  billAfter: number | null
}

/**
 * One ledger line for a live request. The live usage has no 5m / 1h split, no web search count and no advisor tokens,
 * so those stay unknown on the line. Web searches are counted from the tool calls (a WebSearch call is one search),
 * and the advisor shows as a count. The engine bill before and after is the check, not a part.
 */
export function liveLine(x: LiveIn): string | null {
  const u = x.usage
  if (!u) return null
  const ws = x.tools.filter(name => name === 'WebSearch').length
  const parts = partsOf({
    model: u.model,
    in: n(u.input_tokens),
    out: n(u.output_tokens),
    cr: n(u.cache_read_input_tokens),
    cw: n(u.cache_creation_input_tokens),
    w5: null,
    w1: null,
    ws: 0,
    advisor: [],
    helperUsd: 0,
  })
  const round = (v: number): number => Math.round(v * 1e6) / 1e6
  const line = {
    v: 1,
    at: x.at,
    session: x.session,
    ...(x.agentId ? { agentId: x.agentId } : {}),
    turnId: x.turnId,
    index: x.index,
    model: u.model,
    effort: x.effort ?? null,
    tokens: { in: n(u.input_tokens), out: n(u.output_tokens), cr: n(u.cache_read_input_tokens), cw: n(u.cache_creation_input_tokens) },
    split: n(u.cache_creation_input_tokens) > 0 ? 'unknown' : 'none',
    parts: Object.fromEntries(PART_NAMES.map(k => [k, round(parts[k])])),
    total: round(totalOf(parts)),
    webSearchCalls: ws,
    advisorCalls: x.advisorCalls,
    tools: x.tools,
    toolResultChars: null,
    bill: x.billBefore !== null && x.billAfter !== null ? { before: round(x.billBefore), after: round(x.billAfter), delta: round(x.billAfter - x.billBefore) } : null,
  }
  return JSON.stringify(line)
}

// ---------- the write ----------

export type LedgerFs = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
}

/**
 * Add one line to the file. There is no append call, so the file is read and written whole.
 * A read that fails on a file that exists stops the write: the old lines are never overwritten.
 * Past LEDGER_ROLL_BYTES the old text goes to `<file>.<n>` (a new name) and the main file starts again.
 */
export async function appendLine(fs: LedgerFs, path: string, line: string): Promise<'added' | 'rolled' | 'skipped'> {
  let old = ''
  if (await fs.exists(path)) {
    try {
      old = await fs.read(path)
    } catch {
      return 'skipped'
    }
  }
  if (old.length + line.length + 1 > LEDGER_ROLL_BYTES && old.length > 0) {
    let k = 1
    while (await fs.exists(`${path}.${k}`)) k += 1
    await fs.write(`${path}.${k}`, old)
    await fs.write(path, line + '\n')
    return 'rolled'
  }
  await fs.write(path, old + (old && !old.endsWith('\n') ? '\n' : '') + line + '\n')
  return 'added'
}

/** One chain for all writes of this process, so helpers side by side do not lose lines. */
let chain: Promise<unknown> = Promise.resolve()
export function queueLine(fs: LedgerFs, path: string, line: string): Promise<unknown> {
  chain = chain.then(() => appendLine(fs, path, line)).catch(() => undefined)
  return chain
}
