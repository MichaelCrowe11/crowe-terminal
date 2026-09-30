// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ipcMain } from "electron";
import { getWebServerEndpoint, getWSServerEndpoint } from "../frontend/util/endpoints";
import { setHostBackendHeaders } from "../frontend/util/fetchutil";

const AuthKeyHeader = "X-AuthKey";
export const WaveAuthKeyEnv = "WAVETERM_AUTH_KEY";
export const AuthKey = crypto.randomUUID();
const FrontendKeyHeader = "X-Wave-Frontend-Key";
const FrontendKeyEnv = "WAVETERM_FRONTEND_KEY";
const FrontendKey = crypto.randomUUID();
// Main-process net.fetch calls have no webContents. They prove their origin with a key
// that never leaves this process (no IPC exposure) and is stripped before sending.
const MainProcessKeyHeader = "X-Hypheus-Main-Process";
const MainProcessKey = crypto.randomUUID();
setHostBackendHeaders({ [MainProcessKeyHeader]: MainProcessKey });
const TrustedRenderers = new Map<number, { contents: Electron.WebContents; document: string }>();

function documentURL(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username || parsed.password || !["file:", "http:", "https:"].includes(parsed.protocol)) {
            return null;
        }
        parsed.hash = "";
        return parsed.href;
    } catch {
        return null;
    }
}

export function registerTrustedRenderer(contents: Electron.WebContents, expectedDocument: string) {
    const document = documentURL(expectedDocument);
    if (!document || contents.getType() === "webview") {
        throw new Error("Invalid trusted renderer registration");
    }
    TrustedRenderers.set(contents.id, { contents, document });
    contents.once("destroyed", () => TrustedRenderers.delete(contents.id));
    const restrictNavigation = (event: Electron.Event, url: string) => {
        if (documentURL(url) !== document) {
            event.preventDefault();
        }
    };
    contents.on("will-navigate", restrictNavigation);
    contents.on("will-redirect", restrictNavigation);
}

function isTrustedRendererFrame(contents: Electron.WebContents, frame: Electron.WebFrameMain): boolean {
    try {
        if (!contents || contents.isDestroyed() || !frame || frame.isDestroyed()) {
            return false;
        }
        const registered = TrustedRenderers.get(contents.id);
        return (
            registered?.contents === contents &&
            contents.getType() !== "webview" &&
            frame === contents.mainFrame &&
            documentURL(frame.url) === registered.document
        );
    } catch {
        return false;
    }
}

export function setWaveSrvFrontendKey(env: NodeJS.ProcessEnv) {
    env[FrontendKeyEnv] = FrontendKey;
}

ipcMain.on("get-auth-key", (event) => {
    event.returnValue = isTrustedRendererFrame(event.sender, event.senderFrame) ? AuthKey : "";
});

export function configureAuthKeyRequestInjection(session: Electron.Session) {
    // Inspect redirect destinations too, so privileged headers cannot follow a redirect off the backend.
    const filter: Electron.WebRequestFilter = { urls: ["<all_urls>"] };
    session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        const stripped = [AuthKeyHeader, FrontendKeyHeader, MainProcessKeyHeader].map((name) => name.toLowerCase());
        const mainProcessValues: string[] = [];
        for (const name of Object.keys(details.requestHeaders)) {
            const lower = name.toLowerCase();
            if (lower === MainProcessKeyHeader.toLowerCase()) {
                mainProcessValues.push(details.requestHeaders[name]);
            }
            if (stripped.includes(lower)) {
                delete details.requestHeaders[name];
            }
        }
        const target = new URL(details.url);
        const isWebBackend = target.origin === new URL(getWebServerEndpoint()).origin;
        const isWSBackend = target.origin === new URL(getWSServerEndpoint()).origin;
        if (!isWebBackend && !isWSBackend) {
            callback({ requestHeaders: details.requestHeaders });
            return;
        }
        const fromMainProcess =
            details.webContents == null &&
            details.webContentsId == null &&
            mainProcessValues.length === 1 &&
            mainProcessValues[0] === MainProcessKey;
        if (
            fromMainProcess &&
            isWebBackend &&
            details.resourceType !== "mainFrame" &&
            details.resourceType !== "subFrame"
        ) {
            details.requestHeaders[AuthKeyHeader] = AuthKey;
            callback({ requestHeaders: details.requestHeaders });
            return;
        }
        if (
            details.webContentsId !== details.webContents?.id ||
            !isTrustedRendererFrame(details.webContents, details.frame) ||
            details.resourceType === "mainFrame" ||
            details.resourceType === "subFrame"
        ) {
            callback({ cancel: true });
            return;
        }
        details.requestHeaders[AuthKeyHeader] = AuthKey;
        if (isWebBackend || (isWSBackend && details.resourceType === "webSocket" && target.pathname === "/ws")) {
            details.requestHeaders[FrontendKeyHeader] = FrontendKey;
        }
        callback({ requestHeaders: details.requestHeaders });
    });
}
