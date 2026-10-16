// 按"锚点"改文件的共用守卫。
//
// ⚠️ 为什么需要它（同一个坑出现过三次）：
//   替换的目标字符串**不存在** → 什么也没改 → 但脚本认为成功了 → 继续往下走
//     · tools/README.md 的 `# 335 项`（正则少考虑了 `#`）→ 没改成
//     · 同一处 `# 91 项` → 没改成，而那次更糟：在 manifest-check 红着的时候就提交并升了版本
//   …而**变异测试脚本里早就有这个守卫**（先数锚点出现次数），只是没有推广到别处。
//
// 所以：任何"按锚点改文件"的地方都应该走这里，而不是自己写一遍 replace。
//
// ⚠️ 拆成两层，是为了让**判断逻辑可测**：
//   planReplace  —— 纯函数，不碰文件系统（smoke-test 能真调它断言）
//   applyReplace —— 薄薄一层 I/O，只负责读/写 + 把 planReplace 的错误抛出去
//
// ⚠️ 读写都用显式 utf8 —— 这个项目被编码问题咬过五次（PowerShell 的 Set-Content 默认 GBK）。

import fs from 'node:fs';

/**
 * 规划一次（或一批）锚点替换。**纯函数，不改文件。**
 *
 * @param {string} text 原文本
 * @param {Array<{find:string, replace:string, expect?:number, label?:string}>} pairs
 *        要做的替换。`expect` 默认 1（锚点必须**恰好**出现 1 次）。
 * @param {{expect?:number}} [opts] 给所有 pairs 的默认 expect
 * @returns {{ok:boolean, out:string, errors:Array<{index:number,label:string,find:string,count:number,expect:number,reason:string}>}}
 *          `ok:false` 时 **`out` 等于原文**（绝不半改）。
 */
export function planReplace(text, pairs, opts = {}) {
  const src = typeof text === 'string' ? text : '';
  const list = Array.isArray(pairs) ? pairs : [];
  const defExpect = Number.isInteger(opts.expect) ? opts.expect : 1;
  const errors = [];

  // 空列表：什么都不做，算成功（调用方不该拿它当"改过了"）
  if (list.length === 0) return { ok: true, out: src, errors };

  // —— 第一遍：全部校验，一个都不改 ——
  for (let i = 0; i < list.length; i++) {
    const p = list[i] || {};
    const find = typeof p.find === 'string' ? p.find : '';
    const label = typeof p.label === 'string' && p.label ? p.label : `#${i + 1}`;
    const expect = Number.isInteger(p.expect) ? p.expect : defExpect;

    if (!find) {
      errors.push({ index: i, label, find, count: -1, expect, reason: '锚点是空字符串' });
      continue;
    }
    const count = src.split(find).length - 1;
    if (count !== expect) {
      errors.push({
        index: i, label, find, count, expect,
        reason: count === 0 ? '锚点不存在' : count === 1 ? '锚点次数不符' : '锚点有歧义（出现多次）',
      });
    }
  }
  if (errors.length) return { ok: false, out: src, errors }; // ← 原文，绝不半改

  // —— 第二遍：按顺序施加 ——
  // ⚠️ 用 split/join 而不是 String.replace，有两个原因，都不是洁癖：
  //   ① replace 只替换**第一处** —— 而 expect > 1 时我们要替换全部（这个 bug 是断言抓出来的）
  //   ② replace 会把替换串里的 `$&` / `$1` 当成特殊语法 —— split/join 一律按字面处理
  // ⚠️ 顺序施加，所以后面的 find 看到的是前面替换后的文本。
  //    一批里若两个锚点互相重叠，请在调用方拆成两次调用。
  let out = src;
  for (const p of list) out = out.split(p.find).join(p.replace);

  return { ok: true, out, errors };
}

/**
 * 把一批锚点替换写进文件。**要么全部改，要么一个字节都不动。**
 *
 * @throws {Error} 校验失败（信息里说清**哪个文件、哪个锚点、出现了几次、期望几次**）
 */
export function applyReplace(file, pairs, opts = {}) {
  const before = fs.readFileSync(file, 'utf8');
  const plan = planReplace(before, pairs, opts);
  if (!plan.ok) {
    const lines = plan.errors.map(
      (e) =>
        `  · [${e.label}] ${e.reason}：出现 ${e.count} 次（期望 ${e.expect}）\n` +
        `    锚点: ${JSON.stringify(e.find.length > 120 ? e.find.slice(0, 120) + '…' : e.find)}`,
    );
    throw new Error(
      `锚点校验失败，文件未改动：${file}\n${lines.join('\n')}\n` +
        `  ⚠️ 锚点写错时会"静默什么都没改" —— 先读一眼文件里到底长什么样（注意空格和 # 这类符号）。`,
    );
  }
  if (plan.out !== before) fs.writeFileSync(file, plan.out, 'utf8');
  return { changed: plan.out !== before, bytes: Buffer.byteLength(plan.out, 'utf8') };
}

/**
 * 校验但不写。给"先 dry-run 一遍"用。
 * @returns {{ok:boolean, errors:Array}}
 */
export function checkReplace(file, pairs, opts = {}) {
  const plan = planReplace(fs.readFileSync(file, 'utf8'), pairs, opts);
  return { ok: plan.ok, errors: plan.errors };
}
