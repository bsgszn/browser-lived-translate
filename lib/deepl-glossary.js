// DeepL 官方术语表（Glossary）接入。
//
// DeepL 是三家翻译服务里唯一有**正式术语表 API** 的：
//   1. POST /v2/glossaries 建一份术语表，拿到 glossary_id
//   2. 之后每次翻译请求带上 glossary_id，DeepL 保证遵守
//
// 讲究的地方：
//   · 建术语表要花钱花配额，所以按「服务地址+语言对+内容哈希」缓存 id，内容没变就复用
//   · 内容变了要重建，顺便删掉旧的，否则很快撞上账号的术语表数量上限
//   · **DeepL 不允许在 source_lang=auto 时使用术语表**，所以源语言必须显式指定；
//     没指定就明确回报原因，让上层能提示用户，而不是静默失效

const CACHE_KEY = 'livedub.deeplGlossary';
/** 失败也要记住，否则每一次翻译都会再撞一次同样的墙 */
const FAIL_TTL_MS = 10 * 60 * 1000;

/** djb2，够用的短哈希 */
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function readCache() {
  try {
    const raw = await chrome.storage.local.get(CACHE_KEY);
    return raw?.[CACHE_KEY] || null;
  } catch {
    return null;
  }
}

async function writeCache(value) {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: value });
  } catch {
    /* ignore */
  }
}

/**
 * 确保存在一份与当前术语内容匹配的 DeepL 术语表。
 * @returns {Promise<{id: string|null, reason: string}>}
 */
export async function ensureDeepLGlossary({ apiKey, pro, source, target, entries, signal }) {
  if (!apiKey) return { id: null, reason: 'no-key' };
  if (!entries?.length) return { id: null, reason: 'no-entries' };
  if (!source || source === 'auto') {
    // DeepL 的硬性限制：术语表必须绑定具体源语言
    return { id: null, reason: 'source-auto' };
  }

  const host = pro ? 'https://api.deepl.com' : 'https://api-free.deepl.com';
  const src = String(source).toUpperCase().split('-')[0];
  const tgt = String(target).toUpperCase();
  const tsv = entries.map((e) => `${e.from}\t${e.to}`).join('\n');
  const key = hash(`${host}|${src}|${tgt}|${tsv}`);

  const cached = await readCache();
  if (cached?.key === key) {
    if (cached.id) return { id: cached.id, reason: 'cached' };
    // 失败缓存还没过期：直接复用结论，别再打一次网络请求。
    // 少了这一段，每一句字幕都会额外发一个注定失败的请求——
    // 既拖慢翻译，又会把同一条错误刷满诊断面板。
    if (cached.error && Date.now() - (cached.failedAt || 0) < FAIL_TTL_MS) {
      return { id: null, reason: cached.error, cachedFailure: true };
    }
  }

  const headers = {
    Authorization: `DeepL-Auth-Key ${apiKey}`,
    'Content-Type': 'application/json',
  };

  /** 把 DeepL 的原话挖出来——它比我们任何猜测都有用 */
  const readError = async (res) => {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const j = JSON.parse(text);
        detail = j?.message || j?.detail || text;
      } catch {
        detail = text;
      }
    } catch {
      /* ignore */
    }
    const trace = res.headers?.get?.('X-Trace-ID') || '';
    return { detail: String(detail || '').trim().slice(0, 300), trace };
  };

  // 先建新的，成功了再删旧的——反过来的话中途失败就两头空
  let created;
  try {
    const res = await fetch(`${host}/v2/glossaries`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        name: `livedub-${src}-${tgt}-${key}`,
        source_lang: src,
        target_lang: tgt,
        entries: tsv,
        entries_format: 'tsv',
      }),
    });
    if (!res.ok) {
      const { detail, trace } = await readError(res);
      const reason = `create-failed-${res.status}${detail ? ':' + detail : ''}${trace ? ` [X-Trace-ID ${trace}]` : ''}`;
      await writeCache({ key, error: reason, failedAt: Date.now() });
      return { id: null, reason };
    }
    created = await res.json();
  } catch (e) {
    const reason = `create-error:${e?.message || e}`;
    await writeCache({ key, error: reason, failedAt: Date.now() });
    return { id: null, reason };
  }

  const id = created?.glossary_id || null;
  if (!id) {
    const reason = 'no-glossary-id';
    await writeCache({ key, error: reason, failedAt: Date.now() });
    return { id: null, reason };
  }

  if (cached?.id && cached.id !== id) {
    // 尽力而为地清理旧的，失败不影响本次使用
    try {
      await fetch(`${host}/v2/glossaries/${cached.id}`, { method: 'DELETE', headers, signal });
    } catch {
      /* ignore */
    }
  }

  await writeCache({ key, id, createdAt: Date.now(), entryCount: entries.length });
  return { id, reason: 'created' };
}

/** 设置页「测试翻译」之外的自检入口：把当前缓存情况读出来 */
export async function getDeepLGlossaryCache() {
  return readCache();
}
