#!/usr/bin/env bash
# Builds the release binaries from the built workspace (run `pnpm -r build`
# first): dist/release/chimera-<os>-<arch> for linux-amd64, linux-arm64 and
# darwin-arm64, each a `bun build --compile` single file, plus SHA256SUMS.
#
# Usage: scripts/build-release.sh <version> [out-dir]
#   version   the release version stamped into the binaries, e.g. v1.2.3
#   out-dir   where the binaries go (default: dist/release)
# CHIMERA_RELEASE_TARGETS limits the targets for a local check, e.g.
# CHIMERA_RELEASE_TARGETS=linux-amd64; SHA256SUMS then lists only those.
#
# Bun is pinned by .bun-version; the release workflow installs that version.
# The darwin binary is re-signed ad hoc with rcodesign when it is on the PATH.
set -euo pipefail

version="${1:-}"
if [[ -z "$version" ]]; then
  echo "usage: scripts/build-release.sh <version> [out-dir]" >&2
  exit 2
fi
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${2:-$root/dist/release}"
pinned="$(cat "$root/.bun-version")"
actual="$(bun --version)"
if [[ "$actual" != "$pinned" ]]; then
  echo "warning: bun $actual is not the pinned $pinned (.bun-version)" >&2
fi

entry="$root/packages/cli/dist/bin.js"
grammar="$root/packages/permissions/dist/tree-sitter-bash.wasm"
runtime="$(node -e "console.log(require.resolve('web-tree-sitter/web-tree-sitter.wasm', { paths: ['$root/packages/permissions'] }))")"
for file in "$entry" "$grammar" "$runtime"; do
  if [[ ! -f "$file" ]]; then
    echo "missing $file: run pnpm -r build first" >&2
    exit 1
  fi
done

mkdir -p "$out"
all_targets=(linux-amd64:bun-linux-x64 linux-arm64:bun-linux-arm64 darwin-arm64:bun-darwin-arm64)
targets=()
for target in "${all_targets[@]}"; do
  if [[ -z "${CHIMERA_RELEASE_TARGETS:-}" || " ${CHIMERA_RELEASE_TARGETS//,/ } " == *" ${target%%:*} "* ]]; then
    targets+=("$target")
  fi
done
names=()
for target in "${targets[@]}"; do
  names+=("chimera-${target%%:*}")
  name="chimera-${target%%:*}"
  echo "building $name ($version)"
  # The two tree-sitter WebAssembly files are embedded beside the bundle, where
  # the permissions module and web-tree-sitter look for them.
  bun build --compile \
    --target="${target#*:}" \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --define "process.env.NODE_ENV=\"production\"" \
    --define "__CHIMERA_VERSION__=\"$version\"" \
    --asset-naming='[name].[ext]' \
    --outfile "$out/$name" \
    "$entry" "$grammar" "$runtime"
done

if [[ " ${names[*]} " == *" chimera-darwin-arm64 "* ]]; then
  if command -v rcodesign >/dev/null 2>&1; then
    echo "signing chimera-darwin-arm64 ad hoc"
    rcodesign sign "$out/chimera-darwin-arm64"
  else
    echo "warning: rcodesign not found; chimera-darwin-arm64 is not re-signed" >&2
  fi
fi

(
  cd "$out"
  sha256sum "${names[@]}" >SHA256SUMS
)
echo "wrote $out/SHA256SUMS"
