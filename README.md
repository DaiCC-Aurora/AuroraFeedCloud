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
    │   └── transcriptService.js# Groq Whisper 转录（含 RSS description 兜底）
    └── utils/dateUtils.js      # 时间工具（ISO 8601）
```

## 一、准备 Supabase

1. 打开 [supabase.com](https://supabase.com) 注册并创建免费项目。
2. 进入 **SQL Editor**，复制 [`schema.sql`](./schema.sql) 全文并执行，创建 `episodes` 表。
3. 进入 **Settings → API**，记录：
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

## 二、准备转录 API（可选）

- 默认 `TRANSCRIPT_API_TYPE=groq`，去 [console.groq.com/keys](https://console.groq.com/keys) 申请免费 API Key，填入 `TRANSCRIPT_API_KEY`。
- 若不想调用转录 API（省时、避免超时），把 `TRANSCRIPT_API_TYPE=none`，此时会直接使用 RSS 自带 `description` 作为字幕（最稳）。

> 提示：Vercel 免费计划函数执行时长有限，音频下载 + Whisper 转录可能超时。**推荐先用 `none` 方案**跑通全流程，再按需开启 Groq。

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
3. 在项目 **Settings → Environment Variables** 添加 `.env.example` 中的变量（`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`RSS_FEED_URL`、`CRON_SECRET`、`TRANSCRIPT_API_TYPE`、`TRANSCRIPT_API_KEY` 等）。
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
      "duration_seconds": 420,
      "transcript": "Full subtitle text here..."
    }
  ]
}
```

### POST /api/cron/update

抓取 RSS、过滤新增、生成字幕、写入数据库、清理旧数据。需要 `x-cron-secret` 头（值为 `CRON_SECRET`）。

## 常见问题

- **转录失败/超时**：免费计划下 Whisper 可能超时——优先 `TRANSCRIPT_API_TYPE=none`，或改用更短的音频、`whisper-large-v3-turbo` 模型（已默认）。转录失败会保留 `pending`，下次 cron 会重试。
- **guid 冲突**：`episodes.guid` 唯一；RSS 的 `guid` 相同则跳过，不会重复插入。
- **Supabase 行数上限**：免费层 5000 行，`MAX_KEEP_EPISODES`（默认 30）会自动清理最旧记录。