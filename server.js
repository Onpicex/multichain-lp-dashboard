require('dotenv').config();
const express = require('express');
const path = require('path');
const { ethers } = require('ethers');

const fs = require('fs');
const app = express();
app.use(express.json());

// 2026-09-28 审计修复: 缓存/配置文件统一原子写 (tmp + rename), 进程在写一半被杀不会留下截断的 JSON
function writeJsonAtomic(file, obj, pretty = false) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}
// 2026-09-28 审计修复: token symbol 净化 (只允许 [\w.$\-\/+ ]{1,24}, 越界回退 地址前6+…+后4) —— 前端插值的 XSS 源头在这里堵
const SYMBOL_OK = /^[\w.$\-\/+ ]{1,24}$/;
function shortAddr(addr) { const a = String(addr || ''); return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a; }
function sanitizeSymbol(sym, addr) {
  const t = typeof sym === 'string' ? sym.trim() : '';
  return SYMBOL_OK.test(t) ? t : shortAddr(addr);
}
// 2026-09-28 审计修复: 从 positions-cache.json 读回的旧仓位 symbol 是净化前写入的, 加载后对 token0/token1 与闲置余额条目统一过一遍
function sanitizePayloadSymbols(data) {
  if (!data || typeof data !== 'object') return data;
  for (const w of (data.wallets || [])) for (const p of (w.positions || [])) {
    for (const k of ['token0', 'token1']) if (p[k] && typeof p[k] === 'object') p[k].symbol = sanitizeSymbol(p[k].symbol, p[k].address);
  }
  for (const w of Object.values((data.idle && data.idle.byWallet) || {})) for (const t of (w.tokens || [])) if (!t.native) t.symbol = sanitizeSymbol(t.symbol, t.address);
  return data;
}

// 2026-09-09 登录页模式 (原 nginx Basic Auth 弹窗)。必须在业务路由之前挂载。
// 注意: 真正的鉴权闸门在 nginx (map $cookie_lpauth $lp_ok), 本模块只负责
// 校验用户名口令并下发 nginx 认识的 cookie —— 见 lp-auth.js 顶部说明。
const { mountLpAuth } = require("./lp-auth");
const pnlLedger = require('./pnl-ledger');   // 盈亏字段注入 (applyPnl) + 钱包盈亏报告 (BSC 无账本, 全部退回建仓回溯)
mountLpAuth(app);
const PORT = parseInt(process.env.PORT || '1788');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// --- Multi-chain registry (六链全部在线; 前端 /api/chains 只读 pending 字段, enabled 仅作说明) ---
const CHAINS = [
  { id: 'bsc',  name: 'BSC',  enabled: true },
  { id: 'sol',  name: 'Solana', enabled: true },
  { id: 'eth',  name: 'Ethereum', enabled: true },
  { id: 'rh',   name: 'Robinhood', enabled: true },
  { id: 'base', name: 'Base', enabled: true },   // 2026-09-28 审计修复: Base 早已上线 (evm-adapter 管), 死字段 enabled:false 改正
  // Arc (Circle 稳定币 L1, chainId 5042): 主网 2026-09-16 公开, 2026-09-19 切活 (arc-check 全绿)。
  { id: 'arc',  name: 'Arc', enabled: true },
];

// Optional admin guard for mutating endpoints (set ADMIN_TOKEN in .env to enable)
function adminGuard(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: '需要管理密码 (X-Admin-Token)' });
}

// --- Config (from .env) ---
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
const WALLET_ADDR_RE = /^0x[0-9a-f]{40}$/;
const WALLET_NAME_MAX = 64;
// 2026-09-28 审计修复: 钱包入参统一取字符串 —— 只收 string / 有限 number, 其余 (null/对象/数组/布尔) 一律非法 (路由回 400);
//   不对对象直接 String(): JSON 里 {"toString":1} 会让 String() 抛 TypeError (以前变 500), null 会变成名字 "null", 数组会拼成逗号串蒙混过关
function walletInputStr(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
// 2026-09-28 审计修复: 地址 → 小写且须 0x+40hex; 名称 → 去首尾空白后 1~64 个字符 (按码点计, emoji 不算 2 个); 非法一律返回 null
function cleanWalletAddr(v) { const s = walletInputStr(v); if (s === null) return null; const a = s.trim().toLowerCase(); return WALLET_ADDR_RE.test(a) ? a : null; }
function cleanWalletName(v) { const s = walletInputStr(v); if (s === null) return null; const n = s.trim(); const len = [...n].length; return len >= 1 && len <= WALLET_NAME_MAX ? n : null; }
// 2026-09-28 审计修复: .env 里的 WALLETS 条目也过同一套校验 (cleanWalletAddr / cleanWalletName), 不合法的跳过并打日志
function validWalletEntries(list, srcLabel) {
  const out = [];
  for (const w of (Array.isArray(list) ? list : [])) {
    const addr = cleanWalletAddr(w && w.address);
    const name = cleanWalletName(w && w.name);
    if (!addr || !name) {
      console.error(`[wallets] ${srcLabel} 跳过不合法条目: ${JSON.stringify(w).slice(0, 120)}`);
      continue;
    }
    out.push({ ...w, address: addr, name });
  }
  return out;
}
// 2026-09-28 审计修复: 只有 .env 真配了 WALLETS 才当初始化来源 (缺省 null, 不再用空数组冒充配置); JSON 坏了打日志按未配置处理, 不让进程启动即崩
function parseEnvWallets() {
  if (!process.env.WALLETS) return null;
  try { return validWalletEntries(JSON.parse(process.env.WALLETS), '.env WALLETS'); }
  catch (e) { console.error('[wallets] .env WALLETS 不是合法 JSON, 按未配置处理:', e.message); return null; }
}
const ENV_WALLETS = parseEnvWallets();

// Dynamic wallet list: load from wallets.json, fallback to .env
function loadWallets() {
  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('wallets.json 顶层不是数组');
      return parsed;
    } catch (e) {
      // 2026-09-28 审计修复: 解析失败改名 wallets.json.corrupt-<ts> 留证, 内存用空表, 绝不写回覆盖原文件 (以前会用 .env 的空表直接覆盖)
      console.error('Failed to load wallets.json:', e.message);
      try {
        const bak = `${WALLETS_FILE}.corrupt-${Date.now()}`;
        fs.renameSync(WALLETS_FILE, bak);
        console.error(`wallets.json 已改名为 ${path.basename(bak)} 留证, 本次启动钱包列表为空, 请人工修复`);
      } catch (e2) { console.error('wallets.json 改名留证失败:', e2.message); }
      return [];
    }
  }
  // 首次启动 (无 wallets.json): 只有 .env 真配了 WALLETS 才初始化落盘
  if (ENV_WALLETS && ENV_WALLETS.length) { saveWallets(ENV_WALLETS); return [...ENV_WALLETS]; }
  return [];
}

function saveWallets(wallets) {
  writeJsonAtomic(WALLETS_FILE, wallets, true);   // 2026-09-28 审计修复: 原子写
}

let WALLETS = loadWallets();
// 启用中的钱包 (enabled 缺省=启用; false=停用: 不抓仓位/不查余额, 只保留在列表里)
function isWalletOn(w) { return w.enabled !== false; }
function activeWallets() { return WALLETS.filter(isWalletOn); }
const BSC_RPC = process.env.BSC_RPC || 'https://bsc-dataseed.binance.org';
// Ankr Advanced API: 支持逗号分隔多个 endpoint 轮动使用 (分摊限流)
const ANKR_ADVANCED_URLS = (process.env.ANKR_ADVANCED_URL || (process.env.BSC_RPC?.includes('ankr.com') ? process.env.BSC_RPC.replace('/bsc/', '/multichain/') : ''))
  .split(',').map(s => s.trim()).filter(Boolean);
const ANKR_ADVANCED_URL = ANKR_ADVANCED_URLS[0] || ''; // 真值判断用
let _ankrRotate = 0;
function nextAnkrUrl() { return ANKR_ADVANCED_URLS[_ankrRotate++ % ANKR_ADVANCED_URLS.length]; }
// V3
const V3_POSITION_MANAGER = '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613';
const V3_FACTORY = '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
// V4
const V4_POSITION_MANAGER = '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b';
const V4_STATE_VIEW = '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4';
const V4_POOL_MANAGER = '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df';
// The Graph key pool (round-robin + circuit breaker)
const GRAPH_KEYS = (process.env.GRAPH_KEYS || '').split(',').filter(Boolean).map(key => ({
  key: key.trim(), ok: 0, fail: 0, blockedUntil: 0,
}));
let graphKeyIndex = 0;
const GRAPH_BLOCK_MS = 10 * 60 * 1000; // 10 min circuit breaker
const V4_SUBGRAPH_ID = 'EAq1nJKgjnuKH6Gj4RFjCW7LcL7E2uipbncdwV7TTWkX';
const V3_SUBGRAPH_ID = 'F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2';

function getNextGraphKey() {
  if (GRAPH_KEYS.length === 0) return null; // 无 key: 走链上 fallback
  const now = Date.now();
  for (let i = 0; i < GRAPH_KEYS.length; i++) {
    const idx = (graphKeyIndex + i) % GRAPH_KEYS.length;
    if (GRAPH_KEYS[idx].blockedUntil <= now) {
      graphKeyIndex = (idx + 1) % GRAPH_KEYS.length;
      return GRAPH_KEYS[idx];
    }
  }
  // All blocked — use the one that unblocks soonest
  const sorted = [...GRAPH_KEYS].sort((a, b) => a.blockedUntil - b.blockedUntil);
  return sorted[0];
}

function graphUrl(subgraphId) {
  const entry = getNextGraphKey();
  if (!entry) return null;
  return { url: `https://gateway.thegraph.com/api/${entry.key}/subgraphs/id/${subgraphId}`, entry };
}

async function graphQuery(subgraphId, query) {
  const g = graphUrl(subgraphId);
  if (!g) return null; // 无 key，让调用方走链上 fallback
  const { url, entry } = g;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      entry.fail++;
      if (res.status === 429) entry.blockedUntil = Date.now() + GRAPH_BLOCK_MS;
      return null;
    }
    const json = await res.json();
    if (json.errors?.length) { entry.fail++; return null; }
    entry.ok++;
    return json.data;
  } catch (e) {
    entry.fail++;
    return null;
  }
}

// 2026-09-28 审计修复: 子图分页 (first:1000 + id_gt 游标, orderBy id, 最多 maxPages 页) 替代 first:200 无分页;
// 任一页失败返回 null (调用方走链上兜底), 不返回半截数据冒充全量
async function graphQueryPaged(subgraphId, buildQuery, pick, maxPages = 5) {
  const out = [];
  let lastId = '';
  for (let page = 0; page < maxPages; page++) {
    const data = await graphQuery(subgraphId, buildQuery(lastId));
    const rows = data ? pick(data) : null;
    if (!Array.isArray(rows)) return null;
    out.push(...rows);
    if (rows.length < 1000) break;
    lastId = String(rows[rows.length - 1].id);
    if (!lastId) break;
  }
  return out;
}

// ===== 建仓价值 / 差价 (BSC Pancake V3+V4): 子图 amountUSD 聚合, 与 eth/base 同构 =====
// 该子图 Position 实体为空, 但 mints/burns/modifyLiquidities 带 amountUSD + origin;
// 按 pool + ticks + origin(=持仓钱包地址) 聚合即得该仓全部入金/提取的历史 USD 值.
// 差价 = 头寸现值 + 已提本金 - 累计入金 (本金盈亏, 不含手续费, 亦非无常损失).
// 异步串行队列 + 失败 15min 冷却 + 命中永久缓存; 拿不到就不显示 (宁缺毋滥).
let bscEntryCache = null;
const bscEntryFile = path.join(__dirname, 'entry-cache-bsc.json');
const bscEntryJobs = new Map();
const bscEntryCooldown = new Map();
let bscEntryWorkerBusy = false;
function bscEntryStore() {
  if (!bscEntryCache) { try { bscEntryCache = JSON.parse(fs.readFileSync(bscEntryFile, 'utf8')); } catch { bscEntryCache = {}; } }
  return bscEntryCache;
}
function saveBscEntry() { try { writeJsonAtomic(bscEntryFile, bscEntryCache || {}); } catch {} }   // 2026-09-28 审计修复: 原子写
// 2026-09-28 审计修复: origin≠owner (代理合约建仓/转入的 NFT) 的仓子图永远查空, 以前每 15 分钟重试到永远; 连续 3 次空结果写 noEntry 并冷却 24h
const bscEntryEmpty = new Map();   // key -> 连续空结果次数
const BSC_ENTRY_NOENTRY_TTL = 24 * 60 * 60 * 1000;
function noteBscEntryEmpty(cache, key, job) {
  const n = (bscEntryEmpty.get(key) || 0) + 1;
  bscEntryEmpty.set(key, n);
  if (n >= 3) { cache[key] = { noEntry: true, liq: job.liq.toString(), ts: Date.now() }; saveBscEntry(); bscEntryEmpty.delete(key); }
  return null;
}
async function graphQueryRetry(subgraphId, query, tries = 3, gap = 700) {
  for (let i = 0; i < tries; i++) {
    const d = await graphQuery(subgraphId, query);
    if (d) return d;
    if (i < tries - 1) await sleep(gap);
  }
  return null;
}
async function getV3EntryBsc(job) {
  const cache = bscEntryStore();
  const key = `v3-${job.tokenId}`;
  const cached = cache[key];
  if (cached && cached.liq === job.liq.toString() && cached.am) return cached;
  const pool = job.poolAddress.toLowerCase();
  const origin = (job.owner || '').toLowerCase();
  if (!origin) return null;
  // 2026-09-28 审计修复: 按 pool+tick+origin 聚合会混入同区间的旧仓 (关掉重开的), 加 timestamp_gte=本 tokenId 的 mint 时间;
  // 优先用本轮已知的 createdAt (子图/链上), 没有再查 getV3MintTime; 都拿不到就不落缓存 (走 15min 冷却重试)
  const mintTs = job.createdAt > 0 ? job.createdAt : await getV3MintTime(BigInt(job.tokenId));
  if (!(mintTs > 0)) return null;
  const sinceSec = Math.floor(mintTs / 1000);
  const md = await graphQueryRetry(V3_SUBGRAPH_ID,
    `{ mints(first:500, where:{pool:"${pool}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}", timestamp_gte:${sinceSec}}){ amount0 amount1 amountUSD timestamp } }`);
  if (!md) return null;
  const bd = await graphQueryRetry(V3_SUBGRAPH_ID,
    `{ burns(first:500, where:{pool:"${pool}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}", timestamp_gte:${sinceSec}}){ amount0 amount1 amountUSD } }`);
  // 2026-09-28 审计修复: burns 查询失败 (null) ≠ 没有 burns ([]): 失败不落缓存, 否则「已提回」永久记成 0
  if (!bd) return null;
  const mints = md.mints || [], burns = bd.burns || [];
  if (mints.length === 0) return noteBscEntryEmpty(cache, key, job);
  bscEntryEmpty.delete(key);
  let u = 0, ts = 0, n0 = 0, n1 = 0;
  for (const m of mints) { u += Math.abs(+m.amountUSD); n0 += Math.abs(+m.amount0 || 0); n1 += Math.abs(+m.amount1 || 0); const t = +m.timestamp * 1000; if (!ts || t < ts) ts = t; }
  const w = burns.reduce((a, b) => a + Math.abs(+b.amountUSD), 0);
  for (const b of burns) { n0 -= Math.abs(+b.amount0 || 0); n1 -= Math.abs(+b.amount1 || 0); }
  // am = 净存入数量 (按 token 地址, 池 token0/token1 顺序 = 链上顺序): 无常损失用
  const am = { [String(job.t0 || '').toLowerCase()]: n0, [String(job.t1 || '').toLowerCase()]: n1 };
  const data = { u, w, ts, n: mints.length, liq: job.liq.toString(), b: 0, mod: false, am };
  cache[key] = data; saveBscEntry();
  return data;
}
async function getV4EntryBsc(job) {
  const cache = bscEntryStore();
  const key = `v4-${job.tokenId}`;
  const cached = cache[key];
  if (cached && cached.liq === job.liq.toString() && cached.am) return cached;
  const pool = job.poolId.toLowerCase();
  const origin = (job.owner || '').toLowerCase();
  if (!origin) return null;
  // 2026-09-28 审计修复: 与 V3 同理, 已知 createdAt 时加 timestamp_gte 过滤同区间旧仓 (未知时保持原聚合, 不因此放弃)
  const sinceV4 = job.createdAt > 0 ? `, timestamp_gte:${Math.floor(job.createdAt / 1000)}` : '';
  const md = await graphQueryRetry(V4_SUBGRAPH_ID,
    `{ modifyLiquidities(first:500, where:{pool:"${pool}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}"${sinceV4}}){ amount amount0 amount1 amountUSD timestamp } }`);
  if (!md) return null;
  const evs = md.modifyLiquidities || [];
  if (evs.length === 0) return noteBscEntryEmpty(cache, key, job);
  let u = 0, w = 0, n = 0, ts = 0, n0 = 0, n1 = 0;
  for (const e of evs) {
    if (+e.amount === 0) continue;   // 2026-09-28 审计修复: liquidityDelta=0 是纯领费, amountUSD 是手续费, 以前 (0>=0) 被当成入金
    const a = Math.abs(+e.amountUSD);
    const sg = +e.amount >= 0 ? 1 : -1;
    n0 += sg * Math.abs(+e.amount0 || 0); n1 += sg * Math.abs(+e.amount1 || 0);
    if (sg > 0) { u += a; n++; const t = +e.timestamp * 1000; if (!ts || t < ts) ts = t; }
    else { w += a; }
  }
  if (n === 0) return noteBscEntryEmpty(cache, key, job);
  bscEntryEmpty.delete(key);
  const am = { [String(job.t0 || '').toLowerCase()]: n0, [String(job.t1 || '').toLowerCase()]: n1 };
  const data = { u, w, ts, n, liq: job.liq.toString(), b: 0, mod: false, am };
  cache[key] = data; saveBscEntry();
  return data;
}
function bscEntryPeek(kind, tokenId, currentLiq, job) {
  const cache = bscEntryStore();
  const key = `${kind}-${tokenId}`;
  const cached = cache[key];
  const hit = cached && cached.liq === currentLiq.toString();
  if (hit && cached.am) return cached;
  if (hit && cached.noEntry && Date.now() - cached.ts < BSC_ENTRY_NOENTRY_TTL) return null;   // 2026-09-28 审计修复: 查不到建仓记录的仓 24h 内不再排队
  if ((bscEntryCooldown.get(key) || 0) < Date.now() && !bscEntryJobs.has(key)) {
    bscEntryJobs.set(key, job);
    setImmediate(() => runBscEntryQueue().catch(() => {}));
  }
  return hit ? cached : null;   // 旧缓存只缺 am: 先沿用, 后台补算
}
async function runBscEntryQueue() {
  if (bscEntryWorkerBusy) return;
  bscEntryWorkerBusy = true;
  try {
    while (bscEntryJobs.size > 0) {
      const [key, job] = bscEntryJobs.entries().next().value;
      bscEntryJobs.delete(key);
      try {
        const ed = job.kind === 'v3' ? await getV3EntryBsc(job) : await getV4EntryBsc(job);
        if (!ed) bscEntryCooldown.set(key, Date.now() + 15 * 60 * 1000);
      } catch { bscEntryCooldown.set(key, Date.now() + 15 * 60 * 1000); }
      await sleep(300);
    }
  } finally { bscEntryWorkerBusy = false; }
}

// V4 subgraph position ID cache (per wallet)
const v4IdCache = {};
const V4_ID_CACHE_TTL = 10 * 60 * 1000; // 10 min (主缓存 CACHE_TTL 现为 5 min, 子图 id 表两轮复用一次)   2026-09-28 审计修复: 注释改正

// --- V4 chain-scan fallback (no Graph key needed) ---
// Scans V4 PositionManager ERC721 Transfer logs to discover tokenIds per wallet.
// Persistent incremental cache: v4ids-cache.json { lastBlock, wallets: { addr: { ids: {tokenId: mintBlock} } } }
const V4_IDS_CACHE_FILE = path.join(__dirname, 'v4ids-cache.json');
const V4_SCAN_CHUNK = parseInt(process.env.V4_SCAN_CHUNK || '49000');
const V4_MAX_LOOKBACK = parseInt(process.env.V4_MAX_LOOKBACK || '40000000'); // blocks
let v4ChainStore = null;
let v4ScanPromise = null; // dedupe concurrent scans

function loadV4Store() {
  if (v4ChainStore) return v4ChainStore;
  try { v4ChainStore = JSON.parse(fs.readFileSync(V4_IDS_CACHE_FILE, 'utf8')); }
  catch { v4ChainStore = { lastBlock: 0, wallets: {} }; }
  return v4ChainStore;
}
function saveV4Store() {
  try { writeJsonAtomic(V4_IDS_CACHE_FILE, v4ChainStore); } catch {}   // 2026-09-28 审计修复: 原子写
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// NodeReal enhanced API: enumerate NFT inventory directly (no log scanning needed)
async function nrGetNFTInventory(wallet, contract) {
  const ids = [];
  let pageKey = '';
  for (let page = 0; page < 20; page++) {
    const body = {
      jsonrpc: '2.0', id: 1, method: 'nr_getNFTInventory',
      params: [wallet, contract, '0x64', pageKey], // 0x64 = 100 per page
    };
    const resp = await fetch(LOG_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message || 'nr_getNFTInventory error');
    const details = json.result?.details || [];
    for (const d of details) ids.push(BigInt(d.tokenId).toString());
    pageKey = json.result?.pageKey || '';
    if (!pageKey || details.length === 0) break;
    await sleep(150);
  }
  return ids;
}

// One global scan covers ALL wallets — via NodeReal NFT inventory API
async function scanV4Chain() {
  if (v4ScanPromise) return v4ScanPromise;
  v4ScanPromise = (async () => {
    const store = loadV4Store();
    const failed = new Set();   // 2026-09-28 审计修复: 记录 inventory 失败的钱包, 调用方据此区分「真 0 仓」和「没查到」
    const scanWallets = activeWallets();   // 2026-09-28 审计修复: 只扫启用中的钱包 (原来遍历 WALLETS 含停用的)
    for (const w of scanWallets) {
      const a = w.address.toLowerCase();
      try {
        const ids = await withRetry(() => nrGetNFTInventory(w.address, V4_POSITION_MANAGER), 3, 1000);
        const wStore = store.wallets[a] = store.wallets[a] || { ids: {} };
        const fresh = {};
        for (const tid of ids) fresh[tid] = wStore.ids[tid] || 0; // keep known mintBlock if any (0 = 未知, 调用方不得拿去查块时间)
        wStore.ids = fresh; // inventory is authoritative: adds new, drops transferred/burned
        console.log(`  ${w.name} V4: ${ids.length} NFTs (inventory)`);
      } catch (e) {
        failed.add(a);
        console.log(`  ${w.name} V4 inventory failed: ${e.message?.slice(0, 60)}`);
      }
      await sleep(200);
    }
    saveV4Store();

    // Inventory API is authoritative — no per-token ownerOf verification needed
    const result = {};
    for (const w of scanWallets) {
      const a = w.address.toLowerCase();
      result[a] = Object.entries(store.wallets[a]?.ids || {}).map(([tid, mintBlock]) => ({ id: BigInt(tid), mintBlock }));
    }
    return { owned: result, failed };
  })();
  try { return await v4ScanPromise; }
  finally { setTimeout(() => { v4ScanPromise = null; }, 60 * 1000); }
}

const blockTsCache = {};
async function blockTimestamp(blockNumber) {
  if (!(Number(blockNumber) > 0)) return 0;   // 2026-09-28 审计修复: 块高未知 (0) 直接回 0, 不再去查创世块把 createdAt 记成 2020 年
  if (blockTsCache[blockNumber]) return blockTsCache[blockNumber];
  try {
    const b = await logProvider.getBlock(Number(blockNumber));
    if (b) { blockTsCache[blockNumber] = b.timestamp * 1000; return blockTsCache[blockNumber]; }
  } catch {}
  return 0;
}

// --- Concurrency control ---
const MAX_CONCURRENT = 2;
const BATCH_SIZE = 5; // max parallel RPC calls per batch
const BATCH_DELAY = 300; // ms between batches

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run promises in small batches with delay between
async function batchedAll(items, fn, batchSize = BATCH_SIZE) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) await sleep(BATCH_DELAY);
  }
  return results;
}

// Retry wrapper
async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  Retry ${i + 1}/${retries} after error: ${e.message.slice(0, 80)}`);
      await sleep(delayMs * (i + 1));
    }
  }
}

// --- Cache ---
let cache = { data: null, timestamp: 0 };
let lastUsdPricesBsc = {};   // 上轮定价 (pnl-ledger 给无参考池的 token 当近似价)
const CACHE_TTL = 5 * 60 * 1000; // 5 min auto-refresh (2026-09-05 由 10min 调快)
const POS_CACHE_FILE = path.join(__dirname, 'positions-cache.json');
// Load persisted cache on startup so pm2 restarts don't blank the dashboard
try {
  const saved = JSON.parse(fs.readFileSync(POS_CACHE_FILE, 'utf8'));
  if (saved && saved.data) { sanitizePayloadSymbols(saved.data); cache = saved; console.log(`Loaded positions cache from disk (age ${Math.round((Date.now() - saved.timestamp) / 1000)}s)`); }   // 2026-09-28 审计修复: 旧缓存 symbol 净化
} catch { /* no cache yet */ }
function savePosCache() {
  try { writeJsonAtomic(POS_CACHE_FILE, cache); } catch {}   // 2026-09-28 审计修复: 原子写
}

// --- ABIs ---
// V3
const V3_POSITION_MANAGER_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
];
// V4
const V4_POSITION_MANAGER_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function balanceOf(address owner) view returns (uint256)',   // 2026-09-28 审计修复: 子图回空数组时用链上持有数交叉核对
];
const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
];
const Q128 = 2n ** 128n;

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];

// --- Providers ---
const provider = new ethers.JsonRpcProvider(BSC_RPC);
// Separate provider for log queries (public RPCs have different rate limits)
// 2026-09-13: 本文件的日志扫描 (40k 块一段的 getLogs、nr_getNFTInventory) 是按 NodeReal 写的; publicnode 对 40k 块回 403、
// 对 nr_* 回 Method not found, 三条兜底全部静默失效。.env 已切到 Pancake 前端自带的 NodeReal 公共端点 (见 pancake-bsc.js 顶部普查)。
const LOG_RPC = process.env.LOG_RPC || 'https://bsc-rpc.publicnode.com';
// ethers v6 默认不设请求超时, RPC 一卡整轮刷新就永久悬着 → 每个请求 20s 上限 (nr_getNFTInventory 走原生 fetch 不受影响)
const _logReq = new ethers.FetchRequest(LOG_RPC); _logReq.timeout = 20000;
const logProvider = new ethers.JsonRpcProvider(_logReq);
// 事件回看深度: 旧值 864000 是按 3s 出块估的"30 天", BSC 现在 0.45s 一块 (2026-09 实测), 只覆盖 4.5 天 → 改按天配置换算
const LOG_SCAN_LOOKBACK_DAYS = parseFloat(process.env.LOG_SCAN_LOOKBACK_DAYS || '30');
const BSC_BLOCK_SECONDS = 0.45;
const LOG_SCAN_LOOKBACK_BLOCKS = Math.round(LOG_SCAN_LOOKBACK_DAYS * 86400 / BSC_BLOCK_SECONDS); // 30 天 ≈ 5.76M 块 ≈ 144 段 × 40k

// --- Token info cache ---
const tokenInfoCache = {};

async function getTokenInfo(address) {
  const addr = address.toLowerCase();
  const cached = tokenInfoCache[addr];
  // Return cached if it's a real symbol (not a fallback address stub)
  if (cached && !cached._fallback) return cached;
  // 2026-09-28 审计修复: decimals 拿不到 (decimalsUnknown) 只缓存 60s 就重试 (金额会差 1e10 倍, 不能拖 10 分钟); 只缺 symbol 仍 10 分钟
  if (cached && cached._fallback && (Date.now() - cached._ts < (cached.decimalsUnknown ? 60 * 1000 : 10 * 60 * 1000))) return cached;
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  // 2026-09-28 审计修复: symbol 与 decimals 分开 try (以前任一失败整体回退 decimals=18); symbol 过 sanitizeSymbol 净化
  const [symRes, decRes] = await Promise.allSettled([contract.symbol(), contract.decimals()]);
  const symbolOk = symRes.status === 'fulfilled';
  const decimalsOk = decRes.status === 'fulfilled';
  const info = { symbol: sanitizeSymbol(symbolOk ? symRes.value : '', address), decimals: decimalsOk ? Number(decRes.value) : 18, address };
  if (!decimalsOk) info.decimalsUnknown = true;
  if (!symbolOk || !decimalsOk) { info._fallback = true; info._ts = Date.now(); }
  tokenInfoCache[addr] = info;
  return info;
}

// --- Math helpers ---
function tickToPrice(tick, decimals0, decimals1) {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

function sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
  const sqrtPrice = Number(sqrtPriceX96) / Math.pow(2, 96);
  return sqrtPrice * sqrtPrice * Math.pow(10, decimals0 - decimals1);
}

function getTokenAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper, decimals0, decimals1) {
  const liq = Number(liquidity);
  if (liq === 0) return { amount0: 0, amount1: 0 };

  const sqrtPrice = Number(sqrtPriceX96) / Math.pow(2, 96);
  const sqrtPriceLower = Math.pow(1.0001, tickLower / 2);
  const sqrtPriceUpper = Math.pow(1.0001, tickUpper / 2);

  let amount0 = 0;
  let amount1 = 0;

  if (sqrtPrice <= sqrtPriceLower) {
    amount0 = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
  } else if (sqrtPrice >= sqrtPriceUpper) {
    amount1 = liq * (sqrtPriceUpper - sqrtPriceLower);
  } else {
    amount0 = liq * (1 / sqrtPrice - 1 / sqrtPriceUpper);
    amount1 = liq * (sqrtPrice - sqrtPriceLower);
  }

  amount0 = amount0 / Math.pow(10, decimals0);
  amount1 = amount1 / Math.pow(10, decimals1);

  return { amount0, amount1 };
}

// --- USD Price Resolution ---
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase();
const BUSD_ADDRESS = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'.toLowerCase();
const USDC_ADDRESS = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'.toLowerCase(); // 2026-09-13 随 Pancake 接入补上 (Pancake 池常用 USDC 计价)
const STABLECOINS = new Set([USDT_ADDRESS, BUSD_ADDRESS, USDC_ADDRESS]);

// 2026-09-28 审计修复: coingecko 按合约地址批量取价抽成独立函数 (主流程与账本参考价钩子 getUSDPrices 共用);
// 非 200 抛错由调用方决定回退 (以前非 200 静默当作没价), 50 个一批防 URL 过长, 15s 超时防整轮悬死
async function coingeckoBscPrices(addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 50) {
    const url = `https://api.coingecko.com/api/v3/simple/token_price/binance-smart-chain?contract_addresses=${addrs.slice(i, i + 50).join(',')}&vs_currencies=usd`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    for (const [addr, info] of Object.entries(data || {})) if (info && info.usd > 0) out[addr.toLowerCase()] = info.usd;
    if (i + 50 < addrs.length) await sleep(1200);
  }
  return out;
}

// meta (可选, 传对象进来): 回填 stale=沿用上轮价的 token 集合, missing=连上轮价都没有 (=0) 的集合, priceMiss=两者之和, coingeckoOk
async function getUSDPrices(tokenAddresses, positionsData, meta = {}) {
  const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
  const prices = {};

  for (const addr of unique) {
    if (STABLECOINS.has(addr)) prices[addr] = 1.0;
  }

  let coingeckoOk = true;
  const needCoinGecko = unique.filter(a => !prices[a]);
  if (needCoinGecko.length > 0) {
    try {
      Object.assign(prices, await coingeckoBscPrices(needCoinGecko));
    } catch (e) {
      coingeckoOk = false;
      console.error('CoinGecko API error:', e.message);
    }
  }

  // Derive prices from pool data, preferring active in-range positions
  // Track which source set each price so we can upgrade later
  const priceSource = {}; // addr -> 'active-inrange' | 'active' | 'inactive'
  for (const pos of positionsData) {
    const t0 = pos.token0addr.toLowerCase();
    const t1 = pos.token1addr.toLowerCase();
    if (pos.currentPrice <= 0) continue;

    let target, price;
    if (STABLECOINS.has(t1) && !STABLECOINS.has(t0)) {
      target = t0; price = pos.currentPrice;
    } else if (STABLECOINS.has(t0) && !STABLECOINS.has(t1)) {
      target = t1; price = 1 / pos.currentPrice;
    } else continue;

    const src = pos.liquidityActive && pos.inRange ? 'active-inrange'
              : pos.liquidityActive ? 'active'
              : 'inactive';
    const rank = { 'active-inrange': 3, 'active': 2, 'inactive': 1 };
    const existing = priceSource[target];
    if (!prices[target] || rank[src] > rank[existing]) {
      prices[target] = price;
      priceSource[target] = src;
    }
  }

  // 2026-09-28 审计修复: 缺价不再静默归零 —— 先回退上轮价 (lastUsdPricesBsc, 记入 meta.stale), 上轮也没有的才是 0 (记入 meta.missing)
  const stale = new Set(), missing = new Set();
  for (const addr of unique) {
    if (prices[addr] > 0) continue;
    const prev = lastUsdPricesBsc[addr];
    if (prev > 0) { prices[addr] = prev; stale.add(addr); }
    else { prices[addr] = 0; missing.add(addr); }
  }
  meta.stale = stale; meta.missing = missing; meta.priceMiss = stale.size + missing.size; meta.coingeckoOk = coingeckoOk;
  if (meta.priceMiss) console.log(`  [bsc] 定价缺失 ${meta.priceMiss} 个 token (沿用上轮 ${stale.size}, 无价 ${missing.size})${coingeckoOk ? '' : ' [coingecko 失败]'}`);

  return prices;
}

// --- 钱包闲置余额 (LP 之外): 候选=LP 涉及 token + USDT/BUSD + WBNB, native BNB 单列 ---
// (BSC 无法免索引器枚举全部 ERC20, 与 EVM 适配器同口径; <$1 灰尘过滤)
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
let lastIdleBsc = null;
async function fetchIdleBsc(walletsSel, tokens, usdPrices, priceMeta = {}) {
  if (walletsSel.length === 0) return { totalUSD: 0, byWallet: {} };
  const staleSet = priceMeta.stale || new Set(), missingSet = priceMeta.missing || new Set();
  const wbnbL = WBNB.toLowerCase();
  const bnbPrice = usdPrices[wbnbL] || 0;
  const bnbStale = staleSet.has(wbnbL) || missingSet.has(wbnbL);
  const byWallet = {}; let totalUSD = 0;
  for (const w of walletsSel) {
    const items = [];
    const bnb = Number(await provider.getBalance(w.address)) / 1e18;
    const bnbVal = bnb * bnbPrice;
    // 2026-09-28 审计修复: BNB 缺价 (价=0) 时不再整条丢掉 (bnbVal<1 是因为没价不是余额小): 保留数量, valueUSD=0, 打 priceStale; 沿用上轮价的也打标
    if (bnbVal >= 1 || (bnbPrice === 0 && bnb > 0)) items.push({ symbol: 'BNB', address: 'native', amount: bnb, priceUSD: bnbPrice, valueUSD: bnbVal, native: true, ...(bnbStale ? { priceStale: true } : {}) });
    for (let i = 0; i < tokens.length; i += 8) {
      const batch = tokens.slice(i, i + 8);
      const rs = await Promise.all(batch.map(async (a) => {
        try {
          const bal = await new ethers.Contract(a, ERC20_BAL_ABI, provider).balanceOf(w.address);
          return { a, bal };
        } catch { return { a, bal: 0n }; }
      }));
      for (const { a, bal } of rs) {
        if (bal === 0n) continue;
        const meta = await getTokenInfo(a);
        const amount = Number(bal) / 10 ** (meta?.decimals ?? 18);
        const price = STABLECOINS.has(a) ? 1 : (usdPrices[a] || 0);
        const v = amount * price;
        if (v < 1) continue;
        items.push({ symbol: meta?.symbol || a.slice(0, 6), address: a, amount, priceUSD: price, valueUSD: v, ...(staleSet.has(a) ? { priceStale: true } : {}) });   // 2026-09-28 审计修复: 沿用上轮价的条目打标
      }
    }
    items.sort((x, y) => y.valueUSD - x.valueUSD);
    const wTotal = items.reduce((s, t) => s + t.valueUSD, 0);
    byWallet[w.address] = { name: w.name, totalUSD: wTotal, tokens: items };
    totalUSD += wTotal;
  }
  return { totalUSD, byWallet };
}

// --- Uncollected fees via collect staticCall ---
async function getUnclaimedFees(positionManager, tokenId, walletAddress) {
  try {
    const MAX_UINT128 = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const result = await positionManager.collect.staticCall({
      tokenId: tokenId,
      recipient: walletAddress,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    }, { from: walletAddress });
    return { fees0: result.amount0, fees1: result.amount1 };
  } catch (e) {
    return { fees0: 0n, fees1: 0n };
  }
}

// --- Fee tier labels ---
function feeLabel(fee) {
  const map = { 100: '0.01%', 500: '0.05%', 2500: '0.25%', 3000: '0.3%', 10000: '1%' };
  if (Number(fee) === 0x800000) return '动态';  // V4 DYNAMIC_FEE_FLAG, 真实费率由 hook 决定
  return map[Number(fee)] || `${(Number(fee) / 10000).toFixed(2)}%`;
}

// --- PancakeSwap V3 (2026-09-13): 独立模块, 注入本文件的 provider/数学/缓存助手; 见 pancake-bsc.js 顶部说明 ---
let pcsBsc = null;
function getPcs() {
  if (!pcsBsc) {
    pcsBsc = require('./pancake-bsc').create({ ethers, provider, getTokenInfo, tickToPrice, sqrtPriceX96ToPrice, getTokenAmounts, feeLabel, batchedAll, withRetry, sleep, dir: __dirname });
  }
  return pcsBsc;
}

// --- V4 helpers ---
function decodePackedPositionInfo(info) {
  const tickUpperRaw = Number((info >> 32n) & 0xffffffn);
  const tickLowerRaw = Number((info >> 8n) & 0xffffffn);
  return {
    tickUpper: tickUpperRaw >= 0x800000 ? tickUpperRaw - 0x1000000 : tickUpperRaw,
    tickLower: tickLowerRaw >= 0x800000 ? tickLowerRaw - 0x1000000 : tickLowerRaw,
  };
}

function computePoolId(poolKey) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  );
}

// V4: query subgraph for position IDs (cached V4_ID_CACHE_TTL, key-pool); v4pm 可选, 用于子图回空时链上核对 balanceOf
async function getV4PositionIds(walletAddress, v4pm = null) {
  const cacheKey = walletAddress.toLowerCase();
  const cached = v4IdCache[cacheKey];
  if (cached && (Date.now() - cached.ts < V4_ID_CACHE_TTL)) {
    return cached.ids;
  }
  // 2026-09-28 审计修复: first:200 无分页 → first:1000 + id_gt 游标分页 (最多 5 页)
  const rows = await graphQueryPaged(V4_SUBGRAPH_ID,
    lastId => `{ positions(first: 1000, orderBy: id, orderDirection: asc, where: { owner: "${cacheKey}"${lastId ? `, id_gt: "${lastId}"` : ''} }) { id tokenId createdAtTimestamp } }`,
    d => d.positions);
  let useChain = !rows;
  if (rows && rows.length === 0 && v4pm) {
    // 2026-09-28 审计修复: 子图回空数组 ([] 是真值, 以前直接当「确实没仓」) 但链上 balanceOf>0 = 子图滞后/漏索引 → 走链上兜底
    try {
      if (Number(await withRetry(() => v4pm.balanceOf(walletAddress), 2, 800)) > 0) { useChain = true; console.log(`  V4 subgraph empty but balanceOf>0 for ${cacheKey}, chain fallback`); }
    } catch (e) { useChain = true; console.error(`  V4 balanceOf check failed for ${cacheKey}:`, e.message?.slice(0, 80)); }
  }
  if (useChain) {
    // Fallback: chain scan (no Graph key or subgraph down)
    try {
      const sc = await scanV4Chain();
      const owned = sc.owned[cacheKey] || [];
      if (sc.failed.has(cacheKey) && owned.length === 0) throw new Error('nr_getNFTInventory failed, no cached ids');
      const ids = [];
      for (const o of owned) {
        ids.push({ id: o.id, createdAt: o.mintBlock > 0 ? await blockTimestamp(o.mintBlock) : 0 });   // 2026-09-28 审计修复: mint 块未知 → createdAt=0, 不查创世块
      }
      v4IdCache[cacheKey] = { ids, ts: Date.now() };
      return ids;
    } catch (e) {
      console.error(`  V4 chain-scan fallback failed for ${cacheKey}:`, e.message?.slice(0, 100));
      if (cached?.ids) return cached.ids;
      // 2026-09-28 审计修复: 子图+链上都失败且无旧缓存 → 抛错让钱包级沿用上轮, 不再回 [] 冒充零仓
      throw new Error(`V4 positions enumeration failed: ${e.message?.slice(0, 80)}`);
    }
  }
  const ids = rows.map(p => ({ id: BigInt(p.tokenId), createdAt: Number(p.createdAtTimestamp || 0) * 1000 }));
  v4IdCache[cacheKey] = { ids, ts: Date.now() };
  return ids;
}

// V4: get token info, handling native BNB (address(0))
async function getTokenInfoV4(address) {
  if (address === ethers.ZeroAddress || address === '0x0000000000000000000000000000000000000000') {
    return { symbol: 'BNB', decimals: 18, address: WBNB }; // use WBNB address for pricing
  }
  return getTokenInfo(address);
}

// V3: query subgraph for position creation timestamps + collected fees history
async function getV3SubgraphData(walletAddress) {
  const addr = walletAddress.toLowerCase();
  try {
    // 2026-09-28 审计修复: first:200 无分页 → first:1000 + id_gt 游标分页 (最多 5 页); 失败/空 → 链上兜底 (调用方已知 balanceOf>0)
    const rows = await graphQueryPaged(V3_SUBGRAPH_ID,
      lastId => `{ positions(first: 1000, orderBy: id, orderDirection: asc, where: { owner: "${addr}"${lastId ? `, id_gt: "${lastId}"` : ''} }) { id transaction { timestamp } collectedFeesToken0 collectedFeesToken1 } }`,
      d => d.positions);
    if (!rows || rows.length === 0) {
      const chainCreated = await getV3CreatedFromChain(walletAddress);
      return { created: chainCreated, collectedFees: {} };
    }
    const created = {};
    const collectedFees = {};
    for (const p of rows) {
      const ts = p.transaction?.timestamp;
      if (ts) created[p.id] = Number(ts) * 1000;
      collectedFees[p.id] = {
        token0: parseFloat(p.collectedFeesToken0 || '0'),
        token1: parseFloat(p.collectedFeesToken1 || '0'),
      };
    }
    if (Object.keys(created).length === 0) {
      const chainCreated = await getV3CreatedFromChain(walletAddress);
      return { created: chainCreated, collectedFees };
    }
    return { created, collectedFees };
  } catch (e) {
    console.error(`V3 subgraph query failed for ${addr}:`, e.message?.slice(0, 80));
    const chainCreated = await getV3CreatedFromChain(walletAddress);
    return { created: chainCreated, collectedFees: {} };
  }
}

// V3: get last Collect event timestamps from chain for specific tokenIds
const v3CollectCache = {};
// 持久化 collect 缓存: 重启不丢。否则每次重启后所有仓位全量回扫 30 天事件, 一轮拉取拖到 8 分钟
const COLLECT_CACHE_FILE = path.join(__dirname, 'collect-cache-bsc.json');
try {
  const savedCollect = JSON.parse(fs.readFileSync(COLLECT_CACHE_FILE, 'utf8'));
  Object.assign(v3CollectCache, savedCollect.v3 || {});
  console.log(`Loaded collect cache from disk (${Object.keys(v3CollectCache).length} entries)`);
} catch { /* no cache yet */ }
function saveCollectCache() {
  try { writeJsonAtomic(COLLECT_CACHE_FILE, { v3: v3CollectCache }); } catch {}   // 2026-09-28 审计修复: 原子写
}
const V3_COLLECT_CACHE_TTL = 30 * 60 * 1000; // 30 min for found collects
const V3_COLLECT_MISS_TTL = 2 * 60 * 1000;  // 2 min for "not found" (retry sooner)
const COLLECT_EVENT_TOPIC = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';

async function getV3LastCollectTimes(tokenIds) {
  const results = {};
  const toQuery = [];
  const now = Date.now();

  for (const tid of tokenIds) {
    const key = tid.toString();
    const cached = v3CollectCache[key];
    if (cached) {
      const ttl = cached.collectAt ? V3_COLLECT_CACHE_TTL : V3_COLLECT_MISS_TTL;
      if (now - cached.ts < ttl) {
        if (cached.collectAt) results[key] = cached.collectAt;
        continue;
      }
    }
    toQuery.push(tid);
  }

  if (toQuery.length === 0) return results;

  // Strategy 1: Ankr Advanced API (one request per token, ~200ms each)
  if (ANKR_ADVANCED_URL) {
    const remaining = [];
    for (const tid of toQuery) {
      const key = tid.toString();
      try {
        const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(tid), 32);
        const body = {
          jsonrpc: '2.0', method: 'ankr_getLogs', id: 1,
          params: {
            blockchain: 'bsc',
            address: [V3_POSITION_MANAGER],
            topics: [[COLLECT_EVENT_TOPIC], [tokenIdHex]],
            fromBlock: 1, toBlock: 'latest',
            pageSize: 1, descOrder: true
          }
        };
        const res = await fetch(nextAnkrUrl(), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error.message || 'ankr_getLogs error');   // 2026-09-28 审计修复: 限流/错误以前被当成「没领过费」缓存
        // 2026-09-28 审计修复: Ankr 是全历史查询, 写缓存时保留 getLogs 兜底的 scannedTo 增量游标 (以前整条覆盖, Ankr 一抖就回退全量回扫 30 天)
        const cur = v3CollectCache[key]?.scannedTo ? { scannedTo: v3CollectCache[key].scannedTo } : {};
        if (data.result?.logs?.[0]) {
          const log = data.result.logs[0];
          const time = parseInt(log.timestamp, 16) * 1000;
          results[key] = time;
          v3CollectCache[key] = { ...cur, collectAt: time, ts: now };
          console.log(`  Last collect for #${key}: ${new Date(time).toISOString()} (Ankr Advanced)`);
        } else {
          v3CollectCache[key] = { ...cur, collectAt: 0, ts: now };
        }
      } catch (e) {
        console.log(`  Ankr collect failed for #${key}: ${e.message?.slice(0, 80)}, queuing fallback`);
        remaining.push(tid);
      }
    }
    if (remaining.length === 0) { saveCollectCache(); return results; }
    toQuery.length = 0;
    toQuery.push(...remaining);
  }

  // 2026-09-28 审计修复: 先用已知的 collectAt 预填 results, getBlockNumber/整批失败时不会把已知的领费时间丢成 0
  for (const tid of toQuery) { const c = v3CollectCache[tid.toString()]; if (c?.collectAt) results[tid.toString()] = c.collectAt; }

  // Strategy 2: Fallback to chunked getLogs scan (NodeReal LOG_RPC)
  try {
    const currentBlock = await logProvider.getBlockNumber();
    const blockStep = 40000; // nodereal supports 45k-range getLogs
    const lookbackBlocks = LOG_SCAN_LOOKBACK_BLOCKS; // 按天配置 (默认 30 天), 见顶部
    const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

    for (const tid of toQuery) {
      const key = tid.toString();
      try {
        const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(tid), 32);
        const prev = v3CollectCache[key];
        // 增量扫描: 已扫过的区块不再重扫 (全量回扫30天是一轮拉取拖到8分钟的元凶)
        const floor = Math.max(fromBlock, (prev?.scannedTo || 0) + 1);
        let foundBlockNumber = null;
        // 2026-09-28 审计修复: 失败段重试一次仍失败 → 记下最低失败段起点, scannedTo 只推进到它之前 (以前跳过失败段却把 scannedTo 推到链头, 段内领费永久漏掉)
        let minFailedStart = null;
        for (let end = currentBlock; end >= floor; end -= blockStep) {
          const start = Math.max(floor, end - blockStep + 1);
          let logs = null;
          for (let attempt = 0; attempt < 2 && !logs; attempt++) {
            try {
              logs = await logProvider.getLogs({
                address: V3_POSITION_MANAGER,
                topics: [COLLECT_EVENT_TOPIC, tokenIdHex],
                fromBlock: start,
                toBlock: end,
              });
            } catch (e) {
              await sleep(500);
            }
          }
          if (!logs) { minFailedStart = start; await sleep(50); continue; }   // 从新往旧扫, 越后失败的段越旧, 直接覆盖即最小
          if (logs.length > 0) {
            foundBlockNumber = logs[logs.length - 1].blockNumber;
            break;
          }
          await sleep(50);
        }
        const partial = minFailedStart !== null;
        const scannedTo = partial ? minFailedStart - 1 : currentBlock;   // 有失败段: 游标停在失败段之前, 下轮从那里补扫
        const stamp = partial ? 0 : now;                                    // 有失败段: ts=0 让下一轮立刻补扫缺口 (只扫游标之后)
        if (partial) console.log(`  Collect scan for #${key}: segment(s) failed, scannedTo held at ${scannedTo} (head ${currentBlock})`);

        if (foundBlockNumber) {
          const block = await logProvider.getBlock(foundBlockNumber);
          if (block) {
            results[key] = block.timestamp * 1000;
            v3CollectCache[key] = { collectAt: block.timestamp * 1000, ts: stamp, scannedTo };
          } else if (prev?.collectAt) {
            results[key] = prev.collectAt;   // 取块失败: 保留旧值, 游标不动, 下轮重试
          }
        } else {
          // 新扫区间没事件: 保留旧 collectAt (已扫过的历史区间不会凭空长出新事件)
          const keep = prev?.collectAt || 0;
          if (keep) results[key] = keep;
          v3CollectCache[key] = { collectAt: keep, ts: stamp, scannedTo };
        }
      } catch (e) {
        console.error(`  Collect event query failed for token ${key}:`, e.message?.slice(0, 120));
        v3CollectCache[key] = { collectAt: v3CollectCache[key]?.collectAt || 0, ts: now, scannedTo: v3CollectCache[key]?.scannedTo || 0 };
      }
    }
  } catch (e) {
    console.error('Collect event batch query failed:', e.message?.slice(0, 120));
  }

  saveCollectCache();
  return results;
}

// V4: get last Collect timestamps from PoolManager ModifyLiquidity events (liquidityDelta=0)
const v4CollectCache = {};
// 2026-09-13 事件扫描 (v4collect-logs.js) 的持久化游标: 按池的 scannedTo/floor/done + 每 tokenId 最新领费块高; 重启不重扫
const V4_LOGSCAN_FILE = path.join(__dirname, 'v4collect-cache-bsc.json');
let _v4LogScanStore = null;
function v4LogScanStore() {
  if (!_v4LogScanStore) { try { _v4LogScanStore = JSON.parse(fs.readFileSync(V4_LOGSCAN_FILE, 'utf8')); } catch { _v4LogScanStore = {}; } }
  return _v4LogScanStore;
}
let _v4SaveTimer = null;
function saveV4LogScanStore() { // 合并写 (扫描中每段都会调一次)
  if (_v4SaveTimer) return;
  _v4SaveTimer = setTimeout(() => { _v4SaveTimer = null; try { const tmp = V4_LOGSCAN_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_v4LogScanStore || {})); fs.renameSync(tmp, V4_LOGSCAN_FILE); } catch {} }, 500);
}
const V4_COLLECT_CACHE_TTL = 30 * 60 * 1000; // 30 min for found collects
const V4_COLLECT_MISS_TTL = 2 * 60 * 1000;  // 2 min for "not found" (retry sooner)
const MODIFY_LIQUIDITY_TOPIC = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';

async function getV4LastCollectTimes(positions) {
  // positions: array of { tokenId, poolId, tickLower, tickUpper }
  const results = {};
  const toQuery = [];
  const now = Date.now();

  for (const pos of positions) {
    const key = pos.tokenId.toString();
    const cached = v4CollectCache[key];
    if (cached) {
      const ttl = cached.collectAt ? V4_COLLECT_CACHE_TTL : V4_COLLECT_MISS_TTL;
      if (now - cached.ts < ttl) {
        if (cached.collectAt) results[key] = cached.collectAt;
        continue;
      }
    }
    toQuery.push(pos);
  }

  if (toQuery.length === 0) return results;

  // 2026-09-13: 没配 Ankr 时改走标准 eth_getLogs 事件扫描 (v4collect-logs.js, salt==tokenId 精确归属);
  // 旧逻辑会把 ankr_getLogs 打到 BSC_RPC 上必然失败 → V4 lastCollectAt 永远 0。有 Ankr 的仍走下面原路径。
  if (!ANKR_ADVANCED_URL) {
    try {
      const { scanV4CollectsViaLogs } = require('./v4collect-logs');
      const r = await scanV4CollectsViaLogs({
        ethers, logProvider, poolManager: V4_POOL_MANAGER, positionManager: V4_POSITION_MANAGER,
        positions: toQuery, lookbackBlocks: LOG_SCAN_LOOKBACK_BLOCKS, blockStep: 49999,
        store: v4LogScanStore(), save: saveV4LogScanStore, budgetCalls: 120, budgetMs: 45000, now, log: console.log,
      });
      Object.assign(results, r.results);
      for (const pos of toQuery) { const k = pos.tokenId.toString(); v4CollectCache[k] = { collectAt: r.results[k] || 0, ts: now }; }
      console.log(`  V4 collect scan (logs): ${toQuery.length} positions, ${Object.keys(r.results).length} with collects, ${r.calls} getLogs${r.errors ? `, ${r.errors} errors` : ''}${r.budgetHit ? ', budget hit (resumes next round)' : ''}`);
    } catch (e) {
      console.error('  V4 collect scan (logs) failed:', e.message?.slice(0, 120));
      for (const pos of toQuery) { const k = pos.tokenId.toString(); v4CollectCache[k] = { collectAt: v4CollectCache[k]?.collectAt || 0, ts: now }; }
    }
    return results;
  }

  // Group by poolId to minimize queries
  const byPool = new Map();
  for (const pos of toQuery) {
    const arr = byPool.get(pos.poolId) || [];
    arr.push(pos);
    byPool.set(pos.poolId, arr);
  }

  const V4_PM_PADDED = ethers.zeroPadValue(V4_POSITION_MANAGER, 32);

  for (const [poolId, poolPositions] of byPool) {
    try {
      // Query all ModifyLiquidity events for this pool from PositionManager
      const body = {
        jsonrpc: '2.0', method: 'ankr_getLogs', id: 1,
        params: {
          blockchain: 'bsc',
          address: [V4_POOL_MANAGER],
          topics: [[MODIFY_LIQUIDITY_TOPIC], [poolId], [V4_PM_PADDED]],
          fromBlock: 1, toBlock: 'latest',
          pageSize: 100, descOrder: true,
        },
      };

      const ankrUrl = ANKR_ADVANCED_URL ? nextAnkrUrl() : BSC_RPC.replace('/bsc/', '/multichain/');
      const res = await fetch(ankrUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || 'ankr_getLogs error');   // 2026-09-28 审计修复: 错误响应不当成「无日志」
      const logs = data.result?.logs || [];


      for (const pos of poolPositions) {
        const key = pos.tokenId.toString();
        let found = false;
        const saltHex = ethers.zeroPadValue(ethers.toBeHex(BigInt(pos.tokenId)), 32).toLowerCase();   // 2026-09-28 审计修复: V4 salt == tokenId, 同区间不同仓靠它区分

        for (const log of logs) {
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ['int24', 'int24', 'int256', 'bytes32'], log.data
            );
            const tickLower = Number(decoded[0]);
            const tickUpper = Number(decoded[1]);
            const liquidityDelta = decoded[2];
            const salt = String(decoded[3]).toLowerCase();

            // Match: same tick range AND same salt(tokenId) AND liquidityDelta === 0 (pure collect)
            if (tickLower === pos.tickLower && tickUpper === pos.tickUpper && salt === saltHex && liquidityDelta === 0n) {
              const time = parseInt(log.timestamp, 16) * 1000;
              results[key] = time;
              v4CollectCache[key] = { collectAt: time, ts: now };
              console.log(`  V4 last collect for #${key}: ${new Date(time).toISOString()} (ticks ${tickLower}~${tickUpper})`);
              found = true;
              break;
            }
          } catch (e) { /* skip malformed log */ }
        }

        if (!found) {
          v4CollectCache[key] = { collectAt: 0, ts: now };
        }
      }
    } catch (e) {
      console.error(`  V4 collect query failed for pool ${poolId.slice(0, 20)}:`, e.message?.slice(0, 100));
      for (const pos of poolPositions) {
        v4CollectCache[pos.tokenId.toString()] = { collectAt: 0, ts: now };
      }
    }
  }

  return results;
}

// V3: fallback - get creation time from NFT mint Transfer event for a SINGLE tokenId
const V3_CREATED_CACHE_FILE = path.join(__dirname, 'created-cache-bsc.json');
let v3CreatedChainCache = {};
try { v3CreatedChainCache = JSON.parse(fs.readFileSync(V3_CREATED_CACHE_FILE, 'utf8')); } catch {}
function saveV3CreatedCache() {
  try { writeJsonAtomic(V3_CREATED_CACHE_FILE, v3CreatedChainCache); } catch {}   // 2026-09-28 审计修复: 原子写
}
const V3_CREATED_CHAIN_TTL = 24 * 60 * 60 * 1000; // 24h — 只对"查失败"的条目生效；查到的永久缓存。老仓(>30天回溯范围)每次扫必失败，1h重试纯浪费
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDR_PADDED = ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32);

async function getV3CreatedFromChain(walletAddress) {
  // Returns empty map — real per-tokenId lookup happens in getV3MintTime
  return {};
}

// Per-tokenId mint time lookup (chunked, backward scan from latest)
async function getV3MintTime(tokenId) {
  const key = tokenId.toString();
  const cached = v3CreatedChainCache[key];
  // 查到过的创建时间永久有效（mint 时间不可变）；只有查失败(time=0)的才按 TTL 重试
  if (cached && (cached.time > 0 || Date.now() - cached.ts < V3_CREATED_CHAIN_TTL)) return cached.time;

  // Strategy 1: Ankr Advanced API (single request, ~200ms)
  if (ANKR_ADVANCED_URL) {
    try {
      const body = {
        jsonrpc: '2.0', method: 'ankr_getLogs', id: 1,
        params: {
          blockchain: 'bsc',
          address: [V3_POSITION_MANAGER],
          topics: [
            [TRANSFER_EVENT_TOPIC],
            [ZERO_ADDR_PADDED],
            [],
            [ethers.zeroPadValue(ethers.toBeHex(tokenId), 32)]
          ],
          fromBlock: 1, toBlock: 'latest', pageSize: 1, descOrder: false
        }
      };
      const res = await fetch(nextAnkrUrl(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
      });
      const data = await res.json();
      if (data.result?.logs?.[0]) {
        const log = data.result.logs[0];
        const time = parseInt(log.timestamp, 16) * 1000;
        v3CreatedChainCache[key] = { time, ts: Date.now() }; saveV3CreatedCache();
        console.log(`  Mint time for #${key}: ${new Date(time).toISOString()} (Ankr Advanced)`);
        return time;
      }
    } catch (e) {
      console.log(`  Ankr Advanced mint time failed for #${key}: ${e.message?.slice(0, 80)}, falling back to chain scan`);
    }
  }

  // Strategy 2: Fallback to chunked getLogs scan
  try {
    const currentBlock = await logProvider.getBlockNumber();
    const blockStep = 40000; // nodereal supports 45k-range getLogs
    const lookback = LOG_SCAN_LOOKBACK_BLOCKS; // 按天配置 (默认 30 天), 见顶部
    const fromBlock = Math.max(0, currentBlock - lookback);
    const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);

    for (let end = currentBlock; end >= fromBlock; end -= blockStep) {
      const start = Math.max(fromBlock, end - blockStep + 1);
      try {
        const logs = await logProvider.getLogs({
          address: V3_POSITION_MANAGER,
          topics: [TRANSFER_EVENT_TOPIC, ZERO_ADDR_PADDED, null, tokenIdHex],
          fromBlock: start,
          toBlock: end,
        });
        if (logs.length > 0) {
          const block = await logProvider.getBlock(logs[0].blockNumber);
          const time = block ? block.timestamp * 1000 : 0;
          v3CreatedChainCache[key] = { time, ts: Date.now() }; saveV3CreatedCache();
          console.log(`  Mint time for #${key}: ${new Date(time).toISOString()} (chain scan)`);
          return time;
        }
      } catch (e) {
        await sleep(500);
      }
      await sleep(50);
    }
  } catch (e) {
    console.error(`  Mint time query failed for #${key}:`, e.message?.slice(0, 120));
  }

  v3CreatedChainCache[key] = { time: 0, ts: Date.now() };
  return 0;
}

// --- Concurrency limiter ---
async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

