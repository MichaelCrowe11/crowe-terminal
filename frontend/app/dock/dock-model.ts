// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { debounce } from "throttle-debounce";

export type DockToolId = "telemetry" | "model" | "thinking" | "design" | "mycelium" | "repo";

export const DOCK_DEFAULT_WIDTH = 460;
export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 760;
export const DOCK_RAIL_WIDTH = 44;
export const MIN_BLOCK_PX = 240;
export const DOCK_SPLIT_PX = 4;

export const DOCK_PERSIST_DEBOUNCE_MS = 150;

export const TOOL_DEFAULT_WIDTH = 280;
export const TOOL_MIN_WIDTH = 200;
export const TOOL_MAX_WIDTH = 480;

const StorageKey = "crowe.dock.v1";

type DockPersisted = {
    activeTool: DockToolId | null;
    columnWidth: number;
    toolWidth: number;
    collapsed: boolean;
};

// DOCK_MIN_WIDTH wins over MIN_BLOCK_PX when the two cannot both be satisfied:
// a chat column under 280px is unusable, so squeezing it further to protect the
// block area trades one broken pane for two. That conflict needs a workspace row
// under DOCK_RAIL_WIDTH + DOCK_MIN_WIDTH + MIN_BLOCK_PX (564px), which the
// 800px MinWindowWidth in emain/emain-window.ts already keeps out of reach.
export function clampColumnWidth(px: number): number {
    if (!Number.isFinite(px)) {
        return DOCK_DEFAULT_WIDTH;
    }
    return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(px)));
}

export function clampToolWidth(px: number): number {
    if (!Number.isFinite(px)) {
        return TOOL_DEFAULT_WIDTH;
    }
    return Math.min(TOOL_MAX_WIDTH, Math.max(TOOL_MIN_WIDTH, Math.round(px)));
}

// Two earlier shapes exist: v0 stored `width` + `chatWidth` as independent
// columns, and the stacked layout stored a vertical `chatFraction`. A fraction
// carries no usable width for a side-by-side tool column, so it is dropped and
// the tool starts at its default rather than at some sliver of the old height.
export function migratePersisted(raw: any): DockPersisted {
    const width = raw?.columnWidth ?? raw?.chatWidth ?? raw?.width;
    return {
        activeTool: raw?.activeTool ?? null,
        columnWidth: clampColumnWidth(typeof width === "number" ? width : NaN),
        toolWidth: clampToolWidth(typeof raw?.toolWidth === "number" ? raw.toolWidth : NaN),
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
    toolWidthAtom: jotai.PrimitiveAtom<number>;

    private constructor() {
        const p = loadPersisted();
        this.activeToolAtom = jotai.atom(p.activeTool) as jotai.PrimitiveAtom<DockToolId | null>;
        this.collapsedAtom = jotai.atom(p.collapsed);
        this.columnWidthAtom = jotai.atom(p.columnWidth);
        this.toolWidthAtom = jotai.atom(p.toolWidth);
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
            toolWidth: globalStore.get(this.toolWidthAtom),
            collapsed: globalStore.get(this.collapsedAtom),
        };
        try {
            localStorage.setItem(StorageKey, JSON.stringify(data));
        } catch {
            // dock UI state is non-critical; ignore quota/serialization failures
        }
    }

    // A drag fires mousemove at pointer rate, and localStorage.setItem is
    // synchronous and hits the main thread. Width changes therefore persist on
    // a trailing debounce while the atom updates immediately, so the drag stays
    // smooth and the last position is still what gets stored.
    persistStateDebounced = debounce(DOCK_PERSIST_DEBOUNCE_MS, () => this.persistState());

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
        this.persistStateDebounced();
    }

    setToolWidth(px: number) {
        globalStore.set(this.toolWidthAtom, clampToolWidth(px));
        this.persistStateDebounced();
    }

    // A drag that ends must not leave its last size sitting in a pending timer,
    // where a reload inside the debounce window would lose it. upcomingOnly is
    // required: a bare cancel() sets throttle-debounce's `cancelled` flag, which
    // is permanent, so the first drag release would kill every later write.
    commitPersist() {
        this.persistStateDebounced.cancel({ upcomingOnly: true });
        this.persistState();
    }
}
