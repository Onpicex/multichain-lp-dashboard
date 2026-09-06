// --- Robinhood 股票代币 × 美股成交额 ---------------------------------------
// 代币清单: api.robinhood.com/rhj/assets (docs.robinhood.com/chain/contracts 页面同一数据源,
//           全部 Stock Tokens & Tokenized ETFs, chainId 4663), 快照兜底 stocktokens-registry.json
// 美股行情: ① Nasdaq screener 全量导出 (一次请求覆盖全部个股, 服务器实测可达)
//           ② 不在个股 screener 里的 ETF/特例走 Cboe delayed quotes 逐个拉 (~18 个, 节流+429 冷却)
//           Yahoo Finance 对本服务器 IP 整段 429, 不可用
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REGISTRY_URL = 'https://api.robinhood.com/rhj/assets';
const REGISTRY_FILE = path.join(__dirname, 'stocktokens-registry.json');
const CACHE_FILE = path.join(__dirname, 'stocktokens-cache.json');
const QUOTE_TTL = 45 * 1000;             // 行情缓存有效期
const REGISTRY_TTL = 24 * 3600 * 1000;   // 代币注册表每日刷一次
const CBOE_COOLDOWN = 5 * 60 * 1000;     // Cboe 429 后冷却
const CBOE_GAP = 300;                    // Cboe 逐个请求间隔 ms

// --- RH 链池子扫描 (V4 PoolManager Initialize + V3 factory PoolCreated) ---
const RH_RPC = process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const RH_V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const RH_V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const POOLS_FILE = path.join(__dirname, 'stocktokens-pools-rh.json');
const POOL_TTL = 10 * 60 * 1000;   // 池子扫描周期 (事件只增不改, 增量续扫)
const POOL_CHUNK = 5 * 1000 * 1000; // rh RPC 全范围 getLogs 间歇 -32000, 必须分段
const POOL_RR = 4000;              // 零流动性池每轮轮转复查条数 (全量 ~2h 转一圈)
const RH_MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const RH_STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const MC_IFACE = new ethers.Interface([
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
]);
const SV_IFACE = new ethers.Interface(['function getLiquidity(bytes32 poolId) view returns (uint128)']);
const V3_LIQ_SEL = '0x1a686502';   // liquidity()
const KNOWN_ADDR = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
};

let registry = [];        // [{sym,name,addr,logo}]
let registryAt = 0;
let quotes = {};          // sym -> {price,chgPct,volume,marketCap,sector,src,at}
let quotesAt = 0;
let cboeSyms = [];        // 上次 Nasdaq 批量没覆盖到的符号 (ETF + 特例)
let cboeUntil = 0;        // 429 冷却截止时间
let refreshing = null;
let lastErr = '';
// pools 只存「涉及官方代币」的池子 (RH 链总池数 100 万+, 全存会爆内存):
//   {t0,t1,fee,ts(tickSpacing),v, id(V4 poolId)|pa(V3 池地址), liq: -1 未查/0 无流动性/1 有流动性}
// RH 链 spam 池泛滥 (194 个官方代币全被开过垃圾池, NVDA 一个 1 万+), 「有池」以链上当前流动性>0 为准
let poolState = { ver: 3, addrs: [], last4: 0, last3: 0, rr: 0, pools: [] };
let poolScanAt = 0;
let poolScanning = null;
let poolBacklog = true;   // 尚未扫到链头 (下次 API 命中立即续扫, 不等 TTL)
let rhProvider = null;

