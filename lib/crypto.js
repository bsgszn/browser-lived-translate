// 翻译服务商要用的散列与签名。
//
// 为什么不直接用 WebCrypto：**`crypto.subtle` 不支持 MD5**，而百度翻译的签名
// 恰恰就是 `MD5(appid + q + salt + key)`。所以这里自带一份 MD5 实现。
// SHA-1 / SHA-256 / HMAC 则走 WebCrypto（原生、快、不容易写错）。
//
// ⚠️ 这个文件里的每个函数都有对应的测试向量断言 —— 签名算错了，服务端只会回
// 一句"签名不匹配"，没有别的线索，所以必须靠测试向量钉死。

/** 字节数组 → 小写十六进制 */
export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16);
  return s;
}

/** 字符串 → UTF-8 字节 */
export function utf8(str) {
  return new TextEncoder().encode(String(str));
}

/* ────────────────────────────── MD5 ────────────────────────────── */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i += 1) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

/**
 * MD5（RFC 1321）。
 *
 * ⚠️ MD5 在密码学上早已不安全，**但这里不是用来做安全的** ——
 * 百度翻译的接口就要求这个签名算法，没有别的选择。不要拿它做任何保密用途。
 *
 * @param {string|Uint8Array} input
 * @returns {string} 32 位小写十六进制
 */
export function md5(input) {
  const msg = typeof input === 'string' ? utf8(input) : input;
  const len = msg.length;
  // 补位：0x80 + 若干 0，使总长 ≡ 56 (mod 64)，再补 8 字节小端长度的比特数
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i += 1) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + (((f << MD5_S[i]) | (f >>> (32 - MD5_S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return toHex(out);
}

/* ─────────────────────── SHA-1 / SHA-256 / HMAC ─────────────────────── */

async function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('当前环境没有 WebCrypto，无法计算签名（需要 https 或扩展页面）');
  return c.subtle;
}

/** SHA-256，返回小写十六进制 */
export async function sha256Hex(input) {
  const s = await subtle();
  const buf = await s.digest('SHA-256', typeof input === 'string' ? utf8(input) : input);
  return toHex(new Uint8Array(buf));
}

/** SHA-1，返回小写十六进制。腾讯/阿里签名要用 */
export async function sha1Hex(input) {
  const s = await subtle();
  const buf = await s.digest('SHA-1', typeof input === 'string' ? utf8(input) : input);
  return toHex(new Uint8Array(buf));
}

/**
 * HMAC。返回原始字节（有些签名要先 HMAC 再当二进制继续用）。
 * @param {'SHA-1'|'SHA-256'} hash
 */
export async function hmac(hash, key, message) {
  // ⚠️ WebCrypto 对零长度 key 抛的是 DataError('Zero-length key is not supported')，
  // 而 RFC 2104 里空 key 是合法的（补零到块长）、Node/OpenSSL 都能算。
  // 这里不比 RFC 更严格，但**必须给出能看懂的错误** —— 否则用户在设置页漏填密钥时，
  // 屏幕上会冒出一句英文的 Zero-length key，完全指不到原因。
  const k = typeof key === 'string' ? utf8(key) : key;
  if (!k || k.length === 0) throw new Error('签名失败：密钥为空（去设置页填写该服务的密钥）');
  const s = await subtle();
  const imported = await s.importKey('raw', k, { name: 'HMAC', hash }, false, ['sign']);
  const sig = await s.sign('HMAC', imported, typeof message === 'string' ? utf8(message) : message);
  return new Uint8Array(sig);
}

/** HMAC，返回小写十六进制 */
export async function hmacHex(hash, key, message) {
  return toHex(await hmac(hash, key, message));
}

/** HMAC-SHA256 的十六进制 —— 腾讯 TC3 签名大量用到 */
export const hmacSha256Hex = (key, msg) => hmacHex('SHA-256', key, msg);
/** HMAC-SHA1 的十六进制 —— 阿里 POP 签名用到 */
export const hmacSha1Hex = (key, msg) => hmacHex('SHA-1', key, msg);
/** HMAC-SHA1 的原始字节 —— 阿里 POP 签名最后一步是 base64(hmac)，要先拿字节 */
export const hmacSha1 = (key, msg) => hmac('SHA-1', key, msg);

/** 字节 → base64（阿里签名最后一步要用） */
export function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** HMAC-SHA1 后直接 base64 —— 阿里 POP 的最终签名 */
export async function hmacSha1Base64(key, msg) {
  return bytesToBase64(await hmacSha1(key, msg));
}
