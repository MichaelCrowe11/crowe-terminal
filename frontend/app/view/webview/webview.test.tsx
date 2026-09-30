// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { WshRouter } from "@/app/store/wshrouter";
import { setDefaultRouter } from "@/app/store/wshrpcutil-base";
import { makeMockWaveEnv } from "@/preview/mock/mockwaveenv";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
    getWebPreviewDisplayUrl,
    getWebViewLoadError,
    WebViewLoadError,
    WebViewModel,
    WebViewPreviewFallback,
} from "./webview";

const FailedUrl = "https://user:password@missing.example/account?token=private#session";

function makeLoadFailure(overrides = {}) {
    return {
        errorCode: -105,
        errorDescription: "ERR_NAME_NOT_RESOLVED",
        validatedURL: FailedUrl,
        isMainFrame: true,
        ...overrides,
    };
}

function getButtons(tree: any): any[] {
    if (!tree || typeof tree !== "object") {
        return [];
    }
    const children = [tree.props?.children].flat(Infinity).flatMap(getButtons);
    return tree.type === "button" ? [tree, ...children] : children;
}

describe("webview load recovery", () => {
    it("explains DNS failure without changing the requested URL", () => {
        const error = getWebViewLoadError(makeLoadFailure());
        const markup = renderToStaticMarkup(
            <WebViewLoadError error={error} model={{} as WebViewModel} hideNavigation={false} />
        );

        expect(error.url).toBe(FailedUrl);
        expect(markup).toContain("Site address not found");
        expect(markup).toContain("(DNS)");
        expect(markup).toContain("https://missing.example/account");
        expect(markup).toContain("Retry");
        expect(markup).toContain("Edit address");
        for (const sensitive of ["password", "user:", "token", "private", "session"]) {
            expect(markup).not.toContain(sensitive);
        }
    });

    it("keeps non-DNS errors actionable with their diagnostic", () => {
        const error = getWebViewLoadError(
            makeLoadFailure({ errorCode: -106, errorDescription: "ERR_INTERNET_DISCONNECTED" })
        );
        const markup = renderToStaticMarkup(
            <WebViewLoadError error={error} model={{} as WebViewModel} hideNavigation={false} />
        );

        expect(error.isDnsError).toBe(false);
        expect(markup).toContain("ERR_INTERNET_DISCONNECTED");
        expect(markup).toContain("Retry");
    });

    it("ignores aborted loads and subframe failures", () => {
        expect(getWebViewLoadError(makeLoadFailure({ errorCode: -3 }))).toBeNull();
        expect(getWebViewLoadError(makeLoadFailure({ isMainFrame: false }))).toBeNull();
        const event = makeLoadFailure();
        delete event.isMainFrame;
        expect(getWebViewLoadError(event)?.isDnsError).toBe(true);
    });

    it("routes recovery buttons through the model and preserves the exact URL", () => {
        const model = { handleRefresh: vi.fn(), focusAddress: vi.fn() } as unknown as WebViewModel;
        const tree = WebViewLoadError({ error: getWebViewLoadError(makeLoadFailure()), model, hideNavigation: false });
        const buttons = getButtons(tree);
        const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

        buttons.find((button) => button.props.children === "Retry").props.onClick(click);
        buttons.find((button) => button.props.children === "Edit address").props.onClick();

        expect(model.handleRefresh).toHaveBeenCalledWith(click, FailedUrl);
        expect(model.focusAddress).toHaveBeenCalledOnce();
    });

    it("gives hidden-navigation guidance instead of an inactive edit button", () => {
        const props = {
            error: getWebViewLoadError(makeLoadFailure()),
            model: {} as WebViewModel,
            hideNavigation: true,
        };
        const markup = renderToStaticMarkup(<WebViewLoadError {...props} />);
        expect(getButtons(WebViewLoadError(props)).map((button) => button.props.children)).toEqual(["Retry"]);
        expect(markup).toContain("Un-Hide Navigation");
    });

    it.each(["", "https://previous.example", FailedUrl])(
        "retries exactly even if the current page is %s",
        async (currentUrl) => {
            const webview = {
                getURL: vi.fn(() => currentUrl),
                loadURL: vi.fn().mockRejectedValue(new Error("simulated navigation rejection")),
                reload: vi.fn(),
                stop: vi.fn(),
            };
            const model = {
                webviewRef: { current: webview },
                isLoading: atom(true),
                url: atom(FailedUrl),
            } as unknown as WebViewModel;
            const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as any;
            const log = vi.spyOn(console, "log").mockImplementation(() => {});
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            try {
                WebViewModel.prototype.handleRefresh.call(model, click, FailedUrl);
                await Promise.resolve();
                expect(webview.loadURL).toHaveBeenCalledWith(FailedUrl);
                expect(webview.reload).not.toHaveBeenCalled();
                expect(webview.stop).not.toHaveBeenCalled();
                expect(globalStore.get(model.url)).toBe(FailedUrl);
                expect(log).not.toHaveBeenCalled();
                expect(warn).not.toHaveBeenCalled();
            } finally {
                log.mockRestore();
                warn.mockRestore();
            }
        }
    );

    it("preserves the toolbar stop/reload behavior", () => {
        const webview = { reload: vi.fn(), stop: vi.fn() };
        const model = { webviewRef: { current: webview }, isLoading: atom(true) } as unknown as WebViewModel;
        const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as any;
        WebViewModel.prototype.handleRefresh.call(model, click);
        expect(webview.stop).toHaveBeenCalledOnce();
        globalStore.set(model.isLoading, false);
        WebViewModel.prototype.handleRefresh.call(model, click);
        expect(webview.reload).toHaveBeenCalledOnce();
    });

    it("focuses and selects the existing address input without modifying its value", () => {
        const input = { focus: vi.fn(), select: vi.fn(), value: FailedUrl };
        const model = { urlInputRef: { current: input } } as unknown as WebViewModel;
        WebViewModel.prototype.focusAddress.call(model);
        expect(input.focus).toHaveBeenCalledOnce();
        expect(input.select).toHaveBeenCalledOnce();
        expect(input.value).toBe(FailedUrl);
    });

    it("redacts credentials, query, and fragment and avoids exposing opaque or malformed URLs", () => {
        expect(getWebPreviewDisplayUrl(FailedUrl)).toBe("https://missing.example/account");
        expect(getWebPreviewDisplayUrl("https://user:password@")).toBe("Invalid address");
        expect(getWebPreviewDisplayUrl("data:text/plain,private")).toBe("data:");
        expect(getWebPreviewDisplayUrl("file:///private/path")).toBe("file:");
    });
});

