#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
MODE="${2:---local}"
ORIGINAL_HEAD="f98efe931920abe20023681080fc5d155e86dc9f"
TAG="software-bundle-2026.10.31"
REPO="mininbin883/caiwugongzuotai"
cd "$ROOT"
case "$MODE" in
  --local)
    git cat-file -e "${ORIGINAL_HEAD}^{commit}"
    git reset --hard "$ORIGINAL_HEAD" >/dev/null
    git clean -fd >/dev/null
    printf 'ROLLBACK_OK mode=local root=%s head=%s\n' "$ROOT" "$(git rev-parse HEAD)"
    ;;
  --remote)
    git fetch origin main --tags
    UPLOAD_COMMIT="$(git rev-list -n 1 "$TAG")"
    test -n "$UPLOAD_COMMIT"
    gh release delete "$TAG" --repo "$REPO" --cleanup-tag --yes
    git checkout main
    git pull --ff-only origin main
    git revert "$UPLOAD_COMMIT" --no-edit
    git push origin main
    printf 'ROLLBACK_OK mode=remote repo=%s reverted=%s\n' "$REPO" "$UPLOAD_COMMIT"
    ;;
  *)
    printf 'usage: %s <repo-copy> [--local|--remote]\n' "$0" >&2
    exit 2
    ;;
esac
