// =============================================================
// pnl-ledger.js — 钱包盈亏账本 (无子图链 rh / arc: 纯链上日志重建)
//
// 目标: 给每个仓位算出三件事, 并按钱包列出历史仓位
//   1. 开仓成本 = 钱包为这仓真实付出的钱 (不是开仓时点的市值):
//      钱包全链 ERC20 Transfer 流水按 tx 归并 → 换币 (swap) 建立「持仓批次」(加权平均成本),
//      开仓 tx 的净流出按成本价扣批次 (zap 一笔换币+开仓的, 流出的稳定币就是全部成本, 天然含换币损耗/滑点);
//      流出覆盖不了入金市值的部分 (原生 ETH 直转不产生日志 / 转入的仓位) 按当时市值补, 标 approx。
//   2. 已提回本金 / 已领手续费: 减仓·销毁 tx 的仓位事件按当块池价折算本金, V3 Collect 减去待提本金即手续费,
//      V4 无手续费事件 → 钱包实收市值 − 本金市值。
//   3. 历史仓位: NFT Transfer (mint/转入/转出/burn) 决定归属期; 已 burn / 清空的仓归「已关闭」, 净利润 = 提回 + 手续费 − 成本。
//
// 数据源全是 RPC 日志 (rh 支持按钱包 topic 全链扫; 每钱包一两百条 Transfer, 几十次 getLogs):
//   - 钱包 Transfer: topics [Transfer, null, wallet] / [Transfer, wallet, null] (同一过滤天然带回 NPM/PM 的 ERC721 事件)
//   - V3 仓位事件: NPM Increase/Decrease/Collect, topic1=tokenId (一个钱包全部 id 用 OR 列表一次扫)
//   - V4 仓位事件: PoolManager ModifyLiquidity (topics poolId + sender=PM), data.salt=tokenId; 按池共享扫描
//   - 历史池价: Swap 事件 sqrtPriceX96 (evm-adapter.entryPricesAtBlock), 稳定币=1, WETH=coingecko 小时价
// 全部结果持久化到 pnl-ledger-<chain>.json (游标增量), 拉取主流程零 RPC 只读内存。
// 拿不准的宁可标 approx / 缺失, 不硬编。高频 bot 钱包 (原始 Transfer 超 RAW_LIMIT) 放弃 (partial)。
// =============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

let E = null;   // evm-adapter 注入的内部工具 (由 evm-adapter 在挂载时 init, 避免循环 require)

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const V3_INC = ethers.id('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const V3_DEC = ethers.id('DecreaseLiquidity(uint256,uint128,uint256,uint256)');
const V3_COL = ethers.id('Collect(uint256,address,uint256,uint256)');
const V3_POOL_MINT = ethers.id('Mint(address,address,int24,int24,uint128,uint256,uint256)');
const V4_MODIFY = ethers.id('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const ZERO32 = '0x' + '0'.repeat(64);
const RAW_LIMIT = 8000;                 // 钱包原始 Transfer 上限, 超过=高频 bot, 放弃
const ROUND_BUDGET_MS = 240 * 1000;     // 每轮后台扫描预算 (超了下轮续, 游标已落盘)
const FIRST_BUDGET_MS = 12 * 60 * 1000; // 启动后首轮预算放大: 首扫每钱包约 1-3 分钟 (实测 51 tx/14 仓的钱包 168s)
const ROUND_MS = 30 * 60 * 1000;        // 后台轮询周期
const PX_RETRY_MS = 6 * 3600 * 1000;    // 历史价拿不到的块, 多久后重试
const POOL_META_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)'];
const PM_KEYS_ABI = ['function poolKeys(bytes25) view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'];

const state = {};   // chainId -> { file, d, busy, lastRun }

function init(api) { E = api; }
function enabled(chainId) { return !!(E && E.EVM_CHAINS[chainId] && E.EVM_CHAINS[chainId].ledgerFromLogs && !E.EVM_CHAINS[chainId].pending); }

function ledgerState(chainId) {
  if (!state[chainId]) {
    const file = path.join(__dirname, `pnl-ledger-${chainId}.json`);
    let d = null;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    if (!d || d.v !== 1) d = { v: 1, wallets: {}, pools: {}, v4: {}, px: {}, bts: {} };
    state[chainId] = { file, d, busy: false, lastRun: 0 };
  }
  return state[chainId];
}
function save(chainId) {
  const st = ledgerState(chainId);
  try {
    const tmp = st.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st.d));
    fs.renameSync(tmp, st.file);
  } catch (e) { console.error(`[${chainId}] pnl-ledger 落盘失败:`, e.message?.slice(0, 80)); }
}
function hexInt(h) { let v = BigInt('0x' + h); if (v >= 1n << 255n) v -= 1n << 256n; return v; }
function hexI24(h) { let v = parseInt(h.slice(-6), 16); if (v >= 0x800000) v -= 0x1000000; return v; }
function padAddr(a) { return ethers.zeroPadValue(a, 32).toLowerCase(); }
function topicAddr(t) { return '0x' + String(t).slice(26).toLowerCase(); }
function low(a) { return String(a || '').toLowerCase(); }
function num(x) { const v = Number(x); return isFinite(v) ? v : 0; }

// --- 自适应分段 getLogs: 超时/超量则缩段重试; 带截止时间 (预算) 与 RPC 限速 (arc) ---
async function scanAdaptive(chainId, filter, fromBlock, toBlock, deadline) {
  const st = E.chainState(chainId);
  const cfg = E.EVM_CHAINS[chainId];
  const maxChunk = Math.min(5000000, cfg.logChunk || 5000000);
  const gap = cfg.logGapMs || 400;
  const out = [];
  let f = fromBlock, chunk = maxChunk, stopped = null, fails = 0;
  while (f <= toBlock) {
    if (Date.now() > deadline) { stopped = 'budget'; break; }
    const to = Math.min(f + chunk - 1, toBlock);
    try {
      const logs = await st.provider.send('eth_getLogs', [{ ...filter, fromBlock: '0x' + f.toString(16), toBlock: '0x' + to.toString(16) }]);
      out.push(...logs);
      f = to + 1; fails = 0;
      if (chunk < maxChunk) chunk = Math.min(chunk * 2, maxChunk);
      if (f <= toBlock) await E.sleep(gap);
    } catch (e) {
      // rh: 5M 块窗口间歇 "log query timed out"; 缩段 (÷4) 直到 300k, 再不行本轮放弃 (下轮续)
      if (chunk > 300000) { chunk = Math.max(300000, Math.floor(chunk / 4)); await E.sleep(1200); continue; }
      if (++fails < 3) { await E.sleep(1500 * fails); continue; }
      stopped = 'rpc'; break;
    }
  }
  return { logs: out, scannedTo: f - 1, stopped };
}

