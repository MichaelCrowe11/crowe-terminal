// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Editor-agnostic live-reload reconcile kernel. No Monaco, no Jotai, no Wave —
// pure functions, so the same policy can back any file-backed editor and lift
// cleanly into a standalone package. This is the extractable core of the
// live-reload protocol: given a file-change event with provenance, decide what
// to do and describe it accessibly. See docs/CROWECODE_LIVE_RELOAD.md.

export type ReloadOrigin = "agent" | "external" | "self" | "";

// FileChange is the wire contract published when a file an editor has open is
// mutated on disk. Provenance (origin) is the primitive that lets the UI
// attribute a reload rather than silently swapping the buffer.
export interface FileChange {
    path: string;
    op: string;
    origin: ReloadOrigin;
}

export type ReconcileAction = "reload" | "guard" | "ignore";

// decideReconcile is the whole policy in one place: a change to a file we don't
// have open is ignored; a change while the buffer has unsaved edits is guarded
// (never clobbered — the UI surfaces a conflict); a change to a clean buffer
// reloads.
export function decideReconcile(args: { matchesOpenFile: boolean; dirty: boolean }): ReconcileAction {
    if (!args.matchesOpenFile) {
        return "ignore";
    }
    if (args.dirty) {
        return "guard";
    }
    return "reload";
}

// changedLineRange returns the 1-indexed lines of newText that differ from
// oldText, computed as the minimal middle span after stripping the common
// prefix and suffix. This is the same "changed region" a diff view highlights:
// it cleanly captures edits, insertions, and deletions without a full LCS. For
// a pure deletion (no new lines remain in the middle) it returns the join line
// so the change still has somewhere to be shown.
export function changedLineRange(oldText: string, newText: string): number[] {
    if (oldText === newText) {
        return [];
    }
    const o = oldText.split("\n");
    const n = newText.split("\n");
    let p = 0;
    while (p < o.length && p < n.length && o[p] === n[p]) p++;
    let s = 0;
    while (s < o.length - p && s < n.length - p && o[o.length - 1 - s] === n[n.length - 1 - s]) s++;
    const start = p;
    const end = n.length - s;
    const lines: number[] = [];
    for (let i = start; i < end; i++) lines.push(i + 1);
    if (lines.length === 0) {
        const joinLine = Math.min(start + 1, n.length);
        if (joinLine >= 1) lines.push(joinLine);
    }
    return lines;
}

// describeReload builds the accessible announcement for a live reload,
// attributing the change by origin so a screen-reader user learns what
// reloaded, where, and who did it — the same information the visual flash
// conveys. Lines arrive as a contiguous span, so min/max describes the region.
export function describeReload(fileName: string | undefined, lines: number[], origin: ReloadOrigin): string {
    const base = fileName ? fileName.split("/").pop() : "file";
    if (lines.length === 0) {
        return `${base} reloaded.`;
    }
    const lo = Math.min(...lines);
    const hi = Math.max(...lines);
    const where = lo === hi ? `line ${lo}` : `lines ${lo} to ${hi}`;
    const by = origin === "agent" ? " by the agent" : origin === "external" ? " by an external edit" : "";
    return `${base} reloaded — ${where} changed${by}.`;
}
