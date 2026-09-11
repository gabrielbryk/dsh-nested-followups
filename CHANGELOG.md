# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Merged upstream Context Preview: inherited request prefix, exclusion groups
  (root/branch tail, siblings, descendants), and completed-turn boundary
  eligibility (`src/client/tree/context-preview.ts`, projection-graph index).

### Changed

- **Breaking:** ported the Host services to the DeepSeek Harness
  `0.1.3-alpha.1` session seam
  (`d347e703908d0406b7a7ef80e3a0e594d86b2215`) and raised the compatibility
  floor to it. Upstream `bec6805` replaced
  `SessionPersistence.inspect`/`readFrom`/`listSnapshots` with a per-session
  handle (`open`/`read`/`close`) plus `list`, and `f99b06e` (session format v2)
  replaced the `Session.events` accessor with `snapshotEvents()` and moved the
  durable fork cut off the header (`header.seedLength`) onto a separate
  `inheritedEventCount` paired with `header.isSeeded`. Every one of those calls
  now goes through the new `src/host/adapter/session-log.ts`; branch creation
  passes the cut as the `inheritedEventCount` creation option beside a
  `meta.isSeeded` marker. Read handles are always closed in a `finally`.
  Read-only branch semantics, tree projection, and the anchored-question flow
  are unchanged.
- Folded `interruptedTurnClosers` into the cold branch read, because the
  removed `inspect` supplied synthetic closers for a log whose writer crashed
  mid-turn and the raw handle read does not. The detached suffix read that
  replaces `readFrom` deliberately does not fold them, matching the removed
  primitive.
- Adapted the validation suite to the v2 session contract
  (`tests/fixtures/session-format-v2.ts`) so it exercises the ported seam while
  the package continues to build against the last published DeepSeek Harness
  line; `0.1.3-alpha.1` is not on the npm registry.
- Restored in-progress assistant text in the Tree View on the new event model.
  `f99b06e` also removed `assistant/chunk` from `SessionEventMap`, so the
  projection's chunk-folding branch could never fire; live text now comes from
  the transient, process-local `agent/assistant-stream` publication
  (`packages/core/agent/src/runtime-types.ts:74` and `:315`), consumed at the
  same Host seam upstream's own session controller uses
  (`packages/api/session-controller/src/history.ts:54`). The new
  `src/host/adapter/assistant-stream.ts` declares that payload structurally and
  `src/host/live-assistant-stream.ts` folds one attempt per session with
  `BlockAssembler` into the same `stream-<turn>-<step>` node the removed branch
  fed, so the Tree View's node identity, `queued`/`streaming` states, and
  coalesced revision cadence are unchanged. The live text is retired on the
  attempt's `end` frame, on `agent/disposed`, and on Host disposal, and a live
  step whose durable `assistant/message` already committed stays suppressed.
  The frames are not session events — they carry no `seq` and are never
  persisted — so a branch whose agent is not attached in this process shows no
  preview. `assistant/attempt` was rejected as the source: it commits only for
  an attempt that produced no surface message, and only at settlement.

### Added

- Added a 13.5-second demo recorded from a real DeepSeek Harness session. It
  shows a side question, a follow-up on that side answer, recursive isolation,
  collapse, and the untouched main chat.
- Added a real Tree View screenshot and a repository-owned screenshot manifest
  for compatible plugin directories and storefronts.
- Added reusable recording instructions and community-specific launch copy.

### Changed

- Made Host compatibility fixtures platform-independent so the fork's full
  validation suite runs on Linux, where Gabe's DSH deployment lives.
- Validated the fork against Gabe's pinned DeepSeek Harness
  `0.1.2-alpha.1` deployment without changing its read-only branch semantics.
- Rebuilt the English and Chinese README introductions around the project's
  defining behavior: every answer at every depth can become another isolated
  fork point, with no plugin-defined nesting limit.
- Kept the fuller DeepSeek Harness social preview and banner, and added a
  compact any-depth branching diagram to both README files as an explainer.
- Updated the npm description and keywords to describe recursive conversation
  branching and context isolation rather than only the Tree View UI.

## [0.2.2] - 2026-08-24

### Changed

- Updated the development and validation dependency set to DeepSeek Harness
  `0.1.1-rc.2`, while retaining `0.1.0-rc.7` as the supported lower bound.
