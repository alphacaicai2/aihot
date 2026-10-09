# 本机 Miniflux/RSS 站点

阅读页：<http://127.0.0.1:3102/all>；后台：<http://127.0.0.1:3102/admin/sources>。
仅绑定本机回环地址。后台登录密码为项目 `.env` 中的 `ADMIN_PASSWORD`，请勿提交或转发该文件。

## 启动和停止

需要 Docker Desktop 正在运行，以及 Node.js 24.11 或更新版本。在项目目录执行：

```sh
docker compose --env-file .env -p tony-aihot -f deploy/docker-compose.local-db.yml up -d
node --env-file=.env scripts/run-local.ts
```

保持这个终端运行；按 Ctrl+C 停止网站、API 和 worker。没有配置登录自动启动。
数据库独立监听 `127.0.0.1:55433`，数据保存在 Docker 卷中；启动时不要同时运行第二份 supervisor。

代码更新后按项目检查要求验证，并重新构建前端：

```sh
npm run build -w @aihot/web
```

## 信源和模型

已接入现有 Miniflux 启用的订阅。首轮读取近两天内容，后续按变更时间增量同步，
默认间隔 30 分钟（worker 会根据产出调整）。在后台可暂停、改频率、看抓取记录和试抓。
新增 Miniflux 订阅后执行：

```sh
node --env-file=.env scripts/import-miniflux.ts
```

BestBlogs OPML 已作为独立 RSS 信源导入，标签 `bestblogs`。在后台搜索 `bestblogs` 可查看这一批订阅。
它与 Miniflux 中已有的相同 RSS 地址去重，不会修改 Miniflux。
抓取默认每小时一次，首次最多读取近一个月的最新 5 条，后续按项目原有规则去重入库。
OPML 清单不会自动跟随 GitHub 更新；需要补充新订阅时下载后重跑导入器，已有设置保留：

```sh
curl -fsSL https://raw.githubusercontent.com/ginobefun/BestBlogs/main/BestBlogs_RSS_ALL.opml -o .data/BestBlogs_RSS_ALL.opml
node --env-file=.env scripts/import-opml.ts .data/BestBlogs_RSS_ALL.opml bestblogs --dedup-miniflux
```

导入器只新增，不覆盖后台设置。Miniflux 原有的已读、收藏和订阅设置不受影响。
原生 RSS 也可直接在后台新建 `rss` 信源，配置 `feedUrl`；细节见 [信源说明](sources.md)。

Miniflux 凭证通过 `.env` 中的 `MINIFLUX_ENV_FILE` 引用既有私有文件。
模型采用现有本机代理 `http://127.0.0.1:8317/v1` 的 `deepseek-v4.1-flash`；
代理需要保持运行。模型凭证在 `.data/credentials/models.env`，非秘密的模型选项在 `.env`。
已关闭 thinking 和强制 JSON 模式，以兼容当前代理；真实文章的中文摘要与评分链路已验证。
模型请求继续经过项目的回执和预算控制；首批文章通过 worker 队列逐步处理。

只展示摘要和原文链接，不自动补抓原文全文。RSS 内容默认标记为未确认全文。
后台 `degraded` 表示 Miniflux 上游抓取存在错误，即使缓存内容仍能读取；需在 Miniflux 修复上游订阅。
飞书推送及 IndexNow 提交关闭。

`.env` 和 `.data/` 已由 Git 忽略，数据库卷也不进入仓库。
