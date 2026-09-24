// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const {
    options,
    validateProof,
    environment,
    collectOwned,
    assertChat,
    consumeResponse,
    failureCode,
    SmokeFailure,
    run,
} = require("./smoke-crowe-account.cjs");

const Source = fs.readFileSync(path.join(__dirname, "smoke-crowe-account.cjs"), "utf8");
const Proof = {
    headsha: "a".repeat(40),
    runid: "100",
    artifactid: "200",
    artifactsha256: "b".repeat(64),
    files: { executable: "c".repeat(64), asar: "d".repeat(64), wavesrv: "e".repeat(64) },
    verification: { codesign: true, gatekeeper: true, notarization: true },
};
const State = {
    modeok: true,
    configok: true,
    toolsoff: true,
    builder: false,
    error: false,
    status: "ready",
    calls: 0,
    attachments: 0,
    users: 0,
    assistants: 0,
};

test("import is inert and launch is independently gated before all artifact access", async () => {
    await assert.rejects(run({}), { code: "LAUNCH_NOT_APPROVED" });
    assert.equal(Source.includes('require("./smoke-terminal-approval.cjs")'), false);
    assert.equal(Source.includes("require.main === module"), true);
});

test("default options do not authorize launch or response", () => {
    const parsed = options([]);
    assert.equal(parsed.stage, "connect");
    assert.equal(parsed.waitms, 900000);
    assert.equal(parsed["approve-launch"], undefined);
    assert.equal(parsed["approve-response"], undefined);
});

test("resume requires a deliberate restore or disconnect stage", () => {
    assert.throws(() => options(["--resume", "/synthetic"]), { code: "RESUME_REQUIRES_RESTORE_OR_DISCONNECT" });
    assert.throws(() => options(["--stage", "restore"]), { code: "STAGE_REQUIRES_RESUME" });
    assert.equal(options(["--resume", "/synthetic", "--stage", "restore"]).stage, "restore");
    assert.equal(options(["--resume", "/synthetic", "--stage", "disconnect"]).stage, "disconnect");
});

test("reject response in disconnect stage and stop in restore stage", () => {
    assert.throws(() => options(["--resume", "/synthetic", "--stage", "disconnect", "--approve-response"]));
    assert.throws(() => options(["--resume", "/synthetic", "--stage", "restore", "--stop-after-connect"]));
});

test("reject old terminal/MCP options and ambiguous options", () => {
    for (const args of [
        ["--approve-exact-pwd"],
        ["--playwright-mcp", "/synthetic"],
        ["--approve-launch", "--approve-launch"],
        ["--app"],
        ["--unknown"],
    ]) {
        assert.throws(() => options(args));
    }
});

test("human sign-in wait is long but bounded", () => {
    assert.equal(options(["--signin-wait-seconds", "1800"]).waitms, 1800000);
    for (const value of ["0", "29", "3601", "Infinity", "1e3", "abc"])
        assert.throws(() => options(["--signin-wait-seconds", value]));
});

test("provenance requires full pinned commit and all signature/hash claims", () => {
    validateProof(Proof, Proof.headsha);
    assert.throws(() => validateProof(Proof, "f".repeat(40)), { code: "COMMIT_MISMATCH" });
    assert.throws(() => validateProof(Proof, "a".repeat(8)), { code: "COMMIT_MISMATCH" });
    for (const key of ["codesign", "gatekeeper", "notarization"]) {
        const changed = structuredClone(Proof);
        changed.verification[key] = false;
        assert.throws(() => validateProof(changed, Proof.headsha));
    }
    for (const key of ["executable", "asar", "wavesrv"]) {
        const changed = structuredClone(Proof);
        changed.files[key] = "missing";
        assert.throws(() => validateProof(changed, Proof.headsha));
    }
});

