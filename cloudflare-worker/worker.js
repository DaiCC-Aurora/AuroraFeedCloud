// Cloudflare Worker：异步字幕转录（解决 Vercel 免费函数 60s 超时）
//
// 架构：Vercel cron 只做 RSS 同步（秒级）；本 Worker 负责耗时转录
//      （下载音频 → MP3 帧级切分 → Workers AI Whisper 并发转录 → 时间戳合并 → 回写 Supabase）。
//      Workers 的 AI 调用在 Cloudflare 侧执行，Worker 仅等待，不受 60s 限制。
//
// 部署步骤（Cloudflare 控制台）：
//   1. Workers & Pages → Create → Worker → 粘贴本文件全部内容 → Deploy
//   2. Settings → Variables and Secrets → 添加：
//        SUPABASE_URL=你的项目URL
//        SUPABASE_SERVICE_ROLE_KEY=你的 service_role key
//        CRON_SECRET=手动触发用密钥（可选）
//      （可选调参：TRANSCRIPT_CF_MODEL / TRANSCRIPT_CF_CHUNK_SECONDS /
//        TRANSCRIPT_CF_CHUNK_CONCURRENCY / TRANSCRIPT_CF_MAX_AUDIO_MB / TRANSCRIPT_MAX_ATTEMPTS）
//   3. Settings → Variables → 添加 "Workers AI" 绑定，变量名 AI
//   4. Triggers → Cron Triggers → 添加（如每小时：* * * *）
//   5. 手动触发：curl -X POST https://<你的worker>.workers.dev/run -H "x-cron-secret: <CRON_SECRET>"
//
// 注意：RSS 简介 description 只是节目简介，不是字幕；只有 Whisper 转录结果（含 VTT 时间轴）才算字幕。

const DEFAULT_MODEL = '@cf/openai/whisper';
const DEFAULT_MAX_AUDIO_MB = 24;
const DEFAULT_CHUNK_SECONDS = 600;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 3;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export default {
  async scheduled(event, env) {
    const summary = await runTranscription(env);
    console.log('[transcriber] scheduled 完成：' + JSON.stringify(summary));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const secret = env.CRON_SECRET;
      if (secret && request.headers.get('x-cron-secret') !== secret) {
        return new Response(JSON.stringify({ error: 'Unauthorized: 无效的 CRON_SECRET' }), { status: 401, headers: JSON_HEADERS });
      }
      const summary = await runTranscription(env);
      return new Response(JSON.stringify(summary), { status: 200, headers: JSON_HEADERS });
    }
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, time: new Date().toISOString() }), { status: 200, headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: JSON_HEADERS });
  },
};

// ================= 主流程 =================

async function runTranscription(env) {
  const summary = {
    checked: 0,
    transcribed: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
    quotaExhausted: false,
    errors: [],
  };
  try {
    const episodes = await fetchPendingEpisodes(env);
    summary.checked = episodes.length;
    const maxAttempts = parseInt(env.TRANSCRIPT_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10) || DEFAULT_MAX_ATTEMPTS;

    for (const ep of episodes) {
      if (summary.quotaExhausted) break;
      const nextAttempts = (ep.attempts || 0) + 1;
      try {
        if (!ep.audio_url) {
          summary.skipped += 1;
          await patchEpisode(env, ep.guid, {
            transcription_status: 'failed',
            transcription_error: '无音频 URL',
            attempts: nextAttempts,
          });
          continue;
        }
        const r = await transcribeAudio(env, ep.audio_url);
        summary.transcribed += 1;
        await patchEpisode(env, ep.guid, {
          subtitle_text: r.text,
          subtitle_vtt: r.vtt,
          transcription_status: 'ready',
          transcription_error: null,
          attempts: nextAttempts,
        });
        summary.updated += 1;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if ((e && e.quotaExhausted) || /429|quota|免费额度|insufficient/i.test(msg)) {
          summary.quotaExhausted = true;
          summary.errors.push({ guid: ep.guid, error: 'Workers AI 免费额度已用完或请求被限流（429），本次停止，次日自动重试' });
          break;
        }
        const status = nextAttempts >= maxAttempts ? 'failed' : 'pending';
        await patchEpisode(env, ep.guid, {
          transcription_status: status,
          transcription_error: msg.slice(0, 500),
          attempts: nextAttempts,
        });
        summary.failed += 1;
        summary.errors.push({ guid: ep.guid, error: msg.slice(0, 200) });
      }
    }
  } catch (e) {
    summary.errors.push({ error: String((e && e.message) || e) });
  }
  return summary;
}

// ================= 转录 =================

