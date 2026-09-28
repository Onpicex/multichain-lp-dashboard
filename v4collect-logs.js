// v4collect-logs.js — Uniswap V4 (BSC) 仓位「上次领费时间」的链上事件扫描 (2026-09-13)
//
// 背景: server.js 的 getV4LastCollectTimes 只会走 Ankr 专有的 ankr_getLogs; 没配 Ankr 时它把请求打到 BSC_RPC 上
// 必然失败 → V4 仓 lastCollectAt 永远 0 → 领过费之后「当前日化」计时起点仍是建仓时间, 被系统性算低。
// 这里用标准 eth_getLogs 实现同一件事: PoolManager 的 ModifyLiquidity(poolId indexed, sender indexed, tickLower,
// tickUpper, liquidityDelta, salt) 事件, 过滤 poolId + sender=PositionManager, liquidityDelta==0 即"纯领费",
// **data 里的 salt 就是 tokenId** (2026-09-13 用三笔真实领费的 receipt 核过), 按 salt 精确归属, 不再靠 tick 区间猜。
//
// 扫描策略 (2026-09-13 实测 NodeReal 单次 getLogs 上限 5 万块、单池一段 ~30 条日志 60ms, 但连打会被限流到超时):
//   - **游标按池**: 同一池里钱包的全部仓位共享一次扫描; 每池记 { scannedTo(上沿), floor(下沿), done }, 落盘断点续跑
//   - 阶段 A 每池: "补顶" [scannedTo+1 .. head] (追平后每池 1 段) + 新池扫最近一段 → 最近的领费一轮就出
//   - 阶段 B 轮转: 仍有仓没记录的池, 在预算内各扫一段向下补深, 直到 lookback 下限; 一个池不能饿死别的池
//   - 领费记录按 tokenId 只存**块高**, 时间戳只给被查询的仓懒解析 (busy 池一段就有几十笔别人的领费, 不能每条都 getBlock)
//   - 每次调用自带超时 (ethers v6 默认不设); 连续 2 次失败当作被限流, 本轮提前收工
'use strict';

const MODIFY_LIQUIDITY_TOPIC = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
// 2026-09-28 审计修复: store.tokens 清理参数 —— 查询过的仓 (store.watch) 30 天没再被问到即遗忘; 非自有 tokenId 只留块高最新的 1000 条
const WATCH_TTL_MS = 30 * 24 * 3600 * 1000;
const OTHERS_KEEP = 1000;

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {import('ethers')} o.ethers
 * @param {import('ethers').JsonRpcProvider} o.logProvider   日志 RPC (需支持 blockStep 大小的 getLogs; NodeReal ≤5 万块)
 * @param {string} o.poolManager       V4 PoolManager 地址
 * @param {string} o.positionManager   V4 PositionManager 地址 (事件 sender)
 * @param {Array<{tokenId:string|number|bigint, poolId:string}>} o.positions  要问的仓
 * @param {number} o.lookbackBlocks    最多回看多少块
 * @param {number} [o.blockStep=49999]
 * @param {{pools?:object, tokens?:object, blockTs?:object, watch?:object}} [o.store]  持久化状态 (原地更新): pools[poolId]={scannedTo,floor,done,floorAt}, tokens[tid]=最新领费块高, blockTs[块高]=毫秒, watch[tid]=该仓最近被查询的时间 (2026-09-28)
 * @param {function} [o.save]          每次进度推进后回调 (落盘)
 * @param {number} [o.budgetCalls=60]  每轮 getLogs 上限 (2026-09-28 审计修复: 注释原写 80, 与代码默认 60 不一致)
 * @param {number} [o.budgetMs=40000]  每轮时间上限
 * @param {number} [o.callTimeoutMs=12000]
 * @param {number} [o.paceMs=350]      两次调用之间的间隔 (公共 key 连打会被限流; 2026-09-28 审计修复: 注释原写 120, 代码默认 350)
 * @param {number} [o.now]             本轮时间戳 (毫秒), 缺省 Date.now()
 * @param {function} [o.log]
 * @returns {Promise<{results: Record<string, number>, calls: number, errors: number, budgetHit: boolean, throttled: boolean, unresolved: number}>}  results 值为毫秒时间戳
 */
