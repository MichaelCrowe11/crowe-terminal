// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Utility to abstract the fetch function so the Electron net module can be used when available.

// Structurally typed rather than Electron.Net so this module needs no Electron
// types. The dynamic import below is deliberate and stays: it only resolves in the
// main process, where Chromium's network stack is preferable to global fetch.
type HostNet = {
    fetch(url: string, init?: RequestInit): Promise<Response>;
};

let net: HostNet;

if (typeof window === "undefined") {
    try {
        import("electron").then(({ net: electronNet }) => (net = electronNet));
    } catch (e) {
        // do nothing
    }
}

export function fetch(input: string | GlobalRequest | URL, init?: RequestInit): Promise<Response> {
    if (net) {
        return net.fetch(input.toString(), init);
    } else {
        return globalThis.fetch(input, init);
    }
}
