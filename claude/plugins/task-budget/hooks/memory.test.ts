// Tests of the learning memory (fix 13). Pure functions, plus the reads and writes with a small fake engine.
import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { bandLine, defaultLimit } from './core.ts'
import { learnRun, memLines, readMemory, upgradeMemory, withTail, type Raw } from './engine.ts'
import { buildPrompt } from './estimator.ts'
import { asksOf, easeFrom, typePathOf, bigTail, INDEX_MAX, isBigMiss, ownStats, parseLines, pickTypes, renderAll, renderIndex, allStats, statsJson, TYPE_MAX, typeOf, type MemLine, type MemRun } from './memory.ts'
import { STARTER } from './starter.ts'

const HOME = '/tmp/tb-mem'
const DIR = `${HOME}/.claude/mods-logs/task-budget-memory`
const OPUS = 'claude-opus-5-5'

function run(over: Partial<MemRun> = {}): MemRun {
  return { at: '2026-11-16T10:00:00.000Z', type: 'writing', task: 'write the pre-outline for the next video', model: OPUS, effort: 'high', cost: 2, ...over }
}

/** A fake engine: files in a map, some paths that cannot be read, and a model that answers one lesson. */
function fake(files: Map<string, string>, broken: Set<string> = new Set(), lesson = 'Count every subagent the task names.') {
  const asked: { prompt: string }[] = []
  const $ = {
    env: { get: async () => HOME },
    clock: { now: async () => Date.parse('2026-11-17T09:00:00.000Z') },
    session: { cwd: async () => '/work', id: async () => 'sess-1' },
    fs: {
      exists: async (p: string) => files.has(p) || broken.has(p),
      read: async (p: string) => {
        if (broken.has(p)) throw new Error('EIO')
        return files.get(p) ?? ''
      },
      write: async (p: string, t: string) => {
        files.set(p, t)
      },
    },
    model: {
      complete: async (req: { prompt: string }) => {
        asked.push(req)
        return { isAnswered: true, text: lesson }
      },
    },
  } as unknown as EngineInterface
  return { $, asked }
}

test('the type rules find the type of a task from its words, folder and skill', async () => {
  expect(typeOf('write the pre-outline and the draft for the video')).toBe('writing')
  expect(typeOf('render the motion graphics clips with ffmpeg')).toBe('video_media')
  expect(typeOf('anything', '/home/x/.claude/plugins/abc')).toBe('claude_tools')
  expect(typeOf('make it', '', 'script-writer')).toBe('writing')
  expect(typeOf('hello there')).toBe('other')
})

test('the estimate picks at most 2 type files, by the rules and by words in the sample tasks', async () => {
  const samples = { writing: ['write the pre-outline for the claude video'], sales: ['draft the proposal for the client'], other: [] }
  expect(pickTypes('write the pre-outline and the script', '', '', samples, Object.keys(samples))).toEqual(['writing'])
  expect(pickTypes('draft a proposal, then the script outline', '', '', samples, Object.keys(samples)).length).toBe(2)
  // No match at all: other.
  expect(pickTypes('zzz qqq', '', '', samples, Object.keys(samples))).toEqual(['other'])
})

test('the index stays at 200 lines or less with 300 types', async () => {
  const lines: MemLine[] = []
  for (let t = 0; t < 300; t++) for (let i = 0; i < 5; i++) lines.push(run({ type: `type${t}`, task: `task number ${i} of type ${t} with enough words`, cost: 1 + i }))
  const files = renderAll(lines, '2026-11-17T09:00:00.000Z')
  const n = files['INDEX.md']!.trimEnd().split('\n').length
  expect(n <= INDEX_MAX).toBe(true)
  expect(files['INDEX.md']).toContain('How to use this file:')
  expect(files['INDEX.md']).toContain('Money tail:')
  // The smallest types went into other.
  expect(files['types/other.md']).toBeDefined()
  for (const [p, text] of Object.entries(files)) if (p.startsWith('types/')) expect(text.trimEnd().split('\n').length <= TYPE_MAX).toBe(true)
})

