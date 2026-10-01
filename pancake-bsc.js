// pancake-bsc.js — BSC 链 PancakeSwap V3 LP 头寸 (2026-09-13)
//
// 与 Uniswap V3 同构: NPM 枚举 → positions() → factory.getPool → slot0 → collect.staticCall 拿未领费。
// 三处不同 (照抄 Uniswap 必错):
//   1. slot0.feeProtocol 是 uint32 (Uniswap 是 uint8), 套 Uniswap ABI 解码会越界报错 → 自带 POOL_ABI
//   2. 质押进 MasterChefV3 农场的仓位 owner=MasterChef, NPM.balanceOf(钱包) 看不见 → 从 MasterChef 再枚举一遍,
//      未领费也得走 MasterChef.collect.staticCall (同签名), 顺带 pendingCake 奖励
//   3. Pancake 没有可用子图 → 建仓时间 / 上次领费 / 已领费历史全靠 NPM 事件日志:
//      Transfer(0→x, tokenId)=mint, Collect(tokenId)=领费(含提取的本金), DecreaseLiquidity(tokenId)=提本金,
//      已领手续费 = Collect 里扣掉「此前 Decrease 提出、尚未领走的本金」后的部分 (与 Uniswap 子图 collectedFeesToken 同口径)
//      (2026-09-28 审计修复: 旧版 ΣCollect − ΣDecrease 夹 0, 改为按 块高/logIndex 时序做本金净额, 见 netState/applyDecrease/applyCollect)
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
  'function ownerOf(uint256 tokenId) view returns (address)',   // 2026-09-28 审计修复: 两路枚举去重后以 ownerOf==MasterChef 判质押
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

