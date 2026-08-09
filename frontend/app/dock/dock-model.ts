// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export type DockToolId = "telemetry" | "model" | "thinking" | "design" | "mycelium" | "repo";

export const DOCK_DEFAULT_WIDTH = 360;
export const DOCK_MIN_WIDTH = 280;
export const DOCK_MAX_WIDTH = 760;
export const DOCK_RAIL_WIDTH = 44;

// The chat drawer is the headline surface, so it gets its own (wider) width
// track independent of the diagnostic tool drawers.
export const CHAT_DEFAULT_WIDTH = 460;
export const CHAT_MIN_WIDTH = 340;
export const CHAT_MAX_WIDTH = 900;

const StorageKey = "crowe.dock.v1";

type DockPersisted = {
    activeTool: DockToolId | null;
    width: number;
    chatWidth: number;
    collapsed: boolean;
};

const DefaultPersisted: DockPersisted = {
    activeTool: null,
    width: DOCK_DEFAULT_WIDTH,
    chatWidth: CHAT_DEFAULT_WIDTH,
    collapsed: true,
};

function clampWidth(px: number): number {
    if (!Number.isFinite(px)) {
        return DOCK_DEFAULT_WIDTH;
    }
    return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(px)));
}

function clampChatWidth(px: number): number {
    if (!Number.isFinite(px)) {
        return CHAT_DEFAULT_WIDTH;
    }
    return Math.min(CHAT_MAX_WIDTH, Math.max(CHAT_MIN_WIDTH, Math.round(px)));
}

function loadPersisted(): DockPersisted {
    try {
        const raw = localStorage.getItem(StorageKey);
        if (!raw) {
            return { ...DefaultPersisted };
        }
        const parsed = JSON.parse(raw);
        return {
            activeTool: parsed?.activeTool ?? null,
            width: clampWidth(parsed?.width ?? DOCK_DEFAULT_WIDTH),
            chatWidth: clampChatWidth(parsed?.chatWidth ?? CHAT_DEFAULT_WIDTH),
            collapsed: parsed?.collapsed ?? true,
        };
    } catch {
        return { ...DefaultPersisted };
    }
}

export class DockModel {
    private static instance: DockModel | null = null;
    activeToolAtom: jotai.PrimitiveAtom<DockToolId | null>;
    collapsedAtom: jotai.PrimitiveAtom<boolean>;
    widthAtom: jotai.PrimitiveAtom<number>;
    chatWidthAtom: jotai.PrimitiveAtom<number>;

    private constructor() {
        const p = loadPersisted();
        this.activeToolAtom = jotai.atom(p.activeTool) as jotai.PrimitiveAtom<DockToolId | null>;
        this.collapsedAtom = jotai.atom(p.collapsed);
        this.widthAtom = jotai.atom(p.width);
        this.chatWidthAtom = jotai.atom(p.chatWidth);
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
            width: globalStore.get(this.widthAtom),
            chatWidth: globalStore.get(this.chatWidthAtom),
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

    setWidth(px: number) {
        globalStore.set(this.widthAtom, clampWidth(px));
        globalStore.set(this.collapsedAtom, false);
        this.persistState();
    }

    setChatWidth(px: number) {
        globalStore.set(this.chatWidthAtom, clampChatWidth(px));
        this.persistState();
    }
}
