# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
docker compose up -d --build
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分，入选的还要写标题摘要）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外信源抓不到时，在 `.env` 里设置 `EGRESS_PROXY_URL`：抓信源、图片和模型榜数据时走这个代理，调用模型接口不走。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

### 更新

```bash
git pull
docker compose up -d --build
```

数据库迁移只做向后兼容的增量，更新时自动执行。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（S3 兼容的对象存储），每天 04:10 自动备份到那里。还没有异地目的地时，可以先设置 `BACKUP_LOCAL_ENABLED=true` 开启每日本地备份；后台会继续提示异地存储尚未配置。本地副本和数据库在同一台服务器，无法抵御整台服务器丢失。

每次备份是 `/data/backups/backup-<时间>-<唯一编号>/` 下的一个完整目录，包含 `database.dump`、`uploads.tar.gz` 和 `manifest.json`。目录仅运行用户可访问，文件权限为 600；保留最近三个完整本地目录。原有旧格式备份保留。数据库导出与所有业务表的行数、内容指纹使用同一个 PostgreSQL 快照，在线写入不会造成清单和导出内容错位。对象存储仍使用 `daily/`、`weekly/`、`monthly/` 前缀，各目录的清单最后上传。

后台“运行 → 自动备份”分别显示本地、异地的最近成功时间和最近失败原因。异地上传失败仍保留完整本地目录，不会覆盖上一次异地成功记录。密码通过子进程环境传递，不出现在 `pg_dump` 参数中。

恢复演练只接受本应用的可信备份，并且目标必须是独立、空的 `_test` 或 `_ci` 数据库。先创建空库，再执行（容器镜像已包含 PostgreSQL 客户端）：

```bash
RESTORE_DATABASE_URL=postgres://用户@隔离数据库:5432/restore_test \
  node scripts/restore-check.ts /backup/manifest.json
```

工具会先核对文件大小和 SHA-256，再实际恢复数据库、比对每张表的完整内容指纹，检查自增序列不会复用已有 ID，并解包附件到一个新的隔离目录。它不启动 worker 或任何采集、模型、推送任务，不覆盖已有对象，也不恢复到生产数据库。成功输出包含恢复的表数、行数、序列数、附件目录和耗时；演练结束后清理自己创建的测试库与附件目录。`pg_restore --list` 只验证归档目录可读取，完整恢复必须通过上述演练。[PostgreSQL 17 文档](https://www.postgresql.org/docs/17/app-pgrestore.html)

也可以手动导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

### 模型故障自动兜底

设置 `LLM_FALLBACK_MODEL=deepseek-flash`，并配置 `DEEPSEEK_BASE_URL=https://api.deepseek.com/v1` 与 `DEEPSEEK_API_KEY`，可让后端直连 DeepSeek 官方接口。未设置时保持原来的模型调用方式。

连接失败、超时、连接断开、429/5xx 和无法解析的模型输出会让当前步骤转用 fallback；已有成功步骤继续复用回执。内容安全拒绝、正常筛除、预算熔断、数据库错误不触发兜底。每一步选择 fallback 后会持久化，重启或重试继续使用同一回执，不重新调用原模型；未知的原请求仍保留给管理员核对计费，原请求和 fallback 的未知回执都不会被自动放行。fallback 也失败时交给现有任务退避规则处理，不递归切换。

连续失败达到 `LLM_FALLBACK_FAILURE_THRESHOLD`（默认 3）后，主线路暂停 `LLM_FALLBACK_COOLDOWN_SECONDS`（默认 300）秒，期间新步骤直接走 fallback；已完成和仍在执行的主请求不受影响。冷却后只放一个请求探测，成功后恢复主线路。预筛/评分评测不会自动换模型，以免把别家结果算到参评模型上。

配置 fallback 后，主线路最多同时发送 `LLM_PRIMARY_MAX_CONCURRENCY`（默认 20）个请求，上限通过 PostgreSQL 在进程间共享；达到上限的新步骤走 fallback，已有响应继续复用。诊断或评测显式关闭 fallback 的调用保持原模型。熔断使用独立的探测归属，旧的在途请求不会关闭后来打开的熔断。

故障恢复期间可设置 `LLM_PRIMARY_MODE=probe`：主要工作继续走 fallback，每个冷却周期只允许一次主线路探测，探测成功也不立即恢复全部流量。观察实际请求成功率、延迟、输出质量和费用后改回 `normal`。备用预算保持独立，不会自动提高。

`ops.recover` 会恢复当前版本尚未完成、没有排队或在途任务且备用结果可用的分析、归组和综述；已完成、旧版本、人工评测以及备用结果也未知的步骤会跳过。尚无备用路由的默认主模型 unknown 会先选择独立的备用回执，原请求保留 unknown，不再自动释放后重发。其他服务仍沿用一次自动放行规则；放行备注与原始 attempt 错误分开保存。

管理员确认上游已计费且费用为 0 时，可通过 `POST /api/admin/receipts/confirm-zero-cost` 提交明确的 `receiptIds` 和 `note`。确认保存在独立的 `billing_review` 中，注明人工来源、操作者和时间，并写入审计；不会改写供应商的 usage/cost、原始错误或 unknown 响应状态，也不会放行或重新入队。重复确认不会覆盖原确认。已确认的回执移出待核账列表，仍计入 unknown 总数和备用处理状态；缺少计费元数据本身不会被自动认定为费用 0。

后台导航、运行页和系统日报使用同一待核账条件。日报不会把已确认费用的 unknown 再列为待核账，也不会建议直接放行；响应恢复仍看备用回执与文章实际处理状态。关闭内置采集（`COLLECT_ENABLED=false`）时，外部推送的文章仍可能需要模型处理，因此模型开启时，处理积压与日报缺失告警继续生效。运行页的重试时间已到时显示“等待调度”；该时间是最早可重试时间，不保证任务恰好在那一刻开始。

fallback 的每次请求仍通过回执与对应服务预算；DeepSeek 使用后台已有的 `deepseek` 预算。原请求可能已经计费，切换不表示退款或未收费。模型使用情况和费用按实际回执统计。

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

后台费用有两种口径：OpenRouter Qwen 显示回执返回的实际费用；DeepSeek V4.1 Flash 显示 `≈` 和“官方估算”，按各次请求的 token 用量、缓存命中和请求时间计算，即使代理没有返回费用也能显示。缺少缓存信息时按未命中算，没有 token 用量的请求不计成零费用。估算采用 [DeepSeek 官方价格](https://api-docs.deepseek.com/quick_start/pricing/) 的 2026-10-11 快照及 2026 中国节假日；价格或后续年度假期变化时，用增量迁移更新 `estimate_deepseek_v41_flash` 和 `service_prices`。历史用量按此价格快照估值，原始回执和实际账单保留。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
