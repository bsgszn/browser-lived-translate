// 术语表：把"这个词必须这么译"这件事，落实到每一条翻译路径上。
//
// 三家服务商的支持程度差很多，所以策略分三档：
//   OpenAI  → 直接写进 system prompt（模型会遵守）
//   DeepL   → 官方 glossary API，最可靠
//   Google  → 免 Key 通道没有任何术语能力，只能做"占位符替换"（best-effort）
//
// 占位符的做法：把原文里的术语换成一个不含字母的私有区标记，
// 翻译器没什么可翻的，通常原样带过去，回来再换回目标词。
// 它不保证成功（翻译器可能吞掉标记），所以 restore 时会回报哪些标记丢了，
// 诊断面板里能看到——不会静默地产生半截译文。

/** 每行一条 `原文=译文`，`#` 开头是注释 */
export function parseGlossary(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf('=');
      if (i <= 0) return null;
      const from = line.slice(0, i).trim();
      const to = line.slice(i + 1).trim();
      return from && to ? { from, to } : null;
    })
    .filter(Boolean);
}

/**
 * 内置游戏术语表。
 *
 * 选词标准很严：**只收在游戏语境之外几乎不会出现的词**。
 * 因为术语表是整词匹配、全局生效的，一条 `support=辅助` 会让技术文档里的
 * "technical support" 也变成"技术辅助"，`top=上路` 会把 "top 10" 毁掉。
 *
 * 所以下面故意**没有**收这些高频歧义词：
 *   support / top / mid / bot / vision / recall / patch / meta / ace / cs / tp /
 *   ultimate / throwing / feeding / cheese / exploit
 * 宁可少收几条，也不要污染非游戏内容。
 *
 * 另外这份表默认**关闭**：只有用户明确打开「游戏术语表」才会生效。
 */
export const GAMING_GLOSSARY_TEXT = `# livedtranslate 内置游戏术语表（默认关闭；仅目标语言为中文时可用）
# 每行一条 原文=译文；整词匹配、忽略大小写。不想要的行前面加 # 即可
carry=核心输出位
carries=核心输出位
aggro=仇恨
gank=抓人
ganked=被抓
ganking=正在抓人
lane=分路
lanes=分路
laning=对线
jungle=野区
jungler=打野
jungling=打野
last-hit=补刀
last hit=补刀
minion=小兵
minions=小兵
creeps=小兵
tower=防御塔
towers=防御塔
inhibitor=高地塔
nexus=基地
respawn=复活
cooldown=冷却
ult=大招
ults=大招
pentakill=五杀
quadrakill=四杀
buff=加强
nerf=削弱
ranked=排位
solo queue=单排
duo queue=双排
smurf=小号
smurfing=开小号
smurfed=开小号
clutch=关键发挥
headshot=爆头
flank=绕后
flanked=绕后
flanking=绕后
speedrun=速通
speedrunning=速通
glitch=游戏漏洞
dungeon=副本
raid=团本
guild=公会
mob=小怪
mobs=小怪
loot=战利品
ward=视野
wards=视野
smite=惩戒
dps=输出
adc=射手
kiting=风筝
peel=保后排
teamfight=团战
pentakill=五杀
gg=打得不错
wp=打得好
`;

/**
 * 内置**直播**术语表（英文 + 日文 → 中文）。
 *
 * 日文部分有一条硬约束，选词时必须守住：
 * 日文没有词边界，termPattern 对含 CJK 的条目只能做**子串匹配**。
 * 所以凡是"可能是某个更长常见词的一部分"的条目都不能收：
 *   草（草食 / 雑草）、笑（笑顔）、枠（枠組み）、乙（甲乙丙）、凸（凸凹）、
 *   www（网址）、わかる（わからない）、ありがと（ありがとう）、
 *   おつかれ（おつかれさま）、それな（それなら）
 * 这些看着最像直播黑话，恰恰是最容易污染译文的一批。
 * 宁可少收几条，也不要让「わからない」变成「懂ない」。
 */
