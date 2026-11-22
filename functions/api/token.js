/**
 * 白色失明文字麻将 · 联机通行证签发（Cloudflare Pages Function）
 * ------------------------------------------------------------
 * 路由：GET /api/token?uid=玩家ID   ->  { appId, token, ttl, expireAt }
 *       GET /api/health            ->  { ok: true }
 *
 * 为什么放在 Pages 而不是独立 Worker：
 *   workers.dev 在国内常被 DNS 污染，玩家拿不到 token 就进不了联机。
 *   Pages 的 *.pages.dev 域名可正常解析，把接口放在同域名下即可绕开。
 *
 * 环境变量（Cloudflare Pages → Settings → Environment variables）：
 *   AGORA_APP_ID     你的 AppID
 *   AGORA_APP_CERT   你的 AppCertificate（加密存储，务必设为 Secret）
 * 可选：
 *   TOKEN_TTL_SEC    通行证有效期秒数，默认 10800（3 小时）
 *   RATE_PER_MIN     单 IP 每分钟最多请求数，默认 30
 */

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32Str(str) {
  const bytes = new TextEncoder().encode(str);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------- 小端字节缓冲 ----------
function ByteBuf() { this.buf = new Uint8Array(512); this.pos = 0; }
ByteBuf.prototype.ensure = function (n) {
  if (this.pos + n > this.buf.length) {
    const nb = new Uint8Array(this.buf.length * 2);
    nb.set(this.buf);
    this.buf = nb;
  }
};
ByteBuf.prototype.u16 = function (v) {
  this.ensure(2);
  this.buf[this.pos] = v & 0xFF;
  this.buf[this.pos + 1] = (v >>> 8) & 0xFF;
  this.pos += 2;
  return this;
};
ByteBuf.prototype.u32 = function (v) {
  this.ensure(4);
  this.buf[this.pos] = v & 0xFF;
  this.buf[this.pos + 1] = (v >>> 8) & 0xFF;
  this.buf[this.pos + 2] = (v >>> 16) & 0xFF;
  this.buf[this.pos + 3] = (v >>> 24) & 0xFF;
  this.pos += 4;
  return this;
};
ByteBuf.prototype.bytes = function (b) {
  this.u16(b.length);
  this.ensure(b.length);
  this.buf.set(b, this.pos);
  this.pos += b.length;
  return this;
};
ByteBuf.prototype.mapU32 = function (map) {
  const keys = Object.keys(map);
  this.u16(keys.length);
  for (let i = 0; i < keys.length; i++) {
    this.u16(parseInt(keys[i], 10));
    this.u32(map[keys[i]]);
  }
  return this;
};
ByteBuf.prototype.pack = function () { return this.buf.slice(0, this.pos); };

function concatBytes(arr) {
  let total = 0;
  for (let i = 0; i < arr.length; i++) total += arr[i].length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < arr.length; i++) { out.set(arr[i], pos); pos += arr[i].length; }
  return out;
}

function u8ToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

async function hmacSha256(keyStr, msgBytes) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

// ---------- 签发 RTM token ----------
async function generateRtmToken(appId, appCert, uid, expireSec) {
  const kRtmLogin = 1000;
  const salt = (Math.random() * 0xFFFFFFFF) >>> 0;
  const ts = Math.floor(Date.now() / 1000) + (expireSec || 3600);

  const messages = {};
  messages[kRtmLogin] = ts;

  const mBuf = new ByteBuf();
  mBuf.u32(salt).u32(ts).mapU32(messages);
  const m = mBuf.pack();

  const toSign = concatBytes([
    new TextEncoder().encode(appId),
    new TextEncoder().encode(uid),
    new TextEncoder().encode(''),
    m
  ]);
  const sig = await hmacSha256(appCert, toSign);

  const crcCh = crc32Str(uid);
  const crcUid = crc32Str('');

  const cBuf = new ByteBuf();
  cBuf.bytes(sig).u32(crcCh).u32(crcUid).bytes(m);

  return '006' + appId + u8ToB64(cBuf.pack());
}

// ---------- 限流（单 isolate 内存内） ----------
const rlBuckets = new Map();
function rateLimited(ip, perMin) {
  const win = Math.floor(Date.now() / 60000);
  const key = ip + '|' + win;
  const n = (rlBuckets.get(key) || 0) + 1;
  rlBuckets.set(key, n);
  if (rlBuckets.size > 5000) {
    for (const k of rlBuckets.keys()) {
      if (!k.endsWith('|' + win)) rlBuckets.delete(k);
    }
  }
  return n > perMin;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === '/api/health') {
    return json({ ok: true });
  }

  const appId = (env.AGORA_APP_ID || '').trim();
  const appCert = (env.AGORA_APP_CERT || '').trim();
  if (!appId || !appCert) {
    return json({ error: 'server not configured', hint: '请在 Pages 设置里添加 AGORA_APP_ID 和 AGORA_APP_CERT' }, 500);
  }

  const rawUid = (url.searchParams.get('uid') || '').trim();
  const uid = rawUid.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
  if (!uid) return json({ error: 'uid required' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const perMin = parseInt(env.RATE_PER_MIN || '30', 10);
  if (rateLimited(ip, perMin)) return json({ error: 'too many requests' }, 429);

  const ttl = Math.min(Math.max(parseInt(env.TOKEN_TTL_SEC || '10800', 10), 60), 86400);

  try {
    const token = await generateRtmToken(appId, appCert, uid, ttl);
    return json({ appId, token, ttl, expireAt: Date.now() + ttl * 1000 });
  } catch (e) {
    return json({ error: 'sign failed' }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}
