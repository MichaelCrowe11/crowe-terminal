# The dock joins the workspace layout

Date: 2026-08-10
Status: approved, ready for implementation planning
Location note: `docs/superpowers` is gitignored in this repo (.gitignore:45), so specs live under `docs/design/`

## Why

The dock's drawers are `position: absolute` (dock.scss:136-141). Only the 44px rail
participates in the workspace's flex row; the chat and tool drawers float above the block
layout with a drop shadow. The tiling layout never learns they exist, so opening a panel
covers the work instead of making room for it.

Michael's words: the panels should fit into the blocks, not sit on top of them.

This is the first of four separate pieces. The others — panel density and visual finish,
context and tools, and a measured look at streaming performance — each get their own spec.
Geometry comes first because it decides how much room the panel has, which is the input to
every density decision that follows.

## The shape

One dock column, not two. Chat on top, the active tool panel below, a draggable divider
between them. Two panels open costs one column of width instead of two.

The alternative considered and rejected was keeping today's two side-by-side columns: at the
current defaults that is 460 + 360 = 820px of a 1280px window before the user's actual work
gets any. Mutually-exclusive panels were also rejected — being able to watch the repository
panel while asking the assistant about it is the point of having both.

## Architecture

`.crowe-dock-root` stops being a positioning context and becomes a flex row of two children:
the rail, and the dock column. The column is itself a flex column holding the chat pane and
the tool pane.

Nothing in `workspace.tsx` changes. `UtilityDock` is already the first flex child of the
workspace row (workspace.tsx:115) and the block container already carries
`flex-grow min-w-0`, so the blocks reflow to fit the moment the dock's children stop being
absolutely positioned.

The manual offset arithmetic goes away with it. `toolLeft` (utilitydock.tsx:154) and the
`left: toolLeft` / `left: var(--dock-rail-width)` rules exist only to place floating elements
beside each other; flex does that now.

## State

`dock-model.ts` persists `width` and `chatWidth` today — two independent column widths, a
model that stops meaning anything when there is one column.

It becomes:

- `columnWidth` — the shared column width, clamped 280-760 (the existing DOCK_MIN/MAX bounds)
- `chatFraction` — 0..1, chat's share of the column height, clamped so neither pane falls
  below 120px (computed against the column's measured height, so the clamp tightens on short
  windows rather than allowing a 40px pane)

Both persist under the existing `crowe.dock.v1` key. The loader must tolerate the old shape:
a stored `{width, chatWidth}` migrates to `{columnWidth: chatWidth || width, chatFraction:
0.5}` rather than throwing or resetting the user's dock to defaults.

## Resize

Two separators replace two width-drags.

- **Vertical**, on the column's right edge: sets `columnWidth` from `clientX - RAIL_WIDTH`.
  This stays valid because the dock is pinned to the workspace's left edge.
- **Horizontal**, between the panes: sets `chatFraction` from `clientY` measured against the
  column's own `getBoundingClientRect()`, so it does not depend on where the column sits on
  screen.

Both keep double-click-to-reset.

Live resize is safe. Terminals re-fit behind a ResizeObserver debounced at 50ms
(termwrap.ts:283, term.tsx:326), so a drag costs at most one fit and one shell resize per
50ms rather than one per frame. This is why the design does not need a deferred-commit or
drag-preview mechanism.

During an active drag the column takes a `dragging` class setting `transition: none`, so it
tracks the cursor instead of lagging behind the 220ms width transition
(dock.scss:208-210). The transition still applies to open and close, where it reads as
intentional.

## Degenerate cases

- **One pane open:** it takes the full column height and the horizontal separator is not
  rendered — no dead grab-strip over nothing.
- **Neither open:** the column is not rendered; only the rail takes space. This is today's
  collapsed behavior, preserved.
- **Narrow window:** the column carries a `max-width` tied to its container so it cannot
  squeeze the block area to zero.
- **The 900px compact breakpoint** (utilitydock.tsx:43, `DOCK_COMPACT_BREAKPOINT`) currently
  force-closes one surface when the other opens, because two columns could not both fit. One
  column at 460px survives a narrow window, so this rule and the `toggleTool`/`toggleChat`
  logic that enforces it are deleted.

## Testing

- `utilitydock.preview.tsx` gains cases for chat-only, tool-only, both-split, and collapsed.
  The preview harness renders the dock in a fixed frame, which is where layout regressions
  show up first.
- The model's clamping and migration are plain functions and get unit tests: fraction bounds,
  width bounds, and the old-shape migration specifically.
- Not automatable: whether the drag *feels* right. That is a look-at-it-in-the-app check.

## Scope

Deliberately excluded: anything inside the panels. No chrome reduction, no density work, no
visual polish, no changes to the AI panel's content or the repository panel. Those are the
next spec; doing them here would mean editing the same components twice with conflicting
goals.

## Risks

- **Every open, close, and drag now reflows the block area**, where before it reflowed
  nothing. The 50ms debounce makes this affordable, but it is a real behavior change: shells
  receive resize signals they did not previously get from dock interaction.
- **The state migration touches persisted user state.** Getting it wrong resets everyone's
  dock geometry. It is the one piece here that deserves a test before the code.
- **Rules that quietly depend on the root's positioning context.** `.crowe-dock-root` is
  already `position: relative; display: flex` (dock.scss:8-14), so the row it needs exists
  today — this change is smaller than it sounds. Checked: `.crowe-dock-indicator`
  (dock.scss:108) is nested inside `.crowe-dock-btn`, which sets its own `position: relative`
  (dock.scss:47), so it anchors to its button and is unaffected. The absolute rules that must
  go are exactly `.crowe-dock-drawer`'s `position/top/left/bottom` and
  `.crowe-dock-resize`'s edge anchoring, which becomes a flex-positioned separator.
- **`flex-shrink: 0` on the root** (dock.scss:12) means the dock will not yield width under
  pressure once its children take real space; the column's `max-width` is what keeps a narrow
  window from starving the block area, so that guard is load-bearing rather than defensive.
