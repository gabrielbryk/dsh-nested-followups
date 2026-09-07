import { clearTimeout, setTimeout } from 'node:timers'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import type {
  BranchCommandResult,
  ContinueBranchRequest,
  CreateBranchRequest,
  DeleteBranchRequest,
  DeleteBranchResult,
  TreeReadRequest,
  TreeReadResult,
  TreeSnapshot,
  TreeWatchRequest,
  TreeWatchResult,
} from '../shared/remote.ts'
import type { BranchRecord, TreeRecord } from '../shared/types.ts'
import type { NestedFollowupsBranchService } from './branch-service.ts'
import type { NestedFollowupsDeleteService } from './delete-service.ts'
import type { NestedFollowupsMetadataService } from './metadata-service.ts'
import {
  listStoredSessions,
  liveSeedLength,
  liveSessionEvents,
  readStoredSessionFrom,
} from './adapter/session-log.ts'
import {
  subscribeAgentDisposed,
  subscribeAssistantStream,
  type AssistantStreamFrame,
} from './adapter/assistant-stream.ts'
import { LiveAssistantStreams } from './live-assistant-stream.ts'
import { isDirectlyDeleted, projectConversationTree, type SessionLogSnapshot } from './projection.ts'

const WATCH_TIMEOUT_MS = 15_000
const STREAM_TOUCH_INTERVAL_MS = 50

declare module '@deepseek-ai/cordis' {
  interface Context {
    nestedFollowups: NestedFollowupsService
  }
}

interface TreeOwnership {
  readonly rootSessionId: string
  readonly tree: TreeRecord | undefined
}

type RevisionWaiter = (changed: boolean) => void

function success<T>(value: T): { readonly ok: true; readonly value: T } {
  return Object.freeze({ ok: true, value })
}

function sessionNotFound(sessionId: string): TreeReadResult & TreeWatchResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: 'session-not-found', sessionId }),
  })
}

function mutationUnavailable(): BranchCommandResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: 'compatibility',
      message: 'Branch creation is unavailable in this DSH composition.',
    }),
  })
}

function deletionUnavailable(message = 'Branch cleanup is unavailable in this DSH composition.'): DeleteBranchResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({ code: 'compatibility', message }),
  })
}

function syntheticTree(header: SessionHeader): TreeRecord {
  return Object.freeze({
    treeId: String(header.id),
    rootSessionId: String(header.id),
    version: 1,
    createdAt: header.createdAt,
    updatedAt: header.createdAt,
  })
}

function snapshotHeaderMap(
  snapshots: readonly SessionPersistenceSnapshot[],
): ReadonlyMap<string, SessionHeader> {
  return new Map(snapshots.map(snapshot => [String(snapshot.header.id), snapshot.header] as const))
}

/** Host Remote for complete tree reads and event-driven long polling. */
export class NestedFollowupsService extends TypertRemoteService {
  static inject = [
    'nestedFollowupsMetadata',
    'sessionPersistence',
    'sessions',
  ]

  private readonly revisions = new Map<string, number>()
  private readonly waiters = new Map<string, Set<RevisionWaiter>>()
  private readonly pendingStreamTouches = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly streams = new LiveAssistantStreams()
  private disposed = false

  constructor(ctx: Context) {
    super(ctx, 'nestedFollowups')
    ctx.on('session/event', (session) => {
      this.onSessionEvent(String(session.id))
    }, { global: true })
    // Session format v2 does not persist assistant chunks, so in-progress text
    // arrives only on this transient publication (`adapter/assistant-stream.ts`).
    subscribeAssistantStream(ctx, (sessionId, frame, seq) => {
      this.onAssistantStreamFrame(sessionId, frame, seq)
    })
    subscribeAgentDisposed(ctx, (sessionId) => {
      this.streams.clear(sessionId)
      this.onSessionEvent(sessionId)
    })
    ctx.on('nested-followups/change', (rootSessionId) => {
      this.touchRoot(rootSessionId)
    })
    ctx.effect(() => () => {
      this.disposed = true
      for (const listeners of this.waiters.values()) {
        for (const listener of listeners) listener(false)
      }
      this.waiters.clear()
      for (const timer of this.pendingStreamTouches.values()) clearTimeout(timer)
      this.pendingStreamTouches.clear()
      this.streams.clearAll()
    }, 'nested-followups.tree-watch')
  }

  /** Notify active readers after a metadata or Session-log change. */
  touchRoot(rootSessionId: string): void {
    const current = this.revisions.get(rootSessionId) ?? 0
    const next = current === Number.MAX_SAFE_INTEGER ? 0 : current + 1
    this.revisions.set(rootSessionId, next)
    const listeners = this.waiters.get(rootSessionId)
    if (listeners === undefined) return
    this.waiters.delete(rootSessionId)
    for (const listener of listeners) listener(true)
  }

