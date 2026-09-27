// ============================================================
// Solana LP 适配器 — Meteora DLMM + Raydium CLMM + Orca Whirlpool
// 完全独立模块：不依赖 server.js 的任何 BSC 逻辑。
// 输出与 BSC /api/positions 相同的 JSON 结构，前端零改动复用。
// ============================================================
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const SOL_RPC = process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com';
// 备胎 RPC: 主 RPC 连续 429 时最后一轮重试切换用 (官方节点低频单钱包查询可承受)
const SOL_RPC_FALLBACK = process.env.SOL_RPC_FALLBACK || 'https://api.mainnet-beta.solana.com';
let conn = new Connection(SOL_RPC, 'confirmed');

const WALLETS_FILE = path.join(__dirname, 'wallets-sol.json');
const CACHE_FILE = path.join(__dirname, 'positions-cache-sol.json');
const CACHE_TTL = 5 * 60 * 1000; // 5 min，与 BSC 一致 (2026-09-05 调快)

const RAY_CLMM_PROGRAM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// --- wallets ---
function loadWallets() {
  try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch { return []; }
}
function saveWallets(w) {
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2));
}
let WALLETS = loadWallets();
// 启用中的钱包 (enabled 缺省=启用; false=停用: 不抓仓位/不查余额, 只保留在列表里)
function isWalletOn(w) { return w.enabled !== false; }
function activeWallets() { return WALLETS.filter(isWalletOn); }

// --- cache ---
let cache = { data: null, timestamp: 0 };
try {
  const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  if (c && c.data) cache = c;
} catch {}
function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
}

// --- Jupiter price API (free lite tier) ---
async function getPrices(mints) {
  const out = {};
  const uniq = [...new Set(mints)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${batch.join(',')}`);
      if (r.ok) {
        const j = await r.json();
        for (const [mint, info] of Object.entries(j)) out[mint] = info?.usdPrice || 0;
      }
    } catch (e) { console.error('SOL price fetch failed:', e.message); }
  }
  return out;
}

// --- Token metadata (symbol) via Jupiter, with fallback map + cache ---
const solLedger = require('./sol-ledger');    // Solana 钱包盈亏账本 (Helius 数据源)
const pnlLedger = require('./pnl-ledger');    // 只用它的 applyPnl (盈亏字段注入, 各链同一口径)
let lastPricesSol = {};                        // 上轮定价 (mint -> USD), 供账本给已关闭仓/无换币记录的币估值
const TOKEN_META_FILE = path.join(__dirname, 'token-meta-sol.json');
let tokenMeta = {};
try { tokenMeta = JSON.parse(fs.readFileSync(TOKEN_META_FILE, 'utf8')); } catch {}
const KNOWN_TOKENS = {
  'So11111111111111111111111111111111111111112': 'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT',
};
async function getTokenSymbols(mints) {
  const need = [...new Set(mints)].filter(m => m && !tokenMeta[m] && !KNOWN_TOKENS[m]);
  if (need.length) {
    for (const mint of need) {
      try {
        const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
        if (r.ok) {
          const arr = await r.json();
          const hit = Array.isArray(arr) ? arr.find(t => t.id === mint) : null;
          if (hit) tokenMeta[mint] = { symbol: hit.symbol, decimals: hit.decimals };
        }
      } catch {}
      if (!tokenMeta[mint]) tokenMeta[mint] = { symbol: mint.slice(0, 4) + '…', decimals: null };
    }
    try { fs.writeFileSync(TOKEN_META_FILE, JSON.stringify(tokenMeta)); } catch {}
  }
  const out = {};
  for (const m of [...new Set(mints)]) {
    out[m] = KNOWN_TOKENS[m] ? { symbol: KNOWN_TOKENS[m] } : (tokenMeta[m] || { symbol: m.slice(0, 4) + '…' });
  }
  return out;
}

const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// ============================================================
// Meteora DLMM
// ============================================================
async function fetchMeteoraPositions(wallet) {
  const DLMM = require('@meteora-ag/dlmm');
  const positions = [];
  let map;
  try {
    map = await DLMM.getAllLbPairPositionsByUser(conn, new PublicKey(wallet.address));
  } catch (e) {
    console.error(`Meteora fetch failed for ${wallet.name}:`, e.message.slice(0, 120));
    return null;   // null = 抓取失败(如429), 上层重试; 空数组才是真没仓位
  }
  for (const [pairAddr, info] of map) {
    try {
      const decX = info.tokenX.mint?.decimals ?? info.tokenX.decimal;
      const decY = info.tokenY.mint?.decimals ?? info.tokenY.decimal;
      const mintX = info.tokenX.publicKey.toBase58();
      const mintY = info.tokenY.publicKey.toBase58();
      const binStep = info.lbPair.binStep;
      const activeId = info.lbPair.activeId;
      // DLMM price: price(binId) = (1 + binStep/10000)^binId  (X in terms of Y, per lamport)
      const binPrice = (id) => Math.pow(1 + binStep / 10000, id) * Math.pow(10, decX - decY);

      for (const pos of info.lbPairPositionsData) {
        const d = pos.positionData;
        const amount0 = Number(d.totalXAmount) / 10 ** decX;
        const amount1 = Number(d.totalYAmount) / 10 ** decY;
        const feesOwed0 = Number(d.feeX) / 10 ** decX;
        const feesOwed1 = Number(d.feeY) / 10 ** decY;
        const lowerPrice = binPrice(d.lowerBinId);
        const upperPrice = binPrice(d.upperBinId + 1); // upper bin 的上边界
        const currentPrice = binPrice(activeId);
        const inRange = activeId >= d.lowerBinId && activeId <= d.upperBinId;
        const liquidityActive = amount0 > 0 || amount1 > 0;

        positions.push({
          tokenId: pos.publicKey.toBase58().slice(0, 8),
          positionKey: pos.publicKey.toBase58(),
          token0: { symbol: '', address: mintX, decimals: decX },
          token1: { symbol: '', address: mintY, decimals: decY },
          token0addr: mintX,
          token1addr: mintY,
          fee: 0,
          feeLabel: (info.lbPair.parameters?.baseFactor != null)
            ? ((info.lbPair.parameters.baseFactor * binStep) / 1e6 * 100).toFixed(2) + '%'
            : `bin ${binStep}`,
          tickLower: d.lowerBinId,
          tickUpper: d.upperBinId,
          currentTick: activeId,
          liquidity: liquidityActive ? '1' : '0',
          liquidityActive,
          inRange,
          currentPrice,
          lowerPrice,
          upperPrice,
          amount0,
          amount1,
          feesOwed0,
          feesOwed1,
          poolAddress: pairAddr,
          walletName: wallet.name,
          walletAddress: wallet.address,
          protocol: 'DLMM',
          platform: 'Meteora',
          createdAt: 0,
          lastCollectAt: 0,
          _lastUpdatedAt: Number(d.lastUpdatedAt) || 0,
          _claimed0: Number(d.totalClaimedFeeXAmount || 0) / 10 ** decX,
          _claimed1: Number(d.totalClaimedFeeYAmount || 0) / 10 ** decY,
        });
      }
    } catch (e) {
      console.error(`Meteora pair ${pairAddr} parse error:`, e.message.slice(0, 120));
    }
  }
  return positions;
}

// ============================================================
// Raydium CLMM
// ============================================================
let raydiumInstances = {}; // per-wallet cache (owner is baked into instance)

async function fetchRaydiumPositions(wallet) {
  const { Raydium, PositionUtils, TickArrayLayout, TickUtil, getPdaTickArrayAddress, getPdaPersonalPositionAddress, TICK_ARRAY_SIZE } = require('@raydium-io/raydium-sdk-v2');
  const progPk = new PublicKey(RAY_CLMM_PROGRAM);
  const taStart = (tick, spacing) => Math.floor(tick / (spacing * TICK_ARRAY_SIZE)) * spacing * TICK_ARRAY_SIZE;
  const positions = [];
  try {
    let raydium = raydiumInstances[wallet.address];
    if (!raydium) {
      raydium = await Raydium.load({
        connection: conn,
        owner: new PublicKey(wallet.address),
        disableLoadToken: true,
      });
      raydiumInstances[wallet.address] = raydium;
    }
    const posList = await raydium.clmm.getOwnerPositionInfo({ programId: RAY_CLMM_PROGRAM });
    if (!posList.length) return [];

    for (const p of posList) {
      try {
        const poolIdStr = p.poolId.toBase58();
        // 官方 API：symbol/decimals/feeRate/APR
        const r = await fetch(`https://api-v3.raydium.io/pools/info/ids?ids=${poolIdStr}`);
        const j = await r.json();
        const pool = j?.data?.[0];
        if (!pool) { console.error(`Raydium pool info missing: ${poolIdStr}`); continue; }

        const decA = pool.mintA.decimals, decB = pool.mintB.decimals;
        const lowerPrice = Math.pow(1.0001, p.tickLower) * Math.pow(10, decA - decB);
        const upperPrice = Math.pow(1.0001, p.tickUpper) * Math.pow(10, decA - decB);

        // 链上池子状态：精确 tick / sqrtPrice / feeGrowth
        const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId: p.poolId });
        const currentTick = rpcData.tickCurrent;
        const inRange = currentTick >= p.tickLower && currentTick < p.tickUpper;
        const currentPrice = Math.pow(1.0001, currentTick) * Math.pow(10, decA - decB);

        // amounts (Uniswap V3 math, BigInt)
        const L = BigInt(p.liquidity.toString());
        const Q64 = 2n ** 64n;
        const sp = BigInt(rpcData.sqrtPriceX64.toString());
        const sl = BigInt(TickUtil.getSqrtPriceAtTick(p.tickLower).toString());
        const su = BigInt(TickUtil.getSqrtPriceAtTick(p.tickUpper).toString());
        let a0 = 0n, a1 = 0n;
        if (sp <= sl) a0 = L * Q64 * (su - sl) / (sl * su);
        else if (sp >= su) a1 = L * (su - sl) / Q64;
        else { a0 = L * Q64 * (su - sp) / (sp * su); a1 = L * (sp - sl) / Q64; }
        const amount0 = Number(a0) / 10 ** decA;
        const amount1 = Number(a1) / 10 ** decB;

        // 未领手续费：tick array 状态 + GetPositionFees
        let feesOwed0 = 0, feesOwed1 = 0;
        try {
          const taLowerAddr = getPdaTickArrayAddress(progPk, p.poolId, taStart(p.tickLower, rpcData.tickSpacing)).publicKey;
          const taUpperAddr = getPdaTickArrayAddress(progPk, p.poolId, taStart(p.tickUpper, rpcData.tickSpacing)).publicKey;
          const [accL, accU] = await conn.getMultipleAccountsInfo([taLowerAddr, taUpperAddr]);
          if (accL && accU) {
            const taL = TickArrayLayout.decode(accL.data);
            const taU = TickArrayLayout.decode(accU.data);
            const offL = Math.floor((p.tickLower - taStart(p.tickLower, rpcData.tickSpacing)) / rpcData.tickSpacing);
            const offU = Math.floor((p.tickUpper - taStart(p.tickUpper, rpcData.tickSpacing)) / rpcData.tickSpacing);
            const fees = PositionUtils.GetPositionFees(rpcData, p, taL.ticks[offL], taU.ticks[offU]);
            feesOwed0 = Number(fees.tokenFeeAmountA.toString()) / 10 ** decA;
            feesOwed1 = Number(fees.tokenFeeAmountB.toString()) / 10 ** decB;
            if (feesOwed0 < 0 || feesOwed0 > 1e12) feesOwed0 = 0;
            if (feesOwed1 < 0 || feesOwed1 > 1e12) feesOwed1 = 0;
          }
        } catch (e) {
          console.error(`Raydium fee calc ${poolIdStr}:`, e.message.slice(0, 100));
        }

        positions.push({
          tokenId: p.nftMint.toBase58().slice(0, 8),
          positionKey: p.nftMint.toBase58(),
          _activityKey: getPdaPersonalPositionAddress(progPk, p.nftMint).publicKey.toBase58(),
          token0: { symbol: pool.mintA.symbol, address: pool.mintA.address, decimals: decA },
          token1: { symbol: pool.mintB.symbol, address: pool.mintB.address, decimals: decB },
          token0addr: pool.mintA.address,
          token1addr: pool.mintB.address,
          fee: (pool.feeRate || 0) * 1e6,
          feeLabel: pool.feeRate ? (pool.feeRate * 100).toFixed(2) + '%' : '',
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          currentTick,
          liquidity: p.liquidity.toString(),
          liquidityActive: L > 0n,
          inRange,
          currentPrice,
          lowerPrice,
          upperPrice,
          amount0,
          amount1,
          feesOwed0,
          feesOwed1,
          poolAddress: poolIdStr,
          walletName: wallet.name,
          walletAddress: wallet.address,
          protocol: 'CLMM',
          platform: 'Raydium',
          createdAt: 0,
          lastCollectAt: 0,
          _aprApi: pool.day?.apr || 0,
        });
      } catch (e) {
        console.error(`Raydium position error:`, e.message.slice(0, 120));
      }
    }
  } catch (e) {
    console.error(`Raydium fetch failed for ${wallet.name}:`, e.message.slice(0, 120));
    return null;   // null = 抓取失败(如429), 上层重试; 空数组才是真没仓位
  }
  return positions;
}

