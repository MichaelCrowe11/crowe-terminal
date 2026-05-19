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
// ActiveEditorState is the snapshot the AI agent (and any panel that cares)
// reads to answer "what is the user looking at?" — file, cursor, selection,
// and the block id so consumers can scroll/focus the editor if they want.
export type ActiveEditorState = {
    blockId: string;
    filePath: string;
    languageId?: string;
    cursorLine: number;
    cursorColumn: number;
    selectionStartLine: number;
    selectionStartColumn: number;
    selectionEndLine: number;
    selectionEndColumn: number;
    hasSelection: boolean;
};

export class CroweCodeWorkspaceModel {
    private static instance: CroweCodeWorkspaceModel | null = null;

    workspaceFolderAtom: jotai.PrimitiveAtom<string | undefined>;
    activeEditorAtom: jotai.PrimitiveAtom<ActiveEditorState | null>;

    private fsProvider: RegisteredFileSystemProvider | null = null;
    private fsProviderOverlayDisposable: { dispose(): void } | null = null;
    private registeredFiles: Map<string, { uri: monaco.Uri; dispose(): void }> = new Map();
    private ensurePromise: Promise<void> | null = null;

    // Debounce timer for backend report calls — cursor moves fire on every
    // keystroke; we only want to ship a snapshot to wavesrv at most every
    // ~150ms so the agent doesn't see stale-but-different state every frame.
    private reportTimer: ReturnType<typeof setTimeout> | null = null;
    private reportHandler: ((state: ActiveEditorState | null) => void) | null = null;

    private constructor() {
        this.workspaceFolderAtom = jotai.atom<string | undefined>(undefined);
        this.activeEditorAtom = jotai.atom<ActiveEditorState | null>(null) as jotai.PrimitiveAtom<ActiveEditorState | null>;
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

    // setActiveEditor is called by crowecode-model whenever a Crowe Code block
    // gains focus or its cursor moves. We update the atom synchronously (so UI
    // reflects immediately) and debounce the backend report so the agent's
    // view-of-truth converges within ~150ms.
    setActiveEditor(state: ActiveEditorState | null): void {
        globalStore.set(this.activeEditorAtom, state);
        if (this.reportTimer) clearTimeout(this.reportTimer);
        this.reportTimer = setTimeout(() => {
            this.reportTimer = null;
            this.reportHandler?.(state);
        }, 150);
    }

    // clearActiveEditor is called when a crowecode block loses focus or
    // unmounts. We only clear if the block id matches — switching focus
    // between blocks already overwrote the state, so we don't want a stale
    // unmount of the previously-focused block to null out the current one.
    clearActiveEditorIfMatches(blockId: string): void {
        const current = globalStore.get(this.activeEditorAtom);
        if (current?.blockId === blockId) {
            this.setActiveEditor(null);
        }
    }

    // setReportHandler lets the application bind a callback that ships
    // active-editor snapshots to the Go backend via wshrpc. Kept here as a
    // late-binding handler so the workspace model file doesn't need to know
    // about the RPC layer directly — the wsh wiring lives in wave.ts.
    setReportHandler(handler: ((state: ActiveEditorState | null) => void) | null): void {
        this.reportHandler = handler;
    }
}
