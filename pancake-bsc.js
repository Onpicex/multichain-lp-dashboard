// pancake-bsc.js — BSC 链 PancakeSwap V3 LP 头寸 (2026-09-13)
//
// 与 Uniswap V3 同构: NPM 枚举 → positions() → factory.getPool → slot0 → collect.staticCall 拿未领费。
// 三处不同 (照抄 Uniswap 必错):
//   1. slot0.feeProtocol 是 uint32 (Uniswap 是 uint8), 套 Uniswap ABI 解码会越界报错 → 自带 POOL_ABI
//   2. 质押进 MasterChefV3 农场的仓位 owner=MasterChef, NPM.balanceOf(钱包) 看不见 → 从 MasterChef 再枚举一遍,
//      未领费也得走 MasterChef.collect.staticCall (同签名), 顺带 pendingCake 奖励
//   3. Pancake 没有可用子图 → 建仓时间 / 上次领费 / 已领费历史全靠 NPM 事件日志:
//      Transfer(0→x, tokenId)=mint, Collect(tokenId)=领费(含提取的本金), DecreaseLiquidity(tokenId)=提本金,
//      已领手续费 = ΣCollect − ΣDecrease (与 Uniswap 子图 collectedFeesToken 同口径)
//
// 事件扫描的约束 (2026-09-13 实测): 公共 BSC RPC 单次 getLogs 最多 ~5000 块, 历史深度各不相同 (publicnode 浅但快,
// bloXroute 深但慢), 官方 dataseed 干脆 limit exceeded; 且 BSC 现在 0.45s 一块 (一天 ≈19 万块)。
// 所以: 4999 块分块 + 断点续跑 (进度落盘) + 每轮调用预算 (不拖垮 5min 刷新节奏) + 多 RPC 逐级回退。
// 找到过的 mint 永久缓存; 领费历史按 tokenId 增量前扫, 追平后每轮只需 1 次调用。
'use strict';
const fs = require('fs');
const path = require('path');

const NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';           // PancakeSwap V3 NonfungiblePositionManager (factory() 已链上验证)
const FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';       // PancakeSwap V3 Factory
const MASTERCHEF_V3 = '0x556B9306565093C855AEA9AE92A594704c2Cd59e'; // 农场 (nonfungiblePositionManager() 已链上验证指向上面的 NPM)
const CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';          // MasterChef.CAKE()

const NPM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
];
const MASTERCHEF_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function pendingCake(uint256 tokenId) view returns (uint256)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
];
const FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'];

const MAX_UINT128 = (1n << 128n) - 1n;

