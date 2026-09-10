import { describe, expect, it } from 'vitest'
import { deriveContextPreview } from '../src/client/tree/context-preview.ts'
import { nestedContextPreviewProjectionFixture } from './fixtures/context-preview.ts'

describe('context preview', () => {
  it('derives a root-session prefix through the selected node', () => {
    const preview = deriveContextPreview(nestedContextPreviewProjectionFixture(), 'root-a2')

    expect(preview?.inheritedNodeIds).toEqual([
      'root-q1',
      'root-a1',
      'root-q2',
      'root-a2',
    ])
    expect(preview?.inheritedEdgeIds).toEqual([
      'sequence:root-q1:root-a1',
      'sequence:root-a1:root-q2',
      'sequence:root-q2:root-a2',
    ])
    expect(preview?.excludedGroups).toEqual([
      {
        reason: 'root-session-tail',
        nodeIds: ['root-q3', 'root-a3'],
      },
      {
        reason: 'descendant-branch',
        nodeIds: [
          'branch-1-q',
          'branch-1-a',
          'branch-1-q2',
          'branch-1-a2',
          'nested-q',
          'nested-a',
          'branch-2-q',
          'branch-2-a',
        ],
      },
    ])
  })

  it('keeps only the exact ancestor chain for a nested branch', () => {
    const preview = deriveContextPreview(nestedContextPreviewProjectionFixture(), 'nested-a')

    expect(preview?.inheritedNodeIds).toEqual([
      'root-q1',
      'root-a1',
      'root-q2',
      'root-a2',
      'branch-1-q',
      'branch-1-a',
      'nested-q',
      'nested-a',
    ])
    expect(preview?.inheritedEdgeIds).toEqual([
      'sequence:root-q1:root-a1',
      'sequence:root-a1:root-q2',
      'sequence:root-q2:root-a2',
      'branch:root-a2:branch-1-q',
      'sequence:branch-1-q:branch-1-a',
      'branch:branch-1-a:nested-q',
      'sequence:nested-q:nested-a',
    ])
    expect(preview?.inheritedNodeIds).not.toContain('root-q3')
    expect(preview?.inheritedNodeIds).not.toContain('branch-1-q2')
    expect(preview?.inheritedNodeIds).not.toContain('branch-2-q')
    expect(preview?.excludedGroups).toEqual([
      {
        reason: 'root-session-tail',
        nodeIds: ['root-q3', 'root-a3'],
      },
      {
        reason: 'current-branch-tail',
        nodeIds: ['branch-1-q2', 'branch-1-a2'],
      },
      {
        reason: 'sibling-branch',
        nodeIds: ['branch-2-q', 'branch-2-a'],
      },
    ])
  })

  it('includes earlier turns when the target is later in the current branch', () => {
    const preview = deriveContextPreview(
      nestedContextPreviewProjectionFixture(),
      'branch-1-a2',
    )

    expect(preview?.inheritedNodeIds).toEqual([
      'root-q1',
      'root-a1',
      'root-q2',
      'root-a2',
      'branch-1-q',
      'branch-1-a',
      'branch-1-q2',
      'branch-1-a2',
    ])
    expect(Object.isFrozen(preview)).toBe(true)
    expect(Object.isFrozen(preview?.inheritedNodeIds)).toBe(true)
    expect(Object.isFrozen(preview?.inheritedEdgeIds)).toBe(true)
    expect(preview?.excludedGroups).toEqual([
      {
        reason: 'root-session-tail',
        nodeIds: ['root-q3', 'root-a3'],
      },
      {
        reason: 'sibling-branch',
        nodeIds: ['branch-2-q', 'branch-2-a'],
      },
      {
        reason: 'descendant-branch',
        nodeIds: ['nested-q', 'nested-a'],
      },
    ])
  })

  it('classifies later turns in the selected branch as branch tail', () => {
    const preview = deriveContextPreview(
      nestedContextPreviewProjectionFixture(),
      'branch-1-a',
    )

    expect(preview?.excludedGroups).toEqual([
      {
        reason: 'root-session-tail',
        nodeIds: ['root-q3', 'root-a3'],
      },
      {
        reason: 'current-branch-tail',
        nodeIds: ['branch-1-q2', 'branch-1-a2'],
      },
      {
        reason: 'sibling-branch',
        nodeIds: ['branch-2-q', 'branch-2-a'],
      },
      {
        reason: 'descendant-branch',
        nodeIds: ['nested-q', 'nested-a'],
      },
    ])
  })

  it('classifies every direct sibling branch outside the inherited path', () => {
    const preview = deriveContextPreview(
      nestedContextPreviewProjectionFixture(),
      'nested-a',
    )

    expect(preview?.excludedGroups.find(group => group.reason === 'sibling-branch'))
      .toEqual({
        reason: 'sibling-branch',
        nodeIds: ['branch-2-q', 'branch-2-a'],
      })
  })

  it('classifies child branch messages outside the selected branch context', () => {
    const preview = deriveContextPreview(
      nestedContextPreviewProjectionFixture(),
      'branch-1-a2',
    )

    expect(preview?.excludedGroups.find(group => group.reason === 'descendant-branch'))
      .toEqual({
        reason: 'descendant-branch',
        nodeIds: ['nested-q', 'nested-a'],
      })
  })

  it('keeps exclusion groups stable when projection arrays are reordered', () => {
    const fixture = nestedContextPreviewProjectionFixture()
    const expected = deriveContextPreview(fixture, 'branch-1-a')
    const reordered = deriveContextPreview({
      ...fixture,
      nodes: [...fixture.nodes].reverse(),
      branches: [...fixture.branches].reverse(),
    }, 'branch-1-a')

    expect(reordered?.excludedGroups).toEqual(expected?.excludedGroups)
  })

  it('deduplicates exclusion candidates within and across reason groups', () => {
    const fixture = nestedContextPreviewProjectionFixture()
    const siblingNodes = fixture.nodes.filter(node => node.branchId === 'branch-2')
    const preview = deriveContextPreview({
      ...fixture,
      nodes: [...fixture.nodes, ...siblingNodes],
    }, 'branch-1-a')
    const excludedNodeIds = preview?.excludedGroups.flatMap(group => group.nodeIds) ?? []

    expect(excludedNodeIds).toEqual([...new Set(excludedNodeIds)])
    expect(preview?.excludedGroups).toEqual([
      {
        reason: 'root-session-tail',
        nodeIds: ['root-q3', 'root-a3'],
      },
      {
        reason: 'current-branch-tail',
        nodeIds: ['branch-1-q2', 'branch-1-a2'],
      },
      {
        reason: 'sibling-branch',
        nodeIds: ['branch-2-q', 'branch-2-a'],
      },
      {
        reason: 'descendant-branch',
        nodeIds: ['nested-q', 'nested-a'],
      },
    ])
  })

  it('omits the root-tail group when the selected path reaches the root tip', () => {
    const preview = deriveContextPreview(nestedContextPreviewProjectionFixture(), 'root-a3')

    expect(preview?.excludedGroups).toEqual([{
      reason: 'descendant-branch',
      nodeIds: [
        'branch-1-q',
        'branch-1-a',
        'branch-1-q2',
        'branch-1-a2',
        'nested-q',
        'nested-a',
        'branch-2-q',
        'branch-2-a',
      ],
    }])
  })

  it('does not invent a preview for an unknown node', () => {
    expect(deriveContextPreview(nestedContextPreviewProjectionFixture(), 'missing')).toBeUndefined()
  })

  it('rejects a malformed cycle in the target ancestor chain', () => {
    const fixture = nestedContextPreviewProjectionFixture()
    const projection = {
      ...fixture,
      branches: fixture.branches.map((branch) => {
        if (branch.record.branchId !== 'branch-1') return branch
        return {
          ...branch,
          anchorNodeId: 'nested-a',
          record: {
            ...branch.record,
            parentBranchId: 'branch-1-1',
            parentSessionId: 'nested-session',
            anchorSessionId: 'nested-session',
            anchorMessageId: 'nested-a',
          },
        }
      }),
    }

    expect(deriveContextPreview(projection, 'nested-a')).toBeUndefined()
  })
})
