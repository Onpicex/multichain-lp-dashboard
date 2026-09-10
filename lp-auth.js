// LP 仪表盘登录 — 2026-09-09 由 nginx Basic Auth 弹窗改为登录页模式
//
// 【与 stock/meme 那套完全独立】(用户 2026-09-09 明确要求账号密码不通用):
//   独立用户库 auth-users-lp.json、独立 cookie(lpauth)、独立进程(5179)。
//   两套之间没有任何共享凭据; lpauth 不带 Domain => host-only, 不会外泄到别的子域。
//
// 【把关的仍然是 nginx，不是这里】
//   5179 只监听 127.0.0.1, nginx 是唯一入口, 由 `map $cookie_lpauth $lp_ok` 判断放行,
//   未持有效 cookie 的请求 302 到 /login (API 路径返 401), 根本到不了本进程。
//   本模块只做一件事: 校验用户名口令, 校验通过就下发那个 nginx 认识的 token。
//   这样保留了「失败即锁死」而非「失败即敞开」的失效方向 —— 万一本模块出错,
//   最坏结果是登不进去, 而不是钱包数据裸奔。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR        = __dirname;
const USERS_FILE = path.join(DIR, 'auth-users-lp.json');
const TOKEN_FILE = path.join(DIR, '.lpauth-token');   // 与 nginx map 里的值必须一致
const COOKIE     = 'lpauth';
const TTL_SEC    = 365 * 24 * 3600;                   // 1 年

const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPw(pw, saltHex) {
  return crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32, SCRYPT).toString('hex');
}
function makeUser(u, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { u: String(u), salt, hash: hashPw(pw, salt) };
}
function loadUsers() {
  try {
    const j = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(j.users) ? j.users : [];
  } catch (_) { return []; }
}
function loadToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { return null; }
}

// ---- 登录失败限流 (内存, 按 IP) ----
const FAILS = new Map();
const MAX_FAIL = 8, LOCK_MS = 15 * 60 * 1000;
function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] ||
         (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
function locked(ip) {
  const f = FAILS.get(ip);
  if (!f) return 0;
  if (Date.now() > f.until) { FAILS.delete(ip); return 0; }
  return f.n >= MAX_FAIL ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFail(ip) {
  const f = FAILS.get(ip) || { n: 0, until: 0 };
  f.n += 1; f.until = Date.now() + LOCK_MS;
  FAILS.set(ip, f);
}

// cookie 不带 Domain => host-only, 与 stock/meme 的 .fucklp.com 作用域互不干扰
function cookieAttrs(req, maxAgeSec) {
  const a = [`Path=/`, `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax'];
  if (req.headers['x-forwarded-proto'] === 'https') a.push('Secure');
  return a.join('; ');
}

function mountLpAuth(app) {
  app.post('/api/lp-auth/login', (req, res) => {
    const ip = clientIp(req);
    const wait = locked(ip);
    if (wait) return res.status(429).json({ ok: false, error: `尝试过于频繁，请 ${Math.ceil(wait / 60)} 分钟后再试` });

    const token = loadToken();
    if (!token) return res.status(500).json({ ok: false, error: '服务端未配置登录令牌' });

    const u  = String((req.body && req.body.user) || '').trim();
    const pw = String((req.body && req.body.pass) || '');
    const rec = loadUsers().find(x => x.u === u);
    // 用户不存在时也跑一次 scrypt, 让耗时一致 (防用户名枚举)
    const ok = rec ? crypto.timingSafeEqual(Buffer.from(hashPw(pw, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex'))
                   : (hashPw(pw, '00'.repeat(16)), false);
    if (!ok) { noteFail(ip); return res.status(401).json({ ok: false, error: '用户名或密码错误' }); }

    FAILS.delete(ip);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req, TTL_SEC)}`);
    res.json({ ok: true, user: u });
  });

  app.post('/api/lp-auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req, 0)}`);
    res.json({ ok: true });
  });
}

module.exports = { mountLpAuth, makeUser, USERS_FILE, TOKEN_FILE };
