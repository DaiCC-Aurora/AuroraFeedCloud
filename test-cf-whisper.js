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

/** 返回字符串的精确字节（mock 下载音频用，避免 Buffer.buffer 带多余空间）。 */
function exactBytes(str) {
  const b = Buffer.from(str);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

(async () => {
  // ---------- 1. audio_url 直接成功（含 vtt/srt） ----------
  {
    let body1 = null;
    global.fetch = async (url, opts) => {
      assert.strictEqual(url, 'https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/openai/whisper');
      assert.strictEqual(opts.method, 'POST');
      assert.strictEqual(opts.headers.Authorization, 'Bearer tok123');
      body1 = JSON.parse(opts.body);
      assert.strictEqual(body1.audio_url, 'https://cdn.example.com/ep.mp3');
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
    ok('成功：audio_url 直传并解析 text/vtt/srt');
  }

  // ---------- 2. audio_url 400 → 自动降级 base64 audio 重试 ----------
  {
    const calls = [];
    global.fetch = async (url, opts) => {
      if (url.includes('/ai/run/')) {
        calls.push(JSON.parse(opts.body));
        if (calls.length === 1) {
          // 第一次（audio_url）返回 400 Bad input
          return {
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
              errors: [{ message: "AiError: Bad input: ... required properties at '/' are 'audio'", code: 5006 }],
            }),
          };
        }
        // 第二次（base64 audio）成功
        assert.ok(!('audio_url' in calls[1]), '第二次不应再带 audio_url');
        assert.ok(typeof calls[1].audio === 'string' && calls[1].audio.length > 0, '应带 base64 audio');
        assert.strictEqual(Buffer.from(calls[1].audio, 'base64').toString('utf8'), 'fake-mp3-bytes');
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { text: 'Transcribed via base64.', vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nTranscribed via base64.' } }),
        };
      }
      // 音频下载请求：返回小音频
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => exactBytes('fake-mp3-bytes'),
      };
    };
    const r = await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
      accountId: 'acc123', apiToken: 'tok123', timeoutMs: 5000,
    });
    assert.strictEqual(r.text, 'Transcribed via base64.');
    assert.strictEqual(calls.length, 2);
    ok('降级：audio_url 400 → 自动下载音频并 base64 重试成功');
  }

  // ---------- 3. base64 也 400（如音频格式不支持）→ 透出错误 ----------
  {
    global.fetch = async (url, opts) => {
      if (url.includes('/ai/run/')) {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          json: async () => ({ errors: [{ message: 'Bad input again', code: 5006 }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => exactBytes('fake-mp3-bytes'),
      };
    };
    let msg = '';
    try {
      await svc.transcribeWithWorkersAI('https://cdn.example.com/ep.mp3', {
        accountId: 'acc123', apiToken: 'tok123', timeoutMs: 5000,
      });
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg.includes('HTTP 400'), msg);
    ok('base64 也 400：错误信息透出（含服务端详情）');
  }

  // ---------- 4. 超过大小上限：MP3 自动分段转录并合并 ----------
  {
    // 生成 CBR MP3：V1 L3 128kbps/44.1kHz（帧长 417B，帧时长 ≈26.122ms）
    const frameLength = 417;
    const frameCount = 2515; // ≈65.7s，约 1.05MB
    const mp3 = Buffer.alloc(frameCount * frameLength);
    for (let i = 0; i < frameCount; i++) {
      const off = i * frameLength;
      mp3[off] = 0xff;
      mp3[off + 1] = 0xfb;
      mp3[off + 2] = 9 << 4; // 128kbps, 44.1kHz
      mp3[off + 3] = 0x00;
    }

    const old = { ...process.env };
    process.env.TRANSCRIPT_CF_MAX_AUDIO_MB = '1'; // 强制走分段路径
    process.env.TRANSCRIPT_CF_CHUNK_SECONDS = '30';
    process.env.TRANSCRIPT_CF_CHUNK_CONCURRENCY = '3';

    let aiCalls = 0;
    global.fetch = async (url, opts) => {
      if (url.includes('/ai/run/')) {
        aiCalls += 1;
        if (aiCalls === 1) {
          // 第一次：audio_url → 400
          return {
            ok: false, status: 400, statusText: 'Bad Request',
            json: async () => ({ errors: [{ message: "required properties at '/' are 'audio'", code: 5006 }] }),
          };
        }
        const idx = aiCalls - 2; // 第 2..N 次为各分段
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: {
              text: `chunk ${idx}`,
              vtt: `WEBVTT\n\n00:00.000 --> 00:01.000\nchunk ${idx}`,
            },
          }),
        };
      }
      // 音频下载：返回 >1MB 的 MP3
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength),
      };
    };

    const r = await svc.transcribeWithWorkersAI('https://cdn.example.com/big.mp3', {
      accountId: 'acc123', apiToken: 'tok123', timeoutMs: 5000,
    });
    assert.ok(aiCalls >= 3, `应至少 3 次 AI 调用（audio_url + 分段），实际 ${aiCalls}`);
    assert.ok(r.text.includes('chunk 0'), r.text);
    assert.ok(r.text.includes(`chunk ${aiCalls - 2}`), r.text);
    assert.ok(r.vtt.startsWith('WEBVTT'), r.vtt);
    // 校验分段时间戳偏移递增（第二段约 +30s）
    const starts = [...r.vtt.matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3}) -->/g)].map((m) => {
      const p = m[1].split(':');
      return +p[0] * 3600000 + +p[1] * 60000 + +p[2] * 1000;
    });
    assert.ok(starts.length >= 3, `VTT 应有 3+ 条时间轴，实际 ${starts.length}`);
    assert.ok(starts[1] > 25000 && starts[1] < 35000, `第二段起始 ≈30s，实际 ${starts[1]}ms`);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] > starts[i - 1], '时间戳递增');
    Object.assign(process.env, old);
    ok('超限 MP3：自动分段并行转录，文本/VTT 按帧级时间戳合并');
  }

  // ---------- 4b. 超过上限且不是 MP3 → 明确报错 ----------
  {
    const old = { ...process.env };
    process.env.TRANSCRIPT_CF_MAX_AUDIO_MB = '1';
    global.fetch = async (url) => {
      if (url.includes('/ai/run/')) {
        return {
          ok: false, status: 400, statusText: 'Bad Request', json: async () => null,
        };
      }
      const big = Buffer.alloc(1100 * 1024); // 1.07MB 全零（非 MP3）
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'audio/mpeg' },
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
      };
    };
    let msg = '';
    try {
      await svc.transcribeWithWorkersAI('https://cdn.example.com/big-not-mp3.bin', {
        accountId: 'acc123', apiToken: 'tok123', timeoutMs: 5000,
      });
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg.includes('无法解析为 MP3 帧流'), msg);
    Object.assign(process.env, old);
    ok('超限非 MP3：明确报错而非静默失败');
  }

  // ---------- 5. HTTP 429 → quotaExhausted ----------
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

  // ---------- 6. HTTP 401/403 → 鉴权错误 ----------
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

  // ---------- 7. 超时（AbortError） ----------
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

  // ---------- 8. 空转录文本 → 报错 ----------
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

  // ---------- 9. generateTranscript 缺 CF 配置 → 跳过转录，不联网 ----------
  {
    const old = { ...process.env };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    process.env.TRANSCRIPT_API_TYPE = 'cf-whisper';
    const r = await svc.generateTranscript(
      { audioUrl: 'https://cdn.example.com/ep.mp3', apiType: 'cf-whisper' },
      null
    );
    assert.strictEqual(r.transcript, null);
    assert.strictEqual(r.source, 'none');
    Object.assign(process.env, old);
    ok('缺 CF 配置：跳过转录（transcript=null）');
  }

  // ---------- 10. generateTranscript cf-whisper 成功（含 vtt 透传） ----------
  {
    const old = { ...process.env };
    process.env.TRANSCRIPT_API_TYPE = 'cf-whisper';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acc123';
    process.env.CLOUDFLARE_API_TOKEN = 'tok123';
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { text: 'Subtitle text.', vtt: 'WEBVTT\n\n00:00.000 --> 00:01.000\nSubtitle text.' } }),
    });
    const r = await svc.generateTranscript(
      { audioUrl: 'https://cdn.example.com/ep.mp3', apiType: 'cf-whisper' },
      null
    );
    assert.strictEqual(r.transcript, 'Subtitle text.');
    assert.strictEqual(r.source, 'cf-whisper');
    assert.ok(r.vtt.includes('WEBVTT'));
    Object.assign(process.env, old);
    ok('cf-whisper：成功转录并返回 text+vtt');
  }

  // ---------- 11. generateTranscript 429 → err.quotaExhausted ----------
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
        null
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, '应当抛错');
    assert.strictEqual(caught.quotaExhausted, true);
    Object.assign(process.env, old);
    ok('429 透传：quotaExhausted 供 cron 标记 pending/跳过');
  }

  console.log(`\n全部通过（${tests} 项）`);
})().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});