test('a type with fewer than 5 runs is merged into other', async () => {
  const lines: MemLine[] = [...Array.from({ length: 5 }, () => run()), run({ type: 'sales', task: 'draft the proposal for the client call' })]
  const files = renderAll(lines, '2026-11-17T09:00:00.000Z')
  expect(files['types/writing.md']).toContain('5 runs')
  expect(files['types/other.md']).toContain('draft the proposal')
})

test('a new install with no runs uses the starter figures', async () => {
  const stats = allStats([])
  expect(stats.size).toBe(Object.keys(STARTER.types).length)
  const any = [...stats.values()][0]
  expect(any?.isStarter).toBe(true)
  const index = renderIndex(stats, [], '2026-11-17T09:00:00.000Z')
  expect(index).toContain('(starter)')
})

test('the person own figures take full weight after 10 runs of a type', async () => {
  const t = Object.keys(STARTER.types)[0]!
  const ten = Array.from({ length: 10 }, (_, i) => run({ type: t, task: `own task ${i} with enough words`, cost: 0.5 }))
  const s = allStats(ten).get(t)!
  expect(s.isStarter).toBe(false)
  expect(s.p50).toBe(0.5)
  const two = allStats(ten.slice(0, 2)).get(t)!
  expect(two.isStarter).toBe(true)
})

test('3 or more subagents give a high end, an "up to" line and a limit from the high end', async () => {
  const top = { n: 20, max: 40, maxFam: 'opus', over20: 1, subN: 3, subP90: 2, samples: [] }
  const t = bigTail({ likely: 4, safe: 9, helpers: 3 }, top, OPUS, 'claude-sonnet-5-5')
  // The highest run, $40 on Opus, on an Opus chat: $40. 3 subagents at $2 each: $6. Safe: $9.
  expect(t?.upTo).toBe(40)
  const raw = { parsed: { mode: 'guard', items: 0, confidence: 'medium', unsure: [], steps: [] }, facts: { model: OPUS, ctx: 0, isCold: false }, matches: [], cost: 0, mem: { types: ['x'], top } } as unknown as Raw
  const p = withTail({ steps: [], estimate: { likely: 4, low: 2, safe: 9, helpers: 3, basis: 'b' } as never }, raw, OPUS, 'claude-sonnet-5-5')
  expect(bandLine(p.estimate)).toBe('up to $40.00')
  expect(defaultLimit(p.estimate)).toBe(40)
  // A small task of a type with many costly runs: no tail.
  expect(bigTail({ likely: 0.4, safe: 1, helpers: 0 }, top, OPUS, 'claude-sonnet-5-5')).toBeNull()
  // The highest run was on Fable: an Opus chat pays half of it.
  expect(bigTail({ likely: 6, safe: 9, helpers: 0 }, { ...top, maxFam: 'fable', max: 100 }, OPUS, 'claude-sonnet-5-5')?.upTo).toBe(50)
})

test('a finished task updates runs.jsonl, its type file and the index', async () => {
  const files = new Map<string, string>()
  const { $ } = fake(files)
  for (let i = 0; i < 5; i++) await learnRun($, run({ task: `write the pre-outline number ${i} for the video` }))
  const lines = parseLines(files.get(`${DIR}/runs.jsonl`) ?? '')
  expect(lines.length).toBe(5)
  expect(files.get(`${DIR}/runs.jsonl.bak`)).toBe(files.get(`${DIR}/runs.jsonl`))
  expect(files.get(`${DIR}/types/writing.md`)).toContain('write the pre-outline number 4')
  expect(files.get(`${DIR}/INDEX.md`)).toContain('| writing (starter) | types/writing.md | 5 |')
  expect(files.get(`${DIR}/stats.json`)).toContain('"writing"')
  expect(files.get(`${DIR}/usage.md`)).toContain('# Task Budget usage')
})