  /** A durable append always supersedes a coalescing live-text touch. */
  private onSessionEvent(sessionId: string): void {
    const rootSessionId = this.rootSessionIdFor(sessionId)
    this.cancelStreamTouch(rootSessionId)
    this.touchRoot(rootSessionId)
  }

  /**
   * Publish live assistant text without one revision per model chunk.
   *
   * Attempt boundaries are rare and change what is rendered structurally, so
   * they notify immediately; chunk frames coalesce into one bounded revision.
   */
  private onAssistantStreamFrame(sessionId: string, frame: AssistantStreamFrame, seq: number): void {
    if (!this.streams.accept(sessionId, frame, seq)) return
    const rootSessionId = this.rootSessionIdFor(sessionId)
    if (frame.type !== 'chunk') {
      this.cancelStreamTouch(rootSessionId)
      this.touchRoot(rootSessionId)
      return
    }
    if (this.pendingStreamTouches.has(rootSessionId)) return
    const timer = setTimeout(() => {
      this.pendingStreamTouches.delete(rootSessionId)
      if (!this.disposed) this.touchRoot(rootSessionId)
    }, STREAM_TOUCH_INTERVAL_MS)
    this.pendingStreamTouches.set(rootSessionId, timer)
  }

  private cancelStreamTouch(rootSessionId: string): void {
    const pending = this.pendingStreamTouches.get(rootSessionId)
    if (pending === undefined) return
    clearTimeout(pending)
    this.pendingStreamTouches.delete(rootSessionId)
  }

  /** Read a complete, de-duplicated projection without attaching cold Agents. */
  async readTree(request: TreeReadRequest): Promise<TreeReadResult> {
    const ownership = this.resolveOwnership(request.sessionId)
    const persisted = await listStoredSessions(this.ctx.sessionPersistence)
    const persistedHeaders = snapshotHeaderMap(persisted)
    const requestedHeader = this.headerFor(request.sessionId, persistedHeaders)
    if (requestedHeader === undefined) return sessionNotFound(request.sessionId)

    const tree = ownership.tree ?? syntheticTree(requestedHeader)
    const revision = this.revisions.get(ownership.rootSessionId) ?? 0
    const branches = ownership.tree === undefined
      ? Object.freeze([]) as readonly BranchRecord[]
      : this.metadata.repository.listBranches(tree.treeId)
    const logs = new Map<string, SessionLogSnapshot>()

    const rootLog = await this.readLog(ownership.rootSessionId, 0, persistedHeaders)
    if (rootLog !== undefined) logs.set(ownership.rootSessionId, rootLog)
    // A marked branch is dropped by the projection, and its session is being
    // archived or is already gone, so reading its log only costs a persistence
    // round trip during cascade deletion.
    await Promise.all(branches.map(async (branch) => {
      if (isDirectlyDeleted(branch)) return
      const log = await this.readLog(branch.sessionId, branch.seedLength, persistedHeaders)
      if (log !== undefined) logs.set(branch.sessionId, log)
    }))

    const mutationCapabilities = this.branches?.capabilities() ?? Object.freeze({
      askFollowUp: false,
      continueBranch: false,
      nativeBranchContinuation: false,
      reason: 'The branch mutation service is unavailable.',
    })
    const deletion = this.deletion?.capabilities() ?? Object.freeze({
      supported: false as const,
      reason: 'The branch deletion service is unavailable.',
    })
    const snapshot: TreeSnapshot = Object.freeze({
      rootSessionId: ownership.rootSessionId,
      revision,
      capabilities: Object.freeze({ ...mutationCapabilities, deletion }),
      projection: projectConversationTree(tree, branches, logs),
    })
    return success(snapshot)
  }

  /** Wait for one revision, returning no projection on an idle timeout. */
  async watchTree(request: TreeWatchRequest): Promise<TreeWatchResult> {
    const rootSessionId = this.rootSessionIdFor(request.sessionId)
    let revision = this.revisions.get(rootSessionId) ?? 0
    if (request.afterRevision !== revision) {
      const read = await this.readTree(request)
      return read.ok ? success({ changed: true, snapshot: read.value }) : read
    }

    const changed = await this.waitForRevision(rootSessionId)
    revision = this.revisions.get(rootSessionId) ?? 0
    if (!changed || this.disposed) return success({ changed: false, revision })
    const read = await this.readTree(request)
    return read.ok ? success({ changed: true, snapshot: read.value }) : read
  }