async function scanV4CollectsViaLogs(o) {
  const { ethers, logProvider, poolManager, positionManager, positions, lookbackBlocks } = o;
  const blockStep = o.blockStep || 49999;
  const store = o.store || {};
  store.pools = store.pools || {}; store.tokens = store.tokens || {}; store.blockTs = store.blockTs || {};
  const save = o.save || (() => {});
  // 默认节奏: 公共 key 实测 ~4 次/秒连打 40 次左右就会卡住一个请求 → 350ms 一次、每轮 ≤60 次
  const budgetCalls = o.budgetCalls || 60, budgetMs = o.budgetMs || 40000, callTimeoutMs = o.callTimeoutMs || 12000, paceMs = o.paceMs ?? 350;
  const log = o.log || (() => {});
  const t0 = Date.now();
  const results = {};
  let calls = 0, errors = 0, consecutiveErrors = 0, budgetHit = false, throttled = false;
  if (!positions || positions.length === 0) return { results, calls, errors, budgetHit, throttled, unresolved: 0 };
  const stop = () => {
    if (throttled) return true;
    if (calls >= budgetCalls || Date.now() - t0 > budgetMs) { budgetHit = true; return true; }
    return false;
  };

  let head;
  try { head = Number(await withTimeout(logProvider.getBlockNumber(), callTimeoutMs)); }
  catch (e) { log(`  V4 collect scan: head block failed (${e.message?.slice(0, 60)}), skip this round`); return { results, calls, errors: 1, budgetHit, throttled: true, unresolved: positions.length }; }
  const globalFloor = Math.max(1, head - lookbackBlocks);
  const PM_PADDED = ethers.zeroPadValue(positionManager, 32).toLowerCase();
  const coder = ethers.AbiCoder.defaultAbiCoder();

  // 一段日志 → 记录每个 tokenId 的最新领费块高; 成功返回 true, 失败返回 false (调用方决定进度)
  async function fetchChunk(poolId, start, end) {
    calls++;
    try {
      const logs = await withTimeout(logProvider.getLogs({ address: poolManager, topics: [MODIFY_LIQUIDITY_TOPIC, poolId, PM_PADDED], fromBlock: start, toBlock: end }), callTimeoutMs);
      for (const l of logs) {
        let liquidityDelta, salt;
        try { [, , liquidityDelta, salt] = coder.decode(['int24', 'int24', 'int256', 'bytes32'], l.data); } catch { continue; }
        if (liquidityDelta !== 0n) continue; // 只要纯领费
        const tid = BigInt(salt).toString();
        if (tid === '0') continue;
        const bn = Number(l.blockNumber);
        if (!store.tokens[tid] || bn > store.tokens[tid]) store.tokens[tid] = bn;
      }
      consecutiveErrors = 0;
      await sleep(paceMs);
      return true;
    } catch (e) {
      errors++; consecutiveErrors++;
      log(`  V4 collect scan ${start}-${end} failed: ${e.message?.replace(/\s+/g, ' ').slice(0, 80)}`);
      if (consecutiveErrors >= 2) throttled = true; // 连续失败 = 限流/断连, 本轮收工, 进度已落盘
      else await sleep(800);
      return false;
    }
  }

  const byPool = new Map();
  for (const p of positions) {
    const pid = String(p.poolId).toLowerCase();
    (byPool.get(pid) || byPool.set(pid, []).get(pid)).push(String(p.tokenId));
  }
  const needDeep = (poolId, tids) => { const cur = store.pools[poolId]; return cur && !cur.done && tids.some(t => !store.tokens[t]); };

  // 阶段 A: 每池补顶 + 新池扫最近一段
  for (const [poolId, tids] of byPool) {
    if (stop()) break;
    const cur = store.pools[poolId] || (store.pools[poolId] = {});
    // 2026-09-28 审计修复: done 是按当轮 globalFloor 定死的; lookback 加大后本轮 globalFloor 比已扫下沿 floor 更低 → 撤销 done 让阶段 B 继续补深
    if (cur.done && Number.isFinite(cur.floor) && globalFloor <= cur.floor - 1) { cur.done = false; }
    if (cur.scannedTo && cur.scannedTo < head) {
      let from = cur.scannedTo + 1;
      while (from <= head && !stop()) {
        const to = Math.min(head, from + blockStep - 1);
        if (!(await fetchChunk(poolId, from, to))) break;
        cur.scannedTo = to; from = to + 1; save();
      }
    }
    if (!cur.scannedTo) {
      cur.scannedTo = head; cur.floor = head + 1; cur.done = false;
      if (stop()) break;
      const end = head, start = Math.max(globalFloor, end - blockStep + 1);
      if (await fetchChunk(poolId, start, end)) { cur.floor = start; if (start <= globalFloor) { cur.done = true; cur.floorAt = globalFloor; } }   // 2026-09-28 审计修复: 记录定 done 时的 globalFloor
      save();
    }
  }

  // 阶段 B: 轮转补深 (只针对仍有仓没记录、且没扫到底的池)
  let progressed = true;
  while (progressed && !stop()) {
    progressed = false;
    for (const [poolId, tids] of byPool) {
      if (stop()) break;
      const cur = store.pools[poolId];
      if (!needDeep(poolId, tids)) continue;
      if (cur.floor - 1 < globalFloor) { cur.done = true; cur.floorAt = globalFloor; save(); continue; }   // 2026-09-28 审计修复: floorAt
      const end = cur.floor - 1, start = Math.max(globalFloor, end - blockStep + 1);
      if (!(await fetchChunk(poolId, start, end))) continue;
      cur.floor = start;
      if (start <= globalFloor) { cur.done = true; cur.floorAt = globalFloor; }   // 2026-09-28 审计修复: floorAt
      save();
      progressed = true;
    }
  }

  // 阶段 C: 只给被查询的仓解析时间戳
  let unresolved = 0;
  for (const p of positions) {
    const tid = String(p.tokenId);
    const bn = store.tokens[tid];
    if (!bn) { unresolved++; continue; }
    let ts = store.blockTs[bn];
    if (!ts && !throttled) {
      try { const b = await withTimeout(logProvider.getBlock(bn), callTimeoutMs); ts = b ? b.timestamp * 1000 : 0; } catch { ts = 0; }
      if (ts) { store.blockTs[bn] = ts; save(); }
    }
    if (ts) results[tid] = ts; else unresolved++;
  }
  if (Object.keys(store.blockTs).length > 5000) { // 防无限膨胀: 只留最近 2000 个块的时间戳
    const keys = Object.keys(store.blockTs).map(Number).sort((a, b) => b - a).slice(2000);
    for (const k of keys) delete store.blockTs[k];
    save();
  }
  // 2026-09-28 审计修复: store.tokens 只长不清 (busy 池一段就有几十笔别人的领费) → 只永久保留「被查询过的仓」(store.watch, 30 天没再被问到即遗忘);
  //   其它 tokenId 只留块高最新的 OTHERS_KEEP 条 (新仓在首次被问到之前的领费还能命中 —— 调用方传的是缓存过期的子集, 池游标又是共享的, 不能只留本轮这几个)
  const nowTs = Number(o.now) || Date.now();
  store.watch = store.watch || {};
  for (const p of positions) store.watch[String(p.tokenId)] = nowTs;
  for (const [tid, ts] of Object.entries(store.watch)) if (nowTs - ts > WATCH_TTL_MS) delete store.watch[tid];
  const others = Object.keys(store.tokens).filter(t => !store.watch[t]);
  if (others.length > OTHERS_KEEP) {
    others.sort((a, b) => store.tokens[b] - store.tokens[a]);
    for (const t of others.slice(OTHERS_KEEP)) delete store.tokens[t];
    save();
  }
  return { results, calls, errors, budgetHit, throttled, unresolved };
}

module.exports = { scanV4CollectsViaLogs, MODIFY_LIQUIDITY_TOPIC };