test('a miss of 2 times or more adds one lesson line, kept in runs.jsonl', async () => {
  const files = new Map<string, string>()
  const { $, asked } = fake(files)
  expect(isBigMiss(run({ estimate: 1, cost: 2.5 }))).toBe(true)
  expect(isBigMiss(run({ estimate: 1, cost: 1.5 }))).toBe(false)
  await learnRun($, run({ estimate: 1, cost: 1.5 }))
  expect(asked.length).toBe(0)
  await learnRun($, run({ estimate: 1, cost: 3 }))
  expect(asked.length).toBe(1)
  const all = parseLines(files.get(`${DIR}/runs.jsonl`) ?? '')
  expect(all.length).toBe(3)
  expect(JSON.stringify(all[2])).toContain('Count every subagent the task names.')
})

test('a stopped or handed-off run makes no lesson and is left out of the multiple, but its cost counts', async () => {
  const files = new Map<string, string>()
  const { $, asked } = fake(files)
  expect(isBigMiss(run({ estimate: 1, cost: 3, outcome: 'stopped' }))).toBe(false)
  await learnRun($, run({ estimate: 1, cost: 6, outcome: 'stopped' }))
  await learnRun($, run({ estimate: 1, cost: 0.2, outcome: 'replaced' }))
  expect(asked.length).toBe(0)
  const lines = parseLines(files.get(`${DIR}/runs.jsonl`) ?? '')
  const five = [...lines, run({ estimate: 2, cost: 2, outcome: 'under' }), run(), run(), run()] as MemRun[]
  const t = ownStats('writing', five)
  expect(t.n).toBe(6)
  expect(t.max).toBe(6)
  expect(t.mult).toBe(1)
})

test('a runs file that is there but cannot be read is never saved over', async () => {
  const files = new Map<string, string>([[`${DIR}/runs.jsonl.bak`, JSON.stringify(run()) + '\n']])
  const broken = new Set([`${DIR}/runs.jsonl`])
  const { $ } = fake(files, broken)
  await learnRun($, run({ task: 'a new task that must not be written over the broken file' }))
  expect(files.has(`${DIR}/runs.jsonl`)).toBe(false)
  expect(files.get(`${DIR}/runs.jsonl.bak`)).toBe(JSON.stringify(run()) + '\n')
  // The reads still see the last good lines from the .bak copy.
  const got = await memLines($)
  expect(got.isBroken).toBe(true)
  expect(got.lines.length).toBe(1)
})

test('a memory file that cannot be read is never saved over', async () => {
  const files = new Map<string, string>()
  const broken = new Set([`${DIR}/INDEX.md`])
  const { $ } = fake(files, broken)
  await learnRun($, run())
  expect(files.has(`${DIR}/INDEX.md`)).toBe(false)
  expect(files.has(`${DIR}/types/writing.md`) || files.has(`${DIR}/types/other.md`)).toBe(true)
})

test('the estimate prompt holds the index and at most 2 type files', async () => {
  const files = new Map<string, string>()
  const { $ } = fake(files)
  const many: MemLine[] = [
    ...Array.from({ length: 6 }, (_, i) => run({ task: `write the pre-outline ${i} for the video` })),
    ...Array.from({ length: 6 }, (_, i) => run({ type: 'sales', task: `draft the proposal ${i} for the client` })),
    ...Array.from({ length: 6 }, (_, i) => run({ type: 'video_media', task: `render the clips ${i} with captions` })),
  ]
  for (const [p, text] of Object.entries(renderAll(many, '2026-11-17T09:00:00.000Z'))) files.set(`${DIR}/${p}`, text)
  const memo = await readMemory($, 'write the pre-outline and draft the proposal')
  expect(memo.types.length <= 2).toBe(true)
  expect(memo.types).toContain('writing')
  const prompt = buildPrompt('write the pre-outline and draft the proposal', { model: OPUS, ctx: 0, isCold: false }, [], memo.text)
  expect(prompt).toContain('INDEX.md')
  expect(prompt).toContain('# Task Budget memory')
  expect((prompt.match(/\ntypes\/[a-z_]+\.md\n/g) ?? []).length <= 2).toBe(true)
  expect(prompt).not.toContain('types/video_media.md\n#')
  // The read is logged, to check the memory is used.
  expect(files.get(`${DIR}/last-read.json`)).toContain('"types":["writing"')
})

