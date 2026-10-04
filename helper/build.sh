#!/bin/zsh

set -euo pipefail

HELPER_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${HELPER_DIR}/dist"

# rustup honours rust-toolchain.toml; accept a rustup install from the
# official installer (~/.cargo/bin) or Homebrew's keg-only formula.
export PATH="${HOME}/.cargo/bin:/opt/homebrew/opt/rustup/bin:/usr/local/opt/rustup/bin:${PATH}"
if ! command -v cargo >/dev/null 2>&1; then
  echo "Missing cargo. Install rustup (https://rustup.rs or 'brew install rustup')." >&2
  exit 1
fi

# Keep build-machine paths out of the packaged binary.
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${HOME}=~ --remap-path-prefix=${HELPER_DIR}=."
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-12.0}"

cd "${HELPER_DIR}"
# Protocol, credential and sink tests run against the locked dependency set.
cargo test --locked --quiet

# Universal binary, matching the universal pinned ffmpeg (both slices are required).
TARGETS=(aarch64-apple-darwin x86_64-apple-darwin)
for target in "${TARGETS[@]}"; do
  cargo build --release --locked --target "${target}"
done

rm -rf "${DIST_DIR}"
mkdir -p "${DIST_DIR}"
lipo -create -output "${DIST_DIR}/spotify_helper" \
  "${HELPER_DIR}/target/aarch64-apple-darwin/release/spotify_helper" \
  "${HELPER_DIR}/target/x86_64-apple-darwin/release/spotify_helper"
chmod 0755 "${DIST_DIR}/spotify_helper"
codesign --force --sign - "${DIST_DIR}/spotify_helper" >/dev/null 2>&1

# License inventory for every crate linked into the helper.
cargo metadata --format-version 1 --locked --filter-platform "$(rustc -vV | sed -n "s/^host: //p")" \
  | node "${HELPER_DIR}/licenses.mjs" > "${DIST_DIR}/SPOTIFY-HELPER-LICENSES.txt"

# The pinned, self-contained LGPL ffmpeg (no Homebrew/PATH binary) that
# converts the helper's Ogg Vorbis output into the FLAC playback artifact.
node "${PUROS_PROVIDER_CLI:?Run through puros-provider build (or npm run build)}" ffmpeg "--install=${DIST_DIR}" >/dev/null
if ! "${DIST_DIR}/ffmpeg" -version >/dev/null 2>&1; then
  echo "Installed ffmpeg cannot start: ${DIST_DIR}/ffmpeg" >&2
  exit 1
fi
# Keep stdin open briefly: EOF means cancellation in the helper protocol.
if ! { echo '{"version":1,"requestId":"build-check"}'; sleep 1; } | "${DIST_DIR}/spotify_helper" describe | grep -q '"event":"completed"'; then
  echo "Built helper failed its describe self-check: ${DIST_DIR}/spotify_helper" >&2
  exit 1
fi
