/**
 * Live assistant-stream access for the handle-based 0.1.3-alpha.1 agent seam.
 *
 * Session format v2 (`f99b06e`) removed `assistant/chunk` from
 * `SessionEventMap`. An attempt's chunks are no longer appended to the log one
 * event at a time: they are published process-locally as
 * `agent/assistant-stream` frames and embedded, already compacted, in the one
 * durable event that settles the attempt — `assistant/message` for a committed
 * surface message, `assistant/attempt` for an attempt that committed none.
 *
 * Baseline: DeepSeek Harness 0.1.3-alpha.1
 * (d347e703908d0406b7a7ef80e3a0e594d86b2215):
 *
 * - `packages/core/agent/src/runtime-types.ts:74` declares
 *   {@link AssistantStreamFrame} (`start` / `chunk` / `end`).
 * - `packages/core/agent/src/runtime-types.ts:315` declares the
 *   `agent/assistant-stream` Context event, documented as "Process-local
 *   assistant-stream publication. Chunk frames are transient".
 * - `packages/core/session/src/types.ts:299` and `:313` show the two durable
 *   settlements that embed the same stream.
 *
 * The frames are therefore NOT session events: they carry no `seq`, are never
 * persisted, and are observable only while an Agent is attached in this
 * process. No amount of log reading can recover in-progress text, so a
 * projection built from `Session.snapshotEvents()` alone cannot see it.
 *
 * Upstream's own Web path consumes them at exactly this seam:
 * `packages/api/session-controller/src/history.ts:54` keeps a per-session
 * accumulator fed by `ctx.on('agent/assistant-stream', …, { global: true })`,
 * clears it on `agent/disposed` (`:62`), and `:165` republishes the frames on
 * the session follow stream, which the browser accumulates in
 * `packages/api/session-controller/src/client/sessions/assistant-stream.ts`
 * and expands for rendering with `expandAssistantStream`
 * (`packages/client/ui-chat/src/client/conversation-nodes/assistant.ts:7`).
 * This plugin's Host projection subscribes at the same Host-side seam.
 *
 * `assistant/attempt` is not a live source. It commits only for an attempt
 * that produced no surface message (failure, retry, cancellation, stream
 * error), and it lands at settlement, not during the stream — projecting from
 * it would still show nothing until the turn is over.
 *
 * The pinned 0.1.1-rc.2 devDependencies predate the event, so its payload is
 * declared structurally here, the same technique `adapter/session-log.ts` and
 * `adapter/session-delete.ts` already use for the rest of the ported surface.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Opens one model attempt's live publication. */
export interface AssistantStreamStartFrame {
  readonly type: 'start'
  readonly attemptId: unknown
  /** Monotone within one attached Agent lifecycle; replacement restarts at 1. */
  readonly revision: number
  readonly turn: number
  readonly step: number
}

/** One transient model chunk, in the same shape `BlockAssembler` consumes. */
export interface AssistantStreamChunkFrame {
  readonly type: 'chunk'
  readonly attemptId: unknown
  readonly revision: number
  /** Dense zero-based position within the attempt. */
  readonly index: number
  readonly time: number
  readonly chunk: unknown
}

/** Closes one attempt, after its durable settlement when there was one. */
export interface AssistantStreamEndFrame {
  readonly type: 'end'
  readonly attemptId: unknown
  readonly revision: number
  readonly index: number
  readonly outcome:
    | {
      readonly kind: 'committed'
      readonly eventType: 'assistant/message' | 'assistant/attempt'
      readonly seq: number
    }
    | { readonly kind: 'abandoned' }
}

/** One ordered process-local assistant-stream publication. */
export type AssistantStreamFrame =
  | AssistantStreamStartFrame
  | AssistantStreamChunkFrame
  | AssistantStreamEndFrame

/** The subset of `Agent` a stream publication is read through. */
export interface StreamingAgent {
  readonly session: { readonly id: unknown; readonly seq?: number }
}

export const ASSISTANT_STREAM_EVENT = 'agent/assistant-stream'
export const AGENT_DISPOSED_EVENT = 'agent/disposed'

/** The subset of `Context` these two agent-scoped events are attached through. */
interface AgentEventContext {
  on(
    name: string,
    listener: (payload: { agent?: StreamingAgent }) => void,
    options: { global: true },
  ): () => void
}

function sessionOf(payload: { agent?: StreamingAgent }): StreamingAgent['session'] | undefined {
  const session = payload.agent?.session
  return session === undefined || session === null ? undefined : session
}

/**
 * Observe every live assistant frame in this process.
 *
 * `{ global: true }` opts out of `@deepseek-ai/dsh-scope` agent-scoped
 * filtering, which is what a Host service watching every session needs and
 * what upstream's own session controller uses. Compositions without the event
 * simply never dispatch; registration itself is inert.
 * @param ctx - the Host context this plugin is loaded into.
 * @param listener - receives the owning session id, the frame, and the
 *   session's next-append seq at publication time.
 * @returns the listener disposer.
 */
export function subscribeAssistantStream(
  ctx: Context,
  listener: (sessionId: string, frame: AssistantStreamFrame, seq: number) => void,
): () => void {
  return (ctx as unknown as AgentEventContext).on(ASSISTANT_STREAM_EVENT, (payload) => {
    const session = sessionOf(payload)
    if (session === undefined) return
    const frame = (payload as { frame?: AssistantStreamFrame }).frame
    if (frame === undefined) return
    // `Session.seq` is the next append position, so the last durable event is
    // one below it. Seq and log offset are the same number on a contiguous
    // log, so nothing is converted here (see `adapter/session-log.ts`).
    const seq = typeof session.seq === 'number' && session.seq > 0 ? session.seq - 1 : 0
    listener(String(session.id), frame, seq)
  }, { global: true })
}

/**
 * Observe agent teardown, which retires any live stream that never ended.
 * @param ctx - the Host context this plugin is loaded into.
 * @param listener - receives the retired agent's session id.
 * @returns the listener disposer.
 */
export function subscribeAgentDisposed(
  ctx: Context,
  listener: (sessionId: string) => void,
): () => void {
  return (ctx as unknown as AgentEventContext).on(AGENT_DISPOSED_EVENT, (payload) => {
    const session = sessionOf(payload)
    if (session === undefined) return
    listener(String(session.id))
  }, { global: true })
}
