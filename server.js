require('dotenv').config();
const express = require('express');
const path = require('path');
const { ethers } = require('ethers');

const fs = require('fs');
const app = express();
app.use(express.json());

// 2026-09-09 登录页模式 (原 nginx Basic Auth 弹窗)。必须在业务路由之前挂载。
// 注意: 真正的鉴权闸门在 nginx (map $cookie_lpauth $lp_ok), 本模块只负责
// 校验用户名口令并下发 nginx 认识的 cookie —— 见 lp-auth.js 顶部说明。
const { mountLpAuth } = require("./lp-auth");
mountLpAuth(app);
const PORT = parseInt(process.env.PORT || '1788');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// --- Multi-chain registry (scaffold: BSC + SOL live, others coming) ---
const CHAINS = [
  { id: 'bsc',  name: 'BSC',  enabled: true },
  { id: 'sol',  name: 'Solana', enabled: true },
  { id: 'eth',  name: 'Ethereum', enabled: true },
  { id: 'rh',   name: 'Robinhood', enabled: true },
  { id: 'base', name: 'Base', enabled: false },
  // Arc (Circle 稳定币 L1, chainId 5042): 主网预计 2026-09-16 上线, 现为预接线状态。
  // pending 字段是前端"待主网"角标+占位页的唯一真源; 上线后改 enabled:true 并删掉 pending。
  { id: 'arc',  name: 'Arc', enabled: false, pending: '2026-09-16' },
];

// Optional admin guard for mutating endpoints (set ADMIN_TOKEN in .env to enable)
function adminGuard(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  if (req.headers['x-admin-token'] === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: '需要管理密码 (X-Admin-Token)' });
}

// --- Config (from .env) ---
const WALLETS_FILE = path.join(__dirname, 'wallets.json');
const ENV_WALLETS = JSON.parse(process.env.WALLETS || '[]');

