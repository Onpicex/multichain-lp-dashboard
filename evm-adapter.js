// =============================================================
// EVM 多链适配器: Ethereum 主网 + Robinhood Chain (chainId 4663) + Base (chainId 8453)
// 模式与 sol-adapter 一致: 独立模块, 输出与 /api/positions 同构 JSON
// 挂载: /api/eth/*  /api/rh/*  /api/base/*
// 钱包列表与 BSC 共享 wallets.json (同一批 0x 地址跨链通用)
// =============================================================
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const ledger = require('./pnl-ledger');
const flows = require('./flows');     // 充提记录 / 净入金 (Ankr 链 base/eth; rh 用本文件的 Transfer 日志回溯, 注入形状同一套)   // 钱包盈亏账本 (rh/arc 纯日志重建: 真实成本/已提回/已领费/历史仓位)

// --- 链配置(合约地址均已链上验证 2026-07-31) ---
const EVM_CHAINS = {
  eth: {
    name: 'Ethereum',
    rpc: process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com',
    v3: {
      npm: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',      // factory() -> 0x1F98431c...
      factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    },
    v4: {
      pm: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e',       // poolManager() -> 0x...4444c
      stateView: '0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227',
      poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    },
    // The Graph 官方子图 (与 lp-radar 同款 id)
    v3SubgraphId: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
    v4SubgraphId: 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G',
    blockscout: 'https://eth.blockscout.com',                  // V4 枚举 fallback
    stables: {
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
      '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    },
    wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    nativeSymbol: 'ETH',
    nativePriceId: 'ethereum',            // coingecko simple/price id
    coingeckoPlatform: 'ethereum',        // coingecko token_price 平台名
    entryFromSubgraph: true,              // 建仓价值: 走子图 Mint/Burn/ModifyLiquidity.amountUSD (公共 RPC 封 getLogs, 后台异步补)
    ledgerFromAnkr: 'eth',                // 钱包盈亏账本: 数据源 Ankr Advanced API (需 .env ANKR_KEY; 公共 RPC 封 getLogs 扫不了钱包流水)
  },
  base: {
    name: 'Base',
    rpc: process.env.BASE_RPC || 'https://base-rpc.publicnode.com',
    v3: {
      npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',      // factory() -> 0x33128a8f... 已链上验证 2026-08-24
      factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    },
    v4: {
      pm: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',       // poolManager() -> 0x498581fF 已链上验证
      stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
      poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    },
    // V3 官方子图已验证 (factories.id 匹配); V4 用注册表搜到的活跃部署 5f2npK...
    // (poolManager 匹配 0x498581f + schema 同官方 + 同步到头, 2026-08-24 验证;
    //  首选 2L6yxq... 无索引节点; blockscout token-transfers 端点会整体 500 不可依赖)
    v3SubgraphId: '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG',
    v4SubgraphId: '5f2npKL2a8oC6thaahyGW5NhJPAtDyMRnQHVmaNSJZ6o',
    blockscout: 'https://base.blockscout.com',
    stables: {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
      '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'USDbC',
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'DAI',
      '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': 'USDT',
    },
    wrappedNative: '0x4200000000000000000000000000000000000006', // WETH (Base)
    nativeSymbol: 'ETH',
    nativePriceId: 'ethereum',
    coingeckoPlatform: 'base',
    entryFromSubgraph: true,              // 建仓价值 V3: 走子图 amountUSD (V3 官方子图健康)
    entryV4FromLogs: true,               // 建仓价值 V4: 子图唯一索引器 0xf92f430d 对 filter 查询常 BadResponse,
                                          //   改走链上 ModifyLiquidity 事件重放 (mainnet.base.org 支持 getLogs+archive getSlot0)
    entryRpc: 'https://mainnet.base.org', // 建仓回溯专用: getLogs 10k 块/段 + 历史 getSlot0 (publicnode 封 getLogs)
    ledgerFromAnkr: 'base',               // 钱包盈亏账本: 数据源 Ankr Advanced API (base.org >2000 块 413, 扫不了钱包流水)
  },
  rh: {
    name: 'Robinhood Chain',
    rpc: process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com',
    v3: {
      npm: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',      // factory() -> 官方 0x1f7d7550
      factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
    },
    v4: {
      pm: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',       // poolManager() -> 0x8366a39C, 62万笔tx
      stateView: '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b',
      poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
      deployBlock: 9073,   // PM 部署块 (blockscout creation tx), Transfer 日志枚举的扫描起点
    },
    // RH 无子图, V4 枚举 + 创建时间全靠 blockscout
    v3SubgraphId: null,
    v4SubgraphId: null,
    blockscout: 'https://robinhoodchain.blockscout.com',
    stables: {
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',   // Paxos Global Dollar, 链上主稳定币
    },
    wrappedNative: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH (RH)
    nativeSymbol: 'ETH',
    nativePriceId: 'ethereum',
    coingeckoPlatform: null,              // coingecko 不收录 RH 链, 全靠池内价 + native 价
    entryFromLogs: true,                  // 建仓价值: 无子图, 从链上事件回溯 (详情面板显示差价)
    fundingFromLogs: true,                // 初始资金(净入金): 全链 Transfer 回溯 (仅 rh; rh RPC 无 trace, 原生 ETH 直转不可见)
    ledgerFromLogs: true,                 // 钱包盈亏账本 (pnl-ledger.js): 全链 Transfer + 仓位事件重放真实成本/历史仓位
    noBatch: true,                        // rh RPC 对 JSON-RPC batch 悬死 (2026-09-06), 单请求正常
  },
  // --- Arc (Circle 稳定币 L1, chainId 5042): 2026-09-19 切活 (主网 09-16 公开) ---
  // tools/arc-check.js 2026-09-19 全绿: chainId 5042、7 个合约字节码、NPM.factory()/PositionManager.poolManager()
  //   互指、PoolManager 部署块 1948056 (2026-05-27, 首个 V4 仓 mint 在 1954872 同日 —— 链在公开前已跑了 3 个多月)。
  // 【RPC 限制】官方 rpc.mainnet.arc.io: getLogs 单段 ≤ 9999 块 (10000 即 "requested range too large"),
  //   单次 ≤ 2000 条; **限速** (2026-09-19 实测: 9999 块窗 2 并行连发 30 窗只成 3 个, -32005 rate limit exceeded;
  //   串行 + 250ms 间隔 30/30 成功, 但每次 getLogs ~2s); batch 正常; archive eth_call 至少能回溯 47 万块。
  //   → logChunk: 9999 让所有分段扫描按它走 (其余链仍 5M), logGapMs: 250 串行限速节奏;
  //     V4 枚举加持久化游标 (v4ids-cache-arc.json), 每 100 窗落盘, 增量只扫新块。
  // 【枚举起点 = 主网公开上线块, 不是 PoolManager 部署块】PoolManager 2026-05-27 就部署了 (块 1948056), 但链在
  //   09-16 才对公众开放; 按 2s/窗 从部署块扫全史 = 1970 万块 ≈ 2000 窗 × 2 请求 × 2s ≈ 2 小时/钱包, 不可行。
  //   公开前只有 Circle/合作方能用, 用户钱包不可能有更早的仓位, 所以从 09-16 00:00 UTC 的块起扫 (60 窗 ≈ 4 分钟/钱包首扫)。
  //   若某钱包确有更早仓位: 把 deployBlock 改回 1948056 并删掉它在 v4ids-cache-arc.json 里的游标即可 (会慢)。
  // 【无子图 / 无 blockscout】The Graph 上 arc 无 Uniswap V3 子图, 唯一的 V4 子图落后链头 20h; explorer.arc.io
  //   是否 Blockscout 兼容未验 → 全部走链上日志 (entryFromLogs), blockscout 保持 null。
  arc: {
    name: 'Arc',
    pending: false,                       // 2026-09-19 切活 (arc-check 全绿)
    chainId: 5042,                        // Uniswap sdk-core ChainId.ARC = 5042
    rpc: process.env.ARC_RPC || 'https://rpc.mainnet.arc.io',   // 官方主网 RPC, 服务器 50ms
    logChunk: 9999,                       // getLogs 单段上限 (见上), 分段扫描/倒扫/池价窗口都按它裁
    logGapMs: 250,                        // 分段扫描串行 + 段间间隔 (官方 RPC 限速, 见上)
    fetchStuckMs: 40 * 60 * 1000,         // 看门狗放宽: 首扫 (枚举 60 窗 + 领费扫描 150s 预算) 比 15min 默认长, 别被误判卡死开第二轮
    v3: {
      npm: '0x39654a85a4c05127f5fd6ed22caec077a0fb1377',      // factory() 已链上验证 2026-09-19
      factory: '0xf0db7b58379503491d857db50ac9ece64c653918',   // 链上验证 2026-09-19 (部署块 1948019)
    },
    v4: {
      pm: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',           // poolManager() 已链上验证 2026-09-19
      stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',    // 与 rh 同址, getSlot0/getLiquidity 链上验证 2026-09-19
      poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',  // 与 rh 同址, 链上验证 2026-09-19
      deployBlock: 21068653,  // 主网公开上线 2026-09-16 00:00 UTC 对应块 (见上); PoolManager 真部署块 = 1948056 (arc-check 二分)
    },
    v3SubgraphId: null,                   // Arc 无 The Graph 子图
    v4SubgraphId: null,
    blockscout: null,                     // explorer.arc.io 是否 Blockscout 兼容未验 -> V4 枚举走日志 (有游标, 便宜)
    // Arc 的 gas 代币就是 USDC: 原生 18 位小数, ERC-20 接口预编译 0x3600… 是 6 位小数的同一笔余额。
    // 链上没有 wrapped USDC ("There is no wrapped USDC address on Arc"), 故 wrappedNative 指向该预编译。
    stables: {
      '0x3600000000000000000000000000000000000000': 'USDC',
    },
    wrappedNative: '0x3600000000000000000000000000000000000000',
    nativeSymbol: 'USDC',
    nativePriceId: 'usd-coin',
    nativeIsAliased: true,                // ⚠ 原生币与 wrappedNative 是同一笔钱的两种表示(非 ETH/WETH 那种两笔),
                                          //   闲置余额只认 ERC-20 那笔, 否则同一笔 USDC 会被算两遍
    coingeckoPlatform: null,              // coingecko 尚未收录 Arc
    entryFromLogs: true,                  // 建仓价值: 无子图, 同 rh 走链上事件回溯
    ledgerFromLogs: true,                 // 钱包盈亏账本: 同 rh (小段+限速, 首扫按每轮预算分多轮)
    ledgerSkipNativeScan: true,           // Arc 的原生币是 USDC (V4 池 currency0=0x0 的都算"原生池"), 按池补扫 9999 块窗 × 2s 每轮都超预算,
                                          //   钱包 31 个仓永远算不出来 (2026-09-28); 改为只靠钱包自发交易的回执 (双边操作都带另一侧 ERC20 日志),
                                          //   只动原生 USDC 一侧的单边加/减仓看不到 → 该仓标「提回未捕获」
  },
};

// --- ABIs (与 server.js 同款) ---
const V3_NPM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
];
const V4_PM_ABI = [
  'function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
];
const V4_STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
];
const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const POOL_ABI = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'];
const ERC20_ABI = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const Q128 = 2n ** 128n;

// --- The Graph key 池 (与 server.js 同一批 env key, 独立熔断状态) ---
const GRAPH_KEYS = (process.env.GRAPH_KEYS || '').split(',').filter(Boolean)
  .map(key => ({ key: key.trim(), blockedUntil: 0 }));
let gkIdx = 0;
function pickGraphKey() {
  if (GRAPH_KEYS.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < GRAPH_KEYS.length; i++) {
    const idx = (gkIdx + i) % GRAPH_KEYS.length;
    if (GRAPH_KEYS[idx].blockedUntil <= now) { gkIdx = (idx + 1) % GRAPH_KEYS.length; return GRAPH_KEYS[idx]; }
  }
  return GRAPH_KEYS[0];
}
async function graphQuery(subgraphId, query) {
  const entry = pickGraphKey();
  if (!entry || !subgraphId) return null;
  try {
    const res = await fetch(`https://gateway.thegraph.com/api/${entry.key}/subgraphs/id/${subgraphId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) { entry.blockedUntil = Date.now() + 10 * 60 * 1000; return null; }
    const j = await res.json();
    return j.data || null;
  } catch { return null; }
}
// 2026-09-28 审计修复: 子图 positions 按 id_gt 翻页 (每页 1000, 上限 5 页) —— 之前 first:1000 单页会把 >1000 仓的大户截断;
//   任一页失败返 null 让调用方走兜底 (宁缺毋截断)
async function graphPositionsPaged(subgraphId, whereBody, fields, maxPages = 5) {
  const out = [];
  let lastId = null;
  for (let page = 0; page < maxPages; page++) {
    const where = lastId === null ? whereBody : `${whereBody}, id_gt: "${lastId}"`;
    const data = await graphQuery(subgraphId, `{ positions(first: 1000, orderBy: id, orderDirection: asc, where: { ${where} }) { id ${fields} } }`);
    if (!data?.positions) return null;
    out.push(...data.positions);
    if (data.positions.length < 1000) return out;
    lastId = data.positions[data.positions.length - 1].id;
    if (page === maxPages - 1) console.error(`[graph] positions 翻页达上限 ${maxPages} 页 (${out.length} 条), 更多的不再取`);
  }
  return out;
}

// --- 工具 ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withRetry(fn, retries = 3, delayMs = 800) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) { if (i === retries - 1) throw e; await sleep(delayMs * (i + 1)); }
  }
}
async function batchedAll(items, fn, batchSize = 5) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)));
    if (i + batchSize < items.length) await sleep(250);
  }
  return out;
}
// 2026-09-28 审计修复: 缓存落盘一律 tmp + renameSync 原子替换 —— 直写被中途杀进程/磁盘满会留半截 JSON, 下次启动 JSON.parse 失败整份缓存归零
//   (枚举游标从部署块重扫、建仓缓存全丢); space 仅 wallets 文件用 (保持原来的 2 空格缩进)
function writeJsonAtomic(file, obj, space) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, space), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}
// 2026-09-28 审计修复: 缓存读取 —— 文件不存在按 fallback 起步 (首次启动正常); 解析失败把坏文件改名 .corrupt-<ts> 留证再按 fallback 起步
function readJsonOrEmpty(file, fallback = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try { return JSON.parse(raw); }
  catch (e) {
    const bad = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, bad); } catch {}
    console.error(`[cache] ${path.basename(file)} 解析失败 (${e.message?.slice(0, 60)}), 已改名 ${path.basename(bad)} 留证, 按空数据起步`);
    return fallback;
  }
}
// 2026-09-28 审计修复: 只增不减的进程级/链级字典 (blockTsCache / codeCache) 加简单上限: 超过 max 就删掉最早插入的一半
function capCache(obj, max = 50000) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length >> 1; i++) delete obj[keys[i]];
}
// 2026-09-28 审计修复: created/entry 缓存条目「不在当前持有集且 30 天未访问」即裁掉 (条目 seenAt = 最近访问时间)
const CACHE_KEEP_MS = 30 * 86400000;
// 2026-09-28 审计修复: token symbol 是链上任意字符串 (可含 <script>, XSS 源头), 只放行 [\w.$\-\/+ ]{1,24}, 越界回退「地址前6+…+后4」
const SYMBOL_OK = /^[\w.$\-\/+ ]{1,24}$/;
function sanitizeSymbol(sym, addr) {
  const s = typeof sym === 'string' ? sym.trim() : '';
  if (s && SYMBOL_OK.test(s)) return s;
  const a = String(addr || '');
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// --- Multicall3 聚合读: 把几百个串行 eth_call 合成个位数请求 ---
// 四链同址 (eth/base/rh/bsc 均已 eth_getCode 验证 2026-08-26); 大户钱包上千 NFT 逐个
// 读仓是刷新耗时 3 分钟级的根因, 聚合后实测 1583 个 positions() 2.6s / rh 250 条 300ms
const MC3_ADDR = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MC3_ABI = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'];
async function multicall(chainId, calls, chunkSize = 250) {
  if (calls.length === 0) return [];
  const st = chainState(chainId);
  const mc = new ethers.Contract(MC3_ADDR, MC3_ABI, st.provider);
  const chunks = [];
  for (let i = 0; i < calls.length; i += chunkSize) chunks.push(calls.slice(i, i + chunkSize));
  const chunkResults = await Promise.all(chunks.map(chunk =>
    withRetry(() => mc.aggregate3.staticCall(chunk.map(c => ({
      target: c.contract.target, allowFailure: true,
      callData: c.contract.interface.encodeFunctionData(c.fn, c.args),
    }))))
  ));
  // 与 calls 同序返回; 单条失败(合约 revert/不存在)为 null, 整块 RPC 失败由 withRetry 抛出
  const out = [];
  chunks.forEach((chunk, ci) => chunk.forEach((c, i) => {
    const r = chunkResults[ci][i];
    if (!r.success) { out.push(null); return; }
    try { out.push(c.contract.interface.decodeFunctionResult(c.fn, r.returnData)); }
    catch { out.push(null); }
  }));
  return out;
}
function tickToPrice(tick, d0, d1) { return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1); }
function sqrtPriceX96ToPrice(s, d0, d1) { const p = Number(s) / 2 ** 96; return p * p * Math.pow(10, d0 - d1); }
function getTokenAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper, d0, d1) {
  const liq = Number(liquidity);
  if (liq === 0) return { amount0: 0, amount1: 0 };
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const sl = Math.pow(1.0001, tickLower / 2), su = Math.pow(1.0001, tickUpper / 2);
  let a0 = 0, a1 = 0;
  if (sp <= sl) a0 = liq * (1 / sl - 1 / su);
  else if (sp >= su) a1 = liq * (su - sl);
  else { a0 = liq * (1 / sp - 1 / su); a1 = liq * (sp - sl); }
  return { amount0: a0 / 10 ** d0, amount1: a1 / 10 ** d1 };
}
function feeLabel(fee) {
  const map = { 100: '0.01%', 500: '0.05%', 3000: '0.3%', 10000: '1%' };
  if (Number(fee) === 0x800000) return '动态';  // V4 DYNAMIC_FEE_FLAG, 真实费率由 hook 决定
  return map[Number(fee)] || `${(Number(fee) / 10000).toFixed(2)}%`;
}
function decodePackedPositionInfo(info) {
  const tu = Number((info >> 32n) & 0xffffffn), tl = Number((info >> 8n) & 0xffffffn);
  return {
    tickUpper: tu >= 0x800000 ? tu - 0x1000000 : tu,
    tickLower: tl >= 0x800000 ? tl - 0x1000000 : tl,
  };
}
function computePoolId(poolKey) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]));
}

// --- 每链运行时状态 ---
const state = {}; // chainId -> { provider, tokenCache, cache, createdCache, fetchInFlight }
function chainState(chainId) {
  if (!state[chainId]) {
    const cfg = EVM_CHAINS[chainId];
    const createdFile = path.join(__dirname, `created-cache-${chainId}.json`);
    // 2026-09-28 审计修复: 缓存文件统一 readJsonOrEmpty (坏文件改名留证); createdCache 文件里 __seen 是各条目最近访问时间 (落盘时裁 30 天未访问的)
    const createdCache = readJsonOrEmpty(createdFile) || {};
    const createdSeen = (createdCache.__seen && typeof createdCache.__seen === 'object') ? createdCache.__seen : {};
    delete createdCache.__seen;
    const posFile = path.join(__dirname, `positions-cache-${chainId}.json`);
    let cache = { data: null, timestamp: 0 };
    const saved = readJsonOrEmpty(posFile, null);
    if (saved && saved.data) cache = saved;
    // V4 日志枚举的持久化游标 (见 rpcNftIdsViaTransferLogs)
    const v4ScanFile = path.join(__dirname, `v4ids-cache-${chainId}.json`);
    const v4Scan = readJsonOrEmpty(v4ScanFile) || {};
    state[chainId] = {
      // rh RPC 对 JSON-RPC batch 请求会悬死不响应 (2026-09-06 实测: 单请求 0.2s 正常,
      // batch>=5 挂死) —— 禁用 ethers 层批处理; 聚合本来就靠 Multicall3, HTTP batch 纯多余
      provider: new ethers.JsonRpcProvider(cfg.rpc, undefined, cfg.noBatch ? { batchMaxCount: 1 } : {}),
      tokenCache: {}, cache, createdFile, createdCache, createdSeen, posFile,
      fetchInFlight: null, fetchStartedAt: 0, lastPublishStart: 0, v4IdCache: {},
      v4ScanFile, v4Scan,
      v4Mismatch: {}, v4ScanInFlight: {},   // 2026-09-28 审计修复: 枚举与链上数连续不符计数 / 每钱包扫描 in-flight (同钱包同时只扫一次)
    };
  }
  return state[chainId];
}
// 2026-09-28 审计修复: createdCache 统一落盘入口 —— 原子写 + 裁掉「不在当前持有集且 30 天未访问」的条目 (缺 seenAt 的旧条目视为本次访问);
//   持有集 = positions 缓存里的仓位 (`${合约小写}-${tokenId}`, V3 npm / V4 pm 两种前缀)
function touchCreated(st, key) { st.createdSeen[key] = Date.now(); }
function saveCreatedCache(chainId) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const now = Date.now();
  const keep = new Set();
  for (const w of (st.cache.data?.wallets || [])) for (const p of (w.positions || [])) keep.add(`${(p.protocol === 'V4' ? cfg.v4.pm : cfg.v3.npm).toLowerCase()}-${p.tokenId}`);
  for (const k of Object.keys(st.createdCache)) {
    if (!(st.createdSeen[k] > 0)) st.createdSeen[k] = now;
    else if (!keep.has(k) && now - st.createdSeen[k] > CACHE_KEEP_MS) { delete st.createdCache[k]; delete st.createdSeen[k]; }
  }
  for (const k of Object.keys(st.createdSeen)) if (!(k in st.createdCache)) delete st.createdSeen[k];
  try { writeJsonAtomic(st.createdFile, { ...st.createdCache, __seen: st.createdSeen }); } catch {}
}

// --- 每链独立钱包列表: wallets-eth.json / wallets-rh.json (与 BSC 的 wallets.json 互不相干) ---
function walletsFile(chainId) { return path.join(__dirname, `wallets-${chainId}.json`); }
function loadWallets(chainId) {
  const w = readJsonOrEmpty(walletsFile(chainId), []);   // 2026-09-28 审计修复: 坏文件改名留证 (之前静默当空表, 下一次保存就把坏文件覆盖掉了)
  return Array.isArray(w) ? w : [];
}
function saveWallets(chainId, wallets) {
  writeJsonAtomic(walletsFile(chainId), wallets, 2);   // 2026-09-28 审计修复: 原子写 (保持 2 空格缩进)
}
// 启用中的钱包 (enabled 缺省=启用; false=停用: 不抓仓位/不查余额/不回溯资金, 只保留在钱包列表里)
function isWalletOn(w) { return w.enabled !== false; }
function loadActiveWallets(chainId) { return loadWallets(chainId).filter(isWalletOn); }

// --- token 信息 ---
async function getTokenInfo(chainId, address) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const addr = address.toLowerCase();
  if (addr === ethers.ZeroAddress.toLowerCase()) {
    return { symbol: cfg.nativeSymbol, decimals: 18, address: cfg.wrappedNative };
  }
  const cached = st.tokenCache[addr];
  // 2026-09-28 审计修复: 部分失败 (_fallback) 的条目缓存 60s 再重试 (之前每次调用都重打 RPC)
  if (cached && (!cached._fallback || Date.now() - (cached._ts || 0) < 60000)) return cached;
  // 2026-09-28 审计修复: symbol 与 decimals 分开取 —— symbol() 失败 (bytes32 symbol / 非标合约) 曾连带把 decimals 退成 18 (数量差 10^12);
  //   decimals 拿不到才标 decimalsUnknown; symbol 经 sanitizeSymbol 净化
  const c = new ethers.Contract(address, ERC20_ABI, st.provider);
  const [symRes, decRes] = await Promise.allSettled([c.symbol(), c.decimals()]);
  const info = {
    symbol: sanitizeSymbol(symRes.status === 'fulfilled' ? symRes.value : null, addr),
    decimals: decRes.status === 'fulfilled' ? Number(decRes.value) : 18,
    address,
  };
  if (decRes.status !== 'fulfilled') info.decimalsUnknown = true;
  if (decRes.status !== 'fulfilled' || symRes.status !== 'fulfilled') { info._fallback = true; info._ts = Date.now(); }
  st.tokenCache[addr] = info;
  return info;
}

// --- blockscout: 枚举某地址持有的某 NFT 合约全部 tokenId (V4 PM 非枚举型, RH 无子图时用) ---
async function blockscoutNftIds(chainId, owner, nftContract, expected = 0) {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg.blockscout) return [];
  const ids = [];
  let params = '';
  // /nft 端点是钱包全量 NFT 库存 (不分合约), 大户可达上千个 —— 之前上限 5 页(250 个)
  // 是 rh 链 698 个持仓只枚举到 236 的根因; expected=链上 balanceOf, 集齐即提前收工
  for (let page = 0; page < 40; page++) {
    try {
      const url = `${cfg.blockscout}/api/v2/addresses/${owner}/nft?type=ERC-721${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) break;
      const d = await res.json();
      for (const it of (d.items || [])) {
        const tokAddr = (it.token?.address_hash || it.token?.address || '').toLowerCase();
        if (tokAddr === nftContract.toLowerCase() && it.id != null) ids.push(BigInt(it.id));
      }
      if (expected > 0 && ids.length >= expected) break;
      const np = d.next_page_params;
      if (!np) break;
      params = '&' + Object.entries(np).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      await sleep(150);
    } catch { break; }
  }
  return ids;
}


