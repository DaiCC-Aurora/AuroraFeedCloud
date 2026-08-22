'use strict';

const { Router } = require('express');
const { getSupabase } = require('../services/supabaseClient');
const { fetchFeed } = require('../services/rssFetcher');
const { generateTranscript } = require('../services/transcriptService');

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
 * 由 Vercel Cron（或 cron-job.org）调用。流程：
 *   1. 抓取 RSS
 *   2. 过滤已存在的 guid
 *   3. 对新条目生成字幕（groq 或 RSS description 兜底）
 *   4. 写入 episodes
 *   5. 清理最旧记录
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

    // 2. 过滤新增
    const { data: existing, error: existingErr } = await supabase
      .from('episodes')
      .select('guid');
    if (existingErr) throw existingErr;
    const known = new Set((existing || []).map((e) => e.guid));
    const newItems = feed.items.filter((i) => i.guid && !known.has(i.guid));
    result.newCount = newItems.length;

    const apiType = process.env.TRANSCRIPT_API_TYPE || 'none';

    // 3+4. 逐条处理，单条失败不影响其余
    for (const item of newItems) {
      try {
        let transcript = item.transcript || null;
        let status = 'ready';

        if (!transcript && apiType !== 'none' && process.env.TRANSCRIPT_API_KEY) {
          try {
            const r = await generateTranscript(
              { audioUrl: item.audio_url, apiType },
              item.transcript
            );
            transcript = r.transcript;
            status = r.transcript ? 'ready' : 'pending';
          } catch (err) {
            // 转录失败：保留 pending，下次 cron 重试
            status = 'pending';
            transcript = err.fallback || null;
          }
        } else if (!transcript) {
          // 无字幕且未配置 API：标记 pending 待后续重试
          status = 'pending';
        }

        const row = {
          guid: item.guid,
          title: item.title,
          description: item.description || null,
          published_at: item.published_at,
          duration_seconds: item.duration_seconds || 0,
          audio_url: item.audio_url || '',
          subtitle_text: transcript,
          transcription_status: status,
        };

        const { error: insErr } = await supabase.from('episodes').insert(row);
        if (insErr) throw new Error(insErr.message);
        result.inserted += 1;
      } catch (err) {
        result.failed += 1;
        result.errors.push({ guid: item.guid, error: err.message });
        console.error(`[cron] 处理节目失败 guid=${item.guid}: ${err.message}`);
      }
    }

    // 5. 清理旧数据
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
        `耗时=${Date.now() - startedAt}ms`
    );

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;