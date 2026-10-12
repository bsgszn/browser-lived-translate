// 滚动 PCM 环形缓冲。
//
// 延迟模式的价值在于"音频还留着"——留住了才能拿它去重新识别一遍。
// 这里用**绝对样本序号**寻址：writeIndex 只增不减，读的时候再对容量取模。
// 这样调用方可以直接用"第 3.2 秒到第 5.8 秒"来切，不用担心内部绕了几圈。
//
// 内存：16kHz 单声道 Int16，90 秒 ≈ 2.9 MB —— 相对它换来的东西可以忽略。

export class PcmRing {
  /**
   * @param {{sampleRate:number, seconds?:number}} opts
   */
  constructor({ sampleRate, seconds = 90 } = {}) {
    const rate = Math.max(1, Math.round(Number(sampleRate) || 16000));
    this.sampleRate = rate;
    this.capacity = Math.max(rate, Math.ceil(rate * Math.max(1, Number(seconds) || 90)));
    this.buf = new Int16Array(this.capacity);
    /** 历史上一共写入过多少样本（绝对序号，只增不减） */
    this.writeIndex = 0;
    /** 当前有效样本数（不超过 capacity） */
    this.length = 0;
  }

  push(chunk) {
    if (!chunk || !chunk.length) return;
    const n = chunk.length;
    for (let i = 0; i < n; i += 1) {
      this.buf[this.writeIndex % this.capacity] = chunk[i];
      this.writeIndex += 1;
    }
    this.length = Math.min(this.capacity, this.length + n);
  }

  /** 缓冲区里最老的样本的绝对序号 */
  get oldestIndex() {
    return Math.max(0, this.writeIndex - this.length);
  }

  /** 已缓冲的秒数 */
  get bufferedSeconds() {
    return this.length / this.sampleRate;
  }

  /**
   * 按绝对样本区间取数据。超出保留范围的部分会被裁掉——
   * 宁可给一小段，也不要静默地给错位的数据。
   * @returns {Int16Array}
   */
  slice(startSample, endSample) {
    const a = Math.max(Math.round(Number(startSample) || 0), this.oldestIndex);
    const b = Math.min(Math.round(Number(endSample) || 0), this.writeIndex);
    if (!(b > a)) return new Int16Array(0);
    const out = new Int16Array(b - a);
    for (let i = a; i < b; i += 1) out[i - a] = this.buf[i % this.capacity];
    return out;
  }

  /** 按秒取（相对流起点） */
  sliceBySeconds(fromSec, toSec, padSec = 0) {
    const pad = Math.max(0, Number(padSec) || 0);
    return this.slice(
      Math.round((Number(fromSec) - pad) * this.sampleRate),
      Math.round((Number(toSec) + pad) * this.sampleRate),
    );
  }

  clear() {
    this.buf.fill(0);
    this.writeIndex = 0;
    this.length = 0;
  }
}

/** Int16 单声道 → 16-bit PCM WAV（给走 multipart 的识别接口用） */
export function encodeWav(int16, sampleRate) {
  const data = int16 instanceof Int16Array ? int16 : new Int16Array(int16 || 0);
  const bytes = data.length * 2;
  const out = new ArrayBuffer(44 + bytes);
  const view = new DataView(out);
  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  writeStr(36, 'data');
  view.setUint32(40, bytes, true);

  const pcm = new Uint8Array(out, 44);
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    pcm[i * 2] = v & 0xff;
    pcm[i * 2 + 1] = (v >> 8) & 0xff;
  }
  return out;
}