// --- blockscout 备选: /nft 库存端点对部分合约漏索引 (如 Base 的 V4 PM 元数据不入库),
//     改用 token-transfers 重建当前持仓; 接口按时间倒序, tokenId 首次出现即最新归属 ---
async function blockscoutNftIdsViaTransfers(chainId, owner, nftContract) {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg.blockscout) return [];
  const ownerLc = owner.toLowerCase();
  const latest = new Map();   // tokenId -> 是否仍持有
  const minted = new Map();   // tokenId -> mint 时间戳(ms)
  let params = "";
  for (let page = 0; page < 10; page++) {
    try {
      const url = `${cfg.blockscout}/api/v2/addresses/${owner}/token-transfers?type=ERC-721&token=${nftContract}${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) break;
      const d = await res.json();
      for (const it of (d.items || [])) {
        const id = it.total?.token_id;
        if (id == null) continue;
        const to = (it.to?.hash || "").toLowerCase();
        const from = (it.from?.hash || "").toLowerCase();
        if (!latest.has(id)) latest.set(id, to === ownerLc);
        if (from === ethers.ZeroAddress.toLowerCase() && it.timestamp) minted.set(id, Date.parse(it.timestamp));
      }
      const np = d.next_page_params;
      if (!np) break;
      params = "&" + Object.entries(np).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
    } catch { break; }
  }
  return [...latest.entries()].filter(([, held]) => held)
    .map(([id]) => ({ id: BigInt(id), createdAt: minted.get(id) || 0 }));
}

// --- blockscout: NFT mint 时间 (createdAt), 磁盘缓存永久 ---
async function blockscoutMintTime(chainId, nftContract, tokenId) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = `${nftContract.toLowerCase()}-${tokenId}`;
  if (st.createdCache[key] > 0) { touchCreated(st, key); return st.createdCache[key]; }
  if (!cfg.blockscout) return 0;
  try {
    // 2026-09-28 审计修复: 首页没有 mint (from=0) 就翻页继续找 (上限 3 页), 找不到返回 0 ——
    //   之前拿「首页最后一条」当 mint, 转手多次的仓会把某次二手 Transfer 的时间当建仓时间 (日化分母错)
    let mint = null, params = '';
    for (let page = 0; page < 3 && !mint; page++) {
      const url = `${cfg.blockscout}/api/v2/tokens/${nftContract}/instances/${tokenId}/transfers${params}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return 0;
      const d = await res.json();
      // mint = from 零地址; transfers 接口按时间倒序
      for (const it of (d.items || [])) {
        const from = (it.from?.hash || '').toLowerCase();
        if (from === ethers.ZeroAddress.toLowerCase()) mint = it;
      }
      const np = d.next_page_params;
      if (mint || !np) break;
      params = '?' + Object.entries(np).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      await sleep(150);
    }
    if (!mint) return 0;
    let ts = 0;
    if (mint.timestamp) ts = Date.parse(mint.timestamp);
    else if (mint.block_number) {
      const b = await st.provider.getBlock(Number(mint.block_number));
      if (b) ts = b.timestamp * 1000;
    }
    if (ts > 0) {
      st.createdCache[key] = ts; touchCreated(st, key);
      saveCreatedCache(chainId);   // 2026-09-28 审计修复: 原子写 + 裁旧
    }
    return ts;
  } catch { return 0; }
}

// --- RPC 兜底: 按 tokenId 过滤 Transfer(from=0) 日志找 mint 块拿 createdAt ---
// rh blockscout 2026-08-29 起被 Cloudflare 盾住 (403), blockscoutMintTime 静默拿不到 mint 时间,
// 活跃仓 createdAt=0 → 当前日化/累计日化整列不显示。从链头往回分段扫: 活跃仓多为近期新开,
// 通常首段即命中; 结果与 blockscout 共用 createdCache 永久缓存, 每 token 只扫一次
async function rpcMintTime(chainId, nftContract, tokenId) {
  const st = chainState(chainId);
  const key = `${nftContract.toLowerCase()}-${tokenId}`;
  if (st.createdCache[key] > 0) { touchCreated(st, key); return st.createdCache[key]; }
  // 枚举游标里已经有 mint 块 → 一次 getBlock 拿时间戳, 不倒扫
  const mbs = mintBlockFromScan(chainId, nftContract, tokenId);
  if (mbs > 0) {
    try {
      const b = await st.provider.getBlock(mbs);
      if (b) { st.createdCache[key] = b.timestamp * 1000; touchCreated(st, key); saveCreatedCache(chainId); return st.createdCache[key]; }   // 2026-09-28 审计修复: 原子写
    } catch {}
  }
  try {
    const T = ethers.id('Transfer(address,address,uint256)');
    const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
    const tid = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
    const latest = await st.provider.getBlockNumber();
    const CHUNK = EVM_CHAINS[chainId].logChunk || 5000000;   // arc: RPC 单段 ≤ 9999 块
    // 小段链 (arc) 不能一路倒扫到创世 (2000+ 窗): 以 V4 枚举起点为地板, 段间按限速间隔
    const floorB = EVM_CHAINS[chainId].logChunk ? (EVM_CHAINS[chainId].v4.deployBlock || 0) : 0;
    const gapMs = EVM_CHAINS[chainId].logGapMs || 0;
    let logs = [];
    for (let to = latest; to >= floorB && logs.length === 0; to -= CHUNK) {
      const from = Math.max(floorB, to - CHUNK + 1);
      if (gapMs && to !== latest) await sleep(gapMs);
      logs = await withRetry(() => st.provider.send('eth_getLogs', [{
        address: nftContract,
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
        topics: [T, zero, null, tid],
      }]));
    }
    if (logs.length === 0) return 0;
    const b = await st.provider.getBlock(parseInt(logs[0].blockNumber, 16));
    if (!b) return 0;
    const ts = b.timestamp * 1000;
    st.createdCache[key] = ts; touchCreated(st, key);
    saveCreatedCache(chainId);   // 2026-09-28 审计修复: 原子写 + 裁旧
    return ts;
  } catch (e) {
    console.error(`  [${chainId}] rpcMintTime 失败 token ${tokenId}:`, e.message?.slice(0, 60));
    return 0;
  }
}

// --- V4 头寸枚举: 链上 Transfer 日志分段扫描 ---
// RH 无子图, blockscout /nft 库存端点对 700+ NFT 大户既翻不完页又被限流 (2026-08-25 实测
// 698 个只枚举到 236); 官方 RPC 全窗一次查会 "log query timed out", 5M 块分段则整链 ~4s 跑完
// 【持久化游标 (2026-09-19, 为 Arc 加)】每钱包记 { scannedTo, held: {tokenId: 0|1} } 到 v4ids-cache-<chain>.json:
//   每次只扫 scannedTo+1 → 链头, 事件按 (块高, logIndex) 顺序叠加到 held 上 (Transfer 的最后一条决定归属),
//   所以增量与全量等价。Arc 若没有它, 每次重启 / 每 6h TTL 到期都要从部署块重扫 1970 万块 (≈2000 窗 × 2 请求)。
//   中途某段失败: 抛错前先把已完成的窗落盘, 下次从那里续; 归属判定只用已扫完的事件, 不会把半截结果当真。
//   rh 同样受益 (重启后零重扫)。
async function rpcNftIdsViaTransferLogs(chainId, owner, nftContract, deployBlock) {
  const st = chainState(chainId);
  // 2026-09-28 审计修复: 同一钱包同时只跑一个扫描 —— 看门狗放弃旧轮后新旧两轮并发, 会同时改同一个 st.v4Scan[key] 游标 (事件乱序叠加 / 游标跳跃)
  st.v4ScanInFlight = st.v4ScanInFlight || {};
  const ifk = owner.toLowerCase();
  // 2026-09-28 审计修复: 复用只限 V4_SCAN_REUSE_MS 内起跑的扫描 —— 旧扫描若卡在悬死的 RPC 上 (看门狗放弃旧轮的典型原因), 无条件复用会让之后每一轮
  //   都挂在同一个永不 settle 的 promise 上; 超时的旧扫描被「接管」: 新扫描从共享游标续扫, 旧扫描下一窗写入前发现自己不再是登记者即中止 (不写 held/游标)
  const prev = st.v4ScanInFlight[ifk];
  if (prev && Date.now() - prev.at < V4_SCAN_REUSE_MS) return prev.p;
  if (prev) console.error(`  [${chainId}] V4 枚举 ${owner.slice(0, 10)}: 上一次扫描已跑 ${((Date.now() - prev.at) / 60000).toFixed(0)}min 未结束, 接管续扫`);
  const tok = {};
  const alive = () => st.v4ScanInFlight[ifk]?.tok === tok;
  const p = rpcNftIdsViaTransferLogsInner(chainId, owner, nftContract, deployBlock, alive);
  st.v4ScanInFlight[ifk] = { p, at: Date.now(), tok };
  p.finally(() => { if (alive()) delete st.v4ScanInFlight[ifk]; }).catch(() => {});
  return p;
}
const V4_SCAN_REUSE_MS = 10 * 60 * 1000;   // 2026-09-28 审计修复: 同钱包扫描复用窗口 (超过即视为悬死, 新一轮接管)
async function rpcNftIdsViaTransferLogsInner(chainId, owner, nftContract, deployBlock, alive = null) {
  const st = chainState(chainId);
  const T = ethers.id('Transfer(address,address,uint256)');
  const wt = ethers.zeroPadValue(owner, 32);
  // 2026-09-28 审计修复: 扫描上限滞后链头 12 块 (滞后确认) —— 扫到最新块时节点视图不一致/短重组会让最后几块的 Transfer 永久漏掉, held 从此错到底
  const latest = (await st.provider.getBlockNumber()) - 12;
  const CHUNK = EVM_CHAINS[chainId].logChunk || 5000000;   // arc: RPC 单段 ≤ 9999 块
  const gap = EVM_CHAINS[chainId].logGapMs || 0;           // arc: 官方 RPC 限速, 串行 + 间隔
  const key = owner.toLowerCase();
  const cur = st.v4Scan[key] && st.v4Scan[key].pm === nftContract.toLowerCase()
    ? st.v4Scan[key]
    : (st.v4Scan[key] = { pm: nftContract.toLowerCase(), scannedTo: deployBlock - 1, held: {}, mint: {} });
  if (!cur.mint) cur.mint = {};
  const ownerTail = owner.slice(2).toLowerCase();
  const ZERO_T = ethers.zeroPadValue(ethers.ZeroAddress, 32).toLowerCase();
  const apply = logs => {
    const evs = logs.map(l => ({ bn: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), from: l.topics[1], to: l.topics[2], id: BigInt(l.topics[3]).toString() }));
    evs.sort((a, b) => a.bn - b.bn || a.li - b.li);
    for (const e of evs) {
      cur.held[e.id] = e.to.slice(26).toLowerCase() === ownerTail ? 1 : 0;
      // mint (from=0x0) 的块顺手记下: rpcMintTime / findMintEvent 就不用再从链头倒扫找它 (小段链上一个仓要 60 窗 × 2s)
      if (String(e.from).toLowerCase() === ZERO_T) cur.mint[e.id] = e.bn;
    }
  };
  let from = Math.max(deployBlock, cur.scannedTo + 1);
  const total = Math.max(0, Math.ceil((latest - from + 1) / CHUNK));
  if (total > 50) console.log(`  [${chainId}] V4 枚举 ${owner.slice(0, 10)}: 从块 ${from} 起 ${total} 窗 (首扫或长期未扫), 每 100 窗落盘一次游标`);
  let n = 0;
  try {
    for (; from <= latest; from += CHUNK) {
      const to = Math.min(from + CHUNK - 1, latest);
      const base = { address: nftContract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
      const fIn = { ...base, topics: [T, null, wt] }, fOut = { ...base, topics: [T, wt, null] };
      let ins, outs;
      if (gap) {
        // 限速链 (arc): 串行 + 间隔, 撞 -32005 退避加长 (1.5s × 次)
        ins = await withRetry(() => st.provider.send('eth_getLogs', [fIn]), 4, 1500); await sleep(gap);
        outs = await withRetry(() => st.provider.send('eth_getLogs', [fOut]), 4, 1500);
      } else {
        [ins, outs] = await Promise.all([
          withRetry(() => st.provider.send('eth_getLogs', [fIn])),
          withRetry(() => st.provider.send('eth_getLogs', [fOut])),
        ]);
      }
      // 2026-09-28 审计修复: 已被新扫描接管 → 中止, 不写 held/游标 (防新旧两路事件叠加、游标来回跳)
      if (alive && !alive()) throw new Error('V4 枚举扫描已被新一轮接管, 旧扫描中止');
      apply([...ins, ...outs]);
      cur.scannedTo = to;
      // 首扫几十上百窗要好几分钟: 每 100 窗落盘一次, 中途重启也能从断点续 (否则 finally 之前什么都没存)
      if (++n % 100 === 0) saveV4Scan(chainId);
      if (gap && from + CHUNK <= latest) await sleep(gap);
    }
  } finally { saveV4Scan(chainId); }   // 成败都把已扫到的游标落盘
  return Object.entries(cur.held).filter(([, h]) => h).map(([id]) => ({ id: BigInt(id), createdAt: 0 }));
}
function saveV4Scan(chainId) {
  const st = chainState(chainId);
  // 2026-09-28 审计修复: 落盘前清掉 held 里数量为 0 的键 (转出/销毁过的 tokenId 只增不减; 事件重放会无条件覆写, 删 0 不影响归属判定), 并改原子写
  for (const cur of Object.values(st.v4Scan || {})) if (cur && cur.held) for (const [id, h] of Object.entries(cur.held)) if (!h) delete cur.held[id];
  try { writeJsonAtomic(st.v4ScanFile, st.v4Scan); } catch (e) { console.error(`  [${chainId}] v4ids-cache 落盘失败:`, e.message?.slice(0, 60)); }
}
// 枚举游标里记过的 mint 块 (任一钱包的扫描看到过该 tokenId 的 mint 即可), 没有返 0
function mintBlockFromScan(chainId, nftContract, tokenId) {
  const st = chainState(chainId);
  const pm = nftContract.toLowerCase(), id = String(tokenId);
  for (const cur of Object.values(st.v4Scan || {})) if (cur && cur.pm === pm && cur.mint && cur.mint[id] > 0) return cur.mint[id];
  return 0;
}

// --- V4 头寸 tokenId 发现: 子图优先, blockscout 兜底 ---
async function getV4PositionIds(chainId, walletAddress) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = walletAddress.toLowerCase();

  // 链上 NFT 数是枚举结果的权威计数 (免费 RPC 单调用), 用它做缓存失效判据:
  // 纯时间 TTL 会让新开仓最长 6h 不可见 (2026-08-25 某钱包新开 2 仓被缓存关在门外的根因)
  let bal = null;
  try {
    const pm721 = new ethers.Contract(cfg.v4.pm,
      ['function balanceOf(address) view returns (uint256)'], st.provider);
    bal = Number(await pm721.balanceOf(walletAddress));
  } catch {}

  const cached = st.v4IdCache[key];
  // 2026-09-28 审计修复: 有持久化游标的链 (rh/arc) 不再拿「bal === cached.ids.length」当可信判据 (转入 1 个同时转出 1 个, 数量不变内容变了),
  //   只要有游标就跑增量扫描 (每轮 1 窗, 很便宜); 枚举缓存只在 RPC 失败时兜底。子图链 (eth/base) 沿用 6h TTL + 计数判据
  const hasCursor = cfg.v4.deployBlock != null && !!(st.v4Scan[key] && st.v4Scan[key].pm === cfg.v4.pm.toLowerCase());
  if (cached && !hasCursor && Date.now() - cached.ts < 6 * 60 * 60 * 1000) {
    // NFT 数没变 → 缓存可信; 变了 (新开仓/转入/销毁) 或 balanceOf 失败 → 分别处理
    if (bal === null || bal === cached.ids.length) return cached.ids;
    console.log(`  [${chainId}] V4 NFT 数变化 ${cached.ids.length} -> ${bal}, 重新枚举 ${walletAddress}`);
  }

  let ids = null;
  if (cfg.v4SubgraphId) {
    // 2026-09-28 审计修复: 按 id_gt 翻页 (每页 1000, 上限 5 页), 之前 first:1000 单页会把大户截断成「枚举不全」
    const rows = await graphPositionsPaged(cfg.v4SubgraphId, `owner: "${key}"`, 'tokenId createdAtTimestamp');
    if (rows) ids = rows.map(p => ({ id: BigInt(p.tokenId), createdAt: Number(p.createdAtTimestamp || 0) * 1000 }));
  }
  if (!ids && cfg.v4.deployBlock != null) {
    // 无子图链 (RH) 主路径: 链上 Transfer 日志分段扫描, 权威且不受第三方索引器限制
    try {
      ids = await rpcNftIdsViaTransferLogs(chainId, walletAddress, cfg.v4.pm, cfg.v4.deployBlock);
    } catch (e) {
      // 2026-09-28 审计修复: 日志扫描失败先用枚举缓存兜底 (rh 的 blockscout 已被 Cloudflare 盾住, arc 没有 blockscout)
      if (cached && cached.ids.length > 0) {
        console.error(`  [${chainId}] V4 日志枚举失败, 用枚举缓存兜底 (${cached.ids.length} 个):`, e.message?.slice(0, 60));
        return cached.ids;
      }
      console.error(`  [${chainId}] V4 日志枚举失败, 退回 blockscout:`, e.message?.slice(0, 60));
    }
  }
  if (!ids) {
    // blockscout 兜底
    const raw = await blockscoutNftIds(chainId, walletAddress, cfg.v4.pm, bal ?? 0);
    if (raw.length > 0) ids = raw.map(id => ({ id, createdAt: 0 }));
    // /nft 库存端点对部分合约漏索引 (Base 的 V4 PM), 用 token-transfers 重建持仓 (含 mint 时间)
    else ids = await blockscoutNftIdsViaTransfers(chainId, walletAddress, cfg.v4.pm);
  }
  // 枚举结果与链上 NFT 数对不上 (子图滞后/blockscout 抽风) → 用现有结果但本轮不缓存, 下轮重试
  // (bal 失败时无从校验, 沿用旧的「枚举到 0 不缓存」保守策略)
  if (bal !== null ? ids.length !== bal : ids.length === 0) {
    console.error(`  [${chainId}] V4 枚举不全: ${walletAddress} 链上 ${bal ?? '?'} 个, 枚举到 ${ids.length}, 本轮不缓存`);
    // 2026-09-28 审计修复: 日志枚举与链上 balanceOf 连续两轮对不上 (按钱包计数) → 游标回退 50 万块重扫 (held/mint 保留: 事件重放幂等,
    //   窗内漏掉的 Transfer 会补回来, 而清空 held 只扫 50 万块会把更早持有的仓全丢掉); 回退后再连续两轮仍不符 → 从部署块清空 held/mint 全量重建
    if (bal !== null && hasCursor) {
      st.v4Mismatch = st.v4Mismatch || {};
      const cnt = (st.v4Mismatch[key] = (st.v4Mismatch[key] || 0) + 1);
      const cur = st.v4Scan[key];
      if (cnt === 2) {
        const back = Math.max(cfg.v4.deployBlock - 1, (cur.scannedTo || 0) - 500000);
        console.error(`  [${chainId}] V4 枚举连续 ${cnt} 轮与链上数不符 (${ids.length}/${bal}), ${walletAddress} 游标 ${cur.scannedTo} -> ${back} 回退重扫`);
        cur.scannedTo = back;
        saveV4Scan(chainId);
      } else if (cnt >= 4 && Date.now() - ((st.v4RebuildAt || {})[key] || 0) >= 24 * 3600e3) {
        // 2026-09-28 审计修复: 全量重建每钱包 24h 最多一次 (进程内计时) —— 持续性不符 (如 arc 钱包持有 deployBlock 之前铸的仓, 日志永远枚举不到)
        //   否则每 4 轮 (~20min) 就从部署块重扫一遍; 被挡住时计数继续累加 (不再触发 50 万块回退), 24h 后再重建一次
        console.error(`  [${chainId}] V4 枚举连续 ${cnt} 轮与链上数不符 (${ids.length}/${bal}), ${walletAddress} 游标回到部署块 ${cfg.v4.deployBlock}, 清空 held/mint 全量重建`);
        cur.scannedTo = cfg.v4.deployBlock - 1; cur.held = {}; cur.mint = {};
        (st.v4RebuildAt = st.v4RebuildAt || {})[key] = Date.now();
        st.v4Mismatch[key] = 0;
        saveV4Scan(chainId);
      }
    }
    // 枚举整体失灵 (0 个): 空列表会把钱包渲染成"无仓位"并覆盖兜底快照 (2026-09-03 某钱包
    // 消失的根因)。bal=null (balanceOf 也失败) 同样无法证明真空仓, 一并按失灵处理:
    // 先用过期的枚举缓存顶上 (仓位明细仍是实时读), 没有缓存就抛错走钱包级快照兜底
    if (ids.length === 0) {
      const stale = st.v4IdCache[key];
      if (stale && stale.ids.length > 0) {
        console.log(`  [${chainId}] V4 枚举失灵, 用过期枚举缓存兜底 (${stale.ids.length} 个)`);
        return stale.ids;
      }
      throw new Error(`V4 枚举失败 0/${bal ?? '?'}`);
    }
    return ids;
  }
  if (st.v4Mismatch) st.v4Mismatch[key] = 0;   // 2026-09-28 审计修复: 对上了就清连续不符计数
  st.v4IdCache[key] = { ids, ts: Date.now() };
  return ids;
}

// --- V3: 子图取创建时间+已领手续费 (ETH); RH 无子图返回空走 blockscout ---
async function getV3SubgraphData(chainId, walletAddress) {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg.v3SubgraphId) return { created: {}, collectedFees: {} };
  // liquidity_gt 只取活跃仓 (消费方只用活跃仓的数据): 之前 first:200 无过滤,
  // 大户 1583 仓会被截断致活跃仓 createdAt 缺失; 两条链子图均已实测支持此过滤
  // 2026-09-28 审计修复: 按 id_gt 翻页 (每页 1000, 上限 5 页), 之前 first:1000 单页会截断
  const rows = await graphPositionsPaged(cfg.v3SubgraphId, `owner: "${walletAddress.toLowerCase()}", liquidity_gt: 0`, 'transaction { timestamp } collectedFeesToken0 collectedFeesToken1');
  const created = {}, collectedFees = {};
  for (const p of (rows || [])) {
    if (p.transaction?.timestamp) created[p.id] = Number(p.transaction.timestamp) * 1000;
    collectedFees[p.id] = {
      token0: parseFloat(p.collectedFeesToken0 || '0'),
      token1: parseFloat(p.collectedFeesToken1 || '0'),
    };
  }
  return { created, collectedFees };
}

// --- V3 未领手续费 ---
async function getUnclaimedFees(npm, tokenId, walletAddress, chainId = '') {
  try {
    const MAX = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const r = await npm.collect.staticCall(
      { tokenId, recipient: walletAddress, amount0Max: MAX, amount1Max: MAX },
      { from: walletAddress });
    return { fees0: r.amount0, fees1: r.amount1 };
  } catch (e) {
    // 2026-09-28 审计修复: 静默归零会让未领费显示 0 而无人知道; 留痕 + 带 failed 标记 (调用方标 feesUnknown)
    console.error(`  [${chainId}] V3 collect.staticCall 失败 token ${tokenId}:`, e.message?.slice(0, 80));
    return { fees0: 0n, fees1: 0n, failed: true };
  }
}

// --- V3 无子图链 (RH): 链上扫 Collect/DecreaseLiquidity 事件 → lastCollectAt + 已领手续费 ---
// RH RPC 支持 fromBlock=0 + topic1=tokenId 过滤, 单仓事件量极小, 开销可忽略
const V3_COLLECT_TOPIC  = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const V3_DECREASE_TOPIC = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
async function getV3CollectData(chainId, tokenId, sinceBlock = 0) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  if (cfg.v3SubgraphId) return null;            // 有子图的链走子图, 不扫链
  st.v3CollectCache = st.v3CollectCache || {};
  const key = tokenId.toString();
  const cached = st.v3CollectCache[key];
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return cached.data;

  // mint 块未知时从 0 全链扫要 20+ 次 getLogs, RPC 紧张期是压垮枚举的帮凶;
  // 等建仓回溯缓存提供 mb 后再扫 (通常一轮内就位), 期间日化按 createdAt 起算无大碍
  if (!sinceBlock) return null;
  const tidTopic = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  try {
    // 事件不早于 mint 块 (sinceBlock 由建仓回溯缓存提供); 全范围单次扫会间歇 -32000, 分段扫
    const base = { address: cfg.v3.npm };
    const collects = await scanLogsChunked(chainId, { ...base, topics: [V3_COLLECT_TOPIC, tidTopic] }, sinceBlock);
    const decreases = await scanLogsChunked(chainId, { ...base, topics: [V3_DECREASE_TOPIC, tidTopic] }, sinceBlock);
    let c0 = 0n, c1 = 0n, d0 = 0n, d1 = 0n, lastBlock = 0;
    for (const lg of collects) {
      // data = recipient(32B) + amount0(32B) + amount1(32B)
      const hex = lg.data.slice(2);
      c0 += BigInt('0x' + hex.slice(64, 128));
      c1 += BigInt('0x' + hex.slice(128, 192));
      const bn = parseInt(lg.blockNumber, 16);
      if (bn > lastBlock) lastBlock = bn;
    }
    for (const lg of decreases) {
      // data = liquidity(32B) + amount0(32B) + amount1(32B)
      const hex = lg.data.slice(2);
      d0 += BigInt('0x' + hex.slice(64, 128));
      d1 += BigInt('0x' + hex.slice(128, 192));
    }
    let lastCollectAt = 0;
    if (lastBlock > 0) {
      const b = await withRetry(() => st.provider.getBlock(lastBlock));
      if (b) lastCollectAt = b.timestamp * 1000;
    }
    // Collect 事件金额 = 手续费 + 减仓提取的本金, 扣掉 DecreaseLiquidity 才是纯手续费
    const f0 = c0 > d0 ? c0 - d0 : 0n;
    const f1 = c1 > d1 ? c1 - d1 : 0n;
    const data = { lastCollectAt, collected0: f0, collected1: f1, dec0: d0, dec1: d1 };
    st.v3CollectCache[key] = { data, ts: Date.now() };
    return data;
  } catch (e) {
    console.error(`  [${chainId}] Collect 事件扫描失败 token ${key}:`, e.message?.slice(0, 100));
    return null;
  }
}

// =============================================================
// 建仓价值回溯 (无子图链, rh): 纯 RPC 从链上事件重建入金时点的美元价值
// - rh RPC 非 archive (历史块状态查询 -10万块即失败, 2026-09-02 实测),
//   历史池价只能取自 Swap 事件自带的 sqrtPriceX96 (V3/V4 事件都带)
// - V3: IncreaseLiquidity 事件直接带 amount0/amount1, 多笔加仓逐笔按当时池价折算求和
// - V4: PoolManager ModifyLiquidity 事件 salt 即 tokenId, 数量由 liquidityDelta+当块池价反推
// - ETH 美元价走 coingecko 历史区间接口 (小时级, 串行队列防限流)
// - 结果进 entry-cache-<chain>.json 永久缓存, 每 token 只回溯一次;
//   「后续加减仓」不进缓存, 每轮用当前 liquidity/Decrease 事件现算
// =============================================================
const V3_INCREASE_TOPIC = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const V4_MODIFY_TOPIC   = ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const V4_SWAP_TOPIC     = ethers.id('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)');
const V3_SWAP_TOPIC     = ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)');
function hexInt(h) { let v = BigInt('0x' + h); if (v >= 1n << 255n) v -= 1n << 256n; return v; }
// 从 32B 十六进制槽解出 int24 (取末 3 字节, 补码): ModifyLiquidity 事件的 tickLower/tickUpper
function hexI24(h) { let v = parseInt(h.slice(-6), 16); if (v >= 0x800000) v -= 0x1000000; return v; }
const GETSLOT0_IFACE = new ethers.Interface(['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);
// 建仓回溯专用 provider (base: mainnet.base.org 支持 getLogs + archive eth_call; 缺省回退主 provider)
function entryProvider(chainId) {
  const st = chainState(chainId);
  if (!st.entryProvider) {
    const url = EVM_CHAINS[chainId].entryRpc;
    st.entryProvider = url ? new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true }) : st.provider;
  }
  return st.entryProvider;
}

function entryState(chainId) {
  const st = chainState(chainId);
  if (!st.entryFile) {
    st.entryFile = path.join(__dirname, `entry-cache-${chainId}.json`);
    st.entryCache = readJsonOrEmpty(st.entryFile) || {};   // 2026-09-28 审计修复: 坏文件改名留证
  }
  return st;
}
// 2026-09-28 审计修复: 原子写 + 落盘时裁掉「不在当前持有集且 30 天未访问」的条目 (seenAt = 最近访问时间, entryPeek 命中时更新; 缺 seenAt 的旧条目视为本次访问)
function saveEntryCache(st) {
  const now = Date.now();
  const keep = new Set();
  for (const w of (st.cache?.data?.wallets || [])) for (const p of (w.positions || [])) keep.add(`${p.protocol === 'V4' ? 'v4' : 'v3'}-${p.tokenId}`);
  for (const [k, v] of Object.entries(st.entryCache)) {
    if (!v || typeof v !== 'object') { delete st.entryCache[k]; continue; }
    if (!(v.seenAt > 0)) v.seenAt = now;
    else if (!keep.has(k) && now - v.seenAt > CACHE_KEEP_MS) delete st.entryCache[k];
  }
  try { writeJsonAtomic(st.entryFile, st.entryCache); } catch {}
}

// coingecko 原生币历史价: 小时桶缓存 **落盘** coin-hist-cache.json (2026-09-28 前只在内存: 每次重启后首轮成百次拉取被免费档限流,
//   失败静默退到「现价」→ 账本成本/提回一轮一个数) + 串行队列 + 429/5xx 按 Retry-After 等待重试; 仍拿不到返回 0 (不缓存, 下轮再试), 失败按分钟聚合打日志
const COIN_HIST_FILE = path.join(__dirname, 'coin-hist-cache.json');
const coinHistCache = new Map();   // `${coinId}:${小时桶}` -> 美元价 (ETH / BNB 等原生币, 供账本与建仓回溯)
try { for (const [k, v] of Object.entries(readJsonOrEmpty(COIN_HIST_FILE) || {})) if (v > 0) coinHistCache.set(k, v); } catch {}   // 2026-09-28 审计修复: 坏文件改名留证
let coinHistSaveTimer = null;
function saveCoinHist() {
  if (coinHistSaveTimer) return;
  coinHistSaveTimer = setTimeout(() => { coinHistSaveTimer = null; try { writeJsonAtomic(COIN_HIST_FILE, Object.fromEntries(coinHistCache)); } catch {} }, 5000);   // 2026-09-28 审计修复: 原子写
}
let cgQueue = Promise.resolve();
const cgFail = { n: 0, at: 0 };
function cgNoteFail(why) {
  cgFail.n++;
  if (Date.now() - cgFail.at > 60000) { cgFail.at = Date.now(); console.error(`[coingecko] 历史价拉取失败 ${cgFail.n} 次 (最近: ${why}); 受影响的账本事件改用链上参考池价或按现价估 (approx), 下轮重试`); cgFail.n = 0; }
}
const cgPending = new Map();   // 2026-09-28 审计修复: `${coinId}:${小时桶}` -> 进行中的 promise (同桶并发请求只发一次)
function coinUsdAtTime(coinId, tsMs) {
  const bucket = Math.floor(tsMs / 3600000);
  const k = b => `${coinId}:${b}`;
  if (coinHistCache.has(k(bucket))) return Promise.resolve(coinHistCache.get(k(bucket)));
  // 2026-09-28 审计修复: 同一小时桶的并发请求复用同一个 promise; 2.5s 节奏只在真正发了网络请求后才加 ——
  //   之前每个排队者 (哪怕排到时缓存已命中) 都占 2.5s, 账本一轮上百个同桶事件把队列拖成几分钟空转
  if (cgPending.has(k(bucket))) return cgPending.get(k(bucket));
  const neighbor = () => { for (const b of [bucket - 1, bucket + 1]) if (coinHistCache.has(k(b))) return coinHistCache.get(k(b)); return 0; };   // 只在拉不到时借邻桶 (先借会让结果随处理顺序变)
  let fetched = false;
  const run = cgQueue.then(async () => {
    if (coinHistCache.has(k(bucket))) return coinHistCache.get(k(bucket));
    fetched = true;
    const from = Math.floor(tsMs / 1000) - 7200, to = Math.floor(tsMs / 1000) + 7200;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`, { signal: AbortSignal.timeout(12000) });
        if (res.status === 429 || res.status >= 500) { const ra = Number(res.headers.get('retry-after')) || 0; await sleep(Math.min(60, ra || (attempt + 1) * 15) * 1000); continue; }
        if (!res.ok) { cgNoteFail('HTTP ' + res.status); return neighbor(); }
        const d = await res.json();
        let best = 0, bd = Infinity;
        for (const [t, p] of (d.prices || [])) { const dd = Math.abs(t - tsMs); if (dd < bd) { bd = dd; best = p; } }
        if (best > 0) { coinHistCache.set(k(bucket), best); saveCoinHist(); return best; }
        cgNoteFail('返回空'); return neighbor();
      } catch (e) { if (attempt === 2) { cgNoteFail(e.name === 'TimeoutError' ? '超时' : (e.message || 'error').slice(0, 40)); return neighbor(); } await sleep(3000); }
    }
    cgNoteFail('429 重试 3 次仍限流'); return neighbor();
  });
  cgPending.set(k(bucket), run);
  run.finally(() => { if (cgPending.get(k(bucket)) === run) cgPending.delete(k(bucket)); }).catch(() => {});
  cgQueue = run.then(() => (fetched ? sleep(2500) : undefined), () => sleep(2500));   // 免费档实测 1.5s 间隔就 429; 缓存命中的排队者不占节奏
  return run;
}
function ethUsdAtTime(tsMs) { return coinUsdAtTime('ethereum', tsMs); }

// 目标块附近最近一笔 Swap 的 sqrtPriceX96 (窗口逐级放大: 忙池首窗即命中, 冷池最远扫 ±250万块)
async function poolPriceNearBlock(chainId, spec, targetBlock) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const latest = await st.provider.getBlockNumber();
  const filt = spec.kind === 'v4'
    ? { address: cfg.v4.poolManager, topics: [V4_SWAP_TOPIC, spec.poolId] }
    : { address: spec.poolAddress, topics: [V3_SWAP_TOPIC] };
  // arc 那种单段 ≤ 9999 块的 RPC: 窗口只到 ±4900, 再大就是必失败的请求
  const windows = cfg.logChunk
    ? [[300, 50], [2000, 2000], [4900, 4900]]
    : [[300, 50], [2000, 2000], [20000, 20000], [150000, 150000], [900000, 900000], [2500000, 2500000]];
  for (const [back, fwd] of windows) {
    const from = Math.max(0, targetBlock - back), to = Math.min(latest, targetBlock + fwd);
    let logs;
    try {
      logs = await withRetry(() => st.provider.send('eth_getLogs', [{
        ...filt, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      }]), 2, 600);
    } catch { continue; }
    if (!logs || logs.length === 0) continue;
    let best = null, bd = Infinity;
    for (const l of logs) {
      const d = Math.abs(parseInt(l.blockNumber, 16) - targetBlock);
      if (d < bd) { bd = d; best = l; }
    }
    // V3/V4 Swap data 布局第 3 槽都是 sqrtPriceX96
    return BigInt('0x' + best.data.slice(2 + 128, 2 + 192));
  }
  return null;
}

// 分段 getLogs: rh RPC 对全范围/大窗口扫描会间歇性 -32000/超时 (2026-09-03 实测),
// 一律分段扫+段间小憩; 任一段重试后仍失败则抛出, 由调用方按「本轮拿不到」处理
async function scanLogsChunked(chainId, baseFilter, fromBlock, chunk = 5000000, toBlock = null) {
  const st = chainState(chainId);
  chunk = Math.min(chunk, EVM_CHAINS[chainId].logChunk || Infinity);   // arc: 单段 ≤ 9999
  const latest = toBlock != null ? toBlock : await st.provider.getBlockNumber();
  const all = [];
  for (let f = fromBlock; f <= latest; f += chunk) {
    const to = Math.min(f + chunk - 1, latest);
    const logs = await withRetry(() => st.provider.send('eth_getLogs', [{
      ...baseFilter, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16),
    }]), 3, 1000);
    all.push(...logs);
    if (f + chunk <= latest) await sleep(EVM_CHAINS[chainId].logGapMs || 120);
  }
  return all;
}

// NFT mint 事件: 块高+时间戳 (从链头倒扫, 与 rpcMintTime 同套路; 顺手喂 createdCache)
async function findMintEvent(chainId, nftContract, tokenId) {
  const st = chainState(chainId);
  {
    // 枚举游标里已经有 mint 块 → 直接取块时间戳 (同 rpcMintTime)
    const mbs = mintBlockFromScan(chainId, nftContract, tokenId);
    if (mbs > 0) {
      try {
        const b = await st.provider.getBlock(mbs);
        if (b) {
          const k = `${nftContract.toLowerCase()}-${tokenId}`;
          if (!(st.createdCache[k] > 0)) { st.createdCache[k] = b.timestamp * 1000; touchCreated(st, k); saveCreatedCache(chainId); }   // 2026-09-28 审计修复: 原子写
          return { block: mbs, ts: b.timestamp * 1000 };
        }
      } catch {}
    }
  }
  const T = ethers.id('Transfer(address,address,uint256)');
  const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const tid = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const latest = await st.provider.getBlockNumber();
  const CHUNK = EVM_CHAINS[chainId].logChunk || 5000000;   // arc: RPC 单段 ≤ 9999 块
  const floorB = EVM_CHAINS[chainId].logChunk ? (EVM_CHAINS[chainId].v4.deployBlock || 0) : 0;   // 同 rpcMintTime: 不倒扫到创世
  const gapMs = EVM_CHAINS[chainId].logGapMs || 0;
  let logs = [];
  for (let to = latest; to >= floorB && logs.length === 0; to -= CHUNK) {
    const from = Math.max(floorB, to - CHUNK + 1);
    if (gapMs && to !== latest) await sleep(gapMs);
    logs = await withRetry(() => st.provider.send('eth_getLogs', [{
      address: nftContract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      topics: [T, zero, null, tid],
    }]));
  }
  if (logs.length === 0) return null;
  const block = parseInt(logs[0].blockNumber, 16);
  const b = await st.provider.getBlock(block);
  if (!b) return null;
  const key = `${nftContract.toLowerCase()}-${tokenId}`;
  if (!(st.createdCache[key] > 0)) {
    st.createdCache[key] = b.timestamp * 1000; touchCreated(st, key);
    saveCreatedCache(chainId);   // 2026-09-28 审计修复: 原子写 + 裁旧
  }
  return { block, ts: b.timestamp * 1000 };
}

// 两侧 token 的建仓时点美元单价 (poolPriceNum = token0 以 token1 计价的人类单位价); 定不了价返 null 宁缺毋滥
async function entryTokenPrices(cfg, t0, t1, poolPriceNum, entryTs) {
  const a0 = t0.address.toLowerCase(), a1 = t1.address.toLowerCase();
  const s0 = !!cfg.stables[a0], s1 = !!cfg.stables[a1];
  if (s0 && s1) return { p0: 1, p1: 1 };
  if (!(poolPriceNum > 0)) return null;
  if (s1) return { p0: poolPriceNum, p1: 1 };
  if (s0) return { p0: 1, p1: 1 / poolPriceNum };
  const wn = cfg.wrappedNative.toLowerCase();
  if (a0 === wn || a1 === wn) {
    const eth = await coinUsdAtTime(cfg.nativePriceId || 'ethereum', entryTs);   // 原生币: rh/eth/base=ETH, bsc=BNB
    if (!(eth > 0)) return null;
    return a0 === wn ? { p0: eth, p1: eth / poolPriceNum } : { p0: poolPriceNum * eth, p1: eth };
  }
  return null;
}

// 某块的池 sqrtPrice + 两侧 token 美元单价 (带 per-调用 dedupe map: 同块多事件只查一次)
async function entryPricesAtBlock(chainId, spec, t0, t1, bn, memo) {
  if (memo.has(bn)) return memo.get(bn);
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  let out = null;
  const sqrt = await poolPriceNearBlock(chainId, spec, bn);
  if (sqrt !== null) {
    const b = await withRetry(() => st.provider.getBlock(bn));
    if (b) {
      const p = await entryTokenPrices(cfg, t0, t1,
        sqrtPriceX96ToPrice(sqrt, t0.decimals, t1.decimals), b.timestamp * 1000);
      if (p) out = { ...p, ts: b.timestamp * 1000, sqrt };
    }
  }
  memo.set(bn, out);
  return out;
}

// 缓存结构 { u: 累计入金USD, w: 累计提取本金USD, ts: 首笔入场时间, n: 加仓笔数,
//            liq: 按事件累计的净 liquidity, b: 已扫至块高, mod: 数据不全标记 }
// liquidity 与缓存一致 → 直接命中; 不一致 (加/减仓了) → V3 全量重算, V4 从 b+1 增量补扫

// V3 建仓回溯: Increase/DecreaseLiquidity 事件按 tokenId 索引可全量秒查, 逐笔按当时池价折算
// (机器人高频仓超 24 笔事件只按首笔计+mod 标记, 避免逐笔定价扫过量日志)
async function getV3EntryData(chainId, tokenId, poolAddress, t0, t1, currentLiq) {
  const st = entryState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = `v3-${tokenId}`;
  const cached = st.entryCache[key];
  if (cached && cached.liq === currentLiq.toString() && cached.am) return cached;
  try {
    // 事件不会早于 mint 块, 从 mint 块起分段扫 (mint 块永久缓存在 mb, 重算不再倒扫)
    const mint = cached && cached.mb
      ? { block: cached.mb }
      : await findMintEvent(chainId, cfg.v3.npm, tokenId.toString());
    if (!mint) return null;
    // 2026-09-28 审计修复: 找到 mint 块立即落 { mb } (其余字段留空, 后续定价成功再整体覆盖) —— 之前定价失败就什么都不存,
    //   getV3CollectData 拿不到 sinceBlock 永远不扫 Collect 事件, 领费时间/已领费一直缺
    if (!(cached && cached.mb)) { st.entryCache[key] = { ...(cached || {}), mb: mint.block }; saveEntryCache(st); }
    const tidTopic = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
    const incs = await scanLogsChunked(chainId, { address: cfg.v3.npm, topics: [V3_INCREASE_TOPIC, tidTopic] }, mint.block);
    const decs = await scanLogsChunked(chainId, { address: cfg.v3.npm, topics: [V3_DECREASE_TOPIC, tidTopic] }, mint.block);
    if (!incs || incs.length === 0) return null;
    // data 布局相同: liquidity(32B) + amount0(32B) + amount1(32B)
    const evs = [];
    for (const lg of incs) evs.push({ lg, sign: 1 });
    for (const lg of (decs || [])) evs.push({ lg, sign: -1 });
    evs.sort((a, b) => parseInt(a.lg.blockNumber, 16) - parseInt(b.lg.blockNumber, 16)
      || parseInt(a.lg.logIndex, 16) - parseInt(b.lg.logIndex, 16));

    const memo = new Map();
    const spec = { kind: 'v3', poolAddress };
    const capped = evs.length > 24;
    const use = capped ? [evs.find(e => e.sign === 1)] : evs;
    let u = 0, w = 0, n = 0, liq = 0n, ts = 0, n0 = 0, n1 = 0;
    for (const ev of use) {
      const hex = ev.lg.data.slice(2);
      const dl = BigInt('0x' + hex.slice(0, 64));
      const amt0 = Number(BigInt('0x' + hex.slice(64, 128))) / 10 ** t0.decimals;
      const amt1 = Number(BigInt('0x' + hex.slice(128, 192))) / 10 ** t1.decimals;
      const bn = parseInt(ev.lg.blockNumber, 16);
      const prices = await entryPricesAtBlock(chainId, spec, t0, t1, bn, memo);
      if (!prices) return null;
      const v = amt0 * prices.p0 + amt1 * prices.p1;
      if (ev.sign > 0) { u += v; n++; liq += dl; n0 += amt0; n1 += amt1; if (!ts) ts = prices.ts; }
      else { w += v; liq -= dl; n0 -= amt0; n1 -= amt1; }
    }
    // am = 净存入数量 (按 token 地址): 前端「无常损失」= 头寸现值 − 这些数量按现价持有不动的价值
    const am = { [t0.address.toLowerCase()]: n0, [t1.address.toLowerCase()]: n1 };
    // capped 时无法对账, 冻结在当前 liquidity 上避免每轮重扫; 正常路径事件应与链上现值对平
    const data = capped
      ? { u, w: 0, ts, n, liq: currentLiq.toString(), b: 0, mb: mint.block, mod: true, am }
      : { u, w, ts, n, liq: liq.toString(), b: 0, mb: mint.block, mod: liq !== BigInt(currentLiq), am };
    st.entryCache[key] = data;
    saveEntryCache(st);
    return data;
  } catch (e) {
    console.error(`  [${chainId}] V3 建仓回溯失败 token ${tokenId}:`, e.message?.slice(0, 80));
    return null;
  }
}

// V4 建仓回溯: PoolManager ModifyLiquidity 无 tokenId 索引, 按 poolId+sender=PM 过滤后用
// data 里的 salt(=tokenId) 匹配; 首扫从 mint 块起, 之后 liquidity 变了才从 b+1 增量补扫
async function getV4EntryData(chainId, tokenId, poolId, tickLower, tickUpper, t0, t1, currentLiq) {
  const st = entryState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = `v4-${tokenId}`;
  const cached = st.entryCache[key];
  if (cached && cached.liq === currentLiq.toString() && cached.am) return cached;
  try {
    let u = 0, w = 0, n = 0, liq = 0n, ts = 0, fromBlock, n0 = 0, n1 = 0;
    const a0k = t0.address.toLowerCase(), a1k = t1.address.toLowerCase();
    if (cached && cached.b > 0 && cached.am) {
      ({ u, w, n, ts } = cached); liq = BigInt(cached.liq); fromBlock = cached.b + 1;
      n0 = cached.am[a0k] || 0; n1 = cached.am[a1k] || 0;
    } else {
      // 无缓存 / 旧缓存缺 am (净存入数量): 从 mint 块全量重放
      const mint = await findMintEvent(chainId, cfg.v4.pm, tokenId.toString());
      if (!mint) return null;
      ts = mint.ts; fromBlock = mint.block;
    }
    const latest = await st.provider.getBlockNumber();
    const saltHex = BigInt(tokenId).toString(16).padStart(64, '0');
    const logs = await scanLogsChunked(chainId, {
      address: cfg.v4.poolManager,
      topics: [V4_MODIFY_TOPIC, poolId, ethers.zeroPadValue(cfg.v4.pm, 32)],
    }, fromBlock, 1000000, latest);
    // data 布局: tickLower(32B) tickUpper(32B) liquidityDelta(32B,有符号) salt(32B)
    const evs = [];
    for (const lg of logs) {
      const hex = lg.data.slice(2);
      if (hex.slice(192, 256) !== saltHex) continue;
      evs.push({ bn: parseInt(lg.blockNumber, 16), delta: hexInt(hex.slice(128, 192)) });
    }
    if (!(cached && cached.am) && !evs.some(e => e.delta > 0n)) return null;
    const memo = new Map();
    const spec = { kind: 'v4', poolId };
    // cap=事件超量只算首笔 (永久); 对账不平的 mod 每次重算, 不从缓存继承 (竞态是暂时的)
    let cap = !!(cached && cached.cap);
    if (evs.length > 30) {
      // 高频机器人仓: 只按首笔正向事件计, 冻结避免每轮重扫
      const firstAdd = evs.find(e => e.delta > 0n);
      if (firstAdd) {
        const prices = await entryPricesAtBlock(chainId, spec, t0, t1, firstAdd.bn, memo);
        if (!prices) return null;
        const { amount0, amount1 } = getTokenAmounts(firstAdd.delta, prices.sqrt, tickLower, tickUpper, t0.decimals, t1.decimals);
        u += amount0 * prices.p0 + amount1 * prices.p1; n++; n0 += amount0; n1 += amount1;
      }
      const data = { u, w: 0, ts, n, liq: currentLiq.toString(), b: latest, mod: true, cap: true, am: { [a0k]: n0, [a1k]: n1 } };
      st.entryCache[key] = data; saveEntryCache(st);
      return data;
    }
    for (const ev of evs.sort((a, b) => a.bn - b.bn)) {
      const prices = await entryPricesAtBlock(chainId, spec, t0, t1, ev.bn, memo);
      if (!prices) return null;
      const mag = ev.delta > 0n ? ev.delta : -ev.delta;
      const { amount0, amount1 } = getTokenAmounts(mag, prices.sqrt, tickLower, tickUpper, t0.decimals, t1.decimals);
      const v = amount0 * prices.p0 + amount1 * prices.p1;
      if (ev.delta > 0n) { u += v; n++; liq += ev.delta; n0 += amount0; n1 += amount1; if (!ts) ts = prices.ts; }
      else { w += v; liq += ev.delta; n0 -= amount0; n1 -= amount1; }
    }
    // 事件累计与链上现值不平 (取数时点竞态/漏事件) → 标记但不强行冻结, 下轮增量再对
    const data = { u, w, ts, n, liq: liq.toString(), b: latest, mod: cap || liq !== BigInt(currentLiq), cap, am: { [a0k]: n0, [a1k]: n1 } };
    st.entryCache[key] = data;
    saveEntryCache(st);
    return data;
  } catch (e) {
    console.error(`  [${chainId}] V4 建仓回溯失败 token ${tokenId}:`, e.message?.slice(0, 80));
    return null;
  }
}

// ---- 建仓回溯 (子图版, eth/base): 公共 RPC 封 eth_getLogs, 改用子图 amountUSD ----
// 子图对每个 Mint/Burn(V3) 或 ModifyLiquidity(V4) 已按事件时点算好美元额, 无需自己重建历史价.
async function graphQueryRetry(subgraphId, query, tries = 3, gap = 700) {
  for (let i = 0; i < tries; i++) {
    const d = await graphQuery(subgraphId, query);
    if (d) return d;
    if (i < tries - 1) await sleep(gap);
  }
  return null;
}

// V3: Position 无 USD, Mint/Burn 有 amountUSD 但 owner 恒为 NPM (无 tokenId 索引);
// 用 pool+ticks+origin 聚合 (origin=建仓 tx 发起人, 覆盖多次加仓); 与 depositedToken0 对账, 偏差>2% 记 mod.
async function getV3EntrySubgraph(chainId, job) {
  const st = entryState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = `v3-${job.tokenId}`;
  const cached = st.entryCache[key];
  if (cached && cached.liq === job.liq.toString() && cached.am) return cached;
  const pool = job.poolAddress.toLowerCase();
  const tl = job.tickLower, tu = job.tickUpper;
  // 1) 拿 owner + 本档创建 mint 的 origin + 累计入金 token0 量 (对账用)
  const pd = await graphQueryRetry(cfg.v3SubgraphId,
    `{ position(id:"${job.tokenId}"){ owner depositedToken0 transaction{ mints{ tickLower tickUpper origin } } } }`);
  const p = pd && pd.position;
  if (!p) return null;
  const cm = (p.transaction && p.transaction.mints || []).find(m => Number(m.tickLower) === tl && Number(m.tickUpper) === tu);
  const origin = (cm && cm.origin || p.owner || '').toLowerCase();
  if (!origin) return null;
  // 2) pool+ticks+origin 聚合全部 mint/burn 的 amountUSD
  const md = await graphQueryRetry(cfg.v3SubgraphId,
    `{ mints(first:500, where:{pool:"${pool}", tickLower:${tl}, tickUpper:${tu}, origin:"${origin}"}){ amount0 amount1 amountUSD timestamp } }`);
  if (!md) return null;
  const bd = await graphQueryRetry(cfg.v3SubgraphId,
    `{ burns(first:500, where:{pool:"${pool}", tickLower:${tl}, tickUpper:${tu}, origin:"${origin}"}){ amount0 amount1 amountUSD } }`);
  const mints = md.mints || [], burns = (bd && bd.burns) || [];
  if (mints.length === 0) return null;
  let u = 0, sum0 = 0, sum1 = 0, ts = 0;
  for (const m of mints) { u += Math.abs(+m.amountUSD); sum0 += +m.amount0; sum1 += +m.amount1; const t = +m.timestamp * 1000; if (!ts || t < ts) ts = t; }
  const w = burns.reduce((a, b) => a + Math.abs(+b.amountUSD), 0);
  let n0 = sum0, n1 = sum1;
  for (const b of burns) { n0 -= Math.abs(+b.amount0 || 0); n1 -= Math.abs(+b.amount1 || 0); }
  const dep0 = +p.depositedToken0;
  const mod = dep0 > 0 ? Math.abs(sum0 - dep0) / dep0 > 0.02 : false;   // 同钱包同池同档多 NFT 合并/漏事件 → 存疑
  const am = { [job.t0.address.toLowerCase()]: n0, [job.t1.address.toLowerCase()]: n1 };   // 净存入数量 (无常损失用)
  const data = { u, w, ts, n: mints.length, liq: job.liq.toString(), b: 0, mod, am };
  st.entryCache[key] = data; saveEntryCache(st);
  return data;
}

// V4: Position 无金额, 从 ModifyLiquidity.amountUSD 聚合 (amount 正负分入金/提取);
// pool+ticks+origin 过滤. base V4 索引器对带 filter 的查询偶发 BadResponse → 多重试, 仍失败交冷却下轮再补.
async function getV4EntrySubgraph(chainId, job) {
  const st = entryState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = `v4-${job.tokenId}`;
  const cached = st.entryCache[key];
  if (cached && cached.liq === job.liq.toString() && cached.am) return cached;
  const pd = await graphQueryRetry(cfg.v4SubgraphId,
    `{ position(id:"${job.tokenId}"){ owner origin createdAtTimestamp } }`);
  const p = pd && pd.position;
  if (!p) return null;
  const origin = (p.origin || p.owner || '').toLowerCase();
  if (!origin) return null;
  // base V4 索引器对带 filter 的 modifyLiquidities 偶发 BadResponse (每次 ~15s 超时); 只试 2 次避免
  // 串行队列被卡死的 job 饿死后面能成功的 base V3; 失败走 15 分钟冷却下轮再补.
  const md = await graphQueryRetry(cfg.v4SubgraphId,
    `{ modifyLiquidities(first:500, where:{pool:"${job.poolId}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}"}){ amount amount0 amount1 amountUSD timestamp } }`, 2, 900);
  if (!md) return null;
  const evs = md.modifyLiquidities || [];
  if (evs.length === 0) return null;
  let u = 0, w = 0, n = 0, ts = 0, n0 = 0, n1 = 0;
  for (const e of evs) {
    const a = Math.abs(+e.amountUSD);
    const s = +e.amount >= 0 ? 1 : -1;
    n0 += s * Math.abs(+e.amount0 || 0); n1 += s * Math.abs(+e.amount1 || 0);
    if (s > 0) { u += a; n++; const t = +e.timestamp * 1000; if (!ts || t < ts) ts = t; }
    else { w += a; }
  }
  const am = { [job.t0.address.toLowerCase()]: n0, [job.t1.address.toLowerCase()]: n1 };
  const data = { u, w, ts, n, liq: job.liq.toString(), b: 0, mod: false, am };
  st.entryCache[key] = data; saveEntryCache(st);
  return data;
}

// ---- 建仓回溯 (链上事件版, base V4): 子图索引器不可靠, 直接重放 ModifyLiquidity ----
// base V4 子图唯一索引器对带 filter 的查询常 BadResponse. mainnet.base.org 既支持 getLogs (10k 块/段)
// 又支持 archive eth_call (历史 getSlot0), 故可精确取每笔事件当块的池价. 关键: V4 前端展示的 token0/token1
// 可能与链上 currency 顺序 (按地址排序) 相反 (如 Basecat 0xB2.. > USDC 0x83.. 被展示成 token0),
// 且事件里带的是链上口径 tick, 所以一律按地址排序定 c0/c1 + 用事件自带 tick, 与展示顺序脱钩.
async function getV4EntryBaseLogs(chainId, job) {
  const st = entryState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const key = `v4-${job.tokenId}`;
  const cached = st.entryCache[key];
  if (cached && cached.liq === job.liq.toString() && cached.am) return cached;
  try {
    const ep = entryProvider(chainId);
    const poolId = job.poolId;
    const saltHex = BigInt(job.tokenId).toString(16).padStart(64, '0');
    // 链上 currency 顺序: 按地址升序 (与 poolId=keccak(currency0<currency1) 一致)
    const [c0, c1] = job.t0.address.toLowerCase() < job.t1.address.toLowerCase() ? [job.t0, job.t1] : [job.t1, job.t0];

    let u = 0, w = 0, n = 0, liq = 0n, ts = 0, fromBlock, n0 = 0, n1 = 0;
    const c0k = c0.address.toLowerCase(), c1k = c1.address.toLowerCase();
    if (cached && cached.b > 0 && cached.am) {
      ({ u, w, n, ts } = cached); liq = BigInt(cached.liq); fromBlock = cached.b + 1;
      n0 = cached.am[c0k] || 0; n1 = cached.am[c1k] || 0;
    } else {
      const mint = await mintBlockBase(chainId, job.createdAt, job.tokenId);
      if (!mint) return null;
      fromBlock = mint;
    }
    const latest = await ep.getBlockNumber();
    // getLogs: base.org 2026-09-27 实测单段 > 2000 块即 413 Payload Too Large (此前 10k 可用), 改 2000 块/段;
    // 分段扫 mint->latest (mintBlockBase 留 50k 余量 → 近期仓 ~25 段起步, 老仓几百段, 后台队列慢慢来)
    const BASE_CHUNK = 2000;
    const logs = [];
    for (let f = fromBlock; f <= latest; f += BASE_CHUNK) {
      const to = Math.min(f + BASE_CHUNK - 1, latest);
      const part = await withRetry(() => ep.send('eth_getLogs', [{
        address: cfg.v4.poolManager,
        topics: [V4_MODIFY_TOPIC, poolId, ethers.zeroPadValue(cfg.v4.pm, 32)],
        fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16),
      }]), 4, 900);
      logs.push(...part);
      if (f + BASE_CHUNK <= latest) await sleep(60);
    }
    // data 布局: tickLower(32B) tickUpper(32B) liquidityDelta(32B,有符号) salt(32B)
    const evs = [];
    for (const lg of logs) {
      const hex = lg.data.slice(2);
      if (hex.slice(192, 256) !== saltHex) continue;
      evs.push({ bn: parseInt(lg.blockNumber, 16), tl: hexI24(hex.slice(0, 64)), tu: hexI24(hex.slice(64, 128)), delta: hexInt(hex.slice(128, 192)) });
    }
    if (!(cached && cached.am) && !evs.some(e => e.delta > 0n)) return null;
    evs.sort((a, b) => a.bn - b.bn);

    // 某块池价 + 两侧 USD 单价 (同块多事件只查一次)。取 sqrt 两条路:
    //  ① archive getSlot0 当块精确值; ② base.org 负载均衡里部分后端非 archive 会报 "pruned history"
    //     (code 4444) → 回退到该块附近最近一笔 V4 Swap 自带的 sqrtPriceX96 (仅需 getLogs, 不吃 archive).
    const memo = new Map();
    const sqrtAt = async (bn) => {
      try {
        const r = await ep.send('eth_call', [{ to: cfg.v4.stateView, data: GETSLOT0_IFACE.encodeFunctionData('getSlot0', [poolId]) }, '0x' + bn.toString(16)]);
        const s = GETSLOT0_IFACE.decodeFunctionResult('getSlot0', r)[0];
        if (s > 0n) return s;
      } catch {}
      // Swap 兜底: 窗口逐级放大, data 第 3 槽 = sqrtPriceX96
      const latestN = latest;
      for (const back of (cfg.logChunk ? [600, 4900] : [600, 990])) {   // arc: 单段 ≤ 9999; base.org: 单段 ≤ 2000 (±990)
        const from = Math.max(0, bn - back), to = Math.min(latestN, bn + back);
        let logs;
        try {
          logs = await ep.send('eth_getLogs', [{ address: cfg.v4.poolManager, topics: [V4_SWAP_TOPIC, poolId], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
        } catch { continue; }
        if (!logs || !logs.length) continue;
        let best = null, bd = Infinity;
        for (const l of logs) { const d = Math.abs(parseInt(l.blockNumber, 16) - bn); if (d < bd) { bd = d; best = l; } }
        return BigInt('0x' + best.data.slice(2 + 128, 2 + 192));
      }
      return null;
    };
    const priceAt = async (bn) => {
      if (memo.has(bn)) return memo.get(bn);
      let out = null;
      try {
        const sqrt = await withRetry(() => sqrtAt(bn), 2, 700);
        const blk = await withRetry(() => st.provider.getBlock(bn));
        if (sqrt && sqrt > 0n && blk) {
          const px = await entryTokenPrices(cfg, c0, c1, sqrtPriceX96ToPrice(sqrt, c0.decimals, c1.decimals), blk.timestamp * 1000);
          if (px) out = { ...px, sqrt, ts: blk.timestamp * 1000 };
        }
      } catch {}
      memo.set(bn, out);
      return out;
    };

    // 高频机器人仓 (>30 事件): 只按首笔正向计 + 冻结, 避免逐笔 archive 调用过量
    let cap = !!(cached && cached.cap);
    if (evs.length > 30) {
      const first = evs.find(e => e.delta > 0n);
      if (first) {
        const pr = await priceAt(first.bn);
        if (!pr) return null;
        const { amount0, amount1 } = getTokenAmounts(first.delta, pr.sqrt, first.tl, first.tu, c0.decimals, c1.decimals);
        u += amount0 * pr.p0 + amount1 * pr.p1; n++; n0 += amount0; n1 += amount1; if (!ts) ts = pr.ts;
      }
      const data = { u, w: 0, ts, n, liq: job.liq.toString(), b: latest, mod: true, cap: true, am: { [c0k]: n0, [c1k]: n1 } };
      st.entryCache[key] = data; saveEntryCache(st);
      return data;
    }
    for (const ev of evs) {
      const pr = await priceAt(ev.bn);
      if (!pr) return null;
      const mag = ev.delta > 0n ? ev.delta : -ev.delta;
      const { amount0, amount1 } = getTokenAmounts(mag, pr.sqrt, ev.tl, ev.tu, c0.decimals, c1.decimals);
      const v = amount0 * pr.p0 + amount1 * pr.p1;
      if (ev.delta > 0n) { u += v; n++; liq += ev.delta; n0 += amount0; n1 += amount1; if (!ts) ts = pr.ts; }
      else { w += v; liq += ev.delta; n0 -= amount0; n1 -= amount1; }
    }
    const data = { u, w, ts, n, liq: liq.toString(), b: latest, mod: cap || liq !== BigInt(job.liq), cap, am: { [c0k]: n0, [c1k]: n1 } };
    st.entryCache[key] = data; saveEntryCache(st);
    return data;
  } catch (e) {
    console.error(`  [${chainId}] V4 链上建仓回溯失败 token ${job.tokenId}:`, e.message?.slice(0, 80));
    return null;
  }
}

// mint 块下界 (供 getLogs 前向扫描的起点, 不必精确, 宁早勿晚): base 固定 2s 出块, 用最新块校准
// 由 createdAt 估算 + 留 50k 块 (~28h) 余量. 关键: 绝不对老块调 getBlock —— publicnode 会剪枝老块
// 状态/区块体, 二分遍历必然撞到 "pruned history" (code 4444). createdAt 缺失才退回 Transfer 倒扫 (getLogs 可靠).
async function mintBlockBase(chainId, createdAtMs, tokenId) {
  const ep = entryProvider(chainId);           // base.org: getBlockNumber + 最近块 getBlock 可靠
  const latest = await ep.getBlockNumber();
  if (createdAtMs > 0) {
    let latestTs = 0;
    try { const lb = await ep.getBlock(latest); latestTs = lb ? lb.timestamp : 0; } catch {}
    if (latestTs > 0) {
      const est = latest - Math.floor((latestTs - Math.floor(createdAtMs / 1000)) / 2);
      return Math.max(0, est - 50000);
    }
  }
  const T = ethers.id('Transfer(address,address,uint256)');
  const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const tid = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const floor = Math.max(0, latest - 3000000);
  for (let to = latest; to >= floor; to -= 9000) {
    const from = Math.max(floor, to - 8999);
    const logs = await withRetry(() => ep.send('eth_getLogs', [{
      address: EVM_CHAINS[chainId].v4.pm, topics: [T, zero, null, tid],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
    }]), 3, 900);
    if (logs.length) return parseInt(logs[0].blockNumber, 16);
    await sleep(60);
  }
  return null;
}

// ---- 建仓回溯异步化: 拉取主流程只读缓存, 缺失/过期的进后台队列慢慢补 ----
// 回填内联在拉取里曾把单轮拖到 5-9 分钟, RPC 抖动时的重试还会挤占枚举扫描的配额;
// 现在缓存未命中 → 本轮不显示 (宁缺毋错), 后台串行补算 (job 间 300ms), 失败 15 分钟冷却
function entryPeek(chainId, kind, tokenId, currentLiq, job) {
  const st = entryState(chainId);
  const key = `${kind}-${tokenId}`;
  const cached = st.entryCache[key];
  if (cached && typeof cached === 'object') cached.seenAt = Date.now();   // 2026-09-28 审计修复: 记最近访问时间 (落盘时裁 30 天未访问的)
  const hit = cached && cached.liq === currentLiq.toString();
  if (hit && cached.am) return cached;
  st.entryJobs = st.entryJobs || new Map();
  st.entryCooldown = st.entryCooldown || new Map();
  if ((st.entryCooldown.get(key) || 0) < Date.now() && !st.entryJobs.has(key)) {
    st.entryJobs.set(key, job);
    setImmediate(() => runEntryQueue(chainId).catch(() => {}));
  }
  // 旧缓存只缺 am (净存入数量, 2026-09-27 新增): 建仓价值照旧显示, 后台补算; 补算失败 (RPC 抽风) 也不断档
  return hit ? cached : null;
}
async function runEntryQueue(chainId) {
  const st = entryState(chainId);
  if (st.entryWorkerBusy) return;
  st.entryWorkerBusy = true;
  try {
    while (st.entryJobs && st.entryJobs.size > 0) {
      const [key, job] = st.entryJobs.entries().next().value;
      st.entryJobs.delete(key);
      try {
        const cfg = EVM_CHAINS[chainId];
        const useSg = cfg.entryFromSubgraph;
        let ed;
        if (job.kind === 'v3') {
          ed = useSg ? await getV3EntrySubgraph(chainId, job)
                     : await getV3EntryData(chainId, job.tokenId, job.poolAddress, job.t0, job.t1, job.liq);
        } else if (cfg.entryV4FromLogs) {
          ed = await getV4EntryBaseLogs(chainId, job);          // base V4: 子图不可靠, 走链上事件重放
        } else {
          ed = useSg ? await getV4EntrySubgraph(chainId, job)
                     : await getV4EntryData(chainId, job.tokenId, job.poolId, job.tickLower, job.tickUpper, job.t0, job.t1, job.liq);
        }
        if (!ed) st.entryCooldown.set(key, Date.now() + 15 * 60 * 1000);
      } catch {
        st.entryCooldown.set(key, Date.now() + 15 * 60 * 1000);
      }
      await sleep(300);
    }
  } finally { st.entryWorkerBusy = false; }
}

// --- 单钱包 V3 (Multicall3 聚合: 枚举/读仓全聚合, 昂贵调用只花在活跃仓上) ---
async function fetchWalletV3(chainId, wallet, npm, factory) {
  const st = chainState(chainId);
  let count = 0;
  try { count = Number(await npm.balanceOf(wallet.address)); } catch { return []; }
  if (count === 0) return [];
  console.log(`  [${chainId}] ${wallet.name} V3: ${count} NFTs`);

  const { created: createdMap, collectedFees } = await getV3SubgraphData(chainId, wallet.address);
  const indices = Array.from({ length: count }, (_, i) => i);
  const idRes = await multicall(chainId, indices.map(i => ({ contract: npm, fn: 'tokenOfOwnerByIndex', args: [wallet.address, i] })));
  const tokenIds = idRes.filter(Boolean).map(r => r[0]);
  // 枚举/读仓缺失会让活跃仓无声消失, 宁可整钱包报错走上一轮缓存兜底
  if (tokenIds.length < count) throw new Error(`V3 tokenId 枚举缺失 ${count - tokenIds.length}/${count}`);
  const posRes = await multicall(chainId, tokenIds.map(id => ({ contract: npm, fn: 'positions', args: [id] })));

  const act = [];
  for (let i = 0; i < posRes.length; i++) {
    if (!posRes[i]) throw new Error(`V3 positions() 读取失败 token ${tokenIds[i]}`);
    if (posRes[i].liquidity > 0n) act.push({ tokenId: tokenIds[i], pos: posRes[i] });   // 只看活跃仓
  }
  if (act.length === 0) return [];

  // 池地址 + slot0: 按 (token0,token1,fee) 去重后聚合
  const pkey = p => `${p.token0.toLowerCase()}|${p.token1.toLowerCase()}|${p.fee}`;
  const uniq = [...new Map(act.map(a => [pkey(a.pos), a.pos])).entries()];
  const poolRes = await multicall(chainId, uniq.map(([, p]) => ({ contract: factory, fn: 'getPool', args: [p.token0, p.token1, p.fee] })));
  const pools = {};   // pkey -> { addr, slot0 }
  const slotCalls = [], slotKeys = [];
  uniq.forEach(([k], i) => {
    const addr = poolRes[i] && poolRes[i][0];
    if (addr && addr !== ethers.ZeroAddress) {
      pools[k] = { addr };
      slotCalls.push({ contract: new ethers.Contract(addr, POOL_ABI, st.provider), fn: 'slot0', args: [] });
      slotKeys.push(k);
    }
  });
  const slotRes = await multicall(chainId, slotCalls);
  slotKeys.forEach((k, i) => { if (slotRes[i]) pools[k].slot0 = slotRes[i]; });

  // 逐仓收尾: collect.staticCall 依赖 msg.sender=owner 进不了 multicall;
  // createdAt/Collect 扫描各有持久缓存, 只有新仓才真正发请求
  const built = await batchedAll(act, async ({ tokenId, pos }) => {
    const pool = pools[pkey(pos)];
    if (!pool || !pool.slot0) {
      // 2026-09-28 审计修复: 静默跳过会无声吞掉活跃仓, 留痕 (行为仍是跳过该仓)
      console.error(`  [${chainId}] V3 ${!pool ? '池查不到' : 'slot0 失败'} token ${tokenId} (${pos.token0}/${pos.token1} fee ${pos.fee}), 本轮跳过该仓`);
      return null;
    }
    const t0 = await getTokenInfo(chainId, pos.token0);
    const t1 = await getTokenInfo(chainId, pos.token1);
    const sqrtPriceX96 = pool.slot0.sqrtPriceX96, currentTick = Number(pool.slot0.tick);

    const tickLower = Number(pos.tickLower), tickUpper = Number(pos.tickUpper);
    const { amount0, amount1 } = getTokenAmounts(pos.liquidity, sqrtPriceX96, tickLower, tickUpper, t0.decimals, t1.decimals);
    const { fees0, fees1, failed: feesOwedUnknown } = await getUnclaimedFees(npm, tokenId, wallet.address, chainId);   // 2026-09-28 审计修复: 失败带标记
    const tidStr = tokenId.toString();
    let createdAt = createdMap[tidStr] || 0;
    if (!createdAt) createdAt = await blockscoutMintTime(chainId, EVM_CHAINS[chainId].v3.npm, tidStr);
    if (!createdAt) createdAt = await rpcMintTime(chainId, EVM_CHAINS[chainId].v3.npm, tidStr);

    // 建仓价值: 只读缓存, 缺失/过期交给后台队列补 (mint 块 mb 即使 liquidity 已变也可用)
    let entryValueUSD = 0, entryWithdrawnUSD = 0, entryTs = 0, entryAdds = 0, entryModified = false, mintBlock = 0, entryAm = null;
    if (EVM_CHAINS[chainId].entryFromLogs || EVM_CHAINS[chainId].entryFromSubgraph) {
      mintBlock = entryState(chainId).entryCache[`v3-${tokenId}`]?.mb || 0;
      const ed = entryPeek(chainId, 'v3', tokenId, pos.liquidity,
        { kind: 'v3', tokenId, poolAddress: pool.addr, tickLower, tickUpper, t0, t1, liq: pos.liquidity });
      if (ed) {
        entryValueUSD = ed.u; entryWithdrawnUSD = ed.w; entryTs = ed.ts;
        entryAdds = ed.n; entryModified = ed.mod; entryAm = ed.am || null;
      }
    }

    // 无子图链 (RH): 链上扫 Collect 事件, 拿最后领取时间 + 已领手续费
    let lastCollectAt = 0;
    let posCollectedFees = collectedFees[tidStr] || { token0: 0, token1: 0 };
    const cd = await getV3CollectData(chainId, tokenId, mintBlock);
    if (cd) {
      lastCollectAt = cd.lastCollectAt;
      posCollectedFees = {
        token0: Number(cd.collected0) / 10 ** t0.decimals,
        token1: Number(cd.collected1) / 10 ** t1.decimals,
      };
    }

    return {
      tokenId: tidStr,
      token0: t0, token1: t1,
      token0addr: pos.token0, token1addr: pos.token1,
      fee: Number(pos.fee), feeLabel: feeLabel(pos.fee),
      tickLower, tickUpper, currentTick,
      liquidity: pos.liquidity.toString(), liquidityActive: true,
      inRange: currentTick >= tickLower && currentTick < tickUpper,
      currentPrice: sqrtPriceX96ToPrice(sqrtPriceX96, t0.decimals, t1.decimals),
      lowerPrice: tickToPrice(tickLower, t0.decimals, t1.decimals),
      upperPrice: tickToPrice(tickUpper, t0.decimals, t1.decimals),
      amount0, amount1,
      feesOwed0: Number(fees0) / 10 ** t0.decimals,
      feesOwed1: Number(fees1) / 10 ** t1.decimals,
      poolAddress: pool.addr,
      walletName: wallet.name, walletAddress: wallet.address,
      protocol: 'V3', createdAt, lastCollectAt,
      collectedFees: posCollectedFees,
      entryValueUSD, entryWithdrawnUSD, entryTs, entryAdds, entryModified, entryAm,
      ...(feesOwedUnknown ? { feesOwedUnknown: true } : {}),   // 2026-09-28 审计修复: 未领费读取失败 (定价循环里再置 feesUnknown)
    };
  });
  return built.filter(Boolean);
}

// --- 单钱包 V4 (Multicall3 聚合: 先全量读 liquidity 过滤活跃仓, 再聚合读明细) ---
async function fetchWalletV4(chainId, wallet, v4pm, stateView) {
  const cfg = EVM_CHAINS[chainId];
  const entries = await getV4PositionIds(chainId, wallet.address);
  if (entries.length === 0) return [];
  console.log(`  [${chainId}] ${wallet.name} V4: ${entries.length} positions`);

  const liqRes = await multicall(chainId, entries.map(e => ({ contract: v4pm, fn: 'getPositionLiquidity', args: [e.id] })));
  const act = [];
  let liqFail = 0;
  for (let i = 0; i < entries.length; i++) {
    if (!liqRes[i]) { liqFail++; continue; }
    if (liqRes[i][0] > 0n) act.push({ entry: entries[i], liquidity: liqRes[i][0] });   // 只看活跃仓
  }
  // 零星失败按旧逻辑跳过该 token; 大面积失败=RPC 异常, 整钱包报错走上一轮缓存兜底
  if (liqFail > 0) {
    console.error(`  [${chainId}] V4 liquidity 读取失败 ${liqFail}/${entries.length}`);
    if (liqFail > entries.length * 0.2) throw new Error(`V4 liquidity 大面积失败 ${liqFail}/${entries.length}`);
  }
  if (act.length === 0) return [];

  const infoRes = await multicall(chainId, act.map(a => ({ contract: v4pm, fn: 'getPoolAndPositionInfo', args: [a.entry.id] })));
  const metas = [];
  const poolIdx = new Map();   // poolId -> slot0 调用下标 (同池多仓去重)
  for (let i = 0; i < act.length; i++) {
    if (!infoRes[i]) { console.error(`  [${chainId}] V4 poolInfo 失败 token ${act[i].entry.id}`); continue; }
    const poolKey = infoRes[i][0], info = infoRes[i][1];
    const { tickLower, tickUpper } = decodePackedPositionInfo(info);
    const poolId = computePoolId(poolKey);
    if (!poolIdx.has(poolId)) poolIdx.set(poolId, poolIdx.size);
    metas.push({ ...act[i], poolKey, tickLower, tickUpper, poolId });
  }
  const slotRes = await multicall(chainId, [...poolIdx.keys()].map(pid => ({ contract: stateView, fn: 'getSlot0', args: [pid] })));
  // V4 未领手续费素材 (feeGrowth 差值法, 与 server.js 同款): 成对聚合
  const feeCalls = [];
  for (const m of metas) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(m.entry.id), 32);
    feeCalls.push({ contract: stateView, fn: 'getPositionInfo', args: [m.poolId, cfg.v4.pm, m.tickLower, m.tickUpper, salt] });
    feeCalls.push({ contract: stateView, fn: 'getFeeGrowthInside', args: [m.poolId, m.tickLower, m.tickUpper] });
  }
  const feeRes = await multicall(chainId, feeCalls);

  const positions = [];
  for (let i = 0; i < metas.length; i++) {
    const m = metas[i];
    const tokenId = m.entry.id;
    try {
      const slot0 = slotRes[poolIdx.get(m.poolId)];
      if (!slot0) {
        // 静默跳过会无声吞掉活跃仓, 必须留痕
        console.error(`  [${chainId}] V4 slot0 失败 token ${tokenId} pool ${m.poolId.slice(0, 10)}`);
        continue;
      }
      const t0 = await getTokenInfo(chainId, m.poolKey.currency0);
      const t1 = await getTokenInfo(chainId, m.poolKey.currency1);
      const sqrtPriceX96 = slot0.sqrtPriceX96, currentTick = Number(slot0.tick);
      const { amount0, amount1 } = getTokenAmounts(m.liquidity, sqrtPriceX96, m.tickLower, m.tickUpper, t0.decimals, t1.decimals);

      let feesOwed0 = 0, feesOwed1 = 0, feesOwedUnknown = false;
      const posInfo = feeRes[i * 2], fgi = feeRes[i * 2 + 1];
      if (posInfo && fgi && posInfo.liquidity > 0n) {
        const MAX_U256 = (1n << 256n) - 1n;
        const d0 = (fgi.feeGrowthInside0X128 - posInfo.feeGrowthInside0LastX128 + MAX_U256 + 1n) & MAX_U256;
        const d1 = (fgi.feeGrowthInside1X128 - posInfo.feeGrowthInside1LastX128 + MAX_U256 + 1n) & MAX_U256;
        feesOwed0 = Number(d0 * posInfo.liquidity / Q128) / 10 ** t0.decimals;
        feesOwed1 = Number(d1 * posInfo.liquidity / Q128) / 10 ** t1.decimals;
        // 2026-09-28 审计修复: 离谱值 (>1e12) 归零要留痕并标 feesOwedUnknown, 不再静默
        if (feesOwed0 > 1e12 || feesOwed1 > 1e12) {
          console.error(`  [${chainId}] V4 未领费离谱 token ${tokenId}: ${feesOwed0.toExponential(2)} / ${feesOwed1.toExponential(2)}, 归零并标 feesUnknown`);
          if (feesOwed0 > 1e12) feesOwed0 = 0;
          if (feesOwed1 > 1e12) feesOwed1 = 0;
          feesOwedUnknown = true;
        }
      } else if (!posInfo || !fgi) {
        // 2026-09-28 审计修复: getPositionInfo/getFeeGrowthInside 读失败曾静默当 0 费
        console.error(`  [${chainId}] V4 未领费素材读取失败 token ${tokenId}, 标 feesUnknown`);
        feesOwedUnknown = true;
      }

      let createdAt = m.entry.createdAt || 0;
      if (!createdAt) createdAt = await blockscoutMintTime(chainId, cfg.v4.pm, tokenId.toString());
      if (!createdAt) createdAt = await rpcMintTime(chainId, cfg.v4.pm, tokenId.toString());

      // 建仓价值: 只读缓存, 缺失/过期交给后台队列补
      let entryValueUSD = 0, entryWithdrawnUSD = 0, entryTs = 0, entryAdds = 0, entryModified = false, entryAm = null;
      if (cfg.entryFromLogs || cfg.entryFromSubgraph) {
        const ed = entryPeek(chainId, 'v4', tokenId, m.liquidity,
          { kind: 'v4', tokenId, poolId: m.poolId, tickLower: m.tickLower, tickUpper: m.tickUpper, t0, t1, liq: m.liquidity, createdAt });
        if (ed) {
          entryValueUSD = ed.u; entryWithdrawnUSD = ed.w; entryTs = ed.ts;
          entryAdds = ed.n; entryModified = ed.mod; entryAm = ed.am || null;
        }
      }

      positions.push({
        tokenId: tokenId.toString(),
        token0: t0, token1: t1,
        token0addr: t0.address, token1addr: t1.address,
        fee: Number(m.poolKey.fee), feeLabel: feeLabel(m.poolKey.fee),
        tickLower: m.tickLower, tickUpper: m.tickUpper, currentTick,
        liquidity: m.liquidity.toString(), liquidityActive: true,
        inRange: currentTick >= m.tickLower && currentTick < m.tickUpper,
        currentPrice: sqrtPriceX96ToPrice(sqrtPriceX96, t0.decimals, t1.decimals),
        lowerPrice: tickToPrice(m.tickLower, t0.decimals, t1.decimals),
        upperPrice: tickToPrice(m.tickUpper, t0.decimals, t1.decimals),
        amount0, amount1, feesOwed0, feesOwed1,
        poolAddress: m.poolId,
        walletName: wallet.name, walletAddress: wallet.address,
        protocol: 'V4', createdAt, lastCollectAt: 0,
        entryValueUSD, entryWithdrawnUSD, entryTs, entryAdds, entryModified, entryAm,
        ...(feesOwedUnknown ? { feesOwedUnknown: true } : {}),   // 2026-09-28 审计修复: 未领费不可信 (定价循环里再置 feesUnknown)
      });
    } catch (e) {
      console.error(`  [${chainId}] V4 err token ${tokenId}:`, e.message?.slice(0, 80));
    }
  }
  return positions;
}

// --- USD 价格: 稳定币=1 -> coingecko -> 池内价推导 -> native 价兜底 ---
let nativePriceCache = { price: 0, ts: 0 };
async function getNativePrice(priceId) {
  if (Date.now() - nativePriceCache.ts < 5 * 60 * 1000 && nativePriceCache.price > 0) return nativePriceCache.price;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${priceId}&vs_currencies=usd`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const d = await res.json();
      const p = d[priceId]?.usd || 0;
      if (p > 0) nativePriceCache = { price: p, ts: Date.now() };
      return p;
    }
  } catch {}
  return nativePriceCache.price;
}

async function getUSDPrices(chainId, tokenAddresses, positionsData, meta = null) {
  const cfg = EVM_CHAINS[chainId];
  const unique = [...new Set(tokenAddresses.map(a => a.toLowerCase()))];
  const prices = {};
  for (const addr of unique) if (cfg.stables[addr]) prices[addr] = 1.0;

  // coingecko 按合约查价 (RH 不支持)
  const need = unique.filter(a => !prices[a]);
  if (need.length > 0 && cfg.coingeckoPlatform) {
    try {
      const url = `https://api.coingecko.com/api/v3/simple/token_price/${cfg.coingeckoPlatform}?contract_addresses=${need.join(',')}&vs_currencies=usd`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const d = await res.json();
        for (const [addr, info] of Object.entries(d)) if (info.usd) prices[addr.toLowerCase()] = info.usd;
      }
    } catch {}
  }

  // 池现价可用性护栏: tick 打到 ±887272 边界=池被单向 swap 打穿(现价处零对手流动性),
  // 现价是边界哨兵值(如 1e50)而非市场价, 不得用于定价推导
  const TICK_EDGE = 887000;
  const poolPriceUsable = (pos) => pos.currentPrice > 0 && Number.isFinite(pos.currentPrice)
    && !(Number.isFinite(pos.currentTick) && Math.abs(pos.currentTick) >= TICK_EDGE);

  // 池内价推导 (稳定币对) — 优先 active+inRange
  const priceSource = {};
  const rank = { 'active-inrange': 3, active: 2, inactive: 1 };
  for (const pos of positionsData) {
    const t0 = pos.token0addr.toLowerCase(), t1 = pos.token1addr.toLowerCase();
    if (!poolPriceUsable(pos)) continue;
    let target, price;
    if (cfg.stables[t1] && !cfg.stables[t0]) { target = t0; price = pos.currentPrice; }
    else if (cfg.stables[t0] && !cfg.stables[t1]) { target = t1; price = 1 / pos.currentPrice; }
    else continue;
    const src = pos.inRange ? 'active-inrange' : 'active';
    if (!prices[target] || rank[src] > rank[priceSource[target] || 'inactive']) {
      prices[target] = price; priceSource[target] = src;
    }
  }

  // WETH/native 兜底: coingecko 全局 ETH 价
  const wn = cfg.wrappedNative.toLowerCase();
  if (unique.includes(wn) && !prices[wn]) {
    prices[wn] = await getNativePrice(cfg.nativePriceId);
  }
  // 第二轮: 用已定价 token (如 WETH) 的池子再推导一层 (token/WETH 对)
  for (const pos of positionsData) {
    const t0 = pos.token0addr.toLowerCase(), t1 = pos.token1addr.toLowerCase();
    if (!poolPriceUsable(pos)) continue;
    if (prices[t1] > 0 && !prices[t0]) prices[t0] = pos.currentPrice * prices[t1];
    else if (prices[t0] > 0 && !prices[t1]) prices[t1] = prices[t0] / pos.currentPrice;
  }

  // rh 官方股票代币: 池内价不可用(唯一池被打穿/无 USDG 对)时用美股行情近似 (~15min 延迟)
  if (chainId === 'rh') {
    const quotes = rhStockQuotes();
    for (const t of rhStockTokens()) {
      if (!prices[t.addr] && quotes[t.sym]?.price > 0) prices[t.addr] = quotes[t.sym].price;
    }
  }

  // 2026-09-28 审计修复: 本轮定不了价的 token 不再静默归零 —— 调用方传 meta (fetchInner) 时沿用上轮价 (st.lastUsdPrices; 只沿用 24h 内还拿到过新鲜价的 token,
  //   免得死池的价永远续命) 并回报 meta.stale (沿用) / meta.miss (彻底没价), 由 fetchInner 标 priceStale / stats.priceMiss;
  //   账本 (pnl-ledger) 的调用不传 meta, 行为不变 (0 = 缺价, 它自己有参考价逻辑)
  if (meta) {
    const st = chainState(chainId);
    st.priceSeenAt = st.priceSeenAt || {};
    meta.stale = new Set(); meta.miss = new Set();
    const now = Date.now();
    for (const addr of unique) {
      if (prices[addr] > 0) { st.priceSeenAt[addr] = now; continue; }
      const prev = (st.lastUsdPrices || {})[addr];
      if (prev > 0 && now - (st.priceSeenAt[addr] || 0) < 24 * 3600e3) { prices[addr] = prev; meta.stale.add(addr); }
      else meta.miss.add(addr);
    }
  }
  for (const addr of unique) if (!prices[addr]) prices[addr] = 0;
  return prices;
}

// --- 钱包闲置余额 (LP 之外的代币资产) ---
// EVM 无法免索引器枚举全部 ERC20, 候选集=LP 涉及 token + 稳定币 + WETH (+ rh 全部官方股票代币);
// 垃圾空投币天然进不了候选集, 无需再做 spam 过滤, 仅滤 <$1 灰尘
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const MC3_NATIVE_ABI = ['function getEthBalance(address addr) view returns (uint256)'];
// rh 股票代币注册表/行情来自独立项目 rh-stocktokens (2026-09-06 拆分): 只读其数据目录做
// 闲置余额定价——文档化松耦合, 文件缺失/项目停用时 catch 兜底自动降级
const STOCKS_DIR = process.env.STOCKTOKENS_DIR || path.join(__dirname, '..', 'rh-stocktokens');
let rhRegistryCache = { list: null, ts: 0 };
function rhStockTokens() {
  if (rhRegistryCache.list && Date.now() - rhRegistryCache.ts < 3600e3) return rhRegistryCache.list;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(STOCKS_DIR, 'stocktokens-registry.json'), 'utf8'));
    rhRegistryCache = { list: reg.map(t => ({ addr: t.addr.toLowerCase(), sym: t.sym })), ts: Date.now() };
  } catch { rhRegistryCache = { list: [], ts: Date.now() }; }
  return rhRegistryCache.list;
}
function rhStockQuotes() {
  try { return JSON.parse(fs.readFileSync(path.join(STOCKS_DIR, 'stocktokens-cache.json'), 'utf8')).quotes || {}; }
  catch { return {}; }
}
// 候选 ERC20 集合 (小写地址); lpTokenAddrs = 本轮 LP 头寸涉及的 token
function idleCandidates(chainId, lpTokenAddrs) {
  const cfg = EVM_CHAINS[chainId];
  const cand = new Set();
  for (const a of lpTokenAddrs) if (a && a !== ethers.ZeroAddress.toLowerCase()) cand.add(a);
  for (const a of Object.keys(cfg.stables)) cand.add(a);
  cand.add(cfg.wrappedNative.toLowerCase());
  if (chainId === 'rh') for (const t of rhStockTokens()) cand.add(t.addr);
  return [...cand];
}
async function fetchIdleBalances(chainId, WALLETS, tokens, usdPrices, staleSet = null) {
  const cfg = EVM_CHAINS[chainId];
  const st = chainState(chainId);
  if (WALLETS.length === 0) return { totalUSD: 0, byWallet: {} };

  // token meta: 未缓存的批量 multicall, 结果进 tokenCache
  const needMeta = tokens.filter(a => !st.tokenCache[a] || st.tokenCache[a]._fallback);
  if (needMeta.length) {
    const metaCalls = [];
    for (const a of needMeta) {
      const c = new ethers.Contract(a, ERC20_ABI, st.provider);
      metaCalls.push({ contract: c, fn: 'symbol', args: [] }, { contract: c, fn: 'decimals', args: [] });
    }
    const mr = await multicall(chainId, metaCalls);
    needMeta.forEach((a, i) => {
      const sym = mr[i * 2], dec = mr[i * 2 + 1];
      // 2026-09-28 审计修复: symbol 与 decimals 分开落 (symbol 失败不再连带 decimals 退 18); symbol 净化; decimals 缺失标 decimalsUnknown
      const info = { symbol: sanitizeSymbol(sym ? sym[0] : null, a), decimals: dec ? Number(dec[0]) : 18, address: a };
      if (!dec) info.decimalsUnknown = true;
      if (!dec || !sym) { info._fallback = true; info._ts = Date.now(); }
      st.tokenCache[a] = info;
    });
  }

  // 余额: 每钱包 native getEthBalance + 每候选 token balanceOf, 全部 Multicall3 聚合
  const mcNative = new ethers.Contract(MC3_ADDR, MC3_NATIVE_ABI, st.provider);
  const calls = [];
  for (const w of WALLETS) {
    calls.push({ contract: mcNative, fn: 'getEthBalance', args: [w.address] });
    for (const a of tokens) calls.push({ contract: new ethers.Contract(a, ERC20_BAL_ABI, st.provider), fn: 'balanceOf', args: [w.address] });
  }
  const res = await multicall(chainId, calls);

  const stockSym = {};
  if (chainId === 'rh') for (const t of rhStockTokens()) stockSym[t.addr] = t.sym;
  const quotes = chainId === 'rh' ? rhStockQuotes() : {};
  let nativePrice = usdPrices[cfg.wrappedNative.toLowerCase()] || 0;
  if (!nativePrice) nativePrice = await getNativePrice(cfg.nativePriceId);

  const byWallet = {}; let totalUSD = 0; let ri = 0;
  for (const w of WALLETS) {
    const items = [];
    const nat = res[ri++];
    // nativeIsAliased (Arc): 原生币与 wrappedNative 预编译是同一笔余额的两种表示, 记了原生再记 ERC-20 会翻倍;
    // 只认 ERC-20 那笔 (规范小数位)。ETH/WETH 那种"两笔独立的钱"不置此位, 行为不变。
    if (nat && !cfg.nativeIsAliased) {
      const amount = Number(nat[0]) / 1e18;
      const v = amount * nativePrice;
      if (v >= 1) items.push({ symbol: cfg.nativeSymbol, address: 'native', amount, priceUSD: nativePrice, valueUSD: v, native: true });
    }
    for (const a of tokens) {
      const r = res[ri++];
      if (!r) continue;
      const meta = st.tokenCache[a];
      const amount = Number(r[0]) / 10 ** (meta?.decimals ?? 18);
      if (amount <= 0) continue;
      let price = cfg.stables[a] ? 1 : (usdPrices[a] || 0);
      if (!price && a === cfg.wrappedNative.toLowerCase()) price = nativePrice;
      if (!price && stockSym[a]) price = quotes[stockSym[a]]?.price || 0;  // rh 股票代币: 美股行情近似 (~15min 延迟)
      const v = amount * price;
      if (v < 1) continue;
      items.push({ symbol: meta?.symbol || a.slice(0, 6), address: a, amount, priceUSD: price, valueUSD: v, ...(staleSet && staleSet.has(a) ? { priceStale: true } : {}) });   // 2026-09-28 审计修复: 沿用上轮价的打标
    }
    items.sort((x, y) => y.valueUSD - x.valueUSD);
    const wTotal = items.reduce((s, t) => s + t.valueUSD, 0);
    byWallet[w.address] = { name: w.name, totalUSD: wTotal, tokens: items };  // 键=钱包文件原样地址(已小写), 与前端筛选值一致
    totalUSD += wTotal;
  }
  return { totalUSD, byWallet };
}
// 钱包删除/换地址时把它从 idle 快照剔除并重算合计 (EVM 地址键=小写)
function dropIdleWallet(idle, addr) {
  if (!idle || !idle.byWallet || !idle.byWallet[addr]) return;
  delete idle.byWallet[addr];
  idle.totalUSD = Object.values(idle.byWallet).reduce((s, w) => s + (w.totalUSD || 0), 0);
}

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
// 把钱包从本链缓存/兜底快照里就地剔除并重算合计+统计 (删除/换地址/停用共用, 零 RPC 立即生效)
function dropWalletFromCache(chainId, addr) {
  const st = chainState(chainId);
  if (st.cache.data) {
    const d = st.cache.data;
    d.wallets = (d.wallets || []).filter(w => w.address.toLowerCase() !== addr);
    const sm = summarizeWallets(d.wallets);
    d.grandTotalUSD = sm.grandTotalUSD;
    d.stats = { ...(d.stats || {}), ...sm, totalWallets: loadActiveWallets(chainId).length };
    dropIdleWallet(d.idle, addr);
    if (Array.isArray(d.failedWallets)) d.failedWallets = d.failedWallets.filter(a => a !== addr);   // 2026-09-28 审计修复: 顶层失败名单同步剔除
    try { writeJsonAtomic(st.posFile, st.cache); } catch {}   // 2026-09-28 审计修复: 原子写
  }
  dropIdleWallet(st.lastIdle, addr);
  if (st.lastGood) delete st.lastGood[addr];
}

// --- 钱包资金查询配置 (fund-config.json, 路由在 server.js): 启用开关 + 按链勾选 ---
function loadFundCfgEvm() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-config.json'), 'utf8'));
    return { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} };
  } catch { return { enabled: true, wallets: {} }; }
}
// 勾选子集; 未设置(非数组)=只看标了「自有」的钱包 (2026-09-28 起; 之前是全部钱包)
function ownWallets(WALLETS) { return WALLETS.filter(w => w.own === true); }
function ledgerWallets(WALLETS) { return WALLETS.filter(w => w.own === true || w.ledger === true); }   // 自有 ∪ 观察钱包里手动开了账本的
function fundSelected(fundCfg, chainId, WALLETS) {
  if (!fundCfg.enabled) return [];
  const sel = fundCfg.wallets[chainId];
  if (!Array.isArray(sel)) return ownWallets(WALLETS);
  const s = new Set(sel.map(a => String(a).toLowerCase()));
  return WALLETS.filter(w => s.has(w.address.toLowerCase()));
}
// --- 钱包盈亏账本配置 (pnl-config.json, 与 server.js 的 /api/pnl/config 同一文件): { enabled, wallets: {<chain>: [addrs]} }
//   wallets.<chain> 未设置 = 只看标了「自有」的钱包; [] = 全不参与; 数组 = 勾选子集 (例外覆盖)
//   只有勾选的钱包才进账本队列 (别人的观察钱包动辄两千笔 tx, 用户不需要看它们的盈亏)
function loadPnlCfgEvm() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'pnl-config.json'), 'utf8'));
    return { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} };
  } catch { return { enabled: true, wallets: {} }; }
}
function pnlSelected(chainId, WALLETS) {
  const pc = loadPnlCfgEvm();
  if (!pc.enabled) return [];
  const pick = arr => { const s = new Set(arr.map(a => String(a).toLowerCase())); return WALLETS.filter(w => s.has(w.address.toLowerCase())); };
  if (Array.isArray(pc.wallets[chainId])) return pick(pc.wallets[chainId]).concat(WALLETS.filter(w => w.ledger === true && !pc.wallets[chainId].some(a => String(a).toLowerCase() === w.address.toLowerCase())));
  return ledgerWallets(WALLETS);   // 未单独设置 = 自有 + 手动开了账本的观察钱包
}
// 兜底快照按当前勾选过滤 (配置变更后旧快照可能含未勾选钱包)
function filterIdleByWallets(idle, walletsSel) {
  if (!idle || !idle.byWallet) return idle;
  const allow = new Set(walletsSel.map(w => w.address.toLowerCase()));
  const byWallet = {}; let totalUSD = 0;
  for (const [a, w] of Object.entries(idle.byWallet)) {
    if (!allow.has(a.toLowerCase())) continue;
    byWallet[a] = w; totalUSD += w.totalUSD || 0;
  }
  return { totalUSD, byWallet };
}

// ============================================================
// 初始资金 (净入金) 回溯 — fundingFromLogs 链 (rh)
// 口径: ERC20 Transfer 日志 + 原生 ETH 直转 (2026-10-02 起; rh RPC 不支持任何 trace 方法、原生转账不出日志 → 走 blockscout 地址交易, 见 scanNativeFunding);
//   对手=合约的转账全部排除 (swap 结算/LP 出入金/router 都是合约对手);
//   计入: 对手=外部 EOA / 本链监控钱包(标"内部", 聚合视图双向抵消) / 铸入销毁(桥);
//   计价: 稳定币=1, WETH=转账时点 ETH 价(coingecko 小时级), 股票代币=当前美股行情近似,
//         其他 token=最近一轮 LP 定价的当前价近似 (历史价不可得, 前端注明);
//   高频 bot 钱包 (原始 Transfer 超 FUNDING_RAW_LIMIT) 直接放弃并标注 — 宁缺毋滥
// ============================================================
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const FUNDING_RAW_LIMIT = 8000;
function fundingFile(chainId) { return path.join(__dirname, `funding-cache-${chainId}.json`); }
function loadFundingCache(chainId) {
  const st = chainState(chainId);
  if (!st.fundingCache) {
    st.fundingCache = readJsonOrEmpty(fundingFile(chainId)) || {};   // 2026-09-28 审计修复: 坏文件改名留证
  }
  return st.fundingCache;
}
function saveFundingCache(chainId) {
  try { writeJsonAtomic(fundingFile(chainId), chainState(chainId).fundingCache || {}); } catch {}   // 2026-09-28 审计修复: 原子写
}
// 2026-10-02: rh 原生 ETH 直转 (EOA↔EOA) 也算充提. 之前只认 ERC20 日志: 从外部地址收的 ETH、转回外部地址的 ETH 全看不见,
//   净入金少记 → 总体盈亏虚高同样多. 数据源 = blockscout 地址顶层交易 (原生直转都在里面; 合约转出的内部转账对手是合约, 本来就不计), 见 blockscoutTopTxs.
//   blockscout 在 Cloudflare 后面, node fetch / curl 一律 403 → cf-get.py (curl_cffi 仿 Chrome TLS 指纹) 子进程取
const CFFI_PY = process.env.CFFI_PYTHON || '/home/ubuntu/.venvs/cffi/bin/python';
const CF_GET = path.join(__dirname, 'cf-get.py');
const NATIVE_OVERLAP = 50000;               // 每轮从游标往回重扫的块数 (rh ~10 块/秒 ≈ 1.4h), 盖住 blockscout 落后链头; 以 id 去重
const NATIVE_MIN_GAP_MS = 4 * 60 * 1000;    // 同一钱包两次原生扫描最小间隔 (强刷也同步跑资金队列, 别每次都多等子进程)
// blockscout 限流按 IP、两个桶各算各的 (10-02 实测响应头): 旧版 /api 每「整点小时」只给 10 次 (reset 指到下个整点), /api/v2 每整 5 分钟 150 次.
//   所以地址交易一律走 v2 (blockscoutTopTxs), 旧版 /api 不再用. 回 429 就按头里的 reset 歇到窗口结束 (没给就歇 5 分钟), 期间该桶直接返回 null 不再打.
const cfBackoff = new Map();
const CF_BACKOFF_MS = 5 * 60 * 1000;
const CF_BACKOFF_MAX_MS = 65 * 60 * 1000;
const cfBucket = url => { try { const u = new URL(url); return u.host + (u.pathname.startsWith('/api/v2/') ? ':v2' : ':api'); } catch { return url; } };
let cfGetWarned = 0;
// 失败一律 resolve(null); 传了 meta 时标 meta.transient = 限流/5xx/网络/超时/没装 curl_cffi (下轮能好), 否则是确定性的 (404 等, 账本补查按次数放弃)
function cfGetJson(url, what = 'rh 原生 ETH 充提', meta) {
  const bucket = cfBucket(url);
  if (Date.now() < (cfBackoff.get(bucket) || 0)) { if (meta) meta.transient = true; return Promise.resolve(null); }
  return new Promise(resolve => {
    require('child_process').execFile(CFFI_PY, [CF_GET, url], { timeout: 90000, maxBuffer: 64 << 20 }, (err, out, errOut) => {
      if (err) {
        const msg = String(errOut || err.message).trim();
        const http = err.code === 2 && /HTTP (\d+)/.exec(msg);
        if (http && http[1] === '429') {
          const reset = Number((/reset=(\d+)/.exec(msg) || [])[1]);
          cfBackoff.set(bucket, Date.now() + (reset > 0 && reset <= CF_BACKOFF_MAX_MS ? reset + 2000 : CF_BACKOFF_MS));
        }
        if (meta) meta.transient = !(http && +http[1] >= 400 && +http[1] < 500 && http[1] !== '429');
        if (Date.now() - cfGetWarned > 600000) { cfGetWarned = Date.now(); console.error(`[cf-get] 失败 (${err.code === 'ENOENT' ? '没有 ' + CFFI_PY : msg.slice(0, 80)}); ${what}本轮跳过, 下轮重试`); }
        return resolve(null);
      }
      try { resolve(JSON.parse(out)); } catch { if (meta) meta.transient = true; resolve(null); }
    });
  });
}
// 返回 true = 扫到 latest; false = 失败/没扫完 (游标停在已处理处, 下轮续)
// 地址顶层交易 (blockscout v2 /addresses/{a}/transactions, 新→旧每页 50; 2026-10-02 起替代旧版 txlist, 旧版每小时只给 10 次):
//   扫 [since, to] 块区间, 只把成功且 value>0 的交易交给 onTx({ hash, b, ts, from, to, v }). 翻到 since 以下或翻到底 = 扫完, 返回 to (调用方把游标前移到这);
//   一次最多翻 V2_PAGES_PER_CALL 页, 没翻完 (首扫/大钱包) 或取失败返回 null, 翻页游标记在 holder[key] 下次接着翻 (此时沿用当初的 since/to, 不重头来).
//   onTx 可能对同一笔调用多次 (区间重叠 / 失败重翻), 调用方须按 hash 去重或幂等写.
const V2_PAGES_PER_CALL = 8;
async function blockscoutTopTxs(chainId, addr, since, to, holder, key, onTx, what) {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg.blockscout) return null;
  const p = holder[key] || { since, to, q: null };
  for (let page = 0; page < V2_PAGES_PER_CALL; page++) {
    const j = await cfGetJson(`${cfg.blockscout}/api/v2/addresses/${addr}/transactions${p.q ? '?' + new URLSearchParams(p.q) : ''}`, what);
    if (!j || !Array.isArray(j.items)) return null;
    for (const x of j.items) {
      const b = Number(x.block_number ?? x.block);
      if (!(b > 0) || b > p.to) continue;                            // pending / 超出本次区间 (下次从 to 往回重叠扫时会拿到)
      if (b < p.since) { delete holder[key]; return p.to; }
      if (x.status !== 'ok') continue;                               // 回滚的交易 value 没转出去
      let v; try { v = BigInt(x.value || '0'); } catch { continue; }
      if (v === 0n) continue;
      await onTx({ hash: String(x.hash).toLowerCase(), b, ts: Date.parse(x.timestamp) || 0,
        from: String(x.from?.hash || '').toLowerCase(), to: String(x.to?.hash || '').toLowerCase(), v });
    }
    if (!j.next_page_params) { delete holder[key]; return p.to; }
    p.q = j.next_page_params; holder[key] = p;
  }
  return null;
}
async function scanNativeFunding(chainId, cur, addr, monitored, latest) {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg.blockscout) return true;
  if (cur.nTo >= 0 && cur.nAt && Date.now() - cur.nAt < NATIVE_MIN_GAP_MS) return !cur.nStopped;
  const wn = cfg.wrappedNative.toLowerCase();
  const seen = new Set(cur.events.map(e => e.id));
  const since = cur.nTo >= 0 ? Math.max(0, cur.nTo - NATIVE_OVERLAP) : 0;
  const to = await blockscoutTopTxs(chainId, addr, since, latest, cur, 'nPend', async t => {
    if (!t.to || t.from === t.to) return;                          // 建合约 / 自转
    const dir = t.to === addr ? 'in' : t.from === addr ? 'out' : null;
    if (!dir) return;
    const id = `${t.hash}-v`;                                      // 与 Ankr 链充提记录的原生腿同一 id 形状
    if (seen.has(id)) return;
    const cp = dir === 'in' ? t.from : t.to;
    let ct;
    if (monitored.has(cp)) ct = 'internal';
    else if (await isContract(chainId, cp)) return;                // 合约对手 (router 付款 / 买卖) = 交易行为, 排除 (与 ERC20 同口径)
    else ct = 'external';
    const amt = Number(t.v) / 1e18;
    const { price, approx } = await fundingTokenPrice(chainId, wn, t.ts);
    const ev = { id, b: t.b, ts: t.ts, dir, tok: ethers.ZeroAddress, sym: 'ETH', amt, usd: 0, cp, ct };
    if (price > 0) ev.usd = amt * price;
    else { ev.usd = amt * ((chainState(chainId).lastUsdPrices || {})[wn] || 0); ev.rp = 1; }   // coingecko 没取到: 先按现价, 打标下轮重取
    if (approx || ev.rp) ev.ax = 1;
    if (ev.usd < 1 && !ev.rp) return;                              // 灰尘
    seen.add(id);
    cur.events.push(ev);
  }, 'rh 原生 ETH 充提');
  cur.nAt = Date.now();
  if (to == null) { cur.nStopped = 'rpc'; return false; }          // 取失败 / 没翻完: 游标不动, 翻页位置在 nPend, 下轮续
  cur.nTo = to; cur.nStopped = null;
  return true;
}
// 上轮按现价顶上的 ETH / WETH 事件 (rp): 再取一次当时价, 拿到就改成精确值
async function repriceFundingNative(cur) {
  for (const e of cur.events) {
    if (!e.rp) continue;
    const p = await ethUsdAtTime(e.ts);
    if (p > 0) { e.usd = e.amt * p; delete e.rp; delete e.ax; }
  }
}
const codeCache = {};   // `${chainId}:${addr}` -> 是否合约 (进程级; 判定失败不缓存下轮重试)
async function isContract(chainId, addr) {
  const key = chainId + ':' + addr;
  if (key in codeCache) return codeCache[key];
  try {
    const code = await withRetry(() => chainState(chainId).provider.getCode(addr), 2, 500);
    capCache(codeCache);   // 2026-09-28 审计修复: 进程级字典上限 5 万, 超了清一半
    codeCache[key] = !!code && code !== '0x';
    return codeCache[key];
  } catch { return true; }   // 拿不到按合约处理 (宁可漏记不错记)
}
async function fundingBlockTs(chainId, block) {
  const st = chainState(chainId);
  st.blockTsCache = st.blockTsCache || {};
  if (st.blockTsCache[block]) return st.blockTsCache[block];
  try {
    const b = await withRetry(() => st.provider.getBlock(block), 2, 500);
    if (b) { capCache(st.blockTsCache); st.blockTsCache[block] = b.timestamp * 1000; return st.blockTsCache[block]; }   // 2026-09-28 审计修复: 上限 5 万
  } catch {}
  return 0;
}
// 自适应分段单方向扫描; stopped: null=完成 | 'budget'=量超限(bot) | 'rpc'=段失败(下轮续)
async function scanTransfersAdaptive(chainId, topics, fromBlock, toBlock, budget) {
  const st = chainState(chainId);
  const out = [];
  let f = fromBlock, chunk = Math.min(5000000, EVM_CHAINS[chainId].logChunk || 5000000), stopped = null;
  while (f <= toBlock) {
    if (out.length > budget) { stopped = 'budget'; break; }
    const to = Math.min(f + chunk - 1, toBlock);
    try {
      const logs = await st.provider.send('eth_getLogs', [{
        fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16), topics,
      }]);
      for (const l of logs) out.push(l);
      f = to + 1;
      if (chunk < 5000000) chunk = Math.min(chunk * 2, 5000000);
      await sleep(700);
    } catch (e) {
      if (chunk > 150000) { chunk = Math.floor(chunk / 4); await sleep(1500); continue; }
      stopped = 'rpc'; break;
    }
  }
  return { logs: out, scannedTo: f - 1, stopped };
}
async function fundingTokenPrice(chainId, token, tsMs) {
  const cfg = EVM_CHAINS[chainId];
  if (cfg.stables[token]) return { price: 1, approx: false };
  if (token === cfg.wrappedNative.toLowerCase()) {
    const p = await ethUsdAtTime(tsMs);
    return { price: p || 0, approx: !p };
  }
  if (chainId === 'rh') {
    for (const t of rhStockTokens()) if (t.addr === token) {
      return { price: rhStockQuotes()[t.sym]?.price || 0, approx: true };   // 当前行情近似
    }
  }
  const st = chainState(chainId);
  return { price: (st.lastUsdPrices || {})[token] || 0, approx: true };     // LP 当前价近似
}
async function scanWalletFunding(chainId, wallet) {
  const st = chainState(chainId);
  const cache = loadFundingCache(chainId);
  const addr = wallet.address.toLowerCase();
  const cur = cache[addr] || (cache[addr] = { scannedTo: -1, stopped: null, events: [], inUSD: 0, outUSD: 0 });
  if (cur.stopped === 'budget') return cur;   // bot 钱包已放弃, 不再扫
  await repriceFundingNative(cur);
  const latest = await st.provider.getBlockNumber();
  const from = cur.scannedTo + 1;
  if (from > latest) return cur;
  const padded = ethers.zeroPadValue(addr, 32);
  const rIn = await scanTransfersAdaptive(chainId, [TRANSFER_TOPIC, null, padded], from, latest, FUNDING_RAW_LIMIT);
  if (rIn.stopped === 'budget') { cur.stopped = 'budget'; cur.events = []; cur.inUSD = 0; cur.outUSD = 0; saveFundingCache(chainId); return cur; }
  const rOut = await scanTransfersAdaptive(chainId, [TRANSFER_TOPIC, padded], from, latest, FUNDING_RAW_LIMIT);
  if (rOut.stopped === 'budget') { cur.stopped = 'budget'; cur.events = []; cur.inUSD = 0; cur.outUSD = 0; saveFundingCache(chainId); return cur; }
  // 两方向进度取小者, 超出部分丢弃 (下轮重扫, 以 id 去重)
  const scannedTo = Math.min(rIn.scannedTo, rOut.scannedTo);
  const monitored = new Set(loadWallets(chainId).map(w => w.address.toLowerCase()));
  const seen = new Set(cur.events.map(e => e.id));
  const zero32 = '0x' + '0'.repeat(64);
  const raw = new Map();   // id -> log (in/out 两次扫描自转会重复)
  for (const l of [...rIn.logs, ...rOut.logs]) {
    if (!l.topics || l.topics.length !== 3) continue;             // ERC721 的 Transfer 是 4 topics
    if (parseInt(l.blockNumber, 16) > scannedTo) continue;
    raw.set(l.transactionHash + '-' + parseInt(l.logIndex, 16), l);
  }
  const cfg = EVM_CHAINS[chainId];
  const stockSet = chainId === 'rh' ? new Set(rhStockTokens().map(t => t.addr)) : new Set();
  for (const [id, l] of raw) {
    if (seen.has(id)) continue;
    const token = l.address.toLowerCase();
    // 快筛: 完全无定价途径的 token (垃圾空投) 不值得花 getCode/getBlock
    const priceable = cfg.stables[token] || token === cfg.wrappedNative.toLowerCase()
      || stockSet.has(token) || (st.lastUsdPrices || {})[token] > 0;
    if (!priceable) continue;
    const fromA = '0x' + l.topics[1].slice(26), toA = '0x' + l.topics[2].slice(26);
    if (fromA === toA) continue;                                   // 自转
    const dir = toA === addr ? 'in' : 'out';
    const cp = dir === 'in' ? fromA : toA;
    let ct;
    if (l.topics[1] === zero32) ct = 'mint';
    else if (l.topics[2] === zero32) ct = 'burn';
    else if (monitored.has(cp)) ct = 'internal';
    else if (await isContract(chainId, cp)) continue;              // 合约对手 = 交易行为, 排除
    else ct = 'external';
    const meta = await getTokenInfo(chainId, token);
    const amt = Number(BigInt(l.data)) / 10 ** (meta?.decimals ?? 18);
    if (!(amt > 0)) continue;
    const b = parseInt(l.blockNumber, 16);
    const ts = await fundingBlockTs(chainId, b);
    let { price, approx } = await fundingTokenPrice(chainId, token, ts);
    let rp = 0;
    // 2026-10-02: WETH 的 coingecko 当时价没取到, 旧版 usd=0 当灰尘丢掉且游标照样前移 = 永久漏记; 改按现价顶上打标, 下轮 repriceFundingNative 重取
    if (!(price > 0) && token === cfg.wrappedNative.toLowerCase()) { price = (st.lastUsdPrices || {})[token] || 0; rp = 1; }
    const usd = amt * price;
    if (usd < 1 && !rp) continue;                                  // 灰尘
    const ev = { id, b, ts, dir, tok: token, sym: meta?.symbol || token.slice(0, 6), amt, usd, cp, ct };
    if (approx || rp) ev.ax = 1;                                   // 2026-10-02: 近似价 (现价折算) 打标, 前端充提记录标 *
    if (rp) ev.rp = 1;
    cur.events.push(ev);
  }
  await scanNativeFunding(chainId, cur, addr, monitored, latest);   // 2026-10-02: 原生 ETH 直转 (进度另记 nTo / nStopped)
  cur.events.sort((a, b2) => b2.ts - a.ts);
  cur.inUSD = cur.events.filter(e => e.dir === 'in').reduce((s, e) => s + e.usd, 0);
  cur.outUSD = cur.events.filter(e => e.dir === 'out').reduce((s, e) => s + e.usd, 0);
  cur.scannedTo = scannedTo;
  cur.stopped = (rIn.stopped || rOut.stopped) ? 'rpc' : null;     // rpc 止步: 下轮从 scannedTo+1 续 (原生 ETH 的进度另记 nTo / nStopped)
  cur.updatedAt = Date.now();
  saveFundingCache(chainId);
  return cur;
}
// funding 缓存 → 注入形状 (与 flows.fundingOf 一致); 2026-10-02 前的旧事件没有 tok/ax: 稳定币与 WETH 是转账时点价, 其余 (股票/其他代币) 都是现价近似
function rhFundingOf(chainId, a) {
  const f = loadFundingCache(chainId)[a.toLowerCase()];
  if (!f || (!f.updatedAt && f.stopped !== 'budget')) return null;
  if (f.stopped === 'budget') return { partial: true };
  const exact = new Set([...Object.values(EVM_CHAINS[chainId].stables), 'WETH']);
  // 2026-10-02: 原生 ETH 没扫完 (blockscout 取不到 / 还没扫过) 也算追赶中; 不在充提队列里的钱包 (09-28 前留下的旧条目) 不会再扫, 不标
  const sel = fundingQueued[chainId];
  const nPending = !!f.nStopped || (!(f.nTo >= 0) && (!sel || sel.has(a.toLowerCase())));
  return { inUSD: f.inUSD || 0, outUSD: f.outUSD || 0, netUSD: (f.inUSD || 0) - (f.outUSD || 0), partial: false, catchingUp: f.stopped === 'rpc' || nPending,
    events: (f.events || []).map(e => (e.tok || exact.has(e.sym)) ? e : { ...e, ax: 1 }) };
}
// 充提记录 / 净入金从缓存注入 idle (零 RPC, 幂等): 仓位刷新时注入一次, 接口返回时再注一次 —— 后台队列刚扫完的不必等下轮仓位刷新 (重启后首轮刷新常早于扫描)
function injectFunding(chainId, idle) {
  if (!idle || !idle.byWallet) return;
  if (EVM_CHAINS[chainId].fundingFromLogs) flows.injectIdle(idle, a => rhFundingOf(chainId, a));
  else if (flows.enabled(chainId)) flows.injectIdle(idle, a => flows.fundingOf(chainId, a));
}
const fundingRunning = {};
const fundingQueued = {};   // 链 -> 本轮充提队列的地址集 (rhFundingOf 判「原生 ETH 还没扫」要不要标追赶中)
async function runFundingQueue(chainId) {
  if (fundingRunning[chainId]) return;
  fundingRunning[chainId] = true;
  try {
    const WALLETS = fundSelected(loadFundCfgEvm(), chainId, loadActiveWallets(chainId));
    fundingQueued[chainId] = new Set(WALLETS.map(w => w.address.toLowerCase()));
    for (const w of WALLETS) {
      try {
        const r = await scanWalletFunding(chainId, w);
        console.log(`[${chainId}] funding ${w.name}: ${r.stopped === 'budget' ? '高频钱包放弃' : `${r.events.length} 笔 (原生 ETH ${r.events.filter(e => e.id.endsWith('-v')).length}), 净入金 $${(r.inUSD - r.outUSD).toFixed(0)}${r.stopped === 'rpc' ? ' (RPC 止步下轮续)' : ''}${r.nStopped ? ' (原生 ETH 未扫完下轮续)' : ''}`}`);
      } catch (e) { console.error(`[${chainId}] funding scan ${w.name}:`, e.message?.slice(0, 80)); }
      await sleep(1200);
    }
  } finally { fundingRunning[chainId] = false; }
}

