// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuthKey } from "./authkey";

const BRIDGE_PORT = 8011;
const BRIDGE_HOST = "127.0.0.1";

let bridgeProc: child_process.ChildProcess | null = null;
let bridgeReady = false;

function findFoundryRoot(): string | null {
    const envPath = process.env.CROWE_FOUNDRY_PATH;
    if (envPath && fs.existsSync(path.join(envPath, "cli", "openai_bridge.py"))) {
        return envPath;
    }
    const candidates = [
        path.join(os.homedir(), "Projects", "crowe-logic-foundry"),
        path.join(os.homedir(), "crowe-logic-foundry"),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, "cli", "openai_bridge.py"))) {
            return c;
        }
    }
    return null;
}

function findPython(foundryRoot: string): string {
    const venvPython = path.join(foundryRoot, ".venv", "bin", "python");
    if (fs.existsSync(venvPython)) {
        return venvPython;
    }
    return "python3";
}

async function probeBridge(timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://${BRIDGE_HOST}:${BRIDGE_PORT}/healthz`);
            if (res.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

export function isBridgeReady(): boolean {
    return bridgeReady;
}

export async function startFoundryBridge(): Promise<boolean> {
    if (bridgeProc) return bridgeReady;

    if (await probeBridge(800)) {
        console.log("[foundry-bridge] external bridge already running on", BRIDGE_PORT);
        bridgeReady = true;
        return true;
    }

    const foundryRoot = findFoundryRoot();
    if (!foundryRoot) {
        console.log("[foundry-bridge] CROWE_FOUNDRY_PATH not set and ~/Projects/crowe-logic-foundry not found; skipping auto-spawn");
        return false;
    }

    const python = findPython(foundryRoot);
    console.log(`[foundry-bridge] spawning ${python} -m cli.openai_bridge in ${foundryRoot}`);

    bridgeProc = child_process.spawn(python, ["-m", "cli.openai_bridge"], {
        cwd: foundryRoot,
        env: {
            ...process.env,
            CROWE_BRIDGE_HOST: BRIDGE_HOST,
            CROWE_BRIDGE_PORT: String(BRIDGE_PORT),
            PYTHONPATH: foundryRoot,
            CROWE_PORTFOLIO_URL: process.env.CROWE_PORTFOLIO_URL ?? "",
            CROWE_PORTFOLIO_TOKEN: process.env.CROWE_PORTFOLIO_TOKEN ?? "",
            // Enable Crowe Terminal's remote-tool registration in the
            // Foundry bridge. The auth key is the same one wavesrv accepts;
            // both processes are children of this Electron main, so they
            // share a token boundary by definition.
            CROWE_AGENT_TOOLS: "1",
            CROWE_AGENT_HOST: process.env.CROWE_AGENT_HOST ?? "127.0.0.1",
            CROWE_AGENT_PORT: process.env.CROWE_AGENT_PORT ?? "8012",
            WAVETERM_AUTH_KEY: AuthKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });

    bridgeProc.stdout?.on("data", (chunk: Buffer) => {
        process.stdout.write(`[foundry-bridge] ${chunk.toString()}`);
    });
    bridgeProc.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(`[foundry-bridge] ${chunk.toString()}`);
    });
    bridgeProc.on("exit", (code) => {
        console.log(`[foundry-bridge] exited with code ${code}`);
        bridgeProc = null;
        bridgeReady = false;
    });

    bridgeReady = await probeBridge();
    if (!bridgeReady) {
        console.warn("[foundry-bridge] failed to become ready within timeout");
    } else {
        console.log("[foundry-bridge] ready on http://127.0.0.1:8011");
    }
    return bridgeReady;
}

export function stopFoundryBridge(): void {
    if (!bridgeProc) return;
    try {
        bridgeProc.kill("SIGTERM");
    } catch (e) {
        console.warn("[foundry-bridge] kill failed", e);
    }
    bridgeProc = null;
    bridgeReady = false;
}
