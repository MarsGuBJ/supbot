# Supbot

Supbot is a local, single-user desktop agent inspired by Supmate's agent client
workspace. It packages a React/Ant Design Electron UI with an in-process Node
agent runtime and file-backed local storage.

## Commands

```powershell
npm install
npm run build
npm run test
npm run smoke:electron
npm run verify:release
npm run dev
```

Windows installer:

```powershell
npm run dist:win
```

Linux x64 AppImage (supports in-app differential updates):

```powershell
npm run dist:linux
npm run verify:linux-release
```

An optional Debian package can be built with `npm run dist:linux:deb`, but the
`.deb` package is not self-updating. Use the AppImage for the managed update
channel.

## Local tool commands

- `/read <path>` reads a local UTF-8 file into the conversation.
- `/write <name-or-path>` followed by a newline and content creates a generated file.
- `/shell <command>` runs a local shell command with a 60-second timeout.

`npm run smoke:electron` starts Electron through DevTools and asserts that the
renderer mounted real Supbot UI content. It catches `file://` asset path
regressions that otherwise show up as an empty window.

## Continuous integration

GitHub Actions runs on every push and pull request using a Windows runner. The
CI gate installs with `npm ci`, then builds, typechecks, lints, checks formatting,
and runs the runtime and desktop Vitest suites. The Electron smoke test remains
a local release gate through `npm run verify` because it requires a reliably
display-capable environment.

## Working tree hygiene

This workspace is expected to stay source-focused after Git initialization: do
not commit generated build outputs or package archives. The generated `dist/`,
`release/`, cache, temporary, and `*.tgz` artifacts are ignored and can be
rebuilt from source.

Use `npm run verify` before staging or handing off changes. The initial Git
setup intentionally does not create a baseline commit, so a fresh `git status`
will show source files as untracked until you decide what to stage.

## Windows production release

The first production target is a local, single-user Windows desktop app. Use
`npm run verify:release` before publishing a Windows installer and follow
[docs/production-windows.md](docs/production-windows.md) for the release,
upgrade, rollback, data, and security checklist.

## Linux production release

Use `npm run verify:release:linux` on Linux x64 and follow
[docs/production-linux.md](docs/production-linux.md). The generated AppImage,
`latest-linux.yml`, and the AppImage's embedded block map form one release set;
publish them from the same build.
