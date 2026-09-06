// =============================================================
// EVM 多链适配器: Ethereum 主网 + Robinhood Chain (chainId 4663) + Base (chainId 8453)
// 模式与 sol-adapter 一致: 独立模块, 输出与 /api/positions 同构 JSON
// 挂载: /api/eth/*  /api/rh/*  /api/base/*
// 钱包列表与 BSC 共享 wallets.json (同一批 0x 地址跨链通用)
// =============================================================
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

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
    let createdCache = {};
    try { createdCache = JSON.parse(fs.readFileSync(createdFile, 'utf8')); } catch {}
    const posFile = path.join(__dirname, `positions-cache-${chainId}.json`);
    let cache = { data: null, timestamp: 0 };
    try {
      const saved = JSON.parse(fs.readFileSync(posFile, 'utf8'));
      if (saved && saved.data) cache = saved;
    } catch {}
    state[chainId] = {
      provider: new ethers.JsonRpcProvider(cfg.rpc),
      tokenCache: {}, cache, createdFile, createdCache, posFile,
      fetchInFlight: null, v4IdCache: {},
    };
  }
  return state[chainId];
}

// --- 每链独立钱包列表: wallets-eth.json / wallets-rh.json (与 BSC 的 wallets.json 互不相干) ---
function walletsFile(chainId) { return path.join(__dirname, `wallets-${chainId}.json`); }
function loadWallets(chainId) {
  try { return JSON.parse(fs.readFileSync(walletsFile(chainId), 'utf8')); } catch { return []; }
}
function saveWallets(chainId, wallets) {
  fs.writeFileSync(walletsFile(chainId), JSON.stringify(wallets, null, 2), 'utf8');
}

