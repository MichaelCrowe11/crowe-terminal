// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    clampColumnWidth,
    clampToolWidth,
    DOCK_DEFAULT_WIDTH,
    DOCK_MAX_WIDTH,
    DOCK_MIN_WIDTH,
    DOCK_PERSIST_DEBOUNCE_MS,
    DockModel,
    migratePersisted,
    TOOL_DEFAULT_WIDTH,
    TOOL_MAX_WIDTH,
    TOOL_MIN_WIDTH,
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

describe("clampToolWidth", () => {
    it("holds the configured bounds", () => {
        expect(clampToolWidth(10)).toBe(TOOL_MIN_WIDTH);
        expect(clampToolWidth(5000)).toBe(TOOL_MAX_WIDTH);
        expect(clampToolWidth(300)).toBe(300);
    });

    it("falls back to the default for junk", () => {
        expect(clampToolWidth(NaN)).toBe(TOOL_DEFAULT_WIDTH);
        expect(clampToolWidth(Infinity)).toBe(TOOL_DEFAULT_WIDTH);
    });
});

describe("migratePersisted", () => {
    // The v1 shape stored two independent column widths. Users upgrading must
    // keep a sane dock rather than silently reset to defaults.
    it("migrates the old two-width shape, preferring the chat width", () => {
        const out = migratePersisted({ activeTool: "repo", width: 360, chatWidth: 520, collapsed: false });
        expect(out.columnWidth).toBe(520);
        expect(out.toolWidth).toBe(TOOL_DEFAULT_WIDTH);
        expect(out.activeTool).toBe("repo");
        expect(out.collapsed).toBe(false);
    });

    it("falls back to the tool width when no chat width was stored", () => {
        expect(migratePersisted({ width: 400 }).columnWidth).toBe(400);
    });

    // A stacked-layout fraction describes a height split and cannot be
    // reinterpreted as a column width, so the tool starts at its default.
    it("drops the stacked chatFraction rather than reusing it as a width", () => {
        expect(migratePersisted({ columnWidth: 600, chatFraction: 0.3 }).toolWidth).toBe(TOOL_DEFAULT_WIDTH);
    });

    it("reads the new shape unchanged", () => {
        const out = migratePersisted({ columnWidth: 600, toolWidth: 320, activeTool: null, collapsed: true });
        expect(out.columnWidth).toBe(600);
        expect(out.toolWidth).toBe(320);
        expect(out.collapsed).toBe(true);
    });

    it("survives null, junk, and missing fields", () => {
        expect(migratePersisted(null).columnWidth).toBe(DOCK_DEFAULT_WIDTH);
        expect(migratePersisted({}).toolWidth).toBe(TOOL_DEFAULT_WIDTH);
        expect(migratePersisted({ columnWidth: "wide" }).columnWidth).toBe(DOCK_DEFAULT_WIDTH);
        expect(migratePersisted(undefined).collapsed).toBe(true);
    });
});

describe("DockModel persistence", () => {
    let writes: string[];

    beforeEach(() => {
        writes = [];
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: (_key: string, value: string) => {
                writes.push(value);
            },
        });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    // The release has to flush the pending timer, or a reload inside the
    // debounce window drops the size the user just chose. commitPersist cancels
    // with upcomingOnly for a reason: a bare cancel() latches
    // throttle-debounce's `cancelled` flag and no later write would ever land,
    // which is what the trailing assertions here guard.
    it("coalesces drag writes and commits the final value on release", () => {
        const model = DockModel.getInstance();
        model.setColumnWidth(400);
        model.setColumnWidth(420);
        model.setColumnWidth(440);
        expect(writes).toHaveLength(0);

        model.commitPersist();
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0]).columnWidth).toBe(440);

        vi.advanceTimersByTime(DOCK_PERSIST_DEBOUNCE_MS * 4);
        expect(writes).toHaveLength(1);

        model.setToolWidth(320);
        vi.advanceTimersByTime(DOCK_PERSIST_DEBOUNCE_MS);
        expect(writes).toHaveLength(2);
        expect(JSON.parse(writes[1]).toolWidth).toBe(320);
    });

    it("still lands the write when no commit follows", () => {
        const model = DockModel.getInstance();
        model.setColumnWidth(500);
        expect(writes).toHaveLength(0);

        vi.advanceTimersByTime(DOCK_PERSIST_DEBOUNCE_MS);
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0]).columnWidth).toBe(500);
    });

    // Only the drag setters are hot. A toggle is a discrete click and must
    // survive an immediate reload.
    it("persists a tool toggle without waiting", () => {
        const model = DockModel.getInstance();
        model.toggle("repo");
        expect(writes).toHaveLength(1);
        expect(JSON.parse(writes[0]).activeTool).toBe("repo");
    });
});
