# podcast-cloud — 云端 RSS 抓取与字幕服务

英语听力播客的云端后端：自动从 RSS 抓取最新音频、生成字幕、提供 Feed API 给手表端。全部部署在免费服务上（Vercel + Supabase）。

## 目录结构

```
podcast-cloud/
├── vercel.json                 # Vercel 部署配置（Cron + 函数超时 + 路由）
├── package.json
├── .env.example                # 环境变量模板（复制为 .env）
├── schema.sql                  # Supabase 建表 SQL
├── api/index.js                # Vercel serverless 入口（也是本地开发入口）
└── src/
    ├── index.js                # Express app 组装
    ├── routes/
    │   ├── feed.js             # GET /api/feed
    │   └── cron.js             # POST /api/cron/update
    ├── services/
    │   ├── supabaseClient.js   # Supabase 客户端（懒加载）
    │   ├── rssFetcher.js       # RSS 解析 + guid/时长归一化
    │   └── transcriptService.js# 字幕生成：Cloudflare Workers AI / Groq Whisper（含 RSS 兜底）
    └── utils/dateUtils.js      # 时间工具（ISO 8601）
```

## 一、准备 Supabase

1. 打开 [supabase.com](https://supabase.com) 注册并创建免费项目。
2. 进入 **SQL Editor**，复制 [`schema.sql`](./schema.sql) 全文并执行，创建 `episodes` 表。
3. 进入 **Settings → API**，记录：
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

## 二、准备字幕转录（推荐 Cloudflare Workers AI，免费）

使用 Cloudflare Workers AI 的 Whisper 模型自动把音频转成字幕文本：

1. 注册 [Cloudflare](https://dash.cloudflare.com/sign-up)（保持 **Free 免费计划，不要绑定支付方式**——免费计划每天送 10,000 neurons，额度用尽会直接拒绝请求并自动回退，**绝不会产生任何费用**）。
2. 控制台右侧栏复制 **Account ID** → 填入 `CLOUDFLARE_ACCOUNT_ID`。
3. 右上角头像 → **My Profile → API Tokens → Create Token**，模板选 **"Workers AI: Run"**（权限：Account → Workers AI → Run）→ 创建后复制 Token → 填入 `CLOUDFLARE_API_TOKEN`。
4. `.env.example` 中设置 `TRANSCRIPT_API_TYPE=cf-whisper`（默认即为此）。

备选方案：

- `TRANSCRIPT_API_TYPE=groq`：去 [console.groq.com/keys](https://console.groq.com/keys) 申请免费 API Key，填入 `TRANSCRIPT_API_KEY`。
- `TRANSCRIPT_API_TYPE=none`：不调用转录 API，直接使用 RSS 自带 `description` 作为字幕（最省、最稳）。

> 免费额度与超时说明：Whisper 按音频时长计费 neurons（以 [Cloudflare 官方定价](https://developers.cloudflare.com/workers-ai/platform/pricing/) 为准），免费额度大致够每天转录一两个小时音频。Vercel 免费计划函数最长执行 60s，音频较长时转录可能超时——此时自动回退 RSS 描述，条目保持 `pending`，**次日 cron 会自动重试**（转录失败最多重试 `TRANSCRIPT_MAX_ATTEMPTS` 次，默认 3 次，之后标记 `failed`）。

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
  "updated": 0,
  "retried": 2,
  "failed": 0,
  "deleted": 0,
  "errors": []
}
```

- `inserted`：本轮新增并入库的条目数
- `updated`：本轮重试转录后更新的旧条目数（`pending` 重试成功/失败都会更新）
- `retried`：本轮参与重试的 `pending` 旧条目数

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

抓取 RSS、过滤新增 + 重试 pending、生成字幕、写入数据库、清理旧数据。需要 `x-cron-secret` 头（值为 `CRON_SECRET`）。

## 常见问题

- **字幕是"歌词式实时字幕"吗？** 是。Whisper 转录结果会保存为带时间戳的 VTT（`subtitle_vtt`），手表端播放时按进度逐行高亮，像歌词一样。RSS 自带的 description 只是节目简介，**不再当作字幕**使用。
- **免费额度用尽（HTTP 429）**：Cloudflare 免费计划每天 10,000 neurons，用尽后接口返回 429。本服务会自动跳过后续转录，条目保持 `pending`，**次日额度重置后 cron 自动重试**，无需人工干预。只要不绑定支付方式就不会产生费用。
- **转录失败/超时**：Vercel 免费计划函数最长执行 60s，音频较长时 Whisper 转录可能超时。超时会保留 `pending`，下次 cron 自动重试（最多 `TRANSCRIPT_MAX_ATTEMPTS` 次，默认 3，之后标记 `failed`）。可改用更短的音频，或在 Vercel 升 Pro（300s）后提高 `TRANSCRIPT_API_TIMEOUT_MS`。
- **转录一直 pending**：检查 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` 是否正确、Token 是否勾选了 "Workers AI: Run" 权限；或查看该条目的 `transcription_error` 字段定位原因。
- **老节目没有 VTT 字幕**：早期版本把 RSS 简介当字幕、没有时间轴。升级后 cron 会自动重转录这些老条目（`ready` 但无 `subtitle_vtt` 的会被重新转录），新条目直接就有实时字幕。
- **guid 冲突**：`episodes.guid` 唯一；RSS 的 `guid` 相同则跳过，不会重复插入。
- **Supabase 行数上限**：免费层 5000 行，`MAX_KEEP_EPISODES`（默认 30）会自动清理最旧记录。