#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
    printf '%s\n' 'Error: Bun is required. Install Bun and add it to PATH.' >&2
    exit 1
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
cd "$script_dir"

if [ "$#" -eq 0 ]; then
    exec bun run src/cli.ts wizard
fi

case "$1" in
    -*) exec bun run src/cli.ts wizard "$@" ;;
    *) exec bun run src/cli.ts "$@" ;;
esac
