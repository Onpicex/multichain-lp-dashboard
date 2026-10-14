// 2026-10-15: Solana RPC 出口统一层 —— Helius 当主节点后, 全进程对 Helius 的请求都从这里出去:
//   1. 限速: 免费档 10 req/s (gPA 5/s)、DAS/Enhanced 2 req/s; 仓位轮 (web3 Connection)、账本 (sol-ledger 裸 fetch)、充提 (flows) 共用同一组令牌桶, 彼此不会把对方顶到 429
//   2. 省积分: web3 的 getProgramAccounts (10 积分) 改写成 Helius 专有 getProgramAccountsV2 (1 积分), 翻页拼回 V1 响应形状; V2 报错回退 V1
//   3. 计量: 按 Helius 定价估算本月消耗 (≈, 估算值; 以 Helius 控制台为准), 落盘 helius-meter-sol.json, 按 key 分账
//   4. 多账号顺序接力 (10-15): HELIUS_KEY / HELIUS_KEY_2 / HELIUS_KEY_3 … 同一时刻只用一把; 当前这把的月积分用尽
//      (Helius 回 429 "max usage reached", 或本地估算 ≥ SOL_HELIUS_BUDGET) 才切下一把, 同一请求原地换 key 重发, 调用方无感;
//      用尽的 key 每 SOL_HELIUS_REPROBE_MS (默认 6 小时) 再探一次, 探通 (Helius 按各自计费周期重置, 不一定是自然月) 就回到靠前的 key;
//      全部用尽 → 本地直接回 429 不出网, 仓位轮走备胎、账本等下一轮
//   SOL_RPC / SOL_RPC_FALLBACK 填 "helius" 即展开为 mainnet.helius-rpc.com?api-key=<HELIUS_KEY>; 真正发请求时按当前接力到的 key 改写 url
//   key 只在 .env 里写; 日志/落盘只出现 sha256 前 8 位指纹, url 一律脱敏 (maskUrl)
const { Connection } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HELIUS_RPC_HOST = 'mainnet.helius-rpc.com';
const KEY_ENVS = ['HELIUS_KEY', 'HELIUS_KEY_2', 'HELIUS_KEY_3', 'HELIUS_KEY_4', 'HELIUS_KEY_5'];
let keysCache = null;
function heliusKeys() {
  if (!keysCache) keysCache = [...new Set(KEY_ENVS.map(e => (process.env[e] || '').trim()).filter(Boolean))];
  return keysCache;
}
function heliusKey() { return heliusKeys()[0] || ''; }
function keyCount() { return heliusKeys().length; }
const fpOf = k => crypto.createHash('sha256').update(k).digest('hex').slice(0, 8);
function resolve(v, dflt) {
  const s = (v || '').trim();
  if (!s) return dflt;
  if (s.toLowerCase() === 'helius') {
    if (!heliusKey()) { console.error('[SOL] SOL_RPC=helius 但 HELIUS_KEY 为空, 退回公共节点'); return dflt; }
    return `https://${HELIUS_RPC_HOST}/?api-key=${heliusKey()}`;
  }
  return s;
}
function isHelius(url) { try { return new URL(url).host === HELIUS_RPC_HOST; } catch { return false; } }
function maskUrl(url) { return String(url || '').replace(/(api-?key=)[^&]+/i, '$1***'); }
function withKey(url, key) { return String(url).replace(/(api-?key=)[^&]*/i, (_, p) => p + key); }

