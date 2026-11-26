import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Budget } from '../types'
import { family } from './book.ts'
import { AGENT_STOP_DENY, FORK_DENY, addPoint, markStepStarts, todoPart, SPAWN_STOP_DENY, agentModel, helperStep, isBigModel, spawnModel, HELP, HELPER_DENY, HELPER_STOP, HELPER_WRAP, HOUR, LAND_DENY, HANDED_OFF, STOPPED, budgetCall, listRank, planFromTodos, stepMark, afterStep, charge, callLine, closeOutcome, countTools, estimateLine, fits, forecast, freshFrom, gateWhy, isPlanDone, live, mustAskEarly, mustAskNear, inlineIn, priceOf, promptOf, recentOf, reserveSpent, runOf, scoreOf, spentOf, statusText, testInline, testToken, todosFrom, usd, viewOf, type Fresh } from './core.ts'
import { addSpawn, askHandoff, upgradeMemory, holdAgents, judgeHelper, regrow, releaseAgents, stopAgents, askGate, billNow, ledgerAfter, changeLimit, checkSoon, clearOffer, closeWithCard, cur, estimate, finish, folder, helperEst, helperRatio, helperUse, helperWarned, iso, isStill, keepGoing, kOf, land, learnLine, measureIdle, noteStart, loadBook, loadLog, mainEst, markFirst, measure, mem, offerSoon, openPanel, pause, placeCard, pricesText, raise, refreshView, runLine, saveRun, scanStart, SCAN_DAYS, setScan, start, type Started, unsent, type Usage } from './engine.ts'
import { registerViews } from './view.tsx'

// The engine wants these names written in the file that reads and writes them.
const REF = { plugin: 'task-budget', key: 'budget' } as const
const HIST_REF = { plugin: 'task-budget', key: 'history' } as const
const budget = atom(REF, null)

const ESTIMATING = 'Estimating the cost. In about 20 seconds you can start with no limit or with a limit. Nothing starts before you pick.'
function estimatingWithLimit(limit: number): string {
  return `Estimating the cost. In about 20 seconds the task starts with a limit of ${usd(limit)}. The mod asks first when the task fits another model, or when the likely cost is over your limit.`
}

