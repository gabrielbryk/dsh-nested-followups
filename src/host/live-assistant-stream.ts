/**
 * Process-local accumulation of the assistant text a live turn has produced.
 *
 * Session format v2 stopped persisting per-chunk events, so the only source of
 * in-progress assistant text is the transient `agent/assistant-stream`
 * publication described in `adapter/assistant-stream.ts`. This tracker holds
 * at most one attempt per session — the current one — and folds its chunks
 * into the same `BlockAssembler` the removed `assistant/chunk` branch used, so
 * the Tree View's live node keeps rendering exactly the text it did before.
 *
 * Nothing here is durable. The tracker is dropped on the attempt's `end`
 * frame, on agent teardown, and on Host disposal; the durable
 * `assistant/message` remains the authoritative record of what was said.
 */

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import type { AssistantStreamFrame } from './adapter/assistant-stream.ts'
import { sourceText, type LiveAssistantStream } from './projection.ts'

interface ActiveStream {
  attemptId: string
  revision: number
  turn: number
  step: number
  seq: number
  time: number
  chunks: number
  text: string
  assembler: BlockAssembler
}

/** One live attempt per session, folded into renderable text. */
export class LiveAssistantStreams {
  private readonly active = new Map<string, ActiveStream>()

  /**
   * Fold one ordered frame into the session's live attempt.
   * @param sessionId - the session that owns the publishing agent.
   * @param frame - one start, chunk, or end publication.
   * @param seq - the session's last durable seq at publication time.
   * @returns whether the frame changed what a reader would see.
   */
  accept(sessionId: string, frame: AssistantStreamFrame, seq: number): boolean {
    if (frame.type === 'start') {
      // A replacement attempt restarts revision numbering, so a start frame is
      // always authoritative and always replaces whatever was accumulating.
      this.active.set(sessionId, {
        attemptId: String(frame.attemptId),
        revision: frame.revision,
        turn: frame.turn,
        step: frame.step,
        seq,
        time: Date.now(),
        chunks: 0,
        text: '',
        assembler: new BlockAssembler(),
      })
      return true
    }
    const current = this.active.get(sessionId)
    if (current === undefined) return false
    // Frames from a superseded attempt must not reopen a retired live node.
    if (String(frame.attemptId) !== current.attemptId || frame.revision !== current.revision) return false
    if (frame.type === 'end') {
      this.active.delete(sessionId)
      return true
    }
    try {
      current.assembler.push(frame.chunk as never)
    } catch {
      // A corrupted or future chunk kind must not make the entire tree
      // unreadable. The durable assistant/message remains authoritative.
    }
    current.chunks += 1
    try {
      current.text = sourceText(current.assembler.blocks())
    } catch {
      // A malformed or future block kind keeps the last renderable prefix;
      // the durable final assistant/message is still authoritative.
    }
    return true
  }

  /** Retire a session's live attempt, e.g. when its agent is disposed. */
  clear(sessionId: string): void {
    this.active.delete(sessionId)
  }

  /** Retire every live attempt on Host disposal. */
  clearAll(): void {
    this.active.clear()
  }

  /** The session's current in-progress attempt, if one is streaming. */
  get(sessionId: string): LiveAssistantStream | undefined {
    const current = this.active.get(sessionId)
    if (current === undefined) return undefined
    return Object.freeze({
      turn: current.turn,
      step: current.step,
      seq: current.seq,
      time: current.time,
      chunks: current.chunks,
      text: current.text,
    })
  }
}
