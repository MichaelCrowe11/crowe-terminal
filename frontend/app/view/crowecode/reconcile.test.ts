// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { changedLineRange, decideReconcile, describeReload } from "./reconcile";

describe("decideReconcile", () => {
    it("ignores changes to files we don't have open", () => {
        expect(decideReconcile({ matchesOpenFile: false, dirty: false })).toBe("ignore");
        expect(decideReconcile({ matchesOpenFile: false, dirty: true })).toBe("ignore");
    });
    it("guards a dirty buffer (never clobber unsaved edits)", () => {
        expect(decideReconcile({ matchesOpenFile: true, dirty: true })).toBe("guard");
    });
    it("reloads a clean buffer", () => {
        expect(decideReconcile({ matchesOpenFile: true, dirty: false })).toBe("reload");
    });
});

describe("changedLineRange", () => {
    it("returns [] for identical text", () => {
        expect(changedLineRange("a\nb\nc", "a\nb\nc")).toEqual([]);
    });
    it("isolates a single edited line", () => {
        expect(changedLineRange("a\nb\nc", "a\nB\nc")).toEqual([2]);
    });
    it("captures appended lines", () => {
        expect(changedLineRange("a\nb\n", "a\nb\nc\nd\n")).toEqual([3]);
    });
    it("captures an inserted block in the middle", () => {
        // common prefix "a"; common suffix "d"; new middle = lines 2..3
        expect(changedLineRange("a\nd", "a\nb\nc\nd")).toEqual([2, 3]);
    });
    it("flags the join line on a pure deletion", () => {
        // delete middle line: prefix "a", suffix "c" -> no new middle, join at line 2
        expect(changedLineRange("a\nb\nc", "a\nc")).toEqual([2]);
    });
});

describe("describeReload", () => {
    it("attributes an agent change with a line range", () => {
        expect(describeReload("/tmp/foo/service.go", [10, 11, 12], "agent")).toBe(
            "service.go reloaded — lines 10 to 12 changed by the agent."
        );
    });
    it("attributes an external change to a single line", () => {
        expect(describeReload("/x/a.ts", [4], "external")).toBe("a.ts reloaded — line 4 changed by an external edit.");
    });
    it("omits attribution when origin is unknown", () => {
        expect(describeReload("a.ts", [1], "")).toBe("a.ts reloaded — line 1 changed.");
    });
    it("handles no changed lines", () => {
        expect(describeReload("a.ts", [], "agent")).toBe("a.ts reloaded.");
    });
});