// --- 价格方向归一: 稳定币放 token1 侧 ---
function normalizePosition(chainId, pos) {
  const cfg = EVM_CHAINS[chainId];
  // 2026-09-28 审计修复: 已归一过的仓 (失败钱包沿用 lastGood 的上轮对象) 不再二次交换 —— 两侧都是稳定币的池会每轮来回翻转 (连带 collectedFees)
  if (pos._normalized) return pos;
  const t0addr = (pos.token0addr || '').toLowerCase();
  if (cfg.stables[t0addr]) {
    return {
      ...pos,
      token0: pos.token1, token1: pos.token0,
      token0addr: pos.token1addr, token1addr: pos.token0addr,
      token0USD: pos.token1USD, token1USD: pos.token0USD,
      amount0: pos.amount1, amount1: pos.amount0,
      feesOwed0: pos.feesOwed1, feesOwed1: pos.feesOwed0,
      // 2026-09-28 审计修复: collectedFees 也随 token0/token1 交换 (之前漏了, 归一后按 token 看已领费会左右颠倒)
      collectedFees: pos.collectedFees ? { ...pos.collectedFees, token0: pos.collectedFees.token1, token1: pos.collectedFees.token0 } : pos.collectedFees,
      currentPrice: pos.currentPrice > 0 ? 1 / pos.currentPrice : 0,
      lowerPrice: pos.upperPrice > 0 ? 1 / pos.upperPrice : 0,
      upperPrice: pos.lowerPrice > 0 ? 1 / pos.lowerPrice : 0,
      _normalized: true,
    };
  }
  return pos;
}

// --- 主拉取 (SWR 缓存, 与 server.js 同策略) ---
const CACHE_TTL = 5 * 60 * 1000; // 2026-09-05 由 10min 调快
// 立即触发一轮后台刷新 (钱包增删后使用; 老缓存继续对外服务, 不阻塞不清空)
// in-flight 归属登记: 只有当前登记的 promise 结束时才清标志 —— 被看门狗放弃的僵尸轮
// 迟到 settle 时不得误清新一轮的标志 (fetchInner 内另有 fetchGen 防僵尸写缓存)
function trackFetch(chainId, p, onDone, onFail) {
  const st = chainState(chainId);
  p.finally(() => { if (st.fetchInFlight === p) st.fetchInFlight = null; }).catch(() => {});
  st.fetchInFlight = p;
  // 2026-09-28 审计修复: 日志回调挂在旁路, 登记/返回的始终是 fetchInner 的原始 promise (resolve 成完整载荷) ——
  //   之前调用方传进来的是 .then(log)/.catch(log) 之后的 promise (resolve 成 undefined), 复用 in-flight 的请求会拿到空 body
  p.then(onDone || undefined, onFail || undefined).catch(() => {});
  return p;
}
function kickRefresh(chainId) {
  const st = chainState(chainId);
  if (st.fetchInFlight) return;
  trackFetch(chainId, fetchInner(chainId, false), null, e => console.error(`[${chainId}] kick refresh failed:`, e.message));
}
async function fetchChainPositions(chainId, forceRefresh = false) {
  const st = chainState(chainId);
  const fresh = st.cache.data && (Date.now() - st.cache.timestamp < CACHE_TTL);
  if (!forceRefresh && fresh) return st.cache.data;
  if (!forceRefresh && st.cache.data) {
    if (!st.fetchInFlight) {
      trackFetch(chainId, fetchInner(chainId, false), null, e => console.error(`[${chainId}] bg refresh failed:`, e.message));
    }
    return st.cache.data;
  }
  if (st.fetchInFlight) {
    // 2026-09-28 审计修复: 撞上正在跑的一轮 (后台/定时/预热) → 复用它, 等它结束后返回缓存里的完整载荷;
    //   之前直接 return st.fetchInFlight, 登记的又是 .then(log) 之后的 promise, ?refresh=true 拿到的是 undefined (空 body)
    try { await st.fetchInFlight; } catch (e) { if (!st.cache.data) throw e; }
    if (st.cache.data) return st.cache.data;
    throw new Error('刷新完成但没有可用数据');
  }
  return trackFetch(chainId, fetchInner(chainId, forceRefresh));
}

// =============================================================
// 最后领费时间 lastCollectAt —— 「当前日化」的计时起点 (分子=未领手续费, 分母=距上次领取)
// 缺了它, 领费后分子归零而分母继续从建仓算, 日化被系统性低估且越老越低.
// - eth/base V3: 子图 PositionSnapshot —— 「累计已领 >= 当前总已领」的最早一条快照即最后一次 Collect
//   (Collect 实体的 owner 恒为 NPM 无法按钱包过滤, 故不用它)
// - eth/base V4: 子图 ModifyLiquidity 按 pool+ticks+origin 反查 (V4 子图无 salt/tokenId 字段).
//   V4 任何 modifyLiquidity 都会顺带把手续费结算给 owner, 所以「最近一笔」就是费归零的时刻.
//   ⚠ 同一 EOA 在同池开了区间完全相同的两仓会撞在一起 (与建仓回溯的 pool+ticks+origin 同款取舍)
// - rh: 无子图 → 扫 PoolManager 日志 (topics: poolId + sender=PositionManager), data 里 salt=tokenId 匹配.
//   每池一个游标增量扫: rh 出块 0.1s, 一轮 5min 只有 ~3000 块, 稳态成本 = 每池 1 次 getLogs.
//   首扫回看上限 500 万块 (~5.8 天), 更早的领取不追 —— 查不到就退回按建仓起算 (即改动前的行为)
// - 一律要求晚于建仓 60s 才算「领过」: 建仓本身也是一条 ModifyLiquidity, 否则会被误判
// =============================================================
const COLLECT_MIN_GAP = 60000;
const V4_COLLECT_MAX_BACKFILL = 5000000;

// BigDecimal 过滤值: 子图不吃科学计数法, 极小/极大值宁可放弃该仓
function decStr(v) {
  if (!(v > 0) || !isFinite(v)) return null;
  const s = v.toFixed(18);
  return (s.includes("e") || s.includes("E")) ? null : s;
}

async function v3LastCollectSubgraph(chainId, positions) {
  const cfg = EVM_CHAINS[chainId];
  const jobs = [];
  for (const p of positions) {
    // 2026-09-28 审计修复: 失败钱包沿用 lastGood 的上轮仓位已归一过 (collectedFees 随 token0/1 交换), 查子图要换回池子原始 token0/token1 方向
    const cfRaw = p.collectedFees || {};
    const cf = p._normalized ? { token0: cfRaw.token1, token1: cfRaw.token0 } : cfRaw;
    // 2026-09-28 审计修复: 两侧都参与 —— 同一 where 里两个 _gte 即 AND: 「两侧累计都已到达当前值」的最早快照 = 最后一次 Collect
    //   (之前只看 token0>0 那一侧, 最后一次只领到 token1 的仓会拿到更早那次的时间; 等价于任务里「两次查询取最大 timestamp」;
    //    若用 or 会取更早到达的一侧, 同样偏早, 故不用 or)
    const s0 = decStr((cf.token0 || 0) * 0.999999), s1 = decStr((cf.token1 || 0) * 0.999999);   // 浮点等值比较不可靠, 留 1e-6 余量
    if (!s0 && !s1) continue;               // 从未领过 → 计时起点保持建仓时间
    const conds = [];
    if (s0) conds.push(`collectedFeesToken0_gte:"${s0}"`);
    if (s1) conds.push(`collectedFeesToken1_gte:"${s1}"`);
    jobs.push({ p, cond: conds.join(",") });
  }
  for (let i = 0; i < jobs.length; i += 30) {
    const batch = jobs.slice(i, i + 30);
    const q = batch.map((j, k) => `p${k}: positionSnapshots(where:{position:"${j.p.tokenId}",${j.cond}},orderBy:timestamp,orderDirection:asc,first:1){timestamp}`).join(" ");
    const d = await graphQueryRetry(cfg.v3SubgraphId, `{ ${q} }`, 2, 600);
    if (!d) continue;
    batch.forEach((j, k) => {
      const ts = Number(d[`p${k}`]?.[0]?.timestamp || 0) * 1000;
      if (ts > (j.p.createdAt || 0) + COLLECT_MIN_GAP) j.p.lastCollectAt = ts;
    });
  }
}

async function v4LastCollectSubgraph(chainId, positions) {
  const cfg = EVM_CHAINS[chainId];
  for (let i = 0; i < positions.length; i += 30) {
    const batch = positions.slice(i, i + 30);
    const q = batch.map((p, k) => `p${k}: modifyLiquidities(where:{pool:"${String(p.poolAddress).toLowerCase()}",tickLower:${p.tickLower},tickUpper:${p.tickUpper},origin:"${String(p.walletAddress).toLowerCase()}"},orderBy:timestamp,orderDirection:desc,first:1){timestamp}`).join(" ");
    const d = await graphQueryRetry(cfg.v4SubgraphId, `{ ${q} }`, 2, 600);
    if (!d) continue;
    batch.forEach((p, k) => {
      const ts = Number(d[`p${k}`]?.[0]?.timestamp || 0) * 1000;
      if (ts > (p.createdAt || 0) + COLLECT_MIN_GAP) p.lastCollectAt = ts;
    });
  }
}

// 持久化: { at: {tokenId: ms}, cur: {poolId: 已扫到块}, seen: {tokenId: 1} }
function v4CollectState(chainId) {
  const st = chainState(chainId);
  if (!st.v4CollectCache) {
    st.v4CollectFile = path.join(__dirname, `v4collect-cache-${chainId}.json`);
    let c = { at: {}, cur: {}, seen: {} };
    const s = readJsonOrEmpty(st.v4CollectFile, null);   // 2026-09-28 审计修复: 坏文件改名留证
    if (s && typeof s === 'object') c = { at: s.at || {}, cur: s.cur || {}, seen: s.seen || {} };
    st.v4CollectCache = c;
  }
  return st.v4CollectCache;
}

async function v4LastCollectRPC(chainId, positions) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const c = v4CollectState(chainId);
  const latest = (await st.provider.getBlockNumber()) - 12;   // 2026-09-28 审计修复: 与枚举同样滞后 12 块确认, 池游标不推进到未确认的链头
  // 小段+限速链 (arc): 回看不早于 V4 枚举起点 (主网公开块), 且每轮只给 150s 预算 —— 一个池从起点扫到链头 ≈ 60 窗 × 2s,
  // 30 天回看窗按 0.51s/块是 500 万块 (500 窗 ≈ 17 分钟/池), 同步跑会把整轮 fetch 拖过看门狗。
  // 没扫完的池游标不推进, 下轮接着扫; 期间这些仓的日化按建仓时点起算 (与没有领费记录时一致)。
  const paced = !!cfg.logGapMs;
  const floor = Math.max(0, latest - V4_COLLECT_MAX_BACKFILL, paced ? (cfg.v4.deployBlock || 0) : 0);
  const budgetMs = paced ? 150 * 1000 : Infinity;
  const t0 = Date.now();
  const byPool = new Map();
  for (const p of positions) {
    const a = byPool.get(p.poolAddress) || []; a.push(p); byPool.set(p.poolAddress, a);
  }
  let dirty = false, skipped = 0;
  for (const [poolId, arr] of byPool) {
    if (Date.now() - t0 > budgetMs) { skipped++; continue; }
    let from = c.cur[poolId] ? c.cur[poolId] + 1 : floor;
    // 本池出现没见过的仓 (新开/新加的钱包) → 起点拉回回看窗口下沿补历史
    if (arr.some(p => !c.seen[p.tokenId])) from = Math.min(from, floor);
    if (from > latest) continue;
    let logs;
    try {
      logs = await scanLogsChunked(chainId, {
        address: cfg.v4.poolManager,
        topics: [V4_MODIFY_TOPIC, poolId, ethers.zeroPadValue(cfg.v4.pm, 32)],
      }, from, 1000000, latest);
    } catch (e) {
      console.error(`  [${chainId}] V4 领费扫描失败 pool ${String(poolId).slice(0, 10)}:`, e.message?.slice(0, 80));
      continue;                              // 游标不推进, 下轮重扫同一段
    }
    const wanted = new Set(arr.map(p => String(p.tokenId)));
    const last = {};
    for (const lg of logs) {
      // data 布局: tickLower(32B) tickUpper(32B) liquidityDelta(32B) salt(32B)
      const salt = BigInt("0x" + lg.data.slice(2).slice(192, 256)).toString();
      if (!wanted.has(salt)) continue;
      const bn = parseInt(lg.blockNumber, 16);
      if (bn > (last[salt] || 0)) last[salt] = bn;
    }
    for (const [tid, bn] of Object.entries(last)) {
      const b = await withRetry(() => st.provider.getBlock(bn)).catch(() => null);
      if (b) { c.at[tid] = b.timestamp * 1000; dirty = true; }
    }
    for (const p of arr) c.seen[p.tokenId] = 1;
    c.cur[poolId] = latest;
    dirty = true;
  }
  if (skipped) console.log(`  [${chainId}] V4 领费扫描本轮预算用完, ${skipped} 个池留到下轮`);
  for (const p of positions) {
    const ms = c.at[p.tokenId];
    if (ms > (p.createdAt || 0) + COLLECT_MIN_GAP) p.lastCollectAt = ms;
  }
  if (dirty) { try { writeJsonAtomic(st.v4CollectFile, st.v4CollectCache); } catch {} }   // 2026-09-28 审计修复: 原子写
}

// 定价前统一填 lastCollectAt; 任何一条腿失败都只是退回「按建仓起算」, 不影响本轮其余数据
async function fillLastCollect(chainId, walletResults) {
  const cfg = EVM_CHAINS[chainId];
  const v3 = [], v4 = [];
  for (const wr of walletResults) for (const p of (wr.positions || [])) {
    if (!p.liquidityActive) continue;
    if (p.protocol === "V4") v4.push(p);
    else if (!p.lastCollectAt) v3.push(p);   // rh V3 已由 Collect 事件扫描填好, 别覆盖
  }
  try {
    if (cfg.v3SubgraphId && v3.length) await v3LastCollectSubgraph(chainId, v3);
  } catch (e) { console.error(`  [${chainId}] V3 领费时间填充失败:`, e.message?.slice(0, 80)); }
  try {
    if (v4.length) {
      if (cfg.v4SubgraphId) await v4LastCollectSubgraph(chainId, v4);
      else await v4LastCollectRPC(chainId, v4);
    }
  } catch (e) { console.error(`  [${chainId}] V4 领费时间填充失败:`, e.message?.slice(0, 80)); }
  const tot = v3.length + v4.length;
  if (tot) console.log(`  [${chainId}] 领费时间: ${[...v3, ...v4].filter(p => p.lastCollectAt).length}/${tot} 仓有记录`);
}