async function blockTs(chainId, block) {
  const st = ledgerState(chainId);
  if (st.d.bts[block]) return st.d.bts[block];
  const b = await E.withRetry(() => E.chainState(chainId).provider.getBlock(block), 2, 500).catch(() => null);
  if (!b) return 0;
  st.d.bts[block] = b.timestamp * 1000;
  return st.d.bts[block];
}

// =============================================================
// 1. 钱包 Transfer 流水 (增量游标): 按 tx 归并 { b, e: {logIndex: [token, ±rawAmt]}, n: {logIndex: [kind, id, dir]} }
// =============================================================
async function scanWallet(chainId, addr, deadline) {
  const st = ledgerState(chainId);
  const cfg = E.EVM_CHAINS[chainId];
  const W = st.d.wallets[addr] || (st.d.wallets[addr] = { scannedTo: -1, partial: false, txs: {}, pos: {}, updatedAt: 0 });
  if (W.partial) return W;
  const latest = await E.chainState(chainId).provider.getBlockNumber();
  const floor = cfg.ledgerFloorBlock != null ? cfg.ledgerFloorBlock : (cfg.logChunk ? (cfg.v4.deployBlock || 0) : 0);
  const from = Math.max(floor, W.scannedTo + 1);
  if (from > latest) return W;
  const wt = padAddr(addr);
  const rIn = await scanAdaptive(chainId, { topics: [TRANSFER_TOPIC, null, wt] }, from, latest, deadline);
  const rOut = await scanAdaptive(chainId, { topics: [TRANSFER_TOPIC, wt, null] }, from, latest, deadline);
  const scannedTo = Math.min(rIn.scannedTo, rOut.scannedTo);
  if (scannedTo < from) return W;   // 一段都没扫成
  const rawCount = Object.values(W.txs).reduce((s, t) => s + Object.keys(t.e || {}).length, 0) + rIn.logs.length + rOut.logs.length;
  if (rawCount > RAW_LIMIT) {
    W.partial = true; W.txs = {}; W.pos = {}; W.updatedAt = Date.now();
    console.log(`[${chainId}] pnl-ledger ${addr.slice(0, 10)}: Transfer ${rawCount} 条超上限, 高频钱包放弃`);
    return W;
  }
  const npm = low(cfg.v3.npm), pm = low(cfg.v4.pm);
  for (const l of [...rIn.logs, ...rOut.logs]) {
    const b = parseInt(l.blockNumber, 16);
    if (b > scannedTo) continue;
    const li = parseInt(l.logIndex, 16);
    const h = l.transactionHash;
    const tx = W.txs[h] || (W.txs[h] = { b });
    if (l.topics.length === 4) {
      const c = low(l.address);
      if (c !== npm && c !== pm) continue;                       // 其他 NFT 不关心
      const fromA = topicAddr(l.topics[1]), toA = topicAddr(l.topics[2]);
      const id = BigInt(l.topics[3]).toString();
      let dir;
      if (l.topics[1] === ZERO32) dir = 'mint';
      else if (l.topics[2] === ZERO32) dir = 'burn';
      else dir = toA === addr ? 'in' : 'out';
      if (dir === 'mint' && toA !== addr) continue;             // 不是铸给本钱包的 (理论上不会匹配到)
      if (dir === 'burn' && fromA !== addr) continue;
      (tx.n = tx.n || {})[li] = [c === npm ? 'v3' : 'v4', id, dir];
      continue;
    }
    if (l.topics.length !== 3 || !l.data || l.data.length < 66) continue;
    const fromA = topicAddr(l.topics[1]), toA = topicAddr(l.topics[2]);
    if (fromA === toA) continue;
    const amt = BigInt(l.data.slice(0, 66));
    if (amt === 0n) continue;
    (tx.e = tx.e || {})[li] = [low(l.address), (toA === addr ? amt : -amt).toString()];
  }
  W.scannedTo = scannedTo;
  W.stopped = (rIn.stopped || rOut.stopped) || null;
  W.updatedAt = Date.now();
  return W;
}

// =============================================================
// 2. 仓位发现 + 池元数据 + 仓位事件
// =============================================================
async function poolMeta(chainId, kind, spec) {
  const st = ledgerState(chainId);
  const key = low(spec);
  if (st.d.pools[key]) return st.d.pools[key];
  const cfg = E.EVM_CHAINS[chainId];
  const provider = E.chainState(chainId).provider;
  let meta = null;
  if (kind === 'v3') {
    const c = new ethers.Contract(spec, POOL_META_ABI, provider);
    const [a0, a1, fee] = await Promise.all([c.token0(), c.token1(), c.fee()]);
    const t0 = await E.getTokenInfo(chainId, a0), t1 = await E.getTokenInfo(chainId, a1);
    meta = { kind, t0: { address: low(t0.address), symbol: t0.symbol, decimals: t0.decimals }, t1: { address: low(t1.address), symbol: t1.symbol, decimals: t1.decimals }, fee: Number(fee) };
  } else {
    const c = new ethers.Contract(cfg.v4.pm, PM_KEYS_ABI, provider);
    const k = await c.poolKeys(spec.slice(0, 52));
    const t0 = await E.getTokenInfo(chainId, k.currency0), t1 = await E.getTokenInfo(chainId, k.currency1);
    meta = { kind, t0: { address: low(t0.address), symbol: t0.symbol, decimals: t0.decimals }, t1: { address: low(t1.address), symbol: t1.symbol, decimals: t1.decimals }, fee: Number(k.fee), native: low(k.currency0) === low(ethers.ZeroAddress) };
  }
  st.d.pools[key] = meta;
  return meta;
}

// mint tx 回执里找池子 + 区间: V3 看池子的 Mint 事件 (owner=NPM, ticks 在 topics), V4 看 PoolManager 的 ModifyLiquidity (salt=tokenId)
async function resolveFromMintTx(chainId, P) {
  const cfg = E.EVM_CHAINS[chainId];
  const provider = E.chainState(chainId).provider;
  const rc = await E.withRetry(() => provider.send('eth_getTransactionReceipt', [P.mtx]), 2, 600).catch(() => null);
  if (!rc || !rc.logs) return false;
  if (P.k === 'v3') {
    // 同一 tx 里可能 mint 多个仓 (multicall): 用本 id 的 IncreaseLiquidity 之前最近的那条池子 Mint
    const idTopic = '0x' + BigInt(P.id).toString(16).padStart(64, '0');
    const incIdx = rc.logs.findIndex(l => low(l.address) === low(cfg.v3.npm) && l.topics[0] === V3_INC && l.topics[1] === idTopic);
    if (incIdx < 0) return false;
    for (let i = incIdx - 1; i >= 0; i--) {
      const l = rc.logs[i];
      if (l.topics[0] === V3_POOL_MINT && l.topics.length === 4) {
        P.spec = low(l.address); P.tl = hexI24(l.topics[2]); P.tu = hexI24(l.topics[3]);
        return true;
      }
    }
    return false;
  }
  const saltHex = BigInt(P.id).toString(16).padStart(64, '0');
  for (const l of rc.logs) {
    if (low(l.address) !== low(cfg.v4.poolManager) || l.topics[0] !== V4_MODIFY) continue;
    const hex = l.data.slice(2);
    if (hex.slice(192, 256) !== saltHex) continue;
    P.spec = low(l.topics[1]); P.tl = hexI24(hex.slice(0, 64)); P.tu = hexI24(hex.slice(64, 128));
    return true;
  }
  return false;
}

