// Whisper 的经典幻听短语。
//
// Whisper 是在海量 YouTube 字幕上训练的，"ご視聴ありがとうございました" 这类片尾套话
// 会在**没有语音、或者只有音乐/掌声**的片段上被凭空吐出来 —— 这是它最出名的毛病，
// 跟音频内容无关，每种语言都有一套自己的高频幻听。
//
// ⚠️ 这只是**第二道网**。第一道应当是 `no_speech_prob` / `avg_logprob` 闸门
// （见 vad.js 与 refine.js 里的 judgeTranscription）—— 那个是内容无关的、
// 不会误伤的。用这个清单只是为了兜住最典型的几句。
//
// ⚠️ 误伤风险：直播主在收尾时**真的会说**"ありがとうございました"。
// 所以这里只收那些几乎不可能是有意义内容的套话，而且限定在短文本上比对。

/** 归一化：去掉空白与标点，只留下实义字符 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s.,!?;:'"“”‘’、。！？；：…—–-]+/g, '');
}

/**
 * 几乎不可能出现在正常直播内容里的套话。
 * 只放"整句就是它"或"很短且包含它"的情况。
 */
const PHRASES = [
  // 日语（最典型）
  'ご視聴ありがとうございました',
  'ご視聴ありがとうございます',
  'ご視聴ありがとう',
  'ご清聴ありがとうございました',
  // ⚠️ `チャンネル登録お願いします` / `おやすみなさい` / `また明日` 曾经在这张表里，
  // **已经删掉**：它们是日语直播里真正常出现的话 ——「请订阅频道」几乎是每场的固定环节，
  // 收播时也真的会说「晚安」「明天见」。把它们当幻听会把**真实内容整条丢掉**
  // （字幕直接消失，用户完全不知道为什么）。宁可漏放几句套话，也不能丢真话。
  // 真正兜底的是 no_speech_prob / avg_logprob 那道闸门，它是内容无关的。
  // 中文
  '感谢您的观看',
  '感谢观看',
  '谢谢观看',
  '谢谢大家的观看',
  '请订阅我们的频道',
  '订阅频道',
  // ⚠️ `字幕由` / `字幕组` 同理已删：直播里真的会聊到字幕组。
  // 英文
  'thanksforwatching',
  'thankyouforwatching',
  'pleasesubscribe',
  'subscribetomychannel',
  'thanksforwatchingthisvideo',
];

/** 短文本才做"包含"匹配 —— 长句里出现这些词多半是真的在说 */
const CONTAIN_MAX = 25;

/**
 * 这段文本像不像幻听。
 * @returns {boolean}
 */
export function looksLikeHallucination(text) {
  const norm = normalize(text);
  if (!norm) return true; // 空文本等同于没有内容
  for (const p of PHRASES) {
    if (norm === p) return true;
    if (norm.length <= CONTAIN_MAX && norm.includes(p)) return true;
  }
  return false;
}

export { PHRASES as HALLUCINATION_PHRASES };
