# Hypheus model authentication

Hypheus is derived from Wave Terminal. Its CroweLM modes use a remote model edge; they do not require a local model server. Model access requires a credential supplied by the user. Builds must not embed a shared model credential or require one in CI.

## Configure your credential

1. Obtain a credential authorized for the model service you intend to use through that service's approved process. This document does not establish a credential-issuance or sign-in service.
2. Open **Settings > Secrets > Add New Secret** in Hypheus.
3. For the shipped remote CroweLM modes, name the secret `CROWE_MODELS_KEY` and save your own model-edge credential as its value. The existing `wsh secret ui` command also opens the secret-management UI.
4. Check that the selected AI mode points to the service you trust before sending a request.

Do not put credentials in shell command arguments, source files, build flags, screenshots or support logs. If secure secret storage is unavailable, resolve that platform issue rather than treating a storage error as permission to bypass it.

## Resolution order

For each AI mode:

1. An explicit configured `ai:apitoken` takes precedence, with its existing exact-value semantics. Prefer the Secrets UI over plaintext token configuration.
2. If `ai:apitokensecretname` is configured, a nonempty stored secret is used after trimming surrounding whitespace.
3. Only for the `CROWE_MODELS_KEY` secret name, an absent or blank stored secret may fall back to the runtime `HYPHEUS_MODELS_KEY` environment variable, also trimmed. This is a user-supplied runtime fallback, not a compiled credential. Launchers must pass it securely to the application process; this document intentionally includes no key-bearing shell command.
4. If neither source supplies that credential, the request fails with setup guidance. Secret-store errors fail closed instead of using the environment fallback. Other secret names retain their missing-secret errors and do not use the CroweLM fallback.

A mode with neither an explicit token nor a secret name retains support for unauthenticated custom/local endpoints. This does not make an authenticated service accessible without a credential.

Endpoint policy is unchanged by this source patch. The runtime fallback is selected by secret name, not destination origin. Only assign the CroweLM secret name to trusted endpoints; a configurable endpoint can receive the resolved credential. A broader origin allowlist needs a separately specified compatibility policy.

## Build and verification boundary

The Taskfile no longer injects `wavebase.CroweModelsKey`, and packaging no longer requires a model key or a keyless bypass switch. The build workflow no longer maps a model secret into package steps. Version/build-time metadata, signing and manifest verification remain separate from model authentication.

Offline regression tests cover source contracts and synthetic authentication decisions. They do not validate a real credential, an installed application, platform secret storage, service access or a packaged backend.

## Previously distributed artifacts remain uncleared

Source removal does **not** revoke a credential, remove it from an existing binary, or clear previously distributed artifacts. The retained backend security finding remains unresolved. Do not treat this patch as release or native rehearsal clearance.

A separately authorized secure assessment must:

- Identify affected artifacts and service dependencies without exposing credential values in reports.
- Establish credential ownership, scope and service impact through approved secret-handling procedures.
- Obtain authorization for revocation/replacement and coordinate dependent services.
- Produce and verify replacement artifacts through authorized release tooling, including confirmation that shared authentication material is no longer embedded.

No credential validation, revocation, replacement, backend build, release or publication is performed by this source-only task.
