#!/usr/bin/env node
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const ExecFile = promisify(execFile);
const Commit = /^[0-9a-f]{40}$/;
const Digest = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const Mode = "waveai@crowe-account";
const Answer = "HYPHEUS_ACCOUNT_OK";
const Prompt = `Account smoke test. Do not use tools. Reply with exactly ${Answer}.`;
const DirNames = ["home", "config", "data", "electron", "tmp", "cache", "xdgconfig", "xdgdata", "runtime"];
const Settings = {
    "autoupdate:enabled": false,
    "autoupdate:installonquit": false,
    "telemetry:enabled": false,
    "term:localshellpath": "/usr/bin/false",
    "term:localshellopts": [],
    "term:durable": false,
    "web:defaulturl": "about:blank",
};
const Modes = {
    [Mode]: {
        "display:name": "Crowe account",
        "ai:provider": "openai",
        "ai:apitype": "crowe-gateway",
        "ai:endpoint": "https://api.crowelogic.com/api/gateway/chat",
        "ai:model": "crowelm-account-default",
        "ai:capabilities": [],
        "ai:switchcompat": ["openai"],
    },
};
const Help = `Native candidate account smoke. No build, install, publish, terminal input, or MCP.

PLAYWRIGHT_MODULE=/absolute/existing/playwright-core/index.js node scripts/smoke-crowe-account.cjs \\
  --app /absolute/candidate/Hypheus.app/Contents/MacOS/Hypheus \\
  --expected-artifact-commit FULL_SHA --artifact-provenance /absolute/provenance.json \\
  --artifact-archive /absolute/downloaded-actions-artifact.zip --expected-team-id APPLE_TEAM_ID \\
  --approve-launch [--approve-response] [--signin-wait-seconds 900] [--stop-after-connect]

Options: --evidence-parent /absolute/existing/directory; --resume /absolute/run-directory;
--stage connect|restore|disconnect (default connect; resume requires restore or disconnect).
Without --approve-launch nothing launches. Without --approve-response no model submission
is allowed. The response flag authorizes at most one fixed text request across this profile;
an uncertain submission consumes the allowance and is NEVER automatically retried.

Connect uses real app buttons. Complete browser sign-in yourself in the system browser;
the harness does not inspect that browser or its approval code. The wait defaults to 15
minutes; expiration/storage/auth errors fail without retries. --stop-after-connect closes
only the owned app and retains the private profile for a later --resume --stage restore.
Otherwise the run restarts, checks connection restoration, disconnects using the UI, then
restarts again to check signed-out state. --stage disconnect is recovery-only, no response.

Provenance uses the downloader schema from smoke-terminal-approval.cjs: headsha, runid,
artifactid, artifactsha256, files.{executable,asar,wavesrv}, and
verification.{codesign,gatekeeper,notarization}=true. Expected SHA and team must be supplied
from independently reviewed CI records. Archive/file hashes and codesign/Gatekeeper are
checked locally; the source-SHA/archive/extracted-file linkage remains a downloader
attestation, not a cryptographically authenticated provenance chain.

No screenshots (including failures), trace, video, HAR, network bodies, auth logs, storage,
or raw errors are collected. Child output is discarded. Reports contain fixed states and
phase durations only. Profiles may contain app-owned sensitive data/logs and are retained,
never uploaded. Resume reuses ONLY this harness's private root, guarded by an exclusive
lock; a stale lock requires manual inspection, never auto-killing a remembered PID.

This is profile isolation, NOT an OS sandbox: macOS Keychain and the human's system
browser remain shared. The app scopes account storage by its isolated config path. Normal
app authentication necessarily accesses its own credentials; the harness does not.
Playwright debugging is enabled, but the signed bundle is not modified. Account mode is
overridden in the isolated config with zero tool capabilities; UI must also say Chat only.
No account refresh token erasure/revocation claim is inferred from UI state. Resume proves
observable restoration, not forced expiry refresh. No layout/cancel/reconnect coverage.
`;

class SmokeFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function check(condition, code) {
    if (!condition) throw new SmokeFailure(code);
}
function failureCode(error) {
    return error instanceof SmokeFailure ? error.code : "UNEXPECTED_FAILURE";
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function options(args = process.argv.slice(2)) {
    const out = {};
    const switches = new Set(["help", "approve-launch", "approve-response", "stop-after-connect"]);
    const values = new Set([
        "app",
        "expected-artifact-commit",
        "artifact-provenance",
        "artifact-archive",
        "expected-team-id",
        "evidence-parent",
        "resume",
        "stage",
        "signin-wait-seconds",
    ]);
    for (let i = 0; i < args.length; i++) {
        check(args[i].startsWith("--"), "INVALID_OPTIONS");
        const key = args[i].slice(2);
        check(!Object.hasOwn(out, key), "DUPLICATE_OPTION");
        if (switches.has(key)) out[key] = true;
        else {
            check(values.has(key) && args[i + 1] && !args[i + 1].startsWith("--"), "INVALID_OPTIONS");
            out[key] = args[++i];
        }
    }
    out.stage ??= "connect";
    check(["connect", "restore", "disconnect"].includes(out.stage), "INVALID_STAGE");
    check(!out.resume || out.stage !== "connect", "RESUME_REQUIRES_RESTORE_OR_DISCONNECT");
    check(out.resume || out.stage === "connect", "STAGE_REQUIRES_RESUME");
    check(!out["stop-after-connect"] || out.stage === "connect", "INVALID_STOP_STAGE");
    check(!out["approve-response"] || out.stage !== "disconnect", "INVALID_RESPONSE_STAGE");
    const seconds = out["signin-wait-seconds"] ?? "900";
    check(/^\d+$/.test(seconds) && Number(seconds) >= 30 && Number(seconds) <= 3600, "INVALID_SIGNIN_WAIT");
    out.waitms = Number(seconds) * 1000;
    return out;
}

function file(value) {
    check(typeof value === "string" && path.isAbsolute(value), "ABSOLUTE_FILE_REQUIRED");
    const real = fs.realpathSync(value);
    check(fs.statSync(real).isFile(), "REGULAR_FILE_REQUIRED");
    return real;
}
async function sha256(filename) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    return hash.digest("hex");
}
function validateProof(proof, expected) {
    check(Commit.test(expected ?? "") && proof.headsha === expected, "COMMIT_MISMATCH");
    check(
        /^\d+$/.test(String(proof.runid)) &&
            /^\d+$/.test(String(proof.artifactid)) &&
            Digest.test(proof.artifactsha256),
        "INVALID_PROVENANCE"
    );
    check(
        ["codesign", "gatekeeper", "notarization"].every((key) => proof.verification?.[key] === true),
        "MISSING_SIGNATURE_ATTESTATION"
    );
    check(
        ["executable", "asar", "wavesrv"].every((key) => Digest.test(proof.files?.[key] ?? "")),
        "MISSING_FILE_DIGEST"
    );
}
function privateDir(dir) {
    const stat = fs.lstatSync(dir);
    check(
        stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
        "UNSAFE_PROFILE_DIRECTORY"
    );
}
function readPrivateJson(filename) {
    const stat = fs.lstatSync(filename);
    check(
        stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.nlink === 1 &&
            stat.uid === process.getuid() &&
            (stat.mode & 0o077) === 0 &&
            stat.size < 16384,
        "UNSAFE_PROFILE_FILE"
    );
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
        fs.closeSync(fd);
    }
}
function writeJson(filename, value, exclusive = false) {
    const flags =
        fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW |
        (exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC);
    const fd = fs.openSync(filename, flags, 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(value) + "\n");
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}
async function bounded(fn, timeout = 15000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(fn),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new SmokeFailure("PHASE_TIMEOUT")), timeout);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
function environment(dirs) {
    return {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: dirs.home,
        TMPDIR: dirs.tmp,
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        LANG: "en_US.UTF-8",
        SHELL: "/usr/bin/false",
        XDG_CONFIG_HOME: dirs.xdgconfig,
        XDG_DATA_HOME: dirs.xdgdata,
        XDG_CACHE_HOME: dirs.cache,
        XDG_RUNTIME_DIR: dirs.runtime,
        WAVETERM_CONFIG_HOME: dirs.config,
        WAVETERM_DATA_HOME: dirs.data,
        WAVETERM_HOME: path.join(dirs.home, "unused"),
        WAVETERM_NOCONFIRMQUIT: "1",
        WAVETERM_NOPING: "1",
        CROWE_AGENT_DISABLED: "1",
        CROWE_FOUNDRY_DISABLED: "1",
    };
}
function signedCheck(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: "ignore", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
        const timer = setTimeout(() => {
            child.kill();
            reject(new SmokeFailure("SIGNATURE_CHECK_TIMEOUT"));
        }, 60000);
        child.once("error", () => {
            clearTimeout(timer);
            reject(new SmokeFailure("SIGNATURE_CHECK_FAILED"));
        });
        child.once("exit", (code) => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new SmokeFailure("SIGNATURE_CHECK_FAILED"));
        });
    });
}
async function processTable() {
    const { stdout } = await ExecFile("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
        timeout: 3000,
        maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), born: match[3] }] : [];
    });
}
function collectOwned(rows, owned, rootpid) {
    const initial = rows.find((row) => row.pid === rootpid);
    if (initial && !owned.size) owned.set(initial.pid, initial);
    let added;
    do {
        added = false;
        for (const row of rows) {
            if (owned.has(row.pid)) continue;
            const parent = owned.get(row.ppid);
            if (!parent || !rows.some((item) => item.pid === parent.pid && item.born === parent.born)) continue;
            owned.set(row.pid, row);
            added = true;
        }
    } while (added);
}
function assertChat(state, expectedCount) {
    check(state.modeok && state.configok && state.toolsoff && !state.builder, "NO_TOOLS_GUARD_FAILED");
    check(!state.error && state.status !== "error", "CHAT_FAILED");
    check(state.calls === 0 && state.attachments === 0, "UNEXPECTED_TOOL_OR_ATTACHMENT");
    check(state.users <= expectedCount && state.assistants <= expectedCount, "UNEXPECTED_MESSAGE_COUNT");
}
function consumeResponse(marker, approved) {
    check(approved === true, "RESPONSE_NOT_APPROVED");
    check(marker.responses === 0, "RESPONSE_ALREADY_ATTEMPTED");
    marker.responses = 1;
}

