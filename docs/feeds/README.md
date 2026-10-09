# 可迁移的订阅清单

`frontierlist.opml` 保存了 2026-10-09 从 FrontierList 筛选并加入本机站点的 6 个公开 RSS/Atom 地址。

在新环境中导入：

```sh
node --env-file=.env scripts/import-opml.ts docs/feeds/frontierlist.opml frontierlist --dedup-miniflux
```

`--dedup-miniflux` 需要配置 Miniflux 凭证；未使用 Miniflux 的环境可省略。导入器会跳过已有地址，不覆盖后台设置。

本机首次采集采用近 7 天、每源最多 5 篇；通用导入器默认近 1 个月、最多 5 篇，新环境如需复现 7 天窗口，应在首次抓取前把新信源的 `config._aihot.initialBackfillMonths` 设为 `7 / 30`（数值）。这些参数只限制首次采集，不限制后续抓取。

OPML 仅保存名称和订阅地址，不包含文章、凭证、评分、抓取进度及数据库设置。迁移完整站点仍需备份、恢复数据库。
