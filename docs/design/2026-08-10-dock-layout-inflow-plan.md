# Dock-in-Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dock's chat and tool panels stop floating over the block layout and become a single in-flow column that blocks make room for.

**Architecture:** `.crowe-dock-root` is already `position: relative; display: flex`. Dropping `position: absolute` from the drawers turns them into flex items in that existing row. One dock column holds chat on top and the active tool below, split by a draggable horizontal separator; a vertical separator on the column's right edge sets the shared width. `workspace.tsx` needs no changes — the block container already carries `flex-grow min-w-0`.

**Tech Stack:** TypeScript/React/Jotai, SCSS, vitest.

**Spec:** `docs/design/2026-08-10-dock-layout-inflow.md` (commit 2c68f320).

## Global Constraints

- Branch `feat/dock-layout-inflow` (already created from merged main). Commit there; no new branch.
- TS: 4-space indent, named exports, `cn` from `@/util/util`, `cursor-pointer` on clickables, `== null` not `=== undefined`, hooks at component top before any conditional return, `React.memo` components get `displayName`.
- Jotai model rules: simple atoms as field initializers, derived atoms in the constructor, singleton `getInstance()`, models never use React hooks — `globalStore.get/set` only.
- No emojis. Comments only for WHY, never to restate the code.
- The repo bans `cursor-not-allowed` and `cursor-help`.
- Verification is `npx tsc --noEmit -p tsconfig.json` (must be clean) and `npx vitest run` from the repo root. **Baseline: 58/59 passing — `frontend/app/view/crowecode/reconcile.test.ts > changedLineRange > captures appended lines` fails on main and is unrelated to this work.** Any OTHER failure is yours.
- Never `git add -A`. `package-lock.json` is dirty in this tree from earlier work and must never be staged.

---

### Task 1: One column, one split — the state model

**Files:**
- Modify: `frontend/app/dock/dock-model.ts` (whole persisted shape)
- Create: `frontend/app/dock/dock-model.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 2 imports these by these exact names):
  - constants `DOCK_DEFAULT_WIDTH = 460`, `DOCK_MIN_WIDTH = 280`, `DOCK_MAX_WIDTH = 760`, `DOCK_RAIL_WIDTH = 44`, `MIN_PANE_PX = 120`, `DEFAULT_CHAT_FRACTION = 0.5`
  - pure, exported: `clampColumnWidth(px: number): number`, `clampChatFraction(f: number, columnHeight?: number): number`, `migratePersisted(raw: any): DockPersisted`
  - `DockModel` atoms: `activeToolAtom`, `collapsedAtom`, `columnWidthAtom`, `chatFractionAtom`
  - `DockModel` methods: `toggle(id)`, `collapse()`, `setColumnWidth(px)`, `setChatFraction(f, columnHeight?)`
  - `CHAT_DEFAULT_WIDTH`, `CHAT_MIN_WIDTH`, `CHAT_MAX_WIDTH`, `setWidth`, `setChatWidth`, `widthAtom`, `chatWidthAtom` are **deleted** — Task 2 removes their last callers in the same branch.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/dock/dock-model.test.ts`:

