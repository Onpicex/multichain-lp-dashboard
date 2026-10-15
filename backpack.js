// =============================================================
// backpack.js — Backpack 交易所最小接入 (2026-10-16 重做; 上一版「全量接入」五笔已回滚, 留在本地分支 backpack-wip-20261016)
//   只做三件事, 充提口径不变 (钱进出这条链照记):
//   ① 公开行情 (免 key): Solana 上 Backpack 股票代币 (DJT.US / CBRS.US / SKHY.US …; mint ↔ ticker 由 /api/v1/assets 反查) 的 1 分钟 K 线
//      → flows.js 给账本没有精确成交价的转账定价: 转账时刻那根 1 分钟 K 线的收盘价; 休市 (夜间 / 周末 / 假日) 取之前最近一根, 最多回看 4 天; 再拿不到 → 调用方维持旧口径 (现价 + *)
//      按 (ticker, UTC 日) 拉 (单次请求上限 ≈1570 根, 一天 ≈500 根), 已收完的日子落盘不重拉
//   ② 自有钱包 ↔ 自己 Backpack 账户的往来 (对方 = 本账户 Solana 充值地址 depositAddressQuery, 或 Backpack 提币热钱包) → flows.js 标 self (列出不计)
//      只对 own 钱包: 观察钱包与热钱包的往来是别人账户的提币, 照记外部 (它在交易所里的持仓 / 盈亏看板看不到)
//   ③ 只读余额 (balanceQuery, 60s 缓存): 持仓按 Backpack 美股行情 fmv (.US) / 稳定币面值 / 现货 ticker 定价, 由 sol-adapter 作为一行「Backpack」并进归属自有钱包的闲置余额
//      → 现值 / 总价值 / 快照 / 盈亏页都从 byWallet.totalUSD 取, 自动含它; 不做配对、不做伪链、不做独立页
//   key 只从 process.env.BACKPACK_API_KEY / BACKPACK_API_SECRET 读 (服务器 .env, 用户自己写, 代码不经手 secret); 没配 → ① 照常, ②只认热钱包, ③ 没这行
//   缓存 backpack-cache.json (.gitignore): { v, depositSol, depositAt, assets: { ts, stock: { 用到的 mint: ticker } }, bars: { 'T:YYYY-MM-DD': [[ts, close], …] }, holdings }
//   签名: ED25519, 头 X-API-Key / X-Signature / X-Timestamp / X-Window; 签名串 instruction=<名>&<参数 key 字母序>&timestamp=&window=
// =============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://api.backpack.exchange';
const CACHE_FILE = path.join(__dirname, 'backpack-cache.json');
const KNOWN_FILE = path.join(__dirname, 'known-addrs.json');   // 可选: { sol: { 地址: { label, ex } } } 已知地址标签 (交易所充值址等), 只用于充提表对方地址列 / 小计
const CACHE_V = 1;
const WINDOW = 5000;
const TIMEOUT_MS = 15000;
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');   // ED25519 私钥 seed 的 PKCS8 DER 头
const HOT_WALLET_SOL = '43DbAvKxhXh1oSxkJSqGosNw3HpBnmsWiak6tB5wpecN';         // Backpack Solana 提币热钱包 (公开基础设施地址, 全体用户共用; 10-16 由提币记录核实)
const HOLD_MS = 60 * 1000;                 // 余额缓存
const HOLD_STALE_MS = 10 * 60 * 1000;      // 余额超过这个年龄还没刷新成功 = 过期 (标 *)
const ADDR_MS = 24 * 3600 * 1000;          // 充值地址 1 天问一次
const ASSETS_MS = 24 * 3600 * 1000;        // /api/v1/assets (7000+ 条) 内存 1 天
const TODAY_MS = 10 * 60 * 1000;           // 含今天的 K 线窗口 10 分钟后重拉
const BAR_GAP_MS = 4 * 86400000;           // 1 分钟 K 线最多往前找多久 (周末 / 长假休市跨 2~3.5 天); 更久 = 不定价
const BAR_DAYS = 5;                        // 往前翻几个 UTC 日
const BAR_KEEP = 40;                       // 落盘保留的 (ticker, 日) 条数
const WARN_MS = 10 * 60 * 1000;            // 同类警告 10 分钟一条
const STABLES = new Set(['USDC', 'USDT', 'USDG', 'PYUSD', 'USDE', 'USD1', 'DAI', 'FDUSD', 'USDS', 'USD', 'EURC']);

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = v => Math.round((Number(v) || 0) * 100) / 100;
const dateKey = ts => new Date(ts).toISOString().slice(0, 10);
const isStockSym = S => /\.US$/i.test(String(S || ''));
const tickerOf = S => String(S || '').toUpperCase().replace(/\.US$/, '');
const warnAt = {};
function warnOnce(k, msg) { const now = Date.now(); if (now - (warnAt[k] || 0) < WARN_MS) return; warnAt[k] = now; console.warn(`[backpack] ${msg}`); }

// ---- key ----
let keyCache = null;   // { apiKey, priv } | false (未配置 / 无效)
function loadKey() {
  if (keyCache !== null) return keyCache;
  const k = String(process.env.BACKPACK_API_KEY || '').trim(), s = String(process.env.BACKPACK_API_SECRET || '').trim();
  if (!k || !s) { keyCache = false; return keyCache; }
  try {
    let seed = Buffer.from(s, 'base64');
    if (seed.length === 64) seed = seed.subarray(0, 32);   // 有的工具导出 64 字节 (seed + 公钥)
    if (seed.length !== 32) throw new Error(`secret 解码后 ${seed.length} 字节 (应为 32 或 64)`);
    const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
    if (spki.subarray(spki.length - 32).toString('base64') !== k) console.warn('[backpack] 警告: 由 secret 推出的公钥与 BACKPACK_API_KEY 不一致 (两个值是否填反 / 复制不全?), 请求大概率会被拒');
    keyCache = { apiKey: k, priv };
  } catch (e) {
    console.error('[backpack] key 无效, 不接入余额:', e.message);
    keyCache = false;
  }
  return keyCache;
}
function configured() { return !!loadKey(); }

// ---- 签名 / 请求 ----
function signHeaders(instruction, params) {
  const k = loadKey(); if (!k) throw new Error('未配置');
  const ts = Date.now();
  const parts = Object.keys(params).filter(x => params[x] !== undefined && params[x] !== null && params[x] !== '').sort().map(x => `${x}=${params[x]}`);
  const msg = [`instruction=${instruction}`, ...parts, `timestamp=${ts}`, `window=${WINDOW}`].join('&');
  const sig = crypto.sign(null, Buffer.from(msg), k.priv).toString('base64');
  return { 'X-API-Key': k.apiKey, 'X-Signature': sig, 'X-Timestamp': String(ts), 'X-Window': String(WINDOW), 'Content-Type': 'application/json; charset=utf-8' };
}
async function api(pathname, instruction, params = {}) {
  const qs = Object.keys(params).filter(x => params[x] !== undefined && params[x] !== null && params[x] !== '').map(x => `${encodeURIComponent(x)}=${encodeURIComponent(params[x])}`).join('&');
  const url = BASE + pathname + (qs ? '?' + qs : '');
  const headers = instruction ? signHeaders(instruction, params) : {};
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  if (!r.ok) {
    let code = '';
    try { const j = JSON.parse(text); code = j.code || j.message || ''; } catch {}
    const e = new Error(`HTTP ${r.status}${code ? ' ' + String(code).slice(0, 80) : ''}`); e.status = r.status; throw e;
  }
  try { return text ? JSON.parse(text) : null; } catch { throw new Error('响应非 JSON'); }
}
const apiPublic = (pathname, params) => api(pathname, null, params);

// ---- 缓存 ----
let cache = null;
function loadCache() {
  if (cache) return cache;
  try { const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); if (c && c.v === CACHE_V && typeof c === 'object') cache = c; } catch {}
  if (!cache) cache = { v: CACHE_V, depositSol: '', depositAt: 0, assets: { ts: 0, stock: {} }, bars: {}, holdings: null };
  if (!cache.assets || typeof cache.assets !== 'object') cache.assets = { ts: 0, stock: {} };
  if (!cache.assets.stock) cache.assets.stock = {};
  if (!cache.bars || typeof cache.bars !== 'object') cache.bars = {};
  return cache;
}
let saveT = null;
function saveCache() {   // 合并 2s 内的多次改动, 原子写
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try { const tmp = CACHE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(loadCache())); fs.renameSync(tmp, CACHE_FILE); }
    catch (e) { console.error('[backpack] 缓存落盘失败:', e.message); }
  }, 2000);
  if (saveT.unref) saveT.unref();
}

// ---- ① 股票代币 1 分钟 K 线 ----
let assetsMemo = { ts: 0, stock: null };   // 全量 Solana mint → 美股 ticker (symbol 以 .US 结尾的)
async function loadAssets() {
  if (assetsMemo.stock && Date.now() - assetsMemo.ts < ASSETS_MS) return assetsMemo.stock;
  const rows = await apiPublic('/api/v1/assets');
  if (!Array.isArray(rows)) throw new Error('assets 响应不是数组');
  const stock = {};
  for (const a of rows) {
    if (!a || !isStockSym(a.symbol)) continue;
    const t = (Array.isArray(a.tokens) ? a.tokens : []).find(x => x && x.blockchain === 'Solana' && x.contractAddress && String(x.contractAddress).length > 30);
    if (t) stock[String(t.contractAddress)] = tickerOf(a.symbol);
  }
  assetsMemo = { ts: Date.now(), stock };
  return stock;
}
// 链上 mint → 行情 ticker ('' = 不是 Backpack 股票代币); 命中的落缓存 (assets 接口偶尔失败时还能用)
async function tickerOfMint(mint) {
  const c = loadCache();
  let all = null;
  try { all = await loadAssets(); } catch (e) { warnOnce('assets', `assets 表拉取失败 (用缓存里已知的): ${e.message}`); }
  const T = all ? (all[mint] || '') : (c.assets.stock[mint] || '');
  if (T && c.assets.stock[mint] !== T) { c.assets.stock[mint] = T; c.assets.ts = Date.now(); saveCache(); }
  return T;
}
const dayMemo = new Map();   // 'T:日' → { rows: [[ts, close], …] 升序, at }
function pruneBars(c) {
  const keys = Object.keys(c.bars);
  if (keys.length <= BAR_KEEP) return;
  keys.sort((a, b) => a.slice(-10).localeCompare(b.slice(-10)));   // 按日期升序, 删最老的
  for (const k of keys.slice(0, keys.length - BAR_KEEP)) delete c.bars[k];
}
async function dayBars(T, day) {
  const c = loadCache(), k = `${T}:${day}`;
  if (Array.isArray(c.bars[k])) return c.bars[k];
  const closedDay = day < dateKey(Date.now() - 3600000);   // 这个 UTC 日已经过完 1 小时以上 = 不会再变
  let m = dayMemo.get(k);
  if (!m || (!closedDay && Date.now() - m.at > TODAY_MS)) {
    const rows = await apiPublic('/wapi/v1/stocks/klines', { ticker: T, timespan: 'minute', multiplier: 1, from: day, to: day });
    const arr = (Array.isArray(rows) ? rows : []).map(r => [num(r && r.timestamp), num(r && r.close)]).filter(x => x[0] > 0 && x[1] > 0).sort((a, b) => a[0] - b[0]);
    m = { rows: arr, at: Date.now() };
    dayMemo.set(k, m); if (dayMemo.size > 400) dayMemo.delete(dayMemo.keys().next().value);
    if (closedDay) { c.bars[k] = arr; pruneBars(c); saveCache(); }
  }
  return m.rows;
}
// ts 之前最近一根 1 分钟 K 线 (当天没有就往前翻, 最多 BAR_DAYS 天; 缺口 > BAR_GAP_MS 不算) → { p: 收盘价 (每份额美元), bt: K 线起点 ms } | null
async function barAt(T, ts) {
  let best = null;
  for (let d = 0; d < BAR_DAYS && !best; d++) {
    const rows = await dayBars(T, dateKey(ts - d * 86400000));
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i][0] <= ts) { best = { p: rows[i][1], bt: rows[i][0] }; break; }
  }
  if (!best || ts - best.bt > BAR_GAP_MS) return null;
  return best;
}
// 给 flows.js 的钩子: (mint, 时刻) → { p 每份额美元, bt K 线起点, ticker }; 不是 Backpack 股票代币 → null; 接口失败抛错 (调用方 catch 后维持旧口径, 下轮再试)
async function stockHist(mint, ts) {
  if (!mint || !(ts > 0)) return null;
  const T = await tickerOfMint(mint);
  if (!T) return null;
  const b = await barAt(T, ts);
  return b ? { p: b.p, bt: b.bt, ticker: T } : null;
}
// 美股行情现价: GET /wapi/v1/stocks/snapshots?tickers=DJT,CBRS → { DJT: { p: fmv (没有则 lastTrade.price / day.close), ts } }
async function stockSnapshots(tickers) {
  const out = {};
  if (!tickers.length) return out;
  const rows = await apiPublic('/wapi/v1/stocks/snapshots', { tickers: tickers.join(',') });
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.ticker) continue;
    const lt = r.lastTrade || {}, tsRaw = num(lt.timestamp);
    const p = num(r.fmv) > 0 ? num(r.fmv) : (num(lt.price) > 0 ? num(lt.price) : num(r.day && r.day.close));
    if (p > 0) out[String(r.ticker).toUpperCase()] = { p, ts: tsRaw > 1e15 ? Math.floor(tsRaw / 1e6) : tsRaw };
  }
  return out;
}

