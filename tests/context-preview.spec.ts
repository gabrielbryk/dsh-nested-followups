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
    expect(preview?.excludedGroups).toEqual([])
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
