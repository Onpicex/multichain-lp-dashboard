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
//
// 2026-09-28 审计修复 (本文件): IP 只信 nginx 覆写的 X-Real-IP; scrypt 改异步; FAILS 加上限+定期清扫;
//   坏 hash 不再 500; 用户库/令牌按 mtime 缓存; 登录成功/失败打日志。令牌本身仍只在 .lpauth-token 与
//   /etc/nginx/lp-token.map 两处 (轮换用 tools/rotate-lp-token.sh), 本模块按 mtime 自动重读, 无需重启。
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const DIR        = __dirname;
const USERS_FILE = path.join(DIR, 'auth-users-lp.json');
const TOKEN_FILE = path.join(DIR, '.lpauth-token');   // 与 nginx map 里的值必须一致
const COOKIE     = 'lpauth';
const TTL_SEC    = 365 * 24 * 3600;                   // 1 年
const MAX_USER_LEN = 128, MAX_PW_LEN = 1024;          // 超长输入直接判不通过, 不进 scrypt

const SCRYPT = { N: 16384, r: 8, p: 1 };
// 2026-09-28 审计修复: 请求路径改用异步 scrypt (scryptSync 每次登录卡事件循环 ~50ms, 并发几十个请求就把整站 API 拖住)
const scryptAsync = util.promisify(crypto.scrypt);
async function hashPw(pw, saltHex) {
  const buf = await scryptAsync(String(pw), Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  return buf.toString('hex');
}
// 同步版只给命令行建号 (makeUser) 用, 不在请求路径上
function hashPwSync(pw, saltHex) {
  return crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32, SCRYPT).toString('hex');
}
function makeUser(u, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { u: String(u), salt, hash: hashPwSync(pw, salt) };
}

// 2026-09-28 审计修复: 用户库与令牌文件按 mtime/size/inode 缓存, 变更即重读 (之前每次登录请求都同步读盘两次)
const FILE_CACHE = new Map();   // file → { key, value }
function readCached(file, parse, fallback) {
  try {
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const c = FILE_CACHE.get(file);
    if (c && c.key === key) return c.value;
    const value = parse(fs.readFileSync(file, 'utf8'));
    FILE_CACHE.set(file, { key, value });
    return value;
  } catch (_) { FILE_CACHE.delete(file); return fallback; }
}
function loadUsers() {
  return readCached(USERS_FILE, s => { const j = JSON.parse(s); return Array.isArray(j.users) ? j.users : []; }, []);
}
function loadToken() {
  return readCached(TOKEN_FILE, s => s.trim() || null, null);
}

// ---- 登录失败限流 (内存, 按 IP) ----
const FAILS = new Map();   // ip → { n, until }; Map 保持插入序, 每次记失败都重插到末尾 => 队头即最久没动的
const MAX_FAIL = 8, LOCK_MS = 15 * 60 * 1000;
// 2026-09-28 审计修复: FAILS 加上限 (5000 键, 满了清最旧) + 每 5 分钟清扫过期项, 防海量来源 IP 把 Map 撑爆
const FAILS_MAX_KEYS = 5000, SWEEP_MS = 5 * 60 * 1000;
function sweepFails(now = Date.now()) {
  for (const [ip, f] of FAILS) if (now > f.until) FAILS.delete(ip);
}
const sweepTimer = setInterval(sweepFails, SWEEP_MS);
if (sweepTimer.unref) sweepTimer.unref();   // 不因这个定时器拖住进程退出 (测试脚本也能正常结束)

// 2026-09-28 审计修复: 客户端 IP 只信 nginx 覆写的 x-real-ip (snippet 里 proxy_set_header X-Real-IP $remote_addr, 客户端伪造不了),
//   其次 socket 对端; 不再读 cf-connecting-ip / x-forwarded-for —— 那两个客户端可自带, 能绕过限流或替别人把 IP 锁死
function clientIp(req) {
  const h = req.headers && req.headers['x-real-ip'];
  const ip = (Array.isArray(h) ? h[0] : h) || (req.socket && req.socket.remoteAddress) || '?';
  return String(ip).trim().slice(0, 64) || '?';
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
  FAILS.delete(ip);   // 重插到末尾, 让 Map 队头保持「最久没失败过」的 IP
  if (FAILS.size >= FAILS_MAX_KEYS) FAILS.delete(FAILS.keys().next().value);   // 满了: 淘汰最旧
  FAILS.set(ip, f);
  return f.n;
}