/** Added in 0.8.0: what /budget answers. The hook logs it for the person; Claude does not get it. */
async function budgetCommand($: Parameters<typeof cur>[0], argsIn: string): Promise<string> {
  const raw = argsIn.trim()
  const args = raw.toLowerCase()
  const head = args.split(/\s+/)[0] ?? ''

  if (args === 'panel' || args === 'open') {
    await openPanel($)
    return 'Budget panel opened.'
  }

  if (args === 'off' || args === 'end') {
    const run = await finish($, 'ended')
    if (!run) return HELP
    return `Budget ended. ${runLine(run)}`
  }

  if (args === 'done') {
    const b = await cur($)
    if (!b) return HELP
    const run = await closeWithCard($, closeOutcome(b))
    return run ? `Budget closed: the task is done. ${runLine(run)} ${learnLine(run)}` : HELP
  }

  // Removed in 0.8.0: Pace mode and the step plan.
  if (/^(approve|guard|pace|plan)\b/.test(args)) return 'This was removed in version 0.8.0. Type /budget and then your task.'

  // "/budget learn": read the last 7 days of chats, and show what they say. "/budget learn all": read every past chat.
  if (args === 'learn') {
    await setScan($, 'yes')
    return scanStart($, { days: SCAN_DAYS, profile: true })
  }
  if (args === 'learn all') {
    await setScan($, 'yes')
    return scanStart($)
  }
  if (args === 'learn off') {
    await setScan($, 'no')
    return 'The mod does not read your past chats. The estimates use the 430 measured tasks and the tasks you run with /budget.'
  }

  if (args === 'prices') {
    await loadBook($)
    return pricesText(viewOf(mem.book, 'none', '', mem.score), mem.book)
  }

  if (args === 'report') {
    const log = await loadLog($)
    const run = [...log.runs].reverse().find(r => r.outcome !== 'open')
    if (!run) return 'No budget has finished yet.'
    await placeCard($, `rep-${run.id}`, { kind: 'report', run })
    return `The last budget: ${run.task || 'no task text'}. ${runLine(run)}`
  }

  if (args === 'finish') return land($)

  if (args === 'keep' || args === 'keep going' || args === 'no limit') return keepGoing($)

  const add = args.match(/^add\s+\$?(\d+(?:\.\d+)?)$/)
  if (add) {
    const text = await raise($, Number(add[1]))
    return text || HELP
  }

  const set = args.match(/^set\s+\$?(\d+(?:\.\d+)?)$/)
  if (set) {
    return (await changeLimit($, Number(set[1]))).text
  }

  const wanted = raw.match(/^estimate\b\s*(.*)$/is)
  if (wanted) {
    const task = (wanted[1] ?? '').trim()
    if (task.length < 8) return 'Put the task after it: /budget estimate research our churned members.'
    offerSoon($, task, true)
    return 'Estimating the cost. The estimate shows in the chat in about 20 seconds. Nothing starts.'
  }

  // A test run typed as the slash command: "/budget try [amount] <task> [tb-test:name]". Found in the paid test of the
  // subagent fixes: with no branch here, "try 1.2" became part of the task and reached Claude.
  if (head === 'try') {
    const t = testInline(`/budget ${raw}`)
    if (!t) return 'A test run needs a test mark at the end: /budget try 1 <task> [tb-test:name].'
    offerSoon($, t.task, false, t.limit)
    return t.limit === undefined ? ESTIMATING : estimatingWithLimit(t.limit)
  }

  // "/budget 3", "/budget $0.5 research the models", "/budget 0.5!" to skip the size check.
  const begin = raw.match(/^\$?(\d+(?:\.\d+)?)(!?)(?:\s+(.*))?$/s)
  if (begin) {
    const limit = Number(begin[1])
    if (limit <= 0) return 'Give a budget above $0, for example /budget 3.'
    const withTask = (begin[3] ?? '').trim()
    // A limit and a task: estimate first. When the likely cost is over the limit, the person chooses before anything starts.
    if (begin[2] !== '!' && testToken(withTask).text.length >= 8) {
      offerSoon($, withTask, false, limit)
      return estimatingWithLimit(limit)
    }
    return (await start($, limit, (begin[3] ?? '').trim(), { isForced: begin[2] === '!' })).text
  }

  // "/budget research our churned members": estimate first, then the person picks the amount.
  if (raw && head !== 'status' && head !== 'help') {
    if (raw.length < 8) return HELP
    offerSoon($, raw, false)
    return ESTIMATING
  }

  const b = await cur($)
  if (!b) return HELP
  const usage = await $.session.usage()
  const spent = spentOf(b, usage.cost?.usd)
  const now = { ...b, spent }
  const est = (await mainEst($, b, b.lastModel || b.model, usage, await $.clock.now(), null)).cost
  const p = b.plan
  const f = forecast(now)
  const planText =
    p && p.steps.length > 0
      ? ` Steps: ` + p.steps.map((st, i) => `${i + 1}. ${st.name} ${usd(st.spent)} of ${usd(st.usd)}`).join('; ') + `; buffer ${usd(reserveSpent(now, p))} of ${usd(p.reserve)}.`
      : ''
  return (
    `Spent ${usd(spent)} of ${usd(b.limit)}. ${usd(b.limit - spent)} left, about ${fits(now, est)} more requests.` +
    (f && f.basis !== 'estimate' ? ` The task is on course for about ${usd(f.usd)}.` : '') +
    (b.estimate ? ` Estimate: ${estimateLine(b.estimate)}.` : '') +
    planText +
    ' Open the panel with /budget panel.'
  )
}

