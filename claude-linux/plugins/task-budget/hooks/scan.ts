// Reads past chats from disk into the price book.
// The file system comes in as `Io`, so the mod and the dev tools run the same code.

import { addSession, feed, feedEnd, ingest, isUnread, newFeed, newScan, type Book, type Scan } from './book.ts'

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }

export type Io = {
  list: (path: string) => Promise<Entry[]>
  /** The whole text of a file. It can fail on a big file. */
  read: (path: string) => Promise<string>
  /** The text of a file of any size, piece by piece. False when this machine cannot do it. */
  stream: (path: string, onPiece: (text: string) => void) => Promise<boolean>
  /** A short wait, so the chat stays quick while the book reads. */
  pause: () => Promise<void>
}

export type SessionFile = { key: string; path: string; dir: string; size: number; mtimeMs: number }

/** The engine reads at most 4 MiB in one call. Under this size a plain read is safe. */
const SMALL = 3_500_000

const JSONL = '.jsonl'

/** Every main chat under the projects folder, newest first. */
export async function findSessions(io: Io, root: string): Promise<SessionFile[]> {
  const out: SessionFile[] = []
  let projects: Entry[]
  try {
    projects = await io.list(root)
  } catch {
    return out
  }
  for (const p of projects) {
    if (p.kind !== 'dir') continue
    let entries: Entry[]
    try {
      entries = await io.list(`${root}/${p.name}`)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith(JSONL)) continue
      const key = e.name.slice(0, -JSONL.length)
      out.push({ key, path: `${root}/${p.name}/${e.name}`, dir: `${root}/${p.name}/${key}`, size: e.size, mtimeMs: e.mtimeMs })
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

async function readAny(io: Io, path: string, size: number): Promise<Scan | null> {
  if (size <= SMALL) {
    try {
      const scan = newScan()
      ingest(scan, await io.read(path))
      return scan
    } catch {
      // fall through to the stream
    }
  }
  const f = newFeed()
  const isRead = await io.stream(path, piece => feed(f, piece)).catch(() => false)
  return isRead ? feedEnd(f) : null
}

async function helperFiles(io: Io, dir: string, depth: number): Promise<{ path: string; size: number }[]> {
  let entries: Entry[]
  try {
    entries = await io.list(dir)
  } catch {
    return []
  }
  const out: { path: string; size: number }[] = []
  for (const e of entries) {
    if (e.kind === 'file' && e.name.startsWith('agent-') && e.name.endsWith(JSONL)) out.push({ path: `${dir}/${e.name}`, size: e.size })
    // Workflow helpers sit two folders down: subagents/workflows/<run>/agent-*.jsonl
    else if (e.kind === 'dir' && depth < 2) out.push(...(await helperFiles(io, `${dir}/${e.name}`, depth + 1)))
  }
  return out
}

/** One main chat and its helper chats. Null when the main chat cannot be read. */
export async function readSession(io: Io, file: SessionFile): Promise<{ main: Scan; subs: Scan[] } | null> {
  const main = await readAny(io, file.path, file.size)
  if (!main) return null
  const subs: Scan[] = []
  for (const h of await helperFiles(io, `${file.dir}/subagents`, 0)) {
    const scan = await readAny(io, h.path, h.size)
    if (scan) subs.push(scan)
  }
  return { main, subs }
}

export type Limits = {
  maxFiles: number
  maxBytes: number
  /** A file to leave out, such as the chat that is open now. */
  skip?: (file: SessionFile) => boolean
  isStopped?: () => boolean
}

export type Progress = { read: number; left: number; added: number; skipped: number }

/** Read the newest chats the book has not read yet, up to the limits. */
export async function scanSome(
  io: Io,
  book: Book,
  files: readonly SessionFile[],
  limits: Limits,
  onStep?: (p: Progress) => void,
): Promise<Progress> {
  const todo = files.filter(f => isUnread(book, f.key, f.mtimeMs) && !limits.skip?.(f))
  let read = 0
  let bytes = 0
  let added = 0
  let skipped = 0
  let i = 0
  for (; i < todo.length; i++) {
    const f = todo[i]
    if (!f || read >= limits.maxFiles || bytes >= limits.maxBytes || limits.isStopped?.()) break
    const got = await readSession(io, f).catch(() => null)
    if (!got) {
      skipped += 1
      book.skipped += 1
      book.seen[f.key] = [f.mtimeMs, book.seen[f.key]?.[1] ?? 0]
      continue
    }
    added += addSession(book, f.key, f.mtimeMs, got.main, got.subs)
    read += 1
    bytes += f.size
    book.bytes += f.size
    onStep?.({ read, left: todo.length - i - 1, added, skipped })
    await io.pause()
  }
  return { read, left: todo.length - i, added, skipped }
}
