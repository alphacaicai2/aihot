#!/usr/bin/env bash
# Extra arguments replace the default Compose rollout.
set -euo pipefail
site=${1:?请提供正式站 URL}
shift
node scripts/check-changelog.ts --before "$site"
if (( $# == 0 )); then
  set -- docker compose up -d --build --wait
fi
"$@"
# Only retry the read-back. A late API or cache must never repeat the deployment.
for attempt in {1..12}; do
  if node scripts/check-changelog.ts --after "$site"; then exit 0; fi
  if (( attempt < 12 )); then sleep 5; fi
done
echo '部署命令已执行，但站点尚未返回本次日志。请核对 API 使用的文件，并用 --after 重新验收。' >&2
exit 1