```ts
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    clampChatFraction,
    clampColumnWidth,
    DEFAULT_CHAT_FRACTION,
    DOCK_DEFAULT_WIDTH,
    DOCK_MAX_WIDTH,
    DOCK_MIN_WIDTH,
    migratePersisted,
    MIN_PANE_PX,
} from "./dock-model";

describe("clampColumnWidth", () => {
    it("holds the configured bounds", () => {
        expect(clampColumnWidth(100)).toBe(DOCK_MIN_WIDTH);
        expect(clampColumnWidth(5000)).toBe(DOCK_MAX_WIDTH);
        expect(clampColumnWidth(500)).toBe(500);
    });

    it("falls back to the default for junk", () => {
        expect(clampColumnWidth(NaN)).toBe(DOCK_DEFAULT_WIDTH);
        expect(clampColumnWidth(Infinity)).toBe(DOCK_DEFAULT_WIDTH);
    });
});

describe("clampChatFraction", () => {
    it("keeps both panes above the minimum on a tall column", () => {
        const height = 1000;
        const minF = MIN_PANE_PX / height;
        expect(clampChatFraction(0.01, height)).toBeCloseTo(minF, 5);
        expect(clampChatFraction(0.99, height)).toBeCloseTo(1 - minF, 5);
        expect(clampChatFraction(0.5, height)).toBe(0.5);
    });

    // A column shorter than two minimum panes cannot honor both, so it splits
    // evenly rather than pinning one pane to a broken bound.
    it("splits evenly when the column is too short for two minimum panes", () => {
        expect(clampChatFraction(0.9, MIN_PANE_PX)).toBe(DEFAULT_CHAT_FRACTION);
    });

    it("uses generic bounds when no height is known", () => {
        expect(clampChatFraction(0)).toBe(0.1);
        expect(clampChatFraction(1)).toBe(0.9);
        expect(clampChatFraction(NaN)).toBe(DEFAULT_CHAT_FRACTION);
    });
});

describe("migratePersisted", () => {
    // The v1 shape stored two independent column widths. Users upgrading must
    // keep a sane dock rather than silently reset to defaults.
    it("migrates the old two-width shape, preferring the chat width", () => {
        const out = migratePersisted({ activeTool: "repo", width: 360, chatWidth: 520, collapsed: false });
        expect(out.columnWidth).toBe(520);
        expect(out.chatFraction).toBe(DEFAULT_CHAT_FRACTION);
        expect(out.activeTool).toBe("repo");
        expect(out.collapsed).toBe(false);
    });

    it("falls back to the tool width when no chat width was stored", () => {
        expect(migratePersisted({ width: 400 }).columnWidth).toBe(400);
    });

    it("reads the new shape unchanged", () => {
        const out = migratePersisted({ columnWidth: 600, chatFraction: 0.3, activeTool: null, collapsed: true });
        expect(out.columnWidth).toBe(600);
        expect(out.chatFraction).toBe(0.3);
        expect(out.collapsed).toBe(true);
    });

    it("survives null, junk, and missing fields", () => {
        expect(migratePersisted(null).columnWidth).toBe(DOCK_DEFAULT_WIDTH);
        expect(migratePersisted({}).chatFraction).toBe(DEFAULT_CHAT_FRACTION);
        expect(migratePersisted({ columnWidth: "wide" }).columnWidth).toBe(DOCK_DEFAULT_WIDTH);
        expect(migratePersisted(undefined).collapsed).toBe(true);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/crowelogic/Projects/hypheus && npx vitest run frontend/app/dock/dock-model.test.ts`
Expected: FAIL — `clampColumnWidth`, `clampChatFraction`, `migratePersisted`, `MIN_PANE_PX`, `DEFAULT_CHAT_FRACTION` are not exported from `./dock-model`.

- [ ] **Step 3: Rewrite the state model**

Replace the constants block and everything from `type DockPersisted` through the end of `class DockModel` in `frontend/app/dock/dock-model.ts` with the following. Keep the file's existing header, the `DockToolId` union (which already includes `"repo"`), the `globalStore`/`jotai` imports, and `StorageKey`.

```ts
export const DOCK_DEFAULT_WIDTH = 460;
export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 760;
export const DOCK_RAIL_WIDTH = 44;
export const MIN_PANE_PX = 120;
export const DEFAULT_CHAT_FRACTION = 0.5;

type DockPersisted = {
    activeTool: DockToolId | null;
    columnWidth: number;
    chatFraction: number;
    collapsed: boolean;
};

export function clampColumnWidth(px: number): number {
    if (!Number.isFinite(px)) {
        return DOCK_DEFAULT_WIDTH;
    }
    return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(px)));
}

// With a measured column height the clamp keeps both panes above MIN_PANE_PX;
// without one it falls back to generic bounds, which is what a cold load has.
export function clampChatFraction(f: number, columnHeight?: number): number {
    if (!Number.isFinite(f)) {
        return DEFAULT_CHAT_FRACTION;
    }
    if (columnHeight == null || !Number.isFinite(columnHeight) || columnHeight <= 0) {
        return Math.min(0.9, Math.max(0.1, f));
    }
    const minF = MIN_PANE_PX / columnHeight;
    const maxF = 1 - minF;
    if (minF >= maxF) {
        return DEFAULT_CHAT_FRACTION;
    }
    return Math.min(maxF, Math.max(minF, f));
}

// v1 stored `width` and `chatWidth` as two independent columns. One column
// inherits the chat width, which was the wider and more deliberately set of
// the two.
export function migratePersisted(raw: any): DockPersisted {
    const width = raw?.columnWidth ?? raw?.chatWidth ?? raw?.width;
    return {
        activeTool: raw?.activeTool ?? null,
        columnWidth: clampColumnWidth(typeof width === "number" ? width : NaN),
        chatFraction: clampChatFraction(typeof raw?.chatFraction === "number" ? raw.chatFraction : NaN),
        collapsed: raw?.collapsed ?? true,
    };
}

function loadPersisted(): DockPersisted {
    try {
        const raw = localStorage.getItem(StorageKey);
        return migratePersisted(raw ? JSON.parse(raw) : null);
    } catch {
        return migratePersisted(null);
    }
}

export class DockModel {
    private static instance: DockModel | null = null;
    activeToolAtom: jotai.PrimitiveAtom<DockToolId | null>;
    collapsedAtom: jotai.PrimitiveAtom<boolean>;
    columnWidthAtom: jotai.PrimitiveAtom<number>;
    chatFractionAtom: jotai.PrimitiveAtom<number>;

    private constructor() {
        const p = loadPersisted();
        this.activeToolAtom = jotai.atom(p.activeTool) as jotai.PrimitiveAtom<DockToolId | null>;
        this.collapsedAtom = jotai.atom(p.collapsed);
        this.columnWidthAtom = jotai.atom(p.columnWidth);
        this.chatFractionAtom = jotai.atom(p.chatFraction);
    }

    static getInstance(): DockModel {
        if (!DockModel.instance) {
            DockModel.instance = new DockModel();
        }
        return DockModel.instance;
    }

    persistState() {
        const data: DockPersisted = {
            activeTool: globalStore.get(this.activeToolAtom),
            columnWidth: globalStore.get(this.columnWidthAtom),
            chatFraction: globalStore.get(this.chatFractionAtom),
            collapsed: globalStore.get(this.collapsedAtom),
        };
        try {
            localStorage.setItem(StorageKey, JSON.stringify(data));
        } catch {
            // dock UI state is non-critical; ignore quota/serialization failures
        }
    }

    toggle(id: DockToolId) {
        const active = globalStore.get(this.activeToolAtom);
        const collapsed = globalStore.get(this.collapsedAtom);
        if (active === id && !collapsed) {
            globalStore.set(this.collapsedAtom, true);
        } else {
            globalStore.set(this.activeToolAtom, id);
            globalStore.set(this.collapsedAtom, false);
        }
        this.persistState();
    }

    collapse() {
        globalStore.set(this.collapsedAtom, true);
        this.persistState();
    }

    setColumnWidth(px: number) {
        globalStore.set(this.columnWidthAtom, clampColumnWidth(px));
        this.persistState();
    }

    setChatFraction(f: number, columnHeight?: number) {
        globalStore.set(this.chatFractionAtom, clampChatFraction(f, columnHeight));
        this.persistState();
    }
}
```

Note `setColumnWidth` no longer force-uncollapses the way the old `setWidth` did — resizing a column is not the same gesture as opening a panel, and Task 2 never calls it while collapsed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/crowelogic/Projects/hypheus && npx vitest run frontend/app/dock/dock-model.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

TypeScript will report errors in `utilitydock.tsx` at this point (it still imports the deleted `CHAT_DEFAULT_WIDTH` and calls `setWidth`). That is expected — Task 2 fixes it in the same branch. Commit anyway so the state change is reviewable on its own:

```bash
cd /Users/crowelogic/Projects/hypheus
git add frontend/app/dock/dock-model.ts frontend/app/dock/dock-model.test.ts
git commit -m "feat(dock): one column width and one split fraction, with v1 migration"
```

---

### Task 2: The drawers become flex panes