// ---- 令牌桶 (滑动 1 秒窗) ----
class Limiter {
  constructor(rps) { this.rps = Math.max(1, rps | 0); this.ts = []; this.chain = Promise.resolve(); }
  take() {
    // 串行排队: 并发调用按到达顺序逐个放行, 保证任意 1 秒窗内 ≤ rps 次
    const p = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        while (this.ts.length && now - this.ts[0] >= 1000) this.ts.shift();
        if (this.ts.length < this.rps) { this.ts.push(now); return; }
        await new Promise(r => setTimeout(r, Math.max(5, this.ts[0] + 1000 - now)));
      }
    });
    this.chain = p.catch(() => {});
    return p;
  }
}
const RPS = +process.env.SOL_RPC_RPS || 9;          // Helius 免费档 10/s, 留 1 次余量给计时抖动
const GPA_RPS = +process.env.SOL_RPC_GPA_RPS || 4;  // gPA 5/s
const ENHANCED_RPS = +process.env.SOL_ENHANCED_RPS || 2;
const limiters = { helius: new Limiter(RPS), heliusGpa: new Limiter(GPA_RPS), enhanced: new Limiter(ENHANCED_RPS), other: new Limiter(+process.env.SOL_RPC_RPS_OTHER || 20) };
const limiterOf = kind => kind === 'enhanced' ? limiters.enhanced : kind === 'gpa' ? limiters.heliusGpa : limiters.helius;

// ---- 积分计量 (估算, 按 key 分账) ----
// 定价 (helius.dev/docs/billing/credits, 2026-10-15): 普通 RPC 1 / getProgramAccounts 10 / getProgramAccountsV2 1 / Enhanced Transactions API 100 / DAS 10
const METER_FILE = path.join(__dirname, 'helius-meter-sol.json');
const BUDGET = +process.env.SOL_HELIUS_BUDGET || 1000000;        // 每把 key 的月积分 (免费档 1,000,000); 估算到这个数就先标记用尽、切下一把, 6 小时后再探
const REPROBE_MS = +process.env.SOL_HELIUS_REPROBE_MS || 6 * 3600 * 1000;
const CREDITS = { getProgramAccounts: 10, getProgramAccountsV2: 1, 'enhanced': 100 };
const creditsOf = m => CREDITS[m] ?? 1;
let meter = null, meterDirty = false;
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }   // UTC 自然月 (Helius 按计费周期重置, 这里只做粗估; 真用尽以 429 max usage reached 为准)
function freshMeter(prev) {
  const m = { month: monthKey(), credits: 0, byMethod: {}, days: {}, keys: {} };
  if (prev && prev.month) m.prev = { month: prev.month, credits: prev.credits, keys: Object.fromEntries(Object.entries(prev.keys || {}).map(([fp, s]) => [fp, s.credits])) };
  return m;
}
function loadMeter() {
  if (meter) return meter;
  try { const m = JSON.parse(fs.readFileSync(METER_FILE, 'utf8')); if (m && typeof m === 'object' && typeof m.credits === 'number') meter = m; } catch {}
  if (!meter) meter = freshMeter(null);
  if (!meter.keys) meter.keys = {};
  return meter;
}
function cur() {   // 跨月: 归零 (上月汇总留在 prev), 各 key 的用尽标记一并清掉 (真没重置的话第一发就会 429 max usage 再标回来)
  const m = loadMeter();
  if (m.month !== monthKey()) { meter = freshMeter(m); meterDirty = true; }
  return meter;
}
function saveMeter() {
  if (!meterDirty) return; meterDirty = false;
  try { const tmp = METER_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(loadMeter())); fs.renameSync(tmp, METER_FILE); } catch (e) { console.error('[SOL] helius-meter 落盘失败:', String(e?.message || e).slice(0, 80)); }
}
setInterval(saveMeter, 30 * 1000).unref();
function keyState(fp) { const m = cur(); return m.keys[fp] || (m.keys[fp] = { credits: 0, byMethod: {} }); }
const roundTally = { credits: 0, calls: 0 };   // 仓位轮内累计, 由 adapter 在 Fetch complete 时读走并清零
let lastFp = null;                             // 最近一次真正发出请求用的 key 指纹 (add 默认记到它头上)
function add(method, n = 1, fp = lastFp) {
  const m = cur();
  const c = creditsOf(method) * n;
  m.credits += c; m.byMethod[method] = (m.byMethod[method] || 0) + n;
  const day = new Date().toISOString().slice(0, 10); m.days[day] = (m.days[day] || 0) + c;
  if (fp) { const st = keyState(fp); st.credits += c; st.byMethod[method] = (st.byMethod[method] || 0) + n; }
  roundTally.credits += c; roundTally.calls += n;
  meterDirty = true;
  return c;
}
function monthCredits() { return cur().credits; }
function takeRound() { const r = { ...roundTally }; roundTally.credits = 0; roundTally.calls = 0; return r; }