describe("webview preview fallback", () => {
    it("shows the requested URL", () => {
        const markup = renderToStaticMarkup(<WebViewPreviewFallback url="https://docs.crowelogic.com/terminal" />);

        expect(markup).toContain("electron webview unavailable");
        expect(markup).toContain("https://docs.crowelogic.com/terminal");
    });

    it("falls back to about:blank when no URL is available", () => {
        expect(getWebPreviewDisplayUrl("")).toBe("about:blank");
        expect(getWebPreviewDisplayUrl(null)).toBe("about:blank");
    });

    it("uses the supplied env for homepage atoms and config updates", async () => {
        setDefaultRouter(new WshRouter({ recvRpcMessage: () => {} }));

        const blockId = "webview-env-block";
        const env = makeMockWaveEnv({
            settings: {
                "web:defaulturl": "https://default.example",
            },
            mockWaveObjs: {
                [`block:${blockId}`]: {
                    otype: "block",
                    oid: blockId,
                    version: 1,
                    meta: {
                        pinnedurl: "https://block.example",
                    },
                } as Block,
            },
        });
        const model = new WebViewModel({
            blockId,
            nodeModel: {
                isFocused: atom(true),
                focusNode: () => {},
            } as any,
            tabModel: {} as any,
            waveEnv: env,
        });

        expect(globalStore.get(model.homepageUrl)).toBe("https://block.example");

        await model.setHomepageUrl("https://global.example", "global");

        expect(globalStore.get(model.homepageUrl)).toBe("https://global.example");
        expect(globalStore.get(env.getSettingsKeyAtom("web:defaulturl"))).toBe("https://global.example");
        expect(globalStore.get(env.wos.getWaveObjectAtom<Block>(`block:${blockId}`))?.meta?.pinnedurl).toBeUndefined();
    });
});