// mint 块已知但 tx 未知 (仓位不在本钱包的 Transfer 流水里, 如扫描不全): 在该块找 NFT 铸造事件拿 tx
async function findMintTx(chainId, contract, id, block) {
  const provider = E.chainState(chainId).provider;
  const tid = '0x' + BigInt(id).toString(16).padStart(64, '0');
  const logs = await E.withRetry(() => provider.send('eth_getLogs', [{ address: contract, fromBlock: '0x' + block.toString(16), toBlock: '0x' + block.toString(16), topics: [TRANSFER_TOPIC, ZERO32, null, tid] }]), 2, 600).catch(() => []);
  return logs[0] ? logs[0].transactionHash : null;
}

// 钱包的仓位集合: NFT 流水 (mint/in/out/burn) ∪ 当前活跃仓 (positions 缓存, 防流水不全)
async function ensurePositions(chainId, addr, W, livePositions, deadline) {
  const cfg = E.EVM_CHAINS[chainId];
  const nftEvs = [];
  for (const [h, t] of Object.entries(W.txs)) for (const [li, n] of Object.entries(t.n || {})) nftEvs.push({ b: t.b, li: +li, h, k: n[0], id: n[1], dir: n[2] });
  nftEvs.sort((a, b) => a.b - b.b || a.li - b.li);
  for (const e of nftEvs) {
    const key = `${e.k}-${e.id}`;
    const P = W.pos[key] || (W.pos[key] = { k: e.k, id: e.id, evs: [], evTo: 0 });
    if (e.dir === 'mint') { P.mb = e.b; P.mtx = e.h; }
    else if (e.dir === 'in') { P.inB = e.b; P.outB = 0; P.burnB = 0; if (!P.mb) { P.mb = e.b; P.mtx = P.mtx || e.h; } }
    else if (e.dir === 'out') { P.outB = e.b; }
    else if (e.dir === 'burn') { P.burnB = e.b; P.burnTx = e.h; }
  }
  for (const p of livePositions || []) {
    const k = p.protocol === 'V4' ? 'v4' : 'v3';
    const key = `${k}-${p.tokenId}`;
    const P = W.pos[key] || (W.pos[key] = { k, id: String(p.tokenId), evs: [], evTo: 0 });
    P.live = 1;
    if (!P.spec) { P.spec = low(p.poolAddress); P.tl = p.tickLower; P.tu = p.tickUpper; }
    if (P.outB || P.burnB) { P.outB = 0; P.burnB = 0; }   // 链上还持有 (转出后又转回等): 以活跃为准
  }
  for (const P of Object.values(W.pos)) {
    if (Date.now() > deadline) break;
    try {
      const contract = P.k === 'v3' ? cfg.v3.npm : cfg.v4.pm;
      if (!P.mb) {
        P.mb = E.mintBlockFromScan(chainId, contract, P.id) || 0;
        if (!P.mb) { const m = await E.findMintEvent(chainId, contract, P.id); if (m) P.mb = m.block; }
        if (!P.mb) continue;
      }
      if (!P.mtx && !P.spec) P.mtx = await findMintTx(chainId, contract, P.id, P.mb);
      if (!P.spec && P.mtx) await resolveFromMintTx(chainId, P);
      if (!P.spec) continue;
      await poolMeta(chainId, P.k, P.spec);
      if (!P.mts) P.mts = await blockTs(chainId, P.mb);
      if (P.burnB && !P.burnTs) P.burnTs = await blockTs(chainId, P.burnB);
      if (P.outB && !P.outTs) P.outTs = await blockTs(chainId, P.outB);
    } catch (e) {
      console.error(`[${chainId}] pnl-ledger 仓位元数据失败 ${P.k}-${P.id}:`, e.message?.slice(0, 80));
    }
  }
}

// V3 仓位事件: 一个钱包全部 tokenId 用 topic OR 列表一次扫 (从最早的未扫块起)
async function scanV3Events(chainId, W, deadline) {
  const cfg = E.EVM_CHAINS[chainId];
  const latest = await E.chainState(chainId).provider.getBlockNumber();
  const need = Object.values(W.pos).filter(P => P.k === 'v3' && P.spec && P.mb && !P.done);
  if (!need.length) return true;
  const from = Math.min(...need.map(P => P.evTo ? P.evTo + 1 : P.mb));
  if (from > latest) return true;
  const ids = need.map(P => '0x' + BigInt(P.id).toString(16).padStart(64, '0'));
  const r = await scanAdaptive(chainId, { address: cfg.v3.npm, topics: [[V3_INC, V3_DEC, V3_COL], ids] }, from, latest, deadline);
  if (r.scannedTo < from) return false;
  const byId = new Map(need.map(P => [P.id, P]));
  for (const l of r.logs) {
    const b = parseInt(l.blockNumber, 16);
    if (b > r.scannedTo) continue;
    const id = BigInt(l.topics[1]).toString();
    const P = byId.get(id); if (!P) continue;
    const li = parseInt(l.logIndex, 16);
    if (P.evs.some(e => e.b === b && e.li === li)) continue;
    const hex = l.data.slice(2);
    const t = l.topics[0] === V3_INC ? 'inc' : l.topics[0] === V3_DEC ? 'dec' : 'col';
    P.evs.push({ b, li, tx: l.transactionHash, t, a0: BigInt('0x' + hex.slice(64, 128)).toString(), a1: BigInt('0x' + hex.slice(128, 192)).toString(), l: t === 'col' ? '0' : BigInt('0x' + hex.slice(0, 64)).toString() });
  }
  for (const P of need) {
    if (r.scannedTo >= (P.evTo || 0)) P.evTo = r.scannedTo;
    P.evs.sort((a, b) => a.b - b.b || a.li - b.li);
    // 已销毁 / 已转出的仓: 归属期结束后不再有本钱包的事件, 扫过归属终点即冻结
    const endB = P.burnB || P.outB;
    if (endB && P.evTo >= endB) P.done = 1;
  }
  return !r.stopped;
}

