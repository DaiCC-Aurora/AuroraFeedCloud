'use strict';

/**
 * MP3 帧级切分器与 VTT 偏移的本地单测。
 * 运行：node test-mp3-chunker.js
 */

const assert = require('assert');
const { chunkMp3, offsetVtt, parseFrameHeader } = require('./src/services/mp3Chunker');

let tests = 0;
function ok(name) {
  tests += 1;
  console.log(`  ✓ ${name}`);
}

/** 生成 CBR MP3 帧流：V1 L3 44.1kHz（帧长按公式计算，128kbps → 417B，帧时长 ≈26.122ms）。 */
function makeCbrFrames(count, bitrateKbps = 128) {
  const sr = 44100;
  const bps = bitrateKbps * 1000;
  const frameLength = Math.floor((144 * bps) / sr); // V1 L3：144*bitrate/samplerate
  const brIdxMap = { 32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8, 128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14 };
  const brIdx = brIdxMap[bitrateKbps];
  if (!brIdx) throw new Error(`测试用不支持的比特率 ${bitrateKbps}`);
  const buf = Buffer.alloc(count * frameLength);
  for (let i = 0; i < count; i++) {
    const off = i * frameLength;
    buf[off] = 0xff;
    buf[off + 1] = 0xfb; // sync + V1 + L3 + 无 CRC
    buf[off + 2] = brIdx << 4; // srIdx=0(44100)，padding=0
    buf[off + 3] = 0x00;
  }
  return buf;
}

(async () => {
  // ---------- 1. 帧头解析 ----------
  {
    const buf = makeCbrFrames(2);
    const h = parseFrameHeader(buf, 0);
    assert.strictEqual(h.bitrateKbps, 128);
    assert.strictEqual(h.sampleRate, 44100);
    assert.strictEqual(h.frameLength, 417);
    assert.strictEqual(h.samplesPerFrame, 1152);
    ok('帧头解析：128kbps/44.1kHz → 帧长 417B，每帧 1152 采样');
  }

  // ---------- 2. 按时长切分：帧对齐 + 起始时间精确 ----------
  {
    const buf = makeCbrFrames(120); // ≈3.13s
    const chunks = chunkMp3(buf, 1, 10 * 1024 * 1024);
    assert.ok(chunks.length >= 3, `应切出至少 3 段，实际 ${chunks.length}`);
    assert.strictEqual(chunks[0].startMs, 0);
    for (const c of chunks) {
      assert.strictEqual(c.buffer.length % 417, 0, '每段都应帧对齐');
    }
    // 每段约 1s = 38.3 帧 → 第二段起始 ≈ 1000ms
    assert.ok(chunks[1].startMs >= 900 && chunks[1].startMs <= 1100, `第二段起始 ${chunks[1].startMs}ms`);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i].startMs > chunks[i - 1].startMs, '起始时间递增');
    }
    ok('按时长切分：帧对齐、起始时间精确递增');
  }

  // ---------- 3. 字节上限约束 ----------
  {
    const buf = makeCbrFrames(200);
    const maxBytes = 50 * 417; // 50 帧
    const chunks = chunkMp3(buf, 600, maxBytes);
    assert.ok(chunks.length >= 4);
    for (const c of chunks) {
      assert.ok(c.buffer.length <= maxBytes, `段 ${c.buffer.length}B 超过上限 ${maxBytes}B`);
    }
    ok('字节上限：每段不超过 maxBytes');
  }

  // ---------- 4. VTT 偏移 ----------
  {
    const vtt = 'WEBVTT\n\n00:00.000 --> 00:03.200\nHello there.\n\n00:03.200 --> 00:07.500\nHow are you?\n';
    const out = offsetVtt(vtt, 30000);
    assert.ok(out.includes('00:00:30.000 --> 00:00:33.200'), out);
    assert.ok(out.includes('00:00:33.200 --> 00:00:37.500'), out);
    assert.ok(out.includes('WEBVTT'), out);
    ok('VTT 偏移：整体 +30s 且保留结构');
  }

  // ---------- 5. 非 MP3 → 明确报错 ----------
  {
    let msg = '';
    try {
      chunkMp3(Buffer.alloc(8192), 1, 10 * 1024 * 1024);
    } catch (e) {
      msg = e.message;
    }
    assert.ok(msg.includes('无法解析为 MP3 帧流'), msg);
    ok('非 MP3：明确报错');
  }

  console.log(`\n全部通过（${tests} 项）`);
})().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});