// ---- 多 key 接力 ----
const EXHAUSTED_RE = /max usage reached/i;   // Helius FAQ: 积分用尽 → "429 max usage reached"; 普通限速 429 是 "Too many requests", 不切 key
const coolingDown = st => !!(st.exhaustedAt && Date.now() < (st.retryAt || 0));
function markExhausted(pick, reason, detail) {
  const st = keyState(pick.fp);
  st.exhaustedAt = Date.now(); st.retryAt = st.exhaustedAt + REPROBE_MS; st.reason = reason;
  meterDirty = true; saveMeter();
  const next = heliusKeys().slice(pick.i + 1).some(k => !coolingDown(keyState(fpOf(k))));
  console.error(`[SOL] Helius 第 ${pick.i + 1}/${keyCount()} 把 key (${pick.fp}) 本周期积分用尽 (${reason === 'server' ? 'Helius 回 429 max usage reached' : '本地估算 ≥ ' + BUDGET}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 80) : ''}), ${next ? '切下一把' : '没有可用的下一把 (仓位轮走备胎, 账本等重置)'}, ${REPROBE_MS >= 3600000 ? Math.round(REPROBE_MS / 3600000) + ' 小时' : Math.round(REPROBE_MS / 60000) + ' 分钟'}后再探`);
}
function unmark(pick) {
  const st = keyState(pick.fp);
  st.base = st.credits;   // 估算从头数 (Helius 那边已重置 / 估算偏高), 否则下一发又被估算标回用尽
  delete st.exhaustedAt; delete st.retryAt; delete st.reason;
  meterDirty = true; saveMeter();
  console.log(`[SOL] Helius 第 ${pick.i + 1}/${keyCount()} 把 key (${pick.fp}) 再探成功, 继续用它`);
}
function choose() {   // 靠前优先: 第一把没用尽 (或冷却到期该再探) 就用第一把; 全部用尽 → exhausted=true (携最后一把, 但调用方不会真发出去)
  const ks = heliusKeys(); if (!ks.length) return null;
  for (let i = 0; i < ks.length; i++) {
    const fp = fpOf(ks[i]), st = keyState(fp);
    if (coolingDown(st)) continue;
    if (!st.exhaustedAt && st.credits - (st.base || 0) >= BUDGET) { markExhausted({ fp, i }, 'estimate'); continue; }
    return { key: ks[i], fp, i, st, exhausted: false };
  }
  const i = ks.length - 1, fp = fpOf(ks[i]);
  return { key: ks[i], fp, i, st: keyState(fp), exhausted: true };
}
let lastPicked = null;
function pickKey() {
  const p = choose(); if (!p) return null;
  const tag = p.fp + (p.exhausted ? '!' : '');
  if (tag !== lastPicked) { lastPicked = tag; console.log(p.exhausted ? `[SOL] Helius ${keyCount()} 把 key 全部用尽/冷却中, 本地直接回 429 不出网` : `[SOL] Helius 当前用第 ${p.i + 1}/${keyCount()} 把 key (${p.fp})`); }
  return p;
}
function overBudget() { const p = choose(); return !!(p && p.exhausted); }
function meterSummary() {
  const m = cur(), p = choose();
  return {
    month: m.month, credits: m.credits, budget: BUDGET, estimated: true,
    active: p && !p.exhausted ? p.i + 1 : null,
    keys: heliusKeys().map((k, i) => { const st = keyState(fpOf(k)); return { n: i + 1, fp: fpOf(k), credits: st.credits, exhausted: coolingDown(st), reason: coolingDown(st) ? st.reason : undefined, since: coolingDown(st) ? st.exhaustedAt : undefined }; }),
    prev: m.prev,
  };
}
const exhaustedResponse = () => new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32005, message: 'max usage reached (all Helius keys exhausted locally, request not sent)' } }), { status: 429, headers: { 'content-type': 'application/json' } });
// 对 Helius 发一次 HTTP: 限速 → 按当前 key 改写 url → 429 max usage reached 就标记用尽、换下一把原地重发
async function heliusSend(kind, url, init) {
  const n = keyCount();
  if (!n) { await limiterOf(kind).take(); return fetch(url, init); }
  for (let hop = 0; hop <= n; hop++) {
    const pick = pickKey();
    if (pick.exhausted) return exhaustedResponse();
    await limiterOf(kind).take();
    lastFp = pick.fp;
    const res = await fetch(withKey(url, pick.key), init);
    if (res.status === 429) {
      let text = ''; try { text = await res.clone().text(); } catch {}
      if (EXHAUSTED_RE.test(text)) { markExhausted(pick, 'server', text); continue; }
    }
    if (res.status === 200 && pick.st.exhaustedAt) unmark(pick);
    return res;
  }
  return exhaustedResponse();
}