// --- Fetch V4 positions for a single wallet ---
async function fetchWalletV4Positions(wallet, v4pm, stateView) {
  const walletAddress = wallet.address;
  const walletName = wallet.name;

  const tokenIds = await getV4PositionIds(walletAddress, v4pm);   // 2026-09-28 审计修复: 传 v4pm 供子图回空时链上核对
  if (tokenIds.length === 0) return [];

  console.log(`  ${walletName} V4: ${tokenIds.length} positions from subgraph`);
  const positions = [];

  for (const tokenEntry of tokenIds) {
    const tokenId = typeof tokenEntry === 'object' ? tokenEntry.id : tokenEntry;
    const createdAtMs = typeof tokenEntry === 'object' ? tokenEntry.createdAt : 0;
    try {
      const [[poolKey, info], liquidity] = await Promise.all([
        withRetry(() => v4pm.getPoolAndPositionInfo(tokenId)),
        withRetry(() => v4pm.getPositionLiquidity(tokenId)),
      ]);

      const { tickLower, tickUpper } = decodePackedPositionInfo(info);
      const token0Info = await getTokenInfoV4(poolKey.currency0);
      const token1Info = await getTokenInfoV4(poolKey.currency1);

      // Get pool state
      const poolId = computePoolId(poolKey);
      let sqrtPriceX96, currentTick;
      try {
        const slot0 = await withRetry(() => stateView.getSlot0(poolId));
        sqrtPriceX96 = slot0.sqrtPriceX96;
        currentTick = Number(slot0.tick);
      } catch (e) {
        console.error(`  V4 StateView error for token ${tokenId}:`, e.message.slice(0, 80));
        continue;
      }

      const inRange = currentTick >= tickLower && currentTick < tickUpper;
      const currentPrice = sqrtPriceX96ToPrice(sqrtPriceX96, token0Info.decimals, token1Info.decimals);
      const lowerPrice = tickToPrice(tickLower, token0Info.decimals, token1Info.decimals);
      const upperPrice = tickToPrice(tickUpper, token0Info.decimals, token1Info.decimals);

      const { amount0, amount1 } = getTokenAmounts(
        liquidity, sqrtPriceX96, tickLower, tickUpper,
        token0Info.decimals, token1Info.decimals
      );

      // V4 uncollected fees calculation
      let feesOwed0 = 0, feesOwed1 = 0;
      if (Number(liquidity) > 0) {
        try {
          const salt = ethers.zeroPadValue(ethers.toBeHex(tokenId), 32);
          const [posInfo, fgi] = await Promise.all([
            withRetry(() => stateView.getPositionInfo(poolId, V4_POSITION_MANAGER, tickLower, tickUpper, salt)),
            withRetry(() => stateView.getFeeGrowthInside(poolId, tickLower, tickUpper)),
          ]);
          const posLiq = posInfo.liquidity;
          if (posLiq > 0n) {
            // uint256 wrapping subtraction (Solidity semantics)
            const MAX_U256 = (1n << 256n) - 1n;
            const diff0 = (fgi.feeGrowthInside0X128 - posInfo.feeGrowthInside0LastX128 + MAX_U256 + 1n) & MAX_U256;
            const diff1 = (fgi.feeGrowthInside1X128 - posInfo.feeGrowthInside1LastX128 + MAX_U256 + 1n) & MAX_U256;
            const raw0 = diff0 * posLiq / Q128;
            const raw1 = diff1 * posLiq / Q128;
            feesOwed0 = Number(raw0) / Math.pow(10, token0Info.decimals);
            feesOwed1 = Number(raw1) / Math.pow(10, token1Info.decimals);
            // Sanity check: if fees are unreasonably large, likely stale data
            if (feesOwed0 > 1e12) feesOwed0 = 0;
            if (feesOwed1 > 1e12) feesOwed1 = 0;
          }
        } catch (e) {
          console.error(`  V4 fee calc error for token ${tokenId}:`, e.message.slice(0, 80));
        }
      }

      positions.push({
        tokenId: tokenId.toString(),
        token0: token0Info,
        token1: token1Info,
        token0addr: token0Info.address,
        token1addr: token1Info.address,
        fee: Number(poolKey.fee),
        feeLabel: feeLabel(poolKey.fee),
        tickLower,
        tickUpper,
        currentTick,
        liquidity: liquidity.toString(),
        liquidityActive: Number(liquidity) > 0,
        inRange,
        currentPrice,
        lowerPrice,
        upperPrice,
        amount0,
        amount1,
        feesOwed0,
        feesOwed1,
        poolAddress: poolId,
        walletName,
        walletAddress,
        protocol: 'V4',
        createdAt: createdAtMs || 0,
        lastCollectAt: 0, // filled later by getV4LastCollectTimes
      });
    } catch (e) {
      console.error(`  V4 error for token ${tokenId}:`, e.message.slice(0, 80));
    }
    await sleep(150);
  }
  return positions;
}

// --- Fetch V3 positions for a single wallet ---
async function fetchWalletPositions(wallet, positionManager, factory) {
  const walletAddress = wallet.address;
  const walletName = wallet.name;

  // 1. Get balance
  let balance;
  try {
    balance = await withRetry(() => positionManager.balanceOf(walletAddress), 3, 800);
  } catch (e) {
    // 2026-09-28 审计修复: 重试后仍失败改为抛错 (调用方沿用上轮并记 failedWallets), 不再回 [] 冒充零仓
    throw new Error(`V3 balanceOf failed for ${walletName}: ${e.message?.slice(0, 80)}`);
  }
  const count = Number(balance);

  if (count === 0) return [];

  // Fetch creation timestamps + collected fees from subgraph
  const { created: createdMap, collectedFees: collectedFeesMap } = await getV3SubgraphData(walletAddress);

  console.log(`  ${walletName} V3: ${count} NFTs found`);

  // 2. Get all token IDs (batched to avoid rate limits)
  const indices = Array.from({ length: count }, (_, i) => i);
  const tokenIds = await batchedAll(indices, (i) =>
    withRetry(() => positionManager.tokenOfOwnerByIndex(walletAddress, i))
  );

  // 3. Get all positions (batched)
  const rawPositions = await batchedAll(tokenIds, (id) =>
    withRetry(() => positionManager.positions(id))
  );

  // 4. Process ONLY active positions (skip closed ones entirely)
  const positions = [];

  for (let i = 0; i < rawPositions.length; i++) {
    const pos = rawPositions[i];
    const liquidity = pos.liquidity;

    // Skip closed positions — no need to query pool/fees
    if (Number(liquidity) === 0) continue;

    const token0Info = await getTokenInfo(pos.token0);
    const token1Info = await getTokenInfo(pos.token1);

    // Get pool address and current price (with retry)
    let poolAddress, sqrtPriceX96, currentTick;
    try {
      poolAddress = await withRetry(() => factory.getPool(pos.token0, pos.token1, pos.fee));
      if (poolAddress === ethers.ZeroAddress) throw new Error('Pool not found');
      const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
      const slot0 = await withRetry(() => pool.slot0());
      sqrtPriceX96 = slot0.sqrtPriceX96;
      currentTick = Number(slot0.tick);
    } catch (e) {
      console.error(`Failed to get pool for position ${tokenIds[i]} (${walletName}):`, e.message);
      continue;
    }
    await sleep(100);

    const tickLower = Number(pos.tickLower);
    const tickUpper = Number(pos.tickUpper);
    const inRange = currentTick >= tickLower && currentTick < tickUpper;

    const currentPrice = sqrtPriceX96ToPrice(sqrtPriceX96, token0Info.decimals, token1Info.decimals);
    const lowerPrice = tickToPrice(tickLower, token0Info.decimals, token1Info.decimals);
    const upperPrice = tickToPrice(tickUpper, token0Info.decimals, token1Info.decimals);

    const { amount0, amount1 } = getTokenAmounts(
      liquidity, sqrtPriceX96, tickLower, tickUpper,
      token0Info.decimals, token1Info.decimals
    );

    // Uncollected fees
    const { fees0, fees1 } = await getUnclaimedFees(positionManager, tokenIds[i], walletAddress);
    const feesOwed0 = Number(fees0) / Math.pow(10, token0Info.decimals);
    const feesOwed1 = Number(fees1) / Math.pow(10, token1Info.decimals);

    positions.push({
      tokenId: tokenIds[i].toString(),
      token0: token0Info,
      token1: token1Info,
      token0addr: pos.token0,
      token1addr: pos.token1,
      fee: Number(pos.fee),
      feeLabel: feeLabel(pos.fee),
      tickLower,
      tickUpper,
      currentTick,
      liquidity: liquidity.toString(),
      liquidityActive: true,
      inRange,
      currentPrice,
      lowerPrice,
      upperPrice,
      amount0,
      amount1,
      feesOwed0,
      feesOwed1,
      poolAddress,
      walletName,
      walletAddress,
      protocol: 'V3',
      createdAt: createdMap[tokenIds[i].toString()] || 0,
      lastCollectAt: 0, // filled after all positions fetched
      collectedFees: collectedFeesMap[tokenIds[i].toString()] || { token0: 0, token1: 0 },
    });
  }

  return positions;
}

// --- Main fetch (all wallets) ---
let fetchInFlight = null; // dedupe concurrent full fetches
async function fetchPositions(forceRefresh = false) {
  const fresh = cache.data && (Date.now() - cache.timestamp < CACHE_TTL);
  if (!forceRefresh && fresh) return cache.data;
  // Stale-while-revalidate: if we have ANY old data and this isn't a manual
  // force refresh, return the stale data immediately and refresh in background.
  if (!forceRefresh && cache.data) {
    if (!fetchInFlight) {
      fetchInFlight = _fetchPositionsInner(false)
        .catch(e => console.error('background refresh failed:', e.message))
        .finally(() => { fetchInFlight = null; });
    }
    return cache.data; // serve stale instantly
  }
  if (fetchInFlight) {
    // 2026-09-28 审计修复: 撞上后台轮 (定时/预热/kick 的 promise 解析值不是载荷) 时等它跑完再返回完整缓存, 以前把 undefined 当载荷回 200 空 body
    await fetchInFlight.then(() => {}, () => {});
    if (cache.data) return cache.data;
    throw new Error('本轮拉取未产出数据');
  }
  fetchInFlight = _fetchPositionsInner(forceRefresh).finally(() => { fetchInFlight = null; });
  return fetchInFlight;
}

// 2026-09-28 审计修复: 沿用上轮缓存的仓位已经过 normalizePosition (稳定币换到 token1 侧), 回灌本轮流程前换回池内顺序
// (建仓 am 按 token0/token1 地址落位, 顺序反了会张冠李戴); 总是返回浅拷贝, 不就地改缓存对象
function denormalizePosition(pos) {
  if (!pos._normalized) return { ...pos };
  const { _normalized, ...rest } = pos;
  return {
    ...rest,
    token0: pos.token1, token1: pos.token0,
    token0addr: pos.token1addr, token1addr: pos.token0addr,
    token0USD: pos.token1USD, token1USD: pos.token0USD,
    amount0: pos.amount1, amount1: pos.amount0,
    feesOwed0: pos.feesOwed1, feesOwed1: pos.feesOwed0,
    currentPrice: pos.currentPrice > 0 ? 1 / pos.currentPrice : 0,
    lowerPrice: pos.upperPrice > 0 ? 1 / pos.upperPrice : 0,
    upperPrice: pos.lowerPrice > 0 ? 1 / pos.lowerPrice : 0,
  };
}

