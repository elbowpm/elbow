#!/bin/sh
# Install the Elbow release this script was published with:
#   curl -fsSL https://elbow.paymahn.workers.dev/install.sh | sh
set -eu

fail() {
  echo "elbow install: $1" >&2
  exit 1
}

# Wrapped in main so a truncated download runs nothing.
main() {
  version="@VERSION@"
  case "$version" in @*) fail "download install.sh from a release, not from the repository" ;; esac
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "unsupported OS $(uname -s); Elbow supports macOS and Linux (including WSL)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported CPU $(uname -m); Elbow supports x64 and arm64" ;;
  esac

  name="elbow-${version}-${os}-${arch}"
  url="https://github.com/elbowpm/elbow/releases/download/v${version}/${name}.tar.gz"
  bin="$HOME/.local/bin"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/${name}.tar.gz" "$url"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$tmp/${name}.tar.gz.sha256" "${url}.sha256"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmp" && sha256sum -c "${name}.tar.gz.sha256" >/dev/null) || fail "checksum mismatch for ${name}.tar.gz"
  else
    (cd "$tmp" && shasum -a 256 -c "${name}.tar.gz.sha256" >/dev/null) || fail "checksum mismatch for ${name}.tar.gz"
  fi
  tar -xzf "$tmp/${name}.tar.gz" -C "$tmp"
  mkdir -p "$bin"
  mv "$tmp/${name}/bin/elbow" "$bin/elbow"

  echo "Installed elbow ${version} to $bin/elbow"
  command -v bend >/dev/null 2>&1 || echo "Elbow runs programs with Bend 2.0.25. Install it: https://bend-lang.com/install.sh"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) echo "Add $bin to PATH in your shell profile: export PATH=\"$bin:\$PATH\"" ;;
  esac
}

main "$@"
