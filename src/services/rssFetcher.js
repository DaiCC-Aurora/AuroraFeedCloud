'use strict';

const Parser = require('rss-parser');
const { toISOString } = require('../utils/dateUtils');

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': 'podcast-cloud/1.0 (+https://vercel.com)' },
  customFields: {
    item: [
      ['itunes:duration', 'itunesDuration'],
      ['itunes:subtitle', 'itunesSubtitle'],
      ['itunes:summary', 'itunesSummary'],
      ['content:encoded', 'contentEncoded'],
      ['itunes:image', 'itunesImage'],
    ],
  },
});

/**
 * 把 RSS 的 <guid> 或 <link> 归一化为稳定的节目唯一标识。
 * 长 URL 会做简单截断+哈希，避免 guid 超出合理长度。
 */
function normalizeGuid(rawGuid, rawLink) {
  const base = String(rawGuid || rawLink || '').trim();
  if (!base) return null;
  if (base.length <= 255) return base;
  const crypto = require('crypto');
  const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 12);
  return `${base.slice(0, 200)}-${hash}`;
}

/**
 * 解析时长：支持
 *  - "1234"（秒）
 *  - "1234.5"（秒，小数）
 *  - "12:34"（分:秒）
 *  - "1:02:34" / "1:02:34.500"（时:分:秒）
 * 返回整数秒；无法解析返回 0。
 */
function parseDuration(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  // 纯数字 = 秒
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));

  // 冒号分隔
  const parts = s.split(':');
  if (parts.length >= 2 && parts.length <= 3) {
    let total = 0;
    let valid = true;
    for (const p of parts) {
      if (!/^\d+(\.\d+)?$/.test(p)) {
        valid = false;
        break;
      }
      total = total * 60 + parseFloat(p);
    }
    if (valid) return Math.round(total);
  }

  return 0;
}

/**
 * 抓取并解析 RSS Feed。
 * 增加了 XML 清洗逻辑，兼容各种包含未转义 `&` 的不规范 RSS 源。
 * @returns {Promise<{title: string, items: Array<object>}>}
 */
async function fetchFeed(feedUrl) {
  let xmlString;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(feedUrl, {
      headers: { 'User-Agent': 'podcast-cloud/1.0 (+https://vercel.com)' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    xmlString = await response.text();
  } catch (e) {
    throw new Error(`Failed to fetch RSS feed (${feedUrl}): ${e.message}`);
  }

  // 清洗 XML：将未转义的 `&` 替换为 `&amp;`，防止 sax 解析器报 "Invalid character in entity name"
  // 匹配 & 后面不是合法实体（如 &amp; &lt; &gt; &quot; &apos; &#123; &#x1A;）的情况
  xmlString = xmlString.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/gi, '&amp;');

  let feed;
  try {
    feed = await parser.parseString(xmlString);
  } catch (parseError) {
    throw new Error(`RSS XML 解析失败，请检查源格式: ${parseError.message}`);
  }

  const items = (feed.items || [])
    .map((item) => {
      const enclosure = item.enclosure || {};
      const link = item.link || enclosure.url || null;
      const guid = normalizeGuid(item.guid, link);
      if (!guid) return null; // 无标识的条目丢弃

      const description =
        item.contentSnippet ||
        item.contentEncoded ||
        item.itunesSubtitle ||
        item.itunesSummary ||
        item.content ||
        item.description ||
        '';

      const publishedAt = toISOString(item.isoDate || item.pubDate);

      return {
        guid,
        title: (item.title || 'Untitled').trim(),
        description: String(description).trim(),
        published_at: publishedAt || toISOString(new Date()),
        duration_seconds: parseDuration(item.itunesDuration),
        audio_url: enclosure.url || null,
        // RSS 自带字幕/描述，可作为 transcript 兜底（避免调用转录 API）
        transcript:
          (item.itunesSubtitle || item.contentSnippet || item.description || '').trim() || null,
      };
    })
    .filter(Boolean);

  return { title: feed.title || 'Podcast', items };
}

module.exports = { fetchFeed, normalizeGuid, parseDuration };