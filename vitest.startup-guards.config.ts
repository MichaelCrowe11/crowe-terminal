// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
    root: fileURLToPath(new URL(".", import.meta.url)),
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./frontend", import.meta.url)),
        },
    },
    test: {
        environment: "node",
        include: ["emain/emain-foundry-bridge.test.ts", "frontend/app/dock/telemetry-model.test.ts"],
        reporters: ["verbose"],
        pool: "threads",
        maxWorkers: 1,
        minWorkers: 1,
        fileParallelism: false,
        cache: false,
        coverage: { enabled: false },
    },
});
