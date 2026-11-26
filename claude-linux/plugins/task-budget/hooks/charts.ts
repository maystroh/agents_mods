// The drawings of the budget panel. Pure code: each function returns one SVG as text.
// The grey of the labels reads on a light and on a dark panel.

import { ACCENT, BAD, GOOD, TRACK, usd } from './core.ts'

const INK = '#8a8f98'
const FONT = 'font-family="system-ui, -apple-system, sans-serif"'

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function open(w: number, h: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`
}

function label(x: number, y: number, text: string, o: { anchor?: 'start' | 'middle' | 'end'; size?: number; fill?: string; bold?: boolean } = {}): string {
  return `<text x="${x.toFixed(1)}" y="${y}" ${FONT} font-size="${o.size ?? 10}" fill="${o.fill ?? INK}" text-anchor="${o.anchor ?? 'start'}"${o.bold ? ' font-weight="600"' : ''}>${esc(text)}</text>`
}

function fit(width: number): number {
  return Math.max(160, Math.round(width))
}

/** Low, the estimate, and the limit on one line. */
export function rangeSvg(low: number, likely: number, limit: number, width: number, name: string): string {
  const w = fit(width)
  const top = Math.max(limit, likely) * 1.08 || 1
  const x = (v: number) => 4 + (Math.max(0, v) / top) * (w - 8)
  return (
    open(w, 40) +
    `<rect x="4" y="8" width="${w - 8}" height="8" rx="4" fill="${TRACK}" opacity="0.2"/>` +
    `<rect x="${x(low).toFixed(1)}" y="8" width="${Math.max(2, x(limit) - x(low)).toFixed(1)}" height="8" rx="4" fill="${ACCENT}" opacity="0.35"/>` +
    `<rect x="${(x(limit) - 1).toFixed(1)}" y="4" width="2" height="16" fill="${INK}"/>` +
    `<circle cx="${x(likely).toFixed(1)}" cy="12" r="6" fill="${ACCENT}"/>` +
    // The limit label ends at the right edge. The other label ends before it, so the two never touch.
    label(Math.min(x(likely) + 14, w - 2 - (`limit ${usd(limit)}`.length * 5.6 + 10)), 34, `${name} ${usd(likely)}`, { anchor: 'end', fill: ACCENT, bold: true }) +
    label(w - 2, 34, `limit ${usd(limit)}`, { anchor: 'end' }) +
    '</svg>'
  )
}

/** What each kind of task cost: a line from the cheap quarter to the dear tenth, and a dot at the middle. */
export function kindsSvg(kinds: readonly { name: string; n: number; p25: number; p50: number; p90: number }[], width: number): string {
  const w = fit(width)
  const list = kinds.slice(0, 8)
  const left = Math.min(120, Math.round(w * 0.36))
  const right = 46
  const top = Math.max(0.01, ...list.map(k => k.p90))
  const x = (v: number) => left + (v / top) * (w - left - right)
  const rh = 20
  const rows = list
    .map((k, i) => {
      const y = i * rh + 10
      return (
        label(0, y + 4, k.name.length > 18 ? `${k.name.slice(0, 17)}…` : k.name) +
        `<rect x="${x(k.p25).toFixed(1)}" y="${y - 2}" width="${Math.max(2, x(k.p90) - x(k.p25)).toFixed(1)}" height="4" rx="2" fill="${ACCENT}" opacity="0.35"/>` +
        `<circle cx="${x(k.p50).toFixed(1)}" cy="${y}" r="4" fill="${ACCENT}"/>` +
        label(w, y + 4, usd(k.p50), { anchor: 'end', bold: true })
      )
    })
    .join('')
  return open(w, Math.max(rh, list.length * rh)) + rows + '</svg>'
}

/** The last budgets: what each one spent, with a mark at its limit and a mark at its estimate. */
export function pastSvg(runs: readonly { spent: number; limit: number; likely: number; tone: string; task: string }[], width: number): string {
  const w = fit(width)
  const list = runs.slice(0, 6)
  const right = 46
  const left = Math.min(110, Math.round(w * 0.34))
  const rh = 20
  const rows = list
    .map((r, i) => {
      const y = i * rh + 4
      const top = Math.max(r.limit, r.spent, r.likely, 0.01)
      const x = (v: number) => left + (v / top) * (w - left - right)
      return (
        label(0, y + 10, r.task.length > 17 ? `${r.task.slice(0, 16)}…` : r.task || 'no task text') +
        `<rect x="${left}" y="${y + 2}" width="${(w - left - right).toFixed(1)}" height="8" rx="4" fill="${TRACK}" opacity="0.18"/>` +
        `<rect x="${left}" y="${y + 2}" width="${Math.max(2, x(r.spent) - left).toFixed(1)}" height="8" rx="4" fill="${r.tone}"/>` +
        (r.likely > 0 ? `<circle cx="${x(r.likely).toFixed(1)}" cy="${y + 6}" r="3" fill="none" stroke="${INK}" stroke-width="1.5"/>` : '') +
        `<rect x="${(x(r.limit) - 1).toFixed(1)}" y="${y}" width="2" height="12" fill="${INK}"/>` +
        label(w, y + 10, usd(r.spent), { anchor: 'end', bold: true })
      )
    })
    .join('')
  return open(w, Math.max(rh, list.length * rh)) + rows + '</svg>'
}

/** Where the money went: the main chat and each group of helpers, as parts of one bar. */
/** The colours of the parts, in order. The legend under the bar uses the same list. */
export const SPLIT_TINTS = [ACCENT, '#6a9bcc', '#788c5d', '#b0aea5'] as const

/** The height of the split bar. */
export const SPLIT_H = 14

/**
 * Where the money went, as one bar. Changed after 0.8.0: the names are no longer drawn in the picture. They overlapped when
 * one part was much bigger than the rest. The panel writes them as text under the bar, so they wrap at any width.
 */
export function splitSvg(parts: readonly { name: string; usd: number }[], width: number): string {
  const w = fit(width)
  const list = parts.filter(p => p.usd > 0)
  const total = list.reduce((sum, p) => sum + p.usd, 0) || 1
  let at = 0
  const bars = list
    .map((p, i) => {
      const width1 = (p.usd / total) * w
      const out = `<rect x="${at.toFixed(1)}" y="2" width="${Math.max(2, width1 - 1).toFixed(1)}" height="10" rx="3" fill="${SPLIT_TINTS[i % SPLIT_TINTS.length]}"/>`
      at += width1
      return out
    })
    .join('')
  return open(w, SPLIT_H) + bars + '</svg>'
}

/** The height of the odds curve, so the panel and the drawing agree. */
export const CURVE_H = 90

/**
 * The odds of the estimate as one curve: where the cost of such a task lands.
 * The shaded part is the band most such tasks land in. Marks: the likely cost, the limit (or the safe budget), and the spend so far.
 * Added in 0.7.5: each label sits under or over its own mark, and the drawing ends a little past the furthest amount that matters,
 * so a far safe budget does not squeeze the curve into the left side.
 */
export function curveSvg(points: readonly { usd: number; y: number }[], o: { likely: number; band?: readonly [number, number]; limit?: number; spent?: number; /** The verdict colour of the spend. */ tint?: string; /** No limit: the safe budget, drawn as a dashed mark when it fits. */ safe?: number }, width: number): string {
  const w = fit(width)
  const h = CURVE_H
  const base = h - 20
  const peak = 22
  const hasLimit = o.limit !== undefined && o.limit > 0
  const spent = o.spent !== undefined && o.spent > 0 ? o.spent : 0
  const room = Math.max(o.likely * 2.2, (o.band?.[1] ?? 0) * 1.1, spent * 1.12, hasLimit ? (o.limit ?? 0) * 1.06 : 0, 0.01)
  const showSafe = !hasLimit && o.safe !== undefined && o.safe > 0 && o.safe <= Math.max(room, o.likely * 3.5)
  const top = Math.max(room, showSafe ? (o.safe ?? 0) * 1.06 : 0)
  const x = (v: number) => 4 + (Math.max(0, Math.min(top, v)) / top) * (w - 8)
  const y = (v: number) => base - Math.max(0, Math.min(1, v)) * (base - peak)
  const pts = points.filter(p => p.usd <= top + 1e-9)
  const line = pts.map(p => `${x(p.usd).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const area = pts.length > 1 ? `<polygon points="${x(0).toFixed(1)},${base} ${line} ${x(pts[pts.length - 1]?.usd ?? 0).toFixed(1)},${base}" fill="${ACCENT}" opacity="0.12"/>` : ''
  const inBand = o.band ? pts.filter(p => p.usd >= (o.band?.[0] ?? 0) && p.usd <= (o.band?.[1] ?? 0)) : []
  const bandArea =
    o.band && inBand.length > 1
      ? `<polygon points="${x(inBand[0]?.usd ?? 0).toFixed(1)},${base} ${inBand.map(p => `${x(p.usd).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')} ${x(inBand[inBand.length - 1]?.usd ?? 0).toFixed(1)},${base}" fill="${ACCENT}" opacity="0.3"/>`
      : ''
  const isOver = hasLimit && spent > (o.limit ?? 0) + 1e-9
  const dot = o.tint ?? (isOver ? BAD : GOOD)
  const edge = hasLimit ? (o.limit ?? 0) : showSafe ? (o.safe ?? 0) : 0
  const edgeMark = edge > 0 ? `<line x1="${x(edge).toFixed(1)}" y1="${peak - 4}" x2="${x(edge).toFixed(1)}" y2="${base}" stroke="${hasLimit ? BAD : INK}" stroke-width="1" stroke-dasharray="${hasLimit ? '4 3' : '2 3'}" opacity="0.8"/>` : ''
  // The spend so far: a bar along the base and a dot at its end, both in the verdict colour.
  const spentMark = spent > 0 ? `<rect x="4" y="${base - 2}" width="${Math.max(1, x(spent) - 4).toFixed(1)}" height="3" fill="${dot}" opacity="0.85"/><circle cx="${x(spent).toFixed(1)}" cy="${base}" r="4.5" fill="${dot}"/>` : ''
  // Labels. Each one is placed at its own mark and kept inside the drawing; one that would touch another is left out.
  const CHAR = 6
  const place = (at: number, text: string): { x0: number; x1: number; mid: number } => {
    const half = (text.length * CHAR) / 2
    const mid = Math.max(4 + half, Math.min(w - 4 - half, at))
    return { x0: mid - half, x1: mid + half, mid }
  }
  const likelyText = `likely ${usd(o.likely)}`
  const lk = place(x(o.likely), likelyText)
  const edgeText = edge > 0 ? `${hasLimit ? 'limit' : 'safe'} ${usd(edge)}` : ''
  const ed = edgeText ? place(x(edge), edgeText) : null
  const nowText = spent > 0 ? `now ${usd(spent)}` : ''
  const nw = nowText ? place(x(spent), nowText) : null
  const touches = (a: { x0: number; x1: number } | null, b: { x0: number; x1: number } | null) => Boolean(a && b && a.x0 < b.x1 + 8 && b.x0 < a.x1 + 8)
  // Top row: the likely amount, and the limit or safe amount when it does not touch it.
  const topRow =
    label(lk.mid, 12, likelyText, { anchor: 'middle', fill: ACCENT, bold: true }) + (ed && !touches(lk, ed) ? label(ed.mid, 12, edgeText, { anchor: 'middle', ...(hasLimit ? { fill: BAD } : {}) }) : '')
  // Bottom row: the spend so far, under its dot, in the verdict colour.
  const bottomRow = nw ? label(nw.mid, h - 4, nowText, { anchor: 'middle', fill: dot, bold: true }) : ''
  return (
    open(w, h) +
    area +
    bandArea +
    (pts.length > 1 ? `<polyline points="${line}" fill="none" stroke="${ACCENT}" stroke-width="2"/>` : '') +
    `<rect x="4" y="${base}" width="${w - 8}" height="1" fill="${TRACK}" opacity="0.5"/>` +
    `<line x1="${x(o.likely).toFixed(1)}" y1="${peak - 4}" x2="${x(o.likely).toFixed(1)}" y2="${base}" stroke="${ACCENT}" stroke-width="1.5"/>` +
    edgeMark +
    spentMark +
    topRow +
    bottomRow +
    '</svg>'
  )
}
