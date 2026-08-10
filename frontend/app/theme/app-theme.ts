// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type AppTheme = "dark" | "light";

const ThemeStorageKey = "hypheus.theme.v1";
const DefaultTheme: AppTheme = "dark";

function isAppTheme(value: unknown): value is AppTheme {
    return value === "dark" || value === "light";
}

export function getAppTheme(): AppTheme {
    const appliedTheme = document.documentElement.dataset.theme;
    if (isAppTheme(appliedTheme)) {
        return appliedTheme;
    }
    try {
        const storedTheme = localStorage.getItem(ThemeStorageKey);
        return isAppTheme(storedTheme) ? storedTheme : DefaultTheme;
    } catch {
        return DefaultTheme;
    }
}

export function applyAppTheme(theme: AppTheme, persist = true): void {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (!persist) {
        return;
    }
    try {
        localStorage.setItem(ThemeStorageKey, theme);
    } catch {
        // Theme persistence is non-critical in restricted preview contexts.
    }
}

export function initializeAppTheme(): void {
    applyAppTheme(getAppTheme(), false);
}
