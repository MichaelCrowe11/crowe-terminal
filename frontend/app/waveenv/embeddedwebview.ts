// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Structural type for the embedded browser element, declared here rather than
// imported as Electron's WebviewTag so that nothing under frontend/ depends on
// the "electron" module. The frontend reaches the host platform only through
// WaveEnv; a type-only import still couples the build to Electron and blocks
// running this tree under any other shell. Base is HTMLWebViewElement because
// that is what React's `webview` intrinsic element types its ref as.
// Only members actually called by the webview views are listed. Add on demand.

export type FindInPageOpts = {
    findNext?: boolean;
    forward?: boolean;
};

export type CapturedPage = {
    toPNG(): Uint8Array;
};

export type EmbeddedWebview = HTMLWebViewElement & {
    loadURL(url: string): Promise<void>;
    getURL(): string;
    getTitle(): string;
    reload(): void;
    stop(): void;
    goBack(): void;
    goForward(): void;
    canGoBack(): boolean;
    canGoForward(): boolean;
    clearHistory(): void;
    getWebContentsId(): number;
    getZoomFactor(): number;
    setZoomFactor(factor: number): void;
    isAudioMuted(): boolean;
    setAudioMuted(muted: boolean): void;
    openDevTools(): void;
    closeDevTools(): void;
    isDevToolsOpened(): boolean;
    findInPage(text: string, options?: FindInPageOpts): number;
    stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
    setUserAgent(userAgent: string): void;
    capturePage(): Promise<CapturedPage>;
    executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
};
