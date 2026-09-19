# winget manifests

Community manifests for `winget install CroweLogic.Hypheus`.

Release procedure, after the GitHub release for a tag is published with the
Windows NSIS installers attached:

1. Run `scripts/winget-update.sh <version>` to stamp the version, release
   date, and installer SHA256 values into a new manifest directory.
2. Validate on a Windows host: `winget validate --manifest manifests/c/CroweLogic/Hypheus/<version>`
3. Open a PR against https://github.com/microsoft/winget-pkgs copying the
   directory to `manifests/c/CroweLogic/Hypheus/<version>`.

The first submission also needs the Windows build enabled in
`.github/workflows/build-helper.yml` so the NSIS installers exist on the
release. The URL and hash fields are placeholders until then.
