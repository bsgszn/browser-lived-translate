// 分析支路的音频前端。
//
// 关键认识：这条链路只喂给语音识别，绝不能碰回放支路——用户听到的原声必须原封不动。
// 所以这里所有处理都做成独立的 Web Audio 原生节点链，挂在 source → worklet 之间，
// 与 source → playbackGain → destination 完全并行。
//
// 为什么必须有抗混叠：
//   之前用 3 点盒式平均做 48k → 16k 抽取，等效滤波器在 8kHz 处只有 -3.5dB、9.6kHz 处 -5.5dB。
//   直播里的观众噪声、音乐、音效富含 8–24kHz 能量，会被折叠回 0–8kHz 的语音频段，
//   直接污染识别输入。换成 8 阶 Butterworth 级联后，8kHz 约 -10dB、12kHz 约 -37dB。
//
// 全部用原生节点实现的额外好处：零 JS 开销（对比手写 97 抽头 FIR 大约要多烧 5% 一个核）。

/** 8 阶 Butterworth 的极点 Q 值：Q_k = 1 / (2·cos((2k+1)π / 16)) */
export const BUTTERWORTH_Q = [
  0.50979557910416, 0.60134488693505, 0.89997622313642, 2.56291544774151,
];

/** 去掉直流与低频隆隆声（空调、桌面震动、电流声） */
export const RUMBLE_CUTOFF_HZ = 80;

/** 抗混叠截止频率：留出 12% 的过渡带余量 */
export function analysisCutoffHz(outRate) {
  return outRate * 0.44;
}

/**
 * 纯数据形式的滤波器设计，不依赖浏览器。
 * buildAnalysisChain 和测试脚本用的是同一份设计，保证"测的就是跑的"。
 */
export function designAnalysisStages(outRate) {
  return [
    { type: 'highpass', frequency: RUMBLE_CUTOFF_HZ, Q: 0.7071 },
    ...BUTTERWORTH_Q.map((Q) => ({ type: 'lowpass', frequency: analysisCutoffHz(outRate), Q })),
  ];
}

/**
 * 在 ctx 里搭出前端链：高通 → 4×低通 → AGC → 限幅，接到 source 上。
 * 返回的 output 需要再连到 AudioWorkletNode。
 */
export function buildAnalysisChain(ctx, source, outRate) {
  const stages = [];

  for (const spec of designAnalysisStages(outRate)) {
    const node = ctx.createBiquadFilter();
    node.type = spec.type;
    node.frequency.value = spec.frequency;
    node.Q.value = spec.Q;
    stages.push(node);
  }

  // AGC：增益由主线程根据实测电平调节，这里只负责承载增益值
  const agc = ctx.createGain();
  agc.gain.value = 1;
  stages.push(agc);

  // 安全限幅：AGC 最多 +12dB，遇到突然的大声不能削顶
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  stages.push(limiter);

  source.connect(stages[0]);
  for (let i = 0; i < stages.length - 1; i++) stages[i].connect(stages[i + 1]);

  return {
    stages,
    agc,
    limiter,
    input: stages[0],
    output: stages[stages.length - 1],
    cutoffHz: analysisCutoffHz(outRate),
  };
}

// ─────────────────────────── AGC 策略 ───────────────────────────

/**
 * AGC 档位。
 *
 * ⚠️ 为什么要有档位：AGC 是**双刃剑**。
 * 它的本意是把忽大忽小的音量拉平，对识别有利；但如果它**追得太快**，
 * 就会在主播音量起伏时来回"泵"——而 VAD 和 Whisper 都讨厌电平忽大忽小。
 * 差麦克风 + 快语速的场景下，底噪本来就不小，`maxGain: 4`（+12dB）
 * 还会把底噪一起放大。
 *
 * `gentle` 就是为这种场景准备的：提升更少、收敛更慢、噪声门更高。
 * 默认仍是 `standard` —— 也就是这次改动**之前的行为**，不改就是零风险。
 */
export const AGC_PROFILES = {
  off: {
    label: '关闭（固定增益 1）',
    hint: '完全不做自动增益。音量本来就稳定的音源适用。',
    values: { noiseFloor: 0.0025, targetRms: 0.09, minGain: 1, maxGain: 1, levelSmoothing: 1.2, gainSmoothing: 0.35 },
  },
  gentle: {
    label: '温和（差麦克风推荐）',
    hint: '提升上限砍半、收敛慢 4 倍、噪声门抬高。音量拉平得没那么狠，但不会来回泵、也不会把底噪放大。',
    values: { noiseFloor: 0.006, targetRms: 0.07, minGain: 1, maxGain: 2, levelSmoothing: 2.5, gainSmoothing: 1.5 },
  },
  standard: {
    label: '标准（默认，一直是这个）',
    hint: '只提升不衰减，最多 +12dB，增益 0.35 秒收敛。',
    values: { noiseFloor: 0.0025, targetRms: 0.09, minGain: 1, maxGain: 4, levelSmoothing: 1.2, gainSmoothing: 0.35 },
  },
  strong: {
    label: '强力',
    hint: '提升更多、收敛更快。音源本身很轻、又稳定时才用。',
    values: { noiseFloor: 0.002, targetRms: 0.12, minGain: 1, maxGain: 6, levelSmoothing: 0.8, gainSmoothing: 0.25 },
  },
};

/** 当前生效的 AGC 参数。setAgcProfile() 会就地改它 —— 纯函数与控制器都读这里。 */
export const AGC = { ...AGC_PROFILES.standard.values, intervalMs: 120 };

/** 切换 AGC 档位。传未知值就当 standard。 */
export function setAgcProfile(id) {
  const p = AGC_PROFILES[id] ? id : 'standard';
  Object.assign(AGC, AGC_PROFILES[p].values);
  return p;
}

/**
 * 根据平滑后的电平算出目标增益。
 * 纯函数，方便单测；真正的平滑在 AgcController 里做。
 */
export function agcTargetGain(levelRms) {
  if (!Number.isFinite(levelRms) || levelRms < AGC.noiseFloor) return AGC.minGain;
  const desired = AGC.targetRms / levelRms;
  return Math.min(AGC.maxGain, Math.max(AGC.minGain, desired));
}

/** 带状态的电平平滑 + 增益收敛 */
export class AgcController {
  constructor() {
    this.level = 0;
    this.gain = AGC.minGain;
    this.lastAt = 0;
  }

  reset() {
    this.level = 0;
    this.gain = AGC.minGain;
    this.lastAt = 0;
  }

  /**
   * @param {number} blockRms 当前音频块的 RMS
   * @param {number} nowMs performance.now()
   * @param {number} blockMs 该块覆盖的时长
   * @returns {number|null} 需要下发的新增益，null 表示本次不改
   */
  update(blockRms, nowMs, blockMs = 43) {
    const dt = Math.max(0, (nowMs - this.lastAt) / 1000);
    if (dt > 0) {
      const a = 1 - Math.exp(-dt / AGC.levelSmoothing);
      this.level += (blockRms - this.level) * a;
    }
    this.lastAt = nowMs;

    if (nowMs - (this._lastPushAt || 0) < AGC.intervalMs) return null;
    this._lastPushAt = nowMs;

    const target = agcTargetGain(this.level);
    if (Math.abs(target - this.gain) < 0.01) return null;

    const a = 1 - Math.exp(-AGC.intervalMs / 1000 / AGC.gainSmoothing);
    this.gain += (target - this.gain) * a;
    void blockMs;
    return this.gain;
  }
}
