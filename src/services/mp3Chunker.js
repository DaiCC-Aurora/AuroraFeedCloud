'use strict';

/**
 * 轻量 MP3 帧级切分器（无原生依赖）。
 *
 * 原理：逐帧解析 MPEG 音频帧头（同步字 + 比特率/采样率/填充位），
 * 每帧时长 = samplesPerFrame / sampleRate（固定值），逐帧累计即得精确时间轴，
 * 因此 CBR / VBR 都能得到帧级精确的切分边界与起始时间。
 *
 * 用法：
 *   const { chunkMp3, parseAndOffsetVtt } = require('./mp3Chunker');
 *   const chunks = chunkMp3(buffer, 600, 24 * 1024 * 1024); // 每段≤10分钟且≤24MB
 *   // chunks: [{ buffer: Buffer, startMs: number }]
 */

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
  [44100, 48000, 32000], // V1
  [22050, 24000, 16000], // V2
  [11025, 12000, 8000],  // V2.5
];

/** 解析 offset 处的 MPEG 帧头；合法返回帧信息，否则 null。 */
function parseFrameHeader(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null; // 同步字
  const verBits = (b1 >> 3) & 0x3; // 0=V2.5 1=保留 2=V2 3=V1
  const layerBits = (b1 >> 1) & 0x3; // 0=保留 1=L3 2=L2 3=L1
  if (verBits === 1 || layerBits === 0) return null;

  const b2 = buf[offset + 2];
  const brIdx = (b2 >> 4) & 0xf;
  const srIdx = (b2 >> 2) & 0x3;
  const padding = (b2 >> 1) & 0x1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;

  const verIdx = verBits === 3 ? 0 : verBits === 2 ? 1 : 2;
  const sampleRate = SAMPLE_RATE_TABLE[verIdx][srIdx];
  // 比特率列：V1 → L1=0, L2=1, L3=2；V2/V2.5 → L1=3, L2=4, L3=4（V2 的 L2/L3 同一列）
  const col =
    verBits === 3 ? (layerBits === 3 ? 0 : layerBits === 2 ? 1 : 2) : layerBits === 3 ? 3 : 4;
  const bitrateKbps = BITRATE_TABLE[brIdx][col];
  if (!bitrateKbps) return null;

  let samplesPerFrame;
  if (layerBits === 3) samplesPerFrame = 384; // L1
  else if (layerBits === 2) samplesPerFrame = 1152; // L2
  else samplesPerFrame = verBits === 3 ? 1152 : 576; // L3（V1=1152，V2/V2.5=576）

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
function id3SkipSize(buffer) {
  if (
    buffer.length >= 10 &&
    buffer[0] === 0x49 && // 'I'
    buffer[1] === 0x44 && // 'D'
    buffer[2] === 0x33 // '3'
  ) {
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f);
    let off = 10 + size;
    if ((buffer[5] & 0x10) !== 0) off += 10; // 有 footer
    return off;
  }
  return 0;
}

/** 在 [from, to) 范围内查找下一个合法帧头；找不到返回 -1。 */
function findNextSync(buffer, from, to) {
  const end = Math.min(to, buffer.length - 4);
  for (let i = from; i <= end; i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
      const h = parseFrameHeader(buffer, i);
      // 容忍最后一帧被截断（文件被切在帧中间）
      if (h && i + h.frameLength <= buffer.length + 512) return i;
    }
  }
  return -1;
}

/**
 * 将 MP3 音频按目标时长切成若干帧边界对齐的段。
 * @param {Buffer} buffer 完整 MP3 数据
 * @param {number} targetSeconds 每段目标时长（秒）
 * @param {number} maxBytes 每段字节上限
 * @returns {Array<{buffer: Buffer, startMs: number}>}
 * @throws {Error} 不是 MP3 帧流时抛错
 */
function chunkMp3(buffer, targetSeconds, maxBytes) {
  const first = findNextSync(buffer, id3SkipSize(buffer), buffer.length);
  if (first < 0) {
    throw new Error('无法解析为 MP3 帧流（找不到帧头）');
  }

  const chunks = [];
  const targetMs = Math.max(targetSeconds, 1) * 1000;
  let segStart = first;
  let segStartMs = 0;
  let offset = first;
  let timeMs = 0;

  while (offset < buffer.length - 3) {
    const h = parseFrameHeader(buffer, offset);
    if (!h) {
      // 帧解析失败（异常帧/损坏）：向前重同步
      const next = findNextSync(buffer, offset + 1, buffer.length);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const frameMs = (h.samplesPerFrame / h.sampleRate) * 1000;
    if (timeMs - segStartMs >= targetMs || offset - segStart >= maxBytes) {
      if (offset - segStart > 0) {
        chunks.push({ buffer: buffer.subarray(segStart, offset), startMs: Math.round(segStartMs) });
      }
      segStart = offset;
      segStartMs = timeMs;
    }
    timeMs += frameMs;
    offset += h.frameLength;
  }
  if (offset - segStart > 0) {
    chunks.push({ buffer: buffer.subarray(segStart, offset), startMs: Math.round(segStartMs) });
  }
  return chunks;
}

const VTT_TIME_REGEX =
  /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;

/** "mm:ss.mmm" / "hh:mm:ss.mmm" -> 毫秒 */
function tcToMs(tc) {
  const parts = tc.trim().replace(',', '.').split(':');
  let total = 0;
  for (const p of parts) total = total * 60 + parseFloat(p);
  return Math.round(total * 1000);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 毫秒 -> "hh:mm:ss.mmm"（VTT 标准；内部先取整，容忍浮点输入） */
function msToTc(ms) {
  const total = Math.round(ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const f = total % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(f).padStart(3, '0')}`;
}

/**
 * 把一段 VTT 的所有时间戳整体加上 offsetMs，返回新的 VTT 文本。
 * 保留原结构（WEBVTT 头、空行、序号行）。
 * @param {string} vtt
 * @param {number} offsetMs
 * @returns {string}
 */
function offsetVtt(vtt, offsetMs) {
  if (!vtt) return vtt;
  return vtt
    .split(/\r?\n/)
    .map((line) => {
      const m = VTT_TIME_REGEX.exec(line);
      if (!m) return line;
      return `${msToTc(tcToMs(m[1]) + offsetMs)} --> ${msToTc(tcToMs(m[2]) + offsetMs)}`;
    })
    .join('\n');
}

module.exports = { chunkMp3, offsetVtt, parseFrameHeader, findNextSync };