test("child environment is constructed, never inherited", () => {
    const dirs = Object.fromEntries(
        ["home", "config", "data", "electron", "tmp", "cache", "xdgconfig", "xdgdata", "runtime"].map((name) => [
            name,
            `/synthetic/${name}`,
        ])
    );
    const env = environment(dirs);
    assert.equal(env.HOME, dirs.home);
    assert.equal(env.WAVETERM_CONFIG_HOME, dirs.config);
    assert.equal(env.WAVETERM_DATA_HOME, dirs.data);
    assert.equal(env.SHELL, "/usr/bin/false");
    for (const key of ["CROWE_AGENT_DISABLED", "CROWE_FOUNDRY_DISABLED", "WAVETERM_NOPING"])
        assert.equal(env[key], "1");
    for (const key of [
        "CROWE_AGENT_PLAYWRIGHT",
        "CROWE_AGENT_PLAYWRIGHT_CMD",
        "NODE_OPTIONS",
        "DEBUG",
        "PWDEBUG",
        "AWS_ACCESS_KEY_ID",
        "CROWE_MODELS_KEY",
        "CROWE_TERMINAL_APPROVAL_SMOKE",
    ])
        assert.equal(env[key], undefined);
});

test("only exact launched ancestry is tracked, excluding unrelated processes", () => {
    const rows = [
        { pid: 1, ppid: 0, born: "init" },
        { pid: 10, ppid: 1, born: "owned" },
        { pid: 11, ppid: 10, born: "child" },
        { pid: 12, ppid: 11, born: "grandchild" },
        { pid: 20, ppid: 1, born: "other" },
    ];
    const owned = new Map();
    collectOwned(rows, owned, 10);
    assert.deepEqual([...owned.keys()], [10, 11, 12]);
});

test("PID reuse cannot adopt an unrelated process or its children", () => {
    const owned = new Map([[10, { pid: 10, ppid: 1, born: "original" }]]);
    collectOwned(
        [
            { pid: 10, ppid: 1, born: "replacement" },
            { pid: 11, ppid: 10, born: "unrelated" },
        ],
        owned,
        10
    );
    assert.equal(owned.size, 1);
    assert.equal(owned.get(10).born, "original");
});

test("chat guard rejects unknown or enabled tools, attachments, builder, wrong mode", () => {
    assertChat(State, 0);
    for (const change of [
        { modeok: false },
        { configok: false },
        { toolsoff: false },
        { builder: true },
        { error: true },
        { status: "error" },
        { calls: 1 },
        { attachments: 1 },
        { users: 1 },
        { assistants: 1 },
    ]) {
        assert.throws(() => assertChat({ ...State, ...change }, 0));
    }
});

test("one-response budget is explicit and consumed before any uncertain click", () => {
    const marker = { responses: 0 };
    assert.throws(() => consumeResponse(marker, false), { code: "RESPONSE_NOT_APPROVED" });
    assert.equal(marker.responses, 0);
    consumeResponse(marker, true);
    assert.equal(marker.responses, 1);
    assert.throws(() => consumeResponse(marker, true), { code: "RESPONSE_ALREADY_ATTEMPTED" });
    assert.ok(
        Source.indexOf('consumeResponse(marker, opts["approve-response"])') <
            Source.indexOf('await click(panel().getByRole("button", { name: "Send"')
    );
});

test("unexpected errors never reveal raw exception text or stack", () => {
    assert.equal(failureCode(new Error("synthetic-secret-DO-NOT-REPORT")), "UNEXPECTED_FAILURE");
    assert.equal(failureCode(new SmokeFailure("ACCOUNT_UNAVAILABLE")), "ACCOUNT_UNAVAILABLE");
    assert.equal(Source.includes("console.error(error"), false);
    assert.equal(Source.includes("error.stack"), false);
    assert.equal(Source.includes("error.message"), false);
});

test("no sensitive evidence collectors or terminal inputs are present", () => {
    for (const pattern of [
        /\.screenshot\(/,
        /\.content\(/,
        /\.innerText\(/,
        /\.textContent\(/,
        /\.storageState\(/,
        /\.cookies\(/,
        /\.postData\(/,
        /\.allHeaders\(/,
        /\.tracing\./,
        /recordHar/,
        /recordVideo/,
        /get-secret-value/,
        /batch-get-secret-value/,
        /getAuthKey\(/,
        /\.on\(["'](?:console|response|request|websocket)["']/,
        /\.press\(["']Enter["']/,
    ])
        assert.doesNotMatch(Source, pattern);
    assert.match(Source, /stdout\?\.resume\(\)/);
    assert.match(Source, /stderr\?\.resume\(\)/);
    assert.match(Source, /stdio: "ignore"/);
    assert.match(Source, /"ai:capabilities": \[\]/);
    assert.match(Source, /"term:localshellpath": "\/usr\/bin\/false"/);
});
