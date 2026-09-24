// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/aipanel/waveai-model", () => ({ WaveAIModel: {} }));
vi.mock("@/app/store/global", () => ({ atoms: {} }));
vi.mock("@/app/store/wos", () => ({}));
vi.mock("@/util/util", () => ({ cn: (...values: string[]) => values.filter(Boolean).join(" ") }));
vi.mock("./designreview-model", () => ({ DesignReviewModel: {} }));
vi.mock("./telemetry-model", () => ({ TelemetryModel: {} }));
vi.mock("./vcs-model", () => ({ VcsModel: {} }));

import { activityLabel, endpointDisplay } from "./dockpanels";

describe("Configured endpoint display", () => {
    it.each(["http://127.0.0.1:8011/v1", "http://localhost:4000/path", "http://[::1]:4000/path"])("labels only the local hop for %s", (value) => {
        expect(endpointDisplay(value).location).toBe("Loopback endpoint");
    });

    it("keeps remote endpoints remote and strips non-origin data", () => {
        expect(endpointDisplay("https://example.test/private?sample=value#fragment")).toEqual({
            origin: "https://example.test", location: "Remote endpoint",
        });
        expect(endpointDisplay("https://sample-user:sample-pass@example.test/path").origin).toBe("https://example.test");
    });

    it.each(["broken example", "file:///example", "javascript:void(0)"])("does not echo invalid values: %s", (value) => {
        expect(endpointDisplay(value)).toEqual({ origin: "Invalid endpoint", location: "Unknown endpoint" });
    });

    it("does not invent an endpoint", () => {
        expect(endpointDisplay(null).origin).toBe("Not specified");
    });
});

describe("Observed activity", () => {
    it("does not invent cognition while waiting", () => {
        expect(activityLabel("running", "idle", "")).toBe("Waiting for response");
    });
    it("uses recorded events and outcomes", () => {
        expect(activityLabel("running", "tool", "read-file")).toBe("Tool event: read-file");
        expect(activityLabel("running", "responding", "stale-tool")).toBe("Receiving response");
        expect(activityLabel("running", "reasoning", "")).toBe("Receiving reasoning output");
        expect(activityLabel("error", "idle", "")).toBe("Run ended with an error");
        expect(activityLabel("done", "idle", "")).toBe("Run complete");
        expect(activityLabel("idle", "idle", "")).toBe("No active run");
    });
});
