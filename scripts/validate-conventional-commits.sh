#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/validate-conventional-commits.sh edit <commit-msg-file>
  scripts/validate-conventional-commits.sh last
  scripts/validate-conventional-commits.sh range <from> <to>
  scripts/validate-conventional-commits.sh title <message>
  scripts/validate-conventional-commits.sh upstream
EOF
}

mode="${1:-}"

if [ -z "$mode" ]; then
  usage
  exit 1
fi

shift

commitlint() {
  pnpm exec commitlint --strict --verbose "$@"
}

case "$mode" in
  edit)
    if [ "$#" -ne 1 ]; then
      usage
      exit 1
    fi

    commitlint --edit "$1"
    ;;

  last)
    if [ "$#" -ne 0 ]; then
      usage
      exit 1
    fi

    commitlint --last
    ;;

  range)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi

    commitlint --from "$1" --to "$2" --git-log-args=--no-merges
    ;;

  title)
    if [ "$#" -ne 1 ]; then
      usage
      exit 1
    fi

    printf '%s\n' "$1" | commitlint
    ;;

  upstream)
    if [ "$#" -ne 0 ]; then
      usage
      exit 1
    fi

    upstream_ref="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

    if [ -z "$upstream_ref" ]; then
      echo "No upstream branch found; validating the last commit instead."
      commitlint --last
      exit 0
    fi

    commitlint --from "$upstream_ref" --to HEAD --git-log-args=--no-merges
    ;;

  *)
    usage
    exit 1
    ;;
esac
