// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getBlockMetaKeyAtom, globalStore, WOS } from "@/store/global";
import * as jotai from "jotai";
import { McpUiView } from "./mcpui";

type McpUiActionInput = {
    type: string;
    toolname?: string;
    params?: string;
    prompt?: string;
    url?: string;
    intent?: string;
    message?: string;
    messageid?: string;
};

export class McpUiViewModel implements ViewModel {
    blockId: string;
    nodeModel: BlockNodeModel;
    tabModel: TabModel;
    viewType = "mcpui";
    blockAtom: jotai.Atom<Block>;
    htmlAtom: jotai.Atom<string>;
    sessionAtom: jotai.Atom<string>;
    viewIcon: jotai.Atom<string>;
    viewName: jotai.Atom<string>;
    noPadding: jotai.Atom<boolean>;
    noHeader: jotai.Atom<boolean>;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.htmlAtom = getBlockMetaKeyAtom(blockId, "mcpui:html");
        this.sessionAtom = getBlockMetaKeyAtom(blockId, "mcpui:session");
        this.viewIcon = jotai.atom("window-maximize");
        this.viewName = jotai.atom("MCP UI");
        this.noPadding = jotai.atom(true);
        this.noHeader = jotai.atom(true);
    }

    get viewComponent(): ViewComponent {
        return McpUiView;
    }

    sendAction(data: McpUiActionInput) {
        const session = globalStore.get(this.sessionAtom);
        RpcApi.McpUiActionCommand(TabRpcClient, {
            blockid: this.blockId,
            session,
            ...data,
        });
    }
}
