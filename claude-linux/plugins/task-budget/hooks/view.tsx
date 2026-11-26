import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { Budget, Card, Run } from '../types'
import { OFFER, PANE } from './names.ts'
import { ACCENT, BAD, GOOD, TRACK, WARN, bandLine, round2, costVerdict, verdict, forecast, modLines, hitLine, isHit, moneyParts, isOver, label, live, nextCost, reserveSpent, share, suggestAdd, defaultLimit, handoffModel, raiseTo, taskCost, tone, unit, usd } from './core.ts'
import { adjust, changeLimit, clearOffer, doneNow, endNow, handoffNow, kTokens, keepGoing, land, offerSoon, openPanel, raise, SCAN_DAYS, scanStart, setScan, start, startOffer, stopNow } from './engine.ts'
import { curvePoints, kindLabel, oddsLine, overOdds } from './estimator.ts'
import { family } from './book.ts'
import { CURVE_H, curveSvg, kindsSvg, pastSvg, rangeSvg, SPLIT_H, SPLIT_TINTS, splitSvg } from './charts.ts'
import { MODEL_NAMES, asFamily, routeName } from './picker.ts'

// What a person sees: the band above the prompt box, the cards in the chat, and the budget panel.
// Nothing here changes a budget by itself. Every button calls an action of engine.ts.

// The engine wants these names written in the file that reads them.
const REF = { plugin: 'task-budget', key: 'budget' } as const
const HIST_REF = { plugin: 'task-budget', key: 'history' } as const
const STOPS_REF = { plugin: 'task-budget', key: 'stops' } as const
const BOOK_REF = { plugin: 'task-budget', key: 'book' } as const
const budget = atom(REF, null)
const history = atom(HIST_REF, [])
const LAST_REF = { plugin: 'task-budget', key: 'last' } as const
const lastRun = atom(LAST_REF, null)
const stops = atom(STOPS_REF, {})
const bookView = atom(BOOK_REF, null)

type EstimateCard = Extract<Card, { kind: 'estimate' }>

// ---------- drawings ----------

function gaugeSvg(b: Budget, width: number, mark: number | null): string {
  const w = Math.max(120, Math.round(width))
  const fill = Math.max(b.spent > 0 ? 6 : 0, Math.min(w, Math.round(w * share(b))))
  const tick = (at: number) => `<rect x="${Math.round(w * at)}" y="0" width="1.5" height="14" fill="${TRACK}" opacity="0.55"/>`
  // Where the task is on course to end. Past the limit, it sits at the right edge in red.
  const at = mark === null ? '' : `<rect x="${Math.max(0, Math.min(w - 3, Math.round(w * Math.min(1, mark)) - 1))}" y="0" width="3" height="14" rx="1" fill="${mark > 1 ? BAD : ACCENT}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 14" width="${w}" height="14">` +
    `<rect x="0" y="2" width="${w}" height="10" rx="5" fill="${TRACK}" opacity="0.22"/>` +
    `<rect x="0" y="2" width="${fill}" height="10" rx="5" fill="${tone(b)}"/>` +
    tick(0.7) +
    tick(0.9) +
    // The estimate as a hollow mark, so the bar shows the spend against the estimate as well as the limit.
    (b.estimate && b.estimate.likely > 0 && b.limit > 0 && b.estimate.likely < b.limit ? `<rect x="${Math.round(w * (b.estimate.likely / b.limit)) - 1}" y="0" width="2" height="14" fill="${ACCENT}" opacity="0.9"/>` : '') +
    at +
    '</svg>'
  )
}

