// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { RegisteredFile } from "@codingame/monaco-vscode-files-service-override";
import type * as MonacoTypes from "monaco-editor";

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, stringToBase64 } from "@/util/util";

// RpcBackedFile is a RegisteredFile whose read/write/size operations are
// routed through Hypheus's wshrpc file commands. This is how VS Code
// services (language servers, search, diagnostics) discover and operate on
// files that live on disk via the Go backend's scope-checked file I/O.
//
// We don't add any extra capabilities here: the file is writable, content is
// base64-bridged through wshrpc, and size is fetched lazily via FileInfo.
export class RpcBackedFile extends RegisteredFile {
    private filePath: string;
    private cachedSize: number | undefined;

    constructor(uri: MonacoTypes.Uri, filePath: string) {
        super(uri as any, false);
        this.filePath = filePath;
    }

    async getSize(): Promise<number> {
        if (this.cachedSize != null) return this.cachedSize;
        try {
            const info = await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: this.filePath } });
            this.cachedSize = info?.size ?? 0;
            return this.cachedSize;
        } catch {
            return 0;
        }
    }

    async read(): Promise<Uint8Array> {
        const file = await RpcApi.FileReadCommand(TabRpcClient, { info: { path: this.filePath } }, null);
        if (!file?.data64) return new Uint8Array();
        const str = base64ToString(file.data64);
        const bytes = new TextEncoder().encode(str);
        this.cachedSize = bytes.byteLength;
        return bytes;
    }

    async write(content: Uint8Array): Promise<void> {
        const str = new TextDecoder().decode(content);
        await RpcApi.FileWriteCommand(
            TabRpcClient,
            { info: { path: this.filePath }, data64: stringToBase64(str) },
            null,
        );
        this.cachedSize = content.byteLength;
    }
}