async function _fetchPositionsInner(forceRefresh = false) {
  // 强制刷新: 清派生缓存 (v4 子图 id 表), 让领费缓存过期但保留增量游标
  if (forceRefresh) {
    for (const k of Object.keys(v4IdCache)) delete v4IdCache[k];
    // 2026-09-28 审计修复: 不再清空 v3CollectCache (scannedTo 增量游标一清就全量回扫 30 天); 只把 ts 置 0 让本轮重查, 仍只扫游标之后的新块
    for (const k of Object.keys(v3CollectCache)) if (v3CollectCache[k]) v3CollectCache[k].ts = 0;
    for (const k of Object.keys(v4CollectCache)) if (v4CollectCache[k]) v4CollectCache[k].ts = 0;
    // v3CreatedChainCache 不清：创建时间不可变，清了只会导致重复链上扫描拖慢刷新
    console.log('Force refresh: cleared v4Id cache, expired collect caches (cursors kept)');
  }
  // 2026-09-28 审计修复: 记下上轮各钱包仓位, 本轮某钱包抓取失败时沿用 (并记入 failedWallets), 不再让它凭空消失
  const prevByAddr = {};
  for (const w of (cache.data?.wallets || [])) prevByAddr[(w.address || '').toLowerCase()] = w;
  const failedWallets = new Set();

  const v3pm = new ethers.Contract(V3_POSITION_MANAGER, V3_POSITION_MANAGER_ABI, provider);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);
  const v4pm = new ethers.Contract(V4_POSITION_MANAGER, V4_POSITION_MANAGER_ABI, provider);
  const stateView = new ethers.Contract(V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

  const ACTIVE = activeWallets();
  console.log(`Fetching V3+V4 positions for ${ACTIVE.length} wallets (concurrency: ${MAX_CONCURRENT})...`);

  // Fetch all wallets: V3 + V4 combined
  let walletResults = await asyncPool(MAX_CONCURRENT, ACTIVE, async (wallet) => {
    // 2026-09-28 审计修复: 三路 (Uniswap V3 / V4 / Pancake) 各自 catch; 失败的那一路沿用上轮缓存里该钱包同来源的仓位, 钱包记入 failedWallets
    const addrL = wallet.address.toLowerCase();
    const prevPos = (prevByAddr[addrL]?.positions) || [];
    const failedSrc = [];
    const fallback = (label, pick) => (e) => {
      failedSrc.push(label);
      console.error(`  [${label}] ${wallet.name} failed:`, e.message?.slice(0, 100));
      return prevPos.filter(pick).map(denormalizePosition);
    };
    const [v3positions, v4positions, pcsPositions] = await Promise.all([
      fetchWalletPositions(wallet, v3pm, factory).catch(fallback('V3', p => p.protocol === 'V3' && p.dex !== 'pancake')),
      fetchWalletV4Positions(wallet, v4pm, stateView).catch(fallback('V4', p => p.protocol === 'V4')),
      // PancakeSwap V3 (含 MasterChefV3 质押仓); 单独 catch, Pancake 侧出错不影响 Uniswap 仓
      getPcs().fetchWalletPositions(wallet).catch(fallback('PCS', p => p.dex === 'pancake')),
    ]);
    const allPositions = [...v3positions, ...v4positions, ...pcsPositions];
    if (failedSrc.length) {
      failedWallets.add(addrL);
      console.log(`[bsc] ${wallet.name} 本轮失败 (${failedSrc.join('/')}), 沿用上轮 (${allPositions.length} 仓)`);
    }
    await sleep(500);
    return { address: wallet.address, name: wallet.name, positions: allPositions, totalUSD: 0, ...(failedSrc.length ? { _stale: true } : {}) };
  });
  // 本轮起跑后被停用/删除的钱包不发布 (WALLETS 是活的全局列表, 路由已同步改过)
  walletResults = walletResults.filter(wr => activeWallets().some(w => w.address.toLowerCase() === (wr.address || '').toLowerCase()));

  // For active V3 positions: fill in createdAt (chain fallback) + lastCollectAt
  // (Pancake 仓 protocol 也是 'V3' 但 dex='pancake', 走自己的事件历史, 这里必须排除, 否则会拿 Pancake tokenId 去扫 Uniswap NPM)
  const activeV3Positions = [];
  const activePcsPositions = [];
  for (const wr of walletResults) {
    for (const pos of wr.positions) {
      if (!pos.liquidityActive) continue;
      if (pos.dex === 'pancake') activePcsPositions.push(pos);
      else if (pos.protocol === 'V3') activeV3Positions.push(pos);
    }
  }
  if (activePcsPositions.length > 0) {
    try { await getPcs().enrichHistory(activePcsPositions); }
    catch (e) { console.error('[PCS] history enrich failed:', e.message?.slice(0, 120)); }
  }

  if (activeV3Positions.length > 0) {
    // 1. Fill createdAt for positions missing it
    const needCreatedAt = activeV3Positions.filter(p => !p.createdAt);
    if (needCreatedAt.length > 0) {
      console.log(`Fetching mint times for ${needCreatedAt.length} V3 positions missing createdAt...`);
      for (const pos of needCreatedAt) {
        pos.createdAt = await getV3MintTime(BigInt(pos.tokenId));
      }
    }

    // 2. Fetch Collect events
    const tokenIds = activeV3Positions.map(p => BigInt(p.tokenId));
    console.log(`Fetching Collect events for ${tokenIds.length} active V3 positions...`);
    const collectTimes = await getV3LastCollectTimes(tokenIds);
    for (const pos of activeV3Positions) {
      pos.lastCollectAt = collectTimes[pos.tokenId] || 0;
    }
    console.log(`Collect events: found ${Object.keys(collectTimes).length} positions with collects`);
  }

  // For active V4 positions: fill in lastCollectAt via PoolManager ModifyLiquidity events
  const activeV4Positions = [];
  for (const wr of walletResults) {
    for (const pos of wr.positions) {
      if (pos.protocol === 'V4' && pos.liquidityActive) {
        activeV4Positions.push(pos);
      }
    }
  }

  if (activeV4Positions.length > 0) {
    console.log(`Fetching Collect events for ${activeV4Positions.length} active V4 positions...`);
    const v4Inputs = activeV4Positions.map(p => ({
      tokenId: p.tokenId,
      poolId: p.poolAddress,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
    }));
    const v4CollectTimes = await getV4LastCollectTimes(v4Inputs);
    for (const pos of activeV4Positions) {
      pos.lastCollectAt = v4CollectTimes[pos.tokenId] || 0;
    }
    console.log(`V4 Collect events: found ${Object.keys(v4CollectTimes).length} positions with collects`);
  }

  // Collect all token addresses and all positions for USD pricing
  const allTokenAddresses = new Set();
  const allPositions = [];

  for (const wr of walletResults) {
    for (const pos of wr.positions) {
      allTokenAddresses.add(pos.token0addr.toLowerCase());
      allTokenAddresses.add(pos.token1addr.toLowerCase());
      allPositions.push(pos);
    }
  }

  // Get USD prices (once for all tokens); 闲置余额候选一并送定价 (coingecko 可覆盖 WBNB 等); CAKE 为质押仓奖励计价
  const CAKE_ADDR = require('./pancake-bsc').CAKE.toLowerCase();
  const idleCandBsc = [...new Set([...allTokenAddresses, ...STABLECOINS, WBNB.toLowerCase(), CAKE_ADDR])];
  const priceMeta = {};   // 2026-09-28 审计修复: 缺价 token 集合 (stale=沿用上轮价, missing=无价), 用于仓位/闲置条目打标与 stats.priceMiss
  const usdPrices = await getUSDPrices(idleCandBsc, allPositions, priceMeta);
  lastUsdPricesBsc = usdPrices;
  const cakePrice = usdPrices[CAKE_ADDR] || 0;

  // Calculate USD values
  let grandTotalUSD = 0;
  let totalActive = 0;
  let totalInRange = 0;
  let totalOutOfRange = 0;
  let totalFees = 0;
  let walletsWithActiveLP = 0;

  for (const wr of walletResults) {
    let walletTotal = 0;
    let hasActive = false;

    for (const pos of wr.positions) {
      const t0l = pos.token0.address.toLowerCase(), t1l = pos.token1.address.toLowerCase();
      const price0 = usdPrices[t0l] || 0;
      const price1 = usdPrices[t1l] || 0;
      // 2026-09-28 审计修复: 本轮缺价 (沿用上轮价或无价) 的仓位打 priceStale, 前端提示; 每轮重算, 不残留上轮标记
      if (priceMeta.stale.has(t0l) || priceMeta.stale.has(t1l) || priceMeta.missing.has(t0l) || priceMeta.missing.has(t1l)) pos.priceStale = true;
      else delete pos.priceStale;

      pos.token0USD = price0;
      pos.token1USD = price1;
      pos.positionValueUSD = pos.amount0 * price0 + pos.amount1 * price1;
      pos.feesValueUSD = pos.feesOwed0 * price0 + pos.feesOwed1 * price1;
      // Pancake 质押仓待领 CAKE: 计入总价值 (可随时领取的真钱), 不计入手续费口径
      pos.rewardValueUSD = pos.pendingCake > 0 ? pos.pendingCake * cakePrice : 0;
      pos.totalValueUSD = pos.positionValueUSD + pos.feesValueUSD + pos.rewardValueUSD;

      // 建仓价值: 只读缓存, 缺失交给后台异步队列补 (子图 amountUSD 聚合); Pancake 无子图, 不做 (宁缺毋滥)
      if (pos.dex !== 'pancake') {
        const kind = pos.protocol === 'V4' ? 'v4' : 'v3';
        const t0a = pos.token0.address, t1a = pos.token1.address;
        const createdAt = pos.createdAt > 0 ? pos.createdAt : 0;   // 2026-09-28 审计修复: 带上 mint 时间, 建仓查询用 timestamp_gte 过滤同区间旧仓
        const job = kind === 'v3'
          ? { kind, tokenId: pos.tokenId, poolAddress: pos.poolAddress, tickLower: pos.tickLower, tickUpper: pos.tickUpper, owner: pos.walletAddress, liq: pos.liquidity, t0: t0a, t1: t1a, createdAt }
          : { kind, tokenId: pos.tokenId, poolId: pos.poolAddress, tickLower: pos.tickLower, tickUpper: pos.tickUpper, owner: pos.walletAddress, liq: pos.liquidity, t0: t0a, t1: t1a, createdAt };
        const ed = bscEntryPeek(kind, pos.tokenId, pos.liquidity, job);
        if (ed) {
          pos.entryValueUSD = ed.u;
          pos.entryWithdrawnUSD = ed.w;
          pos.entryTs = ed.ts;
          pos.entryAdds = ed.n;
          pos.entryModified = ed.mod;
          pos.entryAm = ed.am || null;
        }
      }
      // 盈亏字段: Ankr 账本命中 → 真实成本/已提回/已领费; 否则成本 = 建仓时点价值 (approx), 已领费 V3 子图/Pancake 事件有, V4 无 (feesUnknown)
      {
        const kind = pos.dex === 'pancake' ? 'pcs' : (pos.protocol === 'V4' ? 'v4' : 'v3');
        // 2026-09-28 审计修复: pancake-bsc 用 feesUnknown:true 表示「待领费读取失败」, 但 applyPnl 会把 feesUnknown 重置成账本口径 (false);
        //   先转存到前端认的专用字段 pendingFeesFailed (index.html feesBad), 账本命中时待领费仍显示「—」而不是 $0
        if (pos.dex === 'pancake') { if (pos.feesUnknown === true) pos.pendingFeesFailed = true; else delete pos.pendingFeesFailed; }
        const lg = pnlLedger.positionPnl('bsc', wr.address, kind, pos.tokenId);
        const priceOf = a => usdPrices[a] || 0;
        if (lg) pnlLedger.applyPnl(pos, { cost: lg.cost, approx: lg.approx || lg.inc, source: 'ledger', am: lg.a, costBy: lg.cb, withdrawnUSD: lg.ret, collectedUSD: lg.fees }, priceOf);
        else if (pos.entryValueUSD > 0) pnlLedger.applyPnl(pos, { cost: pos.entryValueUSD, approx: true, source: 'entry', am: pos.entryAm || {}, withdrawnUSD: pos.entryWithdrawnUSD || 0, collectedUSD: pos.protocol === 'V4' ? 0 : undefined, feesUnknown: pos.protocol === 'V4' }, priceOf);
      }

      // === Two daily rate metrics ===
      // 1. Cumulative daily rate: from creation, total fees (collected + pending) / principal / total days
      if (pos.createdAt > 0 && pos.positionValueUSD >= 10) {
        const totalMs = Date.now() - pos.createdAt;
        const totalDays = totalMs / (24 * 60 * 60 * 1000);
        const totalHours = totalMs / (60 * 60 * 1000);
        if (totalDays > 0) {
          // Total fees = already collected (from subgraph) + pending (unclaimed)
          const cf = pos.collectedFees || { token0: 0, token1: 0 };
          // 2026-09-28 审计修复: 账本 applyPnl 注入的已领费美元 (collectedFeesUSD, 领取时点价) 优先; 没有才按 token 数 × 现价折算
          const collectedUSD = (typeof pos.collectedFeesUSD === 'number' && pos.collectedFeesUSD >= 0) ? pos.collectedFeesUSD : (cf.token0 * price0 + cf.token1 * price1);
          const totalFeesUSD = collectedUSD + pos.feesValueUSD;
          if (totalFeesUSD > 0) {
            pos.dailyRateCumulative = (totalFeesUSD / pos.positionValueUSD) / totalDays * 100;
          }
          pos.totalDays = totalDays >= 1 ? Math.floor(totalDays) : 0;
          pos.totalHours = Math.floor(totalHours);
          pos.totalMinutes = Math.floor((totalMs % (60 * 60 * 1000)) / (60 * 1000));
        }
      }

      // 2. Current daily rate: from last collect (or creation if never collected), pending fees only
      const currentStart = pos.lastCollectAt || pos.createdAt;
      // 2026-09-28 审计修复: 日化计时起点 (最后领费, 没有则建仓) 距今 < 1 小时 → rateUnstable (照算不清零, 前端打标);
      //   与 evm-adapter 同口径放在分支外, 两态都显式写 (沿用上轮的仓位对象不残留旧标记)
      if (currentStart > 0 && Date.now() - currentStart < 60 * 60 * 1000) pos.rateUnstable = true; else delete pos.rateUnstable;
      if (currentStart > 0 && pos.positionValueUSD >= 10 && pos.feesValueUSD > 0) {
        const holdMs = Date.now() - currentStart;
        const holdDays = holdMs / (24 * 60 * 60 * 1000);
        const holdHours = holdMs / (60 * 60 * 1000);
        if (holdDays > 0) {
          pos.dailyRateCurrent = (pos.feesValueUSD / pos.positionValueUSD) / holdDays * 100;
          pos.holdDays = holdDays >= 1 ? Math.floor(holdDays) : 0;
          pos.holdHours = Math.floor(holdHours);
          pos.holdMinutes = Math.floor((holdMs % (60 * 60 * 1000)) / (60 * 1000));
          pos.hasCollected = !!pos.lastCollectAt;
        }
      }

      walletTotal += pos.totalValueUSD;
      totalFees += pos.feesValueUSD;

      if (pos.liquidityActive) {
        totalActive++;
        hasActive = true;
        if (pos.inRange) totalInRange++;
        else totalOutOfRange++;
      }
    }

    wr.totalUSD = walletTotal;
    grandTotalUSD += walletTotal;
    if (hasActive) walletsWithActiveLP++;

    // Normalize price direction (Token/USDT) and sort
    wr.positions = wr.positions.map(normalizePosition);
    wr.positions.sort((a, b) => {
      if (a.liquidityActive && !b.liquidityActive) return -1;
      if (!a.liquidityActive && b.liquidityActive) return 1;
      return b.totalValueUSD - a.totalValueUSD;
    });
  }

  // Only include wallets that have positions (balanceOf > 0)
  const wallets = walletResults.filter(wr => wr.positions.length > 0);

  // Sort wallets by name (马年1号, 马年2号, ...)
  wallets.sort((a, b) => {
    const numA = parseInt((a.name.match(/\d+/) || ['0'])[0]);
    const numB = parseInt((b.name.match(/\d+/) || ['0'])[0]);
    return numA - numB;
  });

  // 钱包闲置余额: fund-config 总开关关掉就不查; 失败沿用上轮快照, 不拖累主数据
  const fundCfg = loadFundCfg();
  // 2026-09-28 审计修复: 删掉未使用的 fundSel。勾选 (fundCfg.wallets.bsc, 未设置=只算自有) 由前端 idleFiltered 套在统计条上, 与 evm/sol 同口径;
  //   后端余额对全部启用钱包查 (evm-adapter/sol-adapter 同样如此, 观察钱包的资金快照要用), 不能在这里按勾选裁掉
  const fundWallets = !fundCfg.enabled ? [] : activeWallets();   // 2026-09-28: 全部启用钱包都查余额 (观察钱包快照要用); 统计条只算自有由前端过滤
  let idle = null;
  if (fundWallets.length) {
    // 2026-09-28 审计修复: 兜底快照按本轮查询的钱包集合过滤 (与 evm filterIdleByWallets / sol allow 同口径), 已停用/删除的钱包不借上轮快照回来
    const prevIdle = lastIdleBsc || cache.data?.idle || null;
    if (prevIdle && prevIdle.byWallet) {
      const allow = new Set(fundWallets.map(w => w.address.toLowerCase()));
      const byWallet = {}; let t = 0;
      for (const [a, w] of Object.entries(prevIdle.byWallet)) if (allow.has(a.toLowerCase())) { byWallet[a] = w; t += w.totalUSD || 0; }
      idle = { totalUSD: t, byWallet };
    }
    try {
      idle = await fetchIdleBsc(fundWallets, idleCandBsc, usdPrices, priceMeta);
      lastIdleBsc = idle;
    } catch (e) { console.error('[BSC] idle balances failed:', e.message?.slice(0, 100)); }
  }

  const result = {
    wallets,
    grandTotalUSD,
    idle,
    timestamp: Date.now(),
    failedWallets: [...failedWallets],   // 2026-09-28 审计修复: 本轮抓取失败、沿用上轮 (或无数据) 的钱包 (小写地址); 对应钱包对象带 _stale
    stats: {
      totalActive,
      totalInRange,
      totalOutOfRange,
      totalFees,
      walletsWithActiveLP,
      totalWallets: activeWallets().length,
      priceMiss: priceMeta.priceMiss || 0,   // 2026-09-28 审计修复: 缺价 token 数
    },
  };

  cache = { data: result, timestamp: Date.now() };
  savePosCache();
  console.log(`Fetch complete. ${wallets.length} wallets with positions, ${totalActive} active positions, grand total: $${grandTotalUSD.toFixed(2)}`);
  return result;
}

// --- Normalize price direction: always Token/USDT ---
function normalizePosition(pos) {
  const t0addr = (pos.token0addr || pos.token0.address || '').toLowerCase();
  // If token0 is a stablecoin, swap sides so display is Token/USDT
  if (STABLECOINS.has(t0addr)) {
    return {
      ...pos,
      token0: pos.token1,
      token1: pos.token0,
      token0addr: pos.token1addr,
      token1addr: pos.token0addr,
      token0USD: pos.token1USD,
      token1USD: pos.token0USD,
      amount0: pos.amount1,
      amount1: pos.amount0,
      feesOwed0: pos.feesOwed1,
      feesOwed1: pos.feesOwed0,
      currentPrice: pos.currentPrice > 0 ? 1 / pos.currentPrice : 0,
      lowerPrice: pos.upperPrice > 0 ? 1 / pos.upperPrice : 0,  // swap & invert
      upperPrice: pos.lowerPrice > 0 ? 1 / pos.lowerPrice : 0,  // swap & invert
      _normalized: true,
    };
  }
  return pos;
}

