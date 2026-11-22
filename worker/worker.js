/**
 * 白色失明文字麻将 · 声网 Token 签发 Worker
 * ------------------------------------------------------------
 * 作用：玩家浏览器来要一张临时通行证（token），这里用私章
 *      （AppCertificate）签好给他。私章只存在本 Worker 的环境变量，
 *      永远不会下发到任何人的浏览器。
 *
 * 需要配置的环境变量（Settings → Variables and Secrets，都选 Secret）：
 *   AGORA_APP_ID     你的 AppID
 *   AGORA_APP_CERT   你的 AppCertificate（私章）
 *
 * 可选（都可以不设，用默认值）：
 *   ALLOWED_ORIGINS  允许调用它的来源，逗号分隔，默认 * （不限制）
 *   TOKEN_TTL_SEC    通行证有效期秒数，默认 3600
 *   RATE_PER_MIN     单 IP 每分钟最多要几张，默认 30
 *
 * 路由：
 *   GET /api/token?uid=玩家ID    -> { appId, token, ttl, expireAt }
 *   GET /health                  -> { ok: true }
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

// ---------- 响应头 ----------
function corsHeaders(origin, allowCfg) {
  const allowAll = !allowCfg || allowCfg.trim() === '*';
  let allowOrigin = '*';
  if (!allowAll) {
    const list = allowCfg.split(',').map(s => s.trim()).filter(Boolean);
    allowOrigin = list.includes(origin) ? origin : (list[0] || '');
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin'
  };
}

// ---------- 简易限流（单 isolate 内存内，够用级别） ----------
const rlBuckets = new Map();
function rateLimited(ip, perMin) {
  const windowKey = Math.floor(Date.now() / 60000);
  const key = ip + '|' + windowKey;
  const n = (rlBuckets.get(key) || 0) + 1;
  rlBuckets.set(key, n);
  if (rlBuckets.size > 5000) {
    for (const k of rlBuckets.keys()) {
      if (!k.endsWith('|' + windowKey)) rlBuckets.delete(k);
    }
  }
  return n > perMin;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (url.pathname !== '/api/token') {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
    }

    const appId = (env.AGORA_APP_ID || '').trim();
    const appCert = (env.AGORA_APP_CERT || '').trim();
    if (!appId || !appCert) {
      return new Response(JSON.stringify({
        error: 'server not configured',
        hint: '请在 Settings → Variables and Secrets 添加 AGORA_APP_ID 和 AGORA_APP_CERT'
      }), { status: 500, headers });
    }

    const rawUid = (url.searchParams.get('uid') || '').trim();
    const uid = rawUid.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
    if (!uid) {
      return new Response(JSON.stringify({ error: 'uid required' }), { status: 400, headers });
    }

    const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    const perMin = parseInt(env.RATE_PER_MIN || '30', 10);
    if (rateLimited(ip, perMin)) {
      return new Response(JSON.stringify({ error: 'too many requests' }), { status: 429, headers });
    }

    const ttl = Math.min(Math.max(parseInt(env.TOKEN_TTL_SEC || '3600', 10), 60), 86400);

    try {
      const token = await generateRtmToken(appId, appCert, uid, ttl);
      return new Response(JSON.stringify({
        appId,
        token,
        ttl,
        expireAt: Date.now() + ttl * 1000
      }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'sign failed' }), { status: 500, headers });
    }
  }
};