// 磁盘缓存热启动
try {
  const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  quotes = c.quotes || {};
  quotesAt = c.quotesAt || 0;
  cboeSyms = c.cboeSyms || [];
} catch {}
try {
  const p = JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8'));
  if (p.ver === 3 && Array.isArray(p.pools)) poolState = p;   // 旧版式 (无 id/liq/ts) 直接弃, 触发全量重扫
} catch {}

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ quotesAt, quotes, cboeSyms })); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseNum(s) {
  const n = parseFloat(String(s ?? '').replace(/[,$%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

async function jfetch(url, headers, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: ctl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

// --- 代币注册表 -------------------------------------------------------------
async function ensureRegistry(force) {
  if (!force && registry.length && Date.now() - registryAt < REGISTRY_TTL) return;
  try {
    const d = await jfetch(REGISTRY_URL, {}, 20000);
    const seen = new Set();
    const list = [];
    for (const a of d.assets || []) {
      const sym = a.tokenSymbol;
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      const dep = (a.deployments || [])[0] || {};
      list.push({
        sym,
        name: (a.tokenName || '').replace(/\s*•\s*Robinhood Token\s*$/, ''),
        addr: dep.contractAddress || '',
        logo: a.logoUrl || '',
      });
    }
    if (list.length > 50) {   // 半空响应不覆盖
      registry = list;
      registryAt = Date.now();
      try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(list)); } catch {}
      return;
    }
    throw new Error('registry too small: ' + list.length);
  } catch (e) {
    if (!registry.length) {
      try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); registryAt = Date.now(); } catch {}
    }
    if (!registry.length) throw new Error('registry unavailable: ' + e.message);
    console.error('[stocktokens] registry refresh failed, using cached:', e.message);
  }
}

// --- 行情源 -----------------------------------------------------------------
async function fetchNasdaq() {
  const d = await jfetch('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=0&download=true', {
    Accept: 'application/json',
    Origin: 'https://www.nasdaq.com',
    Referer: 'https://www.nasdaq.com/',
  }, 25000);
  const rows = d?.data?.rows;
  if (!Array.isArray(rows) || rows.length < 1000) throw new Error('bad rows: ' + (rows && rows.length));
  const by = {};
  for (const r of rows) {
    by[r.symbol] = {
      price: parseNum(r.lastsale),
      chgPct: parseNum(r.pctchange),
      volume: parseNum(r.volume),
      marketCap: parseNum(r.marketCap),
      sector: r.sector || '',
    };
  }
  return by;
}

async function fetchCboe(sym) {
  const d = await jfetch(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/${encodeURIComponent(sym)}.json`, {}, 10000);
  const q = d?.data;
  if (!q || !(q.current_price > 0)) return null;
  // 陈旧僵尸条目守卫 (如已改代码的股票会留下几个月前的旧快照)
  const ts = Date.parse(String(d.timestamp || '').replace(' ', 'T') + 'Z');
  if (ts && Date.now() - ts > 5 * 24 * 3600 * 1000) return null;
  return {
    price: q.current_price,
    chgPct: q.price_change_percent || 0,
    volume: q.volume || 0,
    marketCap: 0,
    sector: '',
  };
}

// --- RH 链池子扫描 -----------------------------------------------------------
const T_V4_INIT = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const T_V3_CREATED = ethers.id('PoolCreated(address,address,uint24,int24,address)');

// 「结果数超限」是确定性错误, 重试无意义, 立即抛给上层降段; 只对瞬时错误 (-32000 internal/429/超时) 重试
function isPermanentLogErr(e) {
  return /matched by|exceeds? .{0,12}limit|too many|response size|query returned more/i.test(String(e && (e.message || e)));
}
async function getLogsRetry(prov, filter, tries = 3) {
  for (let a = 0; ; a++) {
    try { return await prov.getLogs(filter); }
    catch (e) {
      if (isPermanentLogErr(e) || a >= tries - 1) throw e;
      await sleep(600 * (a + 1));
    }
  }
}

// 分段扫日志; 失败自适应递减段长 5M→1M→200K→40K (兼治间歇 -32000 与单段日志数超限),
// 40K 仍失败则失败段前止步返回已扫块高, 下轮续扫 (不丢事件)
async function scanPoolLogs(prov, address, topic, from, to, onLog, chunk = POOL_CHUNK) {
  let b = from;
  while (b <= to) {
    const end = Math.min(b + chunk - 1, to);
    let logs;
    try {
      logs = await getLogsRetry(prov, { address, topics: [topic], fromBlock: b, toBlock: end });
    } catch (e) {
      if (chunk > 100000) {
        const sub = await scanPoolLogs(prov, address, topic, b, end, onLog, Math.floor(chunk / 5));
        if (sub < end) return sub;
        b = end + 1;
        continue;
      }
      return b - 1;
    }
    for (const l of logs) onLog(l);
    b = end + 1;
    await sleep(120);
  }
  return to;
}

// Multicall3 批量查流动性 (V4 走 StateView.getLiquidity(poolId), V3 走池合约 liquidity())
// 就地更新 entries[].liq, 返回是否有变化; 单批失败重试一次后跳过 (下轮轮转还会再查)
async function checkLiquidity(entries) {
  let changed = false;
  for (let i = 0; i < entries.length; i += 250) {
    const batch = entries.slice(i, i + 250);
    const calls = batch.map(p => p.v === 4
      ? { target: RH_STATE_VIEW, allowFailure: true, callData: SV_IFACE.encodeFunctionData('getLiquidity', [p.id]) }
      : { target: p.pa, allowFailure: true, callData: V3_LIQ_SEL });
    let res = null;
    for (let a = 0; a < 2 && !res; a++) {
      try {
        const raw = await rhProvider.call({ to: RH_MULTICALL3, data: MC_IFACE.encodeFunctionData('aggregate3', [calls]) });
        res = MC_IFACE.decodeFunctionResult('aggregate3', raw)[0];
      } catch (e) { await sleep(600); }
    }
    if (!res) continue;
    res.forEach((r, j) => {
      const p = batch[j];
      const nv = (r.success && r.returnData && r.returnData.length >= 66 && BigInt(r.returnData) > 0n) ? 1 : 0;
      if (p.liq !== nv) { p.liq = nv; changed = true; }
    });
    await sleep(150);
  }
  return changed;
}

async function scanPools() {
  if (poolScanning) return poolScanning;
  poolScanning = (async () => {
    if (!rhProvider) rhProvider = new ethers.JsonRpcProvider(RH_RPC, undefined, { staticNetwork: true });
    const addrSet = new Set(registry.map(t => (t.addr || '').toLowerCase()).filter(Boolean));
    // 注册表出现新代币: 其历史池子此前在入库时被过滤掉了, 只能全量重扫 (罕见, 后台自动)
    const stored = new Set(poolState.addrs || []);
    if ([...addrSet].some(a => !stored.has(a))) {
      console.log('[stocktokens] registry token set changed, full pool rescan');
      poolState = { ver: 3, addrs: [...addrSet].sort(), last4: 0, last3: 0, rr: 0, pools: [] };
    }
    const head = await rhProvider.getBlockNumber();
    const before = poolState.pools.length, prev4 = poolState.last4, prev3 = poolState.last3;
    const done4 = await scanPoolLogs(rhProvider, RH_V4_POOL_MANAGER, T_V4_INIT, poolState.last4 + 1, head, l => {
      const t0 = ('0x' + l.topics[2].slice(26)).toLowerCase();
      const t1 = ('0x' + l.topics[3].slice(26)).toLowerCase();
      if (!addrSet.has(t0) && !addrSet.has(t1)) return;
      poolState.pools.push({ id: l.topics[1], t0, t1, fee: parseInt(l.data.slice(2, 66), 16) || 0,
        ts: parseInt(l.data.slice(66, 130), 16) || 0, v: 4, liq: -1 });   // data 字1 = tickSpacing
    });
    if (done4 > poolState.last4) poolState.last4 = done4;
    const done3 = await scanPoolLogs(rhProvider, RH_V3_FACTORY, T_V3_CREATED, poolState.last3 + 1, head, l => {
      const t0 = ('0x' + l.topics[1].slice(26)).toLowerCase();
      const t1 = ('0x' + l.topics[2].slice(26)).toLowerCase();
      if (!addrSet.has(t0) && !addrSet.has(t1)) return;
      poolState.pools.push({ pa: ('0x' + l.data.slice(90, 130)).toLowerCase(), t0, t1, fee: parseInt(l.topics[3], 16) || 0,
        ts: parseInt(l.data.slice(2, 66), 16) || 0, v: 3, liq: -1 });     // data 字0 = tickSpacing
    });
    if (done3 > poolState.last3) poolState.last3 = done3;
    // 流动性检查: 新池全查 + 活池复核 + 零流动性池轮转复查
    const fresh = poolState.pools.filter(p => p.liq === -1);
    const liquid = poolState.pools.filter(p => p.liq === 1);
    const zeros = poolState.pools.filter(p => p.liq === 0);
    const rrSlice = [];
    if (zeros.length) {
      const start = poolState.rr % zeros.length;
      const n = Math.min(POOL_RR, zeros.length);
      for (let i = 0; i < n; i++) rrSlice.push(zeros[(start + i) % zeros.length]);
      poolState.rr = (start + n) % zeros.length;
    }
    const liqChanged = await checkLiquidity([...fresh, ...liquid, ...rrSlice]);
    poolBacklog = poolState.last4 < head || poolState.last3 < head;
    const grew = poolState.pools.length !== before || poolState.last4 !== prev4 || poolState.last3 !== prev3;
    if (grew || liqChanged) { try { fs.writeFileSync(POOLS_FILE, JSON.stringify(poolState)); } catch {} }
    const nLiquid = poolState.pools.filter(p => p.liq === 1).length;
    console.log(`[stocktokens] rh pools: ${poolState.pools.length} stored, ${nLiquid} liquid (v4 head ${poolState.last4}, v3 head ${poolState.last3}, backlog ${poolBacklog})`);
  })().catch(e => console.error('[stocktokens] pool scan failed:', e.message))
    .finally(() => { poolScanning = null; });
  return poolScanning;
}

// --- 池子详情 (点击行展开: 每池 量/费/日化 + 主力区间) -------------------------
// 费收不扫 swap 日志 (rh 链一天 ~460 万笔 swap, RPC 单响应限 1 万条, 扫不动)——
// 用链上原生累计器 feeGrowthGlobal{0,1}X128 (每单位活跃 L 的累计费, X128 定点):
// 双环采样: ①全量扫描每 30min 采一次全部真实池, 留 25h 环形 (长窗口基准);
//           ②细采样每 5min 常驻采 TVL≥$1000 的池, 留 ~2.5h 环形 (短窗口/突增探测基准)。
// 日化按窗口差分: 每个窗口取两环中最接近「now − 窗口」的样本, 按实际时长折算 24h 口径。
// 流动性分布 (主力区间 = L≥70% 峰值的连续区间) 走 tickBitmap/ticks + Multicall 聚合。
const WINDOWS = [5, 10, 15, 30, 45, 60, 120, 180, 240, 360, 720, 1440];   // 分钟; 1440 = 主口径
// 伪尖峰护栏阈值: 差分的隐含假设是「挣费时活跃 L≈当前 L」, 套利单打穿尘埃流动性区间时
// (段内实际 L 可低至当前 L 的万分之一) 几毛钱费会被放大成几千刀 (DJT/WETH 0.05% 池实测 361 倍)。
// 判据 = 段隐含成交量物理不可能: 真实最猛 bot 混战池 ~1×TVL/小时, 50 倍上限余量充足。
const SPIKE_TURNOVER_CAP = 50;   // 固定费率池: 段隐含成交量 (费÷费率) 上限 = TVL×50×段小时
const SPIKE_FEE_CAP = 0.5;       // 动态费池推不出成交量, 退用段费收上限 = TVL×0.5×段小时
const FG_FILE = path.join(__dirname, 'stocktokens-feegrowth.json');
const FINE_FILE = path.join(__dirname, 'stocktokens-feegrowth-fine.json');
const FINE_TTL = 5 * 60 * 1000;          // 细采样周期
const FINE_KEEP = 2.6 * 3600 * 1000;     // 细环保留时长 (≤2h 窗口用得上, 更长窗口有粗环)
const SEL_FG0 = ethers.id('feeGrowthGlobal0X128()').slice(0, 10);
const SEL_FG1 = ethers.id('feeGrowthGlobal1X128()').slice(0, 10);
let fgHistory = [];     // 粗环 [{at, fg: {key: [hex0, hex1]}}] 按 at 升序
let fineHistory = [];   // 细环, 同构
let fineKeys = new Set();   // 细采样池集 = 上轮全量扫描中 TVL≥$1000 的池, 随 sweep 更新
try {
  const f = JSON.parse(fs.readFileSync(FG_FILE, 'utf8'));
  if (Array.isArray(f.samples)) fgHistory = f.samples;
} catch {}
try {
  const f = JSON.parse(fs.readFileSync(FINE_FILE, 'utf8'));
  if (Array.isArray(f.samples)) fineHistory = f.samples;
  if (Array.isArray(f.keys)) fineKeys = new Set(f.keys);
} catch {}
function saveFg() {
  try { fs.writeFileSync(FG_FILE, JSON.stringify({ samples: fgHistory })); } catch {}
}
function saveFine() {
  try { fs.writeFileSync(FINE_FILE, JSON.stringify({ keys: [...fineKeys], samples: fineHistory })); } catch {}
}
// 每个窗口的全局差分基准 = 两环合并后最接近「now − 窗口」的样本 (排除 1min 内的太新样本)
function buildSampleIndex(nowMs) {
  const samples = [...fgHistory, ...fineHistory].filter(s => s.at < nowMs - 60000).sort((a, b) => a.at - b.at);
  const bestByWin = {};
  for (const wm of WINDOWS) {
    const target = nowMs - wm * 60000;
    let best = null;
    for (const s of samples) if (!best || Math.abs(s.at - target) < Math.abs(best.at - target)) best = s;
    bestByWin[wm] = best;
  }
  return { samples, bestByWin };
}
const SV2_IFACE = new ethers.Interface([
  'function getFeeGrowthGlobals(bytes32) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)',
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
  'function getTickBitmap(bytes32, int16) view returns (uint256)',
  'function getTickLiquidity(bytes32, int24) view returns (uint128 liquidityGross, int128 liquidityNet)',
]);
const V3P_IFACE = new ethers.Interface([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 a, uint16 b, uint16 c, uint8 d, bool e)',
  'function liquidity() view returns (uint128)',
  'function tickBitmap(int16) view returns (uint256)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 f0, uint256 f1, int56 tc, uint160 so, uint32 sot, bool init)',
]);
const ERC20_IFACE = new ethers.Interface(['function decimals() view returns (uint8)']);
const BITMAP_HALF = 3;              // 当前 word ±3 (每 word=256 个 spacing, 已覆盖极宽价域)
const SWEEP_TTL = 30 * 60 * 1000;   // 全量日化扫描周期 (feeGrowth 采样纯状态读, 很便宜)
const DAILY_FILE = path.join(__dirname, 'stocktokens-pooldaily.json');
const detailCache = {};             // sym -> {at, data} 或 {promise}
const decCache = { '0x0000000000000000000000000000000000000000': 18 };
let dailyBySym = {};                // sym -> {d: 最高池日化(24h), m: 主力日化, pool: 标签, tvl, w: {分钟: {d,m,h,pool}}, at}
let lastStats = null;               // 上次全量扫描的原始池统计 (含 BigInt 上下文), 细采样零 RPC 重算窗口用
let sweepAt = 0;
let sweepTryAt = 0;
let sweeping = null;
try {
  const f = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8'));
  dailyBySym = f.bySym || {};
  sweepAt = f.at || 0;
} catch {}
function saveDaily() {
  try { fs.writeFileSync(DAILY_FILE, JSON.stringify({ at: sweepAt, bySym: dailyBySym })); } catch {}
}

async function stage(name, fn) {
  try { return await fn(); }
  catch (e) { e.message = `[${name}] ` + (e.message || ''); throw e; }
}

// 通用 multicall: [{target,callData}] -> [returnData|null], 整批失败重试一次后置 null
async function mc3(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 250) {
    const batch = calls.slice(i, i + 250).map(c => ({ target: c.target, allowFailure: true, callData: c.callData }));
    let res = null;
    for (let a = 0; a < 2 && !res; a++) {
      try {
        const raw = await rhProvider.call({ to: RH_MULTICALL3, data: MC_IFACE.encodeFunctionData('aggregate3', [batch]) });
        res = MC_IFACE.decodeFunctionResult('aggregate3', raw)[0];
      } catch (e) { await sleep(500); }
    }
    if (!res) { batch.forEach(() => out.push(null)); }
    else for (const r of res) out.push(r.success && r.returnData !== '0x' ? r.returnData : null);
    await sleep(120);
  }
  return out;
}



// 每单位 L 在区间 [sqrtA,sqrtB]、现价 sqrtP 下的 raw 数量 (标准 clamp 公式, float 足够展示精度)
function amountsPerL(sqrtP, sqrtA, sqrtB) {
  if (sqrtA > sqrtB) { const t = sqrtA; sqrtA = sqrtB; sqrtB = t; }
  const p = Math.min(Math.max(sqrtP, sqrtA), sqrtB);
  return [(sqrtB - p) / (p * sqrtB), p - sqrtA];
}
const tickSqrt = t => Math.pow(1.0001, t / 2);

async function ensureDecimals(addrs) {
  const need = [...new Set(addrs)].filter(a => !(a in decCache));
  if (!need.length) return;
  const res = await mc3(need.map(a => ({ target: a, callData: ERC20_IFACE.encodeFunctionData('decimals', []) })));
  need.forEach((a, i) => { decCache[a] = res[i] ? Number(BigInt(res[i])) : 18; });
}

// 美元锚: USDG=1 优先, 否则用官方代币美股报价锚定一侧, 另一侧按池内价推
function usdAnchors(t0, t1, dec0, dec1, sqrtP) {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const hp = (sqrtP * sqrtP) * Math.pow(10, dec0 - dec1);   // 1 个 token0 值多少 token1 (人类单位)
  const q = sym => { const x = quotes[sym]; return x && x.price > 0 ? x.price : 0; };
  const sym0 = addrToSymGlobal[t0], sym1 = addrToSymGlobal[t1];
  if (t1 === USDG) return [hp, 1];
  if (t0 === USDG) return [1, hp > 0 ? 1 / hp : 0];
  const q0 = sym0 ? q(sym0) : 0, q1 = sym1 ? q(sym1) : 0;
  if (q1 > 0) return [hp * q1, q1];
  if (q0 > 0) return [q0, hp > 0 ? q0 / hp : 0];
  return [0, 0];
}
let addrToSymGlobal = {};   // buildPayload/detail 共用, ensureRegistry 后重建

function rebuildAddrSym() {
  addrToSymGlobal = { ...KNOWN_ADDR };
  for (const t of registry) if (t.addr) addrToSymGlobal[t.addr.toLowerCase()] = t.sym;
}
// 与成交额页 RH 池列同一套「真实池」判据
function isRealPool(p) {
  if (p.liq !== 1) return false;
  if (!(p.t0 in addrToSymGlobal) || !(p.t1 in addrToSymGlobal)) return false;
  return (p.v === 4 && (p.fee & 0x800000)) || p.fee <= 100000;
}

// feeGrowth 采样 (全量扫描与细采样共用): pools -> {key: [hex0, hex1, hexL?]}
// 第 3 位 = 采样时活跃 L: 分段费收用「当段采样 L」而非「当前 L」——MM 在窗口内加减仓会让
// Δfg×当前L 等比例虚高/虚低 (SKHY 主池实测虚高 9.3 倍); L 由 LP 增删驱动阶梯变化,
// 5min/30min 采样粒度跟得上。旧样本无此位时下游回退当前 L (25h 环形滚动自愈)。
async function sampleFeeGrowth(pools) {
  const fgCalls = [], fgMeta = [];
  for (const p of pools) {
    if (p.v === 4) {
      fgMeta.push({ key: p.id, both: true });
      fgCalls.push({ target: RH_STATE_VIEW, callData: SV2_IFACE.encodeFunctionData('getFeeGrowthGlobals', [p.id]) });
      fgMeta.push({ key: p.id, liq: true });
      fgCalls.push({ target: RH_STATE_VIEW, callData: SV2_IFACE.encodeFunctionData('getLiquidity', [p.id]) });
    } else {
      fgMeta.push({ key: p.pa, slot: 0 });
      fgCalls.push({ target: p.pa, callData: SEL_FG0 });
      fgMeta.push({ key: p.pa, slot: 1 });
      fgCalls.push({ target: p.pa, callData: SEL_FG1 });
      fgMeta.push({ key: p.pa, liq: true });
      fgCalls.push({ target: p.pa, callData: V3P_IFACE.encodeFunctionData('liquidity', []) });
    }
  }
  const fgRes = await mc3(fgCalls);
  const fgNow = {}, lm = {};
  fgRes.forEach((r, k) => {
    if (!r || r.length < 66) return;
    const m = fgMeta[k];
    if (m.liq) lm[m.key] = '0x' + BigInt(r).toString(16);
    else if (m.both) fgNow[m.key] = ['0x' + r.slice(2, 66), '0x' + r.slice(66, 130)];
    else (fgNow[m.key] = fgNow[m.key] || ['0x0', '0x0'])[m.slot] = '0x' + r.slice(2, 66);
  });
  // L 只挂在 fg 采样成功的池上 (避免凭空造出 fg=0 的假样本)
  for (const k in fgNow) if (lm[k] != null) fgNow[k][2] = lm[k];
  return fgNow;
}

// 对单池按全部窗口做差分: 写入 st.win = {分钟: {d 池日化, m 主力日化, h 实际窗口小时, x 剔除段数}},
// 并同步 24h 主口径旧字段 (dayPct/fees24/vol24/winH/mainDaily)。nf 缺失 = 本轮没采到, 全清。
// st 需带上下文 _L (当前活跃 L, BigInt) 与 _vperl (主力区间单位 L 仓位价值)。
// 伪尖峰护栏: 端点差 = 相邻样本段差之和, 故按样本拆段逐段体检 (SPIKE_* 判据),
// 不合理的段计 0 并计入 x; 剔完整窗合计仍不合理 (多段慢渗) → 整窗标异常 (d/m 置 null 只留 x)。
function computeWins(st, nf, nowMs, samples, bestByWin) {
  st.win = {}; st.dayPct = null; st.fees24 = null; st.vol24 = null; st.winH = 0; st.mainDaily = null;
  if (!nf) return;
  const rate = (st.v === 4 && (st.fee & 0x800000)) ? 0 : st.fee / 1e6;
  const Lnow = Number(st._L);
  const implausible = (fee, hrs) => st.tvl > 0 && hrs > 0 && fee > 0 &&
    (rate > 0 ? fee / rate > st.tvl * SPIKE_TURNOVER_CAP * hrs
              : fee > st.tvl * SPIKE_FEE_CAP * hrs);
  // 该池的样本时间线 (升序) + 当前值 → 相邻段费收逐段体检好, 各窗口取后缀和
  const chain = [];
  for (const s of samples) if (s.fg[st.key]) chain.push({ at: s.at, fg: s.fg[st.key] });
  chain.push({ at: nowMs, fg: nf });
  const segs = [];   // {at 段末时刻, fee 体检后费收 USD, perL 体检后单位L费收 USD, bad}
  for (let i = 1; i < chain.length; i++) {
    const A = chain[i - 1].fg, B = chain[i].fg;
    const d0 = Number(BigInt(B[0]) - BigInt(A[0]));
    const d1 = Number(BigInt(B[1]) - BigInt(A[1]));
    const f0 = d0 > 0 ? d0 / 2 ** 128 / 10 ** st.dec0 * st.p0usd : 0;
    const f1 = d1 > 0 ? d1 / 2 ** 128 / 10 ** st.dec1 * st.p1usd : 0;
    const perL = f0 + f1;
    // 该段 L = 两端采样 L 均值 (费在段内挣得, 段间 L 阶梯变化); 缺哪端用哪端, 全缺回退当前 L
    const La = A[2] != null ? Number(BigInt(A[2])) : null;
    const Lb = B[2] != null ? Number(BigInt(B[2])) : null;
    const Lseg = La != null && Lb != null ? (La + Lb) / 2 : (La != null ? La : (Lb != null ? Lb : Lnow));
    const fee = perL * Lseg;
    const bad = implausible(fee, (chain[i].at - chain[i - 1].at) / 3600000);
    segs.push({ at: chain[i].at, fee: bad ? 0 : fee, perL: bad ? 0 : perL, bad });
  }
  for (const wm of WINDOWS) {
    const target = nowMs - wm * 60000;
    let rf = null, rAt = 0;
    const gb = bestByWin[wm];
    if (gb && gb.fg[st.key]) { rf = gb.fg[st.key]; rAt = gb.at; }
    else {
      // 该池不在全局基准样本里 (新池 / 尘埃池不进细环): 在含它的样本中取最接近目标的
      let bd = Infinity;
      for (const s of samples) {
        if (!s.fg[st.key]) continue;
        const d = Math.abs(s.at - target);
        if (d < bd) { bd = d; rf = s.fg[st.key]; rAt = s.at; }
      }
    }
    const dt = rf ? nowMs - rAt : 0;
    if (!rf || dt <= 60000) continue;
    let sum = 0, sumPerL = 0, x = 0;
    for (const g of segs) if (g.at > rAt) { sum += g.fee; sumPerL += g.perL; if (g.bad) x++; }
    const fees = sum * (86400000 / dt);   // 折算 24h
    if (implausible(fees, 24)) { st.win[wm] = { d: null, m: null, h: +(dt / 3600000).toFixed(2), x: x + 1 }; continue; }
    const dayPct = st.tvl > 0 ? fees / st.tvl * 100 : null;
    // 主力日化用纯单位 L 费收 (Δfg 本身), 不经过 ×L 还原——这是累计器的精确量
    const mainDaily = st._vperl > 0 ? sumPerL * (86400000 / dt) / st._vperl * 100 : null;
    st.win[wm] = {
      d: dayPct == null ? null : +dayPct.toPrecision(4),
      m: mainDaily == null ? null : +mainDaily.toPrecision(4),
      h: +(dt / 3600000).toFixed(2),
      ...(x > 0 ? { x } : {}),
    };
    if (wm === 1440) {
      st.dayPct = dayPct; st.fees24 = fees; st.winH = dt / 3600000; st.mainDaily = mainDaily;
      st.vol24 = rate > 0 && fees > 0 ? fees / rate : null;   // 动态费池无固定费率, 量不可估
    }
  }
}

// 一组池子的中性统计 (不绑定股票视角); 全局日化扫描与单代币实时刷新共用
async function computePoolSet(pools) {
  if (!rhProvider) rhProvider = new ethers.JsonRpcProvider(RH_RPC, undefined, { staticNetwork: true });
  // ① feeGrowthGlobal 采样: 每单位活跃 L 的链上累计费收, 与历史样本按窗口差分
  const fgNow = await stage('feegrowth', () => sampleFeeGrowth(pools));
  const nowMs = Date.now();
  const { samples: fgSamples, bestByWin } = buildSampleIndex(nowMs);

  // ② slot0 + liquidity
  const s0calls = pools.map(p => p.v === 4
    ? { target: RH_STATE_VIEW, callData: SV2_IFACE.encodeFunctionData('getSlot0', [p.id]) }
    : { target: p.pa, callData: V3P_IFACE.encodeFunctionData('slot0', []) });
  const liqCalls = pools.map(p => p.v === 4
    ? { target: RH_STATE_VIEW, callData: SV2_IFACE.encodeFunctionData('getLiquidity', [p.id]) }
    : { target: p.pa, callData: V3P_IFACE.encodeFunctionData('liquidity', []) });
  const s0res = await stage('slot0', () => mc3(s0calls));
  const liqRes = await stage('liq', () => mc3(liqCalls));
  await stage('decimals', () => ensureDecimals(pools.flatMap(p => [p.t0, p.t1]).filter(a => a !== '0x0000000000000000000000000000000000000000')));

  // ③ tickBitmap: 每池 当前word±3
  const bmCalls = [], bmMeta = [];
  pools.forEach((p, i) => {
    if (!s0res[i] || !p.ts) return;
    const tick = p.v === 4
      ? Number(SV2_IFACE.decodeFunctionResult('getSlot0', s0res[i])[1])
      : Number(V3P_IFACE.decodeFunctionResult('slot0', s0res[i])[1]);
    const w = Math.floor(tick / p.ts) >> 8;
    for (let d = -BITMAP_HALF; d <= BITMAP_HALF; d++) {
      bmMeta.push({ i, w: w + d });
      bmCalls.push(p.v === 4
        ? { target: RH_STATE_VIEW, callData: SV2_IFACE.encodeFunctionData('getTickBitmap', [p.id, w + d]) }
        : { target: p.pa, callData: V3P_IFACE.encodeFunctionData('tickBitmap', [w + d]) });
    }
  });
  const bmRes = await stage('bitmap', () => mc3(bmCalls));
  const ticksOf = pools.map(() => []);
  bmRes.forEach((r, k) => {
    if (!r) return;
    const { i, w } = bmMeta[k];
    let bm = BigInt(r);
    for (let b = 0; b < 256 && bm; b++) {
      if (bm & 1n) ticksOf[i].push((w * 256 + b) * pools[i].ts);
      bm >>= 1n;
    }
  });

  // ④ tick liquidityNet
  const tkCalls = [], tkMeta = [];
  pools.forEach((p, i) => {
    for (const t of ticksOf[i].slice(0, 600)) {
      tkMeta.push({ i, t });
      tkCalls.push(p.v === 4
        ? { target: RH_STATE_VIEW, callData: SV2_IFACE.encodeFunctionData('getTickLiquidity', [p.id, t]) }
        : { target: p.pa, callData: V3P_IFACE.encodeFunctionData('ticks', [t]) });
    }
  });
  if (pools.length > 100) console.log(`[stocktokens] poolset: state pass done, tick calls ${tkCalls.length}`);
  const tkRes = await stage('ticks', () => mc3(tkCalls));
  const netOf = pools.map(() => ({}));
  tkRes.forEach((r, k) => {
    if (!r) return;
    const { i, t } = tkMeta[k];
    const dec = pools[i].v === 4
      ? SV2_IFACE.decodeFunctionResult('getTickLiquidity', r)
      : V3P_IFACE.decodeFunctionResult('ticks', r);
    netOf[i][t] = BigInt(dec[1]);
  });

  // ⑤ 逐池汇总
  const out = [];
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    if (!s0res[i]) continue;
    const s0 = p.v === 4 ? SV2_IFACE.decodeFunctionResult('getSlot0', s0res[i]) : V3P_IFACE.decodeFunctionResult('slot0', s0res[i]);
    const sqrtP = Number(s0[0]) / 2 ** 96;
    const curTick = Number(s0[1]);
    const activeL = liqRes[i] ? BigInt(liqRes[i]) : 0n;
    const dec0 = decCache[p.t0] ?? 18, dec1 = decCache[p.t1] ?? 18;
    const [p0usd, p1usd] = usdAnchors(p.t0, p.t1, dec0, dec1, sqrtP);

    // L(t) 轮廓: 以现价段=activeL 锚定, 用 liquidityNet 双向推
    const ticks = ticksOf[i].filter(t => t in netOf[i]).sort((a, b) => a - b);
    const segs = [];   // {a,b,L} 连续段
    {
      const bounds = [...ticks];
      let idx = 0; while (idx < bounds.length && bounds[idx] <= curTick) idx++;
      // 从现价段向右
      let L = activeL;
      let lo = idx > 0 ? bounds[idx - 1] : curTick - 1, hi = idx < bounds.length ? bounds[idx] : curTick + 1;
      segs.push({ a: lo, b: hi, L });
      for (let j = idx; j < bounds.length; j++) {
        L += netOf[i][bounds[j]];
        segs.push({ a: bounds[j], b: j + 1 < bounds.length ? bounds[j + 1] : bounds[j] + 256 * p.ts, L });
      }
      // 向左
      L = activeL;
      for (let j = idx - 1; j >= 0; j--) {
        L -= netOf[i][bounds[j]];
        segs.unshift({ a: j > 0 ? bounds[j - 1] : bounds[j] - 256 * p.ts, b: bounds[j], L });
      }
    }
    const posSegs = segs.filter(s => s.L > 0n);
    // TVL (窗口内) + 各段 USD (主力判定复用)
    const segUsds = posSegs.map(s => {
      const [a0, a1] = amountsPerL(sqrtP, tickSqrt(s.a), tickSqrt(s.b));
      return Number(s.L) * (a0 / 10 ** dec0 * p0usd + a1 / 10 ** dec1 * p1usd);
    });
    let tvl = 0;
    for (const u of segUsds) tvl += u;
    // 主力区间: ≥70% 峰值 L 的连续段 (含峰值段)。
    // 峰值候选须自身 USD ≥ TVL×2%: 单 spacing 尘埃限价单的 L 密度可比真仓高一个量级
    // 但只占 TVL ~1%, 不排除会把主力区间骗到远离现价的孤点 (SPY/PLTR 池实测案例);
    // 无合格候选时退回全局最大 L (小池全是碎单的情形)
    let main = null, mainShare = 0;
    if (posSegs.length) {
      let mi = -1;
      for (let j = 0; j < posSegs.length; j++) {
        if (segUsds[j] < tvl * 0.02) continue;
        if (mi < 0 || posSegs[j].L > posSegs[mi].L) mi = j;
      }
      if (mi < 0) for (let j = 0; j < posSegs.length; j++) if (mi < 0 || posSegs[j].L > posSegs[mi].L) mi = j;
      const thr = posSegs[mi].L * 7n / 10n;
      let lo = mi, hi = mi;
      while (lo > 0 && posSegs[lo - 1].L >= thr && posSegs[lo - 1].b === posSegs[lo].a) lo--;
      while (hi < posSegs.length - 1 && posSegs[hi + 1].L >= thr && posSegs[hi + 1].a === posSegs[hi].b) hi++;
      main = { a: posSegs[lo].a, b: posSegs[hi].b };
      let mUsd = 0;
      for (let j = lo; j <= hi; j++) mUsd += segUsds[j];
      mainShare = tvl > 0 ? mUsd / tvl : 0;
    }
    // 主力区间单位 L 仓位价值 (各窗口主力日化共用分母)
    let vPerL = 0, inMain = false;
    if (main) {
      inMain = curTick >= main.a && curTick < main.b;
      const [a0, a1] = amountsPerL(sqrtP, tickSqrt(main.a), tickSqrt(main.b));
      vPerL = a0 / 10 ** dec0 * p0usd + a1 / 10 ** dec1 * p1usd;
    }
    const key = p.v === 4 ? p.id : p.pa;
    const st = {
      v: p.v, fee: p.fee, key,
      t0: p.t0, t1: p.t1, dec0, dec1, p0usd, p1usd, sqrtP,
      tvl, main, mainShare: mainShare * 100, inMain,
      _L: activeL, _vperl: vPerL,   // 细采样零 RPC 重算窗口所需上下文 (不进 payload)
    };
    computeWins(st, fgNow[key], nowMs, fgSamples, bestByWin);
    out.push(st);
  }
  return { stats: out, fgNow, windowH: bestByWin[1440] ? (nowMs - bestByWin[1440].at) / 3600000 : 0, sampleAt: nowMs };
}

// 把中性统计按某个官方代币的视角包装成展示对象
function presentPool(sym, al, s) {
  const stockIs0 = s.t0 === al;
  const symOf = a => addrToSymGlobal[a] || (a.slice(0, 6) + '…');
  const hpAt = t => Math.pow(1.0001, t) * Math.pow(10, s.dec0 - s.dec1);
  const hp = (s.sqrtP * s.sqrtP) * Math.pow(10, s.dec0 - s.dec1);
  let mainPrice = null, mainRatio = null;
  if (s.main) {
    // 池内比价区间 (对手币 per 1 本币) —— 非 USDG 对的展示主体, 美元折算降为悬停参考
    mainRatio = stockIs0 ? [hpAt(s.main.a), hpAt(s.main.b)] : [1 / hpAt(s.main.b), 1 / hpAt(s.main.a)];
    if (mainRatio[0] > mainRatio[1]) mainRatio = [mainRatio[1], mainRatio[0]];
    mainRatio = [+mainRatio[0].toPrecision(6), +mainRatio[1].toPrecision(6)];
    if (s.p0usd > 0 || s.p1usd > 0) {
      let lo, hi;
      if (stockIs0) { lo = hpAt(s.main.a) * s.p1usd; hi = hpAt(s.main.b) * s.p1usd; }
      else { lo = s.p0usd / hpAt(s.main.b); hi = s.p0usd / hpAt(s.main.a); }
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      mainPrice = [lo, hi];
    }
  }
  const curRatio = stockIs0 ? hp : (hp > 0 ? 1 / hp : 0);
  return {
    v: s.v,
    pair: `${sym}/${symOf(stockIs0 ? s.t1 : s.t0)}`,
    feeLabel: s.v === 4 && (s.fee & 0x800000) ? '动态费' : (s.fee / 10000) + '%',
    key: s.key,
    tvl: s.tvl, vol24: s.vol24, fees24: s.fees24, dayPct: s.dayPct, winH: s.winH,
    win: s.win || {},
    mainPrice, mainRatio, mainShare: s.mainShare, mainDaily: s.mainDaily, inMain: s.inMain,
    curPrice: stockIs0 ? hp * s.p1usd : (s.p0usd > 0 && hp > 0 ? s.p0usd / hp : 0),
    curRatio: curRatio > 0 ? +curRatio.toPrecision(6) : 0,
    usdQuote: (stockIs0 ? s.t1 : s.t0) === '0x5fc5360d0400a0fd4f2af552add042d716f1d168',   // 对手币是否 USDG
  };
}

function packDetail(sym, arr, windowH) {
  arr.sort((a, b) => ((b.fees24 || 0) - (a.fees24 || 0)) || b.tvl - a.tvl);
  const kept = arr.filter(p => p.tvl >= 1000);   // 尘埃池不看 (TVL < $1000)
  return { sym, updatedAt: Date.now(), windowH, pools: kept, hidden: arr.length - kept.length };
}

// 记录该代币所有池 (TVL≥1000) 的最高池日化 (按全部窗口各记一份), 供首页列显示
function noteDaily(sym, data) {
  let best = null, tvl = 0;
  const w = {};
  for (const p of data.pools) {
    tvl += p.tvl;   // 只合计 TVL≥$1000 的真实池 (与详情表之和一致)
    if (p.dayPct != null && (!best || p.dayPct > best.dayPct)) best = p;
    if (p.win) for (const k in p.win) {
      const e = p.win[k];
      if (e.d != null && (!w[k] || e.d > w[k].d)) w[k] = { d: e.d, m: e.m, h: e.h, pool: `V${p.v} ${p.pair} ${p.feeLabel}`, ...(e.x ? { x: e.x } : {}) };
    }
  }
  const bx = best && best.win && best.win[1440] && best.win[1440].x;   // 最高池 24h 窗口的伪尖峰剔除段数
  if (best) dailyBySym[sym] = { d: best.dayPct, m: best.mainDaily, pool: `V${best.v} ${best.pair} ${best.feeLabel}`, tvl, w, at: Date.now(), ...(bx ? { x: bx } : {}) };
  else dailyBySym[sym] = { d: null, tvl, w, at: Date.now() };
}

async function getTokenPoolDetail(sym, force) {
  rebuildAddrSym();
  const tok = registry.find(t => t.sym === sym);
  if (!tok || !tok.addr) throw new Error('unknown symbol');
  const al = tok.addr.toLowerCase();
  const c = detailCache[sym];
  // 非强刷: 全局扫描的结果直接秒回 (最长 ~2h15m 旧, 前端有数据时间和实时刷新按钮)
  if (!force && c && c.data && Date.now() - c.at < SWEEP_TTL + 15 * 60 * 1000) return c.data;
  if (c && c.promise) return c.promise;
  const pools = poolState.pools.filter(p => (p.t0 === al || p.t1 === al) && isRealPool(p));
  if (!pools.length) return { sym, updatedAt: Date.now(), pools: [], hidden: 0, note: poolBacklog ? 'scanning' : 'none' };
  const promise = computePoolSet(pools)
    .then(r => {
      const data = packDetail(sym, r.stats.map(s => presentPool(sym, al, s)), r.windowH);
      detailCache[sym] = { at: Date.now(), data };
      noteDaily(sym, data);
      saveDaily();
      return data;
    })
    .catch(e => { delete detailCache[sym]; throw e; });
  detailCache[sym] = { promise };
  return promise;
}

// 把 lastStats 分组/打包进 detailCache + dailyBySym (全量扫描与细采样重算共用)
function publishStats(windowH) {
  const byAddr = {};
  for (const t of registry) if (t.addr) byAddr[t.addr.toLowerCase()] = t.sym;
  const grouped = {};
  for (const s of lastStats) {
    for (const side of new Set([s.t0, s.t1])) {
      const sm = byAddr[side];
      if (!sm) continue;
      (grouped[sm] = grouped[sm] || []).push(presentPool(sm, side, s));
    }
  }
  const now = Date.now();
  for (const t of registry) {
    const data = packDetail(t.sym, grouped[t.sym] || [], windowH);
    detailCache[t.sym] = { at: now, data };
    noteDaily(t.sym, data);
  }
  saveDaily();
  return Object.keys(grouped).length;
}

// 全局日化扫描: 一次算完所有真实池, 填满首页「最高日化」列 + 所有代币的详情缓存
async function globalSweep() {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    rebuildAddrSym();
    const pools = poolState.pools.filter(isRealPool);
    if (!pools.length) return;
    const t0 = Date.now();
    const r = await computePoolSet(pools);
    // 采样入历史 (只有全量扫描的样本才完整, 单代币刷新不入): 25h 环形
    fgHistory.push({ at: r.sampleAt, fg: r.fgNow });
    fgHistory = fgHistory.filter(s => r.sampleAt - s.at < 26 * 3600 * 1000);
    saveFg();
    // 细采样池集跟随本轮结果 (TVL≥$1000 的池才值得高频采)
    fineKeys = new Set(r.stats.filter(s => s.tvl >= 1000).map(s => s.key));
    saveFine();
    lastStats = r.stats;
    sweepAt = Date.now();
    const nTok = publishStats(r.windowH);
    console.log(`[stocktokens] daily sweep done: ${r.stats.length} pools -> ${nTok} tokens in ${((Date.now() - t0) / 1000).toFixed(0)}s, fg window ${r.windowH.toFixed(2)}h, samples ${fgHistory.length}+${fineHistory.length}`);
  })().catch(e => console.error('[stocktokens] sweep failed:', (e.stack || e.message || '').slice(0, 600)))
    .finally(() => { sweeping = null; });
  return sweeping;
}

// 细采样: 常驻定时 (不依赖页面访问), 只采 fineKeys 池的 feeGrowth (纯状态读, 2~4s),
// 采完用上次全量扫描的池上下文零 RPC 重算全部窗口日化并重新发布
let fineSampling = null;
async function fineSample() {
  if (fineSampling || sweeping || !fineKeys.size) return;
  fineSampling = (async () => {
    if (!rhProvider) rhProvider = new ethers.JsonRpcProvider(RH_RPC, undefined, { staticNetwork: true });
    await ensureRegistry();
    rebuildAddrSym();
    const pools = poolState.pools.filter(p => isRealPool(p) && fineKeys.has(p.v === 4 ? p.id : p.pa));
    if (!pools.length) return;
    const idx = buildSampleIndex(Date.now());   // 基准索引先建 (天然排除本轮新样本)
    const fg = await stage('finefg', () => sampleFeeGrowth(pools));
    const at = Date.now();
    fineHistory.push({ at, fg });
    fineHistory = fineHistory.filter(s => at - s.at < FINE_KEEP);
    saveFine();
    if (lastStats) {
      let n = 0;
      for (const s of lastStats) if (fg[s.key]) { computeWins(s, fg[s.key], at, idx.samples, idx.bestByWin); n++; }
      const wh = idx.bestByWin[1440] ? (at - idx.bestByWin[1440].at) / 3600000 : 0;
      publishStats(wh);
      console.log(`[stocktokens] fine sample: ${pools.length} pools sampled, ${n} recomputed, fine ring ${fineHistory.length}`);
    }
  })().catch(e => console.error('[stocktokens] fine sample failed:', e.message))
    .finally(() => { fineSampling = null; });
  return fineSampling;
}

// --- 刷新 -------------------------------------------------------------------
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const now = Date.now();
    let touched = false;
    // ① Nasdaq 全量 (个股)
    try {
      const by = await fetchNasdaq();
      const leftovers = [];
      for (const t of registry) {
        const q = by[t.sym];
        if (q && q.price > 0) { quotes[t.sym] = { ...q, src: 'nasdaq', at: now }; touched = true; }
        else leftovers.push(t.sym);
      }
      cboeSyms = leftovers;
      lastErr = '';
    } catch (e) {
      lastErr = 'nasdaq: ' + e.message;
      console.error('[stocktokens] nasdaq failed:', e.message);
    }
    // ② Cboe 补漏 (ETF + 特例), 顺序 + 节流, 429 即止
    if (Date.now() > cboeUntil) {
      for (const sym of cboeSyms) {
        try {
          const q = await fetchCboe(sym);
          if (q) { quotes[sym] = { ...q, src: 'cboe', at: Date.now() }; touched = true; }
        } catch (e) {
          if (e.status === 429) {
            cboeUntil = Date.now() + CBOE_COOLDOWN;
            console.error('[stocktokens] cboe 429, cooldown 5min');
            break;
          }
        }
        await sleep(CBOE_GAP);
      }
    }
    if (touched) { quotesAt = Date.now(); saveCache(); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function buildPayload() {
  const addrSym = { ...KNOWN_ADDR };
  for (const t of registry) if (t.addr) addrSym[t.addr.toLowerCase()] = t.sym;
  // 「真实池」三重过滤 (RH 链 spam 池泛滥, bot 车队给官方代币开了几万个垃圾池且都带流动性):
  //   ① 当前流动性 > 0  ② 对手币白名单 = USDG/WETH/ETH/其他官方代币 (垃圾池对手是 wtXXX 山寨币)
  //   ③ 费率 ≤10% 或动态费 (88%/90% 的 griefing 池排除; 真实股票池有 5% 费率惯例, 阈值别收太紧)
  const poolsBy = {};
  for (const p of poolState.pools) {
    if (p.liq !== 1) continue;
    if (!(p.t0 in addrSym) || !(p.t1 in addrSym)) continue;
    if (!(p.v === 4 && (p.fee & 0x800000)) && p.fee > 100000) continue;
    (poolsBy[p.t0] = poolsBy[p.t0] || []).push(p);
    (poolsBy[p.t1] = poolsBy[p.t1] || []).push(p);
  }

  const tokens = registry.map(t => {
    const q = quotes[t.sym];
    const al = (t.addr || '').toLowerCase();
    const pls = (al && poolsBy[al]) || [];
    const dy = dailyBySym[t.sym];
    const poolInfo = pls.slice(0, 8).map(p => {
      const other = p.t0 === al ? p.t1 : p.t0;
      const os = addrSym[other] || other.slice(0, 6) + '…';
      const feeLabel = p.v === 4 && (p.fee & 0x800000) ? '动态费' : (p.fee / 10000) + '%';
      return `V${p.v} ${os} ${feeLabel}`;
    }).join(' · ') + (pls.length > 8 ? ` 等共${pls.length}池` : '');
    return {
      sym: t.sym, name: t.name, addr: t.addr, logo: t.logo,
      price: q ? q.price : 0,
      chgPct: q ? q.chgPct : 0,
      volume: q ? q.volume : 0,
      turnover: q ? q.price * q.volume : 0,
      marketCap: q ? q.marketCap : 0,
      sector: q ? q.sector : '',
      src: q ? q.src : null,
      quoteAt: q ? q.at : 0,
      poolCount: pls.length,
      poolInfo,
      day: dy && dy.d != null ? dy.d : null,        // 全部池 (TVL≥1000) 中最高的池日化 (24h 主口径)
      dayPool: (dy && dy.pool) || '',
      dayMain: dy && dy.m != null ? dy.m : null,     // 该池的主力区间日化
      dayX: dy && dy.x ? dy.x : undefined,           // 该池 24h 窗口被伪尖峰护栏剔除的采样段数
      dayW: dy && dy.w && Object.keys(dy.w).length ? dy.w : undefined,   // 各窗口最高日化 {分钟:{d,m,h,pool,x}}
      rhTvl: dy && dy.tvl != null ? dy.tvl : null,   // 该代币 RH 链真实池 (TVL≥1000) TVL 合计
    };
  }).sort((a, b) => b.turnover - a.turnover);
  const quoted = tokens.filter(t => t.src).length;
  const withPools = tokens.filter(t => t.poolCount > 0).length;
  return {
    updatedAt: quotesAt,
    poolsScanned: poolState.last4 > 0,
    dailyAt: sweepAt || undefined,
    counts: { total: tokens.length, quoted, withPools },
    lastErr: lastErr || undefined,
    tokens,
  };
}

function mountStockTokens(app) {
  app.get('/api/stocktokens/pools', async (req, res) => {
    try {
      await ensureRegistry();
      const sym = String(req.query.sym || '').toUpperCase();
      const force = req.query.force === '1' || req.query.force === 'true';
      res.json(await getTokenPoolDetail(sym, force));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/api/stocktokens', async (req, res) => {
    try {
      await ensureRegistry();
      const force = req.query.refresh === 'true';   // 与主 API 同约定: 必须 =true
      if (force || !quotesAt) await refresh();
      else if (Date.now() - quotesAt > QUOTE_TTL) refresh();  // 后台异步踢, 本次返回现有缓存
      if (!poolScanning && (poolBacklog || Date.now() - poolScanAt > POOL_TTL)) { poolScanAt = Date.now(); scanPools(); }  // 池子扫描后台增量, 有积压立即续
      // 全局日化扫描: 池库就绪后周期跑 (feeGrowth 采样历史不足两份时加密到 8min 尽快出数)
      const sweepTtl = fgHistory.length < 2 ? 8 * 60 * 1000 : SWEEP_TTL;
      if (!sweeping && !poolBacklog && Date.now() - sweepAt > sweepTtl && Date.now() - sweepTryAt > 6 * 60 * 1000) {
        sweepTryAt = Date.now();
        globalSweep();
      }
      res.json(buildPayload());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // 短窗细采样常驻定时: 采样必须连续积累才有短窗历史 (计算/发布零 RPC, 采样 2~4s/轮)
  setInterval(() => { fineSample(); }, FINE_TTL);
}

module.exports = { mountStockTokens };
