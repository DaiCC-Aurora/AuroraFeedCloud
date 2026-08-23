'use strict';

/**
 * 字幕生成服务。
 *  - TRANSCRIPT_API_TYPE=cf-whisper：调用 Cloudflare Workers AI Whisper（REST API，免费额度内不产生费用）。
 *  - TRANSCRIPT_API_TYPE=groq：调用 Groq Whisper REST API（multipart）。
 *  - TRANSCRIPT_API_TYPE=none 或缺少对应配置：无实时字幕（不转录）。
 *
 * 注意：
 *  - 部分模型（如 @cf/openai/whisper）只接受 base64 的 audio 字段，不接受 audio_url；
 *    本服务会自动降级：先试 audio_url（免下载），接口返回 400 时下载音频转 base64 重试。
 *  - Vercel 免费计划函数执行时间有限（Hobby 上限 60s），转录内置超时；
 *    超时/失败会保留 pending，下次 cron 自动重试。
 */

const CLOUDFLARE_AI_BASE = 'https://api.cloudflare.com/client/v4/accounts';
const GROQ_TRANSCRIPT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * 判断当前 apiType 是否具备可用的转录配置。
 * 缺配置时上层应跳过转录（条目保持 pending），而不是报错。
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
 * 调用一次 Cloudflare Workers AI 模型接口。
 * @param {object} cfg { accountId, apiToken, model, body, timeoutMs }
 * @returns {Promise<{text: string, vtt: string|null, srt: string|null}>}
 */
async function requestWorkersAI(cfg) {
  const { accountId, apiToken, model, body, timeoutMs } = cfg;

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
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(
          `Cloudflare Workers AI 转录超时（${timeoutMs}ms）：音频过长或服务繁忙，已标记 pending 次日重试`
        );
      }
      throw e;
    }

    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // 免费额度用尽（Free 计划每天 10,000 neurons）：明确提示，避免误判为配置错误
      if (res.status === 429) {
        const err = new Error(
          'Cloudflare Workers AI 免费额度已用完或请求被限流（HTTP 429），已标记 pending；免费额度每日自动重置'
        );
        err.quotaExhausted = true;
        throw err;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Cloudflare Workers AI 鉴权失败（HTTP ${res.status}），请检查 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN`
        );
      }
      // 输入格式不被接受（如该模型只接受 base64 audio、不接受 audio_url）
      if (res.status === 400) {
        const err = new Error(
          `Cloudflare Workers AI 输入不被接受（HTTP 400）：${data ? JSON.stringify(data) : res.statusText}`
        );
        err.badInput = true;
        throw err;
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
 * 调用 Cloudflare Workers AI Whisper 转录音频（自适应输入方式）。
 * 先试 audio_url（部分模型支持，免下载省函数时间）；
 * 若模型只接受 base64 audio（如 @cf/openai/whisper，HTTP 400），
 * 自动下载音频 → base64 重试。
 * @param {string} audioUrl 音频 URL（需公网可访问的 HTTPS 地址）
 * @param {object} cfg { accountId, apiToken, model, timeoutMs }
 * @returns {Promise<{text: string, vtt: string|null, srt: string|null}>}
 */
async function transcribeWithWorkersAI(audioUrl, cfg) {
  const { accountId, apiToken, model } = cfg;
  const timeoutMs = cfg.timeoutMs || 50000;

  try {
    return await requestWorkersAI({
      accountId,
      apiToken,
      model,
      body: { audio_url: audioUrl },
      timeoutMs,
    });
  } catch (e) {
    if (!(e && e.badInput)) throw e;

    // 该模型不接受 audio_url → 下载音频转 base64 重试
    const downloadTimeoutMs = parseInt(process.env.TRANSCRIPT_DOWNLOAD_TIMEOUT_MS || '30000', 10);
    const maxAudioMb = Math.max(parseInt(process.env.TRANSCRIPT_CF_MAX_AUDIO_MB || '24', 10), 1);
    const { buffer } = await downloadAudioBuffer(audioUrl, downloadTimeoutMs);
    if (buffer.length > maxAudioMb * 1024 * 1024) {
      throw new Error(
        `音频文件过大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），` +
          `超过 Cloudflare Workers AI ${maxAudioMb}MB 上限（可用 TRANSCRIPT_CF_MAX_AUDIO_MB 调整），无法转录`
      );
    }
    return await requestWorkersAI({
      accountId,
      apiToken,
      model,
      body: { audio: buffer.toString('base64') },
      timeoutMs,
    });
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
 * @param {string|null} fallback 备用文本（当前不使用：RSS 简介不再当字幕）
 * @returns {Promise<{transcript: string|null, source: 'cf-whisper'|'groq'|'rss'|'none', vtt?: string|null, srt?: string|null}>}
 */
async function generateTranscript(opts, fallback) {
  const apiType = (opts && opts.apiType) || process.env.TRANSCRIPT_API_TYPE || 'none';
  const audioUrl = opts && opts.audioUrl;
  const noTranscript = { transcript: fallback || null, source: fallback ? 'rss' : 'none' };

  // 无音频 URL：无法转录
  if (!audioUrl) return noTranscript;

  // 未配置对应 API Key/Token：跳过转录
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
    // 转录失败不阻断整批：抛给上层标记 pending，下次 cron 重试
    const e = new Error(`字幕生成失败（已标记 pending，下次 cron 自动重试）：${err.message}`);
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
