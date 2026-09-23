#!/usr/bin/env bash

set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
unset npm_config_cache npm_config_prefix npm_execpath npm_node_execpath

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Skills are no longer bundled into the installer; a source data directory is
# only forwarded for compatibility and may be omitted.
source_data_dir=${1:-${HBCLIENT_BUNDLED_DATA_DIR:-}}

build_dir=$(mktemp -d /tmp/hbclient-linux-build.XXXXXX)
case "$build_dir" in
  /tmp/hbclient-linux-build.*) ;;
  *)
    echo "Unexpected temporary build directory: $build_dir" >&2
    exit 1
    ;;
esac

cleanup() {
  rm -rf -- "$build_dir"
}
trap cleanup EXIT

tar \
  --exclude=.git \
  --exclude=.beads \
  --exclude=node_modules \
  --exclude=apps/desktop/release \
  --exclude=apps/desktop/dist \
  --exclude=apps/desktop/build/default-data \
  --exclude=packages/shared/dist \
  --exclude=packages/runtime/dist \
  -C "$repo_root" \
  -cf - . | tar -C "$build_dir" -xf -

cd "$build_dir"
npm_cli=(npx --yes npm@10.9.4)
export npm_config_cache="$build_dir/.npm-cache"
"${npm_cli[@]}" ci --no-audit --no-fund
if [[ -n "$source_data_dir" ]]; then
  HBCLIENT_BUNDLED_DATA_DIR="$source_data_dir" "${npm_cli[@]}" run dist:linux
else
  "${npm_cli[@]}" run dist:linux
fi
"${npm_cli[@]}" run verify:linux-release

release_target="$repo_root/apps/desktop/release"
mkdir -p "$release_target"
cp -f apps/desktop/release/HyWork-*-linux-*.AppImage "$release_target"/
cp -f apps/desktop/release/latest-linux.yml "$release_target"/
