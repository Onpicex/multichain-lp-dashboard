// 2026-10-15: Solana RPC 出口统一层 —— Helius 当主节点后, 全进程对 Helius 的请求都从这里出去:
//   1. 限速: 免费档 10 req/s (gPA 5/s)、DAS/Enhanced 2 req/s; 仓位轮 (web3 Connection)、账本 (sol-ledger 裸 fetch)、充提 (flows) 共用同一组令牌桶, 彼此不会把对方顶到 429
//   2. 省积分: web3 的 getProgramAccounts (10 积分) 改写成 Helius 专有 getProgramAccountsV2 (1 积分), 翻页拼回 V1 响应形状; V2 报错回退 V1
//   3. 计量: 按 Helius 定价估算本月消耗 (≈, 估算值; 以 Helius 控制台为准), 落盘 helius-meter-sol.json, 仓位轮超预算自动走备胎 (账本没有替代源, 不挡)
//   SOL_RPC / SOL_RPC_FALLBACK 填 "helius" 即展开为 mainnet.helius-rpc.com?api-key=<HELIUS_KEY> —— key 只在 .env 里写一次, 日志一律脱敏 (maskUrl)
const { Connection } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const HELIUS_RPC_HOST = 'mainnet.helius-rpc.com';
function heliusKey() { return (process.env.HELIUS_KEY || '').trim(); }
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
const rpcLimiter = url => isHelius(url) ? limiters.helius : limiters.other;

// ---- 积分计量 (估算) ----
// 定价 (helius.dev/docs/billing/credits, 2026-10-15): 普通 RPC 1 / getProgramAccounts 10 / getProgramAccountsV2 1 / Enhanced Transactions API 100 / DAS 10
const METER_FILE = path.join(__dirname, 'helius-meter-sol.json');
const BUDGET = +process.env.SOL_HELIUS_BUDGET || 950000;   // 免费档 1,000,000/月; 仓位轮估算超过这个数就走备胎, 留 5% 给账本
const CREDITS = { getProgramAccounts: 10, getProgramAccountsV2: 1, 'enhanced': 100 };
const creditsOf = m => CREDITS[m] ?? 1;
let meter = null, meterDirty = false;
function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }   // UTC 自然月 (Helius 重置日以控制台为准, 这里只做粗估)
function loadMeter() {
  if (meter) return meter;
  try { const m = JSON.parse(fs.readFileSync(METER_FILE, 'utf8')); if (m && typeof m === 'object' && typeof m.credits === 'number') meter = m; } catch {}
  if (!meter || meter.month !== monthKey()) meter = { month: monthKey(), credits: 0, byMethod: {}, days: {} };
  return meter;
}
function saveMeter() {
  if (!meterDirty) return; meterDirty = false;
  try { const tmp = METER_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(loadMeter())); fs.renameSync(tmp, METER_FILE); } catch (e) { console.error('[SOL] helius-meter 落盘失败:', String(e?.message || e).slice(0, 80)); }
}
setInterval(saveMeter, 30 * 1000).unref();
const roundTally = { credits: 0, calls: 0 };   // 仓位轮内累计, 由 adapter 在 Fetch complete 时读走并清零
function add(method, n = 1) {
  const m = loadMeter();
  if (m.month !== monthKey()) { meter = null; return add(method, n); }
  const c = creditsOf(method) * n;
  m.credits += c; m.byMethod[method] = (m.byMethod[method] || 0) + n;
  const day = new Date().toISOString().slice(0, 10); m.days[day] = (m.days[day] || 0) + c;
  roundTally.credits += c; roundTally.calls += n;
  meterDirty = true;
  return c;
}
function monthCredits() { return loadMeter().credits; }
function overBudget() { return monthCredits() >= BUDGET; }
function takeRound() { const r = { ...roundTally }; roundTally.credits = 0; roundTally.calls = 0; return r; }
function meterSummary() { const m = loadMeter(); return { month: m.month, credits: m.credits, budget: BUDGET, estimated: true }; }

// ---- 账本/充提 裸 fetch 用: 限速 + 计量 (调用方拿到 200 后再 add) ----
async function heliusFetch(kind, url, init) {
  await (kind === 'enhanced' ? limiters.enhanced : limiters.helius).take();
  return fetch(url, init);
}

// ---- web3 Connection: 自定义 fetch (限速 + gPA→V2 + 计量) ----
let v2Broken = false;   // V2 一旦报错 (方法不存在/参数不认), 本进程后续不再尝试, 回到 V1
async function gpaV2(url, req, init) {
  const [program, cfg0] = req.params || [];
  const cfg = { ...(cfg0 && typeof cfg0 === 'object' ? cfg0 : { commitment: cfg0 }), limit: 10000 };
  delete cfg.paginationKey;
  const withCtx = !!cfg.withContext; delete cfg.withContext;
  const accounts = []; let pageKey = null, context = null;
  for (let page = 0; page < 50; page++) {
    await limiters.heliusGpa.take();
    const body = JSON.stringify({ jsonrpc: '2.0', id: req.id, method: 'getProgramAccountsV2', params: [program, pageKey ? { ...cfg, paginationKey: pageKey } : cfg] });
    const r = await fetch(url, { ...init, body });
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
  const helius = isHelius(url), lim = rpcLimiter(url);
  return async function solFetch(input, init = {}) {
    let req = null; try { req = JSON.parse(init.body); } catch {}
    const reqs = Array.isArray(req) ? req : (req ? [req] : []);
    if (helius && reqs.length === 1 && reqs[0].method === 'getProgramAccounts' && !v2Broken) {
      try {
        const out = await gpaV2(url, reqs[0], init);
        return new Response(out.text, { status: out.status, headers: { 'content-type': 'application/json' } });
      } catch (e) { v2Broken = true; console.error('[SOL] getProgramAccountsV2 不可用, 回退 V1 (10 积分/次):', String(e?.message || e).slice(0, 100)); }
    }
    for (const r of reqs) await (helius && r.method === 'getProgramAccounts' ? limiters.heliusGpa : lim).take();
    const res = await fetch(input, init);
    if (helius && res.status === 200) for (const r of reqs) add(r.method);
    return res;
  };
}
function mkConn(url, commitment = 'confirmed') {
  return new Connection(url, { commitment, fetch: mkFetch(url) });
}

module.exports = { resolve, isHelius, maskUrl, mkConn, heliusFetch, add, monthCredits, overBudget, takeRound, meterSummary, saveMeter, BUDGET, _limiters: limiters };