async function run(opts) {
    check(opts["approve-launch"] === true, "LAUNCH_NOT_APPROVED");
    check(process.platform === "darwin", "MACOS_REQUIRED");
    check(
        !process.env.DEBUG && !process.env.PWDEBUG && !process.env.NODE_OPTIONS && !process.env.NODE_DEBUG,
        "DEBUG_ENV_FORBIDDEN"
    );
    check(/^[A-Z0-9]{10}$/.test(opts["expected-team-id"] ?? ""), "EXPECTED_TEAM_REQUIRED");
    const executable = file(opts.app);
    check(
        /\.app\/Contents\/MacOS\/[^/]+$/.test(executable) && !executable.split(path.sep).includes("Applications"),
        "SEPARATE_CANDIDATE_REQUIRED"
    );
    const bundle = path.resolve(path.dirname(executable), "../..");
    const resources = path.join(bundle, "Contents/Resources");
    const files = {
        executable,
        asar: file(path.join(resources, "app.asar")),
        wavesrv: file(path.join(resources, "app.asar.unpacked/dist/bin", `wavesrv.${process.arch}`)),
    };
    const proof = JSON.parse(fs.readFileSync(file(opts["artifact-provenance"]), "utf8"));
    validateProof(proof, opts["expected-artifact-commit"]);
    check((await sha256(file(opts["artifact-archive"]))) === proof.artifactsha256, "ARCHIVE_DIGEST_MISMATCH");
    const integrity = async () => {
        for (const [key, filename] of Object.entries(files))
            check((await sha256(filename)) === proof.files[key], "FILE_DIGEST_MISMATCH");
        await signedCheck("/usr/bin/codesign", [
            "--verify",
            "--deep",
            "--strict",
            "-R",
            `anchor apple generic and certificate leaf[subject.OU] = "${opts["expected-team-id"]}"`,
            bundle,
        ]);
        await signedCheck("/usr/sbin/spctl", ["--assess", "--type", "execute", bundle]);
    };
    await integrity();
    const playwright = file(process.env.PLAYWRIGHT_MODULE);
    let root;
    let marker;
    if (opts.resume) {
        check(path.isAbsolute(opts.resume), "ABSOLUTE_PROFILE_REQUIRED");
        root = fs.realpathSync(opts.resume);
        check(root === path.resolve(opts.resume), "PROFILE_SYMLINK_FORBIDDEN");
        privateDir(root);
        const markerFile = path.join(root, "account-smoke.json");
        marker = readPrivateJson(markerFile);
        check(
            marker.schema === 1 &&
                marker.root === root &&
                marker.executable === executable &&
                marker.headsha === proof.headsha &&
                marker.asar === proof.files.asar &&
                marker.archive === proof.artifactsha256 &&
                [0, 1].includes(marker.responses),
            "PROFILE_PROVENANCE_MISMATCH"
        );
    } else {
        const parent = opts["evidence-parent"] ?? os.tmpdir();
        check(path.isAbsolute(parent), "ABSOLUTE_PARENT_REQUIRED");
        root = fs.mkdtempSync(path.join(fs.realpathSync(parent), "hypheus-account-smoke-"));
        fs.chmodSync(root, 0o700);
        marker = {
            schema: 1,
            root,
            executable,
            headsha: proof.headsha,
            asar: proof.files.asar,
            archive: proof.artifactsha256,
            responses: 0,
        };
        writeJson(path.join(root, "account-smoke.json"), marker, true);
    }
    const lock = path.join(root, "active.lock");
    fs.mkdirSync(lock, { mode: 0o700 });
    if (opts.resume) marker = readPrivateJson(path.join(root, "account-smoke.json"));
    const save = () => writeJson(path.join(root, "account-smoke.json"), marker);
    const dirs = Object.fromEntries(DirNames.map((name) => [name, path.join(root, name)]));
    const previousUmask = process.umask(0o077);
    const report = { schema: 1, status: "failed", phases: [], responseattempted: marker.responses === 1 };
    let phase = "setup";
    let app;
    let launchAttempted = false;
    let page;
    let monitor;
    let tracking;
    let interrupted = false;
    let monitorFailed = false;
    let gate = { allowed: false, count: 0, unexpected: false };
    const owned = new Map();
    const stop = () => {
        interrupted = true;
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const alive = () => {
        check(!interrupted, "INTERRUPTED");
        check(!monitorFailed, "PROCESS_TRACKING_FAILED");
        check(!gate.unexpected, "UNAPPROVED_MODEL_REQUEST");
    };
    const until = async (fn, timeout = 30000) => {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            alive();
            const result = await bounded(fn);
            if (result) return result;
            await pause(200);
        }
        throw new SmokeFailure("PHASE_TIMEOUT");
    };
    const timed = async (name, action) => {
        phase = name;
        const start = Date.now();
        await action();
        report.phases.push({ phase: name, durationms: Date.now() - start, status: "passed" });
        console.log(JSON.stringify({ phase: name, status: "passed" }));
    };
    const track = () => {
        if (tracking) return tracking;
        tracking = processTable()
            .then((rows) => collectOwned(rows, owned, app?.process()?.pid))
            .finally(() => {
                tracking = null;
            });
        return tracking;
    };
    const close = async () => {
        clearInterval(monitor);
        if (!app) {
            check(!launchAttempted, "LAUNCH_CLEANUP_UNVERIFIED");
            return;
        }
        let failed = false;
        try {
            await track();
        } catch {
            failed = true;
        }
        await Promise.race([app.close().catch(() => {}), pause(8000)]);
        for (const signal of ["SIGTERM", "SIGKILL"]) {
            for (const row of (await processTable()).reverse()) {
                if (owned.get(row.pid)?.born !== row.born) continue;
                try {
                    process.kill(row.pid, signal);
                } catch (error) {
                    if (error.code !== "ESRCH") failed = true;
                }
            }
            await pause(300);
        }
        check(!(await processTable()).some((row) => owned.get(row.pid)?.born === row.born), "OWNED_PROCESS_SURVIVED");
        app = null;
        launchAttempted = false;
        page = null;
        owned.clear();
        check(!failed && !monitorFailed, "PROCESS_CLEANUP_FAILED");
    };
    const native = () =>
        app.evaluate(({ BaseWindow }) =>
            BaseWindow.getAllWindows().flatMap((win) => {
                const view = win.activeTabView;
                if (
                    win.isDestroyed() ||
                    !win.isVisible() ||
                    win.isMinimized() ||
                    !view ||
                    view.isDestroyed ||
                    !view.isActiveTab ||
                    !view.isInitialized ||
                    !view.isWaveReady ||
                    !win.contentView.children.includes(view) ||
                    view.webContents.isDestroyed()
                )
                    return [];
                const bounds = view.getBounds();
                if (bounds.width <= 0 || bounds.height <= 0) return [];
                return [
                    {
                        windowid: win.waveWindowId,
                        tabid: view.waveTabId,
                        viewwindowid: view.waveWindowId,
                        webcontentsid: view.webContents.id,
                        url: view.webContents.getURL(),
                    },
                ];
            })
        );
    const expectedUrl = pathToFileURL(path.join(files.asar, "dist/frontend/index.html")).href;
    const renderer = async () => {
        const windows = await native();
        check(windows.length <= 1, "AMBIGUOUS_RENDERER");
        if (!windows.length) return false;
        const win = windows[0];
        check(
            win.url === expectedUrl &&
                UUID.test(win.windowid) &&
                UUID.test(win.tabid) &&
                win.viewwindowid === win.windowid,
            "NATIVE_RENDERER_MISMATCH"
        );
        const matches = [];
        for (const candidate of app.windows()) {
            if (candidate.isClosed() || candidate.url() !== expectedUrl) continue;
            const matchesIdentity = await candidate.evaluate(
                ({ windowid, tabid }) => {
                    const store = window.globalStore;
                    const atoms = window.globalAtoms;
                    const main = document.getElementById("main");
                    const bounds = main?.getBoundingClientRect();
                    return Boolean(
                        store &&
                        atoms &&
                        main?.childElementCount &&
                        bounds?.width > 0 &&
                        bounds?.height > 0 &&
                        document.visibilityState === "visible" &&
                        store.get(atoms.uiContext).windowid === windowid &&
                        store.get(atoms.staticTabId) === tabid
                    );
                },
                { windowid: win.windowid, tabid: win.tabid }
            );
            if (matchesIdentity) matches.push(candidate);
        }
        check(matches.length <= 1, "AMBIGUOUS_RENDERER");
        if (!matches.length) return false;
        const current = await native();
        check(
            current.length === 1 && current[0].webcontentsid === win.webcontentsid && current[0].tabid === win.tabid,
            "RENDERER_CHANGED"
        );
        if (page) check(page === matches[0], "RENDERER_CHANGED");
        return matches[0];
    };
    const click = async (locator) => {
        alive();
        check(await renderer(), "RENDERER_UNAVAILABLE");
        check(
            (await locator.count()) === 1 && (await locator.isVisible()) && (await locator.isEnabled()),
            "UI_ACTION_UNAVAILABLE"
        );
        await locator.click({ timeout: 10000 });
    };
    const panel = () => page.locator('[data-waveai-panel="true"]');
    const setup = () => panel().getByRole("region", { name: "Crowe account setup", exact: true });
    const accountState = async () => {
        check(await renderer(), "RENDERER_UNAVAILABLE");
        const labels = {
            signedout: "Not connected",
            starting: "Connecting",
            pending: "Waiting for approval",
            connected: "Connected",
            expired: "Connection expired",
            error: "Connection unavailable",
        };
        for (const [state, label] of Object.entries(labels)) {
            if (
                (await panel()
                    .getByRole("button", { name: `Crowe account: ${label}. Open account setup`, exact: true })
                    .count()) === 1
            )
                return state;
        }
        return "checking";
    };
    const chat = () =>
        page.evaluate(
            ({ mode, answer }) => {
                const model = window.WaveAIModel;
                const store = window.globalStore;
                const messages = window.aichatmessages;
                if (!model || !store || !Array.isArray(messages)) return null;
                const config = store.get(model.aiModeConfigs)?.[mode];
                const assistants = messages.filter((message) => message.role === "assistant");
                return {
                    modeok: store.get(model.currentAIMode) === mode && store.get(model.defaultModeAtom) === mode,
                    configok:
                        config?.["ai:apitype"] === "crowe-gateway" &&
                        config?.["ai:endpoint"] === "https://api.crowelogic.com/api/gateway/chat" &&
                        config?.["ai:model"] === "crowelm-account-default" &&
                        (config["ai:capabilities"] == null ||
                            (Array.isArray(config["ai:capabilities"]) && config["ai:capabilities"].length === 0)),
                    toolsoff: store.get(model.widgetAccessAtom) === false,
                    builder: model.inBuilder !== false,
                    status: ["ready", "submitted", "streaming", "error"].includes(window.aichatstatus)
                        ? window.aichatstatus
                        : "unknown",
                    error: Boolean(store.get(model.errorMessage)),
                    attachments: store.get(model.droppedFiles).length,
                    users: messages.filter((message) => message.role === "user").length,
                    assistants: assistants.length,
                    calls: messages
                        .flatMap((message) => message.parts ?? [])
                        .filter((part) => part.type === "data-tooluse" || part.type?.startsWith("tool-")).length,
                    exact:
                        assistants.length === 1 &&
                        assistants[0].parts
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("") === answer,
                };
            },
            { mode: Mode, answer: Answer }
        );
    const chatOnly = async () => {
        const tools = panel().getByRole("group", { name: "Tool authority", exact: true }).getByRole("button");
        check((await tools.count()) === 1, "TOOLS_CONTROL_MISSING");
        if ((await tools.getAttribute("aria-pressed")) === "true") await click(tools);
        await until(async () => (await tools.getAttribute("aria-pressed")) === "false" && (await chat())?.toolsoff);
        const state = await chat();
        assertChat(opts.stage === "disconnect" ? { ...state, error: false, status: "ready" } : state, marker.responses);
    };
    const openAccount = async () => {
        await click(panel().getByRole("button", { name: /^Crowe account: .+\. Open account setup$/ }));
        await setup().waitFor({ state: "visible", timeout: 10000 });
    };
    const waitAccount = (expected, timeout) =>
        until(async () => {
            const state = await accountState();
            check(!["expired", "error"].includes(state), "ACCOUNT_UNAVAILABLE");
            check((await setup().getByRole("alert").count()) === 0, "ACCOUNT_UI_ALERT");
            check(
                (await setup().getByRole("button", { name: "Retry credential removal", exact: true }).count()) === 0,
                "CREDENTIAL_REMOVAL_FAILED"
            );
            const busy = await setup()
                .getByRole("status")
                .filter({ hasText: /^(Canceling connection|Disconnecting)$/ })
                .count();
            return state === expected && busy === 0;
        }, timeout);
    const launch = async () => {
        alive();
        await integrity();
        for (const dir of Object.values(dirs)) privateDir(dir);
        const { _electron } = require(playwright);
        check(typeof _electron?.launch === "function", "PLAYWRIGHT_UNAVAILABLE");
        gate = { allowed: false, count: 0, unexpected: false };
        launchAttempted = true;
        app = await _electron.launch({
            executablePath: executable,
            args: [`--user-data-dir=${dirs.electron}`],
            cwd: dirs.home,
            env: environment(dirs),
            timeout: 60000,
        });
        app.process().stdout?.resume();
        app.process().stderr?.resume();
        await track();
        check(owned.has(app.process().pid), "LAUNCH_PROCESS_NOT_OBSERVED");
        monitor = setInterval(() => {
            track().catch(() => {
                monitorFailed = true;
            });
        }, 250);
        // Route by URL/method only. Never inspect request headers, bodies, or responses.
        await app.context().route("**/api/post-chat-message*", async (route) => {
            if (route.request().method() !== "POST" || !gate.allowed || gate.count !== 0) {
                gate.unexpected = true;
                await route.abort();
                return;
            }
            gate.count++;
            gate.allowed = false;
            await route.continue();
        });
        const identity = await app.evaluate(({ app }) => ({
            packaged: app.isPackaged,
            version: app.getVersion(),
            executable: process.execPath,
            apppath: app.getAppPath(),
            resources: process.resourcesPath,
            userdata: app.getPath("userData"),
            envhome: process.env.HOME,
            arch: process.arch,
        }));
        check(
            identity.packaged &&
                fs.realpathSync(identity.executable) === executable &&
                identity.apppath === files.asar &&
                identity.resources === resources &&
                identity.userdata === dirs.electron &&
                identity.envhome === dirs.home &&
                identity.arch === process.arch,
            "RUNTIME_IDENTITY_MISMATCH"
        );
        page = await until(renderer, 60000);
        page.setDefaultTimeout(10000);
        for (let i = 0; i < 5; i++) {
            const next = page.getByRole("button", { name: /^(Continue|Open workspace)$/ }).filter({ visible: true });
            if (!(await next.count())) break;
            await click(next);
            await pause(350);
        }
        if (!(await panel().isVisible())) await page.keyboard.press("Meta+Shift+A");
        await panel().waitFor({ state: "visible", timeout: 15000 });
        const runtime = await page.evaluate(
            ({ expected, settings }) => {
                const effective = window.globalStore.get(window.globalAtoms.settingsAtom);
                const about = window.api.getAboutModalDetails();
                return {
                    isolated:
                        window.api.getDataDir() === expected.data && window.api.getConfigDir() === expected.config,
                    settingsok: Object.entries(settings).every(
                        ([key, value]) =>
                            JSON.stringify(effective[key]) === JSON.stringify(value) ||
                            ((value === false || (Array.isArray(value) && value.length === 0)) &&
                                effective[key] == null)
                    ),
                    backendversion: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/.test(about.version)
                        ? about.version
                        : null,
                    backendbuildtime:
                        Number.isSafeInteger(about.buildTime) && about.buildTime > 0 ? about.buildTime : null,
                };
            },
            { expected: dirs, settings: Settings }
        );
        check(runtime.isolated, "BACKEND_PROFILE_MISMATCH");
        check(runtime.settingsok, "EFFECTIVE_SAFETY_SETTINGS_MISMATCH");
        check(
            runtime.backendversion && runtime.backendversion === identity.version && runtime.backendbuildtime,
            "BACKEND_IDENTITY_UNAVAILABLE"
        );
        if (report.backendversion)
            check(
                report.backendversion === runtime.backendversion &&
                    report.backendbuildtime === runtime.backendbuildtime,
                "BACKEND_IDENTITY_CHANGED"
            );
        report.backendversion = runtime.backendversion;
        report.backendbuildtime = runtime.backendbuildtime;
        await until(async () => {
            const state = await chat();
            return state?.status === "ready" || (opts.stage === "disconnect" && state?.status === "error");
        });
        await chatOnly();
        await openAccount();
    };
    const response = async () => {
        if (!opts["approve-response"]) return;
        check((await accountState()) === "connected", "ACCOUNT_NOT_CONNECTED");
        await chatOnly();
        const state = await chat();
        assertChat(state, 0);
        check(state.status === "ready" && state.users === 0 && state.assistants === 0, "FRESH_CHAT_REQUIRED");
        const input = panel().getByRole("textbox", { name: "Message Hypheus", exact: true });
        check((await input.count()) === 1 && (await input.inputValue()) === "", "EMPTY_COMPOSER_REQUIRED");
        await input.fill(Prompt);
        await chatOnly();
        consumeResponse(marker, opts["approve-response"]);
        save();
        report.responseattempted = true;
        gate.allowed = true;
        await click(panel().getByRole("button", { name: "Send", exact: true }));
        await until(async () => {
            const current = await chat();
            assertChat(current, 1);
            if (current.status !== "ready" || current.assistants !== 1) return false;
            check(current.users === 1 && current.exact && gate.count === 1, "RESPONSE_MISMATCH");
            return true;
        }, 120000);
    };
    try {
        for (const dir of Object.values(dirs)) {
            if (!opts.resume) fs.mkdirSync(dir, { mode: 0o700 });
            privateDir(dir);
        }
        if (!opts.resume) {
            writeJson(path.join(dirs.config, "settings.json"), Settings, true);
            writeJson(path.join(dirs.config, "waveai.json"), Modes, true);
        }
        // Only synthetic config is read; account storage, databases and runtime logs are never opened.
        const settings = readPrivateJson(path.join(dirs.config, "settings.json"));
        const modes = readPrivateJson(path.join(dirs.config, "waveai.json"));
        check(
            Object.entries(Settings).every(([key, value]) => JSON.stringify(settings[key]) === JSON.stringify(value)) &&
                JSON.stringify(modes) === JSON.stringify(Modes),
            "PROFILE_SAFETY_CONFIG_CHANGED"
        );
        console.log(JSON.stringify({ phase: "profile", profile: root }));
        await timed("launch", launch);
        if (opts.stage === "connect") {
            await timed("connect", async () => {
                await waitAccount("signedout", 15000);
                check(marker.responses === 0, "FRESH_PROFILE_REQUIRED");
                await click(setup().getByRole("button", { name: "Connect account", exact: true }));
                console.log(
                    JSON.stringify({ phase: "human-signin", status: "waiting", waitseconds: opts.waitms / 1000 })
                );
                await waitAccount("connected", opts.waitms);
            });
        } else if (opts.stage === "restore") await timed("restore", () => waitAccount("connected", 60000));
        if (opts.stage !== "disconnect" && opts["approve-response"]) await timed("single-response", response);
        if (!opts["stop-after-connect"]) {
            if (opts.stage !== "disconnect") {
                await timed("restart", async () => {
                    await close();
                    await launch();
                    await waitAccount("connected", 60000);
                });
            }
            await timed("disconnect", async () => {
                await until(async () => (await accountState()) !== "checking");
                await click(setup().getByRole("button", { name: "Disconnect account", exact: true }));
                await waitAccount("signedout", 30000);
                check(
                    (await setup().getByRole("button", { name: "Retry credential removal", exact: true }).count()) ===
                        0,
                    "CREDENTIAL_REMOVAL_FAILED"
                );
            });
            await timed("signedout-restart", async () => {
                await close();
                await launch();
                await waitAccount("signedout", 60000);
            });
        }
        alive();
        await integrity();
        report.status = opts["stop-after-connect"] ? "paused" : "passed";
    } catch (error) {
        report.failure = failureCode(error);
        report.failedphase = phase;
    } finally {
        try {
            await close();
            report.cleanup = "passed";
        } catch {
            report.cleanup = "failed";
            report.status = "failed";
        }
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        process.umask(previousUmask);
        writeJson(path.join(root, `result-${crypto.randomUUID()}.json`), report, true);
        if (report.cleanup === "passed") fs.rmdirSync(lock);
        console.log(JSON.stringify(report));
    }
    return report.status === "failed" ? 1 : 0;
}

if (require.main === module) {
    Promise.resolve()
        .then(() => {
            const opts = options();
            if (opts.help) {
                console.log(Help);
                return 0;
            }
            return run(opts);
        })
        .then((code) => {
            process.exitCode = code;
        })
        .catch((error) => {
            console.error(JSON.stringify({ status: "failed", failure: failureCode(error) }));
            process.exitCode = 1;
        });
}

module.exports = {
    options,
    validateProof,
    environment,
    collectOwned,
    assertChat,
    consumeResponse,
    failureCode,
    SmokeFailure,
    run,
};