// Dynamic wallet list: load from wallets.json, fallback to .env
function loadWallets() {
  try {
    if (fs.existsSync(WALLETS_FILE)) {
      return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load wallets.json:', e.message);
  }
  // Initialize from .env
  saveWallets(ENV_WALLETS);
  return [...ENV_WALLETS];
}

function saveWallets(wallets) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2), 'utf8');
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
function saveBscEntry() { try { fs.writeFileSync(bscEntryFile, JSON.stringify(bscEntryCache || {})); } catch {} }
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
  if (cached && cached.liq === job.liq.toString()) return cached;
  const pool = job.poolAddress.toLowerCase();
  const origin = (job.owner || '').toLowerCase();
  if (!origin) return null;
  const md = await graphQueryRetry(V3_SUBGRAPH_ID,
    `{ mints(first:500, where:{pool:"${pool}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}"}){ amountUSD timestamp } }`);
  if (!md) return null;
  const bd = await graphQueryRetry(V3_SUBGRAPH_ID,
    `{ burns(first:500, where:{pool:"${pool}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}"}){ amountUSD } }`);
  const mints = md.mints || [], burns = (bd && bd.burns) || [];
  if (mints.length === 0) return null;
  let u = 0, ts = 0;
  for (const m of mints) { u += Math.abs(+m.amountUSD); const t = +m.timestamp * 1000; if (!ts || t < ts) ts = t; }
  const w = burns.reduce((a, b) => a + Math.abs(+b.amountUSD), 0);
  const data = { u, w, ts, n: mints.length, liq: job.liq.toString(), b: 0, mod: false };
  cache[key] = data; saveBscEntry();
  return data;
}
async function getV4EntryBsc(job) {
  const cache = bscEntryStore();
  const key = `v4-${job.tokenId}`;
  const cached = cache[key];
  if (cached && cached.liq === job.liq.toString()) return cached;
  const pool = job.poolId.toLowerCase();
  const origin = (job.owner || '').toLowerCase();
  if (!origin) return null;
  const md = await graphQueryRetry(V4_SUBGRAPH_ID,
    `{ modifyLiquidities(first:500, where:{pool:"${pool}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}"}){ amount amountUSD timestamp } }`);
  if (!md) return null;
  const evs = md.modifyLiquidities || [];
  if (evs.length === 0) return null;
  let u = 0, w = 0, n = 0, ts = 0;
  for (const e of evs) {
    const a = Math.abs(+e.amountUSD);
    if (+e.amount >= 0) { u += a; n++; const t = +e.timestamp * 1000; if (!ts || t < ts) ts = t; }
    else { w += a; }
  }
  if (n === 0) return null;
  const data = { u, w, ts, n, liq: job.liq.toString(), b: 0, mod: false };
  cache[key] = data; saveBscEntry();
  return data;
}
function bscEntryPeek(kind, tokenId, currentLiq, job) {
  const cache = bscEntryStore();
  const key = `${kind}-${tokenId}`;
  const cached = cache[key];
  if (cached && cached.liq === currentLiq.toString()) return cached;
  if ((bscEntryCooldown.get(key) || 0) < Date.now() && !bscEntryJobs.has(key)) {
    bscEntryJobs.set(key, job);
    setImmediate(() => runBscEntryQueue().catch(() => {}));
  }
  return null;
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

// V4 subgraph position ID cache (per wallet, 6h TTL)
const v4IdCache = {};
const V4_ID_CACHE_TTL = 10 * 60 * 1000; // 10 min, match main cache

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
  try { fs.writeFileSync(V4_IDS_CACHE_FILE, JSON.stringify(v4ChainStore), 'utf8'); } catch {}
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
    for (const w of WALLETS) {
      const a = w.address.toLowerCase();
      try {
        const ids = await withRetry(() => nrGetNFTInventory(w.address, V4_POSITION_MANAGER), 3, 1000);
        const wStore = store.wallets[a] = store.wallets[a] || { ids: {} };
        const fresh = {};
        for (const tid of ids) fresh[tid] = wStore.ids[tid] || 0; // keep known mintBlock if any
        wStore.ids = fresh; // inventory is authoritative: adds new, drops transferred/burned
        console.log(`  ${w.name} V4: ${ids.length} NFTs (inventory)`);
      } catch (e) {
        console.log(`  ${w.name} V4 inventory failed: ${e.message?.slice(0, 60)}`);
      }
      await sleep(200);
    }
    saveV4Store();

    // Inventory API is authoritative — no per-token ownerOf verification needed
    const result = {};
    for (const w of WALLETS) {
      const a = w.address.toLowerCase();
      result[a] = Object.entries(store.wallets[a]?.ids || {}).map(([tid, mintBlock]) => ({ id: BigInt(tid), mintBlock }));
    }
    return result;
  })();
  try { return await v4ScanPromise; }
  finally { setTimeout(() => { v4ScanPromise = null; }, 60 * 1000); }
}

