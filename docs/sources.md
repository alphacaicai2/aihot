# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

每种信源认哪些配置项写在 `packages/backend/src/sources/config-keys.ts`。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

### rss

#### 从已有 Miniflux/RSS 订阅读取

后端配置 `MINIFLUX_ENV_FILE` 指向本机私有 dotenv 文件，其中提供
`MINIFLUX_BASE_URL` 和 `MINIFLUX_TOKEN`；也可直接使用环境变量。
不要将该文件、Token 或带凭证的 RSS URL 提交 Git。

```sh
node --env-file=.env scripts/import-miniflux.ts --dry-run
node --env-file=.env scripts/import-miniflux.ts
```

导入器只新增当前启用的订阅，重复执行不覆盖后台已有设置。每个订阅保留自己的名称、
Miniflux ID 和分类标签，类型仍为 `rss`，配置为
`{"minifluxFeedId":123,"minifluxLookbackDays":2}`。项目不会修改 Miniflux 的订阅、已读、收藏或抓取设置。
需要纳入新增订阅时重跑导入器；在 Miniflux 暂停的源会停止读取并在后台给出原因。

默认首轮读取近两天内容并标记基线，之后按上游变更时间增量读取，包含已读和未读。
单批最多 60 条，通过固定扫描窗口和 ID 分页继续读取；只有本批存储成功后才推进位置。
已有内容被更新后会正常进入版本检查，重复读取不会重复入库。上游 RSS 失败时仍可读已有内容，
后台会显示 `degraded` 和上游失败计数，而不是把缓存读取成功当成 RSS 健康。

Miniflux 的 `content` 默认作为订阅摘要保存，不声称是完整正文，也不自动访问原文补抓。
确认某源确实提供全文后，可在后台配置 `summaryIsBody:true` 再试抓，已有摘要会升级为正文。
站内全文和全文 RSS 开关仍默认关闭。

普通 RSS 地址继续使用以下原生配置：

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。
如果订阅的 `content:encoded` / Atom `content` 实际也只有摘要，设置 `feedContentIsSummary:true`，保留摘要并让正文提取任务读取原文；默认仍使用订阅提供的正文。
正文采用非标准页面结构时，可用 `bodySelector` 指定已核验的文章正文容器；未匹配到容器则保持正文未确认，不采入页面其他区域。
读取默认最多 8 MiB；确实提供较大 XML 的源可单独配置 `rssMaxBytes`（字节，最多 32 MiB），不影响其他源。

#### 批量导入 OPML

OPML 保存的是订阅清单，导入后每个订阅成为独立的 `rss` 信源，在后台分别管理：

```sh
node --env-file=.env scripts/import-opml.ts path/to/feeds.opml bestblogs --dry-run --dedup-miniflux
node --env-file=.env scripts/import-opml.ts path/to/feeds.opml bestblogs --dedup-miniflux
```

`bestblogs` 是导入批次标签，也作为信源 ID 前缀与标签；文件可以包含嵌套文件夹。
导入器按 RSS 地址去重，重复执行不覆盖后台编辑。`--dedup-miniflux` 会只读 Miniflux 订阅地址，
识别与本站已有 Miniflux 信源的重复，不修改 Miniflux。不同地址即使名称相同也保留。
新源默认 T2、参与精选、每小时读取，全文展示关闭；首次最多收近一个月的最新 5 条，之后走原有 RSS 增量判重流程。
首次抓取安排在导入后约 10 分钟，也可在后台立即抓取。重新导入用于补充新地址，地址修复和启停以后台为准。

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`：`html`（默认，用选择器）、`markdown`（经 Jina 渲染后按 Markdown 读）、`docusaurus_changelog`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### 结构化正文

对已经核实正文位置的站点，可配置 `bodyExtractionJson`。从文章页读取时，用 `selector` 指向唯一的 `application/json` 脚本；从公开 JSON 接口读取时，用 `urlTemplate` 指定包含 `{path}` 或 `{slug}` 的地址。两种入口只选一种。

`path` 指定正文的固定字段路径，`format` 为 `html` 或 `markdown`。HTML 片段包含周边内容时，可用嵌套的 `bodySelector` 限定唯一文章容器。经核实的 Magnolia 页面可指定 `adapter: "magnolia_article"`，只按组件顺序读取正文与问答，遇到未知组件则保留未确认状态。

公开 Sanity API 的文章组件可指定 `adapter: "sanity_article"` 和 `format: "html"`，`path` 必须指向文章本身的组件数组。只读取已支持的段落、链接、列表和图片；遇到未知组件或缺失引用时保留未确认状态，不拼接描述、相关报道或 CMS 元数据。

发布者另有原生 Markdown 全文时，可配置 `bodyExtractionMarkdown: { "urlTemplate": "https://example.org{path}.md" }`，模板须包含 `{path}` 或 `{slug}`。只接受公开 `text/markdown` 或 `text/plain` 响应中的 Markdown 原文，网页、JSON、错误页和过短文本不算正文。该规则与 CSS、JSON-LD、JSON 正文规则互斥，失败后不付费回退。网页列表的详情也从这一原文读取，可用 `detail.publishedAtRegex`、`detail.titleRegex` 指定原文中的主日和标题；未配置该规则的来源行为不变。

此配置不改变 JSON 列表请求的 `bodyJson` 参数，也不从创建时间推断文章发布日期。字段缺失、正文过短或选择结果不唯一时，不会回退到页面导航或付费正文服务。不能与顶层 `bodySelector` 或 `bodyJsonLdType` 同时配置。

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟；免费信源最长 60 分钟，按次计费的信源最长 120–180 分钟。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

对原生 RSS、网页列表和 JSON 列表，可以在配置的 `_aihot` 中设置 `skipInitialRemainder: true`：第一次成功采集建立当前列表基线，只导入 `initialBackfillLimit` 限定的历史条目；其余未变化的存量不会在下次轮询进入站内。此后出现的新网址正常采集，基线中的旧条目发生变化时按历史更新采集。抓取或存储失败不推进基线。此选项不适用于 Miniflux 和 X 搜索，默认关闭，已有订阅保持原行为。已初始化的来源需重新建立基线后再启用此规则。

公开站点拒绝默认请求标识时，可以为原生 RSS、网页列表和 JSON 列表单独配置 `userAgent`，使用明确的采集器名称及站点说明地址。列表、详情和后续正文提取保持同一标识；其他来源和付费 API 保持原请求方式。通过 Miniflux 读取的列表请求由 Miniflux 管理。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。
