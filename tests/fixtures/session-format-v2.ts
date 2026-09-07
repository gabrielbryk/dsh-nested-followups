/**
 * Present the pinned pre-v2 Session runtime in the session-format-v2 shape.
 *
 * The package's devDependencies pin DeepSeek Harness 0.1.1-rc.2, but the
 * plugin is deployed against 0.1.3-alpha.1
 * (d347e703908d0406b7a7ef80e3a0e594d86b2215), whose `f99b06e` replaced the
 * `Session.events` accessor with `snapshotEvents()` and moved the durable fork
 * cut off the header (`header.seedLength`) onto a separate
 * `inheritedEventCount` paired with the boolean `header.isSeeded`.
 *
 * 0.1.3-alpha.1 is not published to the registry, so the suite cannot install
 * it. This shim adapts every Session the pinned store mints into the v2 shape
 * instead, so the tests exercise the contract the plugin is actually ported to
 * rather than the one it was written against.
 */

import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

interface PreV2Header extends SessionHeader {
  readonly seedLength?: number
}

let installed = false

function upgrade<T>(value: T): T {
  const candidate = value as { header?: PreV2Header, inheritedEventCount?: number }
  if (candidate?.header === undefined || candidate.inheritedEventCount !== undefined) return value
  const { seedLength, ...rest } = candidate.header
  Object.defineProperty(value, 'header', {
    value: Object.freeze({ ...rest, isSeeded: seedLength !== undefined }),
    writable: true,
    enumerable: true,
    configurable: true,
  })
  Object.defineProperty(value, 'inheritedEventCount', {
    value: seedLength ?? 0,
    enumerable: false,
    configurable: true,
  })
  return value
}

/** Install the shim once per worker. Idempotent. */
export function installSessionFormatV2Shim(): void {
  if (installed) return
  installed = true

  const sessionProto = Session.prototype as unknown as Record<string, unknown>
  sessionProto['snapshotEvents'] = function (
    this: Session,
    fromSeq = 0,
    toSeqExclusive?: number,
  ): readonly SessionEvent[] {
    // A session log is contiguous from seq 0, so the log index and the event
    // seq are the same number and no conversion is needed here either.
    return Object.freeze(this.events.slice(fromSeq, toSeqExclusive ?? this.events.length))
  }

  const storeProto = SessionStore.prototype as unknown as Record<string, (...args: never[]) => unknown>
  for (const name of ['create', 'prepare', 'fork'] as const) {
    const original = storeProto[name]
    if (typeof original !== 'function') continue
    const rewritesOptions = name !== 'fork'
    storeProto[name] = function (this: SessionStore, ...args: never[]): unknown {
      // `create`/`prepare` take the options object second; `fork` takes the
      // live source session there and must be passed through untouched.
      const applied = rewritesOptions && args.length > 1
        ? ([args[0], downgradeCreateOptions(args[1])] as unknown as never[])
        : args
      return upgrade(original.apply(this, applied))
    }
  }
}

/**
 * Translate v2 seeded-child creation back to the pinned runtime's vocabulary.
 *
 * The plugin now passes `inheritedEventCount` beside a `meta.isSeeded` marker;
 * the pinned store still expects the numeric cut inside `meta.seedLength`.
 */
function downgradeCreateOptions(argument: unknown): unknown {
  const options = argument as {
    inheritedEventCount?: number
    meta?: { isSeeded?: boolean } & Record<string, unknown>
  } | undefined | null
  if (options === null || options === undefined || typeof options !== 'object') return argument
  if (options.inheritedEventCount === undefined && options.meta?.isSeeded === undefined) return argument
  const { inheritedEventCount, meta, ...rest } = options
  const { isSeeded, ...metaRest } = meta ?? {}
  return {
    ...rest,
    meta: isSeeded === true
      ? { ...metaRest, seedLength: inheritedEventCount ?? 0 }
      : metaRest,
  }
}

installSessionFormatV2Shim()