// ============================================================
// Orca Whirlpool
// 不走 SDK (新版 @orca-so/whirlpools 基于 @solana/kit, 与这里的 web3.js v1 是两套连接): 读账户按布局直接解码。
// 布局与 sol-stocks/sol.js 同源 (2026-09-25 逐字段核过); 数量/未领费 2026-09-26 用真实仓位与
// @orca-so/whirlpools-core 的 decreaseLiquidityQuote / collectFeesQuote 核对逐位一致。
// 仓位 NFT 可能在 Token 或 Token-2022 program 下 (新仓默认 Token-2022), 两边都枚举。
// ============================================================
const ORCA_PROGRAM = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const ORCA_TICKS_PER_ARRAY = 88;
const anchorDisc = name => require('crypto').createHash('sha256').update(`account:${name}`).digest().subarray(0, 8).toString('hex');
const ORCA_DISC = { position: anchorDisc('Position'), whirlpool: anchorDisc('Whirlpool'), tickArray: anchorDisc('TickArray'), dynTickArray: anchorDisc('DynamicTickArray') };
const Q128 = 1n << 128n;
const bU128 = (b, o) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);
const bPk = (b, o) => new PublicKey(b.subarray(o, o + 32)).toBase58();
const wrapSub = (a, b) => ((a - b) % Q128 + Q128) % Q128;   // fee growth 是 u128 回绕运算
const orcaArrayStart = (tick, ts) => Math.floor(tick / (ts * ORCA_TICKS_PER_ARRAY)) * ts * ORCA_TICKS_PER_ARRAY;
const orcaTickArrayPda = (whirlpool, start) => PublicKey.findProgramAddressSync(
  [Buffer.from('tick_array'), new PublicKey(whirlpool).toBuffer(), Buffer.from(String(start))], ORCA_PROGRAM)[0].toBase58();

async function getAccountsChunked(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    out.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100).map(k => new PublicKey(k))));
  }
  return out;
}

// 从 tick array 里取某个 tick 的 feeGrowthOutside; 未初始化的 tick 按 0 (与合约一致)
// 定长: 8 start i32 | 12 ticks 88×113 (0 initialized | 1 liqNet i128 | 17 liqGross | 33 fgoA u128 | 49 fgoB u128 | 65 rewards) | 9956 whirlpool
// 变长: 8 start i32 | 12 whirlpool | 44 bitmap u128 | 60 起逐个: 1 字节 tag (0 未初始化 / 1 + 112 字节数据, 布局同上去掉 initialized)
function orcaTickFees(b, tick, ts) {
  const d = b.subarray(0, 8).toString('hex');
  const start = b.readInt32LE(8);
  const idx = (tick - start) / ts;
  if (!Number.isInteger(idx) || idx < 0 || idx >= ORCA_TICKS_PER_ARRAY) throw new Error(`tick ${tick} 不在 array ${start}`);
  if (d === ORCA_DISC.tickArray) {
    const o = 12 + idx * 113;
    if (!b[o]) return { foA: 0n, foB: 0n };
    return { foA: bU128(b, o + 33), foB: bU128(b, o + 49) };
  }
  if (d === ORCA_DISC.dynTickArray) {
    let o = 60;
    for (let i = 0; i < idx; i++) o += b[o] === 1 ? 113 : 1;
    if (b[o] !== 1) return { foA: 0n, foB: 0n };
    return { foA: bU128(b, o + 1 + 32), foB: bU128(b, o + 1 + 48) };
  }
  throw new Error('未知 tick array 类型');
}

