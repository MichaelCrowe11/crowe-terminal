# Hypheus model authentication

Hypheus is derived from Wave Terminal. Its default Crowe account mode uses account sign-in, without a manually configured API key or local model server. Advanced API-key and local modes remain separate. Builds must not embed a shared model credential or require one in CI.

## Connect your Crowe account

1. Open the account control in the Hypheus panel and choose **Connect account**.
2. Sign in to Crowe ID in your system browser and enter the code displayed in Hypheus.
3. Return to Hypheus and wait for **Connected**. Choose **Crowe account** in the engine menu if an advanced mode was previously selected.
4. Submit a prompt explicitly. Connection alone does not send a prompt, read workspace files, or authorize tools.

The backend uses the `crowe-cli` public client with device authorization and PKCE at `https://id.crowelogic.com/realms/crowe`. Access tokens stay in backend memory. Refresh credentials are stored in a private, profile-scoped operating-system credential-store entry, separate from Settings > Secrets and environment bindings. The renderer receives only connection state and the temporary user-facing approval code. Account RPCs and account-funded chat require a separate, ephemeral frontend capability that Electron injects only for registered app main frames. Ordinary webviews do not receive it, and the backend removes its startup environment value before launching child processes.

Account requests use only `https://api.crowelogic.com/api/gateway/chat`. The authenticated model list selects the default included in the account's plan. This mode rejects endpoint changes, proxies, and separately configured API keys. It never falls back to an API-key mode after disconnect. Each model request, including tool follow-ups, counts toward the plan limit; authentication failures are not automatically replayed.

**Cancel** stops a pending sign-in. **Disconnect account** clears the local session and attempts durable removal of its refresh credential. Session cancellation cannot undo a request already accepted by the service. Operating-system credential calls may wait for a keychain prompt; local request cancellation does not guarantee that durable cleanup has finished. If credential cleanup fails, the interface warns that disconnection may not survive restart and offers another removal attempt. Resolve operating-system keychain or credential-service failures rather than bypassing secure storage.

## Configure an advanced API-key mode

1. Obtain a credential authorized for the model service you intend to use through that service's approved process. This document does not establish a credential-issuance or sign-in service.
2. Open **Settings > Secrets > Add New Secret** in Hypheus.
3. For the shipped remote CroweLM modes, name the secret `CROWE_MODELS_KEY` and save your own model-edge credential as its value. The existing `wsh secret ui` command also opens the secret-management UI.
4. Check that the selected AI mode points to the service you trust before sending a request.

Do not put credentials in shell command arguments, source files, build flags, screenshots or support logs. If secure secret storage is unavailable, resolve that platform issue rather than treating a storage error as permission to bypass it.

## Resolution order

For advanced API-key modes only (not Crowe account mode):

1. An explicit configured `ai:apitoken` takes precedence, with its existing exact-value semantics. Prefer the Secrets UI over plaintext token configuration.
2. If `ai:apitokensecretname` is configured, a nonempty stored secret is used after trimming surrounding whitespace.
3. Only for the `CROWE_MODELS_KEY` secret name, an absent or blank stored secret may fall back to the runtime `HYPHEUS_MODELS_KEY` environment variable, also trimmed. This is a user-supplied runtime fallback, not a compiled credential. Launchers must pass it securely to the application process; this document intentionally includes no key-bearing shell command.
4. If neither source supplies that credential, the request fails with setup guidance. Secret-store errors fail closed instead of using the environment fallback. Other secret names retain their missing-secret errors and do not use the CroweLM fallback.

A mode with neither an explicit token nor a secret name retains support for unauthenticated custom/local endpoints. This does not make an authenticated service accessible without a credential.

Advanced API-key endpoint policy is unchanged. The runtime fallback is selected by secret name, not destination origin. Only assign the CroweLM secret name to trusted endpoints; a configurable endpoint can receive the resolved credential. A broader origin allowlist needs a separately specified compatibility policy.

## Build and verification boundary

The Taskfile no longer injects `wavebase.CroweModelsKey`, and packaging no longer requires a model key or a keyless bypass switch. The build workflow no longer maps a model secret into package steps. Version/build-time metadata, signing and manifest verification remain separate from model authentication.

Offline regression tests cover source contracts, synthetic authentication decisions, session races, private credential-store failure paths, local-frontend RPC provenance, gateway responses, and draft-preserving account UI. An isolated Electron smoke test with a synthetic loopback backend also checks main-frame access and embedded-frame denial. These checks do not validate a real credential, an installed Hypheus application, platform secret storage, service access or a packaged backend.

The account implementation is not release-verified. A current application artifact must complete browser approval, authenticated model selection, an explicitly submitted response, restart, and disconnect before release. The available local backend binaries predate the account RPCs. Project instructions prohibit `go build`, and the documented development tasks invoke it; running the old binary is not a substitute for this verification.

## Previously distributed artifacts remain uncleared

Source removal does **not** revoke a credential, remove it from an existing binary, or clear previously distributed artifacts. The retained backend security finding remains unresolved. Do not treat this patch as release or native rehearsal clearance.

A separately authorized secure assessment must:

- Identify affected artifacts and service dependencies without exposing credential values in reports.
- Establish credential ownership, scope and service impact through approved secret-handling procedures.
- Obtain authorization for revocation/replacement and coordinate dependent services.
- Produce and verify replacement artifacts through authorized release tooling, including confirmation that shared authentication material is no longer embedded.

No credential validation, revocation, replacement, backend build, release or publication is performed by this source-only task.
