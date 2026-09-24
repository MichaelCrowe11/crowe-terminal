// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const YAML = require("yaml");

const Root = path.resolve(__dirname, "..");
const TaskSource = fs.readFileSync(path.join(Root, "Taskfile.yml"), "utf8");
const WorkflowSource = fs.readFileSync(path.join(Root, ".github/workflows/build-helper.yml"), "utf8");

function parse(source) {
    const document = YAML.parseDocument(source, { uniqueKeys: true });
    assert.equal(document.errors.length, 0, "YAML must parse without duplicate keys or errors");
    return document.toJS();
}

function assertNoBuildCredential(source) {
    assert.doesNotMatch(source, /CroweModelsKey|CROWE_MODELS_KEY|HYPHEUS_MODELS_KEY|HYPHEUS_ALLOW_KEYLESS|check:models-key/i,
        "model credentials must not enter build configuration");
}

function taskNames(task) {
    return task.cmds.filter((cmd) => typeof cmd === "object" && cmd.task).map((cmd) => cmd.task);
}

function stepNamed(steps, name) {
    const matches = steps.filter((step) => step.name === name);
    assert.equal(matches.length, 1, `expected exactly one step: ${name}`);
    return matches[0];
}

test("Taskfile and workflow contain no shared model credential mechanism", () => {
    parse(TaskSource);
    parse(WorkflowSource);
    assertNoBuildCredential(TaskSource);
    assertNoBuildCredential(WorkflowSource);
});

test("guard rejects synthetic reintroduced linker, environment and package requirements", () => {
    for (const fragment of [
        '-ldflags "-X example/pkg/wavebase.CroweModelsKey=SYNTHETIC_ONLY"',
        "CROWE_MODELS_KEY: ${{ secrets.CROWE_MODELS_KEY }}",
        "HYPHEUS_MODELS_KEY: SYNTHETIC_ONLY",
        "HYPHEUS_ALLOW_KEYLESS=1",
        "- task: check:models-key",
    ]) {
        assert.throws(() => assertNoBuildCredential(`${TaskSource}\n# ${fragment}`), /model credentials/);
    }
    assert.throws(() => parse("tasks: {}\ntasks: {}\n"), /YAML must parse/);
});

test("backend metadata and architecture handling remain intact", () => {
    const tasks = parse(TaskSource).tasks;
    const server = tasks["build:server:internal"];
    assert.match(server.cmd.cmd, /-X main\.BuildTime=/);
    assert.match(server.cmd.cmd, /-X main\.WaveVersion=\{\{\.VERSION\}\}/);
    assert.match(server.cmd.cmd, /CGO_ENABLED=1 GOARCH=\{\{\.GOARCH\}\}/);
    assert.match(server.cmd.cmd, /dist\/bin\/wavesrv\./);
    assert.deepEqual(server.cmd.for, { var: "ARCHS", split: ",", as: "GOARCH" });
    assert.deepEqual(taskNames(tasks["build:server"]), ["build:server:linux", "build:server:macos", "build:server:windows"]);
    assert.match(tasks["build:wsh:internal"].cmd, /-X main\.WaveVersion=/);
});

test("package ordering and Store and Linux targets survive credential removal", () => {
    const tasks = parse(TaskSource).tasks;
    for (const name of ["package", "package:store"]) {
        assert.deepEqual(taskNames(tasks[name]), ["clean", "npm:install", "build:backend", "build:tsunamiscaffold"]);
        assert.match(tasks[name].cmds.at(-1), /-p never/);
    }
    assert.match(tasks["package:store"].cmds.at(-1), /--win appx/);
    assert.equal(tasks["package:store"].env.HYPHEUS_STORE_BUILD, "1");
    assert.deepEqual(taskNames(tasks["package:linux"]), ["build:server:linux:cross"]);
    assert.match(tasks["package:linux"].cmds.at(-1), /--linux AppImage --x64 -p never/);
});

test("CI preserves platform package paths and release gates", () => {
    const jobs = parse(WorkflowSource).jobs;
    assert.equal(jobs["build-app"].needs, "validate-approval");
    const steps = jobs["build-app"].steps;
    assert.equal(stepNamed(steps, "Build (Linux)").run, "task package");
    assert.match(stepNamed(steps, "Build (Darwin)").with.command, /task package && bash scripts\/notarize-dmg\.sh make/);
    assert.equal(stepNamed(steps, "Build (Windows)").run, "task package");
    assert.match(stepNamed(jobs["build-store"].steps, "Build MSIX").run, /task package:store/);
    assert.match(stepNamed(jobs["build-store"].steps, "Windows App Certification Kit").run, /overall -ne "PASS"/);
    assert.equal(jobs["create-release"].needs, "build-app");
    assert.match(jobs["create-release"].if, /github\.event_name != 'workflow_dispatch'/);
    assert.equal(stepNamed(jobs["create-release"].steps, "Create draft release").with.draft, true);
    assert.match(stepNamed(steps, "Upload to S3 staging").if, /ENABLE_S3_STAGING == 'true'/);
});

test("CI keeps signing and strict final manifest verification before upload", () => {
    const jobs = parse(WorkflowSource).jobs;
    const steps = jobs["build-app"].steps;
    const signing = stepNamed(steps, "Verify macOS signing + notarization");
    const manifests = stepNamed(steps, "Regenerate and verify final macOS manifests");
    const upload = stepNamed(steps, "Upload artifacts");
    assert.match(signing.run, /verify-mac-release\.sh make/);
    assert.match(manifests.run, /gen-latest-mac-yml\.sh/);
    assert.match(manifests.run, /verify-mac-manifests\.cjs make "\$VERSION" --strict/);
    assert.ok(steps.indexOf(signing) < steps.indexOf(manifests));
    assert.ok(steps.indexOf(manifests) < steps.indexOf(stepNamed(steps, "Upload to S3 staging")));
    assert.ok(steps.indexOf(manifests) < steps.indexOf(upload));
    assert.equal(stepNamed(jobs["validate-approval"].steps, "Test macOS manifest integrity").run,
        "node --test scripts/mac-manifests.check.cjs");
});

test("onboarding requires explicit account connection instead of shared authentication", () => {
    for (const file of ["onboarding-upgrade-v0157.tsx", "onboarding-upgrade-minor.tsx"]) {
        const source = fs.readFileSync(path.join(Root, "frontend/app/onboarding", file), "utf8").replace(/\s+/g, " ");
        assert.doesNotMatch(source, /no keys|work as installed|no setup/i);
        assert.doesNotMatch(source, /Add New Secret|CROWE_MODELS_KEY/);
        assert.match(source, /Connect account/);
        assert.match(source, /Sign in to Crowe ID/);
        assert.match(source, /browser/);
        assert.match(source, /displayed code/);
        assert.match(source, /Connecting does not read files or run commands/);
    }
});
