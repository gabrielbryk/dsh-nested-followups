import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import SessionStore, {
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { describe, expect, it } from 'vitest'

import { TreeMetadataRepository } from '../src/host/storage.ts'
import { NestedFollowupsService } from '../src/host/tree-service.ts'
import type { BranchRecord, TreeRecord } from '../src/shared/types.ts'
import { textTurn } from './fixtures/session-events.ts'

class MemoryTable<V> implements KvTable<string, V> {
  private readonly values = new Map<string, V>()

  get(key: string): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[string, V]> { return this.values.entries() }
  keys(): IterableIterator<string> { return this.values.keys() }
  get size(): number { return this.values.size }
  async put(key: string, value: V): Promise<void> { this.values.set(key, value) }
  async delete(key: string): Promise<boolean> { return this.values.delete(key) }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = fn(current)
    this.values.set(key, next)
    return next
  }
}

/**
 * The 0.1.3-alpha.1 handle-based persistence seam.
 *
 * `list` replaces `listSnapshots`, and `open`/`read`/`close` replace
 * `inspect`/`readFrom`, so the double states the ported contract rather than
 * the removed one it was originally written against.
 */
class MemoryPersistence extends Service {
  private readonly records = new Map<SessionId, { header: SessionHeader; inheritedEventCount: number; events: SessionEvent[] }>()
  readonly readFromIds: SessionId[] = []
  readonly openHandles = new Set<object>()

  constructor(owner: Context) { super(owner, 'sessionPersistence') }

  store(session: Session): void {
    this.records.set(session.id, {
      header: session.header,
      inheritedEventCount: (session as unknown as { inheritedEventCount: number }).inheritedEventCount,
      events: [...session.events],
    })
  }

  async list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return [...this.records.values()].map((record, index) => ({
      header: record.header,
      revision: `memory-${index}` as SessionPersistenceSnapshot['revision'],
    }))
  }

  async open(id: SessionId, access: 'read' | 'write'): Promise<{
    header: SessionHeader
    inheritedEventCount: number
    read: (offset?: number) => Promise<{ eventState: string; events: readonly SessionEvent[] }>
    close: () => Promise<void>
  }> {
    if (access !== 'read') throw new Error('the tree projection never opens a write handle')
    const stored = this.records.get(id)
    if (stored === undefined) throw new Error('not persisted')
    this.readFromIds.push(id)
    let closed = false
    const handle = {
      header: stored.header,
      inheritedEventCount: stored.inheritedEventCount,
      read: async (offset = 0): Promise<{ eventState: string; events: readonly SessionEvent[] }> => {
        if (closed) throw new Error('handle closed')
        return { eventState: 'detached', events: stored.events.filter(event => event.seq >= offset) }
      },
      close: async (): Promise<void> => {
        closed = true
        this.openHandles.delete(handle)
      },
    }
    this.openHandles.add(handle)
    return handle
  }
}

