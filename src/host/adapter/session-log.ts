/**
 * Session-log access for the handle-based persistence seam.
 *
 * Two upstream commits removed every log-reading surface this plugin used:
 * `bec6805` replaced `SessionPersistence.inspect` / `readFrom` /
 * `listSnapshots` with a per-session {@link StoredSessionHandle}
 * (`open`/`read`/`close`) plus `list`, and `f99b06e` (session format v2)
 * removed the `Session.events` accessor in favour of `snapshotEvents()` and
 * moved the durable fork cut off the header (`header.seedLength`) onto a
 * separate `inheritedEventCount` paired with the boolean `header.isSeeded`.
 *
 * Baseline: DeepSeek Harness 0.1.3-alpha.1
 * (d347e703908d0406b7a7ef80e3a0e594d86b2215).
 *
 * The package still type-checks against its pinned 0.1.1-rc.2 devDependencies,
 * which describe the removed surface, so the new one is declared structurally
 * here — the same technique `adapter/session-delete.ts` already uses — and
 * every call site goes through this module instead of the Service Definition's
 * stale types.
 *
 * ## Sequence numbers and log offsets
 *
 * `SessionSeq` and `SessionLogOffset` are distinct branded types that are both
 * plain numbers at runtime, so no conversion is applied anywhere in this
 * module. That is a determination, not an assumption: a session log is
 * contiguous from seq 0 and never rewritten, so the log array index and the
 * event seq are the same number. Upstream relies on exactly that identity —
 * `Session.eventAt(seq: SessionSeq)` indexes the same array that
 * `snapshotEvents(fromSeq: SessionLogOffset, …)` slices, and
 * `Session.isOwnSeq` compares a `SessionSeq` against `inheritedEventCount`
 * (a `SessionLogOffset`) with no conversion. A forked child re-numbers its
 * inherited prefix from seq 0, so the identity survives seeding. This plugin
 * already depended on it before the port (`adapter/session-fork.ts` asserts
 * `events[boundary].seq === boundary`).
 */

import {
  interruptedTurnClosers,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

/** The subset of the per-session storage handle this plugin reads through. */
export interface StoredSessionHandle {
  readonly header: SessionHeader
  /** Number of leading events inherited from the session's fork parent; `0` when unseeded. */
  readonly inheritedEventCount: number
  /**
   * Events with `seq >= offset`, at most `length` of them. `offset` is the
   * first logical event seq to include and defaults to the log start.
   */
  read(offset?: number, length?: number): Promise<readonly SessionEvent[]>
  close(): Promise<void>
}

/** The subset of the persistence Service Definition this plugin calls. */
export interface HandleSessionPersistence {
  open(id: SessionId, access: 'read' | 'write'): Promise<StoredSessionHandle>
  list(): Promise<readonly SessionPersistenceSnapshot[]>
}

/** The subset of the live Session log surface this plugin reads. */
interface LoggedSession {
  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly SessionEvent[]
  readonly inheritedEventCount: number
}

/** A stored or live session log paired with its durable fork cut. */
export interface SessionLogRead {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  /** Durable fork cut, or `undefined` when the session is not seeded. */
  readonly seedLength: number | undefined
}

/** Narrow the persistence Service Definition to the handle-based surface. */
export function handlePersistence(persistence: object): HandleSessionPersistence {
  return persistence as unknown as HandleSessionPersistence
}

/**
 * The durable fork cut in the shape this plugin has always consumed it.
 *
 * `header.seedLength` was `undefined` for an unseeded session and the exact
 * inherited prefix length otherwise; the replacement splits that into the
 * boolean `header.isSeeded` and a separate count, so recombine them rather
 * than reporting `0` where the plugin expects "absent".
 */
export function seedLengthOf(header: SessionHeader, inheritedEventCount: number): number | undefined {
  return (header as { readonly isSeeded?: boolean }).isSeeded === true ? inheritedEventCount : undefined
}

/** Immutable snapshot of a live Session's log, optionally from one seq onward. */
export function liveSessionEvents(session: Session, fromSeq = 0): readonly SessionEvent[] {
  return (session as unknown as LoggedSession).snapshotEvents(fromSeq)
}

/** The live Session's durable fork cut, in `header.seedLength` shape. */
export function liveSeedLength(session: Session): number | undefined {
  return seedLengthOf(session.header, (session as unknown as LoggedSession).inheritedEventCount)
}

/**
 * Read one complete stored session log, balanced for viewing.
 *
 * Replaces `SessionPersistence.inspect`, which returned synthetic closers for
 * a log whose writer crashed mid-turn. The handle seam returns the raw stored
 * prefix, so the closers are folded back in here exactly as upstream's own
 * cold-read helper does. The read handle takes no ownership and is always
 * closed.
 */
export async function readColdSessionLog(
  persistence: object,
  sessionId: SessionId,
): Promise<SessionLogRead> {
  const handle = await handlePersistence(persistence).open(sessionId, 'read')
  try {
    const stored = await handle.read(0)
    return {
      header: handle.header,
      events: [...stored, ...interruptedTurnClosers(stored)],
      seedLength: seedLengthOf(handle.header, handle.inheritedEventCount),
    }
  } finally {
    await closeQuietly(handle)
  }
}

/**
 * Read the stored events with `seq >= fromSeq`.
 *
 * Replaces `SessionPersistence.readFrom`, which was the detached read-from-seq
 * primitive: no synthetic closers, no preparation cache. `handle.read(offset)`
 * has the same contract — "the events with `seq >= offset`" — so no closers
 * are folded in here either.
 */
export async function readStoredSessionFrom(
  persistence: object,
  sessionId: SessionId,
  fromSeq: number,
): Promise<SessionLogRead> {
  const handle = await handlePersistence(persistence).open(sessionId, 'read')
  try {
    return {
      header: handle.header,
      events: await handle.read(fromSeq),
      seedLength: seedLengthOf(handle.header, handle.inheritedEventCount),
    }
  } finally {
    await closeQuietly(handle)
  }
}

/**
 * Release a read handle without masking a read failure.
 *
 * A read handle owns no write lease and buffers nothing — closing it only
 * frees local resources — so a close failure is never the actionable cause and
 * must not replace the error the caller is already propagating. Leaking one
 * cannot block a write open, the service-wide flush barrier, or a daemon
 * drain, but it does retain the parsed log until the plugin is disposed, so
 * every read path closes in a `finally`.
 */
async function closeQuietly(handle: StoredSessionHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    // Intentionally ignored; see above.
  }
}

/**
 * The seeded-child half of the Session store.
 *
 * Session format v2 moved the fork cut out of the creation metadata: `meta`
 * now carries only the boolean `isSeeded`, and the exact prefix length travels
 * as the sibling `inheritedEventCount` option, which the store validates
 * against the supplied seed.
 */
export interface SeededSessionStore {
  create(
    sessionId: SessionId | undefined,
    options: {
      readonly seed: readonly SessionEvent[]
      readonly inheritedEventCount: number
      readonly meta: object
    },
  ): Session
}

/** Narrow the Session store to its seeded-child creation surface. */
export function seededSessionStore(sessions: object): SeededSessionStore {
  return sessions as unknown as SeededSessionStore
}

/** Every stored session's header, without reading any event log. */
export function listStoredSessions(persistence: object): Promise<readonly SessionPersistenceSnapshot[]> {
  return handlePersistence(persistence).list()
}