- Corrected the DSH peer range so npm's prerelease matching rules explicitly
  accept the `0.1.1` release-candidate line.
- Updated the compatibility notes for the Subagent list's lineage-control
  location in `0.1.1-rc.2`.

## [0.2.1] - 2026-08-20

### Changed

- A tree now opens fully folded on first visit: the trunk plus one dot per
  anchor. Opening a dot always reveals one capsule per branch, even for
  branches that were expanded before, so each level is chosen deliberately.
- A capsule's count now reports only that branch's own messages; nested
  content is signalled by the child-branch marker instead.
- Quoting moved out of the follow-up box. Select text in a message's details
  panel, press Enter in the small popover to save the quote (several can be
  saved, each with an optional comment), and the follow-up box lists them.
- Sibling capsules stack tightly under their anchor, and expanded frames keep
  a guaranteed clearance so dashed regions never overlap.
- Folding never moves the viewport: dots, capsules, and the bottom-edge
  target all act in place. Automatic centering remains only for search
  results and streaming follow.
- Every connector is now a solid line, and branch fans route through the
  dot control as one hub instead of piling up on the anchor card's edge.
- Verified against DeepSeek Harness `0.1.0-rc.8`; the declared compatibility
  range is unchanged and continues to accept `0.1.0-rc.7`.

### Fixed

- Zooming the tree blurred its content: a permanent compositor hint pinned
  the stage raster at 1:1 scale. The hint now applies only while panning, so
  every zoom level re-rasterizes crisply.
- Focused trees did not visibly dim out-of-context cards: the dimmed style
  was invisible over a branch region's opaque background, and the card reveal
  animation kept overriding the dimmed opacity after it settled.
- Tooltips inside the zoomed canvas rendered far away from their buttons: a
  CSS transform hijacks fixed positioning, so canvas tooltips now render
  through a portal. The focus action also uses a crosshair glyph instead of an
  inspect icon that read as a code bracket.
- Cards no longer carry a collapse button; folding lives on the region's
  bottom-edge shadow and the dot/capsule controls.

## [0.2.0] - 2026-08-19

### Added

- Collapse v2 with three progressive levels: one anchor-group dot, one capsule
  per branch, and the existing full message-card group.
- Sticky per-tree collapse state, partial sibling expansion, Alt-click deep
  expansion, a Collapse all action, and a 20 px bottom-edge collapse target.
- Folded activity indicators for streaming and failed descendants, including
  accessible labels and reduced-motion fallbacks.

### Changed

- Search now opens every folded ancestor before locating a result, and the
  minimap reflects dot and capsule geometry.
- The old `+N nodes` badge is replaced by a capsule with branch path, first
  question summary, child-branch count, full subtree message count, and the
  existing cascading delete action.

## [0.1.0] - 2026-08-19

First release, targeting DeepSeek Harness `0.1.0-rc.7`. Published to npm as
[`dsh-nested-followups`](https://www.npmjs.com/package/dsh-nested-followups).

### Added

- Tree View: a conversation tree that renders each user and assistant message
  as a separate card, reachable from a toggle in the conversation header.
- **Ask follow-up**: creates an isolated branch from a completed answer using
  the official session fork mechanism. Branches can be nested without limit.
- **Continue this branch**: adds the next exchange to an existing branch,
  available only on that branch's most recent completed answer.
- Branch deletion, cascading to all nested branches, with a confirmation dialog
  that reports how many branches and messages will be removed.
- Text selection anchors, so a follow-up can quote a specific passage of an
  answer.
- Tree navigation: search, focus, collapse, pan, zoom, fit to view, and an
  overview map.
- Full recovery of trees, branches, and anchors after a restart.

### Security

- Branches run as read-only agents. Read tools are permitted; every other tool,
  including any tool the plugin does not recognise, is refused when it runs.
  Branches share the main conversation's working directory and cannot modify it.

### Notes

- Branches are recorded as subagent-origin sessions, which keeps them out of
  the session list while preserving their history.
- A branch sends the same request prefix as the main conversation, so the model
  provider's cached prefix is reused rather than re-read.
- Continuing a branch from the standard chat view is not available on
  `0.1.0-rc.7`. See the compatibility section of the [README](README.md).