// ---- ② 自己 Backpack 账户的地址 ----
let depBusy = null;
async function ensureDeposit() {
  const c = loadCache();
  if (!configured()) return c.depositSol || '';
  if (c.depositSol && Date.now() - c.depositAt < ADDR_MS) return c.depositSol;
  if (depBusy) return depBusy;
  depBusy = (async () => {
    try {
      const r = await api('/wapi/v1/capital/deposit/address', 'depositAddressQuery', { blockchain: 'Solana' });
      const a = r && r.address ? String(r.address) : '';
      if (a) { if (a !== c.depositSol) console.log(`[backpack] 本账户 Solana 充值地址 ${a.slice(0, 6)}…${a.slice(-4)}`); c.depositSol = a; c.depositAt = Date.now(); saveCache(); }
    } catch (e) { warnOnce('deposit', `充值地址查询失败${c.depositSol ? ' (用缓存的)' : ''}: ${e.message}`); }
    finally { depBusy = null; }
    return c.depositSol || '';
  })();
  return depBusy;
}
function selfAddrs() { const c = loadCache(), s = new Set([HOT_WALLET_SOL]); if (c.depositSol) s.add(c.depositSol); return s; }
function isSelf(chain, a) { return chain === 'sol' && selfAddrs().has(String(a || '')); }
// 已知地址标签 { label, ex } | null: 热钱包 / 本账户充值址 / known-addrs.json
let knownMemo = { ts: 0, map: {} };
function knownMap() {
  if (Date.now() - knownMemo.ts < 60000) return knownMemo.map;
  let m = {};
  try { const j = JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')); if (j && typeof j === 'object') m = j; } catch {}
  knownMemo = { ts: Date.now(), map: m };
  return m;
}
function known(chain, a) {
  a = String(a || ''); if (!a) return null;
  if (chain === 'sol') {
    if (a === HOT_WALLET_SOL) return { label: 'Backpack 热钱包', ex: 'Backpack' };
    const c = loadCache(); if (c.depositSol && a === c.depositSol) return { label: 'Backpack 充值址', ex: 'Backpack' };
  }
  const k = (knownMap()[chain] || {})[chain === 'sol' ? a : a.toLowerCase()];
  return k && k.label ? { label: String(k.label), ex: k.ex ? String(k.ex) : '' } : null;
}

// ---- ③ 只读余额 ----
let holdBusy = null;
function holdView(h) { const stale = Date.now() - h.ts > HOLD_STALE_MS; return { ...h, stale, approx: stale || h.priceMiss > 0 }; }
async function holdings() {
  if (!configured()) return null;
  const c = loadCache();
  if (c.holdings && Date.now() - c.holdings.ts < HOLD_MS) return holdView(c.holdings);
  if (holdBusy) return holdBusy;
  holdBusy = (async () => {
    try {
      const bal = await api('/api/v1/capital', 'balanceQuery');
      const rows = [];
      for (const [sym, b] of Object.entries(bal && typeof bal === 'object' ? bal : {})) {
        const qty = num(b && b.available) + num(b && b.locked) + num(b && b.staked);
        if (qty > 0) rows.push({ symbol: String(sym), qty, price: 0, usd: 0, src: '' });
      }
      const stk = rows.filter(r => isStockSym(r.symbol));
      let snaps = {};
      if (stk.length) { try { snaps = await stockSnapshots(stk.map(r => tickerOf(r.symbol))); } catch (e) { warnOnce('snap', `美股行情 snapshots 失败: ${e.message}`); } }
      for (const r of rows) {
        if (STABLES.has(r.symbol.toUpperCase())) { r.price = 1; r.src = 'stable'; continue; }
        if (isStockSym(r.symbol)) { const s = snaps[tickerOf(r.symbol)]; if (s && s.p > 0) { r.price = s.p; r.src = 'stock'; if (s.ts > 0) r.pts = s.ts; } continue; }
        try { const t = await apiPublic('/api/v1/ticker', { symbol: `${r.symbol}_USDC` }); const p = num(t && t.lastPrice); if (p > 0) { r.price = p; r.src = 'ticker'; } } catch {}
      }
      let total = 0, miss = 0;
      for (const r of rows) { r.usd = round2(r.qty * r.price); if (r.price > 0) total += r.usd; else if (r.qty >= 1e-6) miss++; }
      rows.sort((a, b) => b.usd - a.usd);
      c.holdings = { ts: Date.now(), totalUSD: round2(total), rows, priceMiss: miss, err: '' };
      if (miss) warnOnce('miss', `持仓没拿到价 (不计入): ${rows.filter(r => !(r.price > 0)).map(r => `${r.symbol}×${r.qty}`).join(', ')}`);
      saveCache();
      return holdView(c.holdings);
    } catch (e) {
      const msg = e.message || String(e);
      warnOnce('hold', `余额查询失败${c.holdings ? ' (沿用上次)' : ''}: ${msg}`);
      if (c.holdings) { c.holdings.err = msg; return holdView(c.holdings); }
      return null;
    } finally { holdBusy = null; }
  })();
  return holdBusy;
}

module.exports = { configured, stockHist, stockSnapshots, ensureDeposit, selfAddrs, isSelf, known, holdings, HOT_WALLET_SOL, _test: { barAt, dayBars, tickerOfMint, loadCache } };
