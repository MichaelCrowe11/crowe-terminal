// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { WshRouter } from "@/app/store/wshrouter";
import { setDefaultRouter } from "@/app/store/wshrpcutil-base";
import { makeMockWaveEnv } from "@/preview/mock/mockwaveenv";
import { WOS } from "@/store/global";
import { atom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpUiViewModel } from "./mcpui-model";

function makeModel(session: string) {
    setDefaultRouter(new WshRouter({ recvRpcMessage: () => {} }));
    const blockId = "mcpui-test-block";
    const env = makeMockWaveEnv({});
    WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
    WOS.setObjectValue({
        otype: "block",
        oid: blockId,
        version: 1,
        meta: {
            "mcpui:session": session,
            "mcpui:html": "<html></html>",
        },
    } as Block);
    return new McpUiViewModel({
        blockId,
        nodeModel: { isFocused: atom(true), focusNode: () => {} } as any,
        tabModel: {} as any,
        waveEnv: env,
    });
}

describe("mcpui sendAction", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("sends params as a JSON-text string the server decodes back to raw JSON", () => {
        const spy = vi.spyOn(RpcApi, "McpUiActionCommand").mockResolvedValue(undefined);
        const model = makeModel("sess-123");

        model.sendAction({ type: "tool", toolname: "doThing", params: JSON.stringify({ a: 1 }) });

        expect(spy).toHaveBeenCalledTimes(1);
        const data = spy.mock.calls[0][1];
        expect(data.blockid).toBe("mcpui-test-block");
        expect(data.session).toBe("sess-123");
        expect(data.type).toBe("tool");
        expect(data.toolname).toBe("doThing");
        expect(data.params).toBe(JSON.stringify({ a: 1 }));
    });
});