async function fetchInner(chainId, forceRefresh) {
  const st = chainState(chainId);
  const startedAt = Date.now();
  st.fetchStartedAt = startedAt;
  const cfg = EVM_CHAINS[chainId];
  // 强刷不再清 v4IdCache: 枚举缓存有链上 balanceOf 计数做失效判据, 计数一致即可信;
  // 清掉会触发全部钱包的全链 Transfer 重扫 (rh 手动刷新慢的主因, RPC 紧张时还会雪崩)

  const WALLETS = loadActiveWallets(chainId);
  const npm = new ethers.Contract(cfg.v3.npm, V3_NPM_ABI, st.provider);
  const factory = new ethers.Contract(cfg.v3.factory, FACTORY_ABI, st.provider);
  const v4pm = new ethers.Contract(cfg.v4.pm, V4_PM_ABI, st.provider);
  const stateView = new ethers.Contract(cfg.v4.stateView, V4_STATE_VIEW_ABI, st.provider);

  console.log(`[${chainId}] Fetching V3+V4 for ${WALLETS.length} wallets...`);
  // 每钱包"最后一次成功"快照, 跨轮次保留: 连续失败/缓存被动清空时都还有兜底
  // (旧实现只看上一轮缓存, 单轮全灭后兜底即丢 — 2026-09-03 某钱包消失 20 分钟的帮凶)
  st.lastGood = st.lastGood || {};
  for (const w of (st.cache.data?.wallets || [])) {
    const k = w.address.toLowerCase();
    if (!st.lastGood[k]) st.lastGood[k] = w;
  }

  let walletResults = [];
  const failedWallets = [];   // 2026-09-28 审计修复: 本轮抓取失败的钱包 (小写地址), 进载荷顶层供 snapshot/notifier/前端识别
  // 2026-09-28 审计修复: 僵尸轮护栏 —— 比本轮更晚起跑的一轮已发布 → 本轮不得再覆盖 lastGood / lastUsdPrices / lastIdle (与发布护栏同一代际判据)
  const superseded = () => st.lastPublishStart > startedAt;
  // 串行×2并发: 每个钱包 V3+V4 并行, 钱包间小并发
  for (let i = 0; i < WALLETS.length; i += 2) {
    const batch = WALLETS.slice(i, i + 2);
    const r = await Promise.all(batch.map(async (w) => {
      const [v3, v4] = await Promise.all([
        fetchWalletV3(chainId, w, npm, factory).catch(e => { console.error(`  [${chainId}] ${w.name} V3 failed:`, e.message?.slice(0, 100)); return null; }),
        fetchWalletV4(chainId, w, v4pm, stateView).catch(e => { console.error(`  [${chainId}] ${w.name} V4 failed:`, e.message?.slice(0, 100)); return null; }),
      ]);
      if (v3 === null || v4 === null) {
        failedWallets.push(w.address.toLowerCase());
        // 本轮抓取失败: 沿用最后一次成功快照 (标 _stale), 不要误报为空仓
        const prev = st.lastGood[w.address.toLowerCase()];
        if (prev) { console.log(`  [${chainId}] ${w.name} 本轮失败, 沿用最后成功快照 (${prev.positions.length} 仓)`); return { ...prev, name: w.name, _stale: true }; }
        return { address: w.address, name: w.name, positions: [], totalUSD: 0, _failed: true, _stale: true };
      }
      const wr = { address: w.address, name: w.name, positions: [...(v3 || []), ...(v4 || [])], totalUSD: 0 };
      if (!superseded()) st.lastGood[w.address.toLowerCase()] = wr;   // 定价在后续循环里原地写入同一对象 (僵尸轮不覆盖)
      return wr;
    }));
    walletResults.push(...r);
    await sleep(300);
  }

  // 最后领费时间 (当前日化的计时起点) —— 见 fillLastCollect 顶部注释
  await fillLastCollect(chainId, walletResults);

  // 定价
  const allTokens = new Set(), allPositions = [];
  for (const wr of walletResults) for (const p of wr.positions) {
    allTokens.add(p.token0addr.toLowerCase()); allTokens.add(p.token1addr.toLowerCase());
    allPositions.push(p);
  }
  // 闲置余额候选一并送进定价 (coingecko/池内价/稳定币分支都能覆盖到)
  const idleCand = idleCandidates(chainId, [...allTokens].map(a => a.toLowerCase()));
  const priceMeta = {};   // 2026-09-28 审计修复: getUSDPrices 回报 stale (沿用上轮价) / miss (彻底没价) 两组 token
  const usdPrices = await getUSDPrices(chainId, [...new Set([...allTokens, ...idleCand])], allPositions, priceMeta);
  if (!superseded()) st.lastUsdPrices = usdPrices;   // funding 回溯给非稳定币 token 当前价近似用 (僵尸轮不覆盖)
  const priceMiss = [...allTokens].filter(a => priceMeta.miss.has(a) || priceMeta.stale.has(a)).length;   // 本轮没拿到新鲜价的 LP token 数 (含沿用上轮的)

  let grandTotalUSD = 0, totalActive = 0, totalInRange = 0, totalOutOfRange = 0, totalFees = 0, walletsWithActiveLP = 0;
  for (const wr of walletResults) {
    let walletTotal = 0, hasActive = false;
    for (const pos of wr.positions) {
      const a0 = pos.token0.address.toLowerCase(), a1 = pos.token1.address.toLowerCase();
      const p0 = usdPrices[a0] || 0;
      const p1 = usdPrices[a1] || 0;
      pos.token0USD = p0; pos.token1USD = p1;
      // 2026-09-28 审计修复: 任一侧价是沿用上轮的 → priceStale (仓位对象跨轮复用, 两态都要显式写)
      if (priceMeta.stale.has(a0) || priceMeta.stale.has(a1)) pos.priceStale = true; else delete pos.priceStale;
      pos.positionValueUSD = pos.amount0 * p0 + pos.amount1 * p1;
      pos.feesValueUSD = pos.feesOwed0 * p0 + pos.feesOwed1 * p1;
      pos.totalValueUSD = pos.positionValueUSD + pos.feesValueUSD;

      // 盈亏字段 (pnl-ledger.applyPnl): 开仓成本 / 持币对照→无常损失 / 已领费 / 已提回 / 净利润
      //   rh·arc 账本命中 → 真实成本 (钱包实际付出, 含换币损耗) + 账本里的已领费/已提回;
      //   否则退回建仓回溯 (按开仓时点池价, 标 approx); V4 无子图已领费来源时标 feesUnknown
      {
        const kind = pos.protocol === 'V4' ? 'v4' : 'v3';
        const lg = ledger.positionPnl(chainId, wr.address, kind, pos.tokenId);
        const priceOf = a => usdPrices[a] || 0;
        if (lg) ledger.applyPnl(pos, { cost: lg.cost, approx: lg.approx || lg.inc, source: 'ledger', am: lg.a, costBy: lg.cb, withdrawnUSD: lg.ret, collectedUSD: lg.fees }, priceOf);
        else if (pos.entryValueUSD > 0) ledger.applyPnl(pos, { cost: pos.entryValueUSD, approx: true, source: 'entry', am: pos.entryAm || {}, withdrawnUSD: pos.entryWithdrawnUSD || 0, collectedUSD: pos.protocol === 'V4' ? 0 : undefined, feesUnknown: pos.protocol === 'V4' }, priceOf);
        if (pos.feesOwedUnknown) pos.feesUnknown = true;   // 2026-09-28 审计修复: 未领费读取失败/离谱归零 → feesUnknown (applyPnl 会重置该位, 故放它后面)
      }

      // 2026-09-28 审计修复: 日化计时起点 (最后领费时间, 没有则建仓时间) 距今 < 1h → rateUnstable (照算, 前端打标)
      const rateStart = pos.lastCollectAt || pos.createdAt;
      if (rateStart > 0 && Date.now() - rateStart < 3600000) pos.rateUnstable = true; else delete pos.rateUnstable;
      // 累计日化 (创建至今)
      if (pos.createdAt > 0 && pos.positionValueUSD >= 10) {
        const totalMs = Date.now() - pos.createdAt;
        const totalDays = totalMs / 86400000;
        if (totalDays > 0) {
          // 2026-09-28 审计修复: 已领费优先用账本口径 pos.collectedFeesUSD (applyPnl 按账本/子图算好的美元额), 没有才按 collectedFees × 现价折算
          const cf = pos.collectedFees || { token0: 0, token1: 0 };
          const collectedUSD = (typeof pos.collectedFeesUSD === 'number' && Number.isFinite(pos.collectedFeesUSD)) ? pos.collectedFeesUSD : (cf.token0 * p0 + cf.token1 * p1);
          const totalFeesUSD = collectedUSD + pos.feesValueUSD;
          if (totalFeesUSD > 0) pos.dailyRateCumulative = (totalFeesUSD / pos.positionValueUSD) / totalDays * 100;
          pos.totalDays = totalDays >= 1 ? Math.floor(totalDays) : 0;
          pos.totalHours = Math.floor(totalMs / 3600000);
          pos.totalMinutes = Math.floor((totalMs % 3600000) / 60000);
        }
      }
      // 当前日化 (无 lastCollect 数据, 以创建时间起算)
      const cs = pos.lastCollectAt || pos.createdAt;
      if (cs > 0 && pos.positionValueUSD >= 10 && pos.feesValueUSD > 0) {
        const holdMs = Date.now() - cs;
        const holdDays = holdMs / 86400000;
        if (holdDays > 0) {
          pos.dailyRateCurrent = (pos.feesValueUSD / pos.positionValueUSD) / holdDays * 100;
          pos.holdDays = holdDays >= 1 ? Math.floor(holdDays) : 0;
          pos.holdHours = Math.floor(holdMs / 3600000);
          pos.holdMinutes = Math.floor((holdMs % 3600000) / 60000);
          pos.hasCollected = !!pos.lastCollectAt;
        }
      }

      walletTotal += pos.totalValueUSD;
      totalFees += pos.feesValueUSD;
      if (pos.liquidityActive) {
        totalActive++; hasActive = true;
        if (pos.inRange) totalInRange++; else totalOutOfRange++;
      }
    }
    wr.totalUSD = walletTotal;
    grandTotalUSD += walletTotal;
    if (hasActive) walletsWithActiveLP++;
    wr.positions = wr.positions.map(p => normalizePosition(chainId, p));
    wr.positions.sort((a, b) => b.totalValueUSD - a.totalValueUSD);
  }

  // 本轮起跑后被停用/删除的钱包不发布 (长轮次期间用户点了停用, 别让旧结果把它带回来)
  const stillOn = new Set(loadActiveWallets(chainId).map(w => w.address.toLowerCase()));
  const droppedMid = walletResults.filter(wr => !stillOn.has(wr.address.toLowerCase()));
  if (droppedMid.length) {
    for (const wr of droppedMid) if (st.lastGood) delete st.lastGood[wr.address.toLowerCase()];
    walletResults = walletResults.filter(wr => stillOn.has(wr.address.toLowerCase()));
    ({ grandTotalUSD, totalActive, totalInRange, totalOutOfRange, totalFees, walletsWithActiveLP } = summarizeWallets(walletResults));
    console.log(`[${chainId}] 发布前剔除本轮中途停用/删除的钱包: ${droppedMid.map(w => w.name).join(', ')}`);
  }
  // 2026-09-28 审计修复: 失败但有 lastGood 的钱包 (_stale 且非 _failed) 一律保留在 wallets 里 (沿用上轮仓位, 哪怕上轮是 0 仓), 不走 positions.length 过滤;
  //   没有 lastGood 的失败钱包 (_failed) 不进 wallets, 只进顶层 failedWallets
  const wallets = walletResults.filter(wr => wr.positions.length > 0 || (wr._stale && !wr._failed));
  wallets.sort((a, b) => parseInt((a.name.match(/\d+/) || ['0'])[0]) - parseInt((b.name.match(/\d+/) || ['0'])[0]));
  const failedOn = failedWallets.filter(a => stillOn.has(a));

  // 钱包闲置余额: 按 fund-config 启用/勾选过滤 (已停用钱包不查); 失败沿用上轮快照 (按当前勾选过滤), 不拖累主数据
  const fundCfg = loadFundCfgEvm();
  // 2026-09-28: 余额对全部启用钱包查 (观察钱包的资金快照要用余额); 总览统计条只算自有/例外的那部分由前端按 own 过滤
  const fundWallets = fundCfg.enabled ? WALLETS.filter(w => stillOn.has(w.address.toLowerCase())) : [];
  let idle = null;
  if (fundWallets.length) {
    idle = filterIdleByWallets(st.lastIdle || st.cache.data?.idle || null, fundWallets);
    try {
      idle = await fetchIdleBalances(chainId, fundWallets, idleCand, usdPrices, priceMeta.stale);
      if (!superseded()) st.lastIdle = idle;   // 2026-09-28 审计修复: 僵尸轮不覆盖
    } catch (e) { console.error(`[${chainId}] idle balances failed:`, e.message?.slice(0, 100)); }
  }

  // 强刷时同步跑一轮初始资金增量续扫 (每钱包 1 段×2 方向, 秒级), 让刷新按钮把资金数据一并带新
  if (cfg.fundingFromLogs && fundSelected(fundCfg, chainId, fundWallets).length && forceRefresh) {
    await runFundingQueue(chainId).catch(e => console.error(`[${chainId}] funding sync:`, e.message?.slice(0, 80)));
  }
  // Ankr 链的充提扫描走共用串行队列 (可能正被账本占着), 强刷只踢一下不等, 结果下次刷新带上
  if (!cfg.fundingFromLogs && forceRefresh && flows.enabled(chainId)) {
    setImmediate(() => flows.runQueue(chainId, loadWallets(chainId)).catch(e => console.error(`[${chainId}] flows:`, e.message?.slice(0, 80))));
  }

  // 充提记录 / 净入金: 从缓存注入 (后台队列独立回填, 此处零 RPC)
  injectFunding(chainId, idle);

  const result = {
    wallets, failedWallets: failedOn, grandTotalUSD, idle, timestamp: Date.now(),   // 2026-09-28 审计修复: 顶层 failedWallets (小写地址)
    stats: { totalActive, totalInRange, totalOutOfRange, totalFees, walletsWithActiveLP, totalWallets: stillOn.size, priceMiss },   // 2026-09-28 审计修复: priceMiss
  };
  if (st.lastPublishStart > startedAt) {
    // 比本轮更晚起跑的一轮已发布 (本轮是被看门狗放弃后迟到完成的僵尸轮): 不许旧盖新;
    // 反之没有更新数据时僵尸轮照常发布 —— RPC 慢速期慢轮的工作不浪费
    console.log(`[${chainId}] 迟到轮次结果作废 (晚于本轮起跑的数据已发布)`);
    return result;
  }
  st.lastPublishStart = startedAt;
  st.cache = { data: result, timestamp: Date.now() };
  try { writeJsonAtomic(st.posFile, st.cache); } catch {}   // 2026-09-28 审计修复: 原子写
  console.log(`[${chainId}] Fetch done. ${wallets.length} wallets w/ positions, ${totalActive} active, total $${grandTotalUSD.toFixed(2)}${failedOn.length ? `, ${failedOn.length} 个钱包本轮失败 (沿用旧仓)` : ''}${priceMiss ? `, ${priceMiss} 个 token 缺新鲜价` : ''}`);
  return result;
}

// --- 路由挂载 ---
// 账本后台队列要的「当前活跃仓」快照 (按钱包小写地址): 只取 positions 缓存, 零 RPC
function liveByWallet(chainId) {
  const m = {};
  for (const w of (chainState(chainId).cache.data?.wallets || [])) m[w.address.toLowerCase()] = (w.positions || []).filter(p => p.liquidityActive);
  return m;
}

// 设置页改了盈亏勾选后立刻踢一轮账本 (新勾选的钱包不用等 30min 周期)
function kickLedger(chainId) {
  if (!ledger.enabled(chainId)) return;
  setImmediate(() => ledger.runQueue(chainId, liveByWallet(chainId)).catch(e => console.error(`[${chainId}] pnl-ledger kick:`, e.message)));
}

// 2026-09-28 审计修复: ledger.init 与 module.exports._ledgerApi 曾各写一份键表, init 那份漏了 poolPriceNearBlock (账本里 E.poolPriceNearBlock 直接 TypeError);
//   统一由 ledgerApi() 产出, 两处永不再漂移 (pnl-ledger.js 用到的 E.* 必须是这里的子集)
function ledgerApi() {
  return { EVM_CHAINS, chainState, getTokenInfo, entryPricesAtBlock, entryTokenPrices, poolPriceNearBlock, sqrtPriceX96ToPrice, getTokenAmounts, ethUsdAtTime, coinUsdAtTime, getUSDPrices, loadActiveWallets, withRetry, sleep, findMintEvent, mintBlockFromScan, cfGetJson, blockscoutTopTxs };
}

function mountEvmRoutes(app, adminGuard) {
  ledger.init({ ...ledgerApi(),
    ledgerWallets: chainId => pnlSelected(chainId, loadActiveWallets(chainId)), ledgerEnabled: () => loadPnlCfgEvm().enabled });
  for (const chainId of Object.keys(EVM_CHAINS)) {
    const base = `/api/${chainId}`;
    // 每链独立钱包文件 wallets-<chain>.json, 与 BSC/SOL 完全隔离
    app.get(`${base}/wallets`, (req, res) => res.json(loadWallets(chainId)));
    // 钱包盈亏: 账本里的全部仓位 (活跃 + 已关闭) + 资金概况; ?refresh=true 顺便踢一轮后台账本扫描
    app.get(`${base}/pnl`, (req, res) => {
      const addr = String(req.query.wallet || '').trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: '缺少或无效的 wallet' });
      const st = chainState(chainId);
      const data = st.cache.data;
      const liveWallet = (data?.wallets || []).find(w => w.address.toLowerCase() === addr) || null;
      const wcfg = loadWallets(chainId).find(w => w.address.toLowerCase() === addr) || null;
      const selected = pnlSelected(chainId, loadWallets(chainId)).some(w => w.address.toLowerCase() === addr);
      const rep = ledger.walletReport(chainId, addr, liveWallet, selected);
      if (req.query.refresh === 'true' && ledger.enabled(chainId)) setImmediate(() => ledger.runQueue(chainId, liveByWallet(chainId)).catch(() => {}));
      let idleUSD = null;
      for (const [a, wI] of Object.entries(data?.idle?.byWallet || {})) if (a.toLowerCase() === addr) idleUSD = wI.totalUSD || 0;
      let funding = null;
      if (EVM_CHAINS[chainId].fundingFromLogs) funding = flows.fundingSummary(rhFundingOf(chainId, addr));
      else if (flows.enabled(chainId)) funding = flows.fundingSummary(flows.fundingOf(chainId, addr));
      res.json({
        chain: chainId, wallet: { address: addr, name: wcfg?.name || liveWallet?.name || addr, enabled: wcfg ? wcfg.enabled !== false : true },
        ...rep, idleUSD, lpUSD: liveWallet ? (liveWallet.totalUSD || 0) : 0, funding, dataTs: data?.timestamp || 0,
        selected, ledgerEnabled: loadPnlCfgEvm().enabled,
      });
    });
    app.post(`${base}/wallets`, adminGuard, (req, res) => {
      const { address, name } = req.body;
      if (!address || !name) return res.status(400).json({ error: '需要 address 和 name' });
      const addr = address.trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) return res.status(400).json({ error: '无效的 EVM 地址' });
      const wallets = loadWallets(chainId);
      if (wallets.some(w => w.address.toLowerCase() === addr)) return res.status(409).json({ error: '地址已存在' });
      if (wallets.length >= 30) return res.status(400).json({ error: '最多支持 30 个地址' });
      wallets.push({ address: addr, name: name.trim() });
      saveWallets(chainId, wallets);
      // 不清缓存: 老数据继续对外显示, 后台立刻补一轮把新钱包带进来
      // (曾经清空整链缓存 → 页面数据瞬间消失, 且 RPC 抖动时连兜底都没有)
      kickRefresh(chainId);
      console.log(`[${chainId}] Wallet added: ${name.trim()} (${addr}), 后台刷新已触发`);
      res.json({ ok: true, wallets });
    });
    app.delete(`${base}/wallets/:address`, adminGuard, (req, res) => {
      const addr = req.params.address.toLowerCase();
      const wallets = loadWallets(chainId);
      const idx = wallets.findIndex(w => w.address.toLowerCase() === addr);
      if (idx === -1) return res.status(404).json({ error: '地址不存在' });
      const removed = wallets.splice(idx, 1)[0];
      saveWallets(chainId, wallets);
      // 从缓存里剔除该钱包立即生效 (合计/统计就地重算), 其余数据保留; 后台补一轮刷新
      dropWalletFromCache(chainId, addr);
      kickRefresh(chainId);
      console.log(`[${chainId}] Wallet removed: ${removed.name} (${addr})`);
      res.json({ ok: true, wallets });
    });
    // 编辑钱包: 改名和/或换地址和/或启停。改名零 RPC 就地更新; 换地址=删旧+加新, 不清整链缓存;
    // 停用=就地剔出缓存且后续轮次不再抓 (零 RPC), 启用=后台补一轮把它带回来 (同添加)
    app.patch(`${base}/wallets/:address`, adminGuard, (req, res) => {
      const cur = req.params.address.toLowerCase();
      const wallets = loadWallets(chainId);
      const idx = wallets.findIndex(w => w.address.toLowerCase() === cur);
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
        newName = String(name).trim();
        if (!newName) return res.status(400).json({ error: '名称不能为空' });
      }
      if (address !== undefined) {
        newAddr = String(address).trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(newAddr)) return res.status(400).json({ error: '无效的 EVM 地址' });
        if (newAddr !== cur && wallets.some((w, i) => i !== idx && w.address.toLowerCase() === newAddr)) return res.status(409).json({ error: '地址已存在' });
      }
      if (newName === undefined && newAddr === undefined && newEnabled === undefined && newOwn === undefined && newLedger === undefined) return res.status(400).json({ error: '需要 name / address / enabled / own / ledger' });
      const old = { ...wallets[idx] };
      const addrChanged = newAddr !== undefined && newAddr !== cur;
      const enabledChanged = newEnabled !== undefined && newEnabled !== isWalletOn(old);
      if (newName !== undefined) wallets[idx].name = newName;
      if (newAddr !== undefined) wallets[idx].address = newAddr;
      if (newEnabled !== undefined) { if (newEnabled) delete wallets[idx].enabled; else wallets[idx].enabled = false; }
      if (newOwn !== undefined) { if (newOwn) wallets[idx].own = true; else delete wallets[idx].own; }
      if (newLedger !== undefined) { if (newLedger) wallets[idx].ledger = true; else delete wallets[idx].ledger; }
      if (newLedger === true) kickLedger(chainId);
      saveWallets(chainId, wallets);
      const st = chainState(chainId);
      if (addrChanged) {
        // 旧地址就地剔出缓存, 新地址靠后台刷新补进来 (与删除+添加同语义); 停用中的钱包不抓
        dropWalletFromCache(chainId, cur);
        if (isWalletOn(wallets[idx])) kickRefresh(chainId);
      } else if (enabledChanged) {
        if (newEnabled) kickRefresh(chainId);          // 重新启用: 后台补一轮把它带回来
        else dropWalletFromCache(chainId, cur);        // 停用: 就地剔出缓存, 零 RPC 立即生效
      } else {
        if (st.cache.data) {
          for (const w of st.cache.data.wallets) if (w.address.toLowerCase() === cur) w.name = wallets[idx].name;
          if (st.cache.data.idle?.byWallet?.[cur]) st.cache.data.idle.byWallet[cur].name = wallets[idx].name;
          try { writeJsonAtomic(st.posFile, st.cache); } catch {}   // 2026-09-28 审计修复: 原子写
        }
        if (st.lastIdle?.byWallet?.[cur]) st.lastIdle.byWallet[cur].name = wallets[idx].name;
        if (st.lastGood && st.lastGood[cur]) st.lastGood[cur].name = wallets[idx].name;
      }
      console.log(`[${chainId}] Wallet updated: ${old.name} (${old.address}) -> ${wallets[idx].name} (${wallets[idx].address})${enabledChanged ? (newEnabled ? ' [启用]' : ' [停用]') : ''}`);
      res.json({ ok: true, wallets });
    });
    app.get(`${base}/positions`, async (req, res) => {
      // pending 链: 返回结构合法的空载荷而不是报错 —— 报错会让 snapshot.js 把它计入 failed,
      // 每日快照都挂上"缺 Arc"警告; 空载荷则走既有的 `if (!s.n) continue` 被干净跳过。
      const pcfg = EVM_CHAINS[chainId];
      if (pcfg.pending) {
        return res.json({
          pending: true, pendingDate: pcfg.pendingDate || null, chainId: pcfg.chainId || null,
          wallets: [], grandTotalUSD: 0, timestamp: Date.now(),
          stats: { totalActive: 0, totalInRange: 0, totalOutOfRange: 0, totalFees: 0, walletsWithActiveLP: 0 },
        });
      }
      try {
        const data = await fetchChainPositions(chainId, req.query.refresh === 'true');
        injectFunding(chainId, data && data.idle);
        res.json(data);
      } catch (e) {
        console.error(`[${chainId}] API error:`, e.message);
        res.status(500).json({ error: '刷新失败，请稍后重试' });   // 2026-09-28 审计修复: 不把含 RPC URL/key 的错误文本回给前端
      }
    });
  }
  console.log(`EVM adapter mounted: ${Object.keys(EVM_CHAINS).map(c => `/api/${c}/*`).join(', ')}`);

  // 服务端定时自动刷新 (与 BSC/SOL 同架构): 每 10 分钟后台刷一轮, 不依赖前端访问触发
  // 看门狗: 一轮 fetch 悬死 (RPC 半死连接 300s 超时×重试叠加, 甚至永不返回) 会让 fetchInFlight
  // 永不清空, 之后每轮 auto 都被 skip, 缓存无限变陈旧 (2026-09-06 rh 实际发生, 卡死 30min+);
  // 超过 FETCH_STUCK_MS 判定卡死, 放弃旧 promise 强制开新一轮 (归属/代际护栏防僵尸捣乱)
  const FETCH_STUCK_MS = 15 * 60 * 1000; // 正常 rh 一轮 ~30s, RPC 降级期 5-9min 甚至更久;
                                         // 被放弃的慢轮迟到完成仍可发布 (lastPublishStart 排序), 不白跑
  for (const chainId of Object.keys(EVM_CHAINS)) {
    // pending 链(主网未上线, 如 arc): 不建定时刷新/不预热/不建 funding 队列, 一个 RPC 请求都不发
    if (EVM_CHAINS[chainId].pending) { console.log(`[${chainId}] pending (主网未上线), 跳过刷新调度`); continue; }
    setInterval(() => {
      const st = chainState(chainId);
      if (st.fetchInFlight) {
        const stuckMs = Date.now() - (st.fetchStartedAt || 0);
        if (st.fetchStartedAt && stuckMs > (EVM_CHAINS[chainId].fetchStuckMs || FETCH_STUCK_MS)) {
          console.error(`[${chainId}][auto] fetch 卡死 ${(stuckMs / 60000).toFixed(0)}min, 放弃旧轮强制重启刷新`);
          st.fetchInFlight = null;
        } else {
          console.log(`[${chainId}][auto] skip: fetch in flight`);
          return;
        }
      }
      // 2026-09-28 审计修复: 日志回调作为旁路传给 trackFetch, 登记的是原始 promise (见 trackFetch)
      trackFetch(chainId, fetchInner(chainId, false),
        () => console.log(`[${chainId}][auto] scheduled refresh done`),
        e => console.error(`[${chainId}][auto] scheduled refresh failed:`, e.message));
    }, CACHE_TTL);
    // 钱包盈亏账本后台队列: 启动 150s 后首跑 (等预热拉取先把活跃仓放进缓存), 之后每 30min 增量一轮 (每轮预算 240s, 超了下轮续)
    if (ledger.enabled(chainId)) {
      setTimeout(() => ledger.runQueue(chainId, liveByWallet(chainId)).catch(e => console.error(`[${chainId}] pnl-ledger:`, e.message)), 150 * 1000);
      setInterval(() => ledger.runQueue(chainId, liveByWallet(chainId)).catch(e => console.error(`[${chainId}] pnl-ledger:`, e.message)), ledger.ROUND_MS);
    }
    // 初始资金后台队列: 启动 90s 后首跑 (错开预热), 之后随 5min 刷新周期增量续扫 (每轮每钱包 1 段×2 方向)
    if (EVM_CHAINS[chainId].fundingFromLogs) {
      setTimeout(() => runFundingQueue(chainId).catch(e => console.error(`[${chainId}] funding queue:`, e.message)), 90 * 1000);
      setInterval(() => runFundingQueue(chainId).catch(e => console.error(`[${chainId}] funding queue:`, e.message)), CACHE_TTL);
    }
    // 充提记录 (Ankr 链): 启动 100s 后首跑 (首跑翻全量历史), 之后每 10min 增量
    else if (flows.enabled(chainId)) {
      const kick = () => flows.runQueue(chainId, loadWallets(chainId)).catch(e => console.error(`[${chainId}] flows:`, e.message));
      setTimeout(kick, 100 * 1000);
      setInterval(kick, flows.ROUND_MS);
    }
    // 启动预热: 重启后缓存陈旧就立即补一轮 (eth 35s / rh 45s, 错开 BSC 和 SOL)
    const delay = ({ eth: 35, rh: 45, base: 55 }[chainId] || 45) * 1000;
    setTimeout(() => {
      const st = chainState(chainId);
      if (st.fetchInFlight) return;
      if (st.cache.data && Date.now() - st.cache.timestamp < CACHE_TTL / 2) { console.log(`[${chainId}][auto] 预热跳过: 缓存还新鲜`); return; }
      console.log(`[${chainId}][auto] 启动预热刷新...`);
      trackFetch(chainId, fetchInner(chainId, false),   // 2026-09-28 审计修复: 同上, 登记原始 promise
        () => console.log(`[${chainId}][auto] 预热刷新完成`),
        e => console.error(`[${chainId}][auto] 预热刷新失败:`, e.message));
    }, delay);
  }
}

// =============================================================
// [ARC-GO-LIVE] Arc 主网上线切活步骤 (预计 2026-09-16)
//   1. node tools/arc-check.js            (必要时 ARC_RPC=<官方主网 RPC> 前缀), 要求全绿
//   2. 把自检输出的真实 rpc / v4.deployBlock / 需要时 noBatch 填进上面 EVM_CHAINS.arc,
//      并把各地址注释从"未链上验证"改成"链上验证 <日期>"
//   3. EVM_CHAINS.arc.pending -> false; server.js 的 CHAINS 里 arc 改 enabled:true 并删掉 pending 字段
//   4. 加 Arc 钱包地址 -> 重启服务 -> 验证首轮抓取
// =============================================================
module.exports = { mountEvmRoutes, EVM_CHAINS, kickRefresh, liveByWallet, kickLedger,
  _ledgerApi: ledgerApi(),   // 2026-09-28 审计修复: 与 ledger.init 同源 (见 ledgerApi)
  _entryTest: { getV3EntryData, getV4EntryData, getV3EntrySubgraph, getV4EntrySubgraph, getTokenInfo } };
module.exports._collectTest = { fillLastCollect };   // 领费时间的独立验证入口 (tools/collect-check.js)  // 建仓回溯的独立验证入口
module.exports._fundingTest = { scanWalletFunding, rhFundingOf };   // rh 充提 (含原生 ETH) 的独立验证入口