// ---- 账本/充提 裸 fetch 用: 限速 + 接力 (调用方拿到 200 后再 add 计量) ----
async function heliusFetch(kind, url, init) { return heliusSend(kind === 'enhanced' ? 'enhanced' : 'rpc', url, init); }

// ---- web3 Connection: 自定义 fetch (限速 + 接力 + gPA→V2 + 计量) ----
let v2Broken = false;   // V2 一旦报错 (方法不存在/参数不认), 本进程后续不再尝试, 回到 V1
async function gpaV2(url, req, init) {
  const [program, cfg0] = req.params || [];
  const cfg = { ...(cfg0 && typeof cfg0 === 'object' ? cfg0 : { commitment: cfg0 }), limit: 10000 };
  delete cfg.paginationKey;
  const withCtx = !!cfg.withContext; delete cfg.withContext;
  const accounts = []; let pageKey = null, context = null;
  for (let page = 0; page < 50; page++) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: req.id, method: 'getProgramAccountsV2', params: [program, pageKey ? { ...cfg, paginationKey: pageKey } : cfg] });
    const r = await heliusSend('gpa', url, { ...init, body });
    if (r.status !== 200) return { status: r.status, text: await r.text() };   // 429 等交回 web3 原生重试逻辑
    const j = JSON.parse(await r.text());
    if (j.error) throw new Error(`V2 ${j.error.code}: ${String(j.error.message).slice(0, 80)}`);
    add('getProgramAccountsV2');
    const res = j.result || {};
    const val = res.value && res.value.accounts ? res.value : res;   // Helius 有无 withContext 两种形状都兼容
    if (res.context) context = res.context;
    accounts.push(...(val.accounts || []));
    pageKey = val.paginationKey || null;
    if (!pageKey) break;
  }
  const result = withCtx ? { context: context || { slot: 0 }, value: accounts } : accounts;
  return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) };
}
function mkFetch(url) {
  const helius = isHelius(url);
  return async function solFetch(input, init = {}) {
    let req = null; try { req = JSON.parse(init.body); } catch {}
    const reqs = Array.isArray(req) ? req : (req ? [req] : []);
    if (!helius) { for (const r of reqs) await limiters.other.take(); return fetch(input, init); }
    if (reqs.length === 1 && reqs[0].method === 'getProgramAccounts' && !v2Broken) {
      try {
        const out = await gpaV2(String(input), reqs[0], init);
        return new Response(out.text, { status: out.status, headers: { 'content-type': 'application/json' } });
      } catch (e) { v2Broken = true; console.error('[SOL] getProgramAccountsV2 不可用, 回退 V1 (10 积分/次):', String(e?.message || e).slice(0, 100)); }
    }
    const res = await heliusSend(reqs.some(r => r.method === 'getProgramAccounts') ? 'gpa' : 'rpc', String(input), init);
    if (res.status === 200) for (const r of reqs) add(r.method);
    return res;
  };
}
function mkConn(url, commitment = 'confirmed') {
  return new Connection(url, { commitment, fetch: mkFetch(url) });
}

module.exports = { resolve, isHelius, maskUrl, mkConn, heliusFetch, add, monthCredits, overBudget, takeRound, meterSummary, saveMeter, keyCount, BUDGET, _limiters: limiters };