// --- Routes ---
app.use(express.static(path.join(__dirname, 'public')));

// 2026-09-28 审计修复: /api/health 里的 RPC 地址统一脱敏 (lastRound.rpc 与 rpcs[].url 共用):
//   URL 里的 user:pass@、path 的 /v<n>/<key> (NodeReal /v1、Alchemy /v2)、?apikey=/key=/token=/auth= 参数值、任意位置 32 位以上的 hex 串 (Ankr 等 path/子域里的 key)
function redactRpcUrl(u) {
  if (typeof u !== 'string') return u;
  return u
    .replace(/\/\/[^/?#@\s]+@/g, '//…@')
    .replace(/(\/v\d+\/)[A-Za-z0-9_-]{16,}/g, '$1…')
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|auth)=)[^&#]*/gi, '$1…')
    .replace(/[0-9a-fA-F]{32,}/g, '…');
}
app.get('/api/health', (req, res) => {
  res.json({
    keys: GRAPH_KEYS.map((k, i) => ({
      index: i,
      ok: k.ok,
      fail: k.fail,
      blocked: k.blockedUntil > Date.now(),
      blockedUntilISO: k.blockedUntil > Date.now() ? new Date(k.blockedUntil).toISOString() : null,
    })),
    cache: {
      mainCacheFresh: cache.data ? (Date.now() - cache.timestamp < CACHE_TTL) : false,
      mainCacheAge: cache.timestamp ? Math.round((Date.now() - cache.timestamp) / 1000) + 's' : null,
      v4IdCacheEntries: Object.keys(v4IdCache).length,
    },
    // PancakeSwap 事件扫描状态: 上一轮调用数/耗时/是否触顶预算 + 各日志 RPC 成败计数
    pancake: pcsBsc ? (() => { const s = pcsBsc.stats(); return { lastRound: s.lastRound ? { ...s.lastRound, rpc: redactRpcUrl(s.lastRound.rpc) } : null, rpcs: s.rpcs.map(r => ({ url: redactRpcUrl(r.url), chunk: r.chunk, ok: r.ok, fail: r.fail, cooling: r.failUntil > Date.now() })) }; })() : null,   // 2026-09-28 审计修复: lastRound.rpc 以前明文带 key
  });
});

// --- Chains API (for sidebar) ---
app.get('/api/chains', (req, res) => {
  res.json(CHAINS);
});

// 从已定价的钱包结果重算合计与统计 (剔除钱包后零 RPC 更新, 口径与主循环一致: 费含非活跃仓)
function summarizeWallets(walletResults) {
  let grandTotalUSD = 0, totalActive = 0, totalInRange = 0, totalOutOfRange = 0, totalFees = 0, walletsWithActiveLP = 0;
  for (const wr of walletResults) {
    let hasActive = false;
    for (const pos of wr.positions || []) {
      totalFees += pos.feesValueUSD || 0;
      if (pos.liquidityActive) { totalActive++; hasActive = true; if (pos.inRange) totalInRange++; else totalOutOfRange++; }
    }
    grandTotalUSD += wr.totalUSD || 0;
    if (hasActive) walletsWithActiveLP++;
  }
  return { grandTotalUSD, totalActive, totalInRange, totalOutOfRange, totalFees, walletsWithActiveLP };
}
// 停用钱包: 就地剔出缓存 (合计/统计/闲置余额一起重算), 零 RPC 立即生效
function dropBscWalletFromCache(addr) {
  addr = String(addr).toLowerCase();
  const fixIdle = (idle) => {
    if (!idle || !idle.byWallet) return;
    // 2026-09-28 审计修复: byWallet 的键是钱包表里的原样地址 (可能大小写混合), 按小写比对
    const k = Object.keys(idle.byWallet).find(a => a.toLowerCase() === addr);
    if (!k) return;
    delete idle.byWallet[k];
    idle.totalUSD = Object.values(idle.byWallet).reduce((s, w) => s + (w.totalUSD || 0), 0);
  };
  if (cache.data) {
    const d = cache.data;
    d.wallets = (d.wallets || []).filter(w => (w.address || '').toLowerCase() !== addr);
    if (Array.isArray(d.failedWallets)) d.failedWallets = d.failedWallets.filter(a => a !== addr);
    const sm = summarizeWallets(d.wallets);
    d.grandTotalUSD = sm.grandTotalUSD;
    d.stats = { ...(d.stats || {}), ...sm, totalWallets: activeWallets().length };
    fixIdle(d.idle);
    savePosCache();
  }
  fixIdle(lastIdleBsc);
}
// 重新启用钱包: 后台补一轮把它带回来, 不清老数据 (与 EVM 适配器 kickRefresh 同语义)
let bscKickPending = false;
function kickBscRefresh() {
  if (fetchInFlight) {
    // 2026-09-28 审计修复: 撞上进行中的一轮 (它用的是起跑时的钱包表) → 跑完再补一轮, 新增/换址的钱包不用干等下个 5 分钟
    if (!bscKickPending) { bscKickPending = true; const f = () => { bscKickPending = false; kickBscRefresh(); }; fetchInFlight.then(f, f); }
    return;
  }
  fetchInFlight = _fetchPositionsInner(false)
    .then(r => r)
    .catch(e => console.error('[BSC] kick refresh failed:', e.message))
    .finally(() => { fetchInFlight = null; });
}

// --- Wallet management API ---
app.get('/api/wallets', (req, res) => {
  res.json(WALLETS);
});

app.post('/api/wallets', adminGuard, (req, res) => {
  const { address, name } = req.body || {};
  if (!address || !name) return res.status(400).json({ error: '需要 address 和 name' });
  // 2026-09-28 审计修复: 入参走 cleanWalletAddr / cleanWalletName (只收字符串/数字再 trim; 非字符串以前 .trim() 抛 500); name 1~64 个字符, 非法一律 400
  const addr = cleanWalletAddr(address);
  const nm = cleanWalletName(name);
  if (!addr) return res.status(400).json({ error: '无效的 BSC 地址' });
  if (!nm) return res.status(400).json({ error: `名称须为 1~${WALLET_NAME_MAX} 个字符` });
  if (WALLETS.some(w => w.address.toLowerCase() === addr)) return res.status(409).json({ error: '地址已存在' });
  if (WALLETS.length >= 30) return res.status(400).json({ error: '最多支持 30 个地址' });
  WALLETS.push({ address: addr, name: nm });
  saveWallets(WALLETS);
  // 2026-09-28 审计修复: 不再 cache.data=null 整链空窗; 后台补一轮把新钱包带进来, 老数据照常可看
  kickBscRefresh();
  console.log(`Wallet added: ${nm} (${addr})`);
  res.json({ ok: true, wallets: WALLETS });
});

app.delete('/api/wallets/:address', adminGuard, (req, res) => {
  const addr = req.params.address.toLowerCase();
  const idx = WALLETS.findIndex(w => w.address.toLowerCase() === addr);
  if (idx === -1) return res.status(404).json({ error: '地址不存在' });
  const removed = WALLETS.splice(idx, 1)[0];
  saveWallets(WALLETS);
  dropBscWalletFromCache(addr);   // 2026-09-28 审计修复: 就地剔出缓存 (含 savePosCache), 不再整链空窗
  console.log(`Wallet removed: ${removed.name} (${addr})`);
  res.json({ ok: true, wallets: WALLETS });
});

// 编辑钱包: 改名和/或换地址。换地址等同删旧+加新: 就地剔旧地址 + 后台补一轮带新地址 (2026-09-28 审计修复: 注释改正, 不再清空整链缓存)
app.patch('/api/wallets/:address', adminGuard, (req, res) => {
  const cur = req.params.address.toLowerCase();
  const idx = WALLETS.findIndex(w => w.address.toLowerCase() === cur);
  if (idx === -1) return res.status(404).json({ error: '地址不存在' });
  const { name, address, enabled, own, ledger } = req.body || {};
  let newName, newAddr, newEnabled;
  let newOwn;
  let newLedger;
  if (ledger !== undefined) { if (typeof ledger !== 'boolean') return res.status(400).json({ error: 'ledger 须为布尔值' }); newLedger = ledger; }   // 观察钱包手动开账本 (自有钱包默认开, 此标记无意义)
  if (own !== undefined) { if (typeof own !== 'boolean') return res.status(400).json({ error: 'own 须为布尔值' }); newOwn = own; }   // 自有(true)/观察(false): 资金查询·快照·盈亏·通知默认只看自有
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 须为布尔值' });
    newEnabled = enabled;
  }
  if (name !== undefined) {
    newName = cleanWalletName(name);   // 2026-09-28 审计修复: 与 POST 同一校验 (null/对象/超长 → 400, 以前 null 会存成名字 "null")
    if (newName === null) return res.status(400).json({ error: `名称须为 1~${WALLET_NAME_MAX} 个字符` });
  }
  if (address !== undefined) {
    newAddr = cleanWalletAddr(address);   // 2026-09-28 审计修复: 同上, 非字符串不再抛 500
    if (newAddr === null) return res.status(400).json({ error: '无效的 BSC 地址' });
    if (newAddr !== cur && WALLETS.some((w, i) => i !== idx && w.address.toLowerCase() === newAddr)) return res.status(409).json({ error: '地址已存在' });
  }
  if (newName === undefined && newAddr === undefined && newEnabled === undefined && newOwn === undefined && newLedger === undefined) return res.status(400).json({ error: '需要 name / address / enabled / own / ledger' });
  const old = { ...WALLETS[idx] };
  const addrChanged = newAddr !== undefined && newAddr !== cur;
  const enabledChanged = newEnabled !== undefined && newEnabled !== isWalletOn(old);
  if (newName !== undefined) WALLETS[idx].name = newName;
  if (newAddr !== undefined) WALLETS[idx].address = newAddr;
  if (newEnabled !== undefined) { if (newEnabled) delete WALLETS[idx].enabled; else WALLETS[idx].enabled = false; }
  if (newOwn !== undefined) { if (newOwn) WALLETS[idx].own = true; else delete WALLETS[idx].own; }
  if (newLedger !== undefined) { if (newLedger) WALLETS[idx].ledger = true; else delete WALLETS[idx].ledger; }
  if (newLedger === true && bscKickLedger) setImmediate(bscKickLedger);
  saveWallets(WALLETS);
  if (addrChanged) {
    // 2026-09-28 审计修复: 换地址 = 剔旧 + 后台补一轮带新地址进来, 不再 cache.data=null 整链空窗
    dropBscWalletFromCache(cur);
    kickBscRefresh();
  } else if (enabledChanged) {
    if (newEnabled) kickBscRefresh();       // 重新启用: 后台补一轮带回来
    else dropBscWalletFromCache(cur);       // 停用: 就地剔出缓存, 零 RPC
  } else if (cache.data) {
    // 只改名: 缓存里就地改显示名, 不触发重拉
    for (const w of cache.data.wallets) if ((w.address || '').toLowerCase() === cur) w.name = WALLETS[idx].name;
    savePosCache();
  }
  console.log(`Wallet updated: ${old.name} (${old.address}) -> ${WALLETS[idx].name} (${WALLETS[idx].address})${enabledChanged ? (newEnabled ? ' [启用]' : ' [停用]') : ''}`);
  res.json({ ok: true, wallets: WALLETS });
});

// 钱包盈亏合并视图 /api/pnl/all?scope=own|obs[&chain=<id>][&refresh=true]
//   own = 自有钱包 (∪ pnl-config 例外); obs = 观察钱包 (启用且未标自有); 各链各钱包走本地 /pnl 报告后合并, 行上带 chain / wallet; 60s 缓存
const CHAIN_PNL_API = { bsc: '/api/pnl', sol: '/api/sol/pnl', eth: '/api/eth/pnl', rh: '/api/rh/pnl', base: '/api/base/pnl', arc: '/api/arc/pnl' };
// 2026-09-28 审计修复: 链 id 用 Object.hasOwn 判白名单 (以前 'constructor' 之类的原型键也算命中), 非白名单返回 null
function walletsFileOf(chain) { if (!Object.hasOwn(CHAIN_PNL_API, chain)) return null; return chain === 'bsc' ? 'wallets.json' : `wallets-${chain}.json`; }
function chainWallets(chain) { const f = walletsFileOf(chain); if (!f) return []; try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')).filter(w => w.enabled !== false); } catch { return []; } }
function scopeWallets(chain, scope) {
  const all = chainWallets(chain);
  if (scope === 'obs') return all.filter(w => w.own !== true);
  const pc = loadPnlCfg();
  const norm = a => chain === 'sol' ? String(a) : String(a).toLowerCase();
  if (Array.isArray(pc.wallets[chain])) { const s = new Set(pc.wallets[chain].map(norm)); return all.filter(w => w.own === true || s.has(norm(w.address))); }
  return all.filter(w => w.own === true);
}
function fetchLocalJson(pathname, timeoutMs = 30000) {
  return fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) }).then(r => r.ok ? r.json() : null).catch(() => null);
}
const pnlAllCache = {};   // `${scope}:${chain}` -> { ts, data }
app.get('/api/pnl/all', async (req, res) => {
  const scope = req.query.scope === 'obs' ? 'obs' : 'own';
  const chainQ = String(req.query.chain || '');
  const chains = chainQ && Object.hasOwn(CHAIN_PNL_API, chainQ) ? [chainQ] : Object.keys(CHAIN_PNL_API);   // 2026-09-28 审计修复: hasOwn 白名单
  const refresh = req.query.refresh === 'true';
  const nocache = refresh || req.query.nocache === 'true';   // nocache: 只跳过合并缓存 (钱包开关账本后立刻看到新标记), 不踢扫描
  const key = `${scope}:${chains.join(',')}`;
  const c = pnlAllCache[key];
  if (!nocache && c && Date.now() - c.ts < 60000) return res.json(c.data);
  const out = { scope, chains: {}, wallets: [], positions: [], lpUSD: 0, idleUSD: 0, funding: null, ledgerScanning: false, dataTs: 0 };
  let fin = 0, anyFund = false;
  for (const ch of chains) {
    const ws = scopeWallets(ch, scope);
    if (!ws.length) continue;
    out.chains[ch] = { wallets: ws.length };
    for (const w of ws) {
      const rep = await fetchLocalJson(`${CHAIN_PNL_API[ch]}?wallet=${encodeURIComponent(w.address)}${refresh ? '&refresh=true' : ''}`);
      if (!rep) continue;
      const wk = `${ch}:${w.address}`;
      out.wallets.push({ chain: ch, address: w.address, name: w.name, own: w.own === true, ledger: w.ledger === true, ledgerOn: !!rep.ledger, ledgerStale: !!rep.ledgerStale, priceMiss: rep.priceMiss || 0, partial: !!rep.partial, pending: !!rep.pending, scanning: !!rep.scanning, updatedAt: rep.updatedAt || 0, lpUSD: rep.lpUSD || 0, idleUSD: rep.idleUSD, funding: rep.funding || null, n: (rep.positions || []).length });
      for (const r of (rep.positions || [])) out.positions.push({ ...r, chain: ch, wallet: w.name, walletAddress: w.address, wk });
      out.lpUSD += rep.lpUSD || 0;
      if (typeof rep.idleUSD === 'number') out.idleUSD += rep.idleUSD;
      if (rep.funding && !rep.funding.partial && typeof rep.funding.netUSD === 'number') { fin += rep.funding.netUSD; anyFund = true; }
      if (rep.scanning) out.ledgerScanning = true;
      if (rep.dataTs > out.dataTs) out.dataTs = rep.dataTs;
    }
  }
  if (anyFund) out.funding = { netUSD: fin };
  pnlAllCache[key] = { ts: Date.now(), data: out };
  res.json(out);
});

