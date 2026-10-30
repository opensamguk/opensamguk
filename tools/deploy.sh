#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 2 || ( "$1" != --preflight && "$1" != --target-preflight ) ]]; then
  printf '%s\n' '사용법: deploy.sh --preflight|--target-preflight <입력 JSON 절대 경로>' >&2
  exit 1
fi
tools_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
cd -- "$tools_dir/.."
if [[ "$1" == --target-preflight ]]; then
  exec node --import tsx "$tools_dir/release-target-preflight.ts" "$@"
fi
exec node --import tsx "$tools_dir/release-preflight.ts" "$@"