function barsSvg(b: Budget, width: number): string {
  const w = Math.max(120, Math.round(width))
  const list = b.bars.slice(-14)
  const top = Math.max(0.01, ...list)
  const step = w / 14
  const rects = list
    .map((cost, i) => {
      const tall = Math.max(2, Math.round((cost / top) * 40))
      return `<rect x="${(i * step + 2).toFixed(1)}" y="${44 - tall}" width="${(step - 4).toFixed(1)}" height="${tall}" rx="2" fill="${ACCENT}" opacity="${i === list.length - 1 ? 1 : 0.6}"/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 46" width="${w}" height="46">` +
    `<rect x="0" y="45" width="${w}" height="1" fill="${TRACK}" opacity="0.4"/>` +
    rects +
    '</svg>'
  )
}

function textBar(b: Budget, cells: number): string {
  const full = Math.max(0, Math.min(cells, Math.round(cells * share(b))))
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

function stepBar(spent: number, amount: number, cells: number): string {
  const part = amount > 0 ? spent / amount : spent > 0 ? 1 : 0
  const full = Math.max(0, Math.min(cells, Math.round(cells * part)))
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
}

// ---------- words ----------

/** The cost of the next request while the chat is warm. 0 when the budget has not measured the chat yet. */
function perRequest(b: Budget): number {
  if (!(b.ctxTokens > 0)) return 0
  return nextCost(b, b.lastModel || b.model, { ctx: 0, now: b.lastAt }).cost
}

/** The first letter as a capital, for a line that starts a row. */
function cap(text: string): string {
  return text.slice(0, 1).toUpperCase() + text.slice(1)
}

function outcomeName(o: Run['outcome'], isOpen = false): string {
  if (o === 'under') return 'Done'
  if (o === 'over') return isOpen ? 'Done, no limit' : 'Done, budget was raised'
  if (o === 'stopped') return 'Stopped'
  if (o === 'ended') return 'Ended'
  if (o === 'replaced') return 'Replaced'
  if (o === 'abandoned') return 'Chat closed'
  return 'Open'
}

function outcomeTone(o: Run['outcome']): string {
  if (o === 'under') return GOOD
  if (o === 'over') return WARN
  return o === 'stopped' ? BAD : TRACK
}

function checkWord(check: string | undefined): string {
  return check === 'met' ? 'check met' : check === 'unmet' ? 'check not met' : ''
}

function times(n: number): string {
  return `${(Math.round(n * 100) / 100).toString()} times`
}

function total(units: Budget['used']): number {
  return Object.values(units).reduce((sum: number, n) => sum + (n ?? 0), 0)
}

/** "Sonnet at medium", or the model alone when the effort level is not known. */
function ranOn(model: string | undefined, effort: string | undefined): string {
  if (effort) return routeName({ model: model ?? '', effort })
  const fam = asFamily(family(model))
  return fam ? MODEL_NAMES[fam] : ''
}

/** "62%": the chance that the task passes the limit. Empty when there is no estimate with a measured band, or no limit. */
function passLine(b: Budget): string {
  const e = b.estimate
  if (!e || !e.usual || b.isOpen || b.firstCost !== undefined || !(b.limit > 0)) return ''
  return `${Math.round(overOdds(e, b.spent, b.limit) * 100)}% chance to pass the limit`
}

/** The verdict of a finished run, from its stored cost, estimate and limit. Null when the run had no estimate. */
function runVerdict(run: Run): ReturnType<typeof costVerdict> | null {
  const e = run.estimate
  if (!e || !(e.likely > 0)) return null
  const cost = taskCost(run) ?? run.spent
  const hasLimit = !run.isTrack && !run.isOpen && run.limit > 0
  return costVerdict({ spent: cost, likely: e.likely, safe: e.safe, limit: hasLimit ? run.limit : null })
}

function offerOf(all: Record<string, Card> | null | undefined): EstimateCard | null {
  const card = all && typeof all === 'object' ? all[OFFER] : undefined
  return card && card.kind === 'estimate' ? card : null
}

export function registerViews(on: Parameters<Register>[0]): void {
  // The cards in the chat: a stop, an estimate, a report. Display only.
  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'task-budget') return next(e)
    const all = await read($, stops)
    const card = all && typeof all === 'object' ? all[e.props.id] : undefined
    if (!card) return next(e)
    const { Box, Text } = $.ui.resolve(e)

    if (card.kind === 'stop') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={BAD} paddingX={1}>
          <Text color={BAD} bold>
            Budget stop: {usd(card.spent)} of {usd(card.limit)} spent
          </Text>
          <Text>Claude stopped before the next request, so the limit is not passed. No work is lost.</Text>
          <Text dimColor>To go on, choose above the prompt box: Raise the limit, or Hand off to a cheaper model. You can also type /budget add 2.</Text>
        </Box>
      )
    }

    if (card.kind === 'handoff') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text color={ACCENT} bold>
            Handed off: open a new chat on {card.model}
          </Text>
          {card.isPanel ? (
            <Text>The Handoff panel above the prompt box writes a full handoff of this chat. Press Start new chat there, then pick {card.model}.</Text>
          ) : (
            <Text>
              {card.isCopied ? 'The handoff note is copied.' : 'The copy did not work. Copy the note from the file below.'} Open a new chat, pick {card.model}, and paste the note.
            </Text>
          )}
          <Text dimColor>{card.isPanel ? 'A short note is also in' : 'The note is also in'} {card.file}. Claude stopped here. No work is lost.</Text>
        </Box>
      )
    }

    if (card.kind === 'estimate') {
      const est = card.estimate
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text color={ACCENT} bold>
            Estimate: about {usd(est.likely)}
          </Text>
          <Text>
            {cap(bandLine(est))} · {kindLabel(est.kind)} · {est.confidence} confidence
          </Text>
          {est.usual && est.hold ? <Text>{oddsLine(est)}</Text> : null}
          {est.base && est.base.usd >= 0.01 ? (
            <Text>
              Chat start: {kTokens(est.base.tokens)} tokens, {usd(est.base.usd)}. Work: {usd(Math.max(0, est.likely - est.base.usd))}.
            </Text>
          ) : null}
          {card.route ? <Text dimColor>Priced for {routeName(card.route)}. Your settings do not change.</Text> : null}
          <Text dimColor>Suggested limit {usd(defaultLimit(est))}: {est.times ?? 1.5} times the likely cost. This is a limit, not the estimate.</Text>
          {card.task ? (
            <Text dimColor wrap="truncate-end">
              {card.task}
            </Text>
          ) : null}
          {card.steps.map((st, i) => (
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Text wrap="truncate-end">
                {i + 1}. {st.name}
              </Text>
              <Text tabular>{usd(st.usd)}</Text>
            </Box>
          ))}
          {est.basis ? <Text dimColor>{est.basis}</Text> : null}
          {est.unsure.length > 0 ? <Text dimColor>Not sure about: {est.unsure.slice(0, 3).join('; ')}</Text> : null}
          {est.cost > 0 ? <Text dimColor>The estimate cost {usd(est.cost)}.</Text> : null}
        </Box>
      )
    }

    if (card.kind === 'profile') {
      const pr = card.profile
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Text color={ACCENT} bold>
            How you work: the last {pr.days} days
          </Text>
          <Text>
            {pr.tasks} tasks · {usd(pr.usd)} at list prices
          </Text>
          {pr.kinds.slice(0, 6).map(k => (
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Text wrap="truncate-end">
                {cap(kindLabel(k.kind))} · {k.n} tasks
              </Text>
              <Text tabular>
                about {usd(k.p50)} each · {usd(k.usd)}
              </Text>
            </Box>
          ))}
          {pr.models.length > 0 ? <Text dimColor>Models: {pr.models.map(m => `${ranOn(m.name, undefined) || m.name} ${m.n} tasks, ${usd(m.usd)}`).join(' · ')}</Text> : null}
          {pr.efforts.length > 0 ? <Text dimColor>Effort levels: {pr.efforts.map(x => `${x.name} ${x.n}`).join(' · ')}</Text> : null}
          <Text dimColor>The mod read the chat files on this computer only. The next estimates start from these numbers.</Text>
        </Box>
      )
    }

    if (card.kind !== 'report') return next(e)
    const run = card.run
    const est = run.estimate
    // The estimate was made for the first task: compare it with that task, not with later messages.
    const cost = taskCost(run)
    const v = runVerdict(run)
    const color = run.outcome === 'stopped' ? BAD : v ? v.tint : outcomeTone(run.outcome)
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold>
            Budget report: {run.isOpen ? `${usd(run.spent)} spent · no limit (was ${usd(run.limit)})` : `${usd(run.spent)} of ${usd(run.limit)}`}
          </Text>
          <Text color={color} bold>
            {outcomeName(run.outcome, run.isOpen)}
            {v ? ` · ${v.text}` : ''}
          </Text>
        </Box>
        {run.task ? (
          <Text dimColor wrap="truncate-end">
            {run.task}
          </Text>
        ) : null}
        {est && est.likely > 0 ? (
          <Text>
            The estimate was about {usd(est.likely)} ({bandLine(est)}).
            {cost === null ? '' : ` The task cost ${usd(cost)}: ${times(cost / est.likely)} the estimate.`}
          </Text>
        ) : null}
        {(run.steps ?? []).map((st, i) => (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Text wrap="truncate-end">
              {i + 1}. {st.name}
            </Text>
            <Text tabular color={st.usd > 0 && st.spent > st.usd + 0.005 ? BAD : undefined}>
              {st.usd > 0 ? `${usd(st.spent)} of ${usd(st.usd)}` : usd(st.spent)}
              {checkWord(st.check) ? ` · ${checkWord(st.check)}` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })

  // The band above the prompt box: the numbers, and the buttons for the choice that waits.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = live(await read($, budget))
    const offer = offerOf(await read($, stops))
    if (e.props.hasSurvey || (!b && !offer)) return next(e)
    const bandEls = $.ui.resolve(e)
    const { Box, Button, Text } = bandEls
    // The desktop draws the bar as a picture: the text glyphs came out tiny there.
    const BandSvg = e.surface !== 'terminal' && 'Svg' in bandEls ? bandEls.Svg : undefined
    // Another mod can draw here too. Only one tree wins, so its drawing goes inside ours.
    const beneath = (await next(e)) ?? null

    const offerRow = offer ? (
      <Box flexDirection="row" gap={1}>
        <Text color={ACCENT} bold>
          ● Estimate ready
        </Text>
        <Text>
          about {usd(offer.estimate.likely)}, {bandLine(offer.estimate)}
        </Text>
        <Button key="offer-track" label="Start, no limit" variant="primary" onPress={async () => { $.ui.toast(await startOffer($, 'track')) }} />
        <Button key="offer-default" label={`Start, limit ${usd(defaultLimit(offer.estimate))}`} onPress={async () => { $.ui.toast(await startOffer($, 'default')) }} />
        <Button key="offer-drop" label="Dismiss" onPress={() => clearOffer($)} />
      </Box>
    ) : null

    if (!b) {
      return (
        <Box flexDirection="column">
          {beneath}
          {offerRow}
        </Box>
      )
    }

    const color = tone(b)
    const f = forecast(b)

    if (b.isPaused) {
      // 0.8.0: the same three choices as the pause question: Raise the limit, Hand off to a cheaper model, Stop.
      const to = raiseTo(b, perRequest(b), f)
      const cheaper = handoffModel(b.lastModel || b.model)
      return (
        <Box flexDirection="column">
          {beneath}
          {offerRow}
          <Text>
            <Text color={BAD} bold>
              ● Budget stop
            </Text>
            {'  '}
            {usd(b.spent)} of {usd(b.limit)} spent{b.estimate ? `, the estimate was about ${usd(b.estimate.likely)}` : ''}. No work is lost.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="raise" label={`Raise the limit to ${usd(to)}`} variant="primary" onPress={async () => { $.ui.toast((await changeLimit($, to)).text) }} />
            {cheaper && !b.isHandedOff ? <Button key="handoff" label="Hand off to a cheaper model" onPress={async () => { $.ui.toast(await handoffNow($)) }} /> : null}
            <Button key="end" label="End budget" onPress={async () => { $.ui.toast(await endNow($)) }} />
            <Button key="panel" label="Open Budget Panel" onPress={() => openPanel($)} />
          </Box>
          <Text dimColor>
            {b.isHandedOff
              ? 'Handed off: the work moves to a new chat on a cheaper model. Or raise the limit to go on here.'
              : `Raise the limit to ${usd(to)}: Claude carries on here.${cheaper ? ' Hand off: the work moves to a new chat on a cheaper model.' : ''} End budget: the count stops.`}
          </Text>
        </Box>
      )
    }

    if (b.waiting) {
      return (
        <Box flexDirection="column">
          {beneath}
          <Box flexDirection="row" gap={1}>
            <Text color={WARN} bold>
              ● Budget pause
            </Text>
            <Text>{b.waiting}</Text>
            <Text dimColor>Answer the question in the chat. No work is lost.</Text>
          </Box>
        </Box>
      )
    }

    if (b.phase === 'landing') {
      return (
        <Box flexDirection="column">
          {beneath}
          <Box flexDirection="row" gap={1}>
            <Text color={WARN} bold>
              ● Finishing
            </Text>
            <Text>
              {b.isOpen ? `${usd(b.spent)} spent` : `${usd(b.spent)} / ${usd(b.limit)}`}. Claude writes its last answer. No new work starts.
            </Text>
            <Button key="panel" label="Open Budget Panel" onPress={() => openPanel($)} />
          </Box>
        </Box>
      )
    }

    const p = b.plan
    const at = p ? p.steps.findIndex(st => st.state === 'active') : -1
    const cur = p?.steps[at]
    const v = verdict(b)
    const isHigh = v.key === 'likelyOver'
    const pass = passLine(b)

    return (
      <Box flexDirection="column">
        {beneath}
        {offerRow}
        {/* Changed after 0.8.0: two lines, not one row of seven columns. In one row each column got a narrow strip
            and wrapped word by word. Line 1: the spend, the bar and the button. Line 2: the facts, as one text that wraps. */}
        <Box flexDirection="row" gap={1} alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={1}>
            <Text color={color}>●</Text>
            <Text bold>
              {b.isTrack ? `Task ${usd(b.spent)}` : b.isOpen ? `Budget ${usd(b.spent)} spent` : `Budget ${usd(b.spent)} / ${usd(b.limit)}`}
            </Text>
            {b.isOpen ? null : BandSvg ? <BandSvg source={gaugeSvg(b, 180, f && b.limit > 0 ? f.usd / b.limit : null)} alt={`${Math.round(share(b) * 100)}% of the budget is used`} width={180} height={14} /> : <Text color={color}>{textBar(b, 20)}</Text>}
          </Box>
          <Button key="panel" label="Open Budget Panel" onPress={() => openPanel($)} />
        </Box>
        <Text dimColor>
          {b.isTrack ? 'no limit' : b.isOpen ? `no limit (was ${usd(b.limit)})` : `${usd(b.limit - b.spent)} left`}
          {b.estimate ? ` · estimate about ${usd(b.estimate.likely)}` : ''}
          {' · '}
          <Text color={v.tint} bold>
            {v.text}
          </Text>
          {cur && p ? (
            <Text color={isOver(cur) ? BAD : undefined}>
              {' · '}Step {at + 1}/{p.steps.length}
            </Text>
          ) : null}
          {f ? (
            <Text color={isHigh ? BAD : undefined}>
              {' · '}on course for {usd(f.usd)}
              {pass ? ` · ${pass}` : ''}
            </Text>
          ) : null}
        </Text>
      </Box>
    )
  })

  // The small text beside the model picker. It shows only while a task runs on a model and effort level the person took from the advice.
  // The engine draws text only in this place.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const b = live(await read($, budget))
    const text = b && b.route && b.phase === 'run' ? `This task: ${routeName(b.route)}` : ''
    if (!text) return next(e)
    if (e.surface === 'desktop' || e.surface === 'vscode') {
      // Other mods write here too: their text stays, and ours comes after it.
      const { Box, Text } = $.ui.resolve(e)
      const beneath = (await next(e)) ?? null
      return (
        <Box flexDirection="row" gap={1}>
          {beneath}
          <Text color={ACCENT}>{text}</Text>
        </Box>
      )
    }
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, text] } })
  })

  // The budget panel.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const b = live(await read($, budget))
    const stored = await read($, history)
    const past = Array.isArray(stored) ? stored : []
    const view = await read($, bookView)
    const offer = offerOf(await read($, stops))
    const done = b ? null : await read($, lastRun)
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const Input = 'Input' in els ? els.Input : undefined
    const columns = Math.max(24, e.props.bodyColumns ?? 40)
    const pixels = Math.min(460, Math.max(160, columns * 7 - 16))

    const head = (text: string, side = '') => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor bold>
          {text}
        </Text>
        {side ? <Text dimColor>{side}</Text> : null}
      </Box>
    )
    /** One chart, or its short text form where a drawing cannot show. */
    const chart = (source: string, height: number, alt: string) => (Svg ? <Svg source={source} alt={alt} width={pixels} height={height} /> : <Text dimColor>{alt}</Text>)
    // Where the money went: the bar, then the names as text under it. Text wraps, so no name runs into the next one.
    const split = (ps: readonly { name: string; usd: number }[]) => {
      const alt = ps.map(x => `${x.name} ${usd(x.usd)}`).join(' · ')
      if (!Svg) return <Text dimColor>{alt}</Text>
      return (
        <Box flexDirection="column">
          <Svg source={splitSvg(ps, pixels)} alt={alt} width={pixels} height={SPLIT_H} />
          <Text dimColor>
            {ps.map((x, i) => (
              <Text key={`part-${i}`}>
                <Text color={SPLIT_TINTS[i % SPLIT_TINTS.length]}>●</Text> {x.name} {usd(x.usd)}
                {i < ps.length - 1 ? '   ' : ''}
              </Text>
            ))}
          </Text>
        </Box>
      )
    }

    // ---------- parts both screens share ----------

    const recent = past
      .filter(r => r.id !== b?.id && r.outcome !== 'open')
      .slice(-6)
      .reverse()
    const pastRows =
      recent.length === 0 ? null : (
        <Box flexDirection="column">
          {head('Last budgets', '▮ limit  ○ estimate')}
          {chart(
            pastSvg(
              recent.map(r => ({ spent: r.spent, limit: r.isOpen ? r.spent : r.limit, likely: r.estimate?.likely ?? 0, tone: r.outcome === 'stopped' ? BAD : runVerdict(r)?.tint ?? outcomeTone(r.outcome), task: r.task })),
              pixels,
            ),
            Math.max(20, recent.length * 20),
            recent.map(r => `${usd(r.spent)} of ${usd(r.limit)}`).join(' · '),
          )}
        </Box>
      )

    const kinds = view?.kinds ?? []
    const bookRows =
      kinds.length === 0 ? null : (
        <Box flexDirection="column">
          {head('What your tasks cost', `${view?.tasks ?? 0} past tasks`)}
          {chart(
            kindsSvg(
              kinds.map(k => ({ name: kindLabel(k.kind), n: k.n, p25: k.p25, p50: k.p50, p90: k.p90 })),
              pixels,
            ),
            Math.max(20, Math.min(8, kinds.length) * 20),
            kinds.map(k => `${kindLabel(k.kind)} ${usd(k.p50)}`).join(' · '),
          )}
        </Box>
      )

    // How good the estimates are: the last three tasks, and the count of the last 20.
    const last3 = (view?.recent ?? []).slice(0, 3)
    const hits = hitLine(view?.score ?? null)
    const proofRows =
      last3.length === 0 && !hits ? null : (
        <Box flexDirection="column">
          {head('Your last tasks', 'estimate and real cost')}
          {last3.map(r => {
            const cost = taskCost(r)
            const likely = r.estimate?.likely ?? 0
            const ok = cost !== null && likely > 0 && isHit(cost, likely)
            return (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={ok ? GOOD : WARN} bold>
                    {ok ? '✓' : '✗'}
                  </Text>
                  <Text wrap="truncate-end">{r.task || 'no task text'}</Text>
                </Box>
                <Text dimColor>
                  {[ranOn(r.model, r.effort), `estimate ${usd(likely)}`, cost === null ? '' : `real ${usd(cost)}`, ok ? 'hit' : `miss${r.why ? `: ${r.why}` : ''}`].filter(Boolean).join(' · ')}
                </Text>
              </Box>
            )
          })}
          {hits ? <Text bold>{hits}</Text> : null}
          {view?.score && view.score.n > 0 ? <Text dimColor>A hit is a real cost inside 2 times the estimate. Each finished task corrects the next estimate of its kind.</Text> : null}
        </Box>
      )

    const oe = offer?.estimate
    const offerRows =
      offer && oe ? (
        <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="flex-end">
            <Text bold size="title" tabular color={ACCENT}>
              {usd(oe.likely)}
            </Text>
            <Text dimColor>
              estimate · {kindLabel(oe.kind)} · {oe.confidence} confidence
            </Text>
          </Box>
          {oe.usual ? chart(curveSvg(curvePoints(oe), { likely: oe.likely, band: [oe.likely / 2, oe.likely * 2], safe: oe.safe }, pixels - 16), CURVE_H, oddsLine(oe)) : chart(rangeSvg(oe.low, oe.likely, oe.safe, pixels - 16, 'estimate'), 40, `${usd(oe.low)} to ${usd(oe.safe)}`)}
          {oe.usual && oe.hold ? <Text>{oddsLine(oe)}</Text> : null}
          {oe.base && oe.base.usd >= 0.01 ? (
            <Text>
              Chat start: {kTokens(oe.base.tokens)} tokens, {usd(oe.base.usd)}. Work: {usd(Math.max(0, oe.likely - oe.base.usd))}.
            </Text>
          ) : null}
          {offer.route ?<Text dimColor>Priced for {routeName(offer.route)}. Your settings do not change.</Text> : null}
          <Text dimColor wrap="truncate-end">
            {offer.task}
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="p-offer-track" label="Start, no limit" variant="primary" onPress={async () => { $.ui.toast(await startOffer($, 'track')) }} />
            <Button key="p-offer-default" label={`Limit ${usd(defaultLimit(oe))}`} onPress={async () => { $.ui.toast(await startOffer($, 'default')) }} />
            <Button key="p-offer-drop" label="Dismiss" onPress={() => clearOffer($)} />
          </Box>
        </Box>
      ) : null

    const taskInput = Input ? (
      <Input
        key="task"
        label="Estimate a task"
        placeholder="build the pricing page"
        submitLabel="estimate"
        onSubmit={async value => {
          const task = value.trim()
          if (task.length < 8) {
            $.ui.toast('Type the task in a few words, for example: build the pricing page.')
            return
          }
          $.ui.toast('Estimating the cost. In about 20 seconds you can start with no limit or with a limit.')
          offerSoon($, task, false)
        }}
      />
    ) : null

    // ---------- the task that finished last: what it cost, against the estimate, step by step ----------

    const doneRows = (() => {
      if (!done) return null
      const cost = taskCost(done) ?? done.spent
      const likely = done.estimate?.likely ?? 0
      const ok = likely > 0 && isHit(cost, likely)
      const hasLimit = !done.isTrack && !done.isOpen && done.limit > 0
      // The same verdict the running panel showed last: the same cost, the same estimate, the same limit.
      const v = runVerdict(done) ?? costVerdict({ spent: cost, limit: hasLimit ? done.limit : null })
      const state =
        done.outcome === 'stopped'
          ? { text: `Stopped · ${v.text}`, tint: BAD }
          : done.outcome === 'over'
            ? { text: `Done, over the first limit · ${v.text}`, tint: v.tint === GOOD ? WARN : v.tint }
            : { text: `Task done · ${v.text}`, tint: v.tint }
      const secs = done.secs ?? 0
      const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : secs > 0 ? `${secs} s` : ''
      const tile = (name: string, value: string, tint?: string) => (
        <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
          <Text dimColor>{name}</Text>
          <Text bold color={tint} tabular>
            {value}
          </Text>
        </Box>
      )
      const steps = done.steps ?? []
      const inSteps = steps.reduce((sum, st) => sum + st.spent, 0)
      const loose = Math.max(0, done.spent - inSteps)
      const parts = done.parts ?? []
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Box flexDirection="row" gap={1} alignItems="flex-end">
                <Text bold size="title" tabular>
                  {usd(done.spent)}
                </Text>
                <Text dimColor>{hasLimit ? `of ${usd(done.limit)}` : 'no limit'}</Text>
              </Box>
              <Text color={state.tint} bold>
                ● {state.text}
              </Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {done.task || 'no task text'}
            </Text>
            <Text dimColor>{[`Ran on ${ranOn(done.model, done.effort)}`, time, `${done.messages} ${done.messages === 1 ? 'message' : 'messages'}`].filter(Boolean).join(' · ')}</Text>
          </Box>

          <Box flexDirection="row" gap={1}>
            {tile('Task cost', usd(cost))}
            {likely > 0 ? tile('Estimate', usd(likely)) : null}
            {likely > 0 ? tile('Against the estimate', times(cost / likely), v.tint) : null}
            {hasLimit ? tile('Limit not used', usd(Math.max(0, done.limit - done.spent))) : null}
          </Box>
          {likely > 0 ? (
            <Text dimColor>
              {ok ? 'For the estimate score this is a hit: the real cost is inside 2 times the estimate.' : `For the estimate score this is a miss: the real cost is not inside 2 times the estimate${done.why ? ` (${done.why})` : ''}.`}
            </Text>
          ) : null}

          {steps.length > 0 ? (
            <Box flexDirection="column">
              {head('What each step cost', steps.some(st => st.usd > 0) ? 'real cost of planned' : 'real cost')}
              {done.ticked ? (
                <Text dimColor>
                  Claude did not tick {done.ticked === 1 ? '1 step' : `${done.ticked} steps`} in its list. The mod marked {done.ticked === 1 ? 'it' : 'them'} done. Their cost is in the step that was open at the time.
                </Text>
              ) : null}
              {steps.map((st, i) => {
                const isSkip = st.check === 'skipped' || st.check === 'not done'
                const isHigh = st.usd > 0 && st.spent > st.usd * 2 && st.spent - st.usd > 0.1
                return (
                  <Box flexDirection="row" justifyContent="space-between" gap={2}>
                    <Box flexDirection="row" gap={1}>
                      <Text color={isSkip ? TRACK : GOOD}>{isSkip ? '○' : '✓'}</Text>
                      <Text wrap="truncate-end" dimColor={isSkip}>
                        {i + 1}. {st.name}
                      </Text>
                    </Box>
                    <Text tabular color={isHigh ? WARN : undefined}>
                      {st.usd > 0 ? `${usd(st.spent)} of ${usd(st.usd)}` : usd(st.spent)}
                    </Text>
                  </Box>
                )
              })}
              {loose > 0.01 ? (
                <Box flexDirection="row" justifyContent="space-between" gap={2}>
                  <Text dimColor>Not in a step</Text>
                  <Text dimColor tabular>
                    {usd(loose)}
                  </Text>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {parts.length > 0 ? (
            <Box flexDirection="column">
              {head('Where the money went', done.loadTokens ? `${kTokens(done.loadTokens)} tokens at the start` : '')}
              {parts.length > 1 ? split(parts) : <Text>{parts.map(x => `${x.name} ${usd(x.usd)}`).join(' · ')}</Text>}
            </Box>
          ) : null}

          {/* Added in 0.8.0: what the mod's own calls cost, and the whole bill of the chat. */}
          {typeof done.session === 'number' ? (
            <Box flexDirection="column">
              {head('Mod cost')}
              {modLines(done.mod ?? 0, done.session).map((line, i) => (
                <Text key={`mod-${i}`} tabular>
                  {line}
                </Text>
              ))}
            </Box>
          ) : null}

          {head('Next task')}
        </Box>
      )
    })()

    if (!b) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          {doneRows ?? (
            <Text bold size="title">
              Task Budget
            </Text>
          )}
          {offerRows}
          {taskInput}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Text dimColor>Or start now</Text>
            <Button key="start1" label="$1" onPress={async () => { $.ui.toast((await start($, 1, '', { isForced: true })).text) }} />
            <Button key="start3" label="$3" onPress={async () => { $.ui.toast((await start($, 3, '', { isForced: true })).text) }} />
            <Button key="start5" label="$5" onPress={async () => { $.ui.toast((await start($, 5, '', { isForced: true })).text) }} />
          </Box>
          {proofRows}
          {bookRows}
          {pastRows}
          {view?.state === 'reading' ? null : <Button key="learn" label={`Learn from my last ${SCAN_DAYS} days of chats`} onPress={async () => { await setScan($, 'yes'); $.ui.toast(await scanStart($, { days: SCAN_DAYS, profile: true })) }} />}
        </Box>
      )
    }

    // ---------- a budget runs ----------
    // Each thing in this panel answers one question: what did I spend, where will it end, where is the work, where did the money go, what can I do.

    const v = verdict(b)
    const color = v.tint
    const left = b.limit - b.spent
    const est = perRequest(b)
    const f = forecast(b)
    const e0 = b.estimate
    const isDone = b.firstCost !== undefined
    const isHigh = v.key === 'likelyOver'
    const mark = f && b.limit > 0 && !b.isOpen ? f.usd / b.limit : null
    const pass = passLine(b)
    // One verdict for the badge, the colours and the graph. A finished task keeps the verdict of its last running state.
    const badge = isDone ? { text: `Task done · ${v.text}`, tint: v.tint } : { text: v.text, tint: v.tint }
    const runsOn = b.route ? routeName(b.route) : ranOn(b.lastModel || b.model, b.effort)
    const tile = (name: string, value: string, tint?: string) => (
      <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
        <Text dimColor>{name}</Text>
        <Text bold color={tint} tabular>
          {value}
        </Text>
      </Box>
    )
    const cost = b.firstCost ?? b.spent
    const tiles = isDone
      ? [
          tile('Task cost', usd(cost)),
          e0 ? tile('Estimate', usd(e0.likely)) : null,
          e0 && e0.likely > 0 ? tile('Against the estimate', times(cost / e0.likely), v.tint) : null,
        ]
      : [
          b.isOpen ? null : tile('Left', usd(left), color),
          f ? tile('On course for', usd(f.usd), isHigh ? BAD : undefined) : tile('Next request', est > 0 ? usd(est) : '…'),
          e0 ? tile('Estimate', usd(e0.likely), e0.likely > 0 && b.spent > e0.likely + 0.005 ? v.tint : undefined) : null,
        ]

    // The plan. A plan from the estimate is a guide: the mod reads the chat and moves the steps, so its rows have no buttons.
    // A budget plan that Claude made keeps - and + on each dollar amount.
    const p = b.plan
    const by = unit(b)
    const cells = Math.min(16, Math.max(8, columns - 26))
    const at = p ? p.steps.findIndex(st => st.state === 'active') : -1
    const isGuide = Boolean(p && p.byTool === false)
    // The plan follows Claude's own task list: its steps have a real cost and no planned dollars.
    const isList = Boolean(p && p.source === 'todos')
    const guideRow = (st: NonNullable<Budget['plan']>['steps'][number], i: number) => {
      const isNow = st.state === 'active'
      const isOk = st.state === 'done'
      return (
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexDirection="row" gap={1}>
            <Text color={isNow ? ACCENT : isOk ? GOOD : TRACK}>{isOk ? '✓' : isNow ? '●' : '○'}</Text>
            <Text wrap="truncate-end" bold={isNow} dimColor={!isNow && !isOk}>
              {i + 1}. {st.name}
            </Text>
          </Box>
          <Text tabular bold={isNow} dimColor={!isNow}>
            {st.usd > 0 ? (st.spent >= 0.005 ? `${usd(st.spent)} of ${usd(st.usd)}` : `about ${usd(st.usd)}`) : st.spent >= 0.005 || isOk ? usd(st.spent) : ''}
            {isNow ? (st.usd > 0 || st.spent >= 0.005 ? ' · now' : 'now') : ''}
          </Text>
        </Box>
      )
    }
    const row = (id: string, name: string, amount: number, used: number, dot: string, state1: string, target: number | 'reserve') => (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={dot}>●</Text>
          <Text wrap="truncate-end" bold={state1.startsWith('now')}>
            {name}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Button key={`minus-${id}`} label="-" onPress={() => adjust($, target, -by)} />
          <Text bold tabular>
            {usd(amount)}
          </Text>
          <Button key={`plus-${id}`} label="+" onPress={() => adjust($, target, by)} />
          <Text color={used > amount + 0.005 ? BAD : dot}>{stepBar(used, amount, cells)}</Text>
          <Text dimColor tabular>
            {usd(used)}
            {state1 ? ` · ${state1}` : ''}
          </Text>
        </Box>
      </Box>
    )
    const stateOf = (st: NonNullable<Budget['plan']>['steps'][number]): string => {
      if (st.state === 'cut') return 'skipped'
      const base = isOver(st) ? 'over' : st.state === 'active' ? 'now' : st.state === 'done' ? 'done' : ''
      const check = st.state === 'done' ? checkWord(st.check) : ''
      return [base, check].filter(Boolean).join(' · ')
    }
    // The same rounding as the finished summary: the rounded spend minus the rounded steps, so both show the same cents.
    const loose = p ? (isList ? Math.max(0, round2(round2(b.spent) - p.steps.reduce((sum, st) => sum + round2(st.spent), 0))) : reserveSpent(b, p)) : 0
    const planRows = !p ? null : p.steps.length === 0 ? (
      <Text dimColor>Claude is writing the plan.</Text>
    ) : isGuide ? (
      <Box flexDirection="column">
        {head(isList ? "Claude's task list" : 'Plan', (isDone ? 'all steps done' : at >= 0 ? `step ${at + 1} of ${p.steps.length}` : '') + (isList ? ' · real cost' : ''))}
        {p.steps.map((st, i) => guideRow(st, i))}
        {isList && p.ticked ? <Text dimColor>Claude's list was behind. The mod moved it on from what Claude did.</Text> : null}
        {loose > 0.01 ? (
          <Box flexDirection="row" justifyContent="space-between" gap={2}>
            <Text dimColor>Not in a step</Text>
            <Text dimColor tabular>
              {usd(loose)}
            </Text>
          </Box>
        ) : null}
      </Box>
    ) : (
      <Box flexDirection="column" gap={1}>
        {head('Plan', '')}
        {p.steps.map((st, i) =>
          row(String(i), `${i + 1}. ${st.name}`, st.usd, st.spent, st.state === 'cut' ? TRACK : isOver(st) ? BAD : st.state === 'active' ? ACCENT : st.state === 'done' ? GOOD : TRACK, stateOf(st), i),
        )}
        {row('r', 'Buffer', p.reserve, loose, loose > p.reserve + 0.005 ? BAD : TRACK, loose > p.reserve + 0.005 ? 'over' : '', 'reserve')}
      </Box>
    )

    // Where the money went, scaled to the bill: the same parts as the report card.
    const parts = moneyParts(b)
    const alert = b.isPaused
      ? { tint: BAD, text: 'Stopped. Claude and its helpers are stopped. Raise the limit, hand off to a cheaper model, or end the budget.' }
      : b.waiting
        ? { tint: WARN, text: `Paused: ${b.waiting} Answer in the chat.` }
        : b.phase === 'landing'
          ? { tint: WARN, text: 'Finishing: Claude writes its last answer.' }
          : isHigh && !b.isOpen && f
            ? { tint: BAD, text: `On course for about ${usd(f.usd)}, more than the budget.` }
            : null
    const stepAt = p && isGuide ? Math.max(at + 1, Math.min(p.steps.length, b.left?.step ?? 0)) : 0
    const progress =
      isDone || !b.left
        ? ''
        : `About ${Math.round(b.left.part * 100)}% of the work is done${stepAt && p ? ` · step ${stepAt} of ${p.steps.length}` : ''}`

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexDirection="row" gap={1} alignItems="flex-end">
              <Text bold size="title" tabular>
                {usd(b.spent)}
              </Text>
              <Text dimColor>{b.isOpen ? 'no limit' : `of ${usd(b.limit)}`}</Text>
            </Box>
            <Text color={badge.tint} bold>
              ● {badge.text}
            </Text>
          </Box>
          {runsOn ? <Text dimColor>{b.route ? 'This task runs on' : 'Runs on'} {runsOn}</Text> : null}
        </Box>

        {b.isOpen ? null : Svg ? <Svg source={gaugeSvg(b, pixels, mark)} alt={`${Math.round(share(b) * 100)}% of the budget is used`} width={pixels} height={14} /> : <Text color={color}>{textBar(b, Math.min(30, columns - 4))}</Text>}
        {alert ? <Text color={alert.tint}>{alert.text}</Text> : null}

        <Box flexDirection="row" gap={1}>
          {tiles}
        </Box>

        {e0 ? (
          <Box flexDirection="column">
            {head('Estimate', `${kindLabel(e0.kind)} · ${e0.confidence} confidence`)}
            {e0.usual
              ? chart(curveSvg(curvePoints(e0), { likely: e0.likely, band: [e0.likely / 2, e0.likely * 2], spent: cost, tint: v.tint, ...(b.isOpen ? { safe: e0.safe } : { limit: b.limit }) }, pixels), CURVE_H, `${oddsLine(e0)} Now ${usd(cost)}: ${v.text.toLowerCase()}.`)
              : chart(rangeSvg(e0.low, e0.likely, e0.safe, pixels, 'estimate'), 40, `About ${usd(e0.likely)}, ${bandLine(e0)}. Now ${usd(cost)}: ${v.text.toLowerCase()}.`)}
            <Text color={v.tint}>
              {isDone ? 'The task cost' : 'Spent so far'} {usd(cost)} against an estimate of {usd(e0.likely)}: {v.text.toLowerCase()}.
            </Text>
            {e0.usual && e0.hold ? <Text dimColor>{oddsLine(e0)}</Text> : null}
            {e0.base && e0.base.usd >= 0.01 ? (
              <Text dimColor>
                {e0.base.guess
                  ? `In the estimate: chat start ${kTokens(e0.base.tokens)} tokens, ${usd(e0.base.usd)}, measured in this chat (the guess was ${kTokens(e0.base.guess.tokens)}). Work ${usd(Math.max(0, e0.likely - e0.base.usd))}.`
                  : `In the estimate: chat start ${kTokens(e0.base.tokens)} tokens, ${usd(e0.base.usd)}. Work ${usd(Math.max(0, e0.likely - e0.base.usd))}.`}
              </Text>
            ) : (
              <Text dimColor>Chat start: not in this estimate. The chat was not new, so no start cost was added.</Text>
            )}
            {progress ? <Text>{progress}</Text> : null}
            {pass && !isDone ? <Text color={isHigh ? BAD : undefined} dimColor={!isHigh}>{cap(pass)}</Text> : null}
          </Box>
        ) : progress ? (
          <Text>{progress}</Text>
        ) : null}

        {planRows}

        {parts.filter(x => x.usd >= 0.01).length > 1 ? (
          <Box flexDirection="column">
            {head('Where the money went', b.load && (b.load.usd ?? 0) >= 0.01 ? `${kTokens(b.load.tokens)} tokens at the start` : '')}
            {split(parts.filter(x => x.usd >= 0.01))}
          </Box>
        ) : null}

        {/* Added in 0.8.0: what the mod's own calls cost this run, and the whole bill of the chat. */}
        <Box flexDirection="column">
          {head('Mod cost')}
          {modLines(b.modCost ?? 0, b.startCost + b.spent).map((line, i) => (
            <Text key={`mod-${i}`} tabular>
              {line}
            </Text>
          ))}
        </Box>

        {b.bars.length > 1 ? (
          <Box flexDirection="column">
            {head('Cost of each message', `${b.messages} sent`)}
            {chart(barsSvg(b, pixels), 46, b.bars.slice(-6).map(c => usd(c)).join('  '))}
          </Box>
        ) : null}

        <Box flexDirection="column">
          {head('Limit')}
          {b.isOpen ? null : (
            // Changed in the subagent fixes: the same buttons as the pause question.
            <Box flexDirection="row" gap={1}>
              <Button key="raise" label={`Raise the limit to ${usd(raiseTo(b, perRequest(b), f))}`} variant={b.isPaused ? 'primary' : 'secondary'} onPress={async () => { $.ui.toast((await changeLimit($, raiseTo(b, perRequest(b), forecast(b)))).text) }} />
              {handoffModel(b.lastModel || b.model) && !b.isHandedOff ? <Button key="handoff" label="Hand off to a cheaper model" onPress={async () => { $.ui.toast(await handoffNow($)) }} /> : null}
              {b.isPaused ? <Button key="end" label="End budget" onPress={async () => { $.ui.toast(await endNow($)) }} /> : <Button key="stop" label="Stop" onPress={async () => { $.ui.toast(await stopNow($)) }} />}
            </Box>
          )}
          {Input ? (
            <Input
              key="limit"
              label={b.isOpen ? 'Set a limit of $' : 'Set the limit to $'}
              placeholder={b.limit.toFixed(2)}
              submitLabel="set"
              onSubmit={async value => {
                const to = Number(value.replace(/[$,\s]/g, ''))
                if (!(to > 0)) {
                  $.ui.toast('Type a number of dollars, for example 5.')
                  return
                }
                $.ui.toast((await changeLimit($, to)).text)
              }}
            />
          ) : null}
        </Box>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key="done" label="Task is done" variant="primary" onPress={async () => { $.ui.toast(await doneNow($)) }} />
          </Box>
          <Text dimColor>Task is done: close and show the report. Stop: Claude and its helpers stop at once, and no work is lost.</Text>
        </Box>

        {offerRows}
        {proofRows}
      </Box>
    )
  })
}