async function fetchOrcaPositions(wallet) {
  const positions = [];
  try {
    // 1. 钱包里的 NFT (amount=1, decimals=0) → 推 Position PDA, 存在且归 Whirlpool 程序的才是 Orca 仓位
    const owner = new PublicKey(wallet.address);
    const nftMints = [];
    for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await conn.getParsedTokenAccountsByOwner(owner, { programId: pid });
      for (const acc of r.value) {
        const info = acc.account.data.parsed?.info;
        if (info?.tokenAmount?.amount === '1' && info.tokenAmount.decimals === 0) nftMints.push(info.mint);
      }
    }
    if (!nftMints.length) return [];
    const pdas = nftMints.map(m => PublicKey.findProgramAddressSync([Buffer.from('position'), new PublicKey(m).toBuffer()], ORCA_PROGRAM)[0].toBase58());
    const posAccs = await getAccountsChunked(pdas);
    // Position: 8 whirlpool | 40 positionMint | 72 liquidity u128 | 88 tickLower i32 | 92 tickUpper i32
    //   96 feeGrowthCheckpointA u128 | 112 feeOwedA u64 | 120 feeGrowthCheckpointB u128 | 136 feeOwedB u64 | 144 rewards → 216
    const raw = [];
    posAccs.forEach((a, i) => {
      if (!a || !a.owner.equals(ORCA_PROGRAM) || a.data.length < 216 || a.data.subarray(0, 8).toString('hex') !== ORCA_DISC.position) return;
      const b = a.data;
      raw.push({
        pda: pdas[i], mint: nftMints[i], whirlpool: bPk(b, 8), liquidity: bU128(b, 72),
        tickLower: b.readInt32LE(88), tickUpper: b.readInt32LE(92),
        cpA: bU128(b, 96), owedA: b.readBigUInt64LE(112), cpB: bU128(b, 120), owedB: b.readBigUInt64LE(136),
      });
    });
    if (!raw.length) return [];

    // 2. 池子状态
    // Whirlpool: 41 tickSpacing u16 | 43 feeTierIndexSeed u16 | 45 feeRate u16 (百万分之) | 49 liquidity | 65 sqrtPrice u128
    //   81 tickCurrent i32 | 101 mintA | 165 feeGrowthGlobalA u128 | 181 mintB | 245 feeGrowthGlobalB u128
    const poolIds = [...new Set(raw.map(r => r.whirlpool))];
    const poolAccs = await getAccountsChunked(poolIds);
    const pools = {};
    poolAccs.forEach((a, i) => {
      if (!a || a.data.length < 653 || a.data.subarray(0, 8).toString('hex') !== ORCA_DISC.whirlpool) return;
      const b = a.data;
      pools[poolIds[i]] = {
        tickSpacing: b.readUInt16LE(41), feeTierSeed: b.readUInt16LE(43), feeRate: b.readUInt16LE(45),
        sqrtPrice: bU128(b, 65), tickCurrent: b.readInt32LE(81),
        mintA: bPk(b, 101), fgA: bU128(b, 165), mintB: bPk(b, 181), fgB: bU128(b, 245),
      };
    });

    // 3. 仓位两端 tick 所在的 tick array + 两个代币 mint (取 decimals, mint 布局 44 字节处)
    const extra = new Set();
    for (const r of raw) {
      const p = pools[r.whirlpool];
      if (!p) continue;
      extra.add(p.mintA); extra.add(p.mintB);
      if (r.liquidity > 0n) {
        extra.add(orcaTickArrayPda(r.whirlpool, orcaArrayStart(r.tickLower, p.tickSpacing)));
        extra.add(orcaTickArrayPda(r.whirlpool, orcaArrayStart(r.tickUpper, p.tickSpacing)));
      }
    }
    const extraKeys = [...extra];
    const extraAccs = await getAccountsChunked(extraKeys);
    const acct = {};
    extraKeys.forEach((k, i) => { acct[k] = extraAccs[i]; });

    for (const r of raw) {
      try {
        const p = pools[r.whirlpool];
        if (!p) { console.error(`Orca pool missing: ${r.whirlpool}`); continue; }
        const mA = acct[p.mintA], mB = acct[p.mintB];
        if (!mA || !mB) { console.error(`Orca mint missing: ${r.whirlpool}`); continue; }
        const decA = mA.data[44], decB = mB.data[44];
        const px = t => Math.pow(1.0001, t) * Math.pow(10, decA - decB);
        const inRange = p.tickCurrent >= r.tickLower && p.tickCurrent < r.tickUpper;

        // 数量 (与 Raydium 同一套 V3 数学, Q64.64)
        const L = Number(r.liquidity);
        const sa = Math.pow(1.0001, r.tickLower / 2), sb = Math.pow(1.0001, r.tickUpper / 2), sp = Number(p.sqrtPrice) / 2 ** 64;
        let a0 = 0, a1 = 0;
        if (sp <= sa) a0 = L * (sb - sa) / (sa * sb);
        else if (sp >= sb) a1 = L * (sb - sa);
        else { a0 = L * (sb - sp) / (sp * sb); a1 = L * (sp - sa); }

        // 未领手续费 = feeOwed + L × (feeGrowthInside − checkpoint) >> 64
        let fA = r.owedA, fB = r.owedB;
        if (r.liquidity > 0n) {
          try {
            const taL = acct[orcaTickArrayPda(r.whirlpool, orcaArrayStart(r.tickLower, p.tickSpacing))];
            const taU = acct[orcaTickArrayPda(r.whirlpool, orcaArrayStart(r.tickUpper, p.tickSpacing))];
            if (!taL || !taU) throw new Error('tick array 缺失');
            const lo = orcaTickFees(taL.data, r.tickLower, p.tickSpacing);
            const hi = orcaTickFees(taU.data, r.tickUpper, p.tickSpacing);
            const inside = (fg, foL, foU) => {
              const below = p.tickCurrent < r.tickLower ? wrapSub(fg, foL) : foL;
              const above = p.tickCurrent < r.tickUpper ? foU : wrapSub(fg, foU);
              return wrapSub(wrapSub(fg, below), above);
            };
            fA += (r.liquidity * wrapSub(inside(p.fgA, lo.foA, hi.foA), r.cpA)) >> 64n;
            fB += (r.liquidity * wrapSub(inside(p.fgB, lo.foB, hi.foB), r.cpB)) >> 64n;
          } catch (e) {
            console.error(`Orca fee calc ${r.whirlpool}:`, e.message.slice(0, 100));
          }
        }
        let feesOwed0 = Number(fA) / 10 ** decA, feesOwed1 = Number(fB) / 10 ** decB;
        if (feesOwed0 < 0 || feesOwed0 > 1e12) feesOwed0 = 0;
        if (feesOwed1 < 0 || feesOwed1 > 1e12) feesOwed1 = 0;

        positions.push({
          tokenId: r.mint.slice(0, 8),
          positionKey: r.mint,
          _activityKey: r.pda,
          token0: { symbol: '', address: p.mintA, decimals: decA },
          token1: { symbol: '', address: p.mintB, decimals: decB },
          token0addr: p.mintA,
          token1addr: p.mintB,
          fee: p.feeRate,
          // 自适应费率池 (feeTierIndexSeed ≠ tickSpacing): feeRate 只是基础费, 实际随波动上浮, 标「+」
          feeLabel: (p.feeRate / 1e4).toFixed(2) + '%' + (p.feeTierSeed !== p.tickSpacing ? '+' : ''),
          tickLower: r.tickLower,
          tickUpper: r.tickUpper,
          currentTick: p.tickCurrent,
          liquidity: r.liquidity.toString(),
          liquidityActive: r.liquidity > 0n,
          inRange,
          currentPrice: sp * sp * Math.pow(10, decA - decB),
          lowerPrice: px(r.tickLower),
          upperPrice: px(r.tickUpper),
          amount0: a0 / 10 ** decA,
          amount1: a1 / 10 ** decB,
          feesOwed0,
          feesOwed1,
          poolAddress: r.whirlpool,
          walletName: wallet.name,
          walletAddress: wallet.address,
          protocol: 'Whirlpool',
          platform: 'Orca',
          createdAt: 0,
          lastCollectAt: 0,
        });
      } catch (e) {
        console.error(`Orca position error:`, e.message.slice(0, 120));
      }
    }
  } catch (e) {
    console.error(`Orca fetch failed for ${wallet.name}:`, e.message.slice(0, 120));
    return null;   // null = 抓取失败(如429), 上层重试; 空数组才是真没仓位
  }
  return positions;
}

