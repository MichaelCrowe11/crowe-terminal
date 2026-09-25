// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

export async function probeBridgeHealth(url: string, timeoutMs = 8000): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(remaining),
                redirect: "error",
            });
            // Health probes only inspect headers; do not retain an unread streaming body.
            void response.body?.cancel().catch(() => {});
            if (response.ok && performance.now() <= deadline) return true;
        } catch {
            // A service may not be listening yet during startup.
        }
        const delay = Math.min(250, deadline - performance.now());
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return false;
}
