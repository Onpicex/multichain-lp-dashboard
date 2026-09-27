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
// 【Ankr 数据源 (base / eth, cfg.ledgerFromAnkr=<ankr 链名>, 需 .env ANKR_KEY)】这几条链公共 RPC 不让按钱包扫全链日志
//   (base.org >2000 块 413, publicnode 封 getLogs) → 改用 Ankr Advanced API (Freemium 免费档, 2 亿 credits/月, 30 rps):
//   ankr_getTokenTransfers = 钱包全部 ERC20 转账 (含第三方打进来的); ankr_getTransactionsByAddress(includeLogs) = 钱包自己发的
//   全部交易 + 完整日志 → NFT mint/burn、V3 Inc/Dec/Col、池 Mint、V4 ModifyLiquidity 全从日志里取, 不用再按池/按 id 扫链;
//   还多一个好处: tx.value 能看到原生 ETH 流出 (rh 上是盲区)。历史池价走 Ankr 归档节点 eth_call slot0 (全档含 archive)。
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
// 非 evm-adapter 管的链 (bsc 在 server.js) 由 registerChain 注入: { cfg, chainState(), getTokenInfo(addr), wallets() }
//   cfg 结构与 EVM_CHAINS 同: v3.npm (+ v3.pcsNpm = Pancake V3 NPM, 仓位 kind='pcs'), v4.{pm,stateView,poolManager}, stables, wrappedNative, nativePriceId, ledgerFromAnkr
const extra = {};
function registerChain(chainId, def) { extra[chainId] = def; }
function cfgOf(chainId) { return (E && E.EVM_CHAINS[chainId]) || (extra[chainId] && extra[chainId].cfg) || null; }
function stateOf(chainId) { return extra[chainId] ? extra[chainId].chainState() : E.chainState(chainId); }
function tokenInfoOf(chainId, addr) { return extra[chainId] ? extra[chainId].getTokenInfo(addr) : E.getTokenInfo(chainId, addr); }
function walletsOf(chainId) { if (extra[chainId]) return extra[chainId].wallets(); return E.ledgerWallets ? E.ledgerWallets(chainId) : E.loadActiveWallets(chainId); }
function enabled(chainId) { const c = cfgOf(chainId); return !!(c && !c.pending && (c.ledgerFromLogs || (c.ledgerFromAnkr && ankrKey()))); }
function isAnkr(chainId) { const c = cfgOf(chainId); return !!(c && c.ledgerFromAnkr && ankrKey()); }
function npmOf(cfg, kind) { return kind === 'v4' ? cfg.v4.pm : (kind === 'pcs' ? cfg.v3.pcsNpm : cfg.v3.npm); }
function ankrKey() { return (process.env.ANKR_KEY || '').trim(); }
const ankrProviders = {};
// 链上读 (归档 eth_call / getBlock / receipt): Ankr 链用 Ankr 节点 (含 archive, publicnode 会剪枝老块), 其余用主 provider
function providerFor(chainId) {
  const cfg = cfgOf(chainId);
  if (!isAnkr(chainId)) return stateOf(chainId).provider;
  if (!ankrProviders[chainId]) ankrProviders[chainId] = new ethers.JsonRpcProvider(`https://rpc.ankr.com/${cfg.ledgerFromAnkr}/${ankrKey()}`, undefined, { staticNetwork: true });
  return ankrProviders[chainId];
}
// Ankr 调用: 进程内全局串行 (base/eth/bsc 三条链同时跑也只有一条队列, ≥300ms 一次 ≈ 3 rps);
// 实测 Freemium 对 Advanced API 的限流比标称 30 rps 紧得多 (2026-09-28 两链并发 ~8 rps 就 429 "retry in 10s"),
// 429 按它说的等 11s 再试, 最多 6 次; 仍不行返回 null → 调用方按「本轮没扫完」处理下轮续
let ankrQueue = Promise.resolve();
let ankrLast = 0;
function ankrCall(method, params) {
  const run = ankrQueue.then(async () => {
    for (let i = 0; i < 6; i++) {
      const wait = 300 - (Date.now() - ankrLast); if (wait > 0) await E.sleep(wait);
      ankrLast = Date.now();
      let r;
      try {
        r = await fetch(`https://rpc.ankr.com/multichain/${ankrKey()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
      } catch (e) { if (i === 5) throw e; await E.sleep(2000 * (i + 1)); continue; }
      if (r.status === 429) { await E.sleep(11000); continue; }
      if (r.status >= 500) { await E.sleep(2000 * (i + 1)); continue; }
      let j; try { j = await r.json(); } catch { await E.sleep(2000); continue; }
      if (j.error) {
        const msg = String(j.error.message || '');
        if (/rate limit|too many/i.test(msg)) { await E.sleep(11000); continue; }
        if (/busy|timeout|temporar/i.test(msg) && i < 5) { await E.sleep(2000 * (i + 1)); continue; }
        throw new Error(msg.slice(0, 160));
      }
      return j.result;
    }
    return null;
  });
  ankrQueue = run.catch(() => {});
  return run;
}

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
  const st = stateOf(chainId);
  const cfg = cfgOf(chainId);
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
  const b = await E.withRetry(() => providerFor(chainId).getBlock(block), 2, 500).catch(() => null);
  if (!b) return 0;
  st.d.bts[block] = b.timestamp * 1000;
  return st.d.bts[block];
}

// =============================================================
// 1. 钱包 Transfer 流水 (增量游标): 按 tx 归并 { b, e: {logIndex: [token, ±rawAmt]}, n: {logIndex: [kind, id, dir]} }
// =============================================================
async function scanWallet(chainId, addr, deadline) {
  const st = ledgerState(chainId);
  const cfg = cfgOf(chainId);
  const W = st.d.wallets[addr] || (st.d.wallets[addr] = { scannedTo: -1, partial: false, txs: {}, pos: {}, updatedAt: 0 });
  if (W.partial) return W;
  const latest = await stateOf(chainId).provider.getBlockNumber();
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

// Ankr 版钱包扫描: A) ankr_getTokenTransfers → ERC20 流水 (含第三方打入); B) ankr_getTransactionsByAddress(includeLogs) →
//   钱包自己发的交易: 原生 ETH 流出 (伪 token = wrappedNative)、NFT mint/burn/转出、V3 Inc/Dec/Col、池 Mint、V4 ModifyLiquidity
//   两段都翻完才推进游标 (逐条按 tx+logIndex 幂等, 半途重来不会重复)
const V3_TOPICS = new Set([V3_INC, V3_DEC, V3_COL]);
function hexNum(x) { return typeof x === 'string' && x.startsWith('0x') ? parseInt(x, 16) : Number(x); }
async function scanWalletAnkr(chainId, addr, deadline) {
  const st = ledgerState(chainId);
  const cfg = cfgOf(chainId);
  const bc = cfg.ledgerFromAnkr;
  const W = st.d.wallets[addr] || (st.d.wallets[addr] = { scannedTo: -1, partial: false, txs: {}, pos: {}, updatedAt: 0 });
  if (W.partial) return W;
  const latest = await providerFor(chainId).getBlockNumber();
  const from = Math.max(cfg.ledgerFloorBlock || 0, W.scannedTo + 1);
  const to = latest - 5;   // 留几块给索引追平
  if (from > to) return W;
  const npm = low(cfg.v3.npm), pcs = low(cfg.v3.pcsNpm || ''), pm = low(cfg.v4.pm), poolMgr = low(cfg.v4.poolManager), wn = low(cfg.wrappedNative), pmTopic = padAddr(cfg.v4.pm);
  const kindOfNpm = a => a === npm ? 'v3' : (pcs && a === pcs) ? 'pcs' : null;
  st.d.tok = st.d.tok || {};
  let raw = Object.values(W.txs).reduce((s, t) => s + Object.keys(t.e || {}).length, 0);
  // A. 代币转账
  let token = null, pages = 0;
  do {
    if (Date.now() > deadline) { W.stopped = 'budget'; return W; }
    const r = await ankrCall('ankr_getTokenTransfers', { address: addr, blockchain: [bc], fromBlock: from, toBlock: to, pageSize: 1000, pageToken: token || undefined, descOrder: false });
    if (!r) { W.stopped = 'rpc'; return W; }
    for (const x of (r.transfers || [])) {
      const c = low(x.contractAddress || '');
      if (!c || !/^0x[0-9a-f]{40}$/.test(c)) continue;                           // 原生币条目 (无合约地址) 由 B 段的 tx.value 负责
      const fromA = low(x.fromAddress), toA = low(x.toAddress);
      if (fromA === toA) continue;
      const amt = BigInt(x.valueRawInteger || '0'); if (amt === 0n) continue;
      const b = Number(x.blockHeight); if (!(b >= from && b <= to)) continue;
      const h = String(x.transactionHash).toLowerCase();
      const tx = W.txs[h] || (W.txs[h] = { b });
      (tx.e = tx.e || {})[Number(x.logIndex)] = [c, (toA === addr ? amt : -amt).toString()];
      if (x.timestamp) st.d.bts[b] = Number(x.timestamp) * 1000;
      if (x.tokenDecimals != null && !st.d.tok[c]) st.d.tok[c] = { symbol: x.tokenSymbol || c.slice(0, 6), decimals: Number(x.tokenDecimals) };
      raw++;
    }
    token = r.nextPageToken || null; pages++;
    if (raw > RAW_LIMIT) { W.partial = true; W.txs = {}; W.pos = {}; W.updatedAt = Date.now(); console.log(`[${chainId}] pnl-ledger ${addr.slice(0, 10)}: Transfer 超上限, 高频钱包放弃`); return W; }
  } while (token && pages < 200);
  // B. 钱包发的交易 + 日志
  token = null; pages = 0;
  do {
    if (Date.now() > deadline) { W.stopped = 'budget'; return W; }
    const r = await ankrCall('ankr_getTransactionsByAddress', { address: addr, blockchain: [bc], fromBlock: from, toBlock: to, pageSize: 100, pageToken: token || undefined, descOrder: false, includeLogs: true });
    if (!r) { W.stopped = 'rpc'; return W; }
    for (const x of (r.transactions || [])) {
      const b = hexNum(x.blockNumber); if (!(b >= from && b <= to)) continue;
      if (x.status != null && hexNum(x.status) === 0) continue;                  // 失败交易
      const h = String(x.hash).toLowerCase();
      const tx = W.txs[h] || (W.txs[h] = { b });
      if (x.timestamp) st.d.bts[b] = hexNum(x.timestamp) * 1000;
      const fromA = low(x.from), toA = low(x.to || '');
      const val = x.value ? BigInt(x.value) : 0n;
      if (val > 0n && fromA !== toA) {
        if (fromA === addr) (tx.e = tx.e || {})['v'] = [wn, (-val).toString()];   // 原生 ETH 流出 → 按 WETH 记 (V4 原生池入金可见)
        else if (toA === addr) (tx.e = tx.e || {})['v'] = [wn, val.toString()];
      }
      if (fromA !== addr) { tx.r = 1; continue; }                                // 别人发的 (打款进来): 不会有本钱包的仓位操作
      const m = [], v3 = {}, pmints = {};
      for (const l of (x.logs || [])) {
        const a = low(l.address), tp = l.topics || [];
        const li = hexNum(l.logIndex);
        if (tp.length === 4 && tp[0] === TRANSFER_TOPIC && (a === npm || a === pm || (pcs && a === pcs))) {
          const f = topicAddr(tp[1]), t2 = topicAddr(tp[2]), id = BigInt(tp[3]).toString();
          let dir; if (tp[1] === ZERO32) dir = 'mint'; else if (tp[2] === ZERO32) dir = 'burn'; else dir = t2 === addr ? 'in' : (f === addr ? 'out' : null);
          if (dir === 'mint' && t2 !== addr) continue; if (dir === 'burn' && f !== addr) continue; if (!dir) continue;
          (tx.n = tx.n || {})[li] = [a === pm ? 'v4' : kindOfNpm(a), id, dir];
        } else if (kindOfNpm(a) && V3_TOPICS.has(tp[0]) && tp.length >= 2) {
          const hex = String(l.data).slice(2);
          // [类型, tokenId, amount0, amount1, liquidity, kind(v3|pcs)]
          v3[li] = [tp[0] === V3_INC ? 'inc' : tp[0] === V3_DEC ? 'dec' : 'col', BigInt(tp[1]).toString(), BigInt('0x' + hex.slice(64, 128)).toString(), BigInt('0x' + hex.slice(128, 192)).toString(), tp[0] === V3_COL ? '0' : BigInt('0x' + hex.slice(0, 64)).toString(), kindOfNpm(a)];
        } else if (tp[0] === V3_POOL_MINT && tp.length === 4) {
          pmints[li] = [a, hexI24(tp[2]), hexI24(tp[3])];
        } else if (a === poolMgr && tp[0] === V4_MODIFY && low(tp[2] || '') === pmTopic) {
          const hex = String(l.data).slice(2);
          m.push([low(tp[1]), BigInt('0x' + hex.slice(192, 256)).toString(), hexI24(hex.slice(0, 64)), hexI24(hex.slice(64, 128)), hexInt(hex.slice(128, 192)).toString(), li]);
        }
      }
      if (m.length) tx.m = m; else delete tx.m;
      if (Object.keys(v3).length) tx.v3 = v3; else delete tx.v3;
      if (Object.keys(pmints).length) tx.pm = pmints; else delete tx.pm;
      tx.r = 1;
    }
    token = r.nextPageToken || null; pages++;
  } while (token && pages < 500);
  for (const t of Object.values(W.txs)) if (t.b <= to && !t.r) t.r = 1;         // 只在 A 段出现的 tx (第三方打款) 没有仓位操作
  W.scannedTo = to; W.stopped = null; W.updatedAt = Date.now();
  return W;
}

// =============================================================
// 2. 仓位发现 + 池元数据 + 仓位事件
// =============================================================
async function poolMeta(chainId, kind, spec) {
  const st = ledgerState(chainId);
  const key = low(spec);
  if (st.d.pools[key]) return st.d.pools[key];
  const cfg = cfgOf(chainId);
  const provider = providerFor(chainId);
  let meta = null;
  if (kind === 'v3' || kind === 'pcs') {
    const c = new ethers.Contract(spec, POOL_META_ABI, provider);
    const [a0, a1, fee] = await Promise.all([c.token0(), c.token1(), c.fee()]);
    const t0 = await tokenInfoOf(chainId, a0), t1 = await tokenInfoOf(chainId, a1);
    meta = { kind, t0: { address: low(t0.address), symbol: t0.symbol, decimals: t0.decimals }, t1: { address: low(t1.address), symbol: t1.symbol, decimals: t1.decimals }, fee: Number(fee) };
  } else {
    const c = new ethers.Contract(cfg.v4.pm, PM_KEYS_ABI, provider);
    const k = await c.poolKeys(spec.slice(0, 52));
    const t0 = await tokenInfoOf(chainId, k.currency0), t1 = await tokenInfoOf(chainId, k.currency1);
    meta = { kind, t0: { address: low(t0.address), symbol: t0.symbol, decimals: t0.decimals }, t1: { address: low(t1.address), symbol: t1.symbol, decimals: t1.decimals }, fee: Number(k.fee), native: low(k.currency0) === low(ethers.ZeroAddress) };
  }
  st.d.pools[key] = meta;
  return meta;
}

// mint tx 回执里找池子 + 区间: V3 看池子的 Mint 事件 (owner=NPM, ticks 在 topics), V4 看 PoolManager 的 ModifyLiquidity (salt=tokenId)
async function resolveFromMintTx(chainId, P, W) {
  const cfg = cfgOf(chainId);
  // Ankr 链: mint tx 的日志已经存在流水里, 不用再拿回执
  const t = W && W.txs[String(P.mtx).toLowerCase()];
  if (t && t.r) {
    if (P.k === 'v4') {
      const hit = (t.m || []).find(x => x[1] === P.id);
      if (hit) { P.spec = hit[0]; P.tl = hit[2]; P.tu = hit[3]; return true; }
    } else if (t.v3 && t.pm) {
      const incLi = Math.min(...Object.entries(t.v3).filter(([, v]) => v[0] === 'inc' && v[1] === P.id && (v[5] || 'v3') === P.k).map(([li]) => +li));
      const cand = Object.entries(t.pm).map(([li, v]) => [+li, v]).filter(([li]) => li < incLi).sort((a, b) => b[0] - a[0])[0];
      if (cand) { P.spec = low(cand[1][0]); P.tl = cand[1][1]; P.tu = cand[1][2]; return true; }
    }
  }
  const provider = providerFor(chainId);
  const rc = await E.withRetry(() => provider.send('eth_getTransactionReceipt', [P.mtx]), 2, 600).catch(() => null);
  if (!rc || !rc.logs) return false;
  if (P.k !== 'v4') {
    // 同一 tx 里可能 mint 多个仓 (multicall): 用本 id 的 IncreaseLiquidity 之前最近的那条池子 Mint
    const idTopic = '0x' + BigInt(P.id).toString(16).padStart(64, '0');
    const incIdx = rc.logs.findIndex(l => low(l.address) === low(npmOf(cfg, P.k)) && l.topics[0] === V3_INC && l.topics[1] === idTopic);
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
  const provider = providerFor(chainId);
  const tid = '0x' + BigInt(id).toString(16).padStart(64, '0');
  const logs = await E.withRetry(() => provider.send('eth_getLogs', [{ address: contract, fromBlock: '0x' + block.toString(16), toBlock: '0x' + block.toString(16), topics: [TRANSFER_TOPIC, ZERO32, null, tid] }]), 2, 600).catch(() => []);
  return logs[0] ? logs[0].transactionHash : null;
}

// 钱包的仓位集合: NFT 流水 (mint/in/out/burn) ∪ 当前活跃仓 (positions 缓存, 防流水不全)
async function ensurePositions(chainId, addr, W, livePositions, deadline) {
  const cfg = cfgOf(chainId);
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
    const k = p.dex === 'pancake' ? 'pcs' : (p.protocol === 'V4' ? 'v4' : 'v3');
    const key = `${k}-${p.tokenId}`;
    const P = W.pos[key] || (W.pos[key] = { k, id: String(p.tokenId), evs: [], evTo: 0 });
    P.live = 1;
    if (!P.spec) { P.spec = low(p.poolAddress); P.tl = p.tickLower; P.tu = p.tickUpper; }
    if (P.outB || P.burnB) { P.outB = 0; P.burnB = 0; }   // 链上还持有 (转出后又转回等): 以活跃为准
  }
  for (const P of Object.values(W.pos)) {
    if (Date.now() > deadline) break;
    try {
      const contract = npmOf(cfg, P.k);
      if (!P.mb) {
        if (extra[chainId]) continue;   // 外注册链 (bsc): mint 块只能来自流水里的 NFT 事件, 没有就等下轮
        P.mb = E.mintBlockFromScan(chainId, contract, P.id) || 0;
        if (!P.mb) { const m = await E.findMintEvent(chainId, contract, P.id); if (m) P.mb = m.block; }
        if (!P.mb) continue;
      }
      if (!P.mtx && !P.spec) P.mtx = await findMintTx(chainId, contract, P.id, P.mb);
      if (!P.spec && P.mtx) await resolveFromMintTx(chainId, P, W);
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
  const cfg = cfgOf(chainId);
  const latest = await stateOf(chainId).provider.getBlockNumber();
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
  const cfg = cfgOf(chainId);
  const provider = stateOf(chainId).provider;
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
  const cfg = cfgOf(chainId);
  if (cfg.ledgerSkipNativeScan) return true;   // arc: 官方 RPC 太慢, 原生池不按池补扫, 只靠回执
  const latest = await stateOf(chainId).provider.getBlockNumber();
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
const MIN_SQRT = 4295128739n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
function sqrtSane(sq) { try { const v = BigInt(sq); return v > MIN_SQRT * 4n && v < MAX_SQRT / 4n; } catch { return false; } }
let pxDirty = 0;
async function pxAt(chainId, spec, block) {
  const st = ledgerState(chainId);
  const key = `${spec}:${block}`;
  const c = st.d.px[key];
  if (c && c.p0 != null) { if (sqrtSane(c.sq)) return c; delete st.d.px[key]; }   // 旧缓存里的边界值作废重取
  if (c && c.f && Date.now() - c.f < PX_RETRY_MS) return null;
  const meta = st.d.pools[spec];
  if (!meta) return null;
  let r = null;
  if (isAnkr(chainId)) {
    // 归档 eth_call: V3 pool.slot0() / V4 stateView.getSlot0(poolId) 在当块的 sqrtPriceX96 (Ankr 全档含 archive)
    try {
      const cfg = cfgOf(chainId);
      const provider = providerFor(chainId);
      const tag = '0x' + Number(block).toString(16);
      let sqrt = null;
      if (meta.kind === 'v4') {
        const iface = new ethers.Interface(['function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);
        const res = await E.withRetry(() => provider.send('eth_call', [{ to: cfg.v4.stateView, data: iface.encodeFunctionData('getSlot0', [spec]) }, tag]), 2, 700);
        sqrt = iface.decodeFunctionResult('getSlot0', res)[0];
      } else {
        // slot0() 只取第一槽 sqrtPriceX96 (Pancake 的 feeProtocol 是 uint32, 套 Uniswap ABI 整体解码会越界)
        const res = await E.withRetry(() => provider.send('eth_call', [{ to: spec, data: '0x3850c7bd' }, tag]), 2, 700);
        sqrt = res && res.length >= 66 ? BigInt(res.slice(0, 66)) : 0n;
      }
      const ts = await blockTs(chainId, block);
      if (sqrt > 0n && ts) {
        const px = await E.entryTokenPrices(cfg, meta.t0, meta.t1, E.sqrtPriceX96ToPrice(sqrt, meta.t0.decimals, meta.t1.decimals), ts);
        if (px) r = { ...px, sqrt, ts };
      }
    } catch {}
  } else {
    const specObj = meta.kind === 'v4' ? { kind: 'v4', poolId: spec } : { kind: 'v3', poolAddress: spec };
    r = await E.entryPricesAtBlock(chainId, specObj, meta.t0, meta.t1, block, new Map()).catch(() => null);
  }
  if (!r || !sqrtSane(r.sqrt) || !(r.p0 > 0) || !(r.p1 > 0)) { st.d.px[key] = { f: Date.now() }; return null; }   // 空池/边界价当没取到
  st.d.px[key] = { p0: r.p0, p1: r.p1, sq: r.sqrt.toString(), ts: r.ts };
  if (!st.d.bts[block]) st.d.bts[block] = r.ts;
  if (++pxDirty % 25 === 0) save(chainId);   // 历史价是最贵的部分 (arc 每次 2s), 重放中途重启不白算
  return st.d.px[key];
}

// 某 token 在某块的美元价: 稳定币=1; WETH/原生=coingecko 小时价; 其他=参考池 (与稳定币/WETH 配对的池) 当块价; 再不行=当前价 (approx)
function buildRefPools(chainId) {
  const st = ledgerState(chainId);
  const cfg = cfgOf(chainId);
  const wn = low(cfg.wrappedNative);
  const ref = {};   // token -> [{ spec, side, score }...] 按 score 降序 (稳定币对 > 原生币对); 取价时逐个试, 空池/死池跳过
  for (const [spec, m] of Object.entries(st.d.pools)) {
    for (const [side, tok, other] of [[0, m.t0.address, m.t1.address], [1, m.t1.address, m.t0.address]]) {
      if (cfg.stables[tok] || tok === wn) continue;
      const score = cfg.stables[other] ? 2 : other === wn ? 1 : 0;
      if (!score) continue;
      (ref[tok] = ref[tok] || []).push({ spec, side, score });
    }
  }
  for (const arr of Object.values(ref)) arr.sort((a, b) => b.score - a.score);
  return ref;
}
async function priceAt(chainId, token, block, ref) {
  const cfg = cfgOf(chainId);
  if (cfg.stables[token]) return { p: 1, approx: false };
  if (token === low(cfg.wrappedNative)) {
    const ts = await blockTs(chainId, block);
    const p = ts ? await E.coinUsdAtTime(cfg.nativePriceId || 'ethereum', ts) : 0;   // ETH / BNB 小时价
    if (p > 0) return { p, approx: false };
  }
  for (const r of (ref[token] || []).slice(0, 4)) {
    const px = await pxAt(chainId, r.spec, block);
    const p = px ? (r.side === 0 ? px.p0 : px.p1) : 0;
    if (p > 0) return { p, approx: false };
  }
  const cur = (stateOf(chainId).lastUsdPrices || {})[token] || 0;
  return { p: cur, approx: true };
}

// =============================================================
// 4. 按 tx 时间线重放: 持仓批次 (加权平均成本) + 仓位成本/提回/手续费
// =============================================================
async function computeWallet(chainId, addr, livePositions) {
  const st = ledgerState(chainId);
  const cfg = cfgOf(chainId);
  const W = st.d.wallets[addr];
  if (!W || W.partial) return;
  const ref = buildRefPools(chainId);
  const liveKeys = new Set((livePositions || []).map(p => `${p.dex === 'pancake' ? 'pcs' : (p.protocol === 'V4' ? 'v4' : 'v3')}-${p.tokenId}`));

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
  // Ankr 链: V3 事件也从钱包交易日志里取 (加/减仓/领费都是钱包自己发的 tx)
  const v3FromTx = new Map();
  if (isAnkr(chainId)) for (const [h, t] of Object.entries(W.txs)) for (const [li, v] of Object.entries(t.v3 || {})) {
    const key = `${v[5] || 'v3'}-${v[1]}`; if (!W.pos[key]) continue;
    const arr = v3FromTx.get(key) || []; arr.push({ b: t.b, li: +li, tx: h, t: v[0], a0: v[2], a1: v[3], l: v[4] }); v3FromTx.set(key, arr);
  }
  for (const P of Object.values(W.pos)) {
    if (!P.spec) continue;
    let evs;
    if (P.k !== 'v4') evs = isAnkr(chainId) ? (v3FromTx.get(`${P.k}-${P.id}`) || []).sort((x, y) => x.b - y.b || x.li - y.li) : P.evs;
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
  const dec = async tok => { if (decOf[tok] == null) { const k = (st.d.tok || {})[tok]; if (k && k.decimals != null) decOf[tok] = k.decimals; else { const i = await tokenInfoOf(chainId, tok); decOf[tok] = i?.decimals ?? 18; } } return decOf[tok]; };
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
  const cOf = P => C[`${P.k}-${P.id}`] || (C[`${P.k}-${P.id}`] = { cost: 0, dep: 0, ret: 0, fees: 0, a: {}, cb: {}, openTs: 0, lastTs: 0, n: 0, approx: false, inc: false, owed0: 0, owed1: 0, liq: 0n });

  // 仓位事件 → 数量 (人类单位) + 当块池价
  const evAmounts = async (P, ev) => {
    const meta = st.d.pools[P.spec]; if (!meta) return null;
    const px = await pxAt(chainId, P.spec, ev.b); if (!px) return null;
    if (P.k !== 'v4') {
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
      else if (v.kind === 'wd') { wds.push({ P, c, v, mkt: mkt0 + mkt1 }); c.liq += (P.k !== 'v4' ? -v.liq : v.liq); if (P.k !== 'v4') { c.owed0 += v.a0; c.owed1 += v.a1; } }
      else {
        // V3 Collect = 手续费 + 之前减仓待提的本金; V4 delta=0 的 ModifyLiquidity 只是结算手续费 (金额从实收推)
        if (P.k !== 'v4') {
          const pr0 = Math.min(v.a0, c.owed0), pr1 = Math.min(v.a1, c.owed1);
          c.owed0 -= pr0; c.owed1 -= pr1;
          const f0 = v.a0 - pr0, f1 = v.a1 - pr1;
          cols.push({ P, c, v, fee: f0 * v.px.p0 + f1 * v.px.p1, known: true });
        } else cols.push({ P, c, v, fee: 0, known: false });
      }
      if (ts > c.lastTs) c.lastTs = ts;
    }
    // B. 钱包流水 (人类单位 + 市值); 本 tx 涉及的仓位两侧 token 直接用该仓池子当块价 (比参考池更贴)
    const ownPx = {};
    for (const x of [...deps, ...wds, ...cols]) { ownPx[x.v.meta.t0.address] = x.v.px.p0; ownPx[x.v.meta.t1.address] = x.v.px.p1; }
    const priceHere = async tok => (ownPx[tok] > 0 && !cfg.stables[tok]) ? { p: ownPx[tok], approx: false } : await priceAt(chainId, tok, tx.b, ref);
    const outs = [], ins = [];
    for (const [tok, raw] of tx.flows) {
      const q = Math.abs(await hum(tok, raw));
      if (!(q > 0)) continue;
      (raw < 0n ? outs : ins).push({ tok, q });
    }
    let outMkt = 0, inMkt = 0, anyApprox = false;
    for (const o of outs) { const p = await priceHere(o.tok); o.mkt = o.q * p.p; outMkt += o.mkt; }
    for (const i of ins) { const p = await priceHere(i.tok); i.mkt = i.q * p.p; i.ax = p.approx; inMkt += i.mkt; }
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
        const costHere = Math.max(0, costTotal) * share;
        d.c.cost += costHere; d.c.dep += d.mkt; d.c.n++;
        d.c.a[d.v.meta.t0.address] = (d.c.a[d.v.meta.t0.address] || 0) + d.v.a0;
        d.c.a[d.v.meta.t1.address] = (d.c.a[d.v.meta.t1.address] || 0) + d.v.a1;
        // 按币分摊 (悬浮提示用): 本笔成本按两侧入金市值份额摊到两种币, 记存入数量(毛)与摊到的成本
        const m0 = d.v.a0 * d.v.px.p0, m1 = d.v.a1 * d.v.px.p1, mm = m0 + m1;
        for (const [addr, q, mk] of [[d.v.meta.t0.address, d.v.a0, m0], [d.v.meta.t1.address, d.v.a1, m1]]) {
          if (!(q > 0)) continue;
          const cb = d.c.cb[addr] || (d.c.cb[addr] = { q: 0, cost: 0 });
          cb.q += q; cb.cost += mm > 0 ? costHere * mk / mm : costHere / 2;
        }
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
    else if (!liveKeys.has(key) && !P.live) {
      // 不在看板活跃仓里 = 链上已无流动性. 事件累计还有剩余 liquidity 说明减仓 tx 没被捕获 (如 arc 只动原生 USDC 一侧的单边减仓), 标 unseen
      status = 'closed'; closeTs = c.lastTs; note = c.liq > 0n ? 'unseen' : 'empty';
    }
    for (const k of Object.keys(c.a)) if (Math.abs(c.a[k]) < 1e-12) c.a[k] = 0;
    P.c = {
      cost: c.cost, dep: c.dep, ret: c.ret, fees: c.fees, a: c.a, cb: c.cb, n: c.n,
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
  if (E.ledgerEnabled && !E.ledgerEnabled()) return;   // 设置页总开关关了: 不扫 (已有数据保留)
  const st = ledgerState(chainId);
  if (st.busy) return;
  st.busy = true;
  const deadline = Date.now() + (opts.budgetMs || (st.lastRun ? ROUND_BUDGET_MS : FIRST_BUDGET_MS));
  try {
    // 只扫设置页勾选的钱包 (默认沿用「钱包资金查询」的勾选); 别人的观察钱包不扫
    const wallets = walletsOf(chainId);
    const t0 = Date.now();
    const ready = new Set();   // 本轮流水+仓位事件都扫到链头的钱包 (半截数据不重放, 避免把没扫完的减仓/领费算成亏损)
    for (const w of wallets) {
      if (Date.now() > deadline) { console.log(`[${chainId}] pnl-ledger 本轮预算用完, 其余钱包下轮续`); break; }
      const addr = low(w.address);
      const live = (livePositionsByWallet && livePositionsByWallet[addr]) || [];
      try {
        const ankr = isAnkr(chainId);
        const W = ankr ? await scanWalletAnkr(chainId, addr, deadline) : await scanWallet(chainId, addr, deadline);
        if (W.partial) { save(chainId); continue; }
        if (W.stopped) { save(chainId); console.log(`[${chainId}] pnl-ledger ${w.name}: 流水未扫完 (${W.stopped}), 下轮续`); continue; }
        await ensurePositions(chainId, addr, W, live, deadline);
        const metaOk = Object.values(W.pos).every(P => P.spec || !P.mb);
        // Ankr 链: 回执与 V3/V4 事件都已随交易日志入库, 不再单独扫
        const rcOk = ankr ? true : await fetchReceipts(chainId, W, deadline);
        const v3Ok = ankr ? true : await scanV3Events(chainId, W, deadline);
        if (metaOk && rcOk && v3Ok) ready.add(addr);
        else console.log(`[${chainId}] pnl-ledger ${w.name}: 本轮未就绪 (元数据 ${metaOk} / 回执 ${rcOk} / V3 ${v3Ok}), 下轮续`);
        save(chainId);
      } catch (e) { console.error(`[${chainId}] pnl-ledger ${w.name}:`, e.message?.slice(0, 100)); }
    }
    let v4Ok = isAnkr(chainId);
    if (!v4Ok) {
      try { v4Ok = await scanV4Events(chainId, deadline); save(chainId); }
      catch (e) { console.error(`[${chainId}] pnl-ledger V4 事件:`, e.message?.slice(0, 100)); }
    }
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
        save(chainId);   // 每个钱包算完就落盘: 重放一个大钱包要几分钟, 中途重启不丢已算好的 (2026-09-27 v3 轮被重启打断, 两个钱包白算)
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
  for (const p of (liveWallet?.positions || [])) liveMap.set(`${p.dex === 'pancake' ? 'pcs' : (p.protocol === 'V4' ? 'v4' : 'v3')}-${p.tokenId}`, p);
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
  const unseen = !active && c.note === 'unseen';   // 提回没捕获到: 净利润算不出, 不给误导数字
  const net = valueUSD + pending + c.fees + c.ret - c.cost;
  return {
    key, protocol: P.k === 'v4' ? 'V4' : 'V3', dex: P.k === 'pcs' ? 'pancake' : undefined, tokenId: P.id, pair: live ? `${live.token0.symbol}/${live.token1.symbol}` : c.pair, feeLabel: live ? live.feeLabel : null, fee: c.fee,
    status: active ? 'active' : 'closed', note: active ? '' : c.note, inRange: live ? !!live.inRange : null,
    openTs: c.openTs, closeTs, source: 'ledger',
    costUSD: c.cost, costApprox: c.approx, incomplete: c.inc, depositValueUSD: c.dep, adds: c.n, costBy: c.cb || null,
    valueUSD, pendingFeesUSD: pending, collectedFeesUSD: c.fees, withdrawnUSD: c.ret,
    hodlValueUSD: live ? (live.hodlValueUSD ?? null) : null, ilUSD: live ? (live.ilUSD ?? null) : null,
    netProfitUSD: c.cost > 0 && !unseen ? net : null, netProfitPct: c.cost > 0 && !unseen ? net / c.cost * 100 : null,
    tokens: live ? [live.token0, live.token1].map(t => ({ address: t.address, symbol: t.symbol })) : [c.t0, c.t1].filter(Boolean).map(t => ({ address: t.address, symbol: t.symbol })),
  };
}
function rowFromLive(key, p) {
  const cost = p.costBasisUSD || 0;
  return {
    key, protocol: p.protocol, dex: p.dex, tokenId: p.tokenId, pair: `${p.token0.symbol}/${p.token1.symbol}`, feeLabel: p.feeLabel, fee: p.fee,
    status: 'active', note: '', inRange: !!p.inRange, openTs: p.entryTs || p.createdAt || 0, closeTs: 0, source: p.costSource || 'none',
    costUSD: cost, costApprox: !!p.costApprox, incomplete: false, depositValueUSD: p.entryValueUSD || 0, adds: p.entryAdds || 0, costBy: p.costByToken || null,
    valueUSD: p.positionValueUSD || 0, pendingFeesUSD: p.feesValueUSD || 0, collectedFeesUSD: p.collectedFeesUSD || 0, withdrawnUSD: p.withdrawnUSD || 0,
    hodlValueUSD: p.hodlValueUSD ?? null, ilUSD: p.ilUSD ?? null,
    netProfitUSD: cost > 0 ? (p.netProfitUSD ?? null) : null, netProfitPct: cost > 0 ? (p.netProfitPct ?? null) : null,
    feesUnknown: !!p.feesUnknown, tokens: [p.token0, p.token1].map(t => ({ address: t.address, symbol: t.symbol })),
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
  if (src.costBy) pos.costByToken = src.costBy;   // { token: { q: 存入数量, cost: 分摊成本 } }, 前端悬浮提示
  // Solana mint 是大小写敏感的 base58, 先按原样查价, 再退回小写 (EVM 地址)
  const px = tok => priceOf(tok) || priceOf(low(tok)) || 0;
  let hodl = 0, any = false;
  for (const [tok, q] of Object.entries(src.am || {})) { const p = px(tok); if (q && p) { hodl += q * p; any = true; } }
  if (any) {
    pos.hodlValueUSD = hodl;
    pos.ilUSD = (pos.positionValueUSD || 0) - hodl;
    pos.ilPct = hodl > 0 ? pos.ilUSD / hodl * 100 : 0;
  }
  let collected = src.collectedUSD;
  if (collected == null) {
    const cf = pos.collectedFees || {};
    collected = (cf.token0 || 0) * px(pos.token0.address) + (cf.token1 || 0) * px(pos.token1.address);
  }
  pos.collectedFeesUSD = collected;
  pos.withdrawnUSD = src.withdrawnUSD || 0;
  pos.feesUnknown = !!src.feesUnknown;
  pos.netProfitUSD = (pos.positionValueUSD || 0) + (pos.feesValueUSD || 0) + collected + pos.withdrawnUSD - src.cost;
  pos.netProfitPct = pos.netProfitUSD / src.cost * 100;
}

module.exports = { init, registerChain, enabled, isAnkr, runQueue, positionPnl, walletStatus, walletReport, applyPnl, ledgerState, ROUND_MS, _test: { computeWallet, scanWallet, ensurePositions, scanV3Events, scanV4Events } };
