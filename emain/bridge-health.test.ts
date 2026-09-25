// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { createServer, RequestListener, Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { probeBridgeHealth } from "./bridge-health";

const Servers: Server[] = [];
async function serve(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    Servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address == null) throw new Error("Missing server address");
    return `http://127.0.0.1:${address.port}/healthz`;
}

afterEach(async () => {
    await Promise.all(
        Servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                })
        )
    );
});

describe("bridge health deadline", () => {
    it("accepts a healthy service", async () => {
        expect(await probeBridgeHealth(await serve((_req, res) => res.end("ok")), 500)).toBe(true);
    });
    it("retries while the service starts", async () => {
        let requests = 0;
        const url = await serve((_req, res) => {
            res.statusCode = ++requests === 1 ? 503 : 200;
            res.end();
        });
        expect(await probeBridgeHealth(url, 1500)).toBe(true);
        expect(requests).toBe(2);
    });
    it("bounds requests that never return headers", async () => {
        const url = await serve(() => {});
        const started = performance.now();
        expect(await probeBridgeHealth(url, 100)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1000);
    });
    it("does not accept redirects as readiness", async () => {
        const url = await serve((_req, res) => {
            res.writeHead(302, { Location: "/other" });
            res.end();
        });
        expect(await probeBridgeHealth(url, 100)).toBe(false);
    });
    it("rejects persistent unhealthy responses", async () => {
        const url = await serve((_req, res) => {
            res.statusCode = 503;
            res.end();
        });
        expect(await probeBridgeHealth(url, 100)).toBe(false);
    });
    it("rejects invalid budgets", async () => {
        for (const budget of [0, -1, NaN, Infinity]) {
            expect(await probeBridgeHealth("http://127.0.0.1", budget)).toBe(false);
        }
    });
});