// 钱包盈亏 (BSC): 无链上账本, 只有活跃仓 (成本按建仓时点价值), 历史仓位不可用
app.get('/api/pnl', (req, res) => {
  const addr = String(req.query.wallet || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: '缺少或无效的 wallet' });
  const data = cache.data;
  const liveWallet = (data?.wallets || []).find(w => w.address.toLowerCase() === addr) || null;
  const wcfg = WALLETS.find(w => w.address.toLowerCase() === addr) || null;
  const selected = pnlSelectedAddrs('bsc', WALLETS.map(w => w.address)).has(addr);
  const rep = pnlLedger.walletReport('bsc', addr, liveWallet, selected);
  let idleUSD = null;
  for (const [a, wI] of Object.entries(data?.idle?.byWallet || {})) if (a.toLowerCase() === addr) idleUSD = wI.totalUSD || 0;
  res.json({ chain: 'bsc', wallet: { address: addr, name: wcfg?.name || liveWallet?.name || addr, enabled: wcfg ? wcfg.enabled !== false : true }, ...rep, idleUSD, lpUSD: liveWallet ? (liveWallet.totalUSD || 0) : 0, funding: null, dataTs: data?.timestamp || 0,
    selected, ledgerEnabled: loadPnlCfg().enabled });
});

app.get('/api/positions', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const data = await fetchPositions(forceRefresh);
    res.json(data);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: '刷新失败，请稍后重试' });   // 2026-09-28 审计修复: 固定文案, 完整错误只进日志 (以前把 RPC/URL 细节回给前端)
  }
});

// --- Solana (Meteora DLMM + Raydium CLMM + Orca Whirlpool) ---
let solKickRefresh = null, evmKickRefresh = null, evmKickLedger = null, bscKickLedger = null, solKickLedger = null;
try {
  const solMod = require('./sol-adapter');
  solMod.mountSolRoutes(app, adminGuard);
  solKickRefresh = solMod.kickSolRefresh || null;
  solKickLedger = solMod.kickSolLedger || null;
  console.log('SOL adapter mounted (/api/sol/*)');
} catch (e) {
  console.error('SOL adapter failed to mount:', e.message);
}

// --- EVM 多链 (Ethereum + Robinhood Chain), 每链独立钱包文件 wallets-<chain>.json ---
try {
  const evmMod = require('./evm-adapter');
  evmMod.mountEvmRoutes(app, adminGuard);
  evmKickRefresh = evmMod.kickRefresh || null;
  evmKickLedger = evmMod.kickLedger || null;
} catch (e) {
  console.error('EVM adapter failed to mount:', e.message);
}

// --- BSC 钱包盈亏账本: 数据源 Ankr (需 ANKR_KEY); Uniswap V3/V4 + Pancake V3 (kind=pcs) 一并入账 ---
try {
  const pcsMod = require('./pancake-bsc');
  pnlLedger.registerChain('bsc', {
    cfg: {
      name: 'BSC', ledgerFromAnkr: 'bsc',
      v3: { npm: V3_POSITION_MANAGER, pcsNpm: pcsMod.NPM },
      v4: { pm: V4_POSITION_MANAGER, stateView: V4_STATE_VIEW, poolManager: V4_POOL_MANAGER },
      stables: { [USDT_ADDRESS]: 'USDT', [USDC_ADDRESS]: 'USDC', [BUSD_ADDRESS]: 'BUSD' },
      wrappedNative: WBNB, nativePriceId: 'binancecoin',
    },
    chainState: () => ({ provider, lastUsdPrices: lastUsdPricesBsc }),
    getTokenInfo: (a) => getTokenInfo(a),
    wallets: () => { const sel = pnlSelectedAddrs('bsc', activeWallets().map(w => w.address)); return activeWallets().filter(w => sel.has(w.address.toLowerCase())); },
    // 2026-09-28 审计修复: 账本 priceSane 参考价钩子 ({ [addrLower]: usd }): 稳定币=1, 先用上轮定价, 缺的按合约地址批量问 coingecko (与主流程同源)
    getUSDPrices: async (addrsLower) => {
      const out = {}, need = [];
      const ZERO = '0x0000000000000000000000000000000000000000', wbnbL = WBNB.toLowerCase();
      for (const a of (addrsLower || []).map(x => String(x).toLowerCase())) {
        // 2026-09-28 审计修复: V4 原生池的 token0 是零地址 (= BNB), 映射到 WBNB 价; 非法/非地址键不问 coingecko (会整批 400)
        if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
        if (a === ZERO) { if (lastUsdPricesBsc[wbnbL] > 0) out[a] = lastUsdPricesBsc[wbnbL]; else need.push(wbnbL); continue; }
        if (STABLECOINS.has(a)) out[a] = 1;
        else if (lastUsdPricesBsc[a] > 0) out[a] = lastUsdPricesBsc[a];
        else need.push(a);
      }
      if (need.length) {
        try { const got = await coingeckoBscPrices([...new Set(need)]); Object.assign(out, got); if (got[wbnbL] > 0 && !(out[ZERO] > 0)) out[ZERO] = got[wbnbL]; }
        catch (e) { console.error('[bsc] getUSDPrices (ledger ref) coingecko failed:', e.message?.slice(0, 80)); }
      }
      return out;
    },
  });
  const liveByWalletBsc = () => { const m = {}; for (const w of (cache.data?.wallets || [])) m[w.address.toLowerCase()] = (w.positions || []).filter(p => p.liquidityActive); return m; };
  bscKickLedger = () => { if (!pnlLedger.enabled('bsc')) return; pnlLedger.runQueue('bsc', liveByWalletBsc()).catch(e => console.error('[bsc] pnl-ledger:', e.message)); };
  setTimeout(bscKickLedger, 170 * 1000);
  setInterval(bscKickLedger, pnlLedger.ROUND_MS);
  console.log(`BSC pnl-ledger registered (${pnlLedger.enabled('bsc') ? 'Ankr 数据源就绪' : '未配置 ANKR_KEY, 停用'})`);
} catch (e) {
  console.error('BSC pnl-ledger register failed:', e.message);
}

// --- Robinhood 股票代币 x 美股成交额: 2026-09-06 拆分为独立项目 /home/ubuntu/rh-stocktokens ---
// (独立进程 :5180 + rh-stocktokens.service; nginx 直接反代, 与本服务再无代码关系)

// --- LP 出区间 Telegram 通知 (哨兵 bot, /api/notify/*) ---
try {
  const { mountNotifier } = require('./notifier');
  mountNotifier(app, adminGuard);
} catch (e) {
  console.error('Notifier failed to mount:', e.message);
}

// --- 资金每日快照 (/api/snapshot/*): 每天到点把钱包余额+LP 价值按钱包落盘, 供「资金快照」页看增减 ---
try {
  const { mountSnapshot } = require('./snapshot');
  mountSnapshot(app, adminGuard);
} catch (e) {
  console.error('Snapshot failed to mount:', e.message);
}

// --- 钱包资金查询配置 (/api/fund/config): 启用开关 + 按链勾选钱包 ---
// wallets.<chain> 未设置 = 只算标了「自有」的钱包; [] = 全不参与; 数组 = 勾选子集 (evm-adapter.fundSelected / 前端 idleAllowedSet 同语义)
//   2026-09-28 审计修复: 注释改正 (原写「未设置 = 全部钱包」); 勾选只作用于统计条/资金扫描, 余额本身对全部启用钱包都查 (观察钱包快照要用)
const FUND_CFG_FILE = path.join(__dirname, 'fund-config.json');
function loadFundCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(FUND_CFG_FILE, 'utf8'));
    return { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} };
  } catch { return { enabled: true, wallets: {} }; }
}
app.get('/api/fund/config', (req, res) => res.json(loadFundCfg()));
app.post('/api/fund/config', adminGuard, (req, res) => {
  const body = req.body || {};
  const cur = loadFundCfg();
  const next = { enabled: body.enabled !== false, wallets: {} };
  const VALID_CHAINS = ['bsc', 'sol', 'eth', 'rh', 'base', 'arc'];
  const src = (body.wallets && typeof body.wallets === 'object') ? body.wallets : cur.wallets;
  for (const [ch, arr] of Object.entries(src)) {
    if (!VALID_CHAINS.includes(ch)) continue;
    if (Array.isArray(arr)) next.wallets[ch] = arr.slice(0, 60).map(a => String(a).slice(0, 64));
  }
  try {
    const tmp = FUND_CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, FUND_CFG_FILE);
  } catch (e) { console.error('[config] 写入失败:', e.message); return res.status(500).json({ error: '写入失败, 请查看服务日志' }); }   // 2026-09-28 审计修复: 不把含文件路径的错误文本回给前端
  // 踢一轮当前链后台刷新, 让改动尽快生效 (其余链下轮 5min 周期自然跟上)
  const ch = String(body._chain || '');
  try {
    if (['eth', 'rh', 'base', 'arc'].includes(ch) && evmKickRefresh) evmKickRefresh(ch);
    else if (ch === 'sol' && solKickRefresh) solKickRefresh();
  } catch {}
  console.log(`[fund] config saved: enabled=${next.enabled}, chains=${Object.keys(next.wallets).join(',') || '(all default)'}`);
  res.json(loadFundCfg());
});

// --- 钱包盈亏账本配置 (/api/pnl/config): 总开关 + 按链勾选钱包 ---
// wallets.<chain> 未设置 = 自有钱包 + 手动开了账本 (ledger) 的观察钱包; [] = 只剩开了账本的观察钱包; 数组 = 勾选子集 ∪ 开了账本的 (evm-adapter.pnlSelected 同语义)
//   2026-09-28 审计修复: 注释改正 (原写「未设置 = 沿用钱包资金查询的勾选」, 与下面 pnlSelectedAddrs 的实际逻辑不符)
const PNL_CFG_FILE = path.join(__dirname, 'pnl-config.json');
function loadPnlCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(PNL_CFG_FILE, 'utf8'));
    return { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} };
  } catch { return { enabled: true, wallets: {} }; }
}
function pnlSelectedAddrs(chain, walletAddrs) {
  const pc = loadPnlCfg();
  if (!pc.enabled) return new Set();
  const norm = a => chain === 'sol' ? String(a) : String(a).toLowerCase();
  const led = WALLETS.filter(w => w.ledger === true).map(w => norm(w.address));   // 观察钱包里手动开了账本的
  if (Array.isArray(pc.wallets[chain])) return new Set([...pc.wallets[chain].map(norm), ...led]);
  return new Set([...WALLETS.filter(w => w.own === true).map(w => norm(w.address)), ...led]);   // 未单独设置 = 自有 + 开账本的观察
}
app.get('/api/pnl/config', (req, res) => res.json(loadPnlCfg()));
app.post('/api/pnl/config', adminGuard, (req, res) => {
  const body = req.body || {};
  const cur = loadPnlCfg();
  const next = { enabled: body.enabled !== false, wallets: {} };
  const VALID_CHAINS = ['bsc', 'sol', 'eth', 'rh', 'base', 'arc'];
  const src = (body.wallets && typeof body.wallets === 'object') ? body.wallets : cur.wallets;
  for (const [ch, arr] of Object.entries(src)) {
    if (!VALID_CHAINS.includes(ch)) continue;
    if (Array.isArray(arr)) next.wallets[ch] = arr.slice(0, 60).map(a => String(a).slice(0, 64));
  }
  try {
    const tmp = PNL_CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, PNL_CFG_FILE);
  } catch (e) { console.error('[config] 写入失败:', e.message); return res.status(500).json({ error: '写入失败, 请查看服务日志' }); }   // 2026-09-28 审计修复: 不把含文件路径的错误文本回给前端
  const ch = String(body._chain || '');
  try { if (next.enabled && evmKickLedger && ['rh', 'arc', 'base', 'eth'].includes(ch)) evmKickLedger(ch); if (next.enabled && ch === 'bsc' && bscKickLedger) bscKickLedger(); if (next.enabled && ch === 'sol' && solKickLedger) solKickLedger(); } catch {}
  console.log(`[pnl] config saved: enabled=${next.enabled}, chains=${Object.keys(next.wallets).join(',') || '(沿用资金查询)'}`);
  res.json(loadPnlCfg());
});

// --- 界面配置 (/api/ui/config): 总览页「管理钱包」面板显隐开关 (纯前端偏好, 服务端持久化以便多端一致) ---
const UI_CFG_FILE = path.join(__dirname, 'ui-config.json');
function loadUiCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(UI_CFG_FILE, 'utf8'));
    return { walletMgr: c.walletMgr !== false };
  } catch { return { walletMgr: true }; }
}
app.get('/api/ui/config', (req, res) => res.json(loadUiCfg()));
app.post('/api/ui/config', adminGuard, (req, res) => {
  const body = req.body || {};
  const cur = loadUiCfg();
  const next = { walletMgr: body.walletMgr === undefined ? cur.walletMgr : body.walletMgr !== false };
  try {
    const tmp = UI_CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2)); fs.renameSync(tmp, UI_CFG_FILE);
  } catch (e) { console.error('[config] 写入失败:', e.message); return res.status(500).json({ error: '写入失败, 请查看服务日志' }); }   // 2026-09-28 审计修复: 不把含文件路径的错误文本回给前端
  console.log(`[ui] config saved: walletMgr=${next.walletMgr}`);
  res.json(loadUiCfg());
});

const LISTEN_HOST = process.env.HOST || '127.0.0.1';   // 2026-09-28 审计修复: 缺省只监听本机 (nginx 反代在前), 不再默认 0.0.0.0
app.listen(PORT, LISTEN_HOST, () => {
  console.log(`LP Dashboard running at http://${LISTEN_HOST}:${PORT}`);
});

// --- 服务端定时自动刷新（不依赖前端触发）---
// 每 CACHE_TTL (5 分钟) 后台跑一轮 BSC 数据拉取，页面随时来拿都是热缓存。  2026-09-28 审计修复: 注释改正 (原写 10 分钟)
setInterval(() => {
  if (fetchInFlight) { console.log('[auto] skip: fetch already in flight'); return; }
  console.log('[auto] server-side scheduled refresh starting...');
  fetchInFlight = _fetchPositionsInner(false)
    .then(r => { console.log('[auto] scheduled refresh done'); return r; })   // 2026-09-28 审计修复: 透传载荷, 手动刷新撞上时不再拿到 undefined
    .catch(e => console.error('[auto] scheduled refresh failed:', e.message))
    .finally(() => { fetchInFlight = null; });
}, CACHE_TTL);

// 启动预热: pm2 重启会把上面的定时器归零, 不预热的话要干等一个 CACHE_TTL 才跑第一轮,
// 叠加拉取耗时会造成 10 分钟以上数据空窗。启动 15s 后检查磁盘缓存年龄, 超过半个 TTL 立即补一轮。
setTimeout(() => {
  if (fetchInFlight) return;
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL / 2) { console.log('[auto] 预热跳过: 缓存还新鲜'); return; }
  console.log('[auto] 启动预热刷新 (缓存已陈旧)...');
  fetchInFlight = _fetchPositionsInner(false)
    .then(r => { console.log('[auto] 预热刷新完成'); return r; })   // 2026-09-28 审计修复: 透传载荷
    .catch(e => console.error('[auto] 预热刷新失败:', e.message))
    .finally(() => { fetchInFlight = null; });
}, 15 * 1000);