// 2026-09-28 审计修复: 已领手续费改按时序做本金净额 —— DecreaseLiquidity 记入待提本金 (o0/o1), Collect 先冲抵待提本金, 余下才是手续费 (f0/f1);
// 旧口径 ΣCollect−ΣDecrease 在「先 Collect 后 Decrease」/分批提取时出负数被夹成 0。c0/c1/d0/d1 累计值仍保留 (诊断用)。
function netState(r) {
  if (r.f0 == null) {   // 旧记录迁移: 只有累计 c/d 时, 按「Decrease 都先于 Collect」的最保守解读初始化 (无 c/d 即全 0)
    const c0 = BigInt(r.c0 || '0'), c1 = BigInt(r.c1 || '0'), d0 = BigInt(r.d0 || '0'), d1 = BigInt(r.d1 || '0');
    r.f0 = (c0 > d0 ? c0 - d0 : 0n).toString(); r.f1 = (c1 > d1 ? c1 - d1 : 0n).toString();
    r.o0 = (d0 > c0 ? d0 - c0 : 0n).toString(); r.o1 = (d1 > c1 ? d1 - c1 : 0n).toString();
  }
  return r;
}
function applyDecrease(r, a0, a1) {
  netState(r);
  r.o0 = (BigInt(r.o0) + BigInt(a0)).toString(); r.o1 = (BigInt(r.o1) + BigInt(a1)).toString();
}
function applyCollect(r, a0, a1) {
  netState(r);
  const one = (amt, oKey, fKey) => {
    const owed = BigInt(r[oKey]); const principal = amt < owed ? amt : owed;   // 先冲抵待提本金
    r[oKey] = (owed - principal).toString(); r[fKey] = (BigInt(r[fKey]) + (amt - principal)).toString();
  };
  one(BigInt(a0), 'o0', 'f0'); one(BigInt(a1), 'o1', 'f1');
}

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
  // 承重的 NodeReal 端点请在 .env 的 PCS_LOG_RPCS 里自己配 (格式 https://bsc-mainnet.nodereal.io/v1/<key>@49999,...)，开源版默认只带公共兜底
  const DEFAULT_LOG_RPCS = 'https://bsc.rpc.blxrbdn.com@4999,https://bsc-rpc.publicnode.com@4999';
  const logRpcs = (process.env.PCS_LOG_RPCS || DEFAULT_LOG_RPCS).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^(.*?)(?:@(\d+))?$/);
    return { url: m[1], chunk: Math.max(500, parseInt(m[2] || '4999')), provider: null, failUntil: 0, ok: 0, fail: 0 };
  });
  const BUDGET = Math.max(10, parseInt(process.env.PCS_LOG_BUDGET || '300'));          // 每轮 getLogs 调用上限 (两阶段合计)
  // 2026-09-28 审计修复: 阶段 1 (mint 回扫) / 阶段 2 (领费历史) 各自预算 (默认 2/3 : 1/3 = 200/100 次, 时间片同比), 阶段 1 吃光预算不再饿死阶段 2
  const BUDGET_MINT = Math.max(5, parseInt(process.env.PCS_LOG_BUDGET_MINT || String(Math.ceil(BUDGET * 2 / 3))));
  const BUDGET_HIST = Math.max(5, parseInt(process.env.PCS_LOG_BUDGET_HIST || String(Math.max(5, BUDGET - BUDGET_MINT))));
  const HEAD_SAFETY = 30;   // 2026-09-28 审计修复: head 与 getLogs 可能不是同一节点, 领费扫描上沿留 30 块余量, 防落后节点把没同步到的末段静默标成已扫
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
  //                     scannedTo, c0, c1, d0, d1 (decimal string), lastCollectAt, lastCollectBlock,
  //                     f0, f1 (已领手续费净额), o0, o1 (已 Decrease 未 Collect 的本金), fees0Pub, fees1Pub, feesPubAt (上次追平时发布的已领费) }  ← 2026-09-28 审计修复新增
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
      // 2026-09-28 审计修复: 读不到未领费不再静默当 0 → err 一行 + unknown (仓位 feesUnknown: true, 前端显示「—」)
      err(`collect.staticCall failed for #${tokenId} (${staked ? 'MasterChef' : 'NPM'}):`, String(e?.shortMessage || e?.message || e).replace(/\s+/g, ' ').slice(0, 100));
      return { fees0: 0n, fees1: 0n, unknown: true };
    }
  }

  // ---------- 枚举 + 状态读取: 一个钱包的全部 Pancake V3 活跃仓 ----------
  // 2026-09-28 审计修复 (枚举契约): balanceOf / tokenOfOwnerByIndex 重试后仍失败 → 抛错 (server.js 沿用上轮该钱包 Pancake 仓 + failedWallets);
  //   只有真 0 仓才返回 []; 合约层失败 (revert/空返回 = 越界/已销毁) 才按单条跳过
  const isContractErr = (e) => e?.code === 'CALL_EXCEPTION' || e?.code === 'BAD_DATA';
  const emsg = (e) => String(e?.shortMessage || e?.message || e).replace(/\s+/g, ' ').slice(0, 80);
  async function fetchWalletPositions(wallet) {
    const walletAddress = wallet.address;
    const walletName = wallet.name;
    let nOwn, nStaked;
    try { nOwn = Number(await withRetry(() => npm.balanceOf(walletAddress))); }
    catch (e) { err(`${walletName} NPM.balanceOf failed:`, emsg(e)); throw new Error(`NPM.balanceOf failed: ${emsg(e)}`); }
    try { nStaked = Number(await withRetry(() => masterChef.balanceOf(walletAddress))); }
    catch (e) { err(`${walletName} MasterChef.balanceOf failed:`, emsg(e)); throw new Error(`MasterChef.balanceOf failed: ${emsg(e)}`); }
    if (nOwn + nStaked === 0) return [];   // 真 0 仓
    log(`${walletName}: ${nOwn} NFTs in wallet + ${nStaked} staked in MasterChefV3`);

    // 2026-09-28 审计修复: tokenOfOwnerByIndex 越界 (balanceOf 与枚举之间仓位变动) 按单条跳过并打日志; RPC 层失败仍抛错
    const idAt = (c, label) => async (i) => {
      try { return await withRetry(() => c.tokenOfOwnerByIndex(walletAddress, i)); }
      catch (e) {
        if (isContractErr(e)) { err(`${walletName} ${label}.tokenOfOwnerByIndex(${i}) 越界/回滚, 跳过:`, emsg(e)); return null; }
        throw e;
      }
    };
    const ownAll = await batchedAll(Array.from({ length: nOwn }, (_, i) => i), idAt(npm, 'NPM'));
    const stakedAll = await batchedAll(Array.from({ length: nStaked }, (_, i) => i), idAt(masterChef, 'MasterChef'));
    const ownIds = ownAll.filter(x => x != null), stakedIds = stakedAll.filter(x => x != null);
    // 2026-09-28 审计修复: 「越界」只在余额确实变少时才成立 —— 有跳过就复读 balanceOf, 没变少说明是 RPC 把失败报成了 revert (missing revert data), 按枚举失败抛错, 不让仓位凭空少一轮
    for (const [c, label, n0, got] of [[npm, 'NPM', nOwn, ownIds.length], [masterChef, 'MasterChef', nStaked, stakedIds.length]]) {
      if (got >= n0) continue;
      let n1;
      try { n1 = Number(await withRetry(() => c.balanceOf(walletAddress))); }
      catch (e) { throw new Error(`${label} 枚举跳过 ${n0 - got} 条且复核 balanceOf 失败: ${emsg(e)}`); }
      if (n1 >= n0) throw new Error(`${label} 枚举跳过 ${n0 - got} 条但 balanceOf 未变 (${n0}→${n1}), 视为 RPC 失败`);
    }
    // 2026-09-28 审计修复: 两路枚举按 tokenId 去重 (枚举间质押/解押会让同一 id 出现两次或换边); staked 以链上 ownerOf==MasterChef 为准, ownerOf 读不到才沿用枚举来源
    const byId = new Map();
    for (const id of ownIds) byId.set(id.toString(), { id, staked: false });
    for (const id of stakedIds) byId.set(id.toString(), { id, staked: true });
    const entries = [...byId.values()];
    const owners = await batchedAll(entries, (e) => withRetry(() => npm.ownerOf(e.id), 2, 800).catch(e2 => { err(`ownerOf(#${e.id}) failed (${walletName}), 按枚举来源判质押:`, emsg(e2)); return null; }));
    entries.forEach((e, i) => { if (owners[i]) e.staked = String(owners[i]).toLowerCase() === MASTERCHEF_V3.toLowerCase(); });
    // 2026-09-28 审计修复: owner 既不是本钱包也不是 MasterChef = 枚举途中已转走, 不算本钱包的仓
    for (let i = entries.length - 1; i >= 0; i--) {
      const o = owners[i] ? String(owners[i]).toLowerCase() : null;
      if (o && o !== walletAddress.toLowerCase() && o !== MASTERCHEF_V3.toLowerCase()) { err(`#${entries[i].id} 枚举后已转给 ${o.slice(0, 10)}… (${walletName}), 跳过`); entries.splice(i, 1); }
    }
    // 2026-09-28 审计修复: 单个 tokenId 的 positions() 失败按单条跳过并打日志 (不整钱包抛错); 全部失败才视为 RPC 不可信抛错
    let posFails = 0;
    const raws = await batchedAll(entries, (e) => withRetry(() => npm.positions(e.id)).catch(e2 => { posFails++; err(`positions(#${e.id}) failed (${walletName}), 跳过:`, emsg(e2)); return null; }));
    if (entries.length && posFails === entries.length) throw new Error(`positions() 全部失败 (${entries.length} 个)`);

    const positions = [];
    for (let i = 0; i < entries.length; i++) {
      const { id, staked } = entries[i];
      const pos = raws[i];
      if (!pos || Number(pos.liquidity) === 0) continue; // 已清仓不展示 (与 Uniswap 路径一致); 读取失败的已在上面打过日志
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

      const { fees0, fees1, unknown: feesUnknown } = await unclaimedFees(id, walletAddress, staked);
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
        ...(feesUnknown ? { feesUnknown: true } : {}),   // 2026-09-28 审计修复: 未领费读取失败 (前端显示「—」而非 0)
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
    // 2026-09-28 审计修复: 两阶段各自预算 (调用次数 + 时间片); 合计仍不超过 BUDGET / TIME_BUDGET
    let calls1 = 0, calls2 = 0, budgetHit1 = false, budgetHit2 = false;
    const overBudget1 = () => { if (calls1 >= BUDGET_MINT || Date.now() - t0 > TIME_BUDGET * 2 / 3) { budgetHit1 = true; return true; } return false; };
    const overBudget2 = () => { if (calls2 >= BUDGET_HIST || calls1 + calls2 >= BUDGET || Date.now() - t0 > TIME_BUDGET) { budgetHit2 = true; return true; } return false; };
    const st = store();
    let headRaw;
    try { headRaw = await headBlock(); } catch (e) { err('head block failed:', String(e?.message || e).slice(0, 80)); return; }
    // 2026-09-28 审计修复: 领费扫描上沿 head = 真实 head − HEAD_SAFETY (阶段 2 / 追平判定用); mint 回扫仍从真实 head 起 (新仓 mint 可能就在最后几十块, 少扫会被判 24h 找不到)
    const head = Math.max(GENESIS, headRaw - HEAD_SAFETY);
    const now = Date.now();
    const byId = new Map(positions.map(p => [p.tokenId, p]));

    // --- 1. mint 发现: 未知 mint 的 token 按 floor 分组倒序回扫 (Transfer from=0, topic3∈ids) ---
    const groups = new Map(); // floor -> [ids]
    for (const id of byId.keys()) {
      const r = tokRec(id);
      if (r.mintBlock) continue;
      if (r.mintMissTs && now - r.mintMissTs < 24 * 3600 * 1000) continue; // 上次判定找不到, 24h 后再试
      const floor = r.floor || (headRaw + 1);
      (groups.get(floor) || groups.set(floor, []).get(floor)).push(id);
    }
    const deepest = Math.max(GENESIS, headRaw - MAX_DEPTH);
    for (const [floor0, ids] of groups) {
      let floor = floor0;
      const pending = new Set(ids);
      while (pending.size && floor - 1 >= deepest) {
        if (overBudget1()) break;
        calls1++;
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
      if (budgetHit1) break;
    }
    // mint 时间戳
    for (const id of byId.keys()) {
      const r = tokRec(id);
      if (r.mintBlock && !r.mintTs) r.mintTs = await blockTs(r.mintBlock);
    }
    saveStore();

    // --- 2. 领费历史: 已知 mint 的 token 从 (scannedTo+1 | mintBlock) 前扫到 head, 按起点分组 ---
    {   // 2026-09-28 审计修复: 阶段 2 有自己的预算, 不再因阶段 1 吃光预算被整体跳过
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
          if (overBudget2()) break;
          calls2++;
          let res;
          try {
            res = await scanChunk(() => ({ address: NPM, topics: [[TOPIC_COLLECT, TOPIC_DECREASE], hexes] }), from, 'up', head);
          } catch (e) {
            err(`collect scan from ${from} failed (${ids.length} ids):`, e.message?.replace(/\s+/g, ' ').slice(0, 90));
            break; // 进度停在上一段, 下轮续
          }
          // 2026-09-28 审计修复: 同段日志按 块高/logIndex 时序处理, Decrease 记待提本金、Collect 先冲抵本金再计费 (netState/applyDecrease/applyCollect)
          const ordered = [...res.logs].sort((a, b) => (Number(a.blockNumber) - Number(b.blockNumber)) || (Number(a.index ?? a.logIndex ?? 0) - Number(b.index ?? b.logIndex ?? 0)));
          for (const l of ordered) {
            const id = BigInt(l.topics[1]).toString();
            const r = st.tokens[id]; if (!r) continue;
            netState(r);   // 先迁移旧记录 (只有累计 c/d 的) 再累加本条, 否则本条会被算进迁移基数
            let a0, a1;
            try {
              if (l.topics[0] === TOPIC_COLLECT) {
                [, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256', 'uint256'], l.data);
                r.c0 = (BigInt(r.c0 || '0') + a0).toString(); r.c1 = (BigInt(r.c1 || '0') + a1).toString();
                applyCollect(r, a0, a1);
                if (!r.lastCollectBlock || Number(l.blockNumber) >= r.lastCollectBlock) { r.lastCollectBlock = Number(l.blockNumber); r.lastCollectAt = 0; }
              } else {
                [, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(['uint128', 'uint256', 'uint256'], l.data);
                r.d0 = (BigInt(r.d0 || '0') + a0).toString(); r.d1 = (BigInt(r.d1 || '0') + a1).toString();
                applyDecrease(r, a0, a1);
              }
            } catch { /* 畸形日志跳过 */ }
          }
          for (const id of ids) st.tokens[id].scannedTo = res.end;
          from = res.end + 1;
          await sleep(40);
        }
        if (budgetHit2) break;
      }
      for (const id of byId.keys()) {
        const r = tokRec(id);
        if (r.lastCollectBlock && !r.lastCollectAt) r.lastCollectAt = await blockTs(r.lastCollectBlock);
      }
      saveStore();
    }

    // --- 3. 回填到仓位 ---
    let filled = 0, caughtUp = 0, pubChanged = false;
    for (const [id, p] of byId) {
      const r = st.tokens[id]; if (!r) continue;
      if (r.mintTs) { p.createdAt = r.mintTs; filled++; }
      if (r.lastCollectAt) p.lastCollectAt = r.lastCollectAt;
      // 已领手续费只在扫描追平时才给 (半截数据会把累计日化算低)
      const upToDate = r.mintBlock && r.scannedTo && (head - r.scannedTo) <= 200000; // ~1 天内算追平
      if (upToDate) {
        caughtUp++;
        netState(r);
        // 2026-09-28 审计修复: 净额算法结果非负, 不再夹 0; 追平值同时落盘 (fees0Pub/fees1Pub/feesPubAt) 供未追平轮次沿用
        if (r.fees0Pub !== r.f0 || r.fees1Pub !== r.f1) { r.fees0Pub = r.f0; r.fees1Pub = r.f1; r.feesPubAt = now; pubChanged = true; }
        p.collectedFees = { token0: Number(BigInt(r.f0)) / Math.pow(10, p.token0.decimals), token1: Number(BigInt(r.f1)) / Math.pow(10, p.token1.decimals) };
      } else if (r.mintBlock) {
        p.histPending = true; // 前端可据此提示"历史回扫中"
        // 2026-09-28 审计修复: 未追平 (预算/RPC 抖动) 不再把已领费归 0 → 沿用上次追平时的值并标 collectedStale; 从没追平过的仍是 0 (与无子图 Uniswap 路径一致)
        if (r.fees0Pub != null) {
          p.collectedFees = { token0: Number(BigInt(r.fees0Pub)) / Math.pow(10, p.token0.decimals), token1: Number(BigInt(r.fees1Pub || '0')) / Math.pow(10, p.token1.decimals) };
          p.collectedStale = true;
        }
      }
    }
    if (pubChanged) saveStore();
    const calls = calls1 + calls2, budgetHit = budgetHit1 || budgetHit2;
    stats.lastRound = { at: now, head, headRaw, calls, callsMint: calls1, callsHist: calls2, ms: Date.now() - t0, budgetHit, budgetHitMint: budgetHit1, budgetHitHist: budgetHit2, positions: positions.length, createdAtFilled: filled, historyCaughtUp: caughtUp, rpc: logRpcs[stickyIdx]?.url };
    log(`history: ${positions.length} pos, createdAt ${filled}, caught-up ${caughtUp}, ${calls} getLogs (mint ${calls1} / hist ${calls2}) in ${Date.now() - t0}ms${budgetHit ? ` (budget hit${budgetHit1 ? ' mint' : ''}${budgetHit2 ? ' hist' : ''}, resumes next round)` : ''}`);
  }

  return { NPM, FACTORY, MASTERCHEF_V3, CAKE, fetchWalletPositions, enrichHistory, stats: () => stats };
}

module.exports = { create, NPM, FACTORY, MASTERCHEF_V3, CAKE, _test: { netState, applyDecrease, applyCollect } };   // 2026-09-28 审计修复: 净额算法导出供独立脚本验证
