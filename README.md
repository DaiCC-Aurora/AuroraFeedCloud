# podcast-cloud — 云端 RSS 抓取与字幕服务

英语听力播客的云端后端：自动从 RSS 抓取最新音频、生成字幕、提供 Feed API 给手表端。全部部署在免费服务上（Vercel + Supabase + Cloudflare Workers）。

> **架构**：Vercel 免费函数限时 60s，转录必然超时（504），因此**转录改由 Cloudflare Worker 异步完成**：
> Vercel cron 只做 RSS 同步入库（秒级）→ Cloudflare Worker 定时/手动拉取 pending 条目 → 下载音频、分段、Whisper 转录 → 回写字幕。见 [cloudflare-worker/worker.js](./cloudflare-worker/worker.js)。

## 目录结构

```
podcast-cloud/
├── vercel.json                 # Vercel 部署配置（Cron + 函数超时 + 路由）
├── package.json
├── .env.example                # Vercel 环境变量模板（复制为 .env）
├── schema.sql                  # Supabase 建表 SQL
├── api/index.js                # Vercel serverless 入口（也是本地开发入口）
├── cloudflare-worker/
│   └── worker.js               # 异步字幕转录 Worker（粘贴到 CF 控制台部署）
└── src/
    ├── index.js                # Express app 组装
    ├── routes/
    │   ├── feed.js             # GET /api/feed
    │   └── cron.js             # POST /api/cron/update（仅 RSS 同步）
    ├── services/
    │   ├── supabaseClient.js   # Supabase 客户端（懒加载）
    │   ├── rssFetcher.js       # RSS 解析 + guid/时长归一化
    │   ├── mp3Chunker.js       # MP3 帧级切分（无原生依赖，CBR/VBR 时间精确到帧）
    │   └── transcriptService.js# 转录实现（供 Worker 逻辑参考/单测）
    └── utils/dateUtils.js      # 时间工具（ISO 8601）
```

## 一、准备 Supabase