async function setup(options: { branches?: boolean; cold?: boolean; deletion?: boolean } = {}): Promise<{
  dispose: () => Promise<void>
  service: NestedFollowupsService
  root: ReturnType<SessionStore['create']>
  repository: TreeMetadataRepository
  persistence: MemoryPersistence
  deletionCalls: Array<{ request: { ownerSessionId: string; branchId: string }; counts: Map<string, number> }>
  ctx: Context
}> {
  const ctx = new Context()
  const fibers: Fiber[] = []
  const sessionFiber = ctx.plugin(SessionStore)
  fibers.push(sessionFiber)
  await sessionFiber
  const persistenceFiber = ctx.plugin(MemoryPersistence)
  fibers.push(persistenceFiber)
  await persistenceFiber

  const repository = new TreeMetadataRepository(
    new MemoryTable<TreeRecord>(),
    new MemoryTable<BranchRecord>(),
  )
  const tree: TreeRecord = {
    treeId: 'tree-root',
    rootSessionId: 'root',
    version: 1,
    createdAt: 1,
    updatedAt: 2,
  }
  const branch: BranchRecord = {
    branchId: 'branch-1',
    clientRequestId: 'request-1',
    treeId: tree.treeId,
    sessionId: 'branch-session',
    parentSessionId: tree.rootSessionId,
    parentBranchId: null,
    anchorSessionId: tree.rootSessionId,
    anchorMessageId: 'a1',
    anchorSeq: 3,
    forkBoundarySeq: 5,
    seedLength: 6,
    siblingOrdinal: 1,
    createdAt: 2,
    status: 'ready',
  }
  await repository.putTree(tree)
  await repository.putBranch(branch)

  class MetadataStub extends Service {
    readonly repository = repository
    constructor(owner: Context) { super(owner, 'nestedFollowupsMetadata') }
  }
  const metadataFiber = ctx.plugin(MetadataStub)
  fibers.push(metadataFiber)
  await metadataFiber

  class BranchesStub extends Service {
    constructor(owner: Context) { super(owner, 'nestedFollowupsBranches') }
    capabilities() {
      return {
        askFollowUp: true,
        continueBranch: true,
        nativeBranchContinuation: false,
      }
    }
  }
  if (options.branches !== false) {
    const branchesFiber = ctx.plugin(BranchesStub)
    fibers.push(branchesFiber)
    await branchesFiber
  }
  const deletionCalls: Array<{
    request: { ownerSessionId: string; branchId: string }
    counts: Map<string, number>
  }> = []
  class DeletionStub extends Service {
    constructor(owner: Context) { super(owner, 'nestedFollowupsDeletion') }
    capabilities() { return { supported: true as const, mode: 'archive' as const } }
    async deleteBranch(
      request: { ownerSessionId: string; branchId: string },
      counts: ReadonlyMap<string, number>,
    ) {
      deletionCalls.push({ request, counts: new Map(counts) })
      return {
        ok: true as const,
        value: {
          status: 'deleted' as const,
          branchCount: 1,
          visibleMessageCount: counts.get(request.branchId) ?? 0,
          cleanupMode: 'archive' as const,
        },
      }
    }
  }
  if (options.deletion === true) {
    const deletionFiber = ctx.plugin(DeletionStub)
    fibers.push(deletionFiber)
    await deletionFiber
  }

  const rootEvents = textTurn(0, 1, 'q1', 'a1', 'root question', 'root answer')
  const branchEvents = [
    ...rootEvents,
    ...textTurn(6, 2, 'branch-q1', 'branch-a1', 'follow-up', 'isolated answer'),
  ]
  const root = options.cold === true
    ? Session.create(SessionId('root'), rootEvents, {
      version: 0,
      id: SessionId('root'),
      createdAt: 1,
    })
    : ctx.sessions.create(SessionId('root'), { seed: rootEvents })
  const branchSession = options.cold === true
    ? Session.create(SessionId('branch-session'), branchEvents, {
      version: 0,
      id: SessionId('branch-session'),
      createdAt: 2,
      parentSession: root.id,
      seedLength: 6,
      origin: 'subagent',
    })
    : ctx.sessions.create(SessionId('branch-session'), {
      seed: branchEvents,
      meta: {
        parentSession: root.id,
        seedLength: 6,
        origin: 'subagent',
      },
    })
  if (options.cold === true) {
    const persistence = ctx.sessionPersistence as unknown as MemoryPersistence
    persistence.store(root)
    persistence.store(branchSession)
  }
  const serviceFiber = ctx.plugin(NestedFollowupsService)
  fibers.push(serviceFiber)
  await serviceFiber
  return {
    dispose: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
    service: ctx.nestedFollowups,
    ctx,
    root,
    repository,
    persistence: ctx.sessionPersistence as unknown as MemoryPersistence,
    deletionCalls,
  }
}

/**
 * Publish one process-local assistant frame the way `AgentLoop` does.
 *
 * `agent/assistant-stream` is not a Session event and does not exist in the
 * pinned 0.1.1-rc.2 type surface, so it is emitted structurally here, exactly
 * as the Host adapter consumes it.
 */
function emitAssistantStream(ctx: Context, session: { id: SessionId; seq: number }, frame: unknown): void {
  ;(ctx as unknown as { emit(name: string, payload: unknown): void })
    .emit('agent/assistant-stream', { agent: { session }, frame })
}

function liveNode(
  nodes: readonly { messageId: string; text: string }[],
): { messageId: string; text: string } | undefined {
  return nodes.find(node => node.messageId === 'stream-2-1')
}

function emitAgentDisposed(ctx: Context, session: { id: SessionId }): void {
  ;(ctx as unknown as { emit(name: string, payload: unknown): void })
    .emit('agent/disposed', { agent: { session } })
}

