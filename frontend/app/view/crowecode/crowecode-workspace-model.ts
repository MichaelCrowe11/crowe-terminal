// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    RegisteredFileSystemProvider,
    registerFileSystemOverlay,
} from "@codingame/monaco-vscode-files-service-override";
import * as jotai from "jotai";
import * as monaco from "monaco-editor";

import { loadMonaco } from "@/app/monaco/monaco-env";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcBackedFile } from "./crowecode-fsprovider";

// CroweCodeWorkspaceModel is the shared brain across every crowecode block
// and (in later phases) the explorer, search, scm, problems, and debug
// panels. It owns:
//   - the current workspace folder atom (the "root" all panels operate on)
//   - the VS Code-compatible filesystem provider that routes reads/writes
//     through wshrpc instead of the renderer's OS filesystem
//   - lazy registration of file URIs as crowecode blocks open them
//
// The provider is registered at priority 1, which sits above the lib's
// default in-memory provider (priority 0) so opened files are visible to
// the languages/search/markers services.
export class CroweCodeWorkspaceModel {
    private static instance: CroweCodeWorkspaceModel | null = null;

    workspaceFolderAtom: jotai.PrimitiveAtom<string | undefined>;

    private fsProvider: RegisteredFileSystemProvider | null = null;
    private fsProviderOverlayDisposable: { dispose(): void } | null = null;
    private registeredFiles: Map<string, { uri: monaco.Uri; dispose(): void }> = new Map();
    private ensurePromise: Promise<void> | null = null;

    private constructor() {
        this.workspaceFolderAtom = jotai.atom<string | undefined>(undefined);
    }

    static getInstance(): CroweCodeWorkspaceModel {
        if (!CroweCodeWorkspaceModel.instance) {
            CroweCodeWorkspaceModel.instance = new CroweCodeWorkspaceModel();
        }
        return CroweCodeWorkspaceModel.instance;
    }

    private async ensureProvider(): Promise<void> {
        if (this.fsProvider) return;
        if (this.ensurePromise) return this.ensurePromise;
        this.ensurePromise = (async () => {
            await loadMonaco();
            const provider = new RegisteredFileSystemProvider(false);
            this.fsProviderOverlayDisposable = registerFileSystemOverlay(1, provider);
            this.fsProvider = provider;
        })();
        return this.ensurePromise;
    }

    // ensureFileRegistered makes `filePath` discoverable to VS Code services
    // by registering an RpcBackedFile for the corresponding file:// URI.
    // Returns the URI for the caller to use when creating Monaco models or
    // model references. Idempotent: re-registering the same path is a no-op.
    async ensureFileRegistered(filePath: string): Promise<monaco.Uri> {
        await this.ensureProvider();
        const uri = monaco.Uri.file(filePath);
        const key = uri.toString();
        const existing = this.registeredFiles.get(key);
        if (existing) return existing.uri;
        const file = new RpcBackedFile(uri, filePath);
        const dispose = this.fsProvider!.registerFile(file);
        this.registeredFiles.set(key, { uri, dispose: () => dispose.dispose() });
        return uri;
    }

    releaseFile(filePath: string): void {
        const uri = monaco.Uri.file(filePath);
        const key = uri.toString();
        const entry = this.registeredFiles.get(key);
        if (!entry) return;
        entry.dispose();
        this.registeredFiles.delete(key);
    }

    setWorkspaceFolder(folder: string | undefined): void {
        globalStore.set(this.workspaceFolderAtom, folder);
    }

    getWorkspaceFolder(): string | undefined {
        return globalStore.get(this.workspaceFolderAtom);
    }
}