async function transcribeAudio(env, audioUrl) {
  const model = env.TRANSCRIPT_CF_MODEL || DEFAULT_MODEL;
  const maxAudioMb = parseInt(env.TRANSCRIPT_CF_MAX_AUDIO_MB || String(DEFAULT_MAX_AUDIO_MB), 10) || DEFAULT_MAX_AUDIO_MB;
  const maxBytes = maxAudioMb * 1024 * 1024;

  const res = await fetch(audioUrl, { headers: { 'User-Agent': 'cloudflare-worker-transcriber/1.0' } });
  if (!res.ok) throw new Error(`下载音频失败：HTTP ${res.status} ${res.statusText}`);
  const audio = new Uint8Array(await res.arrayBuffer());

  // 未超上限：单次转录
  if (audio.length <= maxBytes) {
    const r = await aiRun(env, model, { audio: toBase64(audio) });
    return { text: String((r && r.text) || '').trim(), vtt: (r && r.vtt) || null };
  }

  // 超过上限：帧级切分 + 并发转录 + 时间戳偏移合并
  const chunkSeconds = parseInt(env.TRANSCRIPT_CF_CHUNK_SECONDS || String(DEFAULT_CHUNK_SECONDS), 10) || DEFAULT_CHUNK_SECONDS;
  const concurrency = parseInt(env.TRANSCRIPT_CF_CHUNK_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY;
  const chunks = chunkAudio(audio, chunkSeconds, maxBytes);
  if (chunks.length === 0) throw new Error('音频无法解析为 MP3 帧流且超过大小上限，无法分段转录');

  const results = await mapConcurrency(chunks, concurrency, async (c) => {
    const r = await aiRun(env, model, { audio: toBase64(c.buffer) });
    return { text: String((r && r.text) || '').trim(), vtt: (r && r.vtt) || null, startMs: c.startMs };
  });

  const texts = results.map((r) => r.text).filter(Boolean);
  const vttParts = results.filter((r) => r.vtt).map((r) => offsetVtt(r.vtt, r.startMs));
  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('分段转录结果为空');
  const vtt = vttParts.length > 0
    ? `WEBVTT\n\n${vttParts.join('\n\n').replace(/^WEBVTT\s*\r?\n?/i, '')}`
    : null;
  return { text, vtt };
}

async function aiRun(env, model, inputs) {
  let result;
  try {
    result = await env.AI.run(model, inputs);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/429|quota|rate limit|insufficient/i.test(msg)) {
      const err = new Error('Workers AI 免费额度已用完或请求被限流（HTTP 429）');
      err.quotaExhausted = true;
      throw err;
    }
    throw e;
  }
  return result || {};
}

// ================= Supabase REST =================

async function supabaseFetch(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量');
  }
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body,
  });
  if (!res.ok) {
    throw new Error(`Supabase ${options.method || 'GET'} ${path} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res;
}

/** 取最近 50 条需要转录的：pending，或 ready 但没有 VTT（老数据补录）。 */
async function fetchPendingEpisodes(env) {
  const res = await supabaseFetch(
    env,
    '/rest/v1/episodes?select=guid,audio_url,transcription_status,subtitle_vtt,attempts&order=published_at.desc&limit=50'
  );
  const rows = await res.json();
  const maxAttempts = parseInt(env.TRANSCRIPT_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10) || DEFAULT_MAX_ATTEMPTS;
  return (Array.isArray(rows) ? rows : []).filter(
    (e) =>
      e.audio_url &&
      (e.attempts || 0) < maxAttempts &&
      (e.transcription_status === 'pending' || (e.transcription_status === 'ready' && !e.subtitle_vtt))
  );
}

async function patchEpisode(env, guid, patch) {
  await supabaseFetch(env, `/rest/v1/episodes?guid=eq.${encodeURIComponent(guid)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// ================= 工具 =================

async function mapConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}

/** Uint8Array -> base64（分块拼字符串，避免超长 apply）。 */
export function toBase64(bytes) {
  const parts = [];
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + STEP, bytes.length))));
  }
  return btoa(parts.join(''));
}

// ================= MP3 帧级切分（与 podcast-cloud/src/services/mp3Chunker.js 逻辑一致） =================

// 比特率表（kbps），列：V1L1 V1L2 V1L3 V2L1 V2L2 V2L3
const BITRATE_TABLE = [
  [0, 0, 0, 0, 0, 0],
  [32, 32, 32, 32, 8, 8],
  [64, 48, 40, 48, 16, 16],
  [96, 56, 48, 56, 24, 24],
  [128, 64, 56, 64, 32, 32],
  [160, 80, 64, 80, 40, 40],
  [192, 96, 80, 96, 48, 48],
  [224, 112, 96, 112, 56, 56],
  [256, 128, 112, 128, 64, 64],
  [288, 160, 128, 144, 80, 80],
  [320, 192, 160, 160, 96, 96],
  [352, 224, 192, 176, 112, 112],
  [384, 256, 224, 192, 128, 128],
  [416, 320, 256, 224, 144, 144],
  [448, 384, 320, 256, 160, 160],
];