describe('tree projection Remote service', () => {
  it('reads root and branch suffixes as one de-duplicated message tree', async () => {
    const { dispose, service } = await setup()
    try {
      const result = await service.readTree({ sessionId: 'root' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.rootSessionId).toBe('root')
      expect(result.value.capabilities).toEqual({
        askFollowUp: true,
        continueBranch: true,
        nativeBranchContinuation: false,
        deletion: {
          supported: false,
          reason: 'The branch deletion service is unavailable.',
        },
      })
      expect(result.value.projection.nodes.map(node => node.messageId)).toEqual([
        'q1',
        'a1',
        'branch-q1',
        'branch-a1',
      ])
      expect(result.value.projection.edges.filter(edge => edge.kind === 'branch')).toHaveLength(1)
      expect(result.value.projection.branches[0]?.branchPath).toEqual([1, 1])
      expect(result.value.projection.diagnostics).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('resolves a branch request back to its root-owned tree', async () => {
    const { dispose, service } = await setup()
    try {
      const result = await service.readTree({ sessionId: 'branch-session' })
      expect(result.ok && result.value.rootSessionId).toBe('root')
    } finally {
      await dispose()
    }
  })

  it('recovers the same de-duplicated tree exclusively from cold persisted logs', async () => {
    const { dispose, service } = await setup({ cold: true })
    try {
      const result = await service.readTree({ sessionId: 'branch-session' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.rootSessionId).toBe('root')
      expect(result.value.projection.nodes.map(node => node.messageId)).toEqual([
        'q1',
        'a1',
        'branch-q1',
        'branch-a1',
      ])
      expect(result.value.projection.diagnostics).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('does not read the log of a branch already marked deleted', async () => {
    const { dispose, service, repository, persistence } = await setup({ cold: true })
    try {
      const branch = repository.getBranch('branch-1')
      expect(branch).toBeDefined()
      if (branch === undefined) return
      await repository.putBranch({ ...branch, status: 'deleted', deletedAt: 10 })
      persistence.readFromIds.length = 0

      const result = await service.readTree({ sessionId: 'root' })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      // The projection drops the branch, so fetching its log would only cost a
      // persistence round trip while its session is being cleaned up.
      expect(persistence.readFromIds.map(String)).toEqual(['root'])
      expect(result.value.projection.nodes.map(node => node.messageId)).toEqual(['q1', 'a1'])
    } finally {
      await dispose()
    }
  })

  it('wakes an outstanding revision watch when the root log changes', async () => {
    const { dispose, service, root } = await setup()
    try {
      const initial = await service.readTree({ sessionId: 'root' })
      if (!initial.ok) throw new Error('root projection missing')
      const pending = service.watchTree({
        sessionId: 'root',
        afterRevision: initial.value.revision,
      })
      await Promise.resolve()
      root.append('turn/start', { turn: 2 })

      const changed = await pending
      expect(changed.ok).toBe(true)
      if (!changed.ok) return
      expect(changed.value.changed).toBe(true)
      if (!changed.value.changed) return
      expect(changed.value.snapshot.revision).toBe(initial.value.revision + 1)
    } finally {
      await dispose()
    }
  })

  it('renders in-progress assistant text from the transient stream publication', async () => {
    const { ctx, dispose, service, root } = await setup()
    try {
      root.append('turn/start', { turn: 2 })
      root.append('step/start', { turn: 2, step: 1 })
      const queued = await service.readTree({ sessionId: 'root' })
      if (!queued.ok) throw new Error('root projection missing')
      expect(liveNode(queued.value.projection.nodes)).toEqual(expect.objectContaining({
        messageId: 'stream-2-1',
        state: 'queued',
        text: '',
      }))

      emitAssistantStream(ctx, root, {
        type: 'start', attemptId: 'attempt-1', revision: 1, turn: 2, step: 1,
      })
      for (const text of ['one', ' two', ' three']) {
        emitAssistantStream(ctx, root, {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 1,
          index: 0,
          time: 5_000,
          chunk: { type: 'text-delta', index: 0, text },
        })
      }

      const streaming = await service.readTree({ sessionId: 'root' })
      expect(streaming.ok && liveNode(streaming.value.projection.nodes)).toEqual(
        expect.objectContaining({
          messageId: 'stream-2-1',
          state: 'streaming',
          text: 'one two three',
        }),
      )

      emitAssistantStream(ctx, root, {
        type: 'end',
        attemptId: 'attempt-1',
        revision: 1,
        index: 3,
        outcome: { kind: 'abandoned' },
      })
      const ended = await service.readTree({ sessionId: 'root' })
      expect(ended.ok && liveNode(ended.value.projection.nodes)).toEqual(
        expect.objectContaining({ messageId: 'stream-2-1', text: '' }),
      )
    } finally {
      await dispose()
    }
  })

  it('coalesces high-frequency assistant chunks into one bounded revision', async () => {
    const { ctx, dispose, service, root } = await setup()
    try {
      emitAssistantStream(ctx, root, {
        type: 'start', attemptId: 'attempt-1', revision: 1, turn: 2, step: 1,
      })
      const initial = await service.readTree({ sessionId: 'root' })
      if (!initial.ok) throw new Error('root projection missing')

      for (const text of ['one', ' two', ' three']) {
        emitAssistantStream(ctx, root, {
          type: 'chunk',
          attemptId: 'attempt-1',
          revision: 1,
          index: 0,
          time: 5_000,
          chunk: { type: 'text-delta', index: 0, text },
        })
      }
      const immediate = await service.readTree({ sessionId: 'root' })
      expect(immediate.ok && immediate.value.revision).toBe(initial.value.revision)

      await new Promise(resolve => setTimeout(resolve, 75))
      const coalesced = await service.readTree({ sessionId: 'root' })
      expect(coalesced.ok && coalesced.value.revision).toBe(initial.value.revision + 1)
    } finally {
      await dispose()
    }
  })

  it('retires a live stream when its agent is disposed', async () => {
    const { ctx, dispose, service, root } = await setup()
    try {
      root.append('turn/start', { turn: 2 })
      root.append('step/start', { turn: 2, step: 1 })
      emitAssistantStream(ctx, root, {
        type: 'start', attemptId: 'attempt-1', revision: 1, turn: 2, step: 1,
      })
      emitAssistantStream(ctx, root, {
        type: 'chunk',
        attemptId: 'attempt-1',
        revision: 1,
        index: 0,
        time: 5_000,
        chunk: { type: 'text-delta', index: 0, text: 'half a sentence' },
      })
      const streaming = await service.readTree({ sessionId: 'root' })
      expect(streaming.ok && liveNode(streaming.value.projection.nodes)?.text).toBe('half a sentence')

      emitAgentDisposed(ctx, root)
      const retired = await service.readTree({ sessionId: 'root' })
      expect(retired.ok && liveNode(retired.value.projection.nodes)).toEqual(
        expect.objectContaining({ messageId: 'stream-2-1', text: '' }),
      )
    } finally {
      await dispose()
    }
  })

  it('returns a stable business failure for an unknown session', async () => {
    const { dispose, service } = await setup()
    try {
      await expect(service.readTree({ sessionId: 'missing' })).resolves.toEqual({
        ok: false,
        error: { code: 'session-not-found', sessionId: 'missing' },
      })
    } finally {
      await dispose()
    }
  })

  it('routes deletion through the Host service with projection-derived message counts', async () => {
    const { dispose, service, deletionCalls } = await setup({ deletion: true })
    try {
      const read = await service.readTree({ sessionId: 'root' })
      expect(read.ok && read.value.capabilities.deletion).toEqual({
        supported: true,
        mode: 'archive',
      })
      await expect(service.deleteBranch({
        ownerSessionId: 'root',
        branchId: 'branch-1',
      })).resolves.toEqual({
        ok: true,
        value: {
          status: 'deleted',
          branchCount: 1,
          visibleMessageCount: 2,
          cleanupMode: 'archive',
        },
      })
      expect(deletionCalls).toEqual([{
        request: { ownerSessionId: 'root', branchId: 'branch-1' },
        counts: new Map([['branch-1', 2]]),
      }])
    } finally {
      await dispose()
    }
  })

  it('keeps projection reads available when branch mutation services are absent', async () => {
    const { dispose, service } = await setup({ branches: false })
    try {
      const read = await service.readTree({ sessionId: 'root' })
      expect(read.ok && read.value.capabilities).toEqual({
        askFollowUp: false,
        continueBranch: false,
        nativeBranchContinuation: false,
        deletion: {
          supported: false,
          reason: 'The branch deletion service is unavailable.',
        },
        reason: 'The branch mutation service is unavailable.',
      })
      await expect(service.createBranch({
        ownerSessionId: 'root',
        clientRequestId: 'request-unavailable',
        anchor: { sessionId: 'root', messageId: 'a1', seq: 3 },
        question: 'why?',
      })).resolves.toEqual({
        ok: false,
        error: {
          code: 'compatibility',
          message: 'Branch creation is unavailable in this DSH composition.',
        },
      })
    } finally {
      await dispose()
    }
  })
})