**Files:**
- Modify: `frontend/app/dock/utilitydock.tsx` (render tree, resize handlers, imports)
- Modify: `frontend/app/dock/dock.scss` (`.crowe-dock-drawer` → column + pane rules)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: classes `.crowe-dock-column`, `.crowe-dock-pane`, `.crowe-dock-split`, `.crowe-dock-dragging` for Task 3's preview cases.

- [ ] **Step 1: Restructure the render tree in `utilitydock.tsx`**

Replace the import from `./dock-model` with:

```tsx
import { DOCK_DEFAULT_WIDTH, DOCK_RAIL_WIDTH, DEFAULT_CHAT_FRACTION, DockModel, DockToolId } from "./dock-model";
```

Delete `const DOCK_COMPACT_BREAKPOINT = 900;` and both breakpoint behaviors — `toggleChat` becomes a plain visibility toggle and `toggleTool` a plain `model.toggle(id)`:

```tsx
    const toggleChat = useCallback(() => {
        layout.setAIPanelVisible(!layout.getAIPanelVisible());
    }, [layout]);

    const toggleTool = useCallback(
        (id: DockToolId) => {
            model.toggle(id);
        },
        [model]
    );
```

Replace the `width`/`chatWidth` atom reads with the new atoms, and add a column ref plus a dragging flag alongside the existing hooks (all before any conditional return):

```tsx
    const columnWidth = useAtomValue(model.columnWidthAtom);
    const chatFraction = useAtomValue(model.chatFractionAtom);
    const columnRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState(false);
```

Replace the whole drag `useEffect` (the one listening on `mousemove`/`mouseup`) with:

```tsx
    useEffect(() => {
        const onMove = (e: MouseEvent) => {
            if (dragMode.current === "column") {
                model.setColumnWidth(e.clientX - DOCK_RAIL_WIDTH);
                return;
            }
            if (dragMode.current !== "split") {
                return;
            }
            const rect = columnRef.current?.getBoundingClientRect();
            if (rect == null || rect.height === 0) {
                return;
            }
            model.setChatFraction((e.clientY - rect.top) / rect.height, rect.height);
        };
        const onUp = () => {
            if (dragMode.current == null) {
                return;
            }
            dragMode.current = null;
            setDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
        };
    }, [model]);
```

Replace the two resize-down handlers with:

```tsx
    const onColumnResizeDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragMode.current = "column";
        setDragging(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    }, []);

    const onSplitDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        dragMode.current = "split";
        setDragging(true);
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
    }, []);
```

and widen the ref's type: `const dragMode = useRef<"column" | "split" | null>(null);`

Delete the `toolLeft` computation. Then replace the entire returned JSX with this — note the rail now comes FIRST in the DOM, because flex order is visual order once the panes are in flow:

