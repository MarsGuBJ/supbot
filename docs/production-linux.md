# HBClient Linux Production Checklist

The supported self-updating Linux distribution is the x64 AppImage. A Debian
package can be produced for managed environments, but it must be upgraded by
the package manager or by installing a newer `.deb`.

## Initial Build

Build on Linux x64 with Node.js 22 or newer. Point `HBCLIENT_BUNDLED_DATA_DIR`
at the HBClient data directory whose installed skills should be included, then
run:

```bash
npm ci
npm run verify:release:linux
```

From Windows, keep the Windows `node_modules` directory untouched by building
in an isolated WSL directory:

```powershell
npm run dist:linux:wsl -- /mnt/c/Users/<user>/AppData/Roaming/HBClient/data
```

On a Linux desktop, launch-smoke the packaged application before publishing:

```bash
npm run verify:linux-appimage
```

Set `HBCLIENT_APPIMAGE_EXTRACT_AND_RUN=1` only in environments such as WSL that
do not provide FUSE.

The release directory must contain a matching set:

- `HBClient-{version}-linux-x86_64.AppImage`
- `latest-linux.yml`

The AppImage contains the block map used by `electron-updater` for differential
downloads. Do not modify or recompress the AppImage after `latest-linux.yml` is
generated.

## Installation

Keep the AppImage in a user-owned, writable directory so the updater can replace
it. A typical installation is:

```bash
mkdir -p "$HOME/Applications"
cp -f HBClient-0.1.5-linux-x86_64.AppImage "$HOME/Applications/"
chmod +x "$HOME/Applications/HBClient-0.1.5-linux-x86_64.AppImage"
"$HOME/Applications/HBClient-0.1.5-linux-x86_64.AppImage"
```

Do not install the self-updating AppImage under `/usr`, `/opt`, or another
root-owned directory. The application data directory is separate from the
AppImage and remains in Electron's `userData` location across upgrades.

## Incremental Releases

For every later release:

1. Increase the SemVer version in the root and desktop `package.json` files.
2. Build the AppImage and run `npm run verify:linux-release` without editing the
   generated files.
3. Publish `latest-linux.yml` and the AppImage from the same build to the stable
   `linux-x64` update channel.
4. Verify an older AppImage detects, downloads, and installs the release while
   preserving the user data directory.

The Botstation update endpoint is
`/api/v1/hbclient/updates/stable/linux-x64`. It must serve
`latest-linux.yml` and the referenced AppImage over HTTPS, preserve the
authenticated request headers, and support byte ranges (`Accept-Ranges`,
`Range`, `206 Partial Content`). Single-range responses are required because
the client disables multiple-range requests.

`HBCLIENT_UPDATE_FEED_URL` overrides the channel root for controlled testing.
Production clients reject non-HTTPS update feeds. Linux in-app updating is
enabled only when HBClient is running from an AppImage; `.deb` installations do
not show the managed update flow.
