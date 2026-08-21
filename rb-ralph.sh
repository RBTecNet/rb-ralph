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

SCRIPT_PATH="$(resolve_real_path "${BASH_SOURCE[0]}")"
SOURCE_ROOT="$(dirname "$SCRIPT_PATH")"

case "${1:-}" in
  --install)
    shift
    exec "$SOURCE_ROOT/install.sh" "$@"
    ;;
  --uninstall)
    shift
    exec "$SOURCE_ROOT/install.sh" --uninstall "$@"
    ;;
  *)
    exec "$SOURCE_ROOT/bin/rb-ralph" "$@"
    ;;
esac
