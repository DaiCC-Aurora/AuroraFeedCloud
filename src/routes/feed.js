'use strict';

const { Router } = require('express');
const { getSupabase } = require('../services/supabaseClient');
const { nowISO } = require('../utils/dateUtils');

const router = Router();

/**
 * GET /api/feed?limit=10
 * 返回最新 limit 条节目，供手表端拉取。字段与手表端约定的 snake_case 一致。
 * 缓存 5 分钟。
 */
router.get('/', async (req, res, next) => {
  try {
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isNaN(rawLimit) ? 10 : Math.min(Math.max(rawLimit, 1), 100);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('episodes')
      .select('*')
      .eq('is_active', true)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const items = (data || []).map((row) => ({
      guid: row.guid,
      title: row.title,
      pub_date: row.published_at,
      audio_url: row.audio_url,
      subtitle_url: row.subtitle_url || null,
      duration_seconds: row.duration_seconds,
      transcript: row.subtitle_text || null,
    }));

    const channel = {
      title: process.env.CHANNEL_TITLE || '英语听力',
      description: process.env.CHANNEL_DESCRIPTION || 'Aurora的英语听力',
      language: 'en',
      update_time: nowISO(),
    };

    res.set('Cache-Control', 'public, max-age=300');
    res.json({ channel, items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;