// V4 仓位事件 (主路径): 钱包每笔 tx 的回执里直接取 PoolManager ModifyLiquidity (sender=PM)
//   —— 一个钱包几十到两千笔 tx, 每笔一次 getTransactionReceipt; 按池扫全链 (125 个池 × 分段) 首轮 12 分钟只扫完 5 个池, 弃用为主路径。
//   盲区: 原生币池 (rh ETH/USDG, currency0=0x0) 只动 ETH 一侧的加/减仓/领费没有任何 ERC20 日志 → tx 不在流水里, 由 scanV4Events 按池补扫。
async function fetchReceipts(chainId, W, deadline) {
  const cfg = E.EVM_CHAINS[chainId];
  const provider = E.chainState(chainId).provider;
  const pmTopic = padAddr(cfg.v4.pm), poolMgr = low(cfg.v4.poolManager);
  const todo = Object.entries(W.txs).filter(([, t]) => !t.r);
  for (let i = 0; i < todo.length; i += 4) {
    if (Date.now() > deadline) break;
    await Promise.all(todo.slice(i, i + 4).map(async ([h, t]) => {
      const rc = await E.withRetry(() => provider.send('eth_getTransactionReceipt', [h]), 2, 500).catch(() => null);
      if (!rc || !rc.logs) return;
      const m = [];
      for (const l of rc.logs) {
        if (low(l.address) !== poolMgr || l.topics[0] !== V4_MODIFY || low(l.topics[2]) !== pmTopic) continue;
        const hex = l.data.slice(2);
        // [poolId, salt(tokenId), tickLower, tickUpper, liquidityDelta, logIndex]
        m.push([low(l.topics[1]), BigInt('0x' + hex.slice(192, 256)).toString(), hexI24(hex.slice(0, 64)), hexI24(hex.slice(64, 128)), hexInt(hex.slice(128, 192)).toString(), parseInt(l.logIndex, 16)]);
      }
      if (m.length) t.m = m; else delete t.m;
      t.r = 1;
    }));
    if (i + 4 < todo.length) await E.sleep(60);
  }
  return Object.values(W.txs).every(t => t.r);
}

// V4 仓位事件 (补扫): 只对原生币池按池扫 ModifyLiquidity (topics poolId+sender=PM), 只留 wanted salt 的事件
async function scanV4Events(chainId, deadline) {
  const st = ledgerState(chainId);
  const cfg = E.EVM_CHAINS[chainId];
  const latest = await E.chainState(chainId).provider.getBlockNumber();
  // 收集全部钱包的 V4 仓 → 按池分组
  const byPool = new Map();
  for (const W of Object.values(st.d.wallets)) for (const P of Object.values(W.pos)) {
    if (P.k !== 'v4' || !P.spec || !P.mb) continue;
    if (!(st.d.pools[P.spec] && st.d.pools[P.spec].native)) continue;   // 非原生币池: 回执路径已覆盖
    const a = byPool.get(P.spec) || []; a.push(P); byPool.set(P.spec, a);
  }
  const pmTopic = padAddr(cfg.v4.pm);
  let complete = true;
  for (const [poolId, arr] of byPool) {
    if (Date.now() > deadline) return false;
    const pool = st.d.v4[poolId] || (st.d.v4[poolId] = { from: 0, to: 0, wanted: {}, ev: {} });
    const filter = { address: cfg.v4.poolManager, topics: [V4_MODIFY, poolId, pmTopic] };
    const ingest = (logs, upTo, onlyIds) => {
      for (const l of logs) {
        const b = parseInt(l.blockNumber, 16);
        if (b > upTo) continue;
        const hex = l.data.slice(2);
        const id = BigInt('0x' + hex.slice(192, 256)).toString();
        if (!pool.wanted[id] && !(onlyIds && onlyIds.has(id))) continue;
        if (onlyIds && !onlyIds.has(id)) continue;
        const li = parseInt(l.logIndex, 16);
        const list = pool.ev[id] || (pool.ev[id] = []);
        if (list.some(e => e.b === b && e.li === li)) continue;
        list.push({ b, li, tx: l.transactionHash, d: hexInt(hex.slice(128, 192)).toString(), tl: hexI24(hex.slice(0, 64)), tu: hexI24(hex.slice(64, 128)) });
        list.sort((x, y) => x.b - y.b || x.li - y.li);
      }
    };
    const newIds = arr.filter(P => !pool.wanted[P.id]);
    const allOpen = arr.some(P => !(P.burnB || P.outB) || (P.burnB || P.outB) > pool.to);
    if (!pool.to) {
      // 首扫: 从最早 mint 块到链头
      const from = Math.min(...arr.map(P => P.mb));
      for (const P of arr) pool.wanted[P.id] = 1;
      const r = await scanAdaptive(chainId, filter, from, latest, deadline);
      if (r.scannedTo < from) { for (const P of arr) delete pool.wanted[P.id]; complete = false; continue; }
      ingest(r.logs, r.scannedTo);
      pool.from = from; pool.to = r.scannedTo;
      if (r.stopped) complete = false;
      continue;
    }
    // 新出现的仓: mint 块早于已扫下沿 → 补扫 [mb, from-1]; 落在已扫区间内的 → 只为它们重扫 [mb, to]
    if (newIds.length) {
      const early = newIds.filter(P => P.mb < pool.from);
      if (early.length) {
        const from = Math.min(...early.map(P => P.mb));
        const r = await scanAdaptive(chainId, filter, from, pool.from - 1, deadline);
        if (r.scannedTo >= pool.from - 1) {
          for (const P of newIds) pool.wanted[P.id] = 1;
          ingest(r.logs, r.scannedTo);
          pool.from = from;
        } else { complete = false; continue; }
      }
      const inside = newIds.filter(P => P.mb >= pool.from && P.mb <= pool.to);
      if (inside.length) {
        const from = Math.min(...inside.map(P => P.mb));
        const only = new Set(inside.map(P => P.id));
        const r = await scanAdaptive(chainId, filter, from, pool.to, deadline);
        if (r.scannedTo >= pool.to) { for (const P of inside) pool.wanted[P.id] = 1; ingest(r.logs, pool.to, only); }
        else { complete = false; continue; }
      }
      for (const P of newIds) if (P.mb > pool.to) pool.wanted[P.id] = 1;
    }
    // 向链头延伸: 只在池里还有未结束的仓时
    if (allOpen && pool.to < latest) {
      const r = await scanAdaptive(chainId, filter, pool.to + 1, latest, deadline);
      if (r.scannedTo > pool.to) { ingest(r.logs, r.scannedTo); pool.to = r.scannedTo; }
      if (r.stopped) complete = false;
    }
  }
  return complete;
}

