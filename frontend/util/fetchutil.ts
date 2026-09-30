// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getWebServerEndpoint } from "./endpoints";

// Utility to abstract the fetch function so the Electron net module can be used when available.

// Structurally typed rather than Electron.Net so this module needs no Electron
// types. The dynamic import below is deliberate and stays: it only resolves in the
// main process, where Chromium's network stack is preferable to global fetch.
type HostNet = {
    fetch(url: string, init?: RequestInit): Promise<Response>;
};

let net: HostNet;
let hostBackendHeaders: Record<string, string> = {};

// Main process only: headers attached to requests for the local web backend.
export function setHostBackendHeaders(headers: Record<string, string>) {
    hostBackendHeaders = { ...headers };
}

function withHostBackendHeaders(url: string, init?: RequestInit): RequestInit {
    try {
        if (new URL(url).origin !== new URL(getWebServerEndpoint()).origin) {
            return init;
        }
    } catch {
        return init;
    }
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(hostBackendHeaders)) {
        headers.set(name, value);
    }
    return { ...init, headers };
}

if (typeof window === "undefined") {
    try {
        import("electron").then(({ net: electronNet }) => (net = electronNet));
    } catch (e) {
        // do nothing
    }
}

export function fetch(input: string | GlobalRequest | URL, init?: RequestInit): Promise<Response> {
    if (net) {
        const url = input.toString();
        return net.fetch(url, withHostBackendHeaders(url, init));
    } else {
        return globalThis.fetch(input, init);
    }
}