test('a new install reads the starter figures and writes nothing to the memory', async () => {
  const files = new Map<string, string>()
  const { $ } = fake(files)
  const memo = await readMemory($, 'render the clips for the video')
  expect(memo.text).toContain('(starter)')
  expect([...files.keys()].filter(k => !k.endsWith('last-read.json'))).toEqual([])
  expect(files.get(`${DIR}/last-read.json`)).toContain('"isStarter":true')
})

test('stats.json keeps samples and the tail figures for each type', async () => {
  const s = statsJson([run(), run(), run(), run(), run({ cost: 30 })])
  expect(s.writing?.over20).toBe(1)
  expect(s.writing?.samples.length).toBe(1)
})

// ---------- added after 0.8.0 (item 6): the cost path ----------

/** A run that spent `shares` of its work cost at 25%, 50% and 75% done, on top of a start cost. */
function pathRun(shares: [number, number, number], over: Partial<MemRun> = {}): MemRun {
  const cost = over.cost ?? 2
  const start = over.start ?? 0.5
  const work = cost - start
  return run({ cost, start, path: [[0.25, start + shares[0] * work], [0.5, start + shares[1] * work], [0.75, start + shares[2] * work], [1, cost]], ...over })
}

test('after 0.8.0 item 6: the typical path is the middle work share at 25%, 50% and 75% done, from runs that ran to the end', async () => {
  const runs = [pathRun([0.5, 0.7, 0.9]), pathRun([0.6, 0.8, 0.95]), pathRun([0.4, 0.6, 0.85]), pathRun([0.1, 0.2, 0.3], { outcome: 'stopped' }), run()]
  const tp = typePathOf(runs)!
  expect(tp.n).toBe(3)
  expect(tp.q).toEqual([0.5, 0.7, 0.9])
  // Steps: 2 runs with the same 3 steps give a row; the start cost is taken off first. The middle of 2 is the upper one, as in the rest of the mod.
  const a = pathRun([0.5, 0.7, 0.9], { stepAt: [0.5, 1.25, 1.7] })
  const b = pathRun([0.5, 0.7, 0.9], { stepAt: [0.5, 1.1, 1.4] })
  expect(typePathOf([a, b])?.steps).toEqual({ '3': [0, 0.5, 0.8] })
  expect(typePathOf([run(), run()])).toBeUndefined()
})

test('after 0.8.0 item 6: a false alarm is a soft question before a run that ended under the limit at the question', async () => {
  const asks = [
    { kind: 'early', spent: 0.96, limit: 2.25, course: 2.8, answer: 'Keep going' },
    { kind: 'cap', spent: 1.2, limit: 2.25, answer: 'Keep going' },
    { kind: 'hard', spent: 1.3, limit: 2.25, answer: 'Keep going' },
    { kind: 'near', spent: 1.1, limit: 1.2, answer: 'Keep going' },
  ]
  const qs = asksOf(asks, 1.39, 'under')
  expect(qs.map(q => Boolean(q.falseAlarm))).toEqual([true, true, false, false])
  expect(qs[0]?.course).toBe(2.8)
  // A stopped run says nothing about the alarm.
  expect(asksOf(asks, 1.39, 'stopped').some(q => q.falseAlarm)).toBe(false)
  expect([0, 1, 2, 3, 4, 6, 20].map(easeFrom)).toEqual([1, 1, 1.1, 1.1, 1.2, 1.3, 1.3])
})