```tsx
    const chatPaneStyle = toolOpen
        ? { flexGrow: chatFraction, flexBasis: 0, minHeight: 0 }
        : { flex: "1 1 auto", minHeight: 0 };
    const toolPaneStyle = chatOpen
        ? { flexGrow: 1 - chatFraction, flexBasis: 0, minHeight: 0 }
        : { flex: "1 1 auto", minHeight: 0 };

    return (
        <div className="crowe-dock-root">
            <nav className="crowe-dock-rail glass-chrome" aria-label="Hypheus operator tools">
                <div className="crowe-dock-brand" title="Hypheus operator tools" aria-hidden="true">
                    <img src={hypheusMark} alt="" />
                </div>
                <span className="crowe-dock-sep" />
                <button
                    type="button"
                    className={cn("crowe-dock-btn cursor-pointer", chatOpen && "crowe-dock-btn-active")}
                    onClick={toggleChat}
                    title="Assistant"
                    aria-label="Assistant"
                    aria-pressed={chatOpen}
                >
                    <AssistantIcon className="crowe-dock-glyph" />
                    {chatOpen && <span className="crowe-dock-indicator" />}
                </button>
                {DOCK_TOOLS.map((tool) => {
                    const isActive = !collapsed && activeTool === tool.id;
                    return (
                        <button
                            key={tool.id}
                            type="button"
                            className={cn("crowe-dock-btn cursor-pointer", isActive && "crowe-dock-btn-active")}
                            onClick={() => toggleTool(tool.id)}
                            title={tool.label}
                            aria-label={tool.label}
                            aria-pressed={isActive}
                        >
                            <tool.Icon className="crowe-dock-glyph" />
                            {isActive && <span className="crowe-dock-indicator" />}
                            {tool.id === "design" && <DesignBadge />}
                            {tool.id === "repo" && <VcsDirtyPip />}
                        </button>
                    );
                })}
                <span className="crowe-dock-grow" />
                <span className="crowe-dock-sep" />
                <button
                    type="button"
                    className="crowe-dock-btn cursor-pointer"
                    onClick={toggleTheme}
                    title={theme === "dark" ? "Use light theme" : "Use dark theme"}
                    aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
                    aria-pressed={theme === "light"}
                >
                    {theme === "dark" ? <SunIcon className="crowe-dock-glyph" /> : <MoonIcon className="crowe-dock-glyph" />}
                </button>
            </nav>
            {columnOpen && (
                <div
                    ref={columnRef}
                    className={cn("crowe-dock-column glass-chrome glass-grain", dragging && "crowe-dock-dragging")}
                    style={{ width: columnWidth }}
                >
                    {chatOpen && (
                        <section className="crowe-dock-pane" style={chatPaneStyle}>
                            <div className="crowe-dock-head crowe-chat-head">
                                <button
                                    type="button"
                                    className="crowe-chat-model cursor-pointer"
                                    onClick={() => toggleTool("model")}
                                    title="Switch model"
                                >
                                    <span className="crowe-chat-model-dot" />
                                    <span className="crowe-chat-model-name">{modelLabel}</span>
                                    <i className="fa fa-angle-down crowe-chat-model-caret" />
                                </button>
                                <button
                                    type="button"
                                    className="crowe-dock-close cursor-pointer"
                                    onClick={() => layout.setAIPanelVisible(false)}
                                    title="Close assistant"
                                    aria-label="Close assistant"
                                >
                                    <CloseIcon />
                                </button>
                            </div>
                            <div className="crowe-chat-body">
                                <AIPanel roundTopLeft={false} />
                            </div>
                        </section>
                    )}
                    {chatOpen && toolOpen && (
                        <div
                            className="crowe-dock-split"
                            role="separator"
                            aria-orientation="horizontal"
                            title="Drag to resize, double-click to reset"
                            onMouseDown={onSplitDown}
                            onDoubleClick={() => model.setChatFraction(DEFAULT_CHAT_FRACTION)}
                        />
                    )}
                    {toolOpen && (
                        <section className="crowe-dock-pane" style={toolPaneStyle}>
                            <div className="crowe-dock-head">
                                <span className="crowe-dock-title">{activeDef.label}</span>
                                <button
                                    type="button"
                                    className="crowe-dock-close cursor-pointer"
                                    onClick={() => model.collapse()}
                                    title="Collapse panel"
                                    aria-label="Collapse panel"
                                >
                                    <CloseIcon />
                                </button>
                            </div>
                            <div className="crowe-dock-body">
                                <ActivePanel />
                            </div>
                        </section>
                    )}
                    <div
                        className="crowe-dock-resize crowe-dock-resize-grip"
                        role="separator"
                        aria-orientation="vertical"
                        title="Drag to resize, double-click to reset"
                        onMouseDown={onColumnResizeDown}
                        onDoubleClick={() => model.setColumnWidth(DOCK_DEFAULT_WIDTH)}
                    />
                </div>
            )}
        </div>
    );
```

with these derived values defined just above the JSX, after `activeDef`/`ActivePanel`:

```tsx
    const toolOpen = activeDef != null && ActivePanel != null;
    const columnOpen = chatOpen || toolOpen;
```

- [ ] **Step 2: Replace the drawer rules in `dock.scss`**

Delete the entire `.crowe-dock-drawer { ... }` block (its `position/top/left/bottom/max-width` and every nested rule) and the `.crowe-chat-drawer` / `.crowe-chat-drawer-closed` blocks. Insert in their place:

