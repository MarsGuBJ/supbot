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

Linux npm package:

```powershell
npm run pack:linux
```

The desktop package exposes the `supbot` bin after global npm installation.

## Local tool commands

- `/read <path>` reads a local UTF-8 file into the conversation.
- `/write <name-or-path>` followed by a newline and content creates a generated file.
- `/shell <command>` runs a local shell command with a 60-second timeout.

`npm run smoke:electron` starts Electron through DevTools and asserts that the
renderer mounted real Supbot UI content. It catches `file://` asset path
regressions that otherwise show up as an empty window.

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