test('after 0.8.0 item 6: after 2 false alarms in a type the pause point goes up, with one lesson line written by code', async () => {
  const files = new Map<string, string>()
  const { $, asked } = fake(files)
  const alarm = asksOf([{ kind: 'early', spent: 1, limit: 2.25, answer: 'Keep going' }], 1.4, 'under')
  for (let i = 0; i < 5; i++) await learnRun($, pathRun([0.6, 0.8, 0.9], { estimate: 1.5, cost: 1.4, task: `write the pre-outline ${i} for the video`, ...(i >= 3 ? { qs: alarm } : {}) }))
  const lines = parseLines(files.get(`${DIR}/runs.jsonl`) ?? '')
  const lessons = lines.filter(l => 'lesson' in l)
  expect(lessons.length).toBe(1)
  expect((lessons[0] as { lesson: string }).lesson).toContain('The pause point is now 1.1 times the usual')
  // No paid model call for it.
  expect(asked.length).toBe(0)
  const stats = JSON.parse(files.get(`${DIR}/stats.json`) ?? '{}')
  expect(stats.writing.alarms).toBe(2)
  expect(stats.writing.ease).toBe(1.1)
  expect(stats.writing.path.n).toBe(5)
  const file = files.get(`${DIR}/types/writing.md`) ?? ''
  expect(file).toContain('## How it spends')
  expect(file).toContain('5 runs with a cost path. Middle share of the work cost spent by 25% done: 60%, by 50%: 80%, by 75%: 90%.')
  expect(file).toContain('False alarms: 2. The pause point is 1.1 times the usual.')
  expect(files.get(`${DIR}/INDEX.md`)).toContain('- writing: 5 runs. Share of the work cost by 25% done 60%, by 50% 80%, by 75% 90%.')
  // The estimate start reads the path and the pause point.
  const top = (await readMemory($, 'write the pre-outline for the video', false)).top
  expect(top?.path?.q).toEqual([0.6, 0.8, 0.9])
  expect(top?.ease).toBe(1.1)
})

test('after 0.8.0 item 6: the path lines stay under the line limits, and the index drops its path section when it does not fit', async () => {
  const kinds = Object.keys(STARTER.types)
  const lines: MemLine[] = []
  // Many types, each with many runs and long step lists.
  for (let t = 0; t < 190; t++) {
    for (let i = 0; i < 6; i++) {
      lines.push(pathRun([0.5, 0.7, 0.9], { type: `kind_${t}`, task: `task ${t} number ${i} with enough words`, stepAt: Array.from({ length: 30 }, (_, k) => 0.5 + k * 0.03) }))
    }
  }
  const files = renderAll(lines, '2026-11-17T10:00:00.000Z')
  const index = files['INDEX.md'] ?? ''
  expect(index.split('\n').length).toBeLessThanOrEqual(INDEX_MAX + 1)
  expect(index).not.toContain('## How each type spends')
  for (const [name, text] of Object.entries(files)) if (name.startsWith('types/')) expect(text.split('\n').length).toBeLessThanOrEqual(TYPE_MAX + 1)
  // A few types: the section fits.
  const few = renderAll(lines.filter(l => !('lesson' in l) && ['kind_0', 'kind_1'].includes(l.type)), '2026-11-17T10:00:00.000Z')
  expect(few['INDEX.md']).toContain('## How each type spends')
  expect(few['INDEX.md']!.split('\n').length).toBeLessThanOrEqual(INDEX_MAX + 1)
  expect(kinds.length > 0).toBe(true)
})

test('after 0.8.0 item 6: old memory files are written again once, so they hold the false-alarm count', async () => {
  const files = new Map<string, string>()
  const { $ } = fake(files)
  files.set(`${DIR}/runs.jsonl`, JSON.stringify(pathRun([0.6, 0.8, 0.9])) + '\n')
  files.set(`${DIR}/stats.json`, JSON.stringify({ writing: { n: 1, max: 2, maxFam: 'opus', over20: 0, subN: 0, subP90: 0, samples: [] } }) + '\n')
  expect(await upgradeMemory($)).toBe(true)
  expect(JSON.parse(files.get(`${DIR}/stats.json`) ?? '{}').other.alarms).toBe(0)
  expect(await upgradeMemory($)).toBe(false)
})
