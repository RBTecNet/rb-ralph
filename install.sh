#!/usr/bin/env bash
set -euo pipefail

resolve_real_path() {
  local source="$1" directory target
  while [ -L "$source" ]; do
    directory="$(cd -P "$(dirname "$source")" && pwd)"
    target="$(readlink "$source")"
    if [[ "$target" == /* ]]; then source="$target"; else source="$directory/$target"; fi
  done
  directory="$(cd -P "$(dirname "$source")" && pwd)"
  printf '%s/%s\n' "$directory" "$(basename "$source")"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

SCRIPT_PATH="$(resolve_real_path "${BASH_SOURCE[0]}")"
SOURCE_ROOT="$(dirname "$SCRIPT_PATH")"
VERSION_FILE="$SOURCE_ROOT/VERSION"
RB_RALPH_VERSION="unknown"
[ ! -r "$VERSION_FILE" ] || IFS= read -r RB_RALPH_VERSION < "$VERSION_FILE"
PREFIX="${RB_RALPH_INSTALL_PREFIX:-$HOME/.local}"
CORE_SOURCE=""
UNINSTALL=0
FORCE=0

usage() {
  cat <<'USAGE'
Usage:
  ./rb-ralph.sh --install [--prefix <path>] [--core-cli <path>] [--force]
  ./rb-ralph.sh --uninstall [--prefix <path>]
  ./install.sh [--prefix <path>] [--core-cli <path>] [--force]
  ./install.sh --uninstall [--prefix <path>]

The default prefix is $HOME/.local. No sudo is used by the installer.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --prefix)
      [ "$#" -ge 2 ] || die "--prefix requires a path"
      PREFIX="$2"
      shift 2
      ;;
    --core-cli)
      [ "$#" -ge 2 ] || die "--core-cli requires a path"
      CORE_SOURCE="$2"
      shift 2
      ;;
    --force) FORCE=1; shift ;;
    -V|--ver|--version) printf 'RB Ralph %s\n' "$RB_RALPH_VERSION"; exit 0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

PREFIX="${PREFIX/#\~/$HOME}"
case "$PREFIX" in
  ""|/) die "Refusing unsafe installation prefix: ${PREFIX:-<empty>}" ;;
esac
if [ "$UNINSTALL" -eq 1 ] && [ ! -d "$PREFIX" ]; then
  printf 'RB Ralph is not installed under %s\n' "$PREFIX"
  exit 0
fi
mkdir -p "$PREFIX"
PREFIX="$(cd "$PREFIX" && pwd -P)"
BIN_DIR="$PREFIX/bin"
INSTALL_HOME="$PREFIX/libexec/rb-ralph"
LAUNCHER="$BIN_DIR/rb-ralph"
WATCH_LAUNCHER="$BIN_DIR/rb-ralph-watch"

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then
    die "Refusing to remove non-symlink launcher not owned by RB Ralph: $LAUNCHER"
  fi
  if [ -e "$WATCH_LAUNCHER" ] && [ ! -L "$WATCH_LAUNCHER" ]; then
    die "Refusing to remove non-symlink launcher not owned by RB Ralph: $WATCH_LAUNCHER"
  fi
  [ ! -L "$LAUNCHER" ] || rm -f -- "$LAUNCHER"
  [ ! -L "$WATCH_LAUNCHER" ] || rm -f -- "$WATCH_LAUNCHER"
  [ ! -d "$INSTALL_HOME" ] || rm -rf -- "$INSTALL_HOME"
  printf 'RB Ralph removed from %s\n' "$PREFIX"
  exit 0
fi

if [ -z "$CORE_SOURCE" ]; then
  if [ -f "$SOURCE_ROOT/core/rb-harness.cjs" ]; then
    CORE_SOURCE="$SOURCE_ROOT/core/rb-harness.cjs"
  elif [ -f "$SOURCE_ROOT/../plugins/rb-harness/scripts/rb-harness.cjs" ]; then
    CORE_SOURCE="$SOURCE_ROOT/../plugins/rb-harness/scripts/rb-harness.cjs"
  elif command -v rb-harness >/dev/null 2>&1; then
    CORE_SOURCE="$(command -v rb-harness)"
  else
    die "RB Harness core CLI is unavailable; pass --core-cli <path>"
  fi
fi
if [[ "$CORE_SOURCE" == */* && "$CORE_SOURCE" != /* ]]; then
  CORE_SOURCE="$(pwd -P)/$CORE_SOURCE"
fi
[ -f "$CORE_SOURCE" ] || die "Core CLI does not exist: $CORE_SOURCE"

if [ -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ] && [ "$FORCE" -ne 1 ]; then
  die "Launcher already exists and is not a symlink: $LAUNCHER (use --force to replace it)"
fi
if [ -e "$WATCH_LAUNCHER" ] && [ ! -L "$WATCH_LAUNCHER" ] && [ "$FORCE" -ne 1 ]; then
  die "Dashboard launcher already exists and is not a symlink: $WATCH_LAUNCHER (use --force to replace it)"
fi

install -d -m 0755 "$BIN_DIR" "$INSTALL_HOME/bin" "$INSTALL_HOME/adapters" "$INSTALL_HOME/lib" "$INSTALL_HOME/core"
install -m 0755 "$SOURCE_ROOT/bin/rb-ralph" "$INSTALL_HOME/bin/rb-ralph"
install -m 0755 "$SOURCE_ROOT/bin/rb-ralph-watch" "$INSTALL_HOME/bin/rb-ralph-watch"
install -m 0755 "$SOURCE_ROOT/adapters/adapter-utils.sh" "$INSTALL_HOME/adapters/adapter-utils.sh"
install -m 0755 "$SOURCE_ROOT/adapters/codex.sh" "$INSTALL_HOME/adapters/codex.sh"
install -m 0755 "$SOURCE_ROOT/adapters/claude.sh" "$INSTALL_HOME/adapters/claude.sh"
install -m 0755 "$SOURCE_ROOT/adapters/opencode.sh" "$INSTALL_HOME/adapters/opencode.sh"
install -m 0755 "$SOURCE_ROOT/adapters/api.sh" "$INSTALL_HOME/adapters/api.sh"
install -m 0755 "$SOURCE_ROOT/lib/evidence.cjs" "$INSTALL_HOME/lib/evidence.cjs"
install -m 0755 "$SOURCE_ROOT/lib/control-plane.cjs" "$INSTALL_HOME/lib/control-plane.cjs"
install -m 0755 "$SOURCE_ROOT/lib/provider-telemetry.cjs" "$INSTALL_HOME/lib/provider-telemetry.cjs"
install -m 0755 "$SOURCE_ROOT/lib/usage-summary.cjs" "$INSTALL_HOME/lib/usage-summary.cjs"
install -m 0755 "$SOURCE_ROOT/lib/dashboard.cjs" "$INSTALL_HOME/lib/dashboard.cjs"
install -m 0755 "$SOURCE_ROOT/lib/splash.cjs" "$INSTALL_HOME/lib/splash.cjs"
install -m 0755 "$SOURCE_ROOT/lib/process-supervisor.cjs" "$INSTALL_HOME/lib/process-supervisor.cjs"
install -m 0755 "$SOURCE_ROOT/lib/evidence-index.cjs" "$INSTALL_HOME/lib/evidence-index.cjs"
install -m 0755 "$SOURCE_ROOT/lib/manager-audit.cjs" "$INSTALL_HOME/lib/manager-audit.cjs"
install -m 0755 "$SOURCE_ROOT/lib/operational-verifier.cjs" "$INSTALL_HOME/lib/operational-verifier.cjs"
install -m 0755 "$SOURCE_ROOT/lib/fragment-discovery.cjs" "$INSTALL_HOME/lib/fragment-discovery.cjs"
install -m 0755 "$SOURCE_ROOT/lib/profiles.cjs" "$INSTALL_HOME/lib/profiles.cjs"
install -m 0644 "$SOURCE_ROOT/pricing.example.json" "$INSTALL_HOME/pricing.example.json"
install -m 0644 "$SOURCE_ROOT/README.md" "$INSTALL_HOME/README.md"
install -m 0644 "$SOURCE_ROOT/VERSION" "$INSTALL_HOME/VERSION"

rm -f -- "$INSTALL_HOME/core/rb-harness" "$INSTALL_HOME/core/rb-harness.cjs"
case "$CORE_SOURCE" in
  *.js|*.cjs|*.mjs) install -m 0755 "$CORE_SOURCE" "$INSTALL_HOME/core/rb-harness.cjs" ;;
  *) install -m 0755 "$CORE_SOURCE" "$INSTALL_HOME/core/rb-harness" ;;
esac

if [ -e "$LAUNCHER" ] && [ ! -L "$LAUNCHER" ]; then rm -f -- "$LAUNCHER"; fi
if [ -e "$WATCH_LAUNCHER" ] && [ ! -L "$WATCH_LAUNCHER" ]; then rm -f -- "$WATCH_LAUNCHER"; fi
ln -sfn "../libexec/rb-ralph/bin/rb-ralph" "$LAUNCHER"
ln -sfn "../libexec/rb-ralph/bin/rb-ralph-watch" "$WATCH_LAUNCHER"

printf 'RB Ralph %s installed in %s\n' "$RB_RALPH_VERSION" "$INSTALL_HOME"
printf 'Launcher: %s\n' "$LAUNCHER"
printf 'Dashboard: %s\n' "$WATCH_LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH to call rb-ralph from any directory.\n' "$BIN_DIR" ;;
esac