// --- 仓位创建时间：查该账户最早一笔签名的 blockTime（永不变，持久缓存） ---
const CREATED_CACHE_FILE = path.join(__dirname, 'created-cache-sol.json');
let createdCache = {};
try { createdCache = JSON.parse(fs.readFileSync(CREATED_CACHE_FILE, 'utf8')); } catch {}
async function getCreatedAt(pubkeyStr) {
  if (createdCache[pubkeyStr]) return createdCache[pubkeyStr];
  // 主 RPC 失败(429等)时切备胎重试一次 —— createdAt 拿不到会导致日化无法计算
  for (const c of [conn, new Connection(SOL_RPC_FALLBACK, 'confirmed')]) {
    try {
      const pk = new PublicKey(pubkeyStr);
      let before = undefined, oldest = null;
      for (let page = 0; page < 5; page++) {
        // 注意: 必须 finalized —— solanavibestation 等节点 confirmed 档签名索引返回空数组
        const sigs = await c.getSignaturesForAddress(pk, { limit: 1000, before }, 'finalized');
        if (!sigs.length) break;
        oldest = sigs[sigs.length - 1];
        if (sigs.length < 1000) break;
        before = oldest.signature;
      }
      if (oldest?.blockTime) {
        createdCache[pubkeyStr] = oldest.blockTime * 1000;
        try { fs.writeFileSync(CREATED_CACHE_FILE, JSON.stringify(createdCache)); } catch {}
        return createdCache[pubkeyStr];
      }
      return 0;   // 查询成功但无签名(理论不该发生), 不必换备胎
    } catch (e) {
      console.error(`[SOL] createdAt lookup failed ${pubkeyStr.slice(0, 8)}:`, e.message.slice(0, 80));
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return 0;
}

// 最近一次链上操作时间（领取/加减仓都会更新）——不缓存，每次刷新都查最新
async function getLastActivityAt(pubkeyStr) {
  for (const c of [conn, new Connection(SOL_RPC_FALLBACK, 'confirmed')]) {
    try {
      const sigs = await c.getSignaturesForAddress(new PublicKey(pubkeyStr), { limit: 1 }, 'finalized');
      if (sigs[0]?.blockTime) return sigs[0].blockTime * 1000;
      return 0;
    } catch (e) {
      console.error(`[SOL] lastActivity lookup failed ${pubkeyStr.slice(0, 8)}:`, e.message.slice(0, 80));
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return 0;
}

// ============================================================
// 钱包闲置余额: native SOL + 全部 SPL token (Token + Token-2022 两个 program)
// 定价走 Jupiter (与 LP 同源), 无价/垃圾空投币自然被 <$1 灰尘线滤掉
// ============================================================
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
let lastIdleSol = null;   // 上轮成功快照, RPC 抖动时兜底

// 钱包资金查询配置 (fund-config.json, 路由在 server.js); SOL 地址大小写敏感按原样匹配
function fundWalletsSol() {
  let cfg = { enabled: true, wallets: {} };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-config.json'), 'utf8'));
    cfg = { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} };
  } catch {}
  if (!cfg.enabled) return [];
  const sel = cfg.wallets.sol;
  if (!Array.isArray(sel)) return activeWallets();
  return activeWallets().filter(w => sel.includes(w.address));
}

async function fetchIdleSol(walletsSel) {
  const raw = [];
  const allMints = new Set([WSOL_MINT]);
  for (const w of walletsSel) {
    try {
      const owner = new PublicKey(w.address);
      const lamports = await conn.getBalance(owner);
      const toks = [];
      for (const pid of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        const r = await conn.getParsedTokenAccountsByOwner(owner, { programId: pid });
        for (const acc of r.value) {
          const info = acc.account.data.parsed?.info;
          const amt = info?.tokenAmount?.uiAmount;
          if (amt > 0) { toks.push({ mint: info.mint, amount: amt }); allMints.add(info.mint); }
        }
        await new Promise(r2 => setTimeout(r2, 300));
      }
      raw.push({ w, lamports, toks });
    } catch (e) {
      console.error(`[SOL] idle balance failed ${w.name}:`, e.message.slice(0, 80));
      raw.push({ w, failed: true });
    }
    await new Promise(r2 => setTimeout(r2, 600));
  }
  const mintArr = [...allMints];
  const [symbols, prices] = await Promise.all([getTokenSymbols(mintArr), getPrices(mintArr)]);
  const solPrice = prices[WSOL_MINT] || 0;

  const byWallet = {}; let totalUSD = 0;
  for (const entry of raw) {
    const addr = entry.w.address;
    if (entry.failed) {
      // 本钱包本轮失败: 沿用上轮快照
      const prev = lastIdleSol?.byWallet?.[addr];
      if (prev) { byWallet[addr] = { ...prev, name: entry.w.name }; totalUSD += prev.totalUSD || 0; }
      continue;
    }
    const items = [];
    const solAmt = entry.lamports / 1e9;
    const solVal = solAmt * solPrice;
    if (solVal >= 1) items.push({ symbol: 'SOL', address: 'native', amount: solAmt, priceUSD: solPrice, valueUSD: solVal, native: true });
    for (const t of entry.toks) {
      const price = t.mint === WSOL_MINT ? solPrice : (prices[t.mint] || 0);
      const v = t.amount * price;
      if (v < 1) continue;
      items.push({ symbol: symbols[t.mint]?.symbol || t.mint.slice(0, 4) + '…', address: t.mint, amount: t.amount, priceUSD: price, valueUSD: v });
    }
    items.sort((x, y) => y.valueUSD - x.valueUSD);
    const wTotal = items.reduce((s, t) => s + t.valueUSD, 0);
    byWallet[addr] = { name: entry.w.name, totalUSD: wTotal, tokens: items };  // 键=base58 原样地址(大小写敏感)
    totalUSD += wTotal;
  }
  return { totalUSD, byWallet };
}

// ============================================================
// 主拉取（结构对齐 BSC /api/positions）
// ============================================================
let inFlight = null;

async function fetchAllSol(force = false) {
  const fresh = cache.data && Date.now() - cache.timestamp < CACHE_TTL;
  if (!force && fresh) return cache.data;
  // 与 BSC 同架构：有旧数据就先秒回旧数据，后台悄悄刷新（stale-while-revalidate）
  if (!force && cache.data) {
    if (!inFlight) {
      inFlight = _fetchAllSol()
        .catch(e => console.error('[SOL] background refresh failed:', e.message))
        .finally(() => { inFlight = null; });
    }
    return cache.data;
  }
  if (inFlight) return inFlight;
  inFlight = _fetchAllSol().finally(() => { inFlight = null; });
  return inFlight;
}

async function _fetchAllSol() {
  let walletResults = [];
  for (const w of activeWallets()) {
    // 抓取失败(429限流等)时重试最多3轮, 每轮间隔递增, 避免把有仓钱包误判为空仓
    let met = null, ray = null, orc = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        console.log(`[SOL] ${w.name} 第${attempt + 1}次重试 (限流退避 ${attempt * 5}s)...`);
        await new Promise(r => setTimeout(r, attempt * 5000));
      }
      if (attempt === 2 && SOL_RPC_FALLBACK !== SOL_RPC) {
        // 最后一轮切备胎 RPC (主节点持续限流时兜底)
        console.log(`[SOL] ${w.name} 切换备胎 RPC 重试...`);
        conn = new Connection(SOL_RPC_FALLBACK, 'confirmed');
        raydiumInstances = {};   // Raydium 实例绑定旧连接, 必须重建
      }
      if (met === null) met = await fetchMeteoraPositions(w);
      if (ray === null) ray = await fetchRaydiumPositions(w);
      if (orc === null) orc = await fetchOrcaPositions(w);
      if (met !== null && ray !== null && orc !== null) break;
    }
    if (conn.rpcEndpoint !== SOL_RPC) {
      conn = new Connection(SOL_RPC, 'confirmed');   // 用完备胎切回主 RPC
      raydiumInstances = {};
    }
    if (met === null || ray === null || orc === null) console.error(`[SOL] ${w.name} 3轮重试仍失败, 本轮跳过 (下轮自动刷新会再试)`);
    walletResults.push({ address: w.address, name: w.name, positions: [...(met || []), ...(ray || []), ...(orc || [])], totalUSD: 0 });
    // 钱包间歇 1.5s, 防公共 RPC 429 (15+ 钱包连扫会被打限流, 空仓漏报)
    await new Promise(r => setTimeout(r, 1500));
  }
  // 本轮起跑后被停用/删除的钱包不发布 (SOL 一轮约 2 分钟, 期间用户可能点了停用)
  walletResults = walletResults.filter(wr => activeWallets().some(w => w.address === wr.address));

  // 补 symbol（Meteora/Orca 只有 mint 地址）+ 价格
  const allMints = [];
  for (const wr of walletResults) for (const p of wr.positions) allMints.push(p.token0addr, p.token1addr);
  const [symbols, prices] = await Promise.all([getTokenSymbols(allMints), getPrices(allMints)]);

  let grandTotalUSD = 0, totalActive = 0, totalInRange = 0, totalOutOfRange = 0, totalFees = 0, walletsWithActiveLP = 0;

  for (const wr of walletResults) {
    let walletTotal = 0, hasActive = false;
    for (const pos of wr.positions) {
      if (!pos.token0.symbol) pos.token0.symbol = symbols[pos.token0addr]?.symbol || pos.token0addr.slice(0, 4);
      if (!pos.token1.symbol) pos.token1.symbol = symbols[pos.token1addr]?.symbol || pos.token1addr.slice(0, 4);
      const price0 = prices[pos.token0addr] || 0;
      const price1 = prices[pos.token1addr] || 0;
      pos.token0USD = price0;
      pos.token1USD = price1;
      pos.positionValueUSD = pos.amount0 * price0 + pos.amount1 * price1;
      pos.feesValueUSD = pos.feesOwed0 * price0 + pos.feesOwed1 * price1;
      pos.totalValueUSD = pos.positionValueUSD + pos.feesValueUSD;
      // 盈亏字段 (sol-ledger 命中才有): 开仓成本 / 持币对照→无常损失 / 已领费 / 已提回 / 净利润
      {
        const lg = solLedger.positionPnl(wr.address, pos._activityKey || pos.positionKey);
        if (lg) pnlLedger.applyPnl(pos, { cost: lg.cost, approx: lg.approx, source: 'ledger', am: lg.a, withdrawnUSD: lg.ret, collectedUSD: lg.fees > 0 ? lg.fees : undefined, feesUnknown: lg.feesUnknown }, a => prices[a] || 0);
      }

      // === 日化（与 BSC 同口径） ===
      // createdAt = 仓位账户最早签名的 blockTime（Meteora position PDA / Raydium·Orca NFT mint）
      if (pos.liquidityActive && pos.positionValueUSD >= 10) {
        pos.createdAt = await getCreatedAt(pos.positionKey);
        // lastCollectAt = 仓位账户最近一笔操作（领取/加减仓都会产生签名）
        const lastAct = await getLastActivityAt(pos._activityKey || pos.positionKey);
        if (lastAct > pos.createdAt + 60000) pos.lastCollectAt = lastAct; // 距创建>1分钟才视为后续操作
      }
      if (pos.createdAt > 0 && pos.positionValueUSD >= 10) {
        const totalDays = (Date.now() - pos.createdAt) / 86400000;
        if (totalDays > 0) {
          // 1. 累计日化：已领 + 未领（从创建起算）
          const collectedUSD = (pos._claimed0 || 0) * price0 + (pos._claimed1 || 0) * price1;
          const totalFeesUSD = collectedUSD + pos.feesValueUSD;
          if (totalFeesUSD > 0) {
            pos.dailyRateCumulative = (totalFeesUSD / pos.positionValueUSD) / totalDays * 100;
          }
          pos.totalDays = totalDays >= 1 ? Math.floor(totalDays) : 0;
          pos.totalHours = Math.floor(totalDays * 24);
          pos.hasCollected = collectedUSD > 0 || !!pos.lastCollectAt;
          if (!(pos.collectedFeesUSD > 0)) pos.collectedFeesUSD = collectedUSD;   // 账本已给已领费 (按领取时价) 则以账本为准
        }

        // 2. 当前日化：未领手续费 / 本金 / 距上次操作（无操作则距创建）
        const currentStart = pos.lastCollectAt || pos.createdAt;
        const holdMs = Date.now() - currentStart;
        const holdDays = holdMs / 86400000;
        if (holdDays > 0 && pos.feesValueUSD > 0) {
          pos.dailyRateCurrent = (pos.feesValueUSD / pos.positionValueUSD) / holdDays * 100;
          pos.holdDays = holdDays >= 1 ? Math.floor(holdDays) : 0;
          pos.holdHours = Math.floor(holdMs / 3600000);
          pos.holdMinutes = Math.floor((holdMs % 3600000) / 60000);
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

    // 价格方向归一：稳定币在 token0 时翻转为 Token/稳定币
    wr.positions = wr.positions.map(normalizeSolPosition);
    wr.positions.sort((a, b) => {
      if (a.liquidityActive && !b.liquidityActive) return -1;
      if (!a.liquidityActive && b.liquidityActive) return 1;
      return b.totalValueUSD - a.totalValueUSD;
    });
  }

  const wallets = walletResults.filter(wr => wr.positions.length > 0);
  wallets.sort((a, b) => {
    const nA = parseInt((a.name.match(/\d+/) || ['0'])[0]);
    const nB = parseInt((b.name.match(/\d+/) || ['0'])[0]);
    return nA - nB;
  });

  // 钱包闲置余额: 按 fund-config 启用/勾选过滤; 失败沿用上轮快照, 不拖累主数据
  const fundSel = fundWalletsSol();
  let idle = null;
  if (fundSel.length) {
    const prev = lastIdleSol || cache.data?.idle || null;
    if (prev && prev.byWallet) {
      // 兜底快照按当前勾选过滤
      const allow = new Set(fundSel.map(w => w.address));
      const byWallet = {}; let t = 0;
      for (const [a, w] of Object.entries(prev.byWallet)) { if (allow.has(a)) { byWallet[a] = w; t += w.totalUSD || 0; } }
      idle = { totalUSD: t, byWallet };
    }
    try {
      idle = await fetchIdleSol(fundSel);
      lastIdleSol = idle;
    } catch (e) { console.error('[SOL] idle balances failed:', e.message?.slice(0, 100)); }
  }

  const result = {
    wallets,
    grandTotalUSD,
    idle,
    timestamp: Date.now(),
    chain: 'sol',
    stats: { totalActive, totalInRange, totalOutOfRange, totalFees, walletsWithActiveLP, totalWallets: activeWallets().length },
  };
  lastPricesSol = prices;
  cache = { data: result, timestamp: Date.now() };
  saveCache();
  console.log(`[SOL] Fetch complete. ${wallets.length} wallets, ${totalActive} active, total $${grandTotalUSD.toFixed(2)}`);
  return result;
}

function normalizeSolPosition(pos) {
  if (STABLE_MINTS.has(pos.token0addr)) {
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

// ============================================================
// Express 路由挂载
// ============================================================
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
// 停用钱包: 就地剔出缓存 (合计/统计/闲置余额一起重算) + 释放 Raydium 实例, 零 RPC 立即生效
function dropSolWalletFromCache(addr) {
  const fixIdle = (idle) => {
    if (!idle || !idle.byWallet || !idle.byWallet[addr]) return;
    delete idle.byWallet[addr];
    idle.totalUSD = Object.values(idle.byWallet).reduce((s, w) => s + (w.totalUSD || 0), 0);
  };
  if (cache.data) {
    const d = cache.data;
    d.wallets = (d.wallets || []).filter(w => w.address !== addr);
    const sm = summarizeWallets(d.wallets);
    d.grandTotalUSD = sm.grandTotalUSD;
    d.stats = { ...(d.stats || {}), ...sm, totalWallets: activeWallets().length };
    fixIdle(d.idle);
    saveCache();
  }
  fixIdle(lastIdleSol);
  delete raydiumInstances[addr];
}

function mountSolRoutes(app, adminGuard) {
  // 钱包盈亏 (SOL): 无成本/无常损失来源 (仓位账户不存入金历史, 钱包换币史需逐笔解析交易), 只给活跃仓现值/手续费; 历史仓位不可用
  app.get('/api/sol/pnl', (req, res) => {
    const addr = String(req.query.wallet || '').trim();
    if (!addr) return res.status(400).json({ error: '缺少 wallet' });
    const data = cache.data;
    const lw = (data?.wallets || []).find(w => w.address === addr) || null;
    const wc = WALLETS.find(w => w.address === addr) || null;
    const rep = solLedger.walletReport(addr, lw);
    if (req.query.refresh === 'true' && solLedger.enabled()) setImmediate(() => kickSolLedger());
    let idleUSD = null;
    for (const [a, wI] of Object.entries(data?.idle?.byWallet || {})) if (a === addr) idleUSD = wI.totalUSD || 0;
    res.json({ chain: 'sol', wallet: { address: addr, name: wc?.name || lw?.name || addr, enabled: wc ? wc.enabled !== false : true }, ...rep, idleUSD, lpUSD: lw ? (lw.totalUSD || 0) : 0, funding: null, dataTs: data?.timestamp || 0,
      selected: solPnlWallets().some(w => w.address === addr), ledgerEnabled: solLedger.enabled() && loadPnlCfgSol().enabled });
  });
  app.get('/api/sol/positions', async (req, res) => {
    try {
      res.json(await fetchAllSol(req.query.refresh === 'true'));
    } catch (e) {
      console.error('[SOL] API error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/sol/wallets', (req, res) => res.json(WALLETS));

  app.post('/api/sol/wallets', adminGuard, (req, res) => {
    const { address, name } = req.body;
    if (!address || !name) return res.status(400).json({ error: '需要 address 和 name' });
    const addr = address.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return res.status(400).json({ error: '无效的 Solana 地址' });
    try { new PublicKey(addr); } catch { return res.status(400).json({ error: '无效的 Solana 地址' }); }
    if (WALLETS.some(w => w.address === addr)) return res.status(409).json({ error: '地址已存在' });
    if (WALLETS.length >= 30) return res.status(400).json({ error: '最多支持 30 个地址' });
    WALLETS.push({ address: addr, name: name.trim() });
    saveWallets(WALLETS);
    cache = { data: null, timestamp: 0 };
    console.log(`[SOL] Wallet added: ${name.trim()} (${addr})`);
    res.json({ ok: true, wallets: WALLETS });
  });

  app.delete('/api/sol/wallets/:address', adminGuard, (req, res) => {
    const idx = WALLETS.findIndex(w => w.address === req.params.address);
    if (idx === -1) return res.status(404).json({ error: '地址不存在' });
    const removed = WALLETS.splice(idx, 1)[0];
    saveWallets(WALLETS);
    cache = { data: null, timestamp: 0 };
    console.log(`[SOL] Wallet removed: ${removed.name}`);
    res.json({ ok: true, wallets: WALLETS });
  });

  // 编辑钱包: 改名和/或换地址。换地址等同删旧+加新, 沿用 SOL 增删的清缓存语义
  app.patch('/api/sol/wallets/:address', adminGuard, (req, res) => {
    const idx = WALLETS.findIndex(w => w.address === req.params.address);
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
      newAddr = String(address).trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(newAddr)) return res.status(400).json({ error: '无效的 Solana 地址' });
      try { new PublicKey(newAddr); } catch { return res.status(400).json({ error: '无效的 Solana 地址' }); }
      if (newAddr !== WALLETS[idx].address && WALLETS.some((w, i) => i !== idx && w.address === newAddr)) return res.status(409).json({ error: '地址已存在' });
    }
    if (newName === undefined && newAddr === undefined && newEnabled === undefined) return res.status(400).json({ error: '需要 name / address / enabled' });
    const old = { ...WALLETS[idx] };
    const addrChanged = newAddr !== undefined && newAddr !== old.address;
    const enabledChanged = newEnabled !== undefined && newEnabled !== isWalletOn(old);
    if (newName !== undefined) WALLETS[idx].name = newName;
    if (newAddr !== undefined) WALLETS[idx].address = newAddr;
    if (newEnabled !== undefined) { if (newEnabled) delete WALLETS[idx].enabled; else WALLETS[idx].enabled = false; }
    saveWallets(WALLETS);
    if (addrChanged) {
      cache = { data: null, timestamp: 0 };
      delete raydiumInstances[old.address];
    } else if (enabledChanged) {
      if (newEnabled) kickSolRefresh();                 // 重新启用: 后台补一轮带回来 (不清老数据)
      else dropSolWalletFromCache(old.address);         // 停用: 就地剔出缓存, 零 RPC
    } else if (cache.data) {
      // 只改名: 缓存里就地改显示名, 不触发重拉
      for (const w of (cache.data.wallets || [])) if (w.address === old.address) w.name = WALLETS[idx].name;
      saveCache();
    }
    console.log(`[SOL] Wallet updated: ${old.name} (${old.address}) -> ${WALLETS[idx].name} (${WALLETS[idx].address})${enabledChanged ? (newEnabled ? ' [启用]' : ' [停用]') : ''}`);
    res.json({ ok: true, wallets: WALLETS });
  });
}

// 后台踢一轮刷新 (fund 配置变更时由 server.js 调用, 不阻塞不清缓存)
function kickSolRefresh() {
  if (inFlight) return;
  inFlight = _fetchAllSol()
    .catch(e => console.error('[SOL] kick refresh failed:', e.message))
    .finally(() => { inFlight = null; });
}

// --- Solana 钱包盈亏账本: 只扫设置页「钱包盈亏」勾选的钱包 (未单独勾选沿用「钱包资金查询」的勾选); 启动 190s 后首跑, 之后每 30min ---
function readCfg(file) { try { const c = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')); return { enabled: c.enabled !== false, wallets: (c.wallets && typeof c.wallets === 'object') ? c.wallets : {} }; } catch { return { enabled: true, wallets: {} }; } }
function loadPnlCfgSol() { return readCfg('pnl-config.json'); }
function solPnlWallets() {
  const pc = loadPnlCfgSol(); if (!pc.enabled) return [];
  const on = WALLETS.filter(w => w.enabled !== false);
  const arr = Array.isArray(pc.wallets.sol) ? pc.wallets.sol : (Array.isArray(readCfg('fund-config.json').wallets.sol) ? readCfg('fund-config.json').wallets.sol : null);
  if (!arr) return on;
  const s = new Set(arr.map(String)); return on.filter(w => s.has(w.address));
}
solLedger.init({
  prices: () => lastPricesSol,
  symbols: () => { const o = {}; for (const [m, sym] of Object.entries(KNOWN_TOKENS)) o[m] = { symbol: sym }; for (const [m, v] of Object.entries(tokenMeta)) if (v && v.symbol) o[m] = v; return o; },
  wallets: solPnlWallets,
  log: console.log,
});
function liveByWalletSol() { const m = {}; for (const w of (cache.data?.wallets || [])) m[w.address] = (w.positions || []).filter(p => p.liquidityActive); return m; }
function kickSolLedger() { if (!solLedger.enabled()) return; solLedger.runQueue(liveByWalletSol()).catch(e => console.error('[SOL] pnl-ledger:', e.message)); }
if (solLedger.enabled()) {
  setTimeout(kickSolLedger, 190 * 1000);
  setInterval(kickSolLedger, solLedger.ROUND_MS);
  console.log('[SOL] pnl-ledger 就绪 (Helius)');
} else console.log('[SOL] pnl-ledger 停用 (未配置 HELIUS_KEY)');

module.exports = { mountSolRoutes, kickSolRefresh, kickSolLedger };

// --- 服务端定时自动刷新（与 BSC 同架构，不依赖前端触发）---
setInterval(() => {
  if (inFlight) { console.log('[SOL][auto] skip: fetch in flight'); return; }
  console.log('[SOL][auto] scheduled refresh starting...');
  inFlight = _fetchAllSol()
    .then(() => console.log('[SOL][auto] scheduled refresh done'))
    .catch(e => console.error('[SOL][auto] scheduled refresh failed:', e.message))
    .finally(() => { inFlight = null; });
}, CACHE_TTL);

// 启动预热: pm2 重启定时器归零, 缓存陈旧就立即补一轮 (错开 BSC 25s 启动)
setTimeout(() => {
  if (inFlight) return;
  if (cache.data && Date.now() - cache.timestamp < CACHE_TTL / 2) { console.log('[SOL][auto] 预热跳过: 缓存还新鲜'); return; }
  console.log('[SOL][auto] 启动预热刷新 (缓存已陈旧)...');
  inFlight = _fetchAllSol()
    .then(() => console.log('[SOL][auto] 预热刷新完成'))
    .catch(e => console.error('[SOL][auto] 预热刷新失败:', e.message))
    .finally(() => { inFlight = null; });
}, 25 * 1000);