// 2026-09-28 审计修复: 用户库里 hash 长度不符 (手改坏了 / 非 hex) 时 timingSafeEqual 抛 RangeError => 以前直接 500 且不计失败;
//   现在任何异常都算「不通过」走 401
function hashMatches(calcHex, storedHex) {
  try {
    const a = Buffer.from(String(calcHex), 'hex'), b = Buffer.from(String(storedHex || ''), 'hex');
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}
const HEX_RE = /^[0-9a-fA-F]+$/;

// cookie 不带 Domain => host-only, 与 stock/meme 的 .fucklp.com 作用域互不干扰
function cookieAttrs(req, maxAgeSec) {
  const a = [`Path=/`, `Max-Age=${maxAgeSec}`, 'HttpOnly', 'SameSite=Lax'];
  if (req.headers['x-forwarded-proto'] === 'https') a.push('Secure');
  return a.join('; ');
}

function mountLpAuth(app) {
  // 2026-09-28 审计修复: 处理函数改 async (配合异步 scrypt); Express 4 不接 promise 异常, 故整体 try/catch 兜成 500
  app.post('/api/lp-auth/login', async (req, res) => {
    const ip = clientIp(req);
    const u  = String((req.body && req.body.user) || '').trim().slice(0, MAX_USER_LEN);
    const uLog = JSON.stringify(u);   // 日志里转义引号/控制字符, 防日志注入 (不记口令)
    try {
      const wait = locked(ip);
      if (wait) {
        console.warn(`[lp-auth] 登录拒绝(锁定中, 剩 ${wait}s) user=${uLog} ip=${ip}`);
        return res.status(429).json({ ok: false, error: `尝试过于频繁，请 ${Math.ceil(wait / 60)} 分钟后再试` });
      }

      const token = loadToken();
      if (!token) return res.status(500).json({ ok: false, error: '服务端未配置登录令牌' });

      const pw = String((req.body && req.body.pass) || '');
      const rec = loadUsers().find(x => x && x.u === u);
      const saltOk = !!(rec && typeof rec.salt === 'string' && rec.salt.length >= 2 && HEX_RE.test(rec.salt));
      // 用户不存在 (或记录坏了) 时也跑一次 scrypt, 让耗时一致 (防用户名枚举); 超长口令不进 scrypt 直接判不通过
      let ok = false;
      if (pw.length <= MAX_PW_LEN) {
        const calc = await hashPw(pw, saltOk ? rec.salt : '00'.repeat(16));
        ok = saltOk ? hashMatches(calc, rec.hash) : false;
      }
      if (!ok) {
        const n = noteFail(ip);
        // 2026-09-28 审计修复: 成功/失败各一行日志 (含 IP、用户名, 不含口令)
        console.warn(`[lp-auth] 登录失败 user=${uLog} ip=${ip} fails=${n}/${MAX_FAIL}`);
        return res.status(401).json({ ok: false, error: '用户名或密码错误' });
      }

      FAILS.delete(ip);
      console.log(`[lp-auth] 登录成功 user=${uLog} ip=${ip}`);
      res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(req, TTL_SEC)}`);
      res.json({ ok: true, user: u });
    } catch (e) {
      console.error(`[lp-auth] 登录处理异常 ip=${ip}:`, e && e.message);
      if (!res.headersSent) res.status(500).json({ ok: false, error: '服务端错误' });
    }
  });

  app.post('/api/lp-auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(req, 0)}`);
    res.json({ ok: true });
  });
}

module.exports = {
  mountLpAuth, makeUser, USERS_FILE, TOKEN_FILE,
  _test: { clientIp, locked, noteFail, sweepFails, hashMatches, readCached, FAILS, FAILS_MAX_KEYS, MAX_FAIL, LOCK_MS },
};
