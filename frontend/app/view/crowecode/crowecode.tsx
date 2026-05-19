// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { ViewComponentProps } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { useEffect } from "react";
import { CroweCodeViewModel } from "./crowecode-model";
import { CroweCodeWorkspaceModel } from "./crowecode-workspace-model";
import "./crowecode.scss";

export const CroweCodeView: React.FC<ViewComponentProps<CroweCodeViewModel>> = ({ blockId, model, contentRef }) => {
    const text = useAtomValue(model.textAtom);
    const language = useAtomValue(model.languageAtom);
    const fileName = useAtomValue(model.fileNameAtom);
    const isLoading = useAtomValue(model.isLoadingAtom);

    useEffect(() => {
        fireAndForget(model.bootstrapScope.bind(model));
    }, [model]);

    useEffect(() => {
        if (fileName) {
            fireAndForget(model.loadFromDisk.bind(model));
        }
    }, [fileName, model]);

    const handleChange = (next: string) => {
        globalStore.set(model.textAtom, next);
    };

    // Wire focus + cursor tracking to the workspace model so the AI panel and
    // (Phase 5+) the agent tool registry can answer "what is the user looking
    // at?" without the user copy-pasting. Only fires when a fileName is set —
    // scratch buffers don't pollute the active-editor state.
    const handleEditorMount = (
        editor: MonacoTypes.editor.IStandaloneCodeEditor
    ): (() => void) => {
        const workspaceModel = CroweCodeWorkspaceModel.getInstance();

        const pushState = () => {
            const currentFile = globalStore.get(model.fileNameAtom);
            if (!currentFile) return;
            const lang = globalStore.get(model.languageAtom);
            const pos = editor.getPosition();
            const sel = editor.getSelection();
            workspaceModel.setActiveEditor({
                blockId,
                filePath: currentFile,
                languageId: lang,
                cursorLine: pos?.lineNumber ?? 1,
                cursorColumn: pos?.column ?? 1,
                selectionStartLine: sel?.startLineNumber ?? pos?.lineNumber ?? 1,
                selectionStartColumn: sel?.startColumn ?? pos?.column ?? 1,
                selectionEndLine: sel?.endLineNumber ?? pos?.lineNumber ?? 1,
                selectionEndColumn: sel?.endColumn ?? pos?.column ?? 1,
                hasSelection: sel != null && !sel.isEmpty(),
            });
        };

        const subs: MonacoTypes.IDisposable[] = [
            editor.onDidFocusEditorWidget(pushState),
            editor.onDidChangeCursorPosition(pushState),
            editor.onDidChangeCursorSelection(pushState),
        ];

        if (editor.hasTextFocus()) {
            pushState();
        }

        return () => {
            for (const s of subs) s.dispose();
            workspaceModel.clearActiveEditorIfMatches(blockId);
        };
    };

    return (
        <div className="crowecode-container" ref={contentRef}>
            {isLoading && fileName ? (
                <div className="crowecode-loading">loading {fileName}...</div>
            ) : null}
            <CodeEditor
                blockId={blockId}
                text={text}
                readonly={false}
                language={language}
                fileName={fileName}
                onChange={handleChange}
                onMount={handleEditorMount}
            />
        </div>
    );
};

CroweCodeView.displayName = "CroweCodeView";