```scss
// The dock column takes real space in the workspace row: blocks shrink to make
// room instead of being covered. Chat sits above the active tool panel.
.crowe-dock-column {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    max-width: 70%;
    border-right: 1px solid var(--glass-hairline-chrome);
    overflow: hidden;
    transition: width 0.22s cubic-bezier(0.16, 1, 0.3, 1);

    // While dragging, the transition would make the column lag the cursor.
    &.crowe-dock-dragging {
        transition: none;
    }

    .crowe-dock-resize {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        cursor: col-resize;
        background: transparent;
        transition: background-color 0.15s ease;
        z-index: 1;

        &:hover {
            background: var(--wash-accent-mid);
        }
    }
}

.crowe-dock-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;

    .crowe-dock-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--hairline);
        flex-shrink: 0;

        .crowe-dock-title {
            font-family: var(--font-serif);
            font-size: 14px;
            font-weight: 600;
            color: var(--text);
            letter-spacing: 0.01em;
        }

        .crowe-dock-close {
            width: 22px;
            height: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            border: none;
            background: transparent;
            color: var(--text-dim);
            border-radius: var(--radius-sm, 2px);

            &:hover {
                color: var(--text);
                background: var(--wash-accent-faint);
            }
        }
    }

    .crowe-chat-head {
        padding: 6px 8px 6px 12px;
        gap: 8px;
    }

    .crowe-dock-body {
        flex: 1 1 auto;
        overflow-y: auto;
        min-height: 0;
    }

    .crowe-chat-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
    }
}

.crowe-dock-split {
    flex: 0 0 4px;
    cursor: row-resize;
    background: var(--glass-hairline-chrome);
    transition: background-color 0.15s ease;

    &:hover {
        background: var(--wash-accent-mid);
    }
}
```

Then check the remainder of the file for rules that were nested under `.crowe-dock-drawer` or `.crowe-chat-drawer` and are now orphaned (`.crowe-chat-model`, `.crowe-chat-model-dot`, `.crowe-chat-model-name`, `.crowe-chat-model-caret`, `.crowe-dock-resize-grip`). Re-nest each under `.crowe-dock-pane` or `.crowe-dock-column` as appropriate, or hoist to top level if it is used in both. **Do not delete any declaration** — this step is a re-parenting, not a restyle.

- [ ] **Step 3: Verify**

