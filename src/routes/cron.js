'use strict';

const { Router } = require('express');
const { getSupabase } = require('../services/supabaseClient');
const { fetchFeed } = require('../services/rssFetcher');
const { generateTranscript, hasTranscriptConfig } = require('../services/transcriptService');

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
 *   2. 过滤新增条目 + 上次转录失败(pending)的旧条目（重试）
 *   3. 对新条目/待重试条目生成字幕（Cloudflare Workers AI / Groq，失败回退 RSS description）
 *   4. 写入 episodes（新条目 insert，旧条目 update）
 *   5. 清理最旧记录
 */
router.post('/update', async (req, res, next) => {
  const startedAt = Date.now();
  const result = {
    fetched: 0,
    newCount: 0,
    inserted: 0,
    updated: 0,
    retried: 0,
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

    // 2. 过滤新增 + 待重试
    const { data: existing, error: existingErr } = await supabase
      .from('episodes')
      .select('guid, transcription_status, audio_url, subtitle_text, attempts');
    if (existingErr) throw existingErr;
    const rows = existing || [];
    const known = new Set(rows.map((e) => e.guid));
    const newItems = feed.items.filter((i) => i.guid && !known.has(i.guid));
    result.newCount = newItems.length;

    const apiType = process.env.TRANSCRIPT_API_TYPE || 'none';
    const retryLimit = Math.max(parseInt(process.env.TRANSCRIPT_MAX_ATTEMPTS || '3', 10), 0);
    const canTranscribe = apiType !== 'none' && hasTranscriptConfig(apiType);

    // pending 且还有重试次数的旧条目：本轮重新转录
    // （Cloudflare 免费额度每日自动重置，昨日额度用尽导致的 pending 今日可自动恢复）
    const pendingItems = canTranscribe
      ? rows
          .filter(
            (e) =>
              e.transcription_status === 'pending' &&
              e.audio_url &&
              (e.attempts || 0) < retryLimit
          )
          .map((e) => ({
            guid: e.guid,
            isUpdate: true,
            attempts: e.attempts || 0,
            audio_url: e.audio_url,
            transcript: e.subtitle_text || null,
          }))
      : [];
    result.retried = pendingItems.length;

    const workItems = [
      ...newItems.map((i) => ({
        guid: i.guid,
        isUpdate: false,
        audio_url: i.audio_url,
        transcript: i.transcript || null,
        item: i,
      })),
      ...pendingItems,
    ];

    let quotaExhausted = false;

    // 3+4. 逐条处理，单条失败不影响其余
    for (const work of workItems) {
      // 免费额度用尽：跳过待重试条目（不消耗重试次数），新条目仍以 RSS 描述兜底入库
      if (quotaExhausted && work.isUpdate) continue;

      try {
        let transcript = work.transcript || null;
        let status = work.isUpdate ? 'pending' : 'ready';
        let vtt = null;
        let lastError = null;

        if (!quotaExhausted && !transcript && canTranscribe) {
          try {
            const r = await generateTranscript(
              { audioUrl: work.audio_url, apiType },
              transcript
            );
            transcript = r.transcript;
            vtt = r.vtt || null;
            status = r.transcript ? 'ready' : 'pending';
          } catch (err) {
            // 转录失败：保留 pending，下次 cron 重试
            status = 'pending';
            lastError = err.message;
            transcript = err.fallback || null;
            if (err.quotaExhausted) {
              quotaExhausted = true;
              console.warn(
                '[cron] Cloudflare Workers AI 免费额度已用完：本次跳过后续转录，' +
                  '新条目以 RSS 描述兜底，待重试条目明日 cron 自动重试'
              );
            }
          }
        } else if (!transcript) {
          // 无字幕且未配置转录：标记 pending 待后续重试
          status = 'pending';
        }

        if (work.isUpdate) {
          const nextAttempts = work.attempts + 1;
          if (status === 'pending' && nextAttempts >= retryLimit) {
            status = 'failed';
            lastError = lastError || '达到最大重试次数，转录失败';
          }
          const patch = {
            subtitle_text: transcript,
            subtitle_vtt: vtt,
            transcription_status: status,
            transcription_error: lastError,
            attempts: nextAttempts,
          };
          const { error: updErr } = await supabase
            .from('episodes')
            .update(patch)
            .eq('guid', work.guid);
          if (updErr) throw new Error(updErr.message);
          result.updated += 1;
        } else {
          const row = {
            guid: work.guid,
            title: work.item.title,
            description: work.item.description || null,
            published_at: work.item.published_at,
            duration_seconds: work.item.duration_seconds || 0,
            audio_url: work.item.audio_url || '',
            subtitle_text: transcript,
            subtitle_vtt: vtt,
            transcription_status: status,
            transcription_error: lastError,
            attempts: 0,
          };
          const { error: insErr } = await supabase.from('episodes').insert(row);
          if (insErr) throw new Error(insErr.message);
          result.inserted += 1;
        }
      } catch (err) {
        result.failed += 1;
        result.errors.push({ guid: work.guid, error: err.message });
        console.error(`[cron] 处理节目失败 guid=${work.guid}: ${err.message}`);
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
        `inserted=${result.inserted} updated=${result.updated} retried=${result.retried} ` +
        `failed=${result.failed} deleted=${result.deleted} 耗时=${Date.now() - startedAt}ms`
    );

    return res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
