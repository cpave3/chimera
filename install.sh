#!/bin/sh
# Installs the newest release of Chimera to ~/.local/bin/chimera.
#
#   curl -fsSL https://raw.githubusercontent.com/cpave3/chimera/main/install.sh | sh
#
# The binary is checked against the release's SHA256SUMS before it is put
# in place. CHIMERA_INSTALL_DIR changes where it goes, and
# CHIMERA_INSTALL_BASE_URL where it is downloaded from.
set -eu

base_url="${CHIMERA_INSTALL_BASE_URL:-https://github.com/cpave3/chimera/releases/latest/download}"
install_dir="${CHIMERA_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  printf 'chimera install: %s\n' "$1" >&2
  exit 1
}

system="$(uname -s | tr '[:upper:]' '[:lower:]')"
machine="$(uname -m)"
case "$system $machine" in
  "linux x86_64" | "linux amd64") asset=chimera-linux-amd64 ;;
  "linux aarch64" | "linux arm64") asset=chimera-linux-arm64 ;;
  "darwin arm64" | "darwin aarch64") asset=chimera-darwin-arm64 ;;
  *) fail "$system $machine is not supported; releases are built for linux x86_64, linux aarch64, darwin arm64" ;;
esac

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is needed to download chimera"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is needed to check the download"
  fi
}

mkdir -p "$install_dir"
# Downloaded beside the target, not to /tmp (often a small tmpfs), and
# renamed into place, so a running chimera keeps its binary.
partial="$install_dir/.chimera.install-$$"
sums="$partial.SHA256SUMS"
trap 'rm -f "$partial" "$sums"' EXIT

download "$base_url/$asset" "$partial" || fail "could not download $base_url/$asset"
download "$base_url/SHA256SUMS" "$sums" || fail "could not download $base_url/SHA256SUMS"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$sums")"
[ -n "$expected" ] || fail "SHA256SUMS has no checksum for $asset"
actual="$(sha256 "$partial")"
[ "$actual" = "$expected" ] || fail "$asset does not match its checksum in SHA256SUMS; nothing was installed"

chmod 0755 "$partial"
mv -f "$partial" "$install_dir/chimera"

version="$("$install_dir/chimera" version --json 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')" || version=""
printf 'Installed chimera %s to %s\n' "${version:-(unknown version)}" "$install_dir/chimera"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    printf 'chimera install: %s is not on your PATH; add it in your shell profile:\n' "$install_dir" >&2
    printf "  export PATH=\"%s:\$PATH\"\n" "$install_dir" >&2
    ;;
esac
