'use strict';

/**
 * 字幕生成服务。
 *  - TRANSCRIPT_API_TYPE=groq：下载音频 -> 调 Groq Whisper REST API（multipart）。
 *  - TRANSCRIPT_API_TYPE=none 或未配置 Key：直接回退使用 RSS description。
 *
 * 注意：Vercel 免费计划函数执行时间有限，且音频下载+转录耗时较长，
 * 因此本函数内置超时；对较慢的场景建议直接用 RSS description 兜底。
 */

const GROQ_TRANSCRIPT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

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
 * @returns {Promise<{transcript: string|null, source: 'groq'|'rss'|'none'}>}
 */
async function generateTranscript(opts, fallback) {
  const apiType = (opts && opts.apiType) || process.env.TRANSCRIPT_API_TYPE || 'none';
  const apiKey = process.env.TRANSCRIPT_API_KEY;
  const audioUrl = opts && opts.audioUrl;

  if (apiType === 'groq' && apiKey && audioUrl) {
    try {
      const transcript = await transcribeWithGroq(audioUrl, apiKey);
      if (transcript) return { transcript, source: 'groq' };
      return { transcript: fallback || null, source: 'rss' };
    } catch (err) {
      // 转录失败不阻断整批：返回 RSS 兜底，并把错误抛出由上层标记
      const e = new Error(`字幕生成失败（已回退 RSS 描述）：${err.message}`);
      e.fallback = fallback || null;
      throw e;
    }
  }

  // none / 未配置 Key：直接使用 RSS 描述
  return { transcript: fallback || null, source: fallback ? 'rss' : 'none' };
}

module.exports = { generateTranscript, transcribeWithGroq, downloadAudioBuffer };