// 采样率表：行 = [V1, V2, V2.5]，列 = 采样率索引
const SAMPLE_RATE_TABLE = [
  [44100, 48000, 32000],
  [22050, 24000, 16000],
  [11025, 12000, 8000],
];

/** 解析 offset 处的 MPEG 帧头；合法返回帧信息，否则 null。 */
export function parseFrameHeader(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const verBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  if (verBits === 1 || layerBits === 0) return null;

  const b2 = buf[offset + 2];
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;

  const verIdx = verBits === 3 ? 0 : verBits === 2 ? 1 : 2;
  const sampleRate = SAMPLE_RATE_TABLE[verIdx][srIdx];
  const col = verBits === 3 ? (layerBits === 3 ? 0 : layerBits === 2 ? 1 : 2) : layerBits === 3 ? 3 : 4;
  const bitrateKbps = BITRATE_TABLE[brIdx][col];
  if (!bitrateKbps) return null;

  let samplesPerFrame;
  if (layerBits === 3) samplesPerFrame = 384;
  else if (layerBits === 2) samplesPerFrame = 1152;
  else samplesPerFrame = verBits === 3 ? 1152 : 576;

  const bps = bitrateKbps * 1000;
  let frameLength;
  if (layerBits === 3) {
    frameLength = Math.floor((12 * bps) / sampleRate + padding) * 4;
  } else if (layerBits === 2) {
    frameLength = Math.floor((144 * bps) / sampleRate) + padding;
  } else {
    frameLength = Math.floor(((samplesPerFrame / 8) * bps) / sampleRate) + padding;
  }
  return { bitrateKbps, sampleRate, frameLength, samplesPerFrame };
}

/** 跳过 ID3v2 标签头（若有），返回音频数据起始偏移。 */
function id3SkipSize(buf) {
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    let off = 10 + size;
    if ((buf[5] & 0x10) !== 0) off += 10;
    return off;
  }
  return 0;
}

/** 在 [from, to) 范围内查找下一个合法帧头；找不到返回 -1。 */
function findNextSync(buf, from, to) {
  const end = Math.min(to, buf.length - 4);
  for (let i = from; i <= end; i++) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const h = parseFrameHeader(buf, i);
      if (h && i + h.frameLength <= buf.length + 512) return i;
    }
  }
  return -1;
}

/** 按目标时长切分 MP3（帧边界对齐），返回 [{buffer, startMs}]。 */
export function chunkAudio(buf, targetSeconds, maxBytes) {
  const first = findNextSync(buf, id3SkipSize(buf), buf.length);
  if (first < 0) throw new Error('无法解析为 MP3 帧流（找不到帧头）');

  const chunks = [];
  const targetMs = Math.max(targetSeconds, 1) * 1000;
  let segStart = first;
  let segStartMs = 0;
  let offset = first;
  let timeMs = 0;

  while (offset < buf.length - 3) {
    const h = parseFrameHeader(buf, offset);
    if (!h) {
      const next = findNextSync(buf, offset + 1, buf.length);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const frameMs = (h.samplesPerFrame / h.sampleRate) * 1000;
    if (timeMs - segStartMs >= targetMs || offset - segStart >= maxBytes) {
      if (offset - segStart > 0) {
        chunks.push({ buffer: buf.subarray(segStart, offset), startMs: Math.round(segStartMs) });
      }
      segStart = offset;
      segStartMs = timeMs;
    }
    timeMs += frameMs;
    offset += h.frameLength;
  }
  if (offset - segStart > 0) {
    chunks.push({ buffer: buf.subarray(segStart, offset), startMs: Math.round(segStartMs) });
  }
  return chunks;
}

const VTT_TIME_REGEX = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;

function tcToMs(tc) {
  const parts = tc.trim().replace(',', '.').split(':');
  let total = 0;
  for (const p of parts) total = total * 60 + parseFloat(p);
  return Math.round(total * 1000);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 把 VTT 所有时间戳整体偏移 offsetMs。 */
export function offsetVtt(vtt, offsetMs) {
  if (!vtt) return vtt;
  return vtt
    .split(/\r?\n/)
    .map((line) => {
      const m = VTT_TIME_REGEX.exec(line);
      if (!m) return line;
      const total = Math.round(tcToMs(m[1]) + offsetMs);
      const end = Math.round(tcToMs(m[2]) + offsetMs);
      const fmt = (t) => {
        const h = Math.floor(t / 3600000);
        const mm = Math.floor((t % 3600000) / 60000);
        const s = Math.floor((t % 60000) / 1000);
        const f = t % 1000;
        return `${pad2(h)}:${pad2(mm)}:${pad2(s)}.${String(f).padStart(3, '0')}`;
      };
      return `${fmt(total)} --> ${fmt(end)}`;
    })
    .join('\n');
}