// =============================================================
// 3. 定价 (历史池价 + 稳定币 + WETH), 全部持久化 memo
// =============================================================
async function pxAt(chainId, spec, block) {
  const st = ledgerState(chainId);
  const key = `${spec}:${block}`;
  const c = st.d.px[key];
  if (c && c.p0 != null) return c;
  if (c && c.f && Date.now() - c.f < PX_RETRY_MS) return null;
  const meta = st.d.pools[spec];
  if (!meta) return null;
  const specObj = meta.kind === 'v4' ? { kind: 'v4', poolId: spec } : { kind: 'v3', poolAddress: spec };
  const r = await E.entryPricesAtBlock(chainId, specObj, meta.t0, meta.t1, block, new Map()).catch(() => null);
  if (!r) { st.d.px[key] = { f: Date.now() }; return null; }
  st.d.px[key] = { p0: r.p0, p1: r.p1, sq: r.sqrt.toString(), ts: r.ts };
  if (!st.d.bts[block]) st.d.bts[block] = r.ts;
  return st.d.px[key];
}

// 某 token 在某块的美元价: 稳定币=1; WETH/原生=coingecko 小时价; 其他=参考池 (与稳定币/WETH 配对的池) 当块价; 再不行=当前价 (approx)
function buildRefPools(chainId) {
  const st = ledgerState(chainId);
  const cfg = E.EVM_CHAINS[chainId];
  const wn = low(cfg.wrappedNative);
  const ref = {};   // token -> { spec, side, score }
  for (const [spec, m] of Object.entries(st.d.pools)) {
    for (const [side, tok, other] of [[0, m.t0.address, m.t1.address], [1, m.t1.address, m.t0.address]]) {
      if (cfg.stables[tok] || tok === wn) continue;
      const score = cfg.stables[other] ? 2 : other === wn ? 1 : 0;
      if (!score) continue;
      if (!ref[tok] || ref[tok].score < score) ref[tok] = { spec, side, score };
    }
  }
  return ref;
}
async function priceAt(chainId, token, block, ref) {
  const cfg = E.EVM_CHAINS[chainId];
  if (cfg.stables[token]) return { p: 1, approx: false };
  if (token === low(cfg.wrappedNative)) {
    const ts = await blockTs(chainId, block);
    const p = ts ? await E.ethUsdAtTime(ts) : 0;
    if (p > 0) return { p, approx: false };
  }
  const r = ref[token];
  if (r) {
    const px = await pxAt(chainId, r.spec, block);
    if (px) return { p: r.side === 0 ? px.p0 : px.p1, approx: false };
  }
  const cur = (E.chainState(chainId).lastUsdPrices || {})[token] || 0;
  return { p: cur, approx: true };
}