// --- token 信息 ---
async function getTokenInfo(chainId, address) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const addr = address.toLowerCase();
  if (addr === ethers.ZeroAddress.toLowerCase()) {
    return { symbol: cfg.nativeSymbol, decimals: 18, address: cfg.wrappedNative };
  }
  const cached = st.tokenCache[addr];
  if (cached && !cached._fallback) return cached;
  try {
    const c = new ethers.Contract(address, ERC20_ABI, st.provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    st.tokenCache[addr] = { symbol, decimals: Number(decimals), address };
  } catch {
    st.tokenCache[addr] = { symbol: addr.slice(0, 6) + '...', decimals: 18, address, _fallback: true };
  }
  return st.tokenCache[addr];
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
  if (st.createdCache[key] > 0) return st.createdCache[key];
  if (!cfg.blockscout) return 0;
  try {
    const url = `${cfg.blockscout}/api/v2/tokens/${nftContract}/instances/${tokenId}/transfers`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return 0;
    const d = await res.json();
    const items = d.items || [];
    // mint = from 零地址; transfers 接口按时间倒序, 取最后一条含零地址 from 的
    let mint = null;
    for (const it of items) {
      const from = (it.from?.hash || '').toLowerCase();
      if (from === ethers.ZeroAddress.toLowerCase()) mint = it;
    }
    const target = mint || items[items.length - 1];
    if (!target) return 0;
    let ts = 0;
    if (target.timestamp) ts = Date.parse(target.timestamp);
    else if (target.block_number) {
      const b = await st.provider.getBlock(Number(target.block_number));
      if (b) ts = b.timestamp * 1000;
    }
    if (ts > 0) {
      st.createdCache[key] = ts;
      try { fs.writeFileSync(st.createdFile, JSON.stringify(st.createdCache)); } catch {}
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
  if (st.createdCache[key] > 0) return st.createdCache[key];
  try {
    const T = ethers.id('Transfer(address,address,uint256)');
    const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
    const tid = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
    const latest = await st.provider.getBlockNumber();
    const CHUNK = 5000000;
    let logs = [];
    for (let to = latest; to >= 0 && logs.length === 0; to -= CHUNK) {
      const from = Math.max(0, to - CHUNK + 1);
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
    st.createdCache[key] = ts;
    try { fs.writeFileSync(st.createdFile, JSON.stringify(st.createdCache)); } catch {}
    return ts;
  } catch (e) {
    console.error(`  [${chainId}] rpcMintTime 失败 token ${tokenId}:`, e.message?.slice(0, 60));
    return 0;
  }
}

// --- V4 头寸枚举: 链上 Transfer 日志分段扫描 ---
// RH 无子图, blockscout /nft 库存端点对 700+ NFT 大户既翻不完页又被限流 (2026-08-25 实测
// 698 个只枚举到 236); 官方 RPC 全窗一次查会 "log query timed out", 5M 块分段则整链 ~4s 跑完
async function rpcNftIdsViaTransferLogs(chainId, owner, nftContract, deployBlock) {
  const st = chainState(chainId);
  const T = ethers.id('Transfer(address,address,uint256)');
  const wt = ethers.zeroPadValue(owner, 32);
  const latest = await st.provider.getBlockNumber();
  const CHUNK = 5000000;
  const all = [];
  for (let from = deployBlock; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const base = { address: nftContract, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) };
    const [ins, outs] = await Promise.all([
      withRetry(() => st.provider.send('eth_getLogs', [{ ...base, topics: [T, null, wt] }])),
      withRetry(() => st.provider.send('eth_getLogs', [{ ...base, topics: [T, wt, null] }])),
    ]);
    all.push(...ins, ...outs);
  }
  // 按 (块高, logIndex) 排序后, 每个 tokenId 的最后一条 Transfer 决定当前归属
  const ownerTail = owner.slice(2).toLowerCase();
  const evs = all.map(l => ({ bn: parseInt(l.blockNumber, 16), li: parseInt(l.logIndex, 16), to: l.topics[2], id: BigInt(l.topics[3]).toString() }));
  evs.sort((a, b) => a.bn - b.bn || a.li - b.li);
  const held = new Map();
  for (const e of evs) held.set(e.id, e.to.slice(26).toLowerCase() === ownerTail);
  return [...held.entries()].filter(([, h]) => h).map(([id]) => ({ id: BigInt(id), createdAt: 0 }));
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
  if (cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000) {
    // NFT 数没变 → 缓存可信; 变了 (新开仓/转入/销毁) 或 balanceOf 失败 → 分别处理
    if (bal === null || bal === cached.ids.length) return cached.ids;
    console.log(`  [${chainId}] V4 NFT 数变化 ${cached.ids.length} -> ${bal}, 重新枚举 ${walletAddress}`);
  }

  let ids = null;
  if (cfg.v4SubgraphId) {
    const data = await graphQuery(cfg.v4SubgraphId,
      `{ positions(first: 1000, where: { owner: "${key}" }) { tokenId createdAtTimestamp } }`);
    if (data?.positions) {
      ids = data.positions.map(p => ({ id: BigInt(p.tokenId), createdAt: Number(p.createdAtTimestamp || 0) * 1000 }));
    }
  }
  if (!ids && cfg.v4.deployBlock != null) {
    // 无子图链 (RH) 主路径: 链上 Transfer 日志分段扫描, 权威且不受第三方索引器限制
    try {
      ids = await rpcNftIdsViaTransferLogs(chainId, walletAddress, cfg.v4.pm, cfg.v4.deployBlock);
    } catch (e) {
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
  st.v4IdCache[key] = { ids, ts: Date.now() };
  return ids;
}

// --- V3: 子图取创建时间+已领手续费 (ETH); RH 无子图返回空走 blockscout ---
async function getV3SubgraphData(chainId, walletAddress) {
  const cfg = EVM_CHAINS[chainId];
  if (!cfg.v3SubgraphId) return { created: {}, collectedFees: {} };
  // liquidity_gt 只取活跃仓 (消费方只用活跃仓的数据): 之前 first:200 无过滤,
  // 大户 1583 仓会被截断致活跃仓 createdAt 缺失; 两条链子图均已实测支持此过滤
  const data = await graphQuery(cfg.v3SubgraphId,
    `{ positions(first: 1000, where: { owner: "${walletAddress.toLowerCase()}", liquidity_gt: 0 }) { id transaction { timestamp } collectedFeesToken0 collectedFeesToken1 } }`);
  const created = {}, collectedFees = {};
  for (const p of (data?.positions || [])) {
    if (p.transaction?.timestamp) created[p.id] = Number(p.transaction.timestamp) * 1000;
    collectedFees[p.id] = {
      token0: parseFloat(p.collectedFeesToken0 || '0'),
      token1: parseFloat(p.collectedFeesToken1 || '0'),
    };
  }
  return { created, collectedFees };
}

// --- V3 未领手续费 ---
async function getUnclaimedFees(npm, tokenId, walletAddress) {
  try {
    const MAX = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
    const r = await npm.collect.staticCall(
      { tokenId, recipient: walletAddress, amount0Max: MAX, amount1Max: MAX },
      { from: walletAddress });
    return { fees0: r.amount0, fees1: r.amount1 };
  } catch { return { fees0: 0n, fees1: 0n }; }
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
    st.entryCache = {};
    try { st.entryCache = JSON.parse(fs.readFileSync(st.entryFile, 'utf8')); } catch {}
  }
  return st;
}
function saveEntryCache(st) {
  try { fs.writeFileSync(st.entryFile, JSON.stringify(st.entryCache)); } catch {}
}

// coingecko ETH 历史价: 小时桶缓存 + 串行队列 (免费档限流敏感); 拿不到返回 0, 不缓存下轮重试
const ethHistCache = new Map();
let cgQueue = Promise.resolve();
function ethUsdAtTime(tsMs) {
  const bucket = Math.floor(tsMs / 3600000);
  for (const b of [bucket, bucket - 1, bucket + 1]) if (ethHistCache.has(b)) return Promise.resolve(ethHistCache.get(b));
  const run = cgQueue.then(async () => {
    if (ethHistCache.has(bucket)) return ethHistCache.get(bucket);
    try {
      const from = Math.floor(tsMs / 1000) - 7200, to = Math.floor(tsMs / 1000) + 7200;
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range?vs_currency=usd&from=${from}&to=${to}`, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) return 0;
      const d = await res.json();
      let best = 0, bd = Infinity;
      for (const [t, p] of (d.prices || [])) { const dd = Math.abs(t - tsMs); if (dd < bd) { bd = dd; best = p; } }
      if (best > 0) ethHistCache.set(bucket, best);
      return best;
    } catch { return 0; }
  });
  cgQueue = run.then(() => sleep(1500), () => sleep(1500));
  return run;
}

// 目标块附近最近一笔 Swap 的 sqrtPriceX96 (窗口逐级放大: 忙池首窗即命中, 冷池最远扫 ±250万块)
async function poolPriceNearBlock(chainId, spec, targetBlock) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  const latest = await st.provider.getBlockNumber();
  const filt = spec.kind === 'v4'
    ? { address: cfg.v4.poolManager, topics: [V4_SWAP_TOPIC, spec.poolId] }
    : { address: spec.poolAddress, topics: [V3_SWAP_TOPIC] };
  const windows = [[300, 50], [2000, 2000], [20000, 20000], [150000, 150000], [900000, 900000], [2500000, 2500000]];
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
  const latest = toBlock != null ? toBlock : await st.provider.getBlockNumber();
  const all = [];
  for (let f = fromBlock; f <= latest; f += chunk) {
    const to = Math.min(f + chunk - 1, latest);
    const logs = await withRetry(() => st.provider.send('eth_getLogs', [{
      ...baseFilter, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16),
    }]), 3, 1000);
    all.push(...logs);
    if (f + chunk <= latest) await sleep(120);
  }
  return all;
}

// NFT mint 事件: 块高+时间戳 (从链头倒扫, 与 rpcMintTime 同套路; 顺手喂 createdCache)
async function findMintEvent(chainId, nftContract, tokenId) {
  const st = chainState(chainId);
  const T = ethers.id('Transfer(address,address,uint256)');
  const zero = ethers.zeroPadValue(ethers.ZeroAddress, 32);
  const tid = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const latest = await st.provider.getBlockNumber();
  const CHUNK = 5000000;
  let logs = [];
  for (let to = latest; to >= 0 && logs.length === 0; to -= CHUNK) {
    const from = Math.max(0, to - CHUNK + 1);
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
    st.createdCache[key] = b.timestamp * 1000;
    try { fs.writeFileSync(st.createdFile, JSON.stringify(st.createdCache)); } catch {}
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
    const eth = await ethUsdAtTime(entryTs);
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
  if (cached && cached.liq === currentLiq.toString()) return cached;
  try {
    // 事件不会早于 mint 块, 从 mint 块起分段扫 (mint 块永久缓存在 mb, 重算不再倒扫)
    const mint = cached && cached.mb
      ? { block: cached.mb }
      : await findMintEvent(chainId, cfg.v3.npm, tokenId.toString());
    if (!mint) return null;
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
    let u = 0, w = 0, n = 0, liq = 0n, ts = 0;
    for (const ev of use) {
      const hex = ev.lg.data.slice(2);
      const dl = BigInt('0x' + hex.slice(0, 64));
      const amt0 = Number(BigInt('0x' + hex.slice(64, 128))) / 10 ** t0.decimals;
      const amt1 = Number(BigInt('0x' + hex.slice(128, 192))) / 10 ** t1.decimals;
      const bn = parseInt(ev.lg.blockNumber, 16);
      const prices = await entryPricesAtBlock(chainId, spec, t0, t1, bn, memo);
      if (!prices) return null;
      const v = amt0 * prices.p0 + amt1 * prices.p1;
      if (ev.sign > 0) { u += v; n++; liq += dl; if (!ts) ts = prices.ts; }
      else { w += v; liq -= dl; }
    }
    // capped 时无法对账, 冻结在当前 liquidity 上避免每轮重扫; 正常路径事件应与链上现值对平
    const data = capped
      ? { u, w: 0, ts, n, liq: currentLiq.toString(), b: 0, mb: mint.block, mod: true }
      : { u, w, ts, n, liq: liq.toString(), b: 0, mb: mint.block, mod: liq !== BigInt(currentLiq) };
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
  if (cached && cached.liq === currentLiq.toString()) return cached;
  try {
    let u = 0, w = 0, n = 0, liq = 0n, ts = 0, fromBlock;
    if (cached && cached.b > 0) {
      ({ u, w, n, ts } = cached); liq = BigInt(cached.liq); fromBlock = cached.b + 1;
    } else {
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
    if (!cached && !evs.some(e => e.delta > 0n)) return null;
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
        u += amount0 * prices.p0 + amount1 * prices.p1; n++;
      }
      const data = { u, w: 0, ts, n, liq: currentLiq.toString(), b: latest, mod: true, cap: true };
      st.entryCache[key] = data; saveEntryCache(st);
      return data;
    }
    for (const ev of evs.sort((a, b) => a.bn - b.bn)) {
      const prices = await entryPricesAtBlock(chainId, spec, t0, t1, ev.bn, memo);
      if (!prices) return null;
      const mag = ev.delta > 0n ? ev.delta : -ev.delta;
      const { amount0, amount1 } = getTokenAmounts(mag, prices.sqrt, tickLower, tickUpper, t0.decimals, t1.decimals);
      const v = amount0 * prices.p0 + amount1 * prices.p1;
      if (ev.delta > 0n) { u += v; n++; liq += ev.delta; if (!ts) ts = prices.ts; }
      else { w += v; liq += ev.delta; }
    }
    // 事件累计与链上现值不平 (取数时点竞态/漏事件) → 标记但不强行冻结, 下轮增量再对
    const data = { u, w, ts, n, liq: liq.toString(), b: latest, mod: cap || liq !== BigInt(currentLiq), cap };
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
  if (cached && cached.liq === job.liq.toString()) return cached;
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
    `{ mints(first:500, where:{pool:"${pool}", tickLower:${tl}, tickUpper:${tu}, origin:"${origin}"}){ amount0 amountUSD timestamp } }`);
  if (!md) return null;
  const bd = await graphQueryRetry(cfg.v3SubgraphId,
    `{ burns(first:500, where:{pool:"${pool}", tickLower:${tl}, tickUpper:${tu}, origin:"${origin}"}){ amountUSD } }`);
  const mints = md.mints || [], burns = (bd && bd.burns) || [];
  if (mints.length === 0) return null;
  let u = 0, sum0 = 0, ts = 0;
  for (const m of mints) { u += Math.abs(+m.amountUSD); sum0 += +m.amount0; const t = +m.timestamp * 1000; if (!ts || t < ts) ts = t; }
  const w = burns.reduce((a, b) => a + Math.abs(+b.amountUSD), 0);
  const dep0 = +p.depositedToken0;
  const mod = dep0 > 0 ? Math.abs(sum0 - dep0) / dep0 > 0.02 : false;   // 同钱包同池同档多 NFT 合并/漏事件 → 存疑
  const data = { u, w, ts, n: mints.length, liq: job.liq.toString(), b: 0, mod };
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
  if (cached && cached.liq === job.liq.toString()) return cached;
  const pd = await graphQueryRetry(cfg.v4SubgraphId,
    `{ position(id:"${job.tokenId}"){ owner origin createdAtTimestamp } }`);
  const p = pd && pd.position;
  if (!p) return null;
  const origin = (p.origin || p.owner || '').toLowerCase();
  if (!origin) return null;
  // base V4 索引器对带 filter 的 modifyLiquidities 偶发 BadResponse (每次 ~15s 超时); 只试 2 次避免
  // 串行队列被卡死的 job 饿死后面能成功的 base V3; 失败走 15 分钟冷却下轮再补.
  const md = await graphQueryRetry(cfg.v4SubgraphId,
    `{ modifyLiquidities(first:500, where:{pool:"${job.poolId}", tickLower:${job.tickLower}, tickUpper:${job.tickUpper}, origin:"${origin}"}){ amount amountUSD timestamp } }`, 2, 900);
  if (!md) return null;
  const evs = md.modifyLiquidities || [];
  if (evs.length === 0) return null;
  let u = 0, w = 0, n = 0, ts = 0;
  for (const e of evs) {
    const a = Math.abs(+e.amountUSD);
    if (+e.amount >= 0) { u += a; n++; const t = +e.timestamp * 1000; if (!ts || t < ts) ts = t; }
    else { w += a; }
  }
  const data = { u, w, ts, n, liq: job.liq.toString(), b: 0, mod: false };
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
  if (cached && cached.liq === job.liq.toString()) return cached;
  try {
    const ep = entryProvider(chainId);
    const poolId = job.poolId;
    const saltHex = BigInt(job.tokenId).toString(16).padStart(64, '0');
    // 链上 currency 顺序: 按地址升序 (与 poolId=keccak(currency0<currency1) 一致)
    const [c0, c1] = job.t0.address.toLowerCase() < job.t1.address.toLowerCase() ? [job.t0, job.t1] : [job.t1, job.t0];

    let u = 0, w = 0, n = 0, liq = 0n, ts = 0, fromBlock;
    if (cached && cached.b > 0) {
      ({ u, w, n, ts } = cached); liq = BigInt(cached.liq); fromBlock = cached.b + 1;
    } else {
      const mint = await mintBlockBase(chainId, job.createdAt, job.tokenId);
      if (!mint) return null;
      fromBlock = mint;
    }
    const latest = await ep.getBlockNumber();
    // getLogs: base.org 限 10k 块/段, 用 9000 稳妥; 分段扫 mint->latest (近期机器人仓通常仅几万块)
    const logs = [];
    for (let f = fromBlock; f <= latest; f += 9000) {
      const to = Math.min(f + 8999, latest);
      const part = await withRetry(() => ep.send('eth_getLogs', [{
        address: cfg.v4.poolManager,
        topics: [V4_MODIFY_TOPIC, poolId, ethers.zeroPadValue(cfg.v4.pm, 32)],
        fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16),
      }]), 4, 900);
      logs.push(...part);
      if (f + 9000 <= latest) await sleep(80);
    }
    // data 布局: tickLower(32B) tickUpper(32B) liquidityDelta(32B,有符号) salt(32B)
    const evs = [];
    for (const lg of logs) {
      const hex = lg.data.slice(2);
      if (hex.slice(192, 256) !== saltHex) continue;
      evs.push({ bn: parseInt(lg.blockNumber, 16), tl: hexI24(hex.slice(0, 64)), tu: hexI24(hex.slice(64, 128)), delta: hexInt(hex.slice(128, 192)) });
    }
    if (!cached && !evs.some(e => e.delta > 0n)) return null;
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
      for (const back of [600, 8000, 60000, 400000]) {
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
        u += amount0 * pr.p0 + amount1 * pr.p1; n++; if (!ts) ts = pr.ts;
      }
      const data = { u, w: 0, ts, n, liq: job.liq.toString(), b: latest, mod: true, cap: true };
      st.entryCache[key] = data; saveEntryCache(st);
      return data;
    }
    for (const ev of evs) {
      const pr = await priceAt(ev.bn);
      if (!pr) return null;
      const mag = ev.delta > 0n ? ev.delta : -ev.delta;
      const { amount0, amount1 } = getTokenAmounts(mag, pr.sqrt, ev.tl, ev.tu, c0.decimals, c1.decimals);
      const v = amount0 * pr.p0 + amount1 * pr.p1;
      if (ev.delta > 0n) { u += v; n++; liq += ev.delta; if (!ts) ts = pr.ts; }
      else { w += v; liq += ev.delta; }
    }
    const data = { u, w, ts, n, liq: liq.toString(), b: latest, mod: cap || liq !== BigInt(job.liq), cap };
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
  if (cached && cached.liq === currentLiq.toString()) return cached;
  st.entryJobs = st.entryJobs || new Map();
  st.entryCooldown = st.entryCooldown || new Map();
  if ((st.entryCooldown.get(key) || 0) < Date.now() && !st.entryJobs.has(key)) {
    st.entryJobs.set(key, job);
    setImmediate(() => runEntryQueue(chainId).catch(() => {}));
  }
  return null;
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
    if (!pool || !pool.slot0) return null;   // 池子查不到/slot0 失败: 与旧逻辑一致跳过
    const t0 = await getTokenInfo(chainId, pos.token0);
    const t1 = await getTokenInfo(chainId, pos.token1);
    const sqrtPriceX96 = pool.slot0.sqrtPriceX96, currentTick = Number(pool.slot0.tick);

    const tickLower = Number(pos.tickLower), tickUpper = Number(pos.tickUpper);
    const { amount0, amount1 } = getTokenAmounts(pos.liquidity, sqrtPriceX96, tickLower, tickUpper, t0.decimals, t1.decimals);
    const { fees0, fees1 } = await getUnclaimedFees(npm, tokenId, wallet.address);
    const tidStr = tokenId.toString();
    let createdAt = createdMap[tidStr] || 0;
    if (!createdAt) createdAt = await blockscoutMintTime(chainId, EVM_CHAINS[chainId].v3.npm, tidStr);
    if (!createdAt) createdAt = await rpcMintTime(chainId, EVM_CHAINS[chainId].v3.npm, tidStr);

    // 建仓价值: 只读缓存, 缺失/过期交给后台队列补 (mint 块 mb 即使 liquidity 已变也可用)
    let entryValueUSD = 0, entryWithdrawnUSD = 0, entryTs = 0, entryAdds = 0, entryModified = false, mintBlock = 0;
    if (EVM_CHAINS[chainId].entryFromLogs || EVM_CHAINS[chainId].entryFromSubgraph) {
      mintBlock = entryState(chainId).entryCache[`v3-${tokenId}`]?.mb || 0;
      const ed = entryPeek(chainId, 'v3', tokenId, pos.liquidity,
        { kind: 'v3', tokenId, poolAddress: pool.addr, tickLower, tickUpper, t0, t1, liq: pos.liquidity });
      if (ed) {
        entryValueUSD = ed.u; entryWithdrawnUSD = ed.w; entryTs = ed.ts;
        entryAdds = ed.n; entryModified = ed.mod;
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
      entryValueUSD, entryWithdrawnUSD, entryTs, entryAdds, entryModified,
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

      let feesOwed0 = 0, feesOwed1 = 0;
      const posInfo = feeRes[i * 2], fgi = feeRes[i * 2 + 1];
      if (posInfo && fgi && posInfo.liquidity > 0n) {
        const MAX_U256 = (1n << 256n) - 1n;
        const d0 = (fgi.feeGrowthInside0X128 - posInfo.feeGrowthInside0LastX128 + MAX_U256 + 1n) & MAX_U256;
        const d1 = (fgi.feeGrowthInside1X128 - posInfo.feeGrowthInside1LastX128 + MAX_U256 + 1n) & MAX_U256;
        feesOwed0 = Number(d0 * posInfo.liquidity / Q128) / 10 ** t0.decimals;
        feesOwed1 = Number(d1 * posInfo.liquidity / Q128) / 10 ** t1.decimals;
        if (feesOwed0 > 1e12) feesOwed0 = 0;
        if (feesOwed1 > 1e12) feesOwed1 = 0;
      }

      let createdAt = m.entry.createdAt || 0;
      if (!createdAt) createdAt = await blockscoutMintTime(chainId, cfg.v4.pm, tokenId.toString());
      if (!createdAt) createdAt = await rpcMintTime(chainId, cfg.v4.pm, tokenId.toString());

      // 建仓价值: 只读缓存, 缺失/过期交给后台队列补
      let entryValueUSD = 0, entryWithdrawnUSD = 0, entryTs = 0, entryAdds = 0, entryModified = false;
      if (cfg.entryFromLogs || cfg.entryFromSubgraph) {
        const ed = entryPeek(chainId, 'v4', tokenId, m.liquidity,
          { kind: 'v4', tokenId, poolId: m.poolId, tickLower: m.tickLower, tickUpper: m.tickUpper, t0, t1, liq: m.liquidity, createdAt });
        if (ed) {
          entryValueUSD = ed.u; entryWithdrawnUSD = ed.w; entryTs = ed.ts;
          entryAdds = ed.n; entryModified = ed.mod;
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
        entryValueUSD, entryWithdrawnUSD, entryTs, entryAdds, entryModified,
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

async function getUSDPrices(chainId, tokenAddresses, positionsData) {
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

  for (const addr of unique) if (!prices[addr]) prices[addr] = 0;
  return prices;
}

// --- 钱包闲置余额 (LP 之外的代币资产) ---
// EVM 无法免索引器枚举全部 ERC20, 候选集=LP 涉及 token + 稳定币 + WETH (+ rh 全部官方股票代币);
// 垃圾空投币天然进不了候选集, 无需再做 spam 过滤, 仅滤 <$1 灰尘
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const MC3_NATIVE_ABI = ['function getEthBalance(address addr) view returns (uint256)'];
let rhRegistryCache = { list: null, ts: 0 };
function rhStockTokens() {
  if (rhRegistryCache.list && Date.now() - rhRegistryCache.ts < 3600e3) return rhRegistryCache.list;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'stocktokens-registry.json'), 'utf8'));
    rhRegistryCache = { list: reg.map(t => ({ addr: t.addr.toLowerCase(), sym: t.sym })), ts: Date.now() };
  } catch { rhRegistryCache = { list: [], ts: Date.now() }; }
  return rhRegistryCache.list;
}
function rhStockQuotes() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'stocktokens-cache.json'), 'utf8')).quotes || {}; }
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
async function fetchIdleBalances(chainId, WALLETS, tokens, usdPrices) {
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
      if (sym && dec !== null) st.tokenCache[a] = { symbol: sym[0], decimals: Number(dec[0]), address: a };
      else st.tokenCache[a] = { symbol: a.slice(0, 6) + '…', decimals: 18, address: a, _fallback: true };
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
    if (nat) {
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
      items.push({ symbol: meta?.symbol || a.slice(0, 6), address: a, amount, priceUSD: price, valueUSD: v });
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

// --- 钱包资金查询配置 (fund-config.json, 路由在 server.js): 启用开关 + 按链勾选 ---
function loadFundCfgEvm() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-config.json'), 'utf8'));
    return { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} };
  } catch { return { enabled: true, wallets: {} }; }
}
// 勾选子集; 未设置(非数组)=全部钱包
function fundSelected(fundCfg, chainId, WALLETS) {
  if (!fundCfg.enabled) return [];
  const sel = fundCfg.wallets[chainId];
  if (!Array.isArray(sel)) return WALLETS;
  const s = new Set(sel.map(a => String(a).toLowerCase()));
  return WALLETS.filter(w => s.has(w.address.toLowerCase()));
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
// 口径: 仅 ERC20 Transfer (rh RPC 不支持任何 trace 方法, 原生 ETH 直转链上无日志不可见);
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
    try { st.fundingCache = JSON.parse(fs.readFileSync(fundingFile(chainId), 'utf8')); } catch { st.fundingCache = {}; }
  }
  return st.fundingCache;
}
function saveFundingCache(chainId) {
  try { fs.writeFileSync(fundingFile(chainId), JSON.stringify(chainState(chainId).fundingCache || {})); } catch {}
}
const codeCache = {};   // `${chainId}:${addr}` -> 是否合约 (进程级; 判定失败不缓存下轮重试)
async function isContract(chainId, addr) {
  const key = chainId + ':' + addr;
  if (key in codeCache) return codeCache[key];
  try {
    const code = await withRetry(() => chainState(chainId).provider.getCode(addr), 2, 500);
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
    if (b) { st.blockTsCache[block] = b.timestamp * 1000; return st.blockTsCache[block]; }
  } catch {}
  return 0;
}
// 自适应分段单方向扫描; stopped: null=完成 | 'budget'=量超限(bot) | 'rpc'=段失败(下轮续)
async function scanTransfersAdaptive(chainId, topics, fromBlock, toBlock, budget) {
  const st = chainState(chainId);
  const out = [];
  let f = fromBlock, chunk = 5000000, stopped = null;
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
    const { price } = await fundingTokenPrice(chainId, token, ts);
    const usd = amt * price;
    if (usd < 1) continue;                                         // 灰尘
    cur.events.push({ id, b, ts, dir, sym: meta?.symbol || token.slice(0, 6), amt, usd, cp, ct });
  }
  cur.events.sort((a, b2) => b2.ts - a.ts);
  cur.inUSD = cur.events.filter(e => e.dir === 'in').reduce((s, e) => s + e.usd, 0);
  cur.outUSD = cur.events.filter(e => e.dir === 'out').reduce((s, e) => s + e.usd, 0);
  cur.scannedTo = scannedTo;
  cur.stopped = (rIn.stopped || rOut.stopped) ? 'rpc' : null;     // rpc 止步: 下轮从 scannedTo+1 续
  cur.updatedAt = Date.now();
  saveFundingCache(chainId);
  return cur;
}
const fundingRunning = {};
async function runFundingQueue(chainId) {
  if (fundingRunning[chainId]) return;
  fundingRunning[chainId] = true;
  try {
    const WALLETS = fundSelected(loadFundCfgEvm(), chainId, loadWallets(chainId));
    for (const w of WALLETS) {
      try {
        const r = await scanWalletFunding(chainId, w);
        console.log(`[${chainId}] funding ${w.name}: ${r.stopped === 'budget' ? '高频钱包放弃' : `${r.events.length} 笔, 净入金 $${(r.inUSD - r.outUSD).toFixed(0)}${r.stopped === 'rpc' ? ' (RPC 止步下轮续)' : ''}`}`);
      } catch (e) { console.error(`[${chainId}] funding scan ${w.name}:`, e.message?.slice(0, 80)); }
      await sleep(1200);
    }
  } finally { fundingRunning[chainId] = false; }
}

// --- 价格方向归一: 稳定币放 token1 侧 ---
function normalizePosition(chainId, pos) {
  const cfg = EVM_CHAINS[chainId];
  const t0addr = (pos.token0addr || '').toLowerCase();
  if (cfg.stables[t0addr]) {
    return {
      ...pos,
      token0: pos.token1, token1: pos.token0,
      token0addr: pos.token1addr, token1addr: pos.token0addr,
      token0USD: pos.token1USD, token1USD: pos.token0USD,
      amount0: pos.amount1, amount1: pos.amount0,
      feesOwed0: pos.feesOwed1, feesOwed1: pos.feesOwed0,
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
function kickRefresh(chainId) {
  const st = chainState(chainId);
  if (st.fetchInFlight) return;
  st.fetchInFlight = fetchInner(chainId, false)
    .catch(e => console.error(`[${chainId}] kick refresh failed:`, e.message))
    .finally(() => { st.fetchInFlight = null; });
}
async function fetchChainPositions(chainId, forceRefresh = false) {
  const st = chainState(chainId);
  const fresh = st.cache.data && (Date.now() - st.cache.timestamp < CACHE_TTL);
  if (!forceRefresh && fresh) return st.cache.data;
  if (!forceRefresh && st.cache.data) {
    if (!st.fetchInFlight) {
      st.fetchInFlight = fetchInner(chainId, false)
        .catch(e => console.error(`[${chainId}] bg refresh failed:`, e.message))
        .finally(() => { st.fetchInFlight = null; });
    }
    return st.cache.data;
  }
  if (st.fetchInFlight) return st.fetchInFlight;
  st.fetchInFlight = fetchInner(chainId, forceRefresh).finally(() => { st.fetchInFlight = null; });
  return st.fetchInFlight;
}

async function fetchInner(chainId, forceRefresh) {
  const st = chainState(chainId);
  const cfg = EVM_CHAINS[chainId];
  // 强刷不再清 v4IdCache: 枚举缓存有链上 balanceOf 计数做失效判据, 计数一致即可信;
  // 清掉会触发全部钱包的全链 Transfer 重扫 (rh 手动刷新慢的主因, RPC 紧张时还会雪崩)

  const WALLETS = loadWallets(chainId);
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

  const walletResults = [];
  // 串行×2并发: 每个钱包 V3+V4 并行, 钱包间小并发
  for (let i = 0; i < WALLETS.length; i += 2) {
    const batch = WALLETS.slice(i, i + 2);
    const r = await Promise.all(batch.map(async (w) => {
      const [v3, v4] = await Promise.all([
        fetchWalletV3(chainId, w, npm, factory).catch(e => { console.error(`  [${chainId}] ${w.name} V3 failed:`, e.message?.slice(0, 100)); return null; }),
        fetchWalletV4(chainId, w, v4pm, stateView).catch(e => { console.error(`  [${chainId}] ${w.name} V4 failed:`, e.message?.slice(0, 100)); return null; }),
      ]);
      if (v3 === null || v4 === null) {
        // 本轮抓取失败: 沿用最后一次成功快照, 不要误报为空仓
        const prev = st.lastGood[w.address.toLowerCase()];
        if (prev) { console.log(`  [${chainId}] ${w.name} 本轮失败, 沿用最后成功快照 (${prev.positions.length} 仓)`); return { ...prev, name: w.name }; }
        return { address: w.address, name: w.name, positions: [], totalUSD: 0, _failed: true };
      }
      const wr = { address: w.address, name: w.name, positions: [...(v3 || []), ...(v4 || [])], totalUSD: 0 };
      st.lastGood[w.address.toLowerCase()] = wr;   // 定价在后续循环里原地写入同一对象
      return wr;
    }));
    walletResults.push(...r);
    await sleep(300);
  }

  // 定价
  const allTokens = new Set(), allPositions = [];
  for (const wr of walletResults) for (const p of wr.positions) {
    allTokens.add(p.token0addr.toLowerCase()); allTokens.add(p.token1addr.toLowerCase());
    allPositions.push(p);
  }
  // 闲置余额候选一并送进定价 (coingecko/池内价/稳定币分支都能覆盖到)
  const idleCand = idleCandidates(chainId, [...allTokens].map(a => a.toLowerCase()));
  const usdPrices = await getUSDPrices(chainId, [...new Set([...allTokens, ...idleCand])], allPositions);
  st.lastUsdPrices = usdPrices;   // funding 回溯给非稳定币 token 当前价近似用

  let grandTotalUSD = 0, totalActive = 0, totalInRange = 0, totalOutOfRange = 0, totalFees = 0, walletsWithActiveLP = 0;
  for (const wr of walletResults) {
    let walletTotal = 0, hasActive = false;
    for (const pos of wr.positions) {
      const p0 = usdPrices[pos.token0.address.toLowerCase()] || 0;
      const p1 = usdPrices[pos.token1.address.toLowerCase()] || 0;
      pos.token0USD = p0; pos.token1USD = p1;
      pos.positionValueUSD = pos.amount0 * p0 + pos.amount1 * p1;
      pos.feesValueUSD = pos.feesOwed0 * p0 + pos.feesOwed1 * p1;
      pos.totalValueUSD = pos.positionValueUSD + pos.feesValueUSD;

      // 累计日化 (创建至今)
      if (pos.createdAt > 0 && pos.positionValueUSD >= 10) {
        const totalMs = Date.now() - pos.createdAt;
        const totalDays = totalMs / 86400000;
        if (totalDays > 0) {
          const cf = pos.collectedFees || { token0: 0, token1: 0 };
          const totalFeesUSD = cf.token0 * p0 + cf.token1 * p1 + pos.feesValueUSD;
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

  const wallets = walletResults.filter(wr => wr.positions.length > 0);
  wallets.sort((a, b) => parseInt((a.name.match(/\d+/) || ['0'])[0]) - parseInt((b.name.match(/\d+/) || ['0'])[0]));

  // 钱包闲置余额: 按 fund-config 启用/勾选过滤; 失败沿用上轮快照 (按当前勾选过滤), 不拖累主数据
  const fundCfg = loadFundCfgEvm();
  const fundWallets = fundSelected(fundCfg, chainId, WALLETS);
  let idle = null;
  if (fundWallets.length) {
    idle = filterIdleByWallets(st.lastIdle || st.cache.data?.idle || null, fundWallets);
    try {
      idle = await fetchIdleBalances(chainId, fundWallets, idleCand, usdPrices);
      st.lastIdle = idle;
    } catch (e) { console.error(`[${chainId}] idle balances failed:`, e.message?.slice(0, 100)); }
  }

  // 强刷时同步跑一轮初始资金增量续扫 (每钱包 1 段×2 方向, 秒级), 让刷新按钮把资金数据一并带新
  if (cfg.fundingFromLogs && fundWallets.length && forceRefresh) {
    await runFundingQueue(chainId).catch(e => console.error(`[${chainId}] funding sync:`, e.message?.slice(0, 80)));
  }

  // 初始资金 (净入金): 从 funding 缓存注入 (后台队列独立回填, 此处零 RPC)
  if (cfg.fundingFromLogs && idle && idle.byWallet) {
    const fc = loadFundingCache(chainId);
    let fin = 0, fout = 0; const partialNames = []; let anyData = false;
    for (const [a, wI] of Object.entries(idle.byWallet)) {
      const f = fc[a.toLowerCase()];
      if (!f || (!f.updatedAt && f.stopped !== 'budget')) continue;
      anyData = true;
      if (f.stopped === 'budget') { wI.funding = { partial: true }; partialNames.push(wI.name); continue; }
      wI.funding = {
        inUSD: f.inUSD, outUSD: f.outUSD, netUSD: f.inUSD - f.outUSD,
        partial: false, catchingUp: f.stopped === 'rpc', events: f.events,
      };
      fin += f.inUSD; fout += f.outUSD;
    }
    if (anyData) idle.funding = { inUSD: fin, outUSD: fout, netUSD: fin - fout, partialWallets: partialNames };
  }

  const result = {
    wallets, grandTotalUSD, idle, timestamp: Date.now(),
    stats: { totalActive, totalInRange, totalOutOfRange, totalFees, walletsWithActiveLP, totalWallets: WALLETS.length },
  };
  st.cache = { data: result, timestamp: Date.now() };
  try { fs.writeFileSync(st.posFile, JSON.stringify(st.cache)); } catch {}
  console.log(`[${chainId}] Fetch done. ${wallets.length} wallets w/ positions, ${totalActive} active, total $${grandTotalUSD.toFixed(2)}`);
  return result;
}

// --- 路由挂载 ---
function mountEvmRoutes(app, adminGuard) {
  for (const chainId of Object.keys(EVM_CHAINS)) {
    const base = `/api/${chainId}`;
    // 每链独立钱包文件 wallets-<chain>.json, 与 BSC/SOL 完全隔离
    app.get(`${base}/wallets`, (req, res) => res.json(loadWallets(chainId)));
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
      // 从缓存里剔除该钱包立即生效, 其余数据保留; 后台补一轮刷新总计
      const st = chainState(chainId);
      if (st.cache.data) {
        st.cache.data.wallets = st.cache.data.wallets.filter(w => w.address.toLowerCase() !== addr);
        st.cache.data.grandTotalUSD = st.cache.data.wallets.reduce((s, w) => s + (w.totalUSD || 0), 0);
        dropIdleWallet(st.cache.data.idle, addr);
      }
      dropIdleWallet(st.lastIdle, addr);
      if (st.lastGood) delete st.lastGood[addr];
      kickRefresh(chainId);
      console.log(`[${chainId}] Wallet removed: ${removed.name} (${addr})`);
      res.json({ ok: true, wallets });
    });
    // 编辑钱包: 改名和/或换地址。改名零 RPC 就地更新; 换地址=删旧+加新, 不清整链缓存
    app.patch(`${base}/wallets/:address`, adminGuard, (req, res) => {
      const cur = req.params.address.toLowerCase();
      const wallets = loadWallets(chainId);
      const idx = wallets.findIndex(w => w.address.toLowerCase() === cur);
      if (idx === -1) return res.status(404).json({ error: '地址不存在' });
      const { name, address } = req.body || {};
      let newName, newAddr;
      if (name !== undefined) {
        newName = String(name).trim();
        if (!newName) return res.status(400).json({ error: '名称不能为空' });
      }
      if (address !== undefined) {
        newAddr = String(address).trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(newAddr)) return res.status(400).json({ error: '无效的 EVM 地址' });
        if (newAddr !== cur && wallets.some((w, i) => i !== idx && w.address.toLowerCase() === newAddr)) return res.status(409).json({ error: '地址已存在' });
      }
      if (newName === undefined && newAddr === undefined) return res.status(400).json({ error: '需要 name 或 address' });
      const old = { ...wallets[idx] };
      const addrChanged = newAddr !== undefined && newAddr !== cur;
      if (newName !== undefined) wallets[idx].name = newName;
      if (newAddr !== undefined) wallets[idx].address = newAddr;
      saveWallets(chainId, wallets);
      const st = chainState(chainId);
      if (addrChanged) {
        // 旧地址就地剔出缓存, 新地址靠后台刷新补进来 (与删除+添加同语义)
        if (st.cache.data) {
          st.cache.data.wallets = st.cache.data.wallets.filter(w => w.address.toLowerCase() !== cur);
          st.cache.data.grandTotalUSD = st.cache.data.wallets.reduce((s, w) => s + (w.totalUSD || 0), 0);
          dropIdleWallet(st.cache.data.idle, cur);
          try { fs.writeFileSync(st.posFile, JSON.stringify(st.cache)); } catch {}
        }
        dropIdleWallet(st.lastIdle, cur);
        if (st.lastGood) delete st.lastGood[cur];
        kickRefresh(chainId);
      } else {
        if (st.cache.data) {
          for (const w of st.cache.data.wallets) if (w.address.toLowerCase() === cur) w.name = wallets[idx].name;
          if (st.cache.data.idle?.byWallet?.[cur]) st.cache.data.idle.byWallet[cur].name = wallets[idx].name;
          try { fs.writeFileSync(st.posFile, JSON.stringify(st.cache)); } catch {}
        }
        if (st.lastIdle?.byWallet?.[cur]) st.lastIdle.byWallet[cur].name = wallets[idx].name;
        if (st.lastGood && st.lastGood[cur]) st.lastGood[cur].name = wallets[idx].name;
      }
      console.log(`[${chainId}] Wallet updated: ${old.name} (${old.address}) -> ${wallets[idx].name} (${wallets[idx].address})`);
      res.json({ ok: true, wallets });
    });
    app.get(`${base}/positions`, async (req, res) => {
      try {
        res.json(await fetchChainPositions(chainId, req.query.refresh === 'true'));
      } catch (e) {
        console.error(`[${chainId}] API error:`, e.message);
        res.status(500).json({ error: e.message });
      }
    });
  }
  console.log(`EVM adapter mounted: ${Object.keys(EVM_CHAINS).map(c => `/api/${c}/*`).join(', ')}`);

  // 服务端定时自动刷新 (与 BSC/SOL 同架构): 每 10 分钟后台刷一轮, 不依赖前端访问触发
  for (const chainId of Object.keys(EVM_CHAINS)) {
    setInterval(() => {
      const st = chainState(chainId);
      if (st.fetchInFlight) { console.log(`[${chainId}][auto] skip: fetch in flight`); return; }
      st.fetchInFlight = fetchInner(chainId, false)
        .then(() => console.log(`[${chainId}][auto] scheduled refresh done`))
        .catch(e => console.error(`[${chainId}][auto] scheduled refresh failed:`, e.message))
        .finally(() => { st.fetchInFlight = null; });
    }, CACHE_TTL);
    // 初始资金后台队列: 启动 90s 后首跑 (错开预热), 之后随 5min 刷新周期增量续扫 (每轮每钱包 1 段×2 方向)
    if (EVM_CHAINS[chainId].fundingFromLogs) {
      setTimeout(() => runFundingQueue(chainId).catch(e => console.error(`[${chainId}] funding queue:`, e.message)), 90 * 1000);
      setInterval(() => runFundingQueue(chainId).catch(e => console.error(`[${chainId}] funding queue:`, e.message)), CACHE_TTL);
    }
    // 启动预热: 重启后缓存陈旧就立即补一轮 (eth 35s / rh 45s, 错开 BSC 和 SOL)
    const delay = ({ eth: 35, rh: 45, base: 55 }[chainId] || 45) * 1000;
    setTimeout(() => {
      const st = chainState(chainId);
      if (st.fetchInFlight) return;
      if (st.cache.data && Date.now() - st.cache.timestamp < CACHE_TTL / 2) { console.log(`[${chainId}][auto] 预热跳过: 缓存还新鲜`); return; }
      console.log(`[${chainId}][auto] 启动预热刷新...`);
      st.fetchInFlight = fetchInner(chainId, false)
        .then(() => console.log(`[${chainId}][auto] 预热刷新完成`))
        .catch(e => console.error(`[${chainId}][auto] 预热刷新失败:`, e.message))
        .finally(() => { st.fetchInFlight = null; });
    }, delay);
  }
}

module.exports = { mountEvmRoutes, EVM_CHAINS, kickRefresh,
  _entryTest: { getV3EntryData, getV4EntryData, getV3EntrySubgraph, getV4EntrySubgraph, getTokenInfo } };  // 建仓回溯的独立验证入口
