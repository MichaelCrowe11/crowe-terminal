// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// WebWshClient handles wshrpc commands routed to a specific in-window
// web block. Used by the Crowe Agent's browser.* tools to drive the
// webview from the Go backend without leaving the Wave window.

import { RpcResponseHelper, WshClient } from "@/app/store/wshclient";
import { makeFeBlockRouteId } from "@/app/store/wshrouter";
import type { WebViewModel } from "@/app/view/webview/webview";
import type { EmbeddedWebview } from "@/app/waveenv/embeddedwebview";

export class WebWshClient extends WshClient {
    blockId: string;
    model: WebViewModel;

    constructor(blockId: string, model: WebViewModel) {
        super(makeFeBlockRouteId(blockId));
        this.blockId = blockId;
        this.model = model;
    }

    async handle_webexecutejs(
        _rh: RpcResponseHelper,
        data: CommandWebExecuteJSData
    ): Promise<CommandWebExecuteJSRtnData> {
        const webview = this.model.webviewRef.current as EmbeddedWebview | null;
        if (!webview) {
            return { error: "no webview attached to block" };
        }
        const timeout = data.timeoutms && data.timeoutms > 0 ? data.timeoutms : 10000;
        try {
            const value = await withTimeout(
                webview.executeJavaScript(data.script, true),
                timeout,
                "webexecutejs timed out"
            );
            const url = safeUrl(webview);
            const title = safeTitle(webview);
            return {
                resultjson: JSON.stringify(value ?? null),
                url,
                title,
            };
        } catch (err: any) {
            return {
                error: String(err?.message ?? err),
                url: safeUrl(webview),
                title: safeTitle(webview),
            };
        }
    }

    async handle_webcapture(
        _rh: RpcResponseHelper,
        _data: CommandWebCaptureData
    ): Promise<CommandWebCaptureRtnData> {
        const webview = this.model.webviewRef.current as EmbeddedWebview | null;
        if (!webview) {
            throw new Error("no webview attached to block");
        }
        const image = await webview.capturePage();
        const png = image.toPNG();
        // Avoid btoa — not UTF-8 safe and binary anyway. Build base64 manually
        // via the standard chunked pattern.
        const b64 = bytesToBase64(png);
        return {
            pngbase64: b64,
            url: safeUrl(webview),
            title: safeTitle(webview),
        };
    }
}

function safeUrl(webview: EmbeddedWebview): string {
    try {
        return webview.getURL();
    } catch {
        return "";
    }
}

function safeTitle(webview: EmbeddedWebview): string {
    try {
        return webview.getTitle();
    } catch {
        return "";
    }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(msg)), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            }
        );
    });
}

function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let bin = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
        bin += String.fromCharCode.apply(
            null,
            Array.from(bytes.subarray(i, i + chunkSize))
        );
    }
    return globalThis.btoa(bin);
}
