// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export type DesignSeverity = "polish" | "usability" | "blocker";
export type DesignStatus = "open" | "resolved";

export interface DesignAnnotation {
    id: string;
    target: string;
    severity: DesignSeverity;
    note: string;
    status: DesignStatus;
    createdAt: number;
    updatedAt: number;
}

const StorageKey = "crowe.dock.designreview.v1";

function loadAnnotations(): DesignAnnotation[] {
    try {
        const raw = localStorage.getItem(StorageKey);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export class DesignReviewModel {
    private static instance: DesignReviewModel | null = null;
    annotationsAtom: jotai.PrimitiveAtom<DesignAnnotation[]>;
    openCountAtom!: jotai.Atom<number>;

    private constructor() {
        this.annotationsAtom = jotai.atom(loadAnnotations()) as jotai.PrimitiveAtom<DesignAnnotation[]>;
        this.openCountAtom = jotai.atom((get) => get(this.annotationsAtom).filter((a) => a.status === "open").length);
    }

    static getInstance(): DesignReviewModel {
        if (!DesignReviewModel.instance) {
            DesignReviewModel.instance = new DesignReviewModel();
        }
        return DesignReviewModel.instance;
    }

    persist(list: DesignAnnotation[]) {
        try {
            localStorage.setItem(StorageKey, JSON.stringify(list));
        } catch {
            // non-critical local state; ignore write failures
        }
    }

    add(target: string, severity: DesignSeverity, note: string) {
        const now = Date.now();
        const ann: DesignAnnotation = {
            id: crypto.randomUUID(),
            target: target.trim() || "(unspecified)",
            severity,
            note: note.trim(),
            status: "open",
            createdAt: now,
            updatedAt: now,
        };
        const list = [ann, ...globalStore.get(this.annotationsAtom)];
        globalStore.set(this.annotationsAtom, list);
        this.persist(list);
    }

    setStatus(id: string, status: DesignStatus) {
        const list = globalStore
            .get(this.annotationsAtom)
            .map((a) => (a.id === id ? { ...a, status, updatedAt: Date.now() } : a));
        globalStore.set(this.annotationsAtom, list);
        this.persist(list);
    }

    remove(id: string) {
        const list = globalStore.get(this.annotationsAtom).filter((a) => a.id !== id);
        globalStore.set(this.annotationsAtom, list);
        this.persist(list);
    }
}
