// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export type DockToolId = "telemetry" | "model" | "thinking" | "design" | "mycelium" | "repo";

export const DOCK_DEFAULT_WIDTH = 460;
export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 760;
export const DOCK_RAIL_WIDTH = 44;
export const MIN_PANE_PX = 120;
export const MIN_BLOCK_PX = 240;
export const DEFAULT_CHAT_FRACTION = 0.5;

const StorageKey = "crowe.dock.v1";

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
