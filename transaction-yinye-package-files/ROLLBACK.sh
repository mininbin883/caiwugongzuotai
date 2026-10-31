#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
MODE="${2:---local}"
ORIGINAL_HEAD="e32499b64261f1478f3bff41ed6d044cdad9ebd6"
case "$MODE" in
  --local|--remote) ;;
  *) echo "usage: ROLLBACK.sh <repo-root> [--local|--remote]" >&2; exit 2 ;;
esac
git -C "$ROOT" reset --hard "$ORIGINAL_HEAD"
git -C "$ROOT" clean -fd -- yinye/package-files transaction-yinye-package-files
if [[ "$MODE" == "--remote" ]]; then
  git -C "$ROOT" push --force-with-lease origin "$ORIGINAL_HEAD:main"
fi
ACTUAL="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$ACTUAL" == "$ORIGINAL_HEAD" ]]
echo "ROLLBACK_OK mode=${MODE#--} root=$ROOT head=$ACTUAL"