const blockTsCache = {};
async function blockTimestamp(blockNumber) {
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
const CACHE_TTL = 5 * 60 * 1000; // 5 min auto-refresh (2026-09-05 由 10min 调快)
const POS_CACHE_FILE = path.join(__dirname, 'positions-cache.json');
// Load persisted cache on startup so pm2 restarts don't blank the dashboard
try {
  const saved = JSON.parse(fs.readFileSync(POS_CACHE_FILE, 'utf8'));
  if (saved && saved.data) { cache = saved; console.log(`Loaded positions cache from disk (age ${Math.round((Date.now() - saved.timestamp) / 1000)}s)`); }
} catch { /* no cache yet */ }
function savePosCache() {
  try { fs.writeFileSync(POS_CACHE_FILE, JSON.stringify(cache), 'utf8'); } catch {}
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
const LOG_RPC = process.env.LOG_RPC || 'https://bsc-rpc.publicnode.com';
const logProvider = new ethers.JsonRpcProvider(LOG_RPC);

// --- Token info cache ---
const tokenInfoCache = {};

async function getTokenInfo(address) {
  const addr = address.toLowerCase();
  const cached = tokenInfoCache[addr];
  // Return cached if it's a real symbol (not a fallback address stub)
  if (cached && !cached._fallback) return cached;
  // If fallback is older than 10 min, retry
  if (cached && cached._fallback && (Date.now() - cached._ts < 10 * 60 * 1000)) return cached;
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  try {
    const [symbol, decimals] = await Promise.all([
      contract.symbol(),
      contract.decimals(),
    ]);
    tokenInfoCache[addr] = { symbol, decimals: Number(decimals), address };
    return tokenInfoCache[addr];
  } catch (e) {
    const fallback = { symbol: addr.slice(0, 6) + '...', decimals: 18, address, _fallback: true, _ts: Date.now() };
    tokenInfoCache[addr] = fallback;
    return fallback;
  }
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
const STABLECOINS = new Set([USDT_ADDRESS, BUSD_ADDRESS]);

async function getUSDPrices(tokenAddresses, positionsData) {
  const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
  const prices = {};

  for (const addr of unique) {
    if (STABLECOINS.has(addr)) prices[addr] = 1.0;
  }

  const needCoinGecko = unique.filter(a => !prices[a]);
  if (needCoinGecko.length > 0) {
    try {
      const addresses = needCoinGecko.join(',');
      const url = `https://api.coingecko.com/api/v3/simple/token_price/binance-smart-chain?contract_addresses=${addresses}&vs_currencies=usd`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        for (const [addr, info] of Object.entries(data)) {
          if (info.usd) prices[addr.toLowerCase()] = info.usd;
        }
      }
    } catch (e) {
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

  for (const addr of unique) {
    if (!prices[addr]) prices[addr] = 0;
  }

  return prices;
}

// --- 钱包闲置余额 (LP 之外): 候选=LP 涉及 token + USDT/BUSD + WBNB, native BNB 单列 ---
// (BSC 无法免索引器枚举全部 ERC20, 与 EVM 适配器同口径; <$1 灰尘过滤)
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
let lastIdleBsc = null;
async function fetchIdleBsc(walletsSel, tokens, usdPrices) {
  if (walletsSel.length === 0) return { totalUSD: 0, byWallet: {} };
  const bnbPrice = usdPrices[WBNB.toLowerCase()] || 0;
  const byWallet = {}; let totalUSD = 0;
  for (const w of walletsSel) {
    const items = [];
    const bnb = Number(await provider.getBalance(w.address)) / 1e18;
    const bnbVal = bnb * bnbPrice;
    if (bnbVal >= 1) items.push({ symbol: 'BNB', address: 'native', amount: bnb, priceUSD: bnbPrice, valueUSD: bnbVal, native: true });
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
        items.push({ symbol: meta?.symbol || a.slice(0, 6), address: a, amount, priceUSD: price, valueUSD: v });
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

// V4: query subgraph for position IDs (cached 6h, key-pool)
async function getV4PositionIds(walletAddress) {
  const cacheKey = walletAddress.toLowerCase();
  const cached = v4IdCache[cacheKey];
  if (cached && (Date.now() - cached.ts < V4_ID_CACHE_TTL)) {
    return cached.ids;
  }
  const query = `{ positions(first: 200, where: { owner: "${cacheKey}" }) { tokenId createdAtTimestamp } }`;
  const data = await graphQuery(V4_SUBGRAPH_ID, query);
  if (!data?.positions) {
    // Fallback: chain scan (no Graph key or subgraph down)
    try {
      const scanned = await scanV4Chain();
      const owned = scanned[cacheKey] || [];
      const ids = [];
      for (const o of owned) {
        ids.push({ id: o.id, createdAt: await blockTimestamp(o.mintBlock) });
      }
      v4IdCache[cacheKey] = { ids, ts: Date.now() };
      return ids;
    } catch (e) {
      console.error(`  V4 chain-scan fallback failed for ${cacheKey}:`, e.message?.slice(0, 100));
      return cached?.ids || [];
    }
  }
  const ids = data.positions.map(p => ({ id: BigInt(p.tokenId), createdAt: Number(p.createdAtTimestamp || 0) * 1000 }));
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
  const query = `{ positions(first: 200, where: { owner: "${addr}" }) { id transaction { timestamp } collectedFeesToken0 collectedFeesToken1 } }`;
  try {
    const data = await graphQuery(V3_SUBGRAPH_ID, query);
    if (!data?.positions || data.positions.length === 0) {
      const chainCreated = await getV3CreatedFromChain(walletAddress);
      return { created: chainCreated, collectedFees: {} };
    }
    const created = {};
    const collectedFees = {};
    for (const p of data.positions) {
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
  try { fs.writeFileSync(COLLECT_CACHE_FILE, JSON.stringify({ v3: v3CollectCache })); } catch {}
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
        if (data.result?.logs?.[0]) {
          const log = data.result.logs[0];
          const time = parseInt(log.timestamp, 16) * 1000;
          results[key] = time;
          v3CollectCache[key] = { collectAt: time, ts: now };
          console.log(`  Last collect for #${key}: ${new Date(time).toISOString()} (Ankr Advanced)`);
        } else {
          v3CollectCache[key] = { collectAt: 0, ts: now };
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

  // Strategy 2: Fallback to chunked getLogs scan (publicnode)
  try {
    const currentBlock = await logProvider.getBlockNumber();
    const blockStep = 40000; // nodereal supports 45k-range getLogs
    const lookbackBlocks = 864000; // ~30 days
    const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

    for (const tid of toQuery) {
      const key = tid.toString();
      try {
        const tokenIdHex = ethers.zeroPadValue(ethers.toBeHex(tid), 32);
        const prev = v3CollectCache[key];
        // 增量扫描: 已扫过的区块不再重扫 (全量回扫30天是一轮拉取拖到8分钟的元凶)
        const floor = Math.max(fromBlock, (prev?.scannedTo || 0) + 1);
        let foundBlockNumber = null;

        for (let end = currentBlock; end >= floor; end -= blockStep) {
          const start = Math.max(floor, end - blockStep + 1);
          try {
            const logs = await logProvider.getLogs({
              address: V3_POSITION_MANAGER,
              topics: [COLLECT_EVENT_TOPIC, tokenIdHex],
              fromBlock: start,
              toBlock: end,
            });
            if (logs.length > 0) {
              foundBlockNumber = logs[logs.length - 1].blockNumber;
              break;
            }
          } catch (e) {
            await sleep(500);
          }
          await sleep(50);
        }

        if (foundBlockNumber) {
          const block = await logProvider.getBlock(foundBlockNumber);
          if (block) {
            results[key] = block.timestamp * 1000;
            v3CollectCache[key] = { collectAt: block.timestamp * 1000, ts: now, scannedTo: currentBlock };
          }
        } else {
          // 新扫区间没事件: 保留旧 collectAt (已扫过的历史区间不会凭空长出新事件)
          const keep = prev?.collectAt || 0;
          if (keep) results[key] = keep;
          v3CollectCache[key] = { collectAt: keep, ts: now, scannedTo: currentBlock };
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
      const logs = data.result?.logs || [];


      for (const pos of poolPositions) {
        const key = pos.tokenId.toString();
        let found = false;

        for (const log of logs) {
          try {
            const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
              ['int24', 'int24', 'int256', 'bytes32'], log.data
            );
            const tickLower = Number(decoded[0]);
            const tickUpper = Number(decoded[1]);
            const liquidityDelta = decoded[2];

            // Match: same tick range AND liquidityDelta === 0 (pure collect)
            if (tickLower === pos.tickLower && tickUpper === pos.tickUpper && liquidityDelta === 0n) {
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
  try { fs.writeFileSync(V3_CREATED_CACHE_FILE, JSON.stringify(v3CreatedChainCache)); } catch {}
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
    const lookback = 864000; // ~30 days
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

  const tokenIds = await getV4PositionIds(walletAddress);
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
    balance = await positionManager.balanceOf(walletAddress);
  } catch (e) {
    console.error(`Failed to get V3 balance for ${walletName}:`, e.message);
    return [];
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
  if (fetchInFlight) return fetchInFlight; // join the in-progress fetch
  fetchInFlight = _fetchPositionsInner(forceRefresh).finally(() => { fetchInFlight = null; });
  return fetchInFlight;
}

async function _fetchPositionsInner(forceRefresh = false) {
  // Clear all caches on force refresh
  if (forceRefresh) {
    for (const k of Object.keys(v4IdCache)) delete v4IdCache[k];
    for (const k of Object.keys(v3CollectCache)) delete v3CollectCache[k];
    // v3CreatedChainCache 不清：创建时间不可变，清了只会导致重复链上扫描拖慢刷新
    console.log('Force refresh: cleared v4Id + collect caches');
  }

  const v3pm = new ethers.Contract(V3_POSITION_MANAGER, V3_POSITION_MANAGER_ABI, provider);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);
  const v4pm = new ethers.Contract(V4_POSITION_MANAGER, V4_POSITION_MANAGER_ABI, provider);
  const stateView = new ethers.Contract(V4_STATE_VIEW, V4_STATE_VIEW_ABI, provider);

  const ACTIVE = activeWallets();
  console.log(`Fetching V3+V4 positions for ${ACTIVE.length} wallets (concurrency: ${MAX_CONCURRENT})...`);

  // Fetch all wallets: V3 + V4 combined
  let walletResults = await asyncPool(MAX_CONCURRENT, ACTIVE, async (wallet) => {
    const [v3positions, v4positions] = await Promise.all([
      fetchWalletPositions(wallet, v3pm, factory),
      fetchWalletV4Positions(wallet, v4pm, stateView),
    ]);
    const allPositions = [...v3positions, ...v4positions];
    await sleep(500);
    return { address: wallet.address, name: wallet.name, positions: allPositions, totalUSD: 0 };
  });
  // 本轮起跑后被停用/删除的钱包不发布 (WALLETS 是活的全局列表, 路由已同步改过)
  walletResults = walletResults.filter(wr => activeWallets().some(w => w.address.toLowerCase() === (wr.address || '').toLowerCase()));

  // For active V3 positions: fill in createdAt (chain fallback) + lastCollectAt
  const activeV3Positions = [];
  for (const wr of walletResults) {
    for (const pos of wr.positions) {
      if (pos.protocol === 'V3' && pos.liquidityActive) {
        activeV3Positions.push(pos);
      }
    }
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

  // Get USD prices (once for all tokens); 闲置余额候选一并送定价 (coingecko 可覆盖 WBNB 等)
  const idleCandBsc = [...new Set([...allTokenAddresses, ...STABLECOINS, WBNB.toLowerCase()])];
  const usdPrices = await getUSDPrices(idleCandBsc, allPositions);

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
      const price0 = usdPrices[pos.token0.address.toLowerCase()] || 0;
      const price1 = usdPrices[pos.token1.address.toLowerCase()] || 0;

      pos.token0USD = price0;
      pos.token1USD = price1;
      pos.positionValueUSD = pos.amount0 * price0 + pos.amount1 * price1;
      pos.feesValueUSD = pos.feesOwed0 * price0 + pos.feesOwed1 * price1;
      pos.totalValueUSD = pos.positionValueUSD + pos.feesValueUSD;

      // 建仓价值: 只读缓存, 缺失交给后台异步队列补 (子图 amountUSD 聚合)
      {
        const kind = pos.protocol === 'V4' ? 'v4' : 'v3';
        const job = kind === 'v3'
          ? { kind, tokenId: pos.tokenId, poolAddress: pos.poolAddress, tickLower: pos.tickLower, tickUpper: pos.tickUpper, owner: pos.walletAddress, liq: pos.liquidity }
          : { kind, tokenId: pos.tokenId, poolId: pos.poolAddress, tickLower: pos.tickLower, tickUpper: pos.tickUpper, owner: pos.walletAddress, liq: pos.liquidity };
        const ed = bscEntryPeek(kind, pos.tokenId, pos.liquidity, job);
        if (ed) {
          pos.entryValueUSD = ed.u;
          pos.entryWithdrawnUSD = ed.w;
          pos.entryTs = ed.ts;
          pos.entryAdds = ed.n;
          pos.entryModified = ed.mod;
        }
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
          const collectedUSD = cf.token0 * price0 + cf.token1 * price1;
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

  // 钱包闲置余额: 按 fund-config 启用/勾选过滤; 失败沿用上轮快照, 不拖累主数据
  const fundCfg = loadFundCfg();
  const fundSel = fundCfg.wallets.bsc;
  const fundWallets = !fundCfg.enabled ? []
    : (!Array.isArray(fundSel) ? activeWallets() : activeWallets().filter(w => fundSel.some(a => String(a).toLowerCase() === w.address.toLowerCase())));
  let idle = null;
  if (fundWallets.length) {
    idle = lastIdleBsc || cache.data?.idle || null;
    try {
      idle = await fetchIdleBsc(fundWallets, idleCandBsc, usdPrices);
      lastIdleBsc = idle;
    } catch (e) { console.error('[BSC] idle balances failed:', e.message?.slice(0, 100)); }
  }

  const result = {
    wallets,
    grandTotalUSD,
    idle,
    timestamp: Date.now(),
    stats: {
      totalActive,
      totalInRange,
      totalOutOfRange,
      totalFees,
      walletsWithActiveLP,
      totalWallets: activeWallets().length,
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
  const fixIdle = (idle) => {
    if (!idle || !idle.byWallet || !idle.byWallet[addr]) return;
    delete idle.byWallet[addr];
    idle.totalUSD = Object.values(idle.byWallet).reduce((s, w) => s + (w.totalUSD || 0), 0);
  };
  if (cache.data) {
    const d = cache.data;
    d.wallets = (d.wallets || []).filter(w => (w.address || '').toLowerCase() !== addr);
    const sm = summarizeWallets(d.wallets);
    d.grandTotalUSD = sm.grandTotalUSD;
    d.stats = { ...(d.stats || {}), ...sm, totalWallets: activeWallets().length };
    fixIdle(d.idle);
    savePosCache();
  }
  fixIdle(lastIdleBsc);
}
// 重新启用钱包: 后台补一轮把它带回来, 不清老数据 (与 EVM 适配器 kickRefresh 同语义)
function kickBscRefresh() {
  if (fetchInFlight) return;
  fetchInFlight = _fetchPositionsInner(false)
    .catch(e => console.error('[BSC] kick refresh failed:', e.message))
    .finally(() => { fetchInFlight = null; });
}

// --- Wallet management API ---
app.get('/api/wallets', (req, res) => {
  res.json(WALLETS);
});

app.post('/api/wallets', adminGuard, (req, res) => {
  const { address, name } = req.body;
  if (!address || !name) return res.status(400).json({ error: '需要 address 和 name' });
  const addr = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: '无效的 BSC 地址' });
  if (WALLETS.some(w => w.address.toLowerCase() === addr)) return res.status(409).json({ error: '地址已存在' });
  if (WALLETS.length >= 30) return res.status(400).json({ error: '最多支持 30 个地址' });
  WALLETS.push({ address: addr, name: name.trim() });
  saveWallets(WALLETS);
  cache = { data: null, timestamp: 0 }; // clear cache so next fetch uses new list
  console.log(`Wallet added: ${name.trim()} (${addr})`);
  res.json({ ok: true, wallets: WALLETS });
});

app.delete('/api/wallets/:address', adminGuard, (req, res) => {
  const addr = req.params.address.toLowerCase();
  const idx = WALLETS.findIndex(w => w.address.toLowerCase() === addr);
  if (idx === -1) return res.status(404).json({ error: '地址不存在' });
  const removed = WALLETS.splice(idx, 1)[0];
  saveWallets(WALLETS);
  cache = { data: null, timestamp: 0 };
  console.log(`Wallet removed: ${removed.name} (${addr})`);
  res.json({ ok: true, wallets: WALLETS });
});

// 编辑钱包: 改名和/或换地址。换地址等同删旧+加新, 沿用 BSC 增删的清缓存语义
app.patch('/api/wallets/:address', adminGuard, (req, res) => {
  const cur = req.params.address.toLowerCase();
  const idx = WALLETS.findIndex(w => w.address.toLowerCase() === cur);
  if (idx === -1) return res.status(404).json({ error: '地址不存在' });
  const { name, address, enabled } = req.body || {};
  let newName, newAddr, newEnabled;
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled 须为布尔值' });
    newEnabled = enabled;
  }
  if (name !== undefined) {
    newName = String(name).trim();
    if (!newName) return res.status(400).json({ error: '名称不能为空' });
  }
  if (address !== undefined) {
    newAddr = String(address).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(newAddr)) return res.status(400).json({ error: '无效的 BSC 地址' });
    if (newAddr !== cur && WALLETS.some((w, i) => i !== idx && w.address.toLowerCase() === newAddr)) return res.status(409).json({ error: '地址已存在' });
  }
  if (newName === undefined && newAddr === undefined && newEnabled === undefined) return res.status(400).json({ error: '需要 name / address / enabled' });
  const old = { ...WALLETS[idx] };
  const addrChanged = newAddr !== undefined && newAddr !== cur;
  const enabledChanged = newEnabled !== undefined && newEnabled !== isWalletOn(old);
  if (newName !== undefined) WALLETS[idx].name = newName;
  if (newAddr !== undefined) WALLETS[idx].address = newAddr;
  if (newEnabled !== undefined) { if (newEnabled) delete WALLETS[idx].enabled; else WALLETS[idx].enabled = false; }
  saveWallets(WALLETS);
  if (addrChanged) {
    cache = { data: null, timestamp: 0 };
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

app.get('/api/positions', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const data = await fetchPositions(forceRefresh);
    res.json(data);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Solana (Meteora DLMM + Raydium CLMM) ---
let solKickRefresh = null, evmKickRefresh = null;
try {
  const solMod = require('./sol-adapter');
  solMod.mountSolRoutes(app, adminGuard);
  solKickRefresh = solMod.kickSolRefresh || null;
  console.log('SOL adapter mounted (/api/sol/*)');
} catch (e) {
  console.error('SOL adapter failed to mount:', e.message);
}

// --- EVM 多链 (Ethereum + Robinhood Chain), 每链独立钱包文件 wallets-<chain>.json ---
try {
  const evmMod = require('./evm-adapter');
  evmMod.mountEvmRoutes(app, adminGuard);
  evmKickRefresh = evmMod.kickRefresh || null;
} catch (e) {
  console.error('EVM adapter failed to mount:', e.message);
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
// wallets.<chain> 未设置 = 该链全部钱包参与; [] = 全不参与; 数组 = 勾选子集
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
  } catch (e) { return res.status(500).json({ error: '写入失败: ' + e.message }); }
  // 踢一轮当前链后台刷新, 让改动尽快生效 (其余链下轮 5min 周期自然跟上)
  const ch = String(body._chain || '');
  try {
    if (['eth', 'rh', 'base', 'arc'].includes(ch) && evmKickRefresh) evmKickRefresh(ch);
    else if (ch === 'sol' && solKickRefresh) solKickRefresh();
  } catch {}
  console.log(`[fund] config saved: enabled=${next.enabled}, chains=${Object.keys(next.wallets).join(',') || '(all default)'}`);
  res.json(loadFundCfg());
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
  } catch (e) { return res.status(500).json({ error: '写入失败: ' + e.message }); }
  console.log(`[ui] config saved: walletMgr=${next.walletMgr}`);
  res.json(loadUiCfg());
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`LP Dashboard running at http://0.0.0.0:${PORT}`);
});

// --- 服务端定时自动刷新（不依赖前端触发）---
// 每 10 分钟后台跑一轮 BSC 数据拉取，页面随时来拿都是热缓存。
setInterval(() => {
  if (fetchInFlight) { console.log('[auto] skip: fetch already in flight'); return; }
  console.log('[auto] server-side scheduled refresh starting...');
  fetchInFlight = _fetchPositionsInner(false)
    .then(() => console.log('[auto] scheduled refresh done'))
    .catch(e => console.error('[auto] scheduled refresh failed:', e.message))
    .finally(() => { fetchInFlight = null; });
}, CACHE_TTL);

// 启动预热: pm2 重启会把上面的定时器归零, 不预热的话要干等 10 分钟才跑第一轮,
// 叠加拉取耗时会造成 15-20 分钟数据空窗。启动 15s 后检查磁盘缓存年龄, 超过半个 TTL 立即补一轮。
setTimeout(() => {
  if (fetchInFlight) return;
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL / 2) { console.log('[auto] 预热跳过: 缓存还新鲜'); return; }
  console.log('[auto] 启动预热刷新 (缓存已陈旧)...');
  fetchInFlight = _fetchPositionsInner(false)
    .then(() => console.log('[auto] 预热刷新完成'))
    .catch(e => console.error('[auto] 预热刷新失败:', e.message))
    .finally(() => { fetchInFlight = null; });
}, 15 * 1000);