export const LIVE_GLOSSARY_TEXT = `# livedtranslate 内置直播术语表（仅目标语言为中文时可用）
# 每行一条 原文=译文；英文整词匹配，日文子串匹配（最长优先）。不要的行前面加 # 即可

# ── 平台与变现 ──
superchat=醒目留言（SC）
super chat=醒目留言（SC）
superchats=醒目留言（SC）
スパチャ=醒目留言（SC）
スーパーチャット=醒目留言（SC）
membership=会员
memberships=会员
members-only=会员限定
members only=会员限定
メンバーシップ=会员
メン限=会员限定
メンバー限定=会员限定
donation=打赏
donations=打赏
gift sub=赠送订阅
gift subs=赠送订阅
gifted sub=赠送订阅
charity stream=慈善直播
donothon=打赏马拉松
収益化=开启收益
殿堂入り=殿堂级

# ── 人与角色 ──
streamer=主播
streamers=主播
配信者=主播
実況者=实况主
viewer=观众
viewers=观众
視聴者=观众
リスナー=观众
subscriber=订阅者
subscribers=订阅者
登録者=订阅者
moderator=房管
moderators=房管
モデレーター=房管
VTuber=虚拟主播
VTubers=虚拟主播
初見=初次观看
初見さん=新来的观众
常連=老观众
新規=新人

# ── 直播形态 ──
livestream=直播
live stream=直播
配信=直播
生放送=直播
雑談=杂谈
歌枠=唱歌直播
歌ってみた=翻唱
踊ってみた=翻跳
ゲーム実況=游戏实况
実況=实况解说
縛りプレイ=限制玩法
ホラーゲーム=恐怖游戏
凸待ち=等人连麦
コラボ=联动
collab=联动
collabs=联动
debut=出道
graduation=毕业
卒業=毕业
引退=引退
復活=复活
新衣装=新衣服
3D披露=3D 披露
記念配信=纪念直播
オフ会=线下聚会
karaoke=卡拉OK
waiting room=待机室
待機所=待机室

# ── 互动与运营 ──
live chat=聊天室
chatroom=聊天室
chat room=聊天室
chat box=聊天室
コメント欄=评论区
コメント=评论
固定コメント=置顶评论
emote=表情
emotes=表情
highlights=精彩集锦
clip=切片
clips=切片
切り抜き=切片
VOD=回放
vods=回放
アーカイブ=回放
thumbnail=封面
サムネ=封面
概要欄=简介栏
チャンネル登録=订阅频道
高評価=点赞
低評価=踩
再生数=播放量
同時接続=同时观看人数
raid=突袭
raids=突袭
荒らし=捣乱的人
通報=举报
グッズ=周边
推し=推
ぽんこつ=笨手笨脚
エゴサ=搜自己
つよつよ=超强
`;

/** 目标语言是不是中文（内置词表的译文都是中文，别的目标语言不能并进来） */
function isChineseTarget(target) {
  return /^zh/i.test(String(target || ''));
}

/**
 * 汇总当前应当生效的术语条目。
 * @param {object} settings
 * @returns {Array<{from:string,to:string}>}
 */
export function glossaryEntries(settings) {
  const t = settings?.translate || {};
  const entries = parseGlossary(t.glossary);
  // 内置词表的译文都是中文，所以只在目标语言是中文时并入
  if (isChineseTarget(t.target)) {
    if (t.liveGlossary) entries.push(...parseGlossary(LIVE_GLOSSARY_TEXT));
    if (t.gamingGlossary) entries.push(...parseGlossary(GAMING_GLOSSARY_TEXT));
  }
  // 用户自定义的排在前面，去重时优先保留（自定义要能覆盖内置）
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const key = e.from.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  // 长词优先，避免 "last hit" 被 "hit" 抢先匹配（同理 "solo queue" 先于 "queue"）
  out.sort((a, b) => b.from.length - a.from.length);
  return out;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 术语表的整词匹配模式；英文用词边界，含 CJK 的条目退化为直接包含 */
function termPattern(from) {
  const escaped = escapeRegExp(from);
  // 词边界对 CJK 没有意义，只有纯 ASCII 词才加 \b
  if (/^[\x20-\x7e]+$/.test(from)) return new RegExp(`\\b${escaped}\\b`, 'gi');
  return new RegExp(escaped, 'g');
}

/** 私有区字符包住序号，翻译器通常原样保留 */
const TOKEN_OPEN = '\uE000';
const TOKEN_CLOSE = '\uE001';

/**
 * 把原文里的术语换成占位标记（供没有术语能力的服务商使用）。
 * @returns {{text:string, tokens:Array<{index:number,to:string,from:string}>}}
 */
export function applyPlaceholders(text, entries) {
  const src = String(text || '');
  if (!src || !entries?.length) return { text: src, tokens: [] };

  let out = src;
  const tokens = [];
  let index = 0;
  for (const entry of entries) {
    const re = termPattern(entry.from);
    if (!re.test(out)) continue;
    out = out.replace(re, `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`);
    tokens.push({ index, to: entry.to, from: entry.from });
    index += 1;
    if (index > 60) break; // 保护：一句话里不该有上百个术语
  }
  return { text: out, tokens };
}

/**
 * 把译文里的占位标记换回目标词。
 * 容忍翻译器在标记内部或周围插空格。
 * @returns {{text:string, restored:number, lost:number}}
 */
export function restorePlaceholders(translated, tokens) {
  let out = String(translated || '');
  if (!tokens?.length) return { text: out, restored: 0, lost: 0 };

  let restored = 0;
  let lost = 0;
  for (const token of tokens) {
    const re = new RegExp(`${TOKEN_OPEN}\\s*${token.index}\\s*${TOKEN_CLOSE}`, 'g');
    if (re.test(out)) {
      out = out.replace(re, token.to);
      restored += 1;
    } else {
      lost += 1;
    }
  }
  // 兜底：万一还有没配对的孤立标记，清掉免得出现在字幕里
  out = out.split(TOKEN_OPEN).join('').split(TOKEN_CLOSE).join('');
  return { text: out, restored, lost };
}

/** 给 OpenAI 用的提示词片段 */
export function promptGlossaryText(entries, limit = 80) {
  if (!entries?.length) return '';
  return entries
    .slice(0, limit)
    .map((e) => `${e.from} → ${e.to}`)
    .join('；');
}
