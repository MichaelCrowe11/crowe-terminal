# Publishing Crowe Logic apps via Apple

Single source of truth for what only Michael can do in Apple's dashboards
to unlock signed + notarized macOS distribution. The same Apple Developer
identity covers both **Crowe Terminal** (this repo) and **Crowe Cortex**
(`~/Projects/crowe-cortex`).

## What we're publishing

**Channel:** Developer ID notarized DMG, direct download from
`crowelogic.com`. Not the Mac App Store (App Store review adds 1-2 weeks
and a sandbox compliance pass that's premature for v0.x).

**Result:** customers get a `.dmg` that opens cleanly on any modern macOS,
no Gatekeeper warnings, no "this app is from an unidentified developer."

## Time estimate

| Step                              | Minutes |
| --------------------------------- | ------- |
| Apple Developer Program enrollment | ~5 to submit, **24-48h for approval** |
| Developer ID cert generation       | 10 |
| App-specific password              | 2 |
| Team ID lookup                     | 2 |
| Encode cert for CI                 | 5 |
| Paste secrets into GitHub          | 10 |
| Tag + push first signed build      | 5 |
| **Total active time**              | **~40 minutes** spread over 1-2 days |

## Step 1. Enroll in Apple Developer Program

Skip if already enrolled. To check: visit
<https://developer.apple.com/account>. If you see a "Membership" panel with
a Team ID, you're in.

If not:

1. Go to <https://developer.apple.com/programs/enroll/>
2. Enroll as **Crowe Logic, Inc.** (the business entity, not personal).
   You'll need the EIN.
3. $99/year. Pay via Apple ID linked to a payment method.
4. Apple reviews; takes **24-48 hours**.
5. Watch for the approval email.

You cannot proceed past this step without enrollment.

## Step 2. Generate the Developer ID Application certificate

Once enrolled:

1. Open Keychain Access on this Mac (Cmd+Space, search "Keychain Access").
2. **Menu: Keychain Access > Certificate Assistant > Request a Certificate
   from a Certificate Authority...**
   - User email: `michael@crowelogic.com`
   - Common name: `Michael Crowe`
   - CA email: leave blank
   - Request is: **Saved to disk**
   - Click Continue, save the `.certSigningRequest` file to your Desktop.
3. Go to <https://developer.apple.com/account/resources/certificates/add>
4. Pick **Developer ID Application** (NOT "Mac Development", NOT "Mac App
   Distribution"). Click Continue.
5. Upload the `.certSigningRequest` file. Click Continue.
6. Download the resulting `developerID_application.cer` file.
7. Double-click it. It installs into the login keychain.
8. Verify in Terminal:
   ```bash
   security find-identity -v -p codesigning
   ```
   You should now see **1 valid identity found** with a name like
   `Developer ID Application: Crowe Logic, Inc. (TEAMID)`.

## Step 3. Generate an app-specific password for notarization

1. Sign in at <https://appleid.apple.com/account/manage>
2. Under **Sign-In and Security**, click **App-Specific Passwords**.
3. Click **+** to generate a new one. Label it `Crowe Terminal Notarization`.
4. Apple shows the password **once**. Copy it immediately. Format is
   `xxxx-xxxx-xxxx-xxxx`.

## Step 4. Find your Apple Team ID

1. Go to <https://developer.apple.com/account>
2. Scroll to the **Membership** panel.
3. The 10-character alphanumeric **Team ID** is shown. Copy it.

## Step 5. Export the cert for CI (base64-encoded .p12)

GitHub Actions needs the cert as a single base64-encoded string.

1. Open Keychain Access > **My Certificates**.
2. Right-click your `Developer ID Application: ...` cert > **Export**.
3. Save as `crowe-developer-id.p12`. Set a strong password (you'll need
   this twice: as the export password AND as the GitHub secret value).
4. From Terminal:
   ```bash
   cd ~/Desktop
   base64 -i crowe-developer-id.p12 -o crowe-developer-id.p12.base64
   pbcopy < crowe-developer-id.p12.base64
   ```
   The base64 string is now on your clipboard.

## Step 6. Paste 5 secrets into GitHub

Repo: <https://github.com/MichaelCrowe11/crowe-terminal/settings/secrets/actions>

Click **New repository secret** for each:

| Secret name                              | Value                                                      |
| ---------------------------------------- | ---------------------------------------------------------- |
| `PROD_MACOS_CERTIFICATE_2`               | Base64 from Step 5 (paste from clipboard)                  |
| `PROD_MACOS_CERTIFICATE_PWD_2`           | The .p12 password from Step 5                              |
| `PROD_MACOS_NOTARIZATION_APPLE_ID_2`     | `michael@crowelogic.com` (or the Apple ID used in Step 1)  |
| `PROD_MACOS_NOTARIZATION_PWD_2`          | App-specific password from Step 3                          |
| `PROD_MACOS_NOTARIZATION_TEAM_ID_2`      | Team ID from Step 4                                        |

These names are exactly what `.github/workflows/build-helper.yml` already
expects. Don't rename them.

## Step 7. Ship the first signed build

Once secrets are in place:

```bash
cd ~/Projects/crowe-terminal
git tag v0.14.7
git push origin v0.14.7
```

That tag push triggers `build-helper.yml`. The workflow will:

1. Build for darwin (arm64), darwin (x64), linux, windows in parallel.
2. Sign the macOS bundle with your cert.
3. Submit to Apple notarization and wait for the ticket.
4. Staple the notarization ticket to the DMG.
5. Upload signed artifacts to the staging S3 bucket.

Check progress at <https://github.com/MichaelCrowe11/crowe-terminal/actions>.

When the workflow finishes, **manually publish a GitHub Release** pointing
at that tag. That release-publish event triggers `publish-release.yml`,
which copies the signed DMGs from staging to the public release bucket.

After that, the DMG URLs are stable and can be wired into
`crowelogic-website/app/download/page.tsx` (replacing the 6 platform
placeholder anchors that still link to `#`).

## Cortex shares this identity

`~/Projects/crowe-cortex` uses the **same** Developer ID cert. After
Step 2 above, Cortex's local build script can sign:

```bash
cd ~/Projects/crowe-cortex
APPLE_SIGNING_IDENTITY="Developer ID Application: Crowe Logic, Inc. (TEAMID)" \
APPLE_ID="michael@crowelogic.com" \
APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
APPLE_TEAM_ID="TEAMID" \
./scripts/build-release.sh
```

Cortex also has a `release.yml` workflow if you'd rather push a
`cortex-v0.3.1` tag and let CI handle it. Same 5 GitHub secrets, just
paste them into the **crowe-cortex** repo's secrets page too.

## What can go wrong

- **Notarization rejected for entitlements:** check
  `build/entitlements.mac.plist`. We allow JIT and unsigned executable
  memory (required for Electron's V8) and a few CLI-permission entries
  matching iTerm's set. Don't add `com.apple.security.app-sandbox` for
  Developer ID — that's for App Store only.
- **"errSecInternalComponent" during signing:** the cert isn't in the
  login keychain on the runner. CI handles this automatically via
  `CSC_LINK`; locally, re-import the `.cer` or `.p12`.
- **Notarization stuck > 30 min:** Apple's notary service occasionally
  queues. Check status:
  ```bash
  xcrun notarytool history --apple-id "..." --team-id "..." --password "..."
  ```
- **DMG opens but app crashes immediately:** missing entitlement.
  `console.app` will show the killed-by-codesign reason. Add the missing
  key to `build/entitlements.mac.plist` and re-tag.
