// 通用小工具：无依赖，可在 service worker / offscreen / 扩展页面中复用。

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 深合并：仅用于 settings，数组整体替换。 */
export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch)) return patch.slice();
  if (typeof patch !== 'object') return patch;
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  return out;
}

/** Float32 [-1,1] -> 小端 Int16 */
export function float32ToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToBase64(i16) {
  const bytes = new Uint8Array(i16.buffer, i16.byteOffset, i16.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 由 Int16 PCM 生成 WAV(单声道) ArrayBuffer */
export function buildWav(int16, sampleRate) {
  const dataSize = int16.byteLength;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  new Uint8Array(buf, 44).set(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));
  return buf;
}

/** 均方根音量，0~1 */
export function rms(int16) {
  if (!int16.length) return 0;
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / int16.length);
}

export function concatInt16(chunks, total) {
  const n = total ?? chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * 采样率转换。
 * - 整数倍降采样：块平均（自带抗混叠）
 * - 其他情况：线性插值
 * 跨 block 保持状态，避免每个 block 边界产生杂音。
 */
export class Resampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    this.integerDecimation = Number.isInteger(this.ratio);
    this.tail = new Float32Array(0);
    this.pos = 0;
  }

  process(input) {
    if (this.inRate === this.outRate) return input;
    const buf = new Float32Array(this.tail.length + input.length);
    buf.set(this.tail, 0);
    buf.set(input, this.tail.length);

    let out;
    let consumed;
    if (this.integerDecimation) {
      const r = this.ratio;
      const n = Math.floor(buf.length / r);
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        const base = i * r;
        for (let k = 0; k < r; k++) sum += buf[base + k];
        out[i] = sum / r;
      }
      consumed = n * r;
    } else {
      const n = Math.max(0, Math.floor((buf.length - 1 - this.pos) / this.ratio) + 1);
      out = new Float32Array(Math.max(0, n));
      let p = this.pos;
      let i = 0;
      while (p + 1 < buf.length && i < out.length) {
        const i0 = Math.floor(p);
        const frac = p - i0;
        out[i++] = buf[i0] * (1 - frac) + buf[i0 + 1] * frac;
        p += this.ratio;
      }
      out = out.subarray(0, i);
      consumed = Math.floor(p);
      this.pos = p - consumed;
    }
    this.tail = buf.slice(consumed);
    return out;
  }

  flush() {
    this.tail = new Float32Array(0);
    this.pos = 0;
  }
}

/** 按句子/标点切分长文本，避免 GET URL 过长或单次请求过大 */
export function chunkText(text, maxLen = 1200) {
  const s = String(text || '').trim();
  if (s.length <= maxLen) return s ? [s] : [];
  const parts = [];
  let cur = '';
  const pieces = s.split(/(?<=[。！？；.!?;])\s*/);
  for (const piece of pieces) {
    if ((cur + piece).length > maxLen && cur) {
      parts.push(cur.trim());
      cur = '';
    }
    if (piece.length > maxLen) {
      for (let i = 0; i < piece.length; i += maxLen) parts.push(piece.slice(i, i + maxLen).trim());
    } else {
      cur += piece;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

export function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}
