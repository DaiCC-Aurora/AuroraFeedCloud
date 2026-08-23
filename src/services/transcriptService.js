'use strict';

/**
 * 字幕生成服务。
 *  - TRANSCRIPT_API_TYPE=cf-whisper：调用 Cloudflare Workers AI Whisper（REST API，免费额度内不产生费用）。
 *  - TRANSCRIPT_API_TYPE=groq：调用 Groq Whisper REST API（multipart）。
 *  - TRANSCRIPT_API_TYPE=none 或缺少对应配置：直接回退使用 RSS description。
 *
 * 注意：Vercel 免费计划函数执行时间有限（Hobby 上限 60s），
 * 因此转录内置超时；超时/失败会回退 RSS description，并在下次 cron 重试。
 */

const CLOUDFLARE_AI_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const GROQ_TRANSCRIPT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * 判断当前 apiType 是否具备可用的转录配置。
 * 缺配置时上层应静默回退 RSS description，而不是报错。
 * @param {string} apiType
 * @returns {boolean}
 */
function hasTranscriptConfig(apiType) {
  if (apiType === 'cf-whisper') {
    return !!(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
  }
  if (apiType === 'groq') {
    return !!process.env.TRANSCRIPT_API_KEY;
  }
  return false;
}

async function downloadAudioBuffer(audioUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(audioUrl, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`下载音频失败：HTTP ${res.status} ${res.statusText}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'audio/mpeg';
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 Cloudflare Workers AI Whisper 转录音频。
 * 直接传 audio_url，由 Cloudflare 侧下载音频，无需在 Vercel 侧下载（省函数时间与流量）。
 * @param {string} audioUrl 音频 URL（需公网可访问的 HTTPS 地址）
 * @param {object} cfg { accountId, apiToken, model, timeoutMs }
 * @returns {Promise<{text: string, vtt: string|null, srt: string|null}>}
 */
async function transcribeWithWorkersAI(audioUrl, cfg) {
  const accountId = cfg.accountId;
  const apiToken = cfg.apiToken;
  const model = cfg.model || '@cf/openai/whisper';
  const timeoutMs = cfg.timeoutMs || 50000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(
        `${CLOUDFLARE_AI_BASE}/${encodeURIComponent(accountId)}/ai/run/${model}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ audio_url: audioUrl }),
          signal: controller.signal,
        }
      );
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(
          `Cloudflare Workers AI 转录超时（${timeoutMs}ms）：音频过长或服务繁忙，已回退 RSS 描述`
        );
      }
      throw e;
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // 免费额度用尽（Free 计划每天 10,000 neurons）：明确提示，避免误判为配置错误
      if (res.status === 429) {
        const err = new Error(
          'Cloudflare Workers AI 免费额度已用完或请求被限流（HTTP 429），已回退 RSS 描述；免费额度每日自动重置'
        );
        err.quotaExhausted = true;
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Cloudflare Workers AI 鉴权失败（HTTP ${res.status}），请检查 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN`
        );
      }
      throw new Error(
        `Cloudflare Workers AI 转录失败：HTTP ${res.status} ${data ? JSON.stringify(data) : res.statusText}`
      );
    }

    const result = (data && data.result) || {};
    const text = String(result.text || '').trim();
    if (!text) {
      throw new Error('Cloudflare Workers AI 返回空转录文本');
    }
    return {
      text,
      vtt: result.vtt || null,
      srt: result.srt || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用 Groq Whisper 转录音频。
 * @param {string} audioUrl 音频 URL
 * @param {string} apiKey   Groq API Key
 * @returns {Promise<string>} 转录文本
 */
async function transcribeWithGroq(audioUrl, apiKey) {
  const downloadTimeout = parseInt(process.env.TRANSCRIPT_DOWNLOAD_TIMEOUT_MS || '30000', 10);
  const { buffer, contentType } = await downloadAudioBuffer(audioUrl, downloadTimeout);

  // 从 content-type 推文件名扩展名（可选，仅影响 multipart 元数据）
  const ext = contentType.includes('mpeg') || contentType.includes('mp3')
    ? 'mp3'
    : contentType.includes('aac')
      ? 'aac'
      : contentType.includes('wav')
        ? 'wav'
        : 'mp3';
  const filename = `audio.${ext}`;

  const form = new FormData();
  // Node 18+ 全局 Blob 可直接用于 FormData
  form.append('file', new Blob([buffer], { type: contentType }), filename);
  form.append('model', process.env.TRANSCRIPT_GROQ_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('language', 'en');

  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.TRANSCRIPT_API_TIMEOUT_MS || '50000', 10);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ_TRANSCRIPT_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Groq 转录失败：HTTP ${res.status} - ${JSON.stringify(data)}`);
    }
    return (data.text || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 生成字幕（主入口）。
 * @param {object} opts { audioUrl, apiType }
 * @param {string|null} fallback RSS 自带描述文本
 * @returns {Promise<{transcript: string|null, source: 'cf-whisper'|'groq'|'rss'|'none', vtt?: string|null, srt?: string|null}>}
 */
async function generateTranscript(opts, fallback) {
  const apiType = (opts && opts.apiType) || process.env.TRANSCRIPT_API_TYPE || 'none';
  const audioUrl = opts && opts.audioUrl;
  const noTranscript = { transcript: fallback || null, source: fallback ? 'rss' : 'none' };

  // 无音频 URL：无法转录，直接回退
  if (!audioUrl) return noTranscript;

  // 未配置对应 API Key/Token：回退
  if (!hasTranscriptConfig(apiType)) return noTranscript;

  try {
    if (apiType === 'cf-whisper') {
      const r = await transcribeWithWorkersAI(audioUrl, {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        model: process.env.TRANSCRIPT_CF_MODEL || '@cf/openai/whisper',
        timeoutMs: parseInt(process.env.TRANSCRIPT_API_TIMEOUT_MS || '50000', 10),
      });
      if (r.text) return { transcript: r.text, source: 'cf-whisper', vtt: r.vtt, srt: r.srt };
      return noTranscript;
    }

    if (apiType === 'groq') {
      const transcript = await transcribeWithGroq(audioUrl, process.env.TRANSCRIPT_API_KEY);
      if (transcript) return { transcript, source: 'groq' };
      return noTranscript;
    }
  } catch (err) {
    // 转录失败不阻断整批：返回 RSS 兜底，并把错误抛出由上层标记 pending 重试
    const e = new Error(`字幕生成失败（已回退 RSS 描述）：${err.message}`);
    e.fallback = fallback || null;
    e.quotaExhausted = !!err.quotaExhausted;
    throw e;
  }

  return noTranscript;
}

module.exports = {
  generateTranscript,
  transcribeWithWorkersAI,
  transcribeWithGroq,
  downloadAudioBuffer,
  hasTranscriptConfig,
};
