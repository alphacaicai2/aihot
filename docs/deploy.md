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

每次发布前，在 `industry/changelog.json` 顶部增加一条面向使用者的说明，并同步 `latestVersion`。主分支推送与 PR 的 CI 会对比基线检查新条目。部署时从待发布版本的仓库根目录执行，把域名换成目标站点。

```bash
git pull --ff-only &&
bash scripts/deploy-update.sh https://example.com
```

脚本先和线上版本比较，缺条目即退出。通过后执行 Compose 更新，再从线上读回日志、导航提醒版本和公开页面。增量镜像、仅更新 Web 或 worker、配置发布和回滚，可把本次部署命令及参数接在 URL 后面，沿用相同检查。回滚时追加说明，保留先前版本的记录。

API 默认读取镜像的 `industry/changelog.json`，也可通过 `AIHOT_CHANGELOG_FILE` 指定文件。API 会缓存日志。草庐正式站把主机的 `/opt/caolu/app/industry/changelog.json` 只读挂载到 API 同名文件。增量发布命令须原子替换该主机文件，并用当前 Compose 配置重新创建 API 容器，让绑定挂载指向新文件。若部署后验收失败，可单独运行 `node scripts/check-changelog.ts --after https://example.com` 复核。

数据库迁移只做向后兼容的增量，更新时自动执行。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。也可以手动导出：

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

fallback 的每次请求仍通过回执与对应服务预算；DeepSeek 使用后台已有的 `deepseek` 预算。原请求可能已经计费，切换不表示退款或未收费。模型使用情况和费用按实际回执统计。

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

后台费用有两种口径：OpenRouter Qwen 显示回执返回的实际费用；DeepSeek V4.1 Flash 显示 `≈` 和“官方估算”，按各次请求的 token 用量、缓存命中和请求时间计算，即使代理没有返回费用也能显示。缺少缓存信息时按未命中算，没有 token 用量的请求不计成零费用。估算采用 [DeepSeek 人民币官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 的 2026-10-13 快照及 2026 中国节假日；价格或后续年度假期变化时，用增量迁移更新 `estimate_deepseek_v41_flash_cny` 和 `service_prices`。历史用量按此价格快照估值，原始回执和实际账单保留。

后台“模型与评测”顶部显示总费用，按币种分别汇总回执实际费用与 DeepSeek 官方调用估算，并列出未计入的请求数量。代理通道的参考估值不计入总费用。

后台“模型与评测”的 DeepSeek 官方合计只包含 `deepseek` 通道的 `deepseek-flash`，覆盖所有用途和重试；代理通道仅显示估值。选择“今天”或“昨天”按北京时间自然日统计，24 小时/7 天/30 天为滚动窗口。与官方后台对账时选择本站的 API Key、相同日期及人民币币种；All 会包含其他 Key 的用量，官方数据最多延迟 5 分钟。缺少用量的请求显示未计入数量，不能视作免费。

## 首页的 Google 读者登录

在 Google Cloud 的 Google Auth Platform 配置品牌和受众。向普通读者开放时选 External，测试阶段将要试用的账号添加为测试用户。在 Clients 创建 Web application 类型的 OAuth 客户端，把网站的完整回调地址登记为 Authorized redirect URI。例如站点为 `https://news.example.com`，回调地址为 `https://news.example.com/api/reader/google/callback`。[Google 配置说明](https://developers.google.com/identity/openid-connect/openid-connect)

在 API 环境中设置 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`，确认已有 `SESSION_SECRET`，并将 `SITE_URL` 设为读者实际访问的站点地址。运行数据库迁移并用新配置重启 API、更新网页后，首页会显示「使用 Google 登录」。本机测试可使用 `http://localhost:3000/api/reader/google/callback`，同时将 `SITE_URL` 设为 `http://localhost:3000`。

登录只申请 OpenID 和邮箱权限。站点用 Google 账号标识识别读者，首页显示经过验证的邮箱。读者会话有效期 30 天，点击「退出」立即撤销当前会话。

## 读者会员与 Stripe

普通资讯开放匿名阅读。会员中心在 `/membership`，每月 5 美元订阅包含 Agent 接入和融资数据库。管理员登录后可直接使用，在后台「会员授权」可以按邮箱授予、撤销同样的权限。对于 Google 无法确认当前归属的第三方邮箱，管理员可在同页生成一次性确认码，交付到该地址，由读者在会员中心输入。确认码 24 小时有效，重新生成将使上一个码失效。所有读者都可直接用自己的 Google 账户订阅。

1. 在 Stripe 创建启用状态的循环价格，币种为 USD，金额为 5.00，周期为每 1 个月。将价格的 `price_…` ID 配置到 API 的 `STRIPE_PRICE_ID`，并设置同一模式下的 `STRIPE_SECRET_KEY`。
2. 将 Stripe Webhook 端点设为 `https://你的站点/api/reader/billing/webhook`。订阅 `checkout.session.completed`、`invoice.paid`、`invoice.payment_failed`，以及 `customer.subscription.created`、`updated`、`deleted`、`paused`、`resumed`（后四项同属 `customer.subscription.` 前缀）。将该端点的签名密钥写入 API 的 `STRIPE_WEBHOOK_SECRET`。付款后的会员有效期由已验证的账单事件更新。[Stripe 订阅 Webhook](https://docs.stripe.com/billing/subscriptions/webhooks)
3. 启用 Stripe Customer Portal，允许更新支付方式和在当前计费期末取消续订。若为本站创建了专用 Portal 配置，将其 `bpc_…` ID 写入 `STRIPE_PORTAL_CONFIGURATION_ID`。[Stripe 客户门户设置](https://docs.stripe.com/customer-management/configure-portal)
4. 运行数据库迁移并更新 API 和 Web。代理须转发 Cookie 和 Authorization 请求头，并遵循 `Cache-Control: private, no-store`。启用访问限制时清除 CDN 里已有的融资、RSS、MCP、会员 API、机器可读文档和相关页面缓存。运行 `node scripts/smoke.ts --base https://你的站点` 检查访客权限。要验证会员 MCP，可在环境中设置会员 Agent 令牌 `MEMBERSHIP_AGENT_TOKEN`，再运行 `node scripts/mcp-check.ts https://你的站点/api/mcp`。

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

### 有正式站定制时如何发布

正式站的 Web、API 和 worker 源码及构建流程保存在受控的生产仓库。发布记录同时标明框架提交、生产源码提交和三个镜像的内容摘要。发布时使用从干净检出构建、已在隔离数据库验证过的同一组镜像，切换前保留上一个版本的镜像引用。

升级数据库后，检查新 worker 的心跳来自本次启动的容器，核对模型路由、会员页面回跳、融资查询及公开更新日志。机器重建时可用发布归档恢复这组镜像，再单独恢复数据库、上传文件和部署凭证。