function create(ctx) {
  const { ethers, provider, getTokenInfo, tickToPrice, sqrtPriceX96ToPrice, getTokenAmounts, feeLabel, batchedAll, withRetry, sleep, dir } = ctx;
  const log = (...a) => console.log('[PCS]', ...a);
  const err = (...a) => console.error('[PCS]', ...a);

  const TOPIC_TRANSFER = ethers.id('Transfer(address,address,uint256)');
  const TOPIC_COLLECT = ethers.id('Collect(uint256,address,uint256,uint256)');
  const TOPIC_DECREASE = ethers.id('DecreaseLiquidity(uint256,uint128,uint256,uint256)');
  const ZERO_PADDED = ethers.zeroPadValue('0x00', 32);
  const idHex = (id) => ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32);

  const npm = new ethers.Contract(NPM, NPM_ABI, provider);
  const masterChef = new ethers.Contract(MASTERCHEF_V3, MASTERCHEF_ABI, provider);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, provider);

  // ---------- 事件日志 RPC 池 (只用于 getLogs / getBlockNumber; 状态读取仍走主 provider) ----------
  // 2026-09-13 实测 (getLogs 带 tokenId topic 过滤):
  //   NodeReal 公共 key (Pancake 前端自带): 单次 ≥5 万块, 历史到 4000 万块前, 20~45ms  ← 承重
  //   bloXroute bsc.rpc.blxrbdn.com:       单次 ≤5000 块, 历史到 ~2000 万块前, 1.5~7s   ← 兜底
  //   publicnode:                          单次 ≤1 万块, 深历史/连打都 403             ← 末位
  //   官方 dataseed / drpc / 1rpc / meow / blockrazor: 一律拒绝或 limit exceeded
  // 格式 url@每次块数, 逗号分隔; 顺序即优先级, 失败冷却 60s 自动切下一个, 成功的粘住。
  const DEFAULT_LOG_RPCS = 'https://bsc-mainnet.nodereal.io/v1/__NODEREAL_KEY__@49999,https://bsc.rpc.blxrbdn.com@4999,https://bsc-rpc.publicnode.com@4999';
  const logRpcs = (process.env.PCS_LOG_RPCS || DEFAULT_LOG_RPCS).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*?)(?:@(\d+))?$/);
    return { url: m[1], chunk: Math.max(500, parseInt(m[2] || '4999')), provider: null, failUntil: 0, ok: 0, fail: 0 };
  });
  const BUDGET = Math.max(10, parseInt(process.env.PCS_LOG_BUDGET || '300'));          // 每轮 getLogs 调用上限
  const TIME_BUDGET = Math.max(5000, parseInt(process.env.PCS_LOG_TIME_BUDGET_MS || '60000')); // 每轮扫描时间上限 (慢 RPC 兜底时防拖垮 5min 节奏)
  const GENESIS = 26900000;                                                          // Pancake V3 NPM 部署于 2023-04 (~26.96M 块), 再往前不可能有 mint
  const MAX_DEPTH = parseInt(process.env.PCS_MINT_MAX_DEPTH || '999999999');         // mint 回扫最深块数 (默认不限, 到创世为止)
  const CALL_TIMEOUT = 15000;                                                        // ethers v6 默认不设超时, 必须自己兜
  const RPC_COOLDOWN = 60 * 1000;                                                    // 某 RPC 失败后冷却
  let stickyIdx = 0; // 上次成功的 RPC 优先
  function rpcProvider(r) {
    if (!r.provider) r.provider = new ethers.JsonRpcProvider(r.url, 56, { staticNetwork: true, batchMaxCount: 1 });
    return r.provider;
  }
  function withTimeout(p, ms = CALL_TIMEOUT) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
  }
  function rpcOrder() {
    const now = Date.now();
    const all = [];
    for (let i = 0; i < logRpcs.length; i++) all.push(logRpcs[(stickyIdx + i) % logRpcs.length]);
    const live = all.filter(r => r.failUntil <= now);
    return live.length ? live : all; // 全在冷却就都试一遍
  }
  // 按 sticky → 其余 的顺序逐个试; 全失败抛最后一个错
  async function logRpcCall(fn) {
    let lastErr = null;
    for (const r of rpcOrder()) {
      try {
        const v = await withTimeout(fn(rpcProvider(r)));
        r.ok++; r.failUntil = 0; stickyIdx = logRpcs.indexOf(r);
        return v;
      } catch (e) {
        r.fail++; r.failUntil = Date.now() + RPC_COOLDOWN; lastErr = e;
      }
    }
    throw lastErr || new Error('no log rpc');
  }
  // 扫一段: 块范围按"当前要用的 RPC"的能力定 (NodeReal 5 万块一刀, bloXroute 5000)。
  // dir='down': 以 anchor 为上界向下取一段; dir='up': 以 anchor 为下界向上取一段 (不超过 limit)。
  async function scanChunk(mkFilter, anchor, dir, limit) {
    let lastErr = null;
    for (const r of rpcOrder()) {
      let start, end;
      if (dir === 'down') { end = anchor; start = Math.max(limit, end - r.chunk + 1); }
      else { start = anchor; end = Math.min(limit, start + r.chunk - 1); }
      try {
        const logs = await withTimeout(rpcProvider(r).getLogs({ ...mkFilter(), fromBlock: start, toBlock: end }));
        r.ok++; r.failUntil = 0; stickyIdx = logRpcs.indexOf(r);
        return { logs, start, end, rpc: r };
      } catch (e) {
        r.fail++; r.failUntil = Date.now() + RPC_COOLDOWN; lastErr = e;
      }
    }
    throw lastErr || new Error('no log rpc');
  }
  async function headBlock() {
    try { return await logRpcCall(p => p.getBlockNumber()); }
    catch { return Number(await provider.getBlockNumber()); }
  }
  const blockTsCache = new Map();
  async function blockTs(n) {
    n = Number(n);
    if (blockTsCache.has(n)) return blockTsCache.get(n);
    let b = null;
    try { b = await withTimeout(provider.getBlock(n)); } catch {}
    if (!b) { try { b = await logRpcCall(p => p.getBlock(n)); } catch {} }
    const ts = b ? b.timestamp * 1000 : 0;
    if (ts) blockTsCache.set(n, ts);
    return ts;
  }

  // ---------- 历史进度存储 (落盘, 重启不丢, 断点续跑) ----------
  // tokens[tokenId] = { mintBlock, mintTs, floor, floorFails, mintMissTs,
  //                     scannedTo, c0, c1, d0, d1 (decimal string), lastCollectAt, lastCollectBlock }
  const HIST_FILE = path.join(dir, 'pcs-hist-cache-bsc.json');
  let hist = null;
  function store() {
    if (!hist) { try { hist = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { hist = { tokens: {} }; } if (!hist.tokens) hist.tokens = {}; }
    return hist;
  }
  function saveStore() {
    try { const tmp = HIST_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(hist)); fs.renameSync(tmp, HIST_FILE); } catch (e) { err('save hist failed:', e.message?.slice(0, 80)); }
  }
  const tokRec = (id) => { const t = store().tokens; return t[id] || (t[id] = {}); };

  const stats = { lastRound: null, rpcs: logRpcs };

  // ---------- 未领费 (collect.staticCall, 质押仓走 MasterChef) ----------
  async function unclaimedFees(tokenId, wallet, staked) {
    try {
      const c = staked ? masterChef : npm;
      const r = await withRetry(() => c.collect.staticCall({ tokenId, recipient: wallet, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }, { from: wallet }), 2, 800);
      return { fees0: r.amount0, fees1: r.amount1 };
    } catch (e) {
      return { fees0: 0n, fees1: 0n };
    }
  }

  // ---------- 枚举 + 状态读取: 一个钱包的全部 Pancake V3 活跃仓 ----------
  async function fetchWalletPositions(wallet) {
    const walletAddress = wallet.address;
    const walletName = wallet.name;
    let nOwn = 0, nStaked = 0;
    try { nOwn = Number(await withRetry(() => npm.balanceOf(walletAddress))); } catch (e) { err(`${walletName} NPM.balanceOf failed:`, e.message?.slice(0, 80)); }
    try { nStaked = Number(await withRetry(() => masterChef.balanceOf(walletAddress))); } catch (e) { err(`${walletName} MasterChef.balanceOf failed:`, e.message?.slice(0, 80)); }
    if (nOwn + nStaked === 0) return [];
    log(`${walletName}: ${nOwn} NFTs in wallet + ${nStaked} staked in MasterChefV3`);

    const ownIds = await batchedAll(Array.from({ length: nOwn }, (_, i) => i), (i) => withRetry(() => npm.tokenOfOwnerByIndex(walletAddress, i)));
    const stakedIds = await batchedAll(Array.from({ length: nStaked }, (_, i) => i), (i) => withRetry(() => masterChef.tokenOfOwnerByIndex(walletAddress, i)));
    const entries = [...ownIds.map(id => ({ id, staked: false })), ...stakedIds.map(id => ({ id, staked: true }))];
    const raws = await batchedAll(entries, (e) => withRetry(() => npm.positions(e.id)));

    const positions = [];
    for (let i = 0; i < entries.length; i++) {
      const { id, staked } = entries[i];
      const pos = raws[i];
      if (!pos || Number(pos.liquidity) === 0) continue; // 已清仓不展示 (与 Uniswap 路径一致)
      const token0Info = await getTokenInfo(pos.token0);
      const token1Info = await getTokenInfo(pos.token1);

      let poolAddress, sqrtPriceX96, currentTick;
      try {
        poolAddress = await withRetry(() => factory.getPool(pos.token0, pos.token1, pos.fee));
        if (!poolAddress || poolAddress === ethers.ZeroAddress) throw new Error('Pool not found');
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        const slot0 = await withRetry(() => pool.slot0());
        sqrtPriceX96 = slot0.sqrtPriceX96;
        currentTick = Number(slot0.tick);
      } catch (e) {
        err(`pool lookup failed for #${id} (${walletName}):`, e.message?.slice(0, 100));
        continue;
      }
      await sleep(100);

      const tickLower = Number(pos.tickLower);
      const tickUpper = Number(pos.tickUpper);
      const inRange = currentTick >= tickLower && currentTick < tickUpper;
      const currentPrice = sqrtPriceX96ToPrice(sqrtPriceX96, token0Info.decimals, token1Info.decimals);
      const lowerPrice = tickToPrice(tickLower, token0Info.decimals, token1Info.decimals);
      const upperPrice = tickToPrice(tickUpper, token0Info.decimals, token1Info.decimals);
      const { amount0, amount1 } = getTokenAmounts(pos.liquidity, sqrtPriceX96, tickLower, tickUpper, token0Info.decimals, token1Info.decimals);

      const { fees0, fees1 } = await unclaimedFees(id, walletAddress, staked);
      let pendingCake = 0;
      if (staked) {
        try { pendingCake = Number(await withRetry(() => masterChef.pendingCake(id), 2, 800)) / 1e18; } catch {}
      }

      positions.push({
        tokenId: id.toString(),
        token0: token0Info,
        token1: token1Info,
        token0addr: pos.token0,
        token1addr: pos.token1,
        fee: Number(pos.fee),
        feeLabel: feeLabel(pos.fee),
        tickLower, tickUpper, currentTick,
        liquidity: pos.liquidity.toString(),
        liquidityActive: true,
        inRange,
        currentPrice, lowerPrice, upperPrice,
        amount0, amount1,
        feesOwed0: Number(fees0) / Math.pow(10, token0Info.decimals),
        feesOwed1: Number(fees1) / Math.pow(10, token1Info.decimals),
        poolAddress,
        walletName, walletAddress,
        protocol: 'V3',            // 数学口径同 V3 (前端区间/费率/tag 复用)
        dex: 'pancake',            // 与 Uniswap 区分: 前端标 CAKE V3 + 链接到 pancakeswap.finance; 后端跳过 Uniswap 子图/事件路径
        dexLabel: 'PancakeSwap',
        staked,                    // 质押在 MasterChefV3 (NFT 不在钱包里)
        pendingCake,               // 质押仓待领 CAKE 奖励 (个), 未质押恒 0
        createdAt: 0,              // 由 enrichHistory 填
        lastCollectAt: 0,
        collectedFees: { token0: 0, token1: 0 },
      });
    }
    return positions;
  }

  // ---------- 事件历史 (mint 时间 / 领费历史), 增量 + 预算 + 断点 ----------
  let enrichBusy = false;
  async function enrichHistory(positions) {
    if (!positions.length || enrichBusy) return;
    enrichBusy = true;
    try { await _enrichHistory(positions); }
    finally { enrichBusy = false; }
  }
  async function _enrichHistory(positions) {
    const t0 = Date.now();
    let calls = 0, budgetHit = false;
    const overBudget = () => { if (calls >= BUDGET || Date.now() - t0 > TIME_BUDGET) { budgetHit = true; return true; } return false; };
    const st = store();
    let head;
    try { head = await headBlock(); } catch (e) { err('head block failed:', e.message?.slice(0, 80)); return; }
    const now = Date.now();
    const byId = new Map(positions.map(p => [p.tokenId, p]));

    // --- 1. mint 发现: 未知 mint 的 token 按 floor 分组倒序回扫 (Transfer from=0, topic3∈ids) ---
    const groups = new Map(); // floor -> [ids]
    for (const id of byId.keys()) {
      const r = tokRec(id);
      if (r.mintBlock) continue;
      if (r.mintMissTs && now - r.mintMissTs < 24 * 3600 * 1000) continue; // 上次判定找不到, 24h 后再试
      const floor = r.floor || (head + 1);
      (groups.get(floor) || groups.set(floor, []).get(floor)).push(id);
    }
    const deepest = Math.max(GENESIS, head - MAX_DEPTH);
    for (const [floor0, ids] of groups) {
      let floor = floor0;
      const pending = new Set(ids);
      while (pending.size && floor - 1 >= deepest) {
        if (overBudget()) break;
        calls++;
        let res;
        try {
          const idsHex = [...pending].map(idHex);
          res = await scanChunk(() => ({ address: NPM, topics: [TOPIC_TRANSFER, ZERO_PADDED, null, idsHex] }), floor - 1, 'down', deepest);
        } catch (e) {
          for (const id of pending) { const r = tokRec(id); r.floor = floor; r.floorFails = (r.floorFails || 0) + 1; if (r.floorFails >= 6) { r.mintMissTs = now; r.floorFails = 0; } }
          err(`mint scan below ${floor} failed (${pending.size} ids):`, e.message?.replace(/\s+/g, ' ').slice(0, 90));
          break;
        }
        for (const l of res.logs) {
          const id = BigInt(l.topics[3]).toString();
          if (!pending.has(id)) continue;
          const r = tokRec(id);
          r.mintBlock = Number(l.blockNumber); r.mintTs = 0; delete r.floor; delete r.floorFails; delete r.mintMissTs;
          pending.delete(id);
        }
        floor = res.start;
        for (const id of pending) { const r = tokRec(id); r.floor = floor; r.floorFails = 0; }
        await sleep(40);
      }
      if (pending.size && floor - 1 < deepest) {
        for (const id of pending) { const r = tokRec(id); r.mintMissTs = now; delete r.floor; }
        log(`mint not found down to block ${deepest} for ${pending.size} ids (retry in 24h)`);
      }
      if (budgetHit) break;
    }
    // mint 时间戳
    for (const id of byId.keys()) {
      const r = tokRec(id);
      if (r.mintBlock && !r.mintTs) r.mintTs = await blockTs(r.mintBlock);
    }
    saveStore();

    // --- 2. 领费历史: 已知 mint 的 token 从 (scannedTo+1 | mintBlock) 前扫到 head, 按起点分组 ---
    if (!budgetHit) {
      const fgroups = new Map(); // from -> [ids]
      for (const id of byId.keys()) {
        const r = tokRec(id);
        if (!r.mintBlock) continue;
        const from = r.scannedTo ? r.scannedTo + 1 : r.mintBlock;
        if (from > head) continue;
        (fgroups.get(from) || fgroups.set(from, []).get(from)).push(id);
      }
      for (const [from0, ids] of fgroups) {
        let from = from0;
        const hexes = ids.map(idHex);
        while (from <= head) {
          if (overBudget()) break;
          calls++;
          let res;
          try {
            res = await scanChunk(() => ({ address: NPM, topics: [[TOPIC_COLLECT, TOPIC_DECREASE], hexes] }), from, 'up', head);
          } catch (e) {
            err(`collect scan from ${from} failed (${ids.length} ids):`, e.message?.replace(/\s+/g, ' ').slice(0, 90));
            break; // 进度停在上一段, 下轮续
          }
          for (const l of res.logs) {
            const id = BigInt(l.topics[1]).toString();
            const r = st.tokens[id]; if (!r) continue;
            let a0, a1;
            try {
              if (l.topics[0] === TOPIC_COLLECT) {
                [, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256', 'uint256'], l.data);
                r.c0 = (BigInt(r.c0 || '0') + a0).toString(); r.c1 = (BigInt(r.c1 || '0') + a1).toString();
                if (!r.lastCollectBlock || Number(l.blockNumber) >= r.lastCollectBlock) { r.lastCollectBlock = Number(l.blockNumber); r.lastCollectAt = 0; }
              } else {
                [, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(['uint128', 'uint256', 'uint256'], l.data);
                r.d0 = (BigInt(r.d0 || '0') + a0).toString(); r.d1 = (BigInt(r.d1 || '0') + a1).toString();
              }
            } catch { /* 畸形日志跳过 */ }
          }
          for (const id of ids) st.tokens[id].scannedTo = res.end;
          from = res.end + 1;
          await sleep(40);
        }
        if (budgetHit) break;
      }
      for (const id of byId.keys()) {
        const r = tokRec(id);
        if (r.lastCollectBlock && !r.lastCollectAt) r.lastCollectAt = await blockTs(r.lastCollectBlock);
      }
      saveStore();
    }

    // --- 3. 回填到仓位 ---
    let filled = 0, caughtUp = 0;
    for (const [id, p] of byId) {
      const r = st.tokens[id]; if (!r) continue;
      if (r.mintTs) { p.createdAt = r.mintTs; filled++; }
      if (r.lastCollectAt) p.lastCollectAt = r.lastCollectAt;
      // 已领手续费只在扫描追平时才给 (半截数据会把累计日化算低); 未追平沿用 0 = 与无子图时的 Uniswap 路径一致
      const upToDate = r.mintBlock && r.scannedTo && (head - r.scannedTo) <= 200000; // ~1 天内算追平
      if (upToDate) {
        caughtUp++;
        const f0 = BigInt(r.c0 || '0') - BigInt(r.d0 || '0');
        const f1 = BigInt(r.c1 || '0') - BigInt(r.d1 || '0');
        p.collectedFees = {
          token0: f0 > 0n ? Number(f0) / Math.pow(10, p.token0.decimals) : 0,
          token1: f1 > 0n ? Number(f1) / Math.pow(10, p.token1.decimals) : 0,
        };
      } else if (r.mintBlock) {
        p.histPending = true; // 前端可据此提示"历史回扫中"
      }
    }
    stats.lastRound = { at: now, head, calls, ms: Date.now() - t0, budgetHit, positions: positions.length, createdAtFilled: filled, historyCaughtUp: caughtUp, rpc: logRpcs[stickyIdx]?.url };
    log(`history: ${positions.length} pos, createdAt ${filled}, caught-up ${caughtUp}, ${calls} getLogs in ${Date.now() - t0}ms${budgetHit ? ' (budget hit, resumes next round)' : ''}`);
  }

  return { NPM, FACTORY, MASTERCHEF_V3, CAKE, fetchWalletPositions, enrichHistory, stats: () => stats };
}

module.exports = { create, NPM, FACTORY, MASTERCHEF_V3, CAKE };
