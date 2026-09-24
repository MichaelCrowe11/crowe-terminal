// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { lineReady, logicalOutput } = require("./smoke-terminal-approval.cjs");

const Prompt = "HYPHEUS_0c71771b> ";
const Cols = 58;

function terminal(text = Prompt, trimmed = text) {
    return {
        cols: Cols, cursorx: text.length, cursory: 0,
        rows: [trimmed, ""],
        physicalrows: [{ text: text.padEnd(Cols, " "), wrapped: false }, { text: " ".repeat(Cols), wrapped: false }],
    };
}

test("explicit prompt space and blank-cell padding retain identical exact physical text", () => {
    assert.doesNotThrow(() => lineReady(terminal(), Prompt));
    assert.doesNotThrow(() => lineReady(terminal(Prompt, Prompt.trimEnd()), Prompt));
});

test("typed pwd requires exact physical text and cursor", () => {
    assert.doesNotThrow(() => lineReady(terminal(Prompt + "pwd"), Prompt + "pwd"));
    assert.throws(() => lineReady(terminal(Prompt + "pwd"), Prompt));
    assert.throws(() => lineReady(terminal(), Prompt + "pwd"));
});

test("extra printable input is rejected even with a forged trimmed representation", () => {
    const value = terminal();
    value.physicalrows[0].text = (Prompt + "x").padEnd(Cols, " ");
    assert.throws(() => lineReady(value, Prompt), /exact expected/);
});

test("cursor movement and extra entered spaces are rejected", () => {
    for (const delta of [-1, 1]) {
        const value = terminal();
        value.cursorx += delta;
        assert.throws(() => lineReady(value, Prompt), /exact expected/);
    }
    assert.throws(() => lineReady(terminal(Prompt + " "), Prompt), /exact expected/);
});

test("explicit trailing space is rejected after cursor resets to the expected position", () => {
    for (const expected of [Prompt, Prompt + "pwd"]) {
        const value = terminal(expected + " ");
        value.cursorx = expected.length;
        assert.equal(value.physicalrows[0].text, expected.padEnd(Cols, " "));
        assert.throws(() => lineReady(value, expected), /exact expected/);
    }
});

test("physical row truncation, hidden text below prompt, and inconsistent evidence fail closed", () => {
    const short = terminal();
    short.physicalrows[0].text = Prompt;
    assert.throws(() => lineReady(short, Prompt), /exact expected/);
    const below = terminal();
    below.physicalrows[1].text = "unexpected".padEnd(Cols, " ");
    assert.throws(() => lineReady(below, Prompt), /Unexpected output/);
    const explicitBelow = terminal();
    explicitBelow.rows[1] = " ";
    assert.throws(() => lineReady(explicitBelow, Prompt), /Unexpected output/);
    const missing = terminal();
    missing.physicalrows.pop();
    assert.throws(() => lineReady(missing, Prompt), /inconsistent/);
    const invalidCursor = terminal();
    invalidCursor.cursory = -1;
    assert.throws(() => lineReady(invalidCursor, Prompt), /inconsistent/);
});

test("prompt wrapping, insufficient columns, and wrapped rows below prompt fail closed", () => {
    const wrapped = terminal();
    wrapped.physicalrows[0].wrapped = true;
    assert.throws(() => lineReady(wrapped, Prompt), /continuation/);
    const below = terminal();
    below.physicalrows[1].wrapped = true;
    assert.throws(() => lineReady(below, Prompt), /Unexpected output/);
    const narrow = terminal();
    narrow.cols = Prompt.length + 1;
    assert.throws(() => lineReady(narrow, Prompt), /would wrap/);
});

test("ASCII column accounting cannot be used for controls or non-ASCII expected input", () => {
    assert.throws(() => lineReady(terminal(), Prompt + "\n"), /ASCII/);
    assert.throws(() => lineReady(terminal(), Prompt + "界"), /ASCII/);
});

test("cwd output reconstruction joins only explicit soft wraps and preserves internal spaces", () => {
    const value = { physicalrows: [
        { text: "p> pwd  ", wrapped: false },
        { text: "/tmp/a  ", wrapped: false },
        { text: "b/home  ", wrapped: true },
        { text: "p>      ", wrapped: false },
    ] };
    assert.deepEqual(logicalOutput(value, 0, 3), ["p> pwd", "/tmp/a  b/home"]);
    assert.throws(() => logicalOutput(value, 2, 3), /splits/);
    assert.throws(() => logicalOutput(value, 0, 2), /splits/);
});
