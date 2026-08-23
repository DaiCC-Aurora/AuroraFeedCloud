'use strict';

/**
 * Cloudflare Workers AI 转录路径的本地单测（不联网，mock fetch）。
 * 运行：node test-cf-whisper.js
 */

const assert = require('assert');
const svc = require('./src/services/transcriptService');

let tests = 0;
function ok(name) {
  tests += 1;
  console.log(`  ✓ ${name}`);
}

(async () => {
  // ---------- 1. transcribeWithWorkersAI 成功（含 vtt/srt） ----------
  {
    global.fetch = async (url, opts) => {
      assert.strictEqual(url, 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/openai/whisper');
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.headers.Authorization, 'Bearer tok123');
      assert.strictEqual(JSON.parse(opts.body).audio_url, 'https://cdn.example.com/ep.mp3');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            text: 'Hello world.',
            word_count: 2,
            vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello world.',
            srt: '1\n00:00:00,000 --> 00:00:01,000\nHello world.',
          },
        }),
      };
    };
    const r = await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
      accountId: 'acc123',
      apiToken: 'tok123',
      model: '@cf/openai/whisper',
      timeoutMs: 5000,
    });
    assert.strictEqual(r.text, 'Hello world.');
    assert.ok(r.vtt.includes('WEBVTT'));
    assert.ok(r.srt.includes('00:00:00,000'));
    ok('成功：正确调用 REST 端点并解析 text/vtt/srt');
  }

  // ---------- 2. HTTP 429 → quotaExhausted ----------
  {
    global.fetch = async () => ({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ errors: [{ code: 10002, message: 'Daily usage limit exceeded' }] }),
    });
    let caught = null;
    try {
      await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
        accountId: 'acc123', apiToken: 'tok123', timeoutMs: 5000,
      });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, '应当抛错');
    assert.strictEqual(caught.quotaExhausted, true);
    assert.ok(caught.message.includes('免费额度'));
    ok('429：标记 quotaExhausted（免费额度用尽）');
  }

  // ---------- 3. HTTP 401/403 → 鉴权错误 ----------
  {
    global.fetch = async () => ({
      ok: false, status: 403, statusText: 'Forbidden', json: async () => null,
    });
    let msg = '';
    try {
      await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
        accountId: 'acc123', apiToken: 'bad', timeoutMs: 5000,
      });
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg.includes('鉴权失败'), msg);
    ok('403：提示检查 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
  }

  // ---------- 4. 超时（AbortError） ----------
  {
    global.fetch = (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    let msg = '';
    try {
      await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
        accountId: 'acc123', apiToken: 'tok123', timeoutMs: 80,
      });
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg.includes('转录超时'), msg);
    ok('超时：AbortError 转为明确的超时提示');
  }

  // ---------- 5. 空转录文本 → 报错 ----------
  {
    global.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ success: true, result: { text: '   ' } }),
    });
    let msg = '';
    try {
      await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
        accountId: 'acc123', apiToken: 'tok123', timeoutMs: 5000,
      });
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg.includes('空转录文本'), msg);
    ok('空文本：明确报错而非静默');
  }

  // ---------- 6. generateTranscript 缺 CF 配置 → 回退 RSS，不联网 ----------
  {
    const old = { ...process.env };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.TRANSCRIPT_API_TYPE = 'cf-whisper';
    const r = await svc.generateTranscript(
      { audioUrl: 'https://cdn.example.com/ep.mp3', apiType: 'cf-whisper' },
      'RSS 描述兜底'
    );
    assert.strictEqual(r.transcript, 'RSS 描述兜底');
    assert.strictEqual(r.source, 'rss');
    Object.assign(process.env, old);
    ok('缺 CF 配置：静默回退 RSS 描述');
  }

  // ---------- 7. generateTranscript cf-whisper 成功（含 vtt 透传） ----------
  {
    const old = { ...process.env };
    process.env.TRANSCRIPT_API_TYPE = 'cf-whisper';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acc123';
    process.env.CLOUDFLARE_API_TOKEN = 'tok123';
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { text: 'Subtitle text.' } }),
    });
    const r = await svc.generateTranscript(
      { audioUrl: 'https://cdn.example.com/ep.mp3', apiType: 'cf-whisper' },
      'RSS 描述兜底'
    );
    assert.strictEqual(r.transcript, 'Subtitle text.');
    assert.strictEqual(r.source, 'cf-whisper');
    Object.assign(process.env, old);
    ok('cf-whisper：成功转录并返回 source=cf-whisper');
  }

  // ---------- 8. generateTranscript 429 → err.fallback + quotaExhausted ----------
  {
    const old = { ...process.env };
    process.env.TRANSCRIPT_API_TYPE = 'cf-whisper';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acc123';
    process.env.CLOUDFLARE_API_TOKEN = 'tok123';
    global.fetch = async () => ({
      ok: false, status: 429, statusText: 'Too Many Requests', json: async () => null,
    });
    let caught = null;
    try {
      await svc.generateTranscript(
        { audioUrl: 'https://cdn.example.com/ep.mp3', apiType: 'cf-whisper' },
        'RSS 描述兜底'
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, '应当抛错');
    assert.strictEqual(caught.fallback, 'RSS 描述兜底');
    assert.strictEqual(caught.quotaExhausted, true);
    Object.assign(process.env, old);
    ok('429 透传：fallback + quotaExhausted 供 cron 标记 pending/跳过');
  }

  console.log(`\n全部通过（${tests} 项）`);
})().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});
