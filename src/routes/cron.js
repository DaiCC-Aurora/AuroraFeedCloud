'use strict';

const { Router } = require('express');
const { getSupabase } = require('../services/supabaseClient');
const { fetchFeed } = require('../services/rssFetcher');

const router = Router();

/** 校验 CRON_SECRET（未配置时放行以便本地开发）。 */
function authorize(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const provided =
    req.headers['x-cron-secret'] ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === secret;
}

/** 删除超过保留条数的最旧记录，返回删除条数。 */
async function cleanupOldEpisodes(supabase, keepCount) {
  const { data, error } = await supabase
    .from('episodes')
    .select('guid')
    .order('published_at', { ascending: false })
    .range(keepCount, 100000);

  if (error) throw error;
  const toDelete = (data || []).map((r) => r.guid);
  if (toDelete.length === 0) return 0;

  const { error: delErr } = await supabase.from('episodes').delete().in('guid', toDelete);
  if (delErr) throw delErr;
  return toDelete.length;
}

/**
 * POST /api/cron/update
 * 只做轻量 RSS 同步（必须在 Vercel 免费函数 60s 内完成）：
 *   1. 抓取 RSS
 *   2. 新增条目入库（transcription_status=pending，等转录）
 *   3. 清理最旧记录
 *
 * 字幕转录由 Cloudflare Worker 异步完成（不受 60s 限制），
 * 见 cloudflare-worker/worker.js：Worker 定期/手动拉取 pending 条目，
 * 下载音频 → 帧级切分 → Workers AI Whisper 转录 → 回写 subtitle_text/subtitle_vtt。
 */
router.post('/update', async (req, res, next) => {
  const startedAt = Date.now();
  const result = {
    fetched: 0,
    newCount: 0,
    inserted: 0,
    failed: 0,
    deleted: 0,
    errors: [],
  };

  try {
    if (!authorize(req)) {
      return res.status(401).json({ error: 'Unauthorized: 无效的 CRON_SECRET' });
    }

    const rssUrl = process.env.RSS_FEED_URL;
    if (!rssUrl) {
      throw new Error('缺少环境变量 RSS_FEED_URL');
    }

    const supabase = getSupabase();

    // 1. 抓取 RSS
    const feed = await fetchFeed(rssUrl);
    result.fetched = feed.items.length;

    // 2. 过滤新增（guid 已存在则跳过）
    const { data: existing, error: existingErr } = await supabase
      .from('episodes')
      .select('guid');
    if (existingErr) throw existingErr;
    const known = new Set((existing || []).map((e) => e.guid));
    const newItems = feed.items.filter((i) => i.guid && !known.has(i.guid));
    result.newCount = newItems.length;

    // 3. 新增条目入库（pending，由 Cloudflare Worker 转录）
    for (const item of newItems) {
      try {
        const row = {
          guid: item.guid,
          title: item.title,
          description: item.description || null,
          published_at: item.published_at,
          duration_seconds: item.duration_seconds || 0,
          audio_url: item.audio_url || '',
          subtitle_text: null,
          subtitle_vtt: null,
          transcription_status: 'pending',
          transcription_error: null,
          attempts: 0,
        };
        const { error: insErr } = await supabase.from('episodes').insert(row);
        if (insErr) throw new Error(insErr.message);
        result.inserted += 1;
      } catch (err) {
        result.failed += 1;
        result.errors.push({ guid: item.guid, error: err.message });
        console.error(`[cron] 插入节目失败 guid=${item.guid}: ${err.message}`);
      }
    }

    // 4. 清理旧数据
    const keep = parseInt(process.env.MAX_KEEP_EPISODES || '30', 10);
    try {
      result.deleted = await cleanupOldEpisodes(supabase, keep);
    } catch (err) {
      result.errors.push({ stage: 'cleanup', error: err.message });
      console.error(`[cron] 清理旧数据失败: ${err.message}`);
    }

    console.log(
      `[cron] 完成：fetched=${result.fetched} new=${result.newCount} ` +
        `inserted=${result.inserted} failed=${result.failed} deleted=${result.deleted} ` +
        `耗时=${Date.now() - startedAt}ms（转录由 Cloudflare Worker 异步处理）`
    );

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
