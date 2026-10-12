// 运行在 AudioWorklet 线程：把 Float32 PCM 攒成固定大小的块，再转交给主线程。
// 128 帧一个 render quantum 太碎（≈375 次/秒），这里攒到 2048 帧（48k 下约 43ms）再发。

class LivedTranslatePcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options?.processorOptions?.blockSize;
    this.blockSize = Number.isInteger(requested) && requested > 0 ? requested : 2048;
    this.buf = new Float32Array(this.blockSize);
    this.filled = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.filled === 0) return;
    const out = this.buf.slice(0, this.filled);
    this.filled = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      let offset = 0;
      while (offset < channel.length) {
        const take = Math.min(this.blockSize - this.filled, channel.length - offset);
        this.buf.set(channel.subarray(offset, offset + take), this.filled);
        this.filled += take;
        offset += take;
        if (this.filled === this.blockSize) this.flush();
      }
    }
    // 输出通道保持静音（真正的播放链路在 offscreen 里另接），但必须返回 true 保持节点存活。
    return true;
  }
}

registerProcessor('livedub-pcm', LivedTranslatePcmCapture);