export const register: Register = (on, options) => {
  // Added in the subagent fixes. On by default: every subagent in every chat runs on Sonnet or Haiku, at medium effort at most.
  // Off: only the subagents of a task with a budget are capped, because its money check counts on that.
  const isForce = typeof options?.forceHelperModel === 'boolean' ? options.forceHelperModel : true
  mem.inflight = 0
  mem.asking = null
  helperUse.clear()
  helperWarned.clear()
  mem.idleRaw = 0
  mem.idleParts = null
  mem.stepRaw = 0
  mem.start = null
  mem.isAsked = false
  mem.isLearned = false
  mem.isBookRead = false
  mem.job = null
  mem.offer = null
  mem.ttl = HOUR
  mem.effort = ''

  on('session.start', async ($, e, next) => {
    // First, before the start goes on: the app lists the command for the first message of the chat.
    try {
      await $.command.register({
        name: 'budget',
        description: 'Estimate a task and count its cost live: /budget research our churned members',
        argumentHint: '[task] | [amount] [task] | estimate [task] | add [amount] | set [amount] | learn | done | off | panel',
      })
    } catch {
      // Not in the list: "/budget" at the start or the end of a message still works, through prompt.submit.
    }
    const r = await next(e)
    try {
      const log = await loadLog($)
      mem.score = scoreOf(log.runs)
      mem.recent = recentOf(log.runs)
      await $.state.set(HIST_REF, log.runs.slice(-8))
      // A question cannot be open when the mod has just loaded.
      await update($, budget, c0 => {
        const c = live(c0)
        return c && c.waiting ? { ...c, waiting: '' } : c0
      })
      await loadBook($)
      await refreshView($)
      // Added after 0.8.0: rebuild old memory files once, so they hold the cost paths. In the background.
      void upgradeMemory($).catch(() => undefined)
      // The person said yes to the scan: read the chats of the last days that are new, a moment after the start.
      if (log.scan === 'yes') {
        $.clock.after(4000, () => {
          void scanStart($, { days: SCAN_DAYS }).catch(() => undefined)
        })
      }
    } catch {
      // no history yet
    }
    return r
  })

  // Changed in 0.8.0: the reply of /budget goes to the person alone. The text a mod's command returns goes to Claude too;
  // a log line does not. So the hook returns no text and no note, and logs the reply.
  on('command.run', { command: 'budget' }, async ($, e) => {
    const said = await budgetCommand($, e.args)
    if (said) $.ui.log(said)
    return {}
  })

  // Tool calls: the two times a call is refused. Changed in 0.8.0: no notes for Claude ride on a tool result.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    // The mod's own TaskStop of a subagent it ends. The guard below would refuse it: the task is paused, and a Stop that
    // comes from a question inside a subagent request makes the call as that (now stopped) subagent.
    if (tool === 'TaskStop' && mem.stopping.has(String((e as { task_id?: unknown }).task_id))) return next(e)
    // Added in the subagent fixes: a subagent the mod stopped gets no more tool calls, with a budget open or not.
    if (e.agentId && mem.stopped.has(e.agentId)) return { deny: AGENT_STOP_DENY } as never
    const b = await cur($)
    if (!b) return next(e)

    if (e.agentId) {
      if (b.isPaused) return { deny: AGENT_STOP_DENY } as never
      if (b.phase === 'landing') return { deny: HELPER_DENY } as never
      const ratio = helperRatio(b, e.agentId, '')
      if (ratio >= 1.5) return { deny: HELPER_DENY } as never
      const r = await next(e)
      if (ratio >= 1 && !helperWarned.has(e.agentId) && !('deny' in r)) {
        helperWarned.add(e.agentId)
        return { ...r, context: [...(r.context ?? []), HELPER_WRAP] } as never
      }
      return r
    }

    // Stopped: the main chat gets no more tool calls either, until the person types.
    if (b.isPaused && tool !== 'AskUserQuestion') return { deny: AGENT_STOP_DENY } as never
    // The person chose to finish now: no new work. The mod's own question to the person still goes through.
    if (b.phase === 'landing' && !(tool === 'AskUserQuestion' && mem.asking)) return { deny: LAND_DENY } as never

    return next(e)
  })

  // Added in the subagent fixes. A new subagent runs on Sonnet or Haiku, never on Opus or Fable: in every chat while
  // forceHelperModel is on, and always in a task with a budget. A fork keeps the main chat's model, so a fork of an Opus
  // or Fable chat is refused. While a task is stopped or finishing, no new subagent starts. No money words reach Claude.
  // Hook order: the model-router mod registers first, so it is the outer hook. Its pick is in e.model here, and is capped
  // like any other ask. The turn.step guard below caps each request too, so the order does not matter.
  on('agent.spawn', async ($, e, next) => {
    const b = await cur($)
    if (b && (b.isPaused || b.phase === 'landing')) return { deny: SPAWN_STOP_DENY } as never
    if (!b && !isForce) return next(e)
    const main = b?.route?.model || e.parentModel
    if (e.fork && isBigModel(main)) return { deny: FORK_DENY } as never
    let model: string | undefined
    if (!e.fork && !e.resume) {
      const rule = spawnModel(e.model, main)
      model = rule === 'judge' ? await judgeHelper($, e.prompt) : (rule ?? undefined)
    }
    const r = await next(model ? { ...e, model } : e)
    if ('agentId' in r && r.agentId) {
      // What the subagent runs on: the mod's choice, else what the engine says it ran, else Sonnet (Haiku under a Haiku chat).
      const said = 'model' in r && typeof r.model === 'string' ? r.model : ''
      const ran = model || (family(said) === 'sonnet' || family(said) === 'haiku' ? said : '') || agentModel(e.parentModel, b?.route?.model)
      mem.picks.set(r.agentId, ran)
      if (b) await addSpawn($, b.id, r.agentId, mem.picks.get(r.agentId) ?? 'sonnet').catch(() => undefined)
    }
    return r
  })

  // Added in the subagent fixes: keep the id of the main chat's turn, so Stop can end it.
  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) mem.mainTurn = e.turnId
    return r
  })

  // Every message the person sends: the mod counts it. Changed in 0.8.0: Claude gets no note about the budget.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)

    // The first message of a chat: keep the engine's count from before the chat grows.
    if (!mem.isAsked) {
      mem.isAsked = true
      try {
        const u = await $.session.usage()
        const isNew = u.cost ? u.cost.usd === 0 : u.context.tokens === undefined
        if (isNew) await measureIdle($)
      } catch {
        // no count: the estimate falls back
      }
    }

    // "budget $3: <task>" or "/budget 3 <task>" typed as a normal message:
    // the budget starts and the task goes on in the same message.
    const kind = e.origin?.kind ?? 'composer'
    const isPerson = kind !== 'plugin' && kind !== 'task-notification' && kind !== 'auto-continuation'
    // Added in the subagent fixes: only a message the person typed ends a stop. Peer, bridge and channel messages do not.
    const isTyped = kind === 'composer' || kind === 'sdk'
    // Added in the subagent fixes: a message the person types lets held subagents go on. /budget itself (panel, status) does not.
    if (isTyped && !/^\s*\/budget\b/i.test(e.text)) releaseAgents()
    // A test run with a test mark: the estimate comes first, as with the slash command. The task is sent after the answers.
    const trial = isPerson ? testInline(e.text) : null
    if (trial) {
      offerSoon($, trial.task, false, trial.limit)
      return { drop: 'Test run: estimating the cost first. The task starts after the answers.' }
    }
    const direct = isPerson ? inlineIn(e.text) : null
    const call = isPerson && !direct ? budgetCall(e.text) : null
    if (call && !(call.isForced && call.limit)) {
      // The same path as the command: estimate first, then the person picks. The message is not sent:
      // the task goes to Claude after the pick, without "/budget" and without an amount.
      offerSoon($, call.task, false, call.limit)
      return { drop: call.limit ? estimatingWithLimit(call.limit) : ESTIMATING }
    }
    const found = direct ?? (call && call.limit ? { inline: { limit: call.limit, isForced: true, task: call.task }, head: '' } : null)
    if (found) {
      const inline = found.inline
      let out: Started | null = null
      try {
        out = await start($, inline.limit, inline.task, { isInline: true, isForced: inline.isForced })
      } catch {
        out = null
      }
      if (out && !out.isSet) return { drop: out.text }
      if (out && !inline.task) return { drop: out.text }
      if (out) {
        $.ui.toast(`Budget set: ${usd(inline.limit)}. Open the panel with /budget panel.`)
        // The text in front of the command (the brief of a side session) stays.
        return next({ ...e, text: found.head + testToken(inline.task).text })
      }
    }

    let note: string[] = []
    try {
      const b = await cur($)
      if (!b && isPerson) await clearOffer($)
      if (b) {
        const usage = await $.session.usage()
        const spent = spentOf(b, usage.cost?.usd)
        const isFirst = b.steps === 0 && b.isFresh
        const fresh: Fresh | null = isFirst ? { tokens: b.firstTokens > 0 ? b.firstTokens : 183_000, how: 'guess' } : null
        const guess = await mainEst($, b, b.lastModel || b.model, usage, await $.clock.now(), fresh)
        const isTask = kind !== 'task-notification'
        const isOurs = kind === 'plugin'
        const task = b.task || (isTask ? e.text.slice(0, 200) : '')
        // A task given with /budget that did not arrive: Claude gets it with this message.
        const lost =
          b.pending && isTask && !isOurs && e.text.trim() !== b.pending
            ? `[The user gave this task in a command, and it did not reach you: "${b.pending}". This message is about it.] `
            : ''
        const plan = b.plan && b.plan.status === 'draft' && isTask && !isOurs ? { ...b.plan, isHeard: true } : b.plan
        const counted: Budget = {
          ...b,
          spent,
          task,
          plan,
          // A new message from the person ends a stop: the next request asks again when the money is still short.
          isPaused: isTyped ? false : b.isPaused,
          isMidTurn: isTyped ? false : b.isMidTurn,
          notes: [],
          pending: isTask ? '' : b.pending,
          messages: b.messages + (isTask ? 1 : 0),
          msgStart: isTask ? spent : b.msgStart,
          bars: isTask ? [...b.bars, 0].slice(-14) : b.bars,
        }
        await $.state.set(REF, counted)
        // Added in the subagent fixes: the person adds to a task that is still running. Estimate it again, quietly.
        const added = e.text.trim()
        if (isTyped && b.estimate && b.firstCost === undefined && b.messages >= 1 && added.length >= 12 && (b.regrows ?? 0) < 3 && !mem.isRegrowing) {
          mem.isRegrowing = true
          void regrow($, b.id, `${b.task}\n\nThe user added: ${added.slice(0, 600)}`)
            .catch(() => undefined)
            .finally(() => {
              mem.isRegrowing = false
            })
        }
        // Only the lost task, with no budget words.
        note = lost ? [lost.trim()] : []
        // Keep the history file current, so a chat that is closed is still logged.
        void $.clock
          .now()
          .then(now => saveRun($, runOf(counted, 'open', iso(now))))
          .catch(() => undefined)
      }
    } catch {
      note = []
    }
    return next(note.length > 0 ? { ...e, context: [...(e.context ?? []), ...note] } : e)
  })

  // turn.step streams, so the hook is an async generator: yield* forwards the stream.
  on('turn.step', async function* ($, e, next) {
    // The effort level changes what a task costs: the next estimate reads it from here.
    if (!e.agentId && typeof e.effort === 'string' && e.effort) {
      mem.effort = e.effort
      const level = e.effort
      // No advice was taken: the budget runs at the level of the picker, so it records that level.
      await update($, budget, c0 => {
        const c = live(c0)
        return c && !c.route && c.effort !== level ? { ...c, effort: level } : c0
      }).catch(() => undefined)
    }
    // Added in the subagent fixes: a subagent the mod stopped sends no more requests.
    if (e.agentId && mem.stopped.has(e.agentId)) return yield* unsent(e, STOPPED)
    // Added in the subagent fixes: the person stopped the main turn. A subagent request waits until the person types.
    while (e.agentId && mem.hold) await mem.hold.wait
    if (e.agentId && mem.stopped.has(e.agentId)) return yield* unsent(e, STOPPED)
    let b = await cur($)

    // The first request of a chat, with a budget or not: measure it, so the next
    // estimate in this folder is this person's real number.
    let first: Usage | null = null
    let isNew = false
    let stepRaw = 0
    if (!e.agentId && !mem.isLearned) {
      mem.isLearned = true
      try {
        first = await $.session.usage()
        // Few rows and no answer from Claude yet. Changed after 0.8.0: not "no cost". In a /budget chat the mod's own
        // estimate calls have a cost before the first request, so the start of a /budget chat was never learned.
        isNew = e.messageCount <= 20 && !(await $.session.messages()).some(m => m.role === 'assistant')
        if (isNew) {
          // Changed after 0.8.0 (fix 3): kept for the ratio. Only the parts from before the chat are compared, the same kind each time.
          stepRaw = await measure($)
          mem.stepRaw = stepRaw
        }
      } catch {
        isNew = false
      }
    }

    if (!b) {
      const bill0 = await billNow($)
      // Added in the subagent fixes: with forceHelperModel on, a subagent request in any chat is capped too.
      const r = yield* next(e.agentId && isForce ? helperStep(e, mem.picks.get(e.agentId) ?? 'sonnet') : e)
      ledgerAfter($, e, r, bill0)
      // Changed after 0.8.0 (fix 3): the start is followed over the first requests, not taken from the first one only.
      noteStart($, isNew, r.usage, e.agentId)
      return r
    }

    // Added in the subagent fixes: one question at a time for the whole task. While it is open, every request waits,
    // the main chat's and the subagents'. Then the request checks again.
    if (mem.asking) await mem.asking
    if (e.agentId && mem.stopped.has(e.agentId)) return yield* unsent(e, STOPPED)
    b = await cur($)
    if (!b) return yield* next(e.agentId && isForce ? helperStep(e, mem.picks.get(e.agentId) ?? 'sonnet') : e)

    // The gate. A request that would pass the limit waits here for the person's answer.
    const id = b.id
    let est = 0
    for (let round = 0; ; round++) {
      b = await cur($)
      if (!b || b.id !== id) break
      const usage = round === 0 && first ? first : await $.session.usage()
      const spent = spentOf(b, usage.cost?.usd)
      const now = await $.clock.now()
      const typical = (await mainEst($, b, b.lastModel || e.model, usage, now, null)).cost
      if (e.agentId) {
        // A helper that used twice what a helper may use is stopped. Its work so far is kept.
        if (helperRatio(b, e.agentId, e.model) >= 2) return yield* unsent(e, HELPER_STOP)
        est = helperEst(e.agentId, e.model)
      } else {
        let fresh: Fresh | null = null
        if (b.steps === 0 && b.isFresh) {
          // By now the lists of tools and skills are in the chat, so this count is the close one.
          const raw = stepRaw > 0 ? stepRaw : await measure($)
          const log = await loadLog($)
          fresh = raw > 0 || b.firstTokens <= 0 ? freshFrom(log.base, log.calib, await folder($), raw, 'step', mem.idleParts ?? undefined, await $.session.model()) : { tokens: b.firstTokens, how: 'guess' }
        } else if (b.ctxTokens === 0 && b.steps > 0) {
          // The chat was just compacted: the short chat is written to the cache again.
          const raw = await measure($)
          fresh = { tokens: raw > 0 ? raw : 40_000, how: 'measured' }
        }
        // Changed after 0.8.0: price the model that is really sent. A task with its own model (b.route) is sent on that
        // model below, not on the picker's model. Pricing the picker's model looked like a model change, so the whole chat
        // was priced as written again: $3.34 at 185K on "Fable" for a request that cost about $0.04 on Opus.
        const sendModel = b.route && b.phase === 'run' ? b.route.model : e.model
        est = (await mainEst($, b, sendModel, usage, now, fresh)).cost
      }
      const why = gateWhy(b, spent, mem.inflight, est, typical, Boolean(e.agentId))
      if (!why) break
      if (why.kind === 'paused') return yield* unsent(e, b.isHandedOff ? HANDED_OFF : STOPPED)
      if (!isStill(why, b)) {
        // The question is not true any more: drop it.
        await update($, budget, c0 => {
          const c = live(c0)
          return c && c.id === id ? { ...c, ask: null } : c0
        })
        continue
      }
      // The person gets the choice each time. Four questions with no way through: stop.
      if (round >= 4) {
        await pause($, b, spent, !e.agentId)
        return yield* unsent(e, STOPPED)
      }
      // One question at a time. A second request that must wait joins the open question, then checks again.
      if (mem.asking) {
        await mem.asking
      } else {
        const held = b
        mem.asking = askGate($, held, why, spent, est, typical, !e.agentId)
          .catch(() => undefined)
          .finally(() => {
            mem.asking = null
          })
        await mem.asking
      }
    }
    if (!b || b.id !== id) return yield* next(e.agentId && isForce ? helperStep(e, mem.picks.get(e.agentId) ?? 'sonnet') : e)

    const before = b
    // The person took the advice: the main chat requests of this task run on that model and effort level. No setting changes.
    // Added in the subagent fixes: a subagent runs at medium effort at most, and never on Opus or Fable.
    const agentSent = e.agentId ? helperStep(e, mem.picks.get(e.agentId) ?? agentModel(b.lastModel || b.model, b.route?.model)) : e
    const sent = !e.agentId && b.route && b.phase === 'run' ? ({ ...e, model: b.route.model, ...(b.route.effort ? { effort: b.route.effort } : {}) } as typeof e) : agentSent
    mem.inflight += est
    const bill0 = await billNow($)
    const t0 = await $.clock.now()
    let r
    try {
      r = yield* next(sent)
    } finally {
      mem.inflight = Math.max(0, mem.inflight - est)
    }

    const after = await $.session.usage()
    const t1 = await $.clock.now()
    const u = r.usage
    const k = kOf(u?.model ?? e.model)
    if (e.agentId && u) {
      const h = helperUse.get(e.agentId) ?? { n: 0, usd: 0, model: '' }
      helperUse.set(e.agentId, { n: h.n + 1, usd: h.usd + priceOf(u, k), model: u.model || e.model })
    }
    // A cold request after a short wait: the cache lives five minutes here, not an hour.
    if (!e.agentId && u && before.lastAt > 0 && before.ctxTokens > 0) {
      const gap = t0 - before.lastAt
      const wasCold = u.cache_creation_input_tokens > promptOf(u) / 2
      if (wasCold && gap > 5.5 * 60_000 && gap < HOUR && family(before.lastModel) === family(u.model)) mem.ttl = 5 * 60_000
    }
    const names = e.agentId ? [] : r.toolUses.map(t => t.name)
    let shown: Budget | null = null
    await update($, budget, c0 => {
      const c = live(c0)
      if (!c || c.id !== id) return c0
      // The new spend lands on the step that is active. With none active it stays in the buffer.
      const charged = charge(afterStep(c, u, after.cost?.usd, e.agentId, t1, k), 0)
      const stepped = charge(charged.next, charged.next.spent - c.spent)
      let n = stepped.next
      // What each subagent of this budget has used so far.
      if (e.agentId && u && (n.spawns ?? []).some(x => x.id === e.agentId)) {
        n = { ...n, spawns: (n.spawns ?? []).map(x => (x.id === e.agentId ? { ...x, used: Math.round((x.used + priceOf(u, k)) * 1e4) / 1e4, isRunning: true } : x)) }
      }
      if (!e.agentId) {
        let todos = n.todos
        let listTool = n.todoTool ?? ''
        for (const t of r.toolUses) {
          // One tool keeps the list. The list of a second tool, such as another mod, does not replace it.
          if (listTool && listRank(t.name) < listRank(listTool)) continue
          const got = todosFrom(t.name, t.input, todos)
          if (!got) continue
          todos = got
          listTool = t.name
        }
        const lines = r.toolUses.map(t => callLine(t.name, t.input))
        const hasNewList = todos !== n.todos
        n = { ...n, used: countTools(n.used, names), todos, ...(listTool ? { todoTool: listTool } : {}), ...(lines.length > 0 ? { calls: [...(n.calls ?? []), ...lines].slice(-14) } : {}) }
        // The plan in the panel follows Claude's own task list, so the chat and the panel show the same steps.
        if (hasNewList) n = planFromTodos(n, todos)
        // Added in 0.8.0: a step moved in that list. The forecast takes it, and the small model reads the chat at once.
        if (hasNewList && stepMark(todos) !== stepMark(c.todos)) {
          n = { ...n, todosAt: n.spent, isStepNew: true }
          // Added after 0.8.0: the cost path keeps the share done and the spend at each step move, and the spend at each step start.
          const part = todoPart(todos)
          if (part !== null) n = addPoint(n, part, n.spent)
          n = markStepStarts(n, c.todos, todos)
        }
        if (!n.skill) {
          const sk = r.toolUses.find(t => t.name === 'Skill')
          const name = sk && sk.input && typeof sk.input === 'object' ? (sk.input as { skill?: unknown }).skill : undefined
          if (typeof name === 'string' && name) n = { ...n, skill: name.slice(0, 80) }
        }
      }
      if (!n.ask && n.phase === 'run') {
        // 0.8.0: the 80% pause first, then the 50% pause. The 'stuck' question of the step plan is gone.
        if (mustAskNear(n, forecast(n))) n = { ...n, ask: { kind: 'near' } }
        else if (mustAskEarly(n, forecast(n))) n = { ...n, ask: { kind: 'early' } }
      }
      shown = n
      return n
    })
    const now = shown as Budget | null
    if (now) $.ui.status(statusText(now))
    // At set spend marks a small model reads the chat, so the course is better than a straight line.
    if (now && !e.agentId) checkSoon($, now)
    // Changed after 0.8.0 (fix 3): the start is followed over the first requests, not taken from the first one only.
    noteStart($, isNew, u, e.agentId)
    // The line holds the model and effort level the request really ran on.
    ledgerAfter($, sent, r, bill0)
    return r
  })

  // The turn ended. A task that finished closes its budget, and the report goes in the chat.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      if (e.agentId) {
        // A subagent's run ended: it no longer counts as running.
        const agentId = e.agentId
        await update($, budget, c0 => {
          const c = live(c0)
          return c && (c.spawns ?? []).some(x => x.id === agentId && x.isRunning) ? { ...c, spawns: (c.spawns ?? []).map(x => (x.id === agentId ? { ...x, isRunning: false } : x)) } : c0
        })
        return r
      }
      if (mem.mainTurn === e.turnId) mem.mainTurn = ''
      // A hand off asked during the turn: the Handoff mod may fork the chat now that the turn is over.
      await askHandoff($)
      const b = await cur($)
      if (!b || b.isPaused) return r
      const isBusy = (b.spawns ?? []).some(x => x.isRunning)
      // Added in the subagent fixes: the person stopped the main turn (the app's Stop or Escape) while this task's
      // subagents run. They are not ended: they wait, and send no request, until the person types. The mod's Stop ends them.
      if (e.isAborted && isBusy) {
        holdAgents()
        $.ui.toast('The subagents wait. Type a message and they go on. Stop in /budget panel ends them.')
        return r
      }
      // Subagents still run: the budget stays open, so its gates still hold. It closes after they are done.
      if (isBusy) {
        const usage = await $.session.usage()
        await saveRun($, runOf({ ...b, spent: spentOf(b, usage.cost?.usd) }, 'open', iso(await $.clock.now())))
        return r
      }
      if (b.phase === 'landing') {
        const run = await closeWithCard($, 'stopped')
        if (run) $.ui.toast(`Budget closed. ${runLine(run)}`)
      } else if (e.reason === 'answer' && isPlanDone(b.plan) && b.plan?.byTool !== false) {
        await markFirst($, b)
        const run = await closeWithCard($, closeOutcome(b))
        if (run) $.ui.toast(`Task done. ${runLine(run)}`)
      } else if (e.reason === 'answer' && b.isOpen && !b.todos.some(t => t.status !== 'completed')) {
        // Keep going ran to the answer: the report shows the real cost next to the estimate.
        await markFirst($, b)
        const run = await closeWithCard($, closeOutcome(b))
        if (run) $.ui.toast(`Task done. ${runLine(run)}`)
      } else {
        // Claude answered the first task: keep what it cost, so the estimate can be checked against it.
        const kept = e.reason === 'answer' ? await markFirst($, b) : b
        const isNowDone = kept.firstCost !== undefined && b.firstCost === undefined
        if (isNowDone && kept.task && (kept.isOpen || kept.estimate)) {
          // The task that the estimate was made for has its answer: the budget closes, and the report shows the real cost.
          const run = await closeWithCard($, closeOutcome(kept))
          if (run) $.ui.toast(`Task done. ${runLine(run)}`)
        } else {
          if (isNowDone && kept.estimate) $.ui.toast(`Task done: ${usd(kept.firstCost ?? 0)}. The estimate was about ${usd(kept.estimate.likely)}.`)
          // The budget stays open: keep its spend in the history file current.
          const usage = await $.session.usage()
          await saveRun($, runOf({ ...kept, spent: spentOf(kept, usage.cost?.usd) }, 'open', iso(await $.clock.now())))
        }
      }
    } catch {
      // the budget stays open
    }
    return r
  })

  // After a compaction the chat is short again: measure it new.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId && 'messages' in r) {
        await update($, budget, c0 => {
          const c = live(c0)
          return c ? { ...c, ctxTokens: 0, lastAt: 0 } : c0
        })
      }
    } catch {
      // the next request measures it
    }
    return r
  })

  // The chat closes with a budget open: keep what it spent.
  on('session.end', async ($, e, next) => {
    try {
      const b = await cur($)
      if (b) {
        const usage = await $.session.usage()
        await saveRun($, runOf({ ...b, spent: spentOf(b, usage.cost?.usd) }, 'abandoned', iso(await $.clock.now())))
      }
    } catch {
      // nothing to keep
    }
    return next(e)
  })

  registerViews(on)
}
