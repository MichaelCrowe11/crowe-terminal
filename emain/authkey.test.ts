// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Ipc = vi.hoisted(() => ({ on: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: Ipc }));
const HostHeaders = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock("../frontend/util/fetchutil", () => ({
    setHostBackendHeaders: (headers: Record<string, string>) => (HostHeaders.value = { ...headers }),
}));
vi.mock("../frontend/util/endpoints", () => ({
    getWebServerEndpoint: () => "http://127.0.0.1:5010",
    getWSServerEndpoint: () => "ws://127.0.0.1:5011",
}));

import { AuthKey, configureAuthKeyRequestInjection, registerTrustedRenderer, setWaveSrvFrontendKey } from "./authkey";

const AppDocument = "file:///app/frontend/index.html";
let NextId = 1;

function makeContents(type = "window", url = AppDocument) {
    const contents = Object.assign(new EventEmitter(), {
        id: NextId++,
        getType: () => type,
        isDestroyed: () => false,
        mainFrame: { url, isDestroyed: () => false },
    });
    return contents as unknown as Electron.WebContents;
}

describe("frontend authentication provenance", () => {
    let request: (details: Partial<Electron.OnBeforeSendHeadersListenerDetails>) => any;

    beforeEach(() => {
        const hook = vi.fn();
        configureAuthKeyRequestInjection({ webRequest: { onBeforeSendHeaders: hook } } as any);
        const callback = hook.mock.calls[0][1];
        request = (details) => {
            const done = vi.fn();
            callback(
                { url: "ws://127.0.0.1:5011/ws", resourceType: "webSocket", requestHeaders: {}, ...details },
                done
            );
            return done.mock.calls[0][0];
        };
    });

    it.each(["window", "browserView"])("allows registered %s main-frame sockets and resources", (type) => {
        const contents = makeContents(type);
        registerTrustedRenderer(contents, AppDocument);
        const identity = { webContents: contents, webContentsId: contents.id, frame: contents.mainFrame };
        const socket = request(identity);
        expect(socket.cancel).not.toBe(true);
        expect(socket.requestHeaders["X-AuthKey"]).toBe(AuthKey);
        const env = {};
        setWaveSrvFrontendKey(env);
        expect(socket.requestHeaders["X-Wave-Frontend-Key"]).toBe(env["WAVETERM_FRONTEND_KEY"]);
        for (const resourceType of ["xhr", "image", "media", "script", "stylesheet"] as const) {
            const resource = request({ ...identity, url: "http://127.0.0.1:5010/api/resource", resourceType });
            expect(resource.cancel).not.toBe(true);
            expect(resource.requestHeaders["X-AuthKey"]).toBe(AuthKey);
            expect(resource.requestHeaders["X-Wave-Frontend-Key"]).toBe(env["WAVETERM_FRONTEND_KEY"]);
        }
        (contents.mainFrame as { url: string }).url = `${AppDocument}#tab`;
        expect(request(identity).cancel).not.toBe(true);
    });

    it("denies webviews, unregistered windows, subframes, workers, and forged headers", () => {
        const contents = makeContents();
        registerTrustedRenderer(contents, AppDocument);
        const guest = makeContents("webview");
        const other = makeContents();
        const attacks = [
            {},
            { webContents: guest, webContentsId: guest.id, frame: guest.mainFrame },
            { webContents: other, webContentsId: other.id, frame: other.mainFrame },
            { webContents: contents, webContentsId: contents.id, frame: null },
            { webContents: contents, webContentsId: contents.id, frame: { ...contents.mainFrame } },
            { webContents: contents, webContentsId: contents.id + 100, frame: contents.mainFrame },
            { webContents: contents, webContentsId: contents.id, frame: contents.mainFrame, resourceType: "mainFrame" },
            { webContents: contents, webContentsId: contents.id, frame: contents.mainFrame, resourceType: "subFrame" },
        ];
        for (const attack of attacks) {
            expect(
                request({ ...attack, requestHeaders: { "x-authkey": AuthKey, "X-WAVE-FRONTEND-KEY": "forged" } } as any)
                    .cancel
            ).toBe(true);
        }
        expect(() => registerTrustedRenderer(guest, AppDocument)).toThrow();
    });

    it("rejects changed documents, query strings, destroyed contents, and stale frames", () => {
        const contents = makeContents();
        registerTrustedRenderer(contents, AppDocument);
        const identity = { webContents: contents, webContentsId: contents.id, frame: contents.mainFrame };
        for (const url of ["about:blank", "https://evil.test/", `${AppDocument}?evil=1`, `${AppDocument}/evil`]) {
            (contents.mainFrame as { url: string }).url = url;
            expect(request(identity).cancel).toBe(true);
        }
        (contents.mainFrame as { url: string }).url = AppDocument;
        contents.emit("destroyed");
        expect(request(identity).cancel).toBe(true);
    });

    it("supports the exact development document, not its sibling paths", () => {
        const url = "http://localhost:5173/index.html";
        const contents = makeContents("window", url);
        registerTrustedRenderer(contents, url);
        const identity = { webContents: contents, webContentsId: contents.id, frame: contents.mainFrame };
        expect(request(identity).cancel).not.toBe(true);
        (contents.mainFrame as { url: string }).url = "http://localhost:5173/preview.html";
        expect(request(identity).cancel).toBe(true);
    });

    it("strips auth headers case-insensitively on external redirects", () => {
        const headers = {
            "x-authkey": "synthetic",
            "X-AuthKey": "synthetic",
            "X-WAVE-FRONTEND-KEY": "synthetic",
            Accept: "text/html",
        };
        const result = request({ url: "https://external.test/redirect", requestHeaders: headers });
        expect(result.requestHeaders).toEqual({ Accept: "text/html" });
    });

    it("admits only exact main-process key requests to the web backend", () => {
        const [[name, key]] = Object.entries(HostHeaders.value);
        const main = { url: "http://127.0.0.1:5010/wave/service", resourceType: "other" as const };
        const allowed = request({ ...main, requestHeaders: { [name.toLowerCase()]: key, Accept: "*/*" } });
        expect(allowed.cancel).not.toBe(true);
        expect(allowed.requestHeaders).toEqual({ Accept: "*/*", "X-AuthKey": AuthKey });

        const contents = makeContents();
        const denied = [
            { ...main, requestHeaders: { [name]: "wrong" } },
            { ...main, requestHeaders: { [name]: key, [name.toUpperCase()]: key } },
            { ...main, requestHeaders: {} },
            { url: "ws://127.0.0.1:5011/ws", resourceType: "webSocket", requestHeaders: { [name]: key } },
            { ...main, resourceType: "mainFrame", requestHeaders: { [name]: key } },
            { ...main, resourceType: "subFrame", requestHeaders: { [name]: key } },
            { ...main, webContents: contents, webContentsId: contents.id, requestHeaders: { [name]: key } },
            { ...main, webContentsId: 7, requestHeaders: { [name]: key } },
        ];
        for (const attack of denied) {
            expect(request(attack as any).cancel).toBe(true);
        }
        const external = request({ url: "https://external.test/", requestHeaders: { [name]: key, Accept: "*/*" } });
        expect(external.cancel).not.toBe(true);
        expect(external.requestHeaders).toEqual({ Accept: "*/*" });
    });

    it("limits key IPC to the registered main frame", () => {
        const ipc = Ipc.on.mock.calls.find(([name]) => name === "get-auth-key")[1];
        const contents = makeContents();
        registerTrustedRenderer(contents, AppDocument);
        const trusted = { sender: contents, senderFrame: contents.mainFrame, returnValue: "" };
        ipc(trusted);
        expect(trusted.returnValue).toBe(AuthKey);
        for (const senderFrame of [null, { ...contents.mainFrame }]) {
            const denied = { sender: contents, senderFrame, returnValue: "" };
            ipc(denied);
            expect(denied.returnValue).toBe("");
        }
        (contents.mainFrame as { url: string }).url = "https://evil.test/";
        ipc(trusted);
        expect(trusted.returnValue).toBe("");
    });

    it("blocks unexpected navigation and redirects before renderer loading", () => {
        const contents = makeContents();
        registerTrustedRenderer(contents, AppDocument);
        for (const eventName of ["will-navigate", "will-redirect"]) {
            const event = { preventDefault: vi.fn() };
            contents.emit(eventName, event, "https://evil.test/");
            expect(event.preventDefault).toHaveBeenCalled();
            const reload = { preventDefault: vi.fn() };
            contents.emit(eventName, reload, AppDocument);
            expect(reload.preventDefault).not.toHaveBeenCalled();
        }
    });
});
