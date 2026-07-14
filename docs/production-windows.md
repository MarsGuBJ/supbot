# Supbot Windows Production Checklist

Supbot's first production target is a local, single-user Windows desktop app. It is not a multi-user service, and Remote Bridge is not supported for public exposure.

## Release Build

Run the release gate from a clean working tree:

```powershell
npm install
npm run verify:release
```

`verify:release` runs the npm security audit against the official registry, builds and tests the workspace, runs the Electron smoke checks, and creates the Windows NSIS installer.

Before publishing a build:

- Confirm `npm audit --registry=https://registry.npmjs.org` reports no unreviewed production-blocking advisories.
- Confirm the Electron smoke output has no Electron security warning.
- Install the generated NSIS package on a clean Windows user profile and verify first launch.
- Upgrade over the previous installer and verify the existing user data directory still loads.
- Record the generated installer name, app version, commit, and audit result in release notes.

## Remote Updates

HBClient checks the authenticated Botstation stable update feed after connecting and every 30 minutes. It never downloads or installs an update without user action.

Publish a release from Botstation Admin Console:

1. Build and sign the Windows x64 NSIS installer.
2. Confirm the file name is `HBClient-{version}-win-x64.exe` and the embedded application version uses the same SemVer value.
3. Open **客户端版本**, upload the EXE, confirm the version, and publish it.
4. Verify an installed older HBClient displays the upgrade prompt, downloads the package, and offers **重启并安装**.

Botstation stores installers in its existing artifact-repo MinIO bucket and generates `latest.yml` from the published release. The feed and installer require the user's Botstation access token. `HBCLIENT_UPDATE_FEED_URL` overrides the feed root for controlled testing; `HBCLIENT_ENABLE_DEV_UPDATES=1` enables updater wiring in an unpackaged development build.

## Data And Credentials

Runtime data lives under Electron's `userData` directory unless `SUPBOT_USER_DATA_DIR` is set for development or testing. The app stores conversations, transcripts, memory, generated files, worktree metadata, schedules, MCP config, and Remote Bridge audit records under `data/`.

Model API keys and tool-market credentials use Electron `safeStorage` when the operating system makes encryption available. If Supbot reports `file` storage for a credential, treat that fallback as local obfuscation, not strong encryption. Do not publish logs, transcripts, or state files from a real user profile.

Memory backups are written under `data/memory-backups`. Restore tests should cover both the latest-backup path and an explicit backup path.

## Security Boundaries

Renderer code runs with `contextIsolation`, `sandbox`, `webSecurity`, and `nodeIntegration: false`. Production builds reject `SUPBOT_DEV_SERVER_URL`, block external navigation/window creation, and deny renderer permission requests.

IPC handlers validate arguments in the main process. `file:open` only opens paths Supbot created, imported, tracks as a worktree, or stores under the app data directory.

Dangerous tools (`WriteFile`, `Shell`, `Agent`, and MCP tools) must pass through permission policy. Slash commands follow the same rule: `/read` is direct, while `/write` and `/shell` require approval unless an explicit rule allows them.

Remote Bridge defaults to disabled and binds only to localhost. It uses bearer-token authentication, request-body limits, JSON validation, read-only prompts, and a bounded audit log. Do not bind it to a LAN or public interface for the Windows local desktop release.

## Operations

Backup before upgrade:

1. Close Supbot.
2. Copy the full app data directory.
3. Install the new version.
4. Launch Supbot and verify conversations, memory, schedules, MCP settings, and model settings.

Rollback:

1. Close Supbot.
2. Uninstall the new version without deleting app data.
3. Reinstall the previous installer.
4. Restore the copied app data directory only if the previous app cannot read the current state.

Troubleshooting:

- Blank window: run `npm run smoke:electron` on the release commit and check renderer asset paths.
- Model calls fail: verify Base URL, model name, API key saved state, and network access.
- Tools do not run: check permission mode, pending permissions, and explicit allow/deny rules.
- Remote Bridge does not start: verify it is enabled, bound to localhost, and the selected port is free.
