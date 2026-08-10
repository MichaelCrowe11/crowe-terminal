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