  /** Create a new child branch to the right of one safe assistant boundary. */
  createBranch(request: CreateBranchRequest): Promise<BranchCommandResult> {
    return Promise.resolve(this.branches?.createBranch(request) ?? mutationUnavailable())
  }

  /** Append one ordinary turn to the bottom of an existing branch. */
  continueBranch(request: ContinueBranchRequest): Promise<BranchCommandResult> {
    return Promise.resolve(this.branches?.continueBranch(request) ?? mutationUnavailable())
  }

  /** Delete one complete branch subtree using the advertised cleanup mode. */
  async deleteBranch(request: DeleteBranchRequest): Promise<DeleteBranchResult> {
    const deletion = this.deletion
    if (deletion === undefined) return deletionUnavailable()
    const read = await this.readTree({ sessionId: request.ownerSessionId })
    if (!read.ok) {
      return Object.freeze({
        ok: false,
        error: Object.freeze({
          code: 'tree-mismatch',
          message: `session '${request.ownerSessionId}' does not own an available conversation tree`,
        }),
      })
    }
    const visibleMessagesByBranch = new Map<string, number>()
    for (const node of read.value.projection.nodes) {
      if (node.branchId === null) continue
      visibleMessagesByBranch.set(
        node.branchId,
        (visibleMessagesByBranch.get(node.branchId) ?? 0) + 1,
      )
    }
    return deletion.deleteBranch(request, visibleMessagesByBranch)
  }

  private get metadata(): NestedFollowupsMetadataService {
    return this.ctx.nestedFollowupsMetadata
  }

  private get branches(): NestedFollowupsBranchService | undefined {
    return this.ctx.get('nestedFollowupsBranches')
  }

  private get deletion(): NestedFollowupsDeleteService | undefined {
    return this.ctx.get('nestedFollowupsDeletion')
  }

  private resolveOwnership(sessionId: string): TreeOwnership {
    const branch = this.metadata.repository.getBranchBySession(sessionId)
    if (branch !== undefined) {
      const tree = this.metadata.repository.getTree(branch.treeId)
      if (tree !== undefined) return { rootSessionId: tree.rootSessionId, tree }
    }
    const tree = this.metadata.repository.getTreeByRootSession(sessionId)
    return { rootSessionId: tree?.rootSessionId ?? sessionId, tree }
  }

  private rootSessionIdFor(sessionId: string): string {
    return this.resolveOwnership(sessionId).rootSessionId
  }

  private liveSession(sessionId: string): Session | undefined {
    return this.ctx.sessions.get(sessionId as SessionId)
  }

  private headerFor(
    sessionId: string,
    persistedHeaders: ReadonlyMap<string, SessionHeader>,
  ): SessionHeader | undefined {
    return this.liveSession(sessionId)?.header ?? persistedHeaders.get(sessionId)
  }

  private async readLog(
    sessionId: string,
    fromSeq: number,
    persistedHeaders: ReadonlyMap<string, SessionHeader>,
  ): Promise<SessionLogSnapshot | undefined> {
    const live = this.liveSession(sessionId)
    if (live !== undefined) {
      // `fromSeq` is a branch's own durable seed cut, which is a log position
      // in the branch session: seq and log offset are the same number on a
      // contiguous log, so it is passed through unconverted.
      const seedLength = liveSeedLength(live)
      const liveStream = this.streams.get(sessionId)
      return {
        sessionId,
        events: liveSessionEvents(live, fromSeq),
        ...(seedLength === undefined ? {} : { seedLength }),
        ...(liveStream === undefined ? {} : { liveStream }),
      }
    }
    if (!persistedHeaders.has(sessionId)) return undefined
    const stored = await readStoredSessionFrom(this.ctx.sessionPersistence, sessionId as SessionId, fromSeq)
    return {
      sessionId,
      events: stored.events,
      ...(stored.seedLength === undefined ? {} : { seedLength: stored.seedLength }),
    }
  }

  private waitForRevision(rootSessionId: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    return new Promise((resolve) => {
      let settled = false
      const listeners = this.waiters.get(rootSessionId) ?? new Set<RevisionWaiter>()
      const finish = (changed: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        listeners.delete(finish)
        if (listeners.size === 0 && this.waiters.get(rootSessionId) === listeners) {
          this.waiters.delete(rootSessionId)
        }
        resolve(changed)
      }
      const timer = setTimeout(() => { finish(false) }, WATCH_TIMEOUT_MS)
      listeners.add(finish)
      this.waiters.set(rootSessionId, listeners)
    })
  }
}
