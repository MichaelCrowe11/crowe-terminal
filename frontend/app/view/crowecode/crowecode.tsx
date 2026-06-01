// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type * as MonacoTypes from "monaco-editor";
import { useEffect, useMemo, useRef, useState } from "react";
import { CroweCodeViewModel } from "./crowecode-model";
import { CroweCodeWorkspaceModel } from "./crowecode-workspace-model";
import { describeReload, type ReloadOrigin } from "./reconcile";
import "./crowecode.scss";

export const CroweCodeView: React.FC<ViewComponentProps<CroweCodeViewModel>> = ({ blockId, model, contentRef }) => {
    const text = useAtomValue(model.textAtom);
    const language = useAtomValue(model.languageAtom);
    const fileName = useAtomValue(model.fileNameAtom);
    const isLoading = useAtomValue(model.isLoadingAtom);
    const reloadHighlight = useAtomValue(model.reloadHighlightAtom);

    const editorRef = useRef<MonacoTypes.editor.IStandaloneCodeEditor>(null);
    const monacoRef = useRef<typeof MonacoTypes>(null);

    // Honor the OS "reduce motion" setting: motion-sensitive users get a static
    // highlight instead of the fade animation. The gutter glyph carries the
    // signal either way, so the change is never communicated by color alone.
    const reduceMotion = useMemo(
        () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
        []
    );

    // Screen-reader announcement for a live reload. Routed through an aria-live
    // region below so non-sighted users learn that the file changed, who changed
    // it, and where — the same information the gold flash conveys visually.
    const [announcement, setAnnouncement] = useState("");

    useEffect(() => {
        fireAndForget(model.bootstrapScope.bind(model));
    }, [model]);

    // Flash the lines a live-reload just changed, so the user sees WHAT the
    // agent (or an external editor) touched, not merely that the buffer moved.
    // The decorations auto-clear after a beat; the token in the atom guarantees
    // this fires again even when the same lines change on a subsequent reload.
    useEffect(() => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco || !reloadHighlight?.lines?.length) {
            return;
        }
        const lineClassName = reduceMotion ? "crowecode-reload-line-static" : "crowecode-reload-line";
        const collection = editor.createDecorationsCollection(
            reloadHighlight.lines.map((line) => ({
                range: new monaco.Range(line, 1, line, 1),
                // glyph in the line-number gutter is the non-color-dependent signal
                options: { isWholeLine: true, className: lineClassName, linesDecorationsClassName: "crowecode-reload-glyph" },
            }))
        );
        setAnnouncement(describeReload(fileName, reloadHighlight.lines, reloadHighlight.origin as ReloadOrigin));
        const timer = setTimeout(() => collection.clear(), 2400);
        return () => {
            clearTimeout(timer);
            collection.clear();
        };
    }, [reloadHighlight, reduceMotion, fileName]);

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
        editor: MonacoTypes.editor.IStandaloneCodeEditor,
        monaco: typeof MonacoTypes
    ): (() => void) => {
        const workspaceModel = CroweCodeWorkspaceModel.getInstance();
        editorRef.current = editor;
        monacoRef.current = monaco;

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
            if (editorRef.current === editor) {
                editorRef.current = null;
                monacoRef.current = null;
            }
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
            <div className="sr-only" role="status" aria-live="polite">
                {announcement}
            </div>
        </div>
    );
};

CroweCodeView.displayName = "CroweCodeView";
