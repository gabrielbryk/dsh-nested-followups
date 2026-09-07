import type { ConversationTreeProjection } from '../../shared/projection.ts'
import type { MessageNodeView } from '../../shared/types.ts'
import {
  buildProjectionGraphIndex,
  type ProjectionGraphIndex,
} from './projection-graph.ts'

/**
 * Why a message is visible in the conversation tree but excluded from the
 * request prefix represented by a Context Preview.
 */
export type ContextExclusionReason =
  | 'root-session-tail'
  | 'current-branch-tail'
  | 'sibling-branch'
  | 'descendant-branch'

/** One display group of messages excluded for the same semantic reason. */
export interface ContextExclusionGroup {
  readonly reason: ContextExclusionReason
  /** Stable MessageNodeView IDs in deterministic display order. */
  readonly nodeIds: readonly string[]
}

/**
 * The exact model context represented by one eligible message boundary.
 *
 * The inherited path is ordered from the root message to `targetNodeId`.
 * Excluded messages never appear in the inherited path or in another
 * exclusion group. Eligibility and aggregate counts are layered on by their
 * dedicated derivation steps.
 */
export interface ContextPreview {
  readonly targetNodeId: string
  readonly inheritedNodeIds: readonly string[]
  readonly inheritedEdgeIds: readonly string[]
  readonly excludedGroups: readonly ContextExclusionGroup[]
}

function sessionPrefixThrough(
  graph: ProjectionGraphIndex,
  node: MessageNodeView,
): readonly MessageNodeView[] | undefined {
  const sessionNodes = graph.nodesBySessionId.get(node.sessionId)
  const sequenceIndex = graph.sessionSequenceIndexByNodeId.get(node.nodeId)
  if (sessionNodes === undefined || sequenceIndex === undefined) return undefined
  return sessionNodes.slice(0, sequenceIndex + 1)
}

function inheritedEdges(
  graph: ProjectionGraphIndex,
  nodes: readonly MessageNodeView[],
): readonly string[] {
  const edgeIds: string[] = []
  for (let index = 1; index < nodes.length; index += 1) {
    const source = nodes[index - 1]
    const target = nodes[index]
    if (source === undefined || target === undefined) continue
    const expectedKind = source.sessionId === target.sessionId ? 'sequence' : 'branch'
    const edge = graph.outgoingEdgesByNodeId.get(source.nodeId)?.find(candidate => (
      candidate.targetNodeId === target.nodeId && candidate.kind === expectedKind
    ))
    if (edge !== undefined) edgeIds.push(edge.edgeId)
  }
  return Object.freeze(edgeIds)
}

/**
 * Derive the exact ancestor-only request prefix represented by a tree node.
 *
 * Each branch contributes only its session-local prefix through the selected
 * node (or through the child branch's anchor). Parent-session tails and sibling
 * branches are therefore never pulled into the inherited path. Exclusion
 * groups and boundary eligibility are added by later derivation stages.
 */
export function deriveContextPreview(
  projection: ConversationTreeProjection,
  targetNodeId: string,
): ContextPreview | undefined {
  const graph = buildProjectionGraphIndex(projection)
  let cursor = graph.nodesById.get(targetNodeId)
  if (cursor === undefined) return undefined

  const segments: (readonly MessageNodeView[])[] = []
  const visitedBranchIds = new Set<string>()
  while (true) {
    const segment = sessionPrefixThrough(graph, cursor)
    if (segment === undefined) return undefined
    segments.unshift(segment)

    if (cursor.branchId === null) {
      if (cursor.sessionId !== projection.tree.rootSessionId) return undefined
      break
    }

    if (visitedBranchIds.has(cursor.branchId)) return undefined
    visitedBranchIds.add(cursor.branchId)

    const branch = graph.branchesById.get(cursor.branchId)
    const anchor = graph.anchorNodesByBranchId.get(cursor.branchId)
    if (
      branch === undefined
      || branch.record.sessionId !== cursor.sessionId
      || anchor === undefined
      || anchor.sessionId !== branch.record.parentSessionId
    ) return undefined
    cursor = anchor
  }

  const inheritedNodes = segments.flat()
  return Object.freeze({
    targetNodeId,
    inheritedNodeIds: Object.freeze(inheritedNodes.map(node => node.nodeId)),
    inheritedEdgeIds: inheritedEdges(graph, inheritedNodes),
    excludedGroups: Object.freeze([]),
  })
}
