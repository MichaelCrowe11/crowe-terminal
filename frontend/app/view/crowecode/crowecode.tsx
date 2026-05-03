// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { ViewComponentProps } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import { CodeEditor } from "@/app/view/codeeditor/codeeditor";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { CroweCodeViewModel } from "./crowecode-model";
import "./crowecode.scss";

export const CroweCodeView: React.FC<ViewComponentProps<CroweCodeViewModel>> = ({ blockId, model, contentRef }) => {
    const text = useAtomValue(model.textAtom);
    const language = useAtomValue(model.languageAtom);
    const fileName = useAtomValue(model.fileNameAtom);
    const isLoading = useAtomValue(model.isLoadingAtom);

    useEffect(() => {
        if (fileName) {
            fireAndForget(model.loadFromDisk.bind(model));
        }
    }, [fileName, model]);

    const handleChange = (next: string) => {
        globalStore.set(model.textAtom, next);
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
            />
        </div>
    );
};

CroweCodeView.displayName = "CroweCodeView";