Run: `cd /Users/crowelogic/Projects/hypheus && npx tsc --noEmit -p tsconfig.json`
Expected: clean, zero errors (Task 1's expected errors are now resolved).

Run: `npx vitest run`
Expected: 58/59 plus Task 1's new dock-model tests all passing; the only failure is the pre-existing `reconcile.test.ts` case.

- [ ] **Step 4: Commit**

```bash
cd /Users/crowelogic/Projects/hypheus
git add frontend/app/dock/utilitydock.tsx frontend/app/dock/dock.scss
git commit -m "feat(dock): the panels take real space instead of floating over blocks"
```

---

### Task 3: Preview coverage and the in-app check

**Files:**
- Modify: `frontend/preview/previews/utilitydock.preview.tsx`

**Interfaces:**
- Consumes: `DockModel` atoms from Task 1, the classes from Task 2.

- [ ] **Step 1: Cover the four states in the preview**

The existing preview seeds one state in a `useEffect`. Replace that effect so the preview renders the dock four times, once per state, in a row of fixed-height frames. Keep the file's existing imports and add `VcsModel` seeding so the repository pane has content rather than a spinner:

```tsx
const DockCase = ({ label, chat, tool }: { label: string; chat: boolean; tool: boolean }) => {
    useEffect(() => {
        const dock = DockModel.getInstance();
        const layout = WorkspaceLayoutModel.getInstance();
        globalStore.set(layout.panelVisibleAtom, chat);
        globalStore.set(dock.activeToolAtom, tool ? "repo" : null);
        globalStore.set(dock.collapsedAtom, !tool);
    }, [chat, tool]);

    return (
        <figure className="flex min-w-0 flex-1 flex-col gap-2">
            <figcaption className="font-mono text-[10px] uppercase text-muted">{label}</figcaption>
            <div className="flex h-[520px] overflow-hidden border border-border bg-background">
                <UtilityDock />
                <div className="min-w-0 flex-1 bg-panel p-3 font-mono text-[10px] text-muted">
                    block area — shrinks to fit the dock
                </div>
            </div>
        </figure>
    );
};
```

Because `DockModel` and `WorkspaceLayoutModel` are singletons, four live `UtilityDock` instances would fight over one piece of state. Render the cases **one at a time** behind a selector instead:

```tsx
const CASES = [
    { label: "chat only", chat: true, tool: false },
    { label: "tool only", chat: false, tool: true },
    { label: "both, split", chat: true, tool: true },
    { label: "collapsed", chat: false, tool: false },
];

export default function UtilityDockPreview() {
    const [caseIdx, setCaseIdx] = useState(2);
    const c = CASES[caseIdx];
    return (
        <div className="flex w-[min(1180px,calc(100vw-32px))] flex-col gap-3">
            <div className="flex gap-2">
                {CASES.map((x, i) => (
                    <button
                        key={x.label}
                        type="button"
                        className={cn(
                            "cursor-pointer border border-border px-2 py-1 font-mono text-[10px] uppercase",
                            i === caseIdx ? "bg-accent/80 text-primary" : "text-muted"
                        )}
                        onClick={() => setCaseIdx(i)}
                    >
                        {x.label}
                    </button>
                ))}
            </div>
            <DockCase label={c.label} chat={c.chat} tool={c.tool} />
        </div>
    );
}
```

Add the imports this needs: `useState` from react, `cn` from `@/util/util`, and keep the existing `DockModel`, `UtilityDock`, `globalStore`, `WorkspaceLayoutModel`, `useEffect` imports.

- [ ] **Step 2: Full verification**

```bash
cd /Users/crowelogic/Projects/hypheus
npx tsc --noEmit -p tsconfig.json
npx vitest run
```
Expected: tsc clean; vitest shows only the pre-existing `reconcile.test.ts` failure.

- [ ] **Step 3: Commit**

```bash
git add frontend/preview/previews/utilitydock.preview.tsx
git commit -m "feat(preview): dock layout cases for chat, tool, split, and collapsed"
```

- [ ] **Step 4: The in-app check (needs a human)**

The one thing no test covers is whether the drag feels right and whether blocks reflow cleanly. Launch the dev build with the documented overrides and traps:

```bash
cd /Users/crowelogic/Projects/hypheus
CROWE_AGENT_PORT=8013 PYTHON=/opt/homebrew/bin/python3.13 npm_config_python=/opt/homebrew/bin/python3.13 task electron:quickdev
```

Traps that still apply: it opens FULL SCREEN; never run `task dev:reset` (it kills the user's production app too — kill dev only by path); only one Hypheus may run at a time (single-instance lock ignores `WAVETERM_DATA_HOME`), so the production app must be quit first.

Check: opening a panel shrinks the blocks rather than covering them; dragging the right edge resizes live without the column lagging; the horizontal split moves and both panes stay above 120px; a terminal block reflows and its shell picks up the new width.

## Self-review notes (done at plan time)

- **Spec coverage:** one column with vertical split → Task 2; `columnWidth` + `chatFraction` with 120px floor → Task 1; v1 migration → Task 1 Step 1/3; live resize with `dragging` class killing the transition → Task 2 Steps 1-2; compact breakpoint deleted → Task 2 Step 1; degenerate one-pane and zero-pane cases → `chatPaneStyle`/`toolPaneStyle`/`columnOpen`; `max-width` guard → `.crowe-dock-column { max-width: 70% }`; no `workspace.tsx` change → confirmed, absent from every task's file list.
- **Type consistency:** `clampColumnWidth`/`clampChatFraction`/`migratePersisted`/`MIN_PANE_PX`/`DEFAULT_CHAT_FRACTION` are named identically in the test, the model, and the component; `dragMode` values `"column"`/`"split"` match between the down-handlers and the move-handler.
- **Known risk carried into execution:** Task 2 Step 2's re-parenting of orphaned `.crowe-chat-*` rules is the step most likely to silently drop a declaration. It is called out as re-parenting-not-restyling, and the preview cases in Task 3 are what would expose a miss.