// =============================================================
// 4. 按 tx 时间线重放: 持仓批次 (加权平均成本) + 仓位成本/提回/手续费
// =============================================================
async function computeWallet(chainId, addr, livePositions) {
  const st = ledgerState(chainId);
  const cfg = E.EVM_CHAINS[chainId];
  const W = st.d.wallets[addr];
  if (!W || W.partial) return;
  const ref = buildRefPools(chainId);
  const liveKeys = new Set((livePositions || []).map(p => `${p.protocol === 'V4' ? 'v4' : 'v3'}-${p.tokenId}`));

  // tx 汇总
  const txs = new Map();
  const getTx = (h, b) => { let t = txs.get(h); if (!t) { t = { h, b, li: Infinity, flows: new Map(), nft: [], pev: [] }; txs.set(h, t); } return t; };
  for (const [h, t] of Object.entries(W.txs)) {
    const tx = getTx(h, t.b);
    for (const [li, [tok, amt]] of Object.entries(t.e || {})) { tx.li = Math.min(tx.li, +li); tx.flows.set(tok, (tx.flows.get(tok) || 0n) + BigInt(amt)); }
    for (const [li, n] of Object.entries(t.n || {})) { tx.li = Math.min(tx.li, +li); tx.nft.push({ k: n[0], id: n[1], dir: n[2] }); }
  }
  // V4 事件: 回执提取 (W.txs[h].m) ∪ 原生币池补扫 (st.d.v4), 按 (块, logIndex) 去重
  const v4FromTx = new Map();
  for (const [h, t] of Object.entries(W.txs)) for (const m of (t.m || [])) {
    const key = `v4-${m[1]}`;
    const P = W.pos[key];
    if (!P || low(P.spec || '') !== m[0]) continue;
    const arr = v4FromTx.get(key) || []; arr.push({ b: t.b, li: m[5], tx: h, d: m[4], tl: m[2], tu: m[3] }); v4FromTx.set(key, arr);
  }
  for (const P of Object.values(W.pos)) {
    if (!P.spec) continue;
    let evs;
    if (P.k === 'v3') evs = P.evs;
    else {
      const seenEv = new Set();
      evs = [];
      for (const ev of [...(v4FromTx.get(`v4-${P.id}`) || []), ...((st.d.v4[P.spec] || { ev: {} }).ev[P.id] || [])]) {
        const k = ev.b + ':' + ev.li; if (seenEv.has(k)) continue; seenEv.add(k); evs.push(ev);
      }
      evs.sort((x, y) => x.b - y.b || x.li - y.li);
    }
    for (const ev of evs) {
      if (P.outB && ev.b > P.outB) continue;          // 转出后归新主人
      if (P.inB && ev.b < P.inB && !P.mtx) { /* 转入前的事件也算 (成本无流水对应, 会走 approx 补市值) */ }
      const tx = getTx(ev.tx, ev.b); tx.li = Math.min(tx.li, ev.li); tx.pev.push({ P, ev });
    }
  }
  const order = [...txs.values()].sort((a, b) => a.b - b.b || a.li - b.li);

  // token 精度
  const decOf = {};
  const dec = async tok => { if (decOf[tok] == null) { const i = await E.getTokenInfo(chainId, tok); decOf[tok] = i?.decimals ?? 18; } return decOf[tok]; };
  const hum = async (tok, raw) => Number(raw) / 10 ** (await dec(tok));

  // 持仓批次
  const lots = {};
  const consume = async (tok, qty, block) => {
    if (cfg.stables[tok]) return { cost: qty, approx: false };
    const L = lots[tok];
    if (L && L.q > 0) {
      if (L.q >= qty * 0.999999) { const c = L.c * Math.min(1, qty / L.q); L.q -= qty; L.c -= c; if (L.q < 1e-12) { L.q = 0; L.c = 0; } return { cost: c, approx: !!L.ax }; }
      const c = L.c, excess = qty - L.q; L.q = 0; L.c = 0;
      const pm = await priceAt(chainId, tok, block, ref);
      return { cost: c + excess * pm.p, approx: true };
    }
    const pm = await priceAt(chainId, tok, block, ref);
    return { cost: qty * pm.p, approx: true };
  };
  const addLot = (tok, qty, cost, approx) => {
    if (cfg.stables[tok] || !(qty > 0)) return;
    const L = lots[tok] || (lots[tok] = { q: 0, c: 0, ax: false });
    L.q += qty; L.c += cost; if (approx) L.ax = true;
  };

  // 仓位累计
  const C = {};
  const cOf = P => C[`${P.k}-${P.id}`] || (C[`${P.k}-${P.id}`] = { cost: 0, dep: 0, ret: 0, fees: 0, a: {}, openTs: 0, lastTs: 0, n: 0, approx: false, inc: false, owed0: 0, owed1: 0, liq: 0n });

  // 仓位事件 → 数量 (人类单位) + 当块池价
  const evAmounts = async (P, ev) => {
    const meta = st.d.pools[P.spec]; if (!meta) return null;
    const px = await pxAt(chainId, P.spec, ev.b); if (!px) return null;
    if (P.k === 'v3') {
      const a0 = Number(ev.a0) / 10 ** meta.t0.decimals, a1 = Number(ev.a1) / 10 ** meta.t1.decimals;
      return { kind: ev.t === 'inc' ? 'dep' : ev.t === 'dec' ? 'wd' : 'col', a0, a1, px, meta, liq: BigInt(ev.l || '0') };
    }
    const d = BigInt(ev.d);
    if (d === 0n) return { kind: 'col', a0: 0, a1: 0, px, meta, liq: 0n };
    const mag = d > 0n ? d : -d;
    const { amount0, amount1 } = E.getTokenAmounts(mag, BigInt(px.sq), ev.tl, ev.tu, meta.t0.decimals, meta.t1.decimals);
    return { kind: d > 0n ? 'dep' : 'wd', a0: amount0, a1: amount1, px, meta, liq: d };
  };

  for (const tx of order) {
    const ts = st.d.bts[tx.b] || await blockTs(chainId, tx.b);
    // A. 仓位事件
    const deps = [], wds = [], cols = [];
    for (const { P, ev } of tx.pev) {
      const c = cOf(P);
      const v = await evAmounts(P, ev);
      if (!v) { c.inc = true; continue; }
      const mkt0 = v.a0 * v.px.p0, mkt1 = v.a1 * v.px.p1;
      if (v.kind === 'dep') { deps.push({ P, c, v, mkt: mkt0 + mkt1 }); c.liq += v.liq; }
      else if (v.kind === 'wd') { wds.push({ P, c, v, mkt: mkt0 + mkt1 }); c.liq += (P.k === 'v3' ? -v.liq : v.liq); if (P.k === 'v3') { c.owed0 += v.a0; c.owed1 += v.a1; } }
      else {
        // V3 Collect = 手续费 + 之前减仓待提的本金; V4 delta=0 的 ModifyLiquidity 只是结算手续费 (金额从实收推)
        if (P.k === 'v3') {
          const pr0 = Math.min(v.a0, c.owed0), pr1 = Math.min(v.a1, c.owed1);
          c.owed0 -= pr0; c.owed1 -= pr1;
          const f0 = v.a0 - pr0, f1 = v.a1 - pr1;
          cols.push({ P, c, v, fee: f0 * v.px.p0 + f1 * v.px.p1, known: true });
        } else cols.push({ P, c, v, fee: 0, known: false });
      }
      if (ts > c.lastTs) c.lastTs = ts;
    }
    // B. 钱包流水 (人类单位 + 市值)
    const outs = [], ins = [];
    for (const [tok, raw] of tx.flows) {
      const q = Math.abs(await hum(tok, raw));
      if (!(q > 0)) continue;
      (raw < 0n ? outs : ins).push({ tok, q });
    }
    let outMkt = 0, inMkt = 0, anyApprox = false;
    for (const o of outs) { const p = await priceAt(chainId, o.tok, tx.b, ref); o.mkt = o.q * p.p; outMkt += o.mkt; }
    for (const i of ins) { const p = await priceAt(chainId, i.tok, tx.b, ref); i.mkt = i.q * p.p; i.ax = p.approx; inMkt += i.mkt; }
    // C. 归因
    if (deps.length) {
      let outCost = 0;
      for (const o of outs) { const r = await consume(o.tok, o.q, tx.b); outCost += r.cost; if (r.approx) anyApprox = true; }
      const depMkt = deps.reduce((s, d) => s + d.mkt, 0);
      const wdMkt = wds.reduce((s, w) => s + w.mkt, 0);
      const feeMkt = cols.reduce((s, x) => s + (x.known ? x.fee : 0), 0);
      const visible = outMkt + wdMkt + feeMkt - inMkt;      // 本 tx 里看得见的、投入到仓位的市值
      let costTotal = outCost + wdMkt + feeMkt - inMkt;
      if (depMkt > 0) {
        const coverage = visible / depMkt;
        if (coverage < 0.9) { costTotal += depMkt - Math.max(0, visible); anyApprox = true; }         // 原生 ETH 直转 / 转入的仓: 看不见的部分按市值补
        else if (coverage > 1.3) { costTotal = depMkt * (outMkt > 0 ? outCost / outMkt : 1); anyApprox = true; }   // 流出远超入金 (同 tx 还干了别的): 按成本/市值比折算
      }
      for (const d of deps) {
        const share = depMkt > 0 ? d.mkt / depMkt : 1 / deps.length;
        d.c.cost += Math.max(0, costTotal) * share; d.c.dep += d.mkt; d.c.n++;
        d.c.a[d.v.meta.t0.address] = (d.c.a[d.v.meta.t0.address] || 0) + d.v.a0;
        d.c.a[d.v.meta.t1.address] = (d.c.a[d.v.meta.t1.address] || 0) + d.v.a1;
        if (!d.c.openTs) d.c.openTs = ts;
        if (anyApprox) d.c.approx = true;
      }
      for (const w of wds) { w.c.ret += w.mkt; w.c.a[w.v.meta.t0.address] = (w.c.a[w.v.meta.t0.address] || 0) - w.v.a0; w.c.a[w.v.meta.t1.address] = (w.c.a[w.v.meta.t1.address] || 0) - w.v.a1; }
      for (const x of cols) if (x.known) x.c.fees += x.fee;
      for (const i of ins) addLot(i.tok, i.q, i.mkt, i.ax);   // 找零/退回按市值入批次 (已从成本里扣掉)
    } else if (wds.length || cols.length) {
      const wdMkt = wds.reduce((s, w) => s + w.mkt, 0);
      const v3Fee = cols.reduce((s, x) => s + (x.known ? x.fee : 0), 0);
      for (const w of wds) { w.c.ret += w.mkt; w.c.a[w.v.meta.t0.address] = (w.c.a[w.v.meta.t0.address] || 0) - w.v.a0; w.c.a[w.v.meta.t1.address] = (w.c.a[w.v.meta.t1.address] || 0) - w.v.a1; }
      for (const x of cols) if (x.known) x.c.fees += x.fee;
      // V4: 实收 − 本金 − (同 tx 的 V3 手续费) = V4 手续费, 按本金份额分给 tx 里的 V4 仓 (纯领费则均分)
      const v4 = [...wds.filter(w => w.P.k === 'v4'), ...cols.filter(x => !x.known)];
      if (v4.length) {
        const v4Fee = Math.max(0, inMkt - wdMkt - v3Fee);
        const v4Wd = wds.filter(w => w.P.k === 'v4').reduce((s, w) => s + w.mkt, 0);
        const seen = new Set();
        const targets = v4.filter(x => { const k = `${x.P.k}-${x.P.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
        for (const t of targets) {
          const wdOf = wds.filter(w => w.P === t.P).reduce((s, w) => s + w.mkt, 0);
          const share = v4Wd > 0 ? wdOf / v4Wd : 1 / targets.length;
          t.c.fees += v4Fee * share;
          if (v4Fee > 0 && inMkt > 0 && ins.some(i => i.ax)) t.c.approx = true;
        }
      }
      for (const o of outs) await consume(o.tok, o.q, tx.b);
      for (const i of ins) addLot(i.tok, i.q, i.mkt, i.ax);
    } else if (outs.length && ins.length) {
      // 换币: 入账 token 的成本 = 出账的成本 (按入账市值份额分摊)
      let outCost = 0, ax = false;
      for (const o of outs) { const r = await consume(o.tok, o.q, tx.b); outCost += r.cost; if (r.approx) ax = true; }
      for (const i of ins) { const share = inMkt > 0 ? i.mkt / inMkt : 1 / ins.length; addLot(i.tok, i.q, outCost * share, ax); }
    } else if (ins.length) {
      for (const i of ins) addLot(i.tok, i.q, i.mkt, i.ax || !cfg.stables[i.tok]);   // 外部转入/桥入: 只能按当时市值
    } else {
      for (const o of outs) await consume(o.tok, o.q, tx.b);
    }
  }

  // 收官: 状态 / 时间
  for (const P of Object.values(W.pos)) {
    const key = `${P.k}-${P.id}`;
    const c = C[key];
    if (!c || !P.spec) { P.c = null; continue; }
    const meta = st.d.pools[P.spec];
    let status = 'active', closeTs = 0, note = '';
    if (P.burnB) { status = 'closed'; closeTs = P.burnTs || c.lastTs; }
    else if (P.outB) { status = 'closed'; closeTs = P.outTs || c.lastTs; note = 'transferred'; }
    else if (!liveKeys.has(key) && !P.live && c.liq <= 0n) { status = 'closed'; closeTs = c.lastTs; note = 'empty'; }
    else if (!liveKeys.has(key) && c.liq > 0n) { status = 'active'; note = 'notlive'; }
    for (const k of Object.keys(c.a)) if (Math.abs(c.a[k]) < 1e-12) c.a[k] = 0;
    P.c = {
      cost: c.cost, dep: c.dep, ret: c.ret, fees: c.fees, a: c.a, n: c.n,
      openTs: c.openTs || P.mts || 0, closeTs, status, note, approx: c.approx, inc: c.inc,
      pair: meta ? `${meta.t0.symbol}/${meta.t1.symbol}` : '', fee: meta ? meta.fee : 0, t0: meta ? meta.t0 : null, t1: meta ? meta.t1 : null,
    };
  }
  W.lots = Object.fromEntries(Object.entries(lots).filter(([, L]) => L.q > 1e-9).map(([t, L]) => [t, { q: L.q, c: L.c, ax: L.ax }]));
  W.computedAt = Date.now();
}

// =============================================================
// 5. 后台队列 (每链串行): 扫流水 → 仓位发现/事件 → 重放; 每钱包落盘
// =============================================================
async function runQueue(chainId, livePositionsByWallet, opts = {}) {
  if (!enabled(chainId)) return;
  const st = ledgerState(chainId);
  if (st.busy) return;
  st.busy = true;
  const deadline = Date.now() + (opts.budgetMs || (st.lastRun ? ROUND_BUDGET_MS : FIRST_BUDGET_MS));
  try {
    const wallets = E.loadActiveWallets(chainId);
    const t0 = Date.now();
    const ready = new Set();   // 本轮流水+仓位事件都扫到链头的钱包 (半截数据不重放, 避免把没扫完的减仓/领费算成亏损)
    for (const w of wallets) {
      if (Date.now() > deadline) { console.log(`[${chainId}] pnl-ledger 本轮预算用完, 其余钱包下轮续`); break; }
      const addr = low(w.address);
      const live = (livePositionsByWallet && livePositionsByWallet[addr]) || [];
      try {
        const W = await scanWallet(chainId, addr, deadline);
        if (W.partial) { save(chainId); continue; }
        if (W.stopped) { save(chainId); continue; }
        await ensurePositions(chainId, addr, W, live, deadline);
        const metaOk = Object.values(W.pos).every(P => P.spec || !P.mb);
        const rcOk = await fetchReceipts(chainId, W, deadline);
        const v3Ok = await scanV3Events(chainId, W, deadline);
        if (metaOk && rcOk && v3Ok) ready.add(addr);
        else console.log(`[${chainId}] pnl-ledger ${w.name}: 本轮未就绪 (元数据 ${metaOk} / 回执 ${rcOk} / V3 ${v3Ok}), 下轮续`);
        save(chainId);
      } catch (e) { console.error(`[${chainId}] pnl-ledger ${w.name}:`, e.message?.slice(0, 100)); }
    }
    let v4Ok = false;
    try { v4Ok = await scanV4Events(chainId, deadline); save(chainId); }
    catch (e) { console.error(`[${chainId}] pnl-ledger V4 事件:`, e.message?.slice(0, 100)); }
    for (const w of wallets) {
      const addr = low(w.address);
      const W = st.d.wallets[addr];
      if (!W || W.partial) continue;
      if (!ready.has(addr)) continue;
      if (!v4Ok && Object.values(W.pos).some(P => P.k === 'v4' && st.d.pools[P.spec] && st.d.pools[P.spec].native)) { console.log(`[${chainId}] pnl-ledger ${w.name}: 原生币池 V4 事件未扫完, 本轮不重放`); continue; }
      try {
        await computeWallet(chainId, addr, (livePositionsByWallet && livePositionsByWallet[addr]) || []);
        const n = Object.values(W.pos).filter(P => P.c).length, cl = Object.values(W.pos).filter(P => P.c && P.c.status === 'closed').length;
        console.log(`[${chainId}] pnl-ledger ${w.name}: ${Object.keys(W.txs).length} tx, ${n} 仓 (已关闭 ${cl})${W.stopped ? ' · 流水未扫完下轮续' : ''}`);
      } catch (e) { console.error(`[${chainId}] pnl-ledger 重放 ${w.name}:`, e.message?.slice(0, 100)); }
    }
    save(chainId);
    st.lastRun = Date.now();
    console.log(`[${chainId}] pnl-ledger 一轮完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } finally { st.busy = false; }
}

// =============================================================
// 6. 只读查询 (零 RPC)
// =============================================================
function positionPnl(chainId, addr, kind, tokenId) {
  if (!enabled(chainId)) return null;
  const W = ledgerState(chainId).d.wallets[low(addr)];
  if (!W || W.partial) return null;
  const P = W.pos[`${kind}-${tokenId}`];
  return P && P.c && P.c.cost > 0 ? P.c : null;
}
function walletStatus(chainId, addr) {
  if (!enabled(chainId)) return { ledger: false };
  const st = ledgerState(chainId);
  const W = st.d.wallets[low(addr)];
  if (!W) return { ledger: true, pending: true, busy: st.busy };
  return { ledger: true, partial: !!W.partial, scanning: st.busy, catchingUp: !!W.stopped, updatedAt: W.computedAt || 0, txCount: Object.keys(W.txs).length };
}
// 钱包报告: 账本里的全部仓位 (活跃 + 已关闭), 活跃仓合并实时数据 (现值/待领费/盈亏字段由拉取主流程注入)
function walletReport(chainId, addr, liveWallet) {
  const status = walletStatus(chainId, addr);
  const out = { ...status, positions: [], lots: [] };
  const liveMap = new Map();
  for (const p of (liveWallet?.positions || [])) liveMap.set(`${p.protocol === 'V4' ? 'v4' : 'v3'}-${p.tokenId}`, p);
  const seen = new Set();
  if (status.ledger && !status.partial && !status.pending) {
    const W = ledgerState(chainId).d.wallets[low(addr)];
    for (const [key, P] of Object.entries(W.pos)) {
      if (!P.c) continue;
      const live = liveMap.get(key);
      seen.add(key);
      out.positions.push(rowFromLedger(key, P, live));
    }
    out.lots = Object.entries(W.lots || {}).map(([tok, L]) => ({ token: tok, qty: L.q, costUSD: L.c, avgCost: L.q > 0 ? L.c / L.q : 0, approx: L.ax }));
  }
  for (const [key, p] of liveMap) if (!seen.has(key)) out.positions.push(rowFromLive(key, p));
  return out;
}
function rowFromLedger(key, P, live) {
  const c = P.c;
  const active = c.status === 'active' && !!live;
  const valueUSD = live ? (live.positionValueUSD || 0) : 0;
  const pending = live ? (live.feesValueUSD || 0) : 0;
  const closeTs = active ? 0 : (c.closeTs || 0);
  const net = valueUSD + pending + c.fees + c.ret - c.cost;
  return {
    key, protocol: P.k === 'v4' ? 'V4' : 'V3', tokenId: P.id, pair: live ? `${live.token0.symbol}/${live.token1.symbol}` : c.pair, feeLabel: live ? live.feeLabel : null, fee: c.fee,
    status: active ? 'active' : 'closed', note: active ? '' : c.note, inRange: live ? !!live.inRange : null,
    openTs: c.openTs, closeTs, source: 'ledger',
    costUSD: c.cost, costApprox: c.approx, incomplete: c.inc, depositValueUSD: c.dep, adds: c.n,
    valueUSD, pendingFeesUSD: pending, collectedFeesUSD: c.fees, withdrawnUSD: c.ret,
    hodlValueUSD: live ? (live.hodlValueUSD ?? null) : null, ilUSD: live ? (live.ilUSD ?? null) : null,
    netProfitUSD: c.cost > 0 ? net : null, netProfitPct: c.cost > 0 ? net / c.cost * 100 : null,
  };
}
function rowFromLive(key, p) {
  const cost = p.costBasisUSD || 0;
  return {
    key, protocol: p.protocol, tokenId: p.tokenId, pair: `${p.token0.symbol}/${p.token1.symbol}`, feeLabel: p.feeLabel, fee: p.fee,
    status: 'active', note: '', inRange: !!p.inRange, openTs: p.entryTs || p.createdAt || 0, closeTs: 0, source: p.costSource || 'none',
    costUSD: cost, costApprox: !!p.costApprox, incomplete: false, depositValueUSD: p.entryValueUSD || 0, adds: p.entryAdds || 0,
    valueUSD: p.positionValueUSD || 0, pendingFeesUSD: p.feesValueUSD || 0, collectedFeesUSD: p.collectedFeesUSD || 0, withdrawnUSD: p.withdrawnUSD || 0,
    hodlValueUSD: p.hodlValueUSD ?? null, ilUSD: p.ilUSD ?? null,
    netProfitUSD: cost > 0 ? (p.netProfitUSD ?? null) : null, netProfitPct: cost > 0 ? (p.netProfitPct ?? null) : null,
    feesUnknown: !!p.feesUnknown,
  };
}

// =============================================================
// 7. 给活跃仓注入盈亏字段 (拉取主流程调用, 纯计算): 成本 / 持币对照 (无常损失) / 已领费 / 已提回 / 净利润
//   src: { cost, approx, source, am: {token: 净存入数量}, withdrawnUSD, collectedUSD (undefined=按 pos.collectedFees 折算), feesUnknown }
//   priceOf(tokenLower) -> 当前美元价
// =============================================================
function applyPnl(pos, src, priceOf) {
  if (!src || !(src.cost > 0)) return;
  pos.costBasisUSD = src.cost;
  pos.costApprox = !!src.approx;
  pos.costSource = src.source;
  let hodl = 0, any = false;
  for (const [tok, q] of Object.entries(src.am || {})) { const p = priceOf(low(tok)) || 0; if (q && p) { hodl += q * p; any = true; } }
  if (any) {
    pos.hodlValueUSD = hodl;
    pos.ilUSD = (pos.positionValueUSD || 0) - hodl;
    pos.ilPct = hodl > 0 ? pos.ilUSD / hodl * 100 : 0;
  }
  let collected = src.collectedUSD;
  if (collected == null) {
    const cf = pos.collectedFees || {};
    collected = (cf.token0 || 0) * (priceOf(low(pos.token0.address)) || 0) + (cf.token1 || 0) * (priceOf(low(pos.token1.address)) || 0);
  }
  pos.collectedFeesUSD = collected;
  pos.withdrawnUSD = src.withdrawnUSD || 0;
  pos.feesUnknown = !!src.feesUnknown;
  pos.netProfitUSD = (pos.positionValueUSD || 0) + (pos.feesValueUSD || 0) + collected + pos.withdrawnUSD - src.cost;
  pos.netProfitPct = pos.netProfitUSD / src.cost * 100;
}

module.exports = { init, enabled, runQueue, positionPnl, walletStatus, walletReport, applyPnl, ledgerState, ROUND_MS, _test: { computeWallet, scanWallet, ensurePositions, scanV3Events, scanV4Events } };
