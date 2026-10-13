// 文档里的版本号引用 —— **唯一的一份实现**。
//
// 为什么要有这个模块：以前 `bump-version.mjs` 和 `manifest-check.mjs` 各写一份扫描，
// 而且判定方式不同：
//
//   manifest-check   line.match(/livedtranslate v(\d+\.\d+\.\d+)/)   ← 要求前缀 ✓
//   bump-version     line.includes(`v${current}`)                    ← 裸子串 ✗
//
// 后果：`tools/README.md` 里那些**历史对照例子**（比如记「先提交修复再改版本号」那条约定时
// 写的 `3b1ce5e v2.66.8`）会被裸子串命中 —— 每次升版本都报 5 条"版本号滞留"，其中 3 条是噪音。
//
// ⚠️ 噪音会训练人忽略警告。那个提示的本意是"某处版本号忘改了"，
//    被三条假警报稀释之后，真出问题时也没人看。所以两边统一到这里。
//
// ⚠️ 新增扫描目标请只改 `VERSION_DOC_FILES` —— 别在调用方再写一份清单
//    （这个项目为"两份清单/两份实现不一致"栽过多次）。

/** 文档里出现过版本号、且必须跟着 manifest 一起动的文件。 */
export const VERSION_DOC_FILES = ['README.md', 'tools/README.md', 'docs/delayed-playback.md'];

/**
 * 真正算数的两种写法。
 *
 * ⚠️ 只认**带前缀**的形式，裸的 `v1.2.3` 不算 —— 因为文档里到处是历史例子、
 *    示意用的假 SHA、以及"某次事故发生在 v1.2.3"这类叙述，那些都不该被当成待同步的版本号。
 */
const PATTERNS = [
  // README 的示例标题：`livedtranslate · 浏览器同声传译 v2.66.9`
  { kind: 'title', re: /livedtranslate v(\d+\.\d+\.\d+)/g },
  // README 顶部的徽章：`badge/version-2.66.9-blue`（不含 `v` 前缀，上面那个抓不到）
  { kind: 'badge', re: /badge\/version-(\d+\.\d+\.\d+)-/g },
];

/**
 * 把一行里所有"真正的版本号引用"抽出来。
 * @returns {{kind: 'title'|'badge', version: string}[]}
 */
export function extractVersionRefs(line) {
  const out = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0; // 带 g 的正则是有状态的，复用前必须复位
    let m;
    while ((m = re.exec(line)) !== null) out.push({ kind, version: m[1] });
  }
  return out;
}

/**
 * 扫一份文档，返回所有版本号引用（带行号与原文，便于打印给人看）。
 * @returns {{kind: string, version: string, rel: string, line: number, text: string}[]}
 */
export function scanVersionRefs(text, rel) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const r of extractVersionRefs(line)) {
      out.push({ ...r, rel, line: i + 1, text: line.trim() });
    }
  });
  return out;
}