1. 打开 [supabase.com](https://supabase.com) 注册并创建免费项目。
2. 进入 **SQL Editor**，复制 [`schema.sql`](./schema.sql) 全文并执行，创建 `episodes` 表。
3. 进入 **Settings → API**，记录：
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

## 二、部署字幕转录 Worker（Cloudflare Workers，免费）

转录由 Cloudflare Worker 完成（不受 Vercel 60s 限制）。部署步骤：

1. 注册 [Cloudflare](https://dash.cloudflare.com/sign-up)（保持 **Free 免费计划，不要绑定支付方式**——免费计划每天送 10,000 neurons，额度用尽会拒绝请求并自动重试，**绝不会产生任何费用**）。
2. **Workers & Pages → Create → Worker** → 把 [`cloudflare-worker/worker.js`](./cloudflare-worker/worker.js) 全部内容粘贴进去 → **Deploy**。
3. 在 Worker 的 **Settings → Variables and Secrets** 添加：
   - `SUPABASE_URL`（Supabase Settings → API 的 Project URL）
   - `SUPABASE_SERVICE_ROLE_KEY`（同上，service_role key）
   - `CRON_SECRET`（手动触发用的密钥，可随意设）
   - 可选调参：`TRANSCRIPT_CF_MODEL`（默认 `@cf/openai/whisper`，可换更快的 `@cf/onnx-community/whisper-large-v3-turbo`）、`TRANSCRIPT_CF_CHUNK_SECONDS`（默认 600）、`TRANSCRIPT_CF_CHUNK_CONCURRENCY`（默认 3）、`TRANSCRIPT_CF_MAX_AUDIO_MB`（默认 24）、`TRANSCRIPT_MAX_ATTEMPTS`（默认 3）
4. 在 Worker 的 **Settings → Variables** 添加 **"Workers AI" 绑定**，变量名填 `AI`。
5. （可选）**Triggers → Cron Triggers** 添加定时任务（如每小时 `* * * *`，免费套餐的触发频率以控制台提示为准），让转录自动跑。
6. 手动触发验证：

```bash
curl -X POST https://<你的worker>.workers.dev/run -H "x-cron-secret: <CRON_SECRET>"
```

> 免费额度说明：Whisper 按音频时长计费 neurons（以 [Cloudflare 官方定价](https://developers.cloudflare.com/workers-ai/platform/pricing/) 为准），免费额度大致够每天转录一两个小时音频。音频超过 24MB 会自动**分段转录**：MP3 帧级切分 → 各段并发转录 → 时间戳按帧偏移合并，字幕仍同步准确。

## 三、本地运行

```bash
cd podcast-cloud
cp .env.example .env      # 然后编辑 .env 填入真实值
npm install
npm run dev               # 或 npm start
```

验证：

```bash
# 健康检查
curl http://localhost:3000/api/health

# 手动触发一次抓取（.env 里没配 CRON_SECRET 时会放行）
curl -X POST http://localhost:3000/api/cron/update

# 读取 Feed
curl "http://localhost:3000/api/feed?limit=10"
```

## 四、部署到 Vercel

1. 把本目录推到 GitHub 仓库。
2. 在 [vercel.com](https://vercel.com) 导入该仓库（框架选 “Other”，根目录选 `podcast-cloud`）。
3. 在项目 **Settings → Environment Variables** 添加 `.env.example` 中的变量（`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RSS_FEED_URL`、`CRON_SECRET`、`TRANSCRIPT_API_TYPE`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` 等）。
4. Deploy。部署后可用：
   - `https://<你的项目>.vercel.app/api/feed?limit=10`
   - `https://<你的项目>.vercel.app/api/cron/update`

## 五、配置定时任务

`vercel.json` 已声明 Cron：每天 03:00（UTC）调用 `POST /api/cron/update`。

- Vercel Cron 需在项目 **Settings → Cron Jobs** 中启用（部分免费计划可能需要升级；若不可用，见下方兜底方案）。
- **重要**：Vercel Cron 请求不会自动携带 `CRON_SECRET`。请在 **Cron Jobs 配置里手动加 Header**：
  - Header 名：`x-cron-secret`
  - 值：你在环境变量里设置的 `CRON_SECRET`

### 兜底：cron-job.org（Vercel Cron 不可用时）

1. 打开 [cron-job.org](https://cron-job.org) 新建任务：
   - URL：`https://<你的项目>.vercel.app/api/cron/update`
   - 请求方式：`POST`
   - 执行计划：每天 `03:00`
   - 自定义 Header：`x-cron-secret: <你的 CRON_SECRET>`
2. 保存启用即可（每分钟调用也不需要，每天一次足够）。

## 六、手动触发抓取

```bash
curl -X POST https://<你的项目>.vercel.app/api/cron/update \
  -H "x-cron-secret: <你的 CRON_SECRET>"
```

成功返回类似：

```json
{
  "fetched": 12,
  "newCount": 3,
  "inserted": 3,
  "failed": 0,
  "deleted": 0,
  "errors": []
}
```

- `inserted`：本轮新增并入库的条目数（`transcription_status=pending`，等 Worker 转录）

> 注意：cron 不再返回 `updated/retried`——转录已不在 Vercel 执行，由 Cloudflare Worker 异步完成。

## API 说明

### GET /api/feed?limit=10

返回最新节目列表（`Cache-Control: public, max-age=300`）。

```json
{
  "channel": { "title": "英语听力", "description": "Aurora的英语听力", "language": "en", "update_time": "2026-08-21T10:00:00Z" },
  "items": [
    {
      "guid": "ep-2026-08-21",
      "title": "News Summary 2026-08-21",
      "pub_date": "2026-08-21T08:00:00Z",
      "audio_url": "https://external-audio-cdn.com/....mp3",
      "subtitle_url": null,
      "subtitle_vtt": "WEBVTT\n\n00:00.000 --> 00:03.000\nHello everyone...",
      "duration_seconds": 420,
      "transcript": "Full subtitle text here..."
    }
  ]
}
```

> `subtitle_vtt` 是带时间戳的 VTT 字幕（Whisper 转录产物），手表端据此像歌词一样逐行实时显示；`transcript` 是同内容的纯文本。

### POST /api/cron/update

只做轻量 RSS 同步：抓取 RSS、新增条目入库（`pending`）、清理旧数据。需要 `x-cron-secret` 头（值为 `CRON_SECRET`）。转录由 Cloudflare Worker 异步完成。

## 常见问题

- **字幕是"歌词式实时字幕"吗？** 是。Whisper 转录结果会保存为带时间戳的 VTT（`subtitle_vtt`），手表端播放时按进度逐行高亮，像歌词一样。RSS 自带的 description 只是节目简介，**不再当作字幕**使用。
- **Vercel cron 504 超时怎么办**：已解决——转录已迁移到 Cloudflare Worker（见上文"二、部署字幕转录 Worker"），Vercel cron 只做 RSS 同步，几秒内返回。
- **转录一直 pending**：确认 Worker 已部署、`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 已配、Workers AI 绑定（变量名 `AI`）已添加；然后手动触发一次 Worker：`curl -X POST https://<你的worker>.workers.dev/run -H "x-cron-secret: <CRON_SECRET>"`，返回 JSON 里的 `errors` 会说明原因；也可在 Supabase 表里看该条目的 `transcription_error`。
- **免费额度用尽（HTTP 429）**：Cloudflare 免费计划每天 10,000 neurons，用尽后 Worker 会停止并标记，条目保持 `pending`，**次日额度重置后自动重试**。只要不绑定支付方式就不会产生费用。
- **音频超过 24MB 怎么办**：RSS 源的整集音频普遍 >24MB。Worker 会自动**分段转录**：按 MP3 帧精确切分（每段默认 10 分钟）→ 各段并发转录 → 文本/VTT 按帧级时间戳偏移合并，字幕仍然同步准确。若源不是 MP3（无法帧级切分）且超过上限，会保持 `pending` 并在 `transcription_error` 中说明。
- **老节目没有 VTT 字幕**：早期版本把 RSS 简介当字幕、没有时间轴。Worker 会自动重转录这些老条目（`ready` 但无 `subtitle_vtt` 的会被重新转录），新条目直接就有实时字幕。
- **guid 冲突**：`episodes.guid` 唯一；RSS 的 `guid` 相同则跳过，不会重复插入。
- **Supabase 行数上限**：免费层 5000 行，`MAX_KEEP_EPISODES`（默认 30）会自动清理最旧记录。