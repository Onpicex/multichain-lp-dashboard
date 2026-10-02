// =============================================================
// sol-ledger.js — Solana 钱包盈亏账本 (数据源 Helius Enhanced Transactions, 需 .env HELIUS_KEY)
//
// 与 EVM 的 pnl-ledger.js 同一套思路, 换数据源与解析层:
//   - Helius /v0/addresses/<wallet>/transactions 一次拉回解析好的交易: 钱包各 token 余额变动 (accountData.tokenBalanceChanges)、
//     原生 SOL 变动、涉及的程序与账户列表 (instructions[].programId/accounts/data)、swap 事件
//   - 仓位识别: 三家协议的开仓指令 (Anchor 8 字节 discriminator = sha256("global:<name>")[0..8]):
//       Meteora DLMM initializePosition / initializePosition2: position = accounts[1]; initializePositionPda / initializePositionByOperator: accounts = [payer, base, position, ...] → accounts[2] (2026-09-28 审计修复)
//       Raydium CLMM openPosition*: personalPosition PDA = ["position", nftMint(accounts[2])]
//       Orca Whirlpool openPosition*: position PDA = ["position", positionMint(accounts[3])] (= accounts[2])
//     之后 加/减/领费/关仓 指令的账户列表里含该 position 即归属该仓
//   - 成本: 钱包换币 (SWAP) 建立加权平均成本批次; 开仓/加仓 tx 的净流出按成本扣 (稳定币=面值)
//   - 提回/手续费: 减仓/领费 tx 的净流入; 非稳定币按「时间最近的价格观测 (±3 天)」折算, 再不行按现价 (approx)
//     (2026-09-28 审计修复: 同 tx 的观测优先; 观测离交易 > 6h 也标 approx)
//     价格观测三来源 (同时刻按优先级): ① 本钱包双边存/取 + 仓位 tick 区间反推的池价 (Orca/Raydium, 精确中间价)
//     ② 本钱包换币腿成交价 (含池费, 覆盖 zap 里的换币和 Meteora) ③ 纯换币 tx 的钱包净流向隐含价
//     解析层把每条 LP 指令自己的 SPL 转账挂在指令下 (xf), zap tx 里才能把换币腿和入金腿分开; 开仓指令解出 tick 区间 (tk)
//   - zap 找零 (入金 tx 顺带的稳定币流入) 从成本、持币基线、按币拆分三处一起扣, 否则 IL 会虚报找零那么多
//     Raydium 的 decreaseLiquidity 把手续费和本金一起转出, 无法拆分 → 全计提回, feesUnknown
//     (2026-09-28 审计修复) Orca collectFees*/collectReward*、Meteora claimFee*/claimReward* 指令名下的 xf 就是手续费/奖励 → 平仓 tx 里直接计 fees, 其余流入计提回
//   - 同 tx 多仓: 按每条 LP 指令自己的 xf 归属流水, xf 解释不了的剩余才均分 (2026-09-28 审计修复, 旧版整 tx 1/N 均分)
//   - 无常损失/净利润的现价来自 sol-adapter 每轮定价 (注入时给)
// 结果持久化 pnl-ledger-sol.json; 只扫设置页勾选的钱包 (未单独勾选沿用「钱包资金查询」的勾选)
// =============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PublicKey } = require('@solana/web3.js');

const PROGS = {
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
};
const PROTO = { Meteora: 'DLMM', Raydium: 'CLMM', Orca: 'Whirlpool' };
const SPL_PROGS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const EVENT_CPI = 'e445a52e51cb9a1d';   // Anchor emit_cpi 自调用指令的 8 字节前缀 (Meteora 用), 不是操作也不切转账分组
const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
const FILE = path.join(__dirname, 'pnl-ledger-sol.json');
const RAW_LIMIT = 4000;              // 交易数上限, 超过=高频钱包放弃
const ROUND_MS = 30 * 60 * 1000;
const PARSE_V = 4;                   // 2026-09-30: 解析层版本; IX 表补了名字就 +1, 下轮扫描把落盘记录里没命名的 LP 指令重解析 (有 d 就本地查表, 没有 d 的旧记录按签名重拉)
                                     // v3 (2026-10-02): 记录加 to/from (托管挂单的成本接力), 旧记录里可能带这两项的按签名重拉一次
                                     // v4 (2026-10-02): to/from 补原生 SOL 挂单 (进出托管名下 WSOL 账户), 有原生 SOL 单向进出的旧记录重拉一次
const SOL_NOISE = 0.15;              // LP 操作 tx 里 |ΔSOL| 小于此 = 租金/手续费噪声, 不计流水 (SOL 不是池子币时)
                                     // 2026-09-28 审计修复: 只在该 tx 的 LP 指令 xf 里不含 WSOL 时才按它过滤; xf 有 WSOL = SOL 是真实资金腿, 小额也计
const APPROX_OBS_MS = 6 * 3600 * 1000;   // 2026-09-28 审计修复: 价格观测离交易时刻超过 6h 即标 approx (旧版 ±3 天内都当精确价)
const METEORA_POS_AT2 = new Set(['initializePositionPda', 'initializePositionByOperator']);   // 2026-09-28 审计修复: 这两个开仓指令账户序 [payer, base, position, ...], position 在 a[2]

// 指令名 → 操作类型 (dep 入金 / wd 减仓 / col 领费 / close 关仓 / open 开仓)
const IX = {
  Meteora: { initializePosition: 'open', initializePositionPda: 'open', initializePositionByOperator: 'open', initializePosition2: 'open',
    addLiquidity: 'dep', addLiquidityByWeight: 'dep', addLiquidityByStrategy: 'dep', addLiquidityByStrategyOneSide: 'dep', addLiquidityOneSide: 'dep', addLiquidityOneSidePrecise: 'dep', addLiquidity2: 'dep', addLiquidityByStrategy2: 'dep', addLiquidityOneSidePrecise2: 'dep',
    removeLiquidity: 'wd', removeLiquidityByRange: 'wd', removeAllLiquidity: 'wd', removeLiquidity2: 'wd', removeLiquidityByRange2: 'wd',
    claimFee: 'col', claimFee2: 'col', claimReward: 'col', claimReward2: 'col', closePosition: 'close', closePosition2: 'close', closePositionIfEmpty: 'close',
    rebalanceLiquidity: 'flow',   // 一条指令里既可加也可减, 按本 tx 净流向判
    swap: 'swap', swap2: 'swap', swapExactOut: 'swap', swapExactOut2: 'swap', swapWithPriceImpact: 'swap', swapWithPriceImpact2: 'swap' },
  Raydium: { openPosition: 'open', openPositionV2: 'open', openPositionWithToken22Nft: 'open', increaseLiquidity: 'dep', increaseLiquidityV2: 'dep',
    decreaseLiquidity: 'wd', decreaseLiquidityV2: 'wd', closePosition: 'close', collectRemainingRewards: 'col',
    swap: 'swap', swapV2: 'swap', swapRouterBaseIn: 'swap' },
  Orca: { openPosition: 'open', openPositionWithMetadata: 'open', openPositionWithTokenExtensions: 'open', increaseLiquidity: 'dep', increaseLiquidityV2: 'dep',
    decreaseLiquidity: 'wd', decreaseLiquidityV2: 'wd', collectFees: 'col', collectFeesV2: 'col', collectReward: 'col', collectRewardV2: 'col', closePosition: 'close', closePositionWithTokenExtensions: 'close',
    updateFeesAndRewards: 'aux',   // 辅助指令, 不代表操作
    // 2026-09-30 修: Orca 新版 UI (whirlpool IDL 0.9.0) 的加仓走 increase_liquidity_by_token_amounts_v2 (disc effb097c…), 之前没命名被当 flow 判,
    //   zap 加仓找零回钱包时按 dep+wd 记, 把 $2.7 找零算成「已提回」且没冲减成本 (DJT/USDC 加仓实例); reposition_liquidity_v2 (bfa9e00b…) 一条指令换区间, 按净流向判
    increaseLiquidityByTokenAmountsV2: 'dep', repositionLiquidityV2: 'flow',
    swap: 'swap', swapV2: 'swap', twoHopSwap: 'swap', twoHopSwapV2: 'swap' },
};
// 开仓指令参数里 tick_lower/tick_upper (i32×2) 的字节偏移 (8 字节 discriminator 之后; Orca 旧版前面还有 bumps)
// Meteora DLMM 的 initializePosition 给的是 bin 不是 tick, 且双边数量比与价格没有闭式关系, 不解
const TICK_OFF = { 'Orca:openPosition': 9, 'Orca:openPositionWithMetadata': 10, 'Orca:openPositionWithTokenExtensions': 8,
  'Raydium:openPosition': 8, 'Raydium:openPositionV2': 8, 'Raydium:openPositionWithToken22Nft': 8 };
function ticksOf(prog, name, buf) {
  const off = TICK_OFF[`${prog}:${name}`];
  if (off == null || !buf || buf.length < off + 8) return null;
  const lo = buf.readInt32LE(off), hi = buf.readInt32LE(off + 4);
  return lo < hi && Math.abs(lo) < 1e6 && Math.abs(hi) < 1e6 ? [lo, hi] : null;
}
// 没对上名字但账户里含已知仓位的指令一律按本 tx 净流向判 (flow); 有 IDL 的程序 (Orca/Meteora 链上 anchor:idl 账户, Raydium CLMM 没有) 尽量把名字补进 IX, 否则找零会被记成提回
// Anchor discriminator 用的是 Rust 侧 snake_case 函数名: sha256("global:add_liquidity_by_strategy")[0..8]
const snake = n => n.replace(/([A-Z])/g, '_$1').toLowerCase();
const DISC = {};   // `${prog}:${hex8}` -> camelCase name
for (const [prog, names] of Object.entries(IX)) for (const n of Object.keys(names)) DISC[`${prog}:${crypto.createHash('sha256').update(`global:${snake(n)}`).digest('hex').slice(0, 16)}`] = n;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  const bytes = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch); if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== '1') break; bytes.push(0); }
  return Buffer.from(bytes.reverse());
}
function pda(seedStr, mint, prog) {
  try { return PublicKey.findProgramAddressSync([Buffer.from(seedStr), new PublicKey(mint).toBuffer()], new PublicKey(prog))[0].toBase58(); } catch { return null; }
}
const PROG_ID = Object.fromEntries(Object.entries(PROGS).map(([k, v]) => [v, k]));

let deps = { prices: () => ({}), symbols: () => ({}), wallets: () => [], log: console.log, histSol: null };   // histSol(tsMs) → SOL 当时美元价 (0 = 没取到)
function init(d) { deps = { ...deps, ...d }; }
function key() { return (process.env.HELIUS_KEY || '').trim(); }
function enabled() { return !!key(); }

let st = null;
function state() {
  if (!st) {
    let d = null; try { d = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
    if (d && d.v === 1) d = { v: 2, wallets: {}, tok: d.tok || {} };   // v2: 解析层新增 xf/tk 字段, 旧缓存没有 → 清掉重扫 (每钱包一两页 Helius, 便宜)
    if (!d || d.v !== 2) d = { v: 2, wallets: {}, tok: {} };
    st = { d, busy: false, lastRun: 0 };
  }
  return st;
}
function save() { try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state().d)); fs.renameSync(tmp, FILE); } catch (e) { console.error('[SOL] pnl-ledger 落盘失败:', e.message?.slice(0, 80)); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Helius 拉取 (增量: 新的在前, 碰到已知签名即停; 首扫翻到底) ----
async function heliusPage(wallet, before) {
  const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${key()}&limit=100${before ? '&before=' + before : ''}`;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) { await sleep(2000 * (i + 1)); continue; }
      const j = await r.json();
      if (Array.isArray(j)) return j;
      await sleep(2000);
    } catch { await sleep(2000 * (i + 1)); }
  }
  return null;
}
function parseTx(wallet, t) {
  const fl = {};
  for (const a of (t.accountData || [])) for (const c of (a.tokenBalanceChanges || [])) {
    if (c.userAccount !== wallet || !c.mint) continue;
    const raw = c.rawTokenAmount || {};
    fl[c.mint] = (fl[c.mint] || 0) + Number(raw.tokenAmount || 0) / 10 ** Number(raw.decimals || 0);
    if (raw.decimals != null) state().d.tok[c.mint] = state().d.tok[c.mint] || { decimals: Number(raw.decimals) };
  }
  const me = (t.accountData || []).find(a => a.account === wallet);
  let sol = me ? Number(me.nativeBalanceChange || 0) / 1e9 : 0;
  if (t.feePayer === wallet) sol += Number(t.fee || 0) / 1e9;   // 把手续费加回, 只留真正的转账/租金
  // token 账户 → 持有人/mint/精度 (余额变动 + 转账列表都看: 中间跳的账户净变动为 0 时只出现在 tokenTransfers)
  const tokAcc = {};
  for (const a of (t.accountData || [])) for (const c of (a.tokenBalanceChanges || [])) if (c.tokenAccount) tokAcc[c.tokenAccount] = { owner: c.userAccount, mint: c.mint, dec: c.rawTokenAmount && c.rawTokenAmount.decimals != null ? Number(c.rawTokenAmount.decimals) : null };
  for (const x of (t.tokenTransfers || [])) {
    if (x.fromTokenAccount && !tokAcc[x.fromTokenAccount]) tokAcc[x.fromTokenAccount] = { owner: x.fromUserAccount, mint: x.mint, dec: null };
    if (x.toTokenAccount && !tokAcc[x.toTokenAccount]) tokAcc[x.toTokenAccount] = { owner: x.toUserAccount, mint: x.mint, dec: null };
  }
  // SPL 转账 (Token / Token-2022: transfer=3, transferChecked=12) → 钱包视角 [mint, ±人类数量]; 与钱包无关或自转返回 null
  const xferOf = ix => {
    if (!SPL_PROGS.has(ix.programId)) return null;
    const b = b58decode(String(ix.data || '')), acc = ix.accounts || [];
    if (!b || !b.length) return null;
    let src, dst, auth, mint, dec;
    if (b[0] === 12 && b.length >= 10 && acc.length >= 4) { src = acc[0]; mint = acc[1]; dst = acc[2]; auth = acc[3]; dec = b[9]; }
    else if (b[0] === 3 && b.length >= 9 && acc.length >= 3) {
      src = acc[0]; dst = acc[1]; auth = acc[2];
      const ta = tokAcc[src] || tokAcc[dst]; if (!ta || !ta.mint) return null;
      mint = ta.mint; dec = ta.dec != null ? ta.dec : (state().d.tok[mint] && state().d.tok[mint].decimals != null ? state().d.tok[mint].decimals : null);
    } else return null;
    if (!mint || dec == null) return null;
    if (b[0] === 12) state().d.tok[mint] = state().d.tok[mint] || { decimals: dec };
    const amt = Number(b.readBigUInt64LE(1)) / 10 ** dec;
    if (!(amt > 0)) return null;
    const out = (tokAcc[src] && tokAcc[src].owner === wallet) || auth === wallet, inn = !!(tokAcc[dst] && tokAcc[dst].owner === wallet);
    return out && !inn ? [mint, -amt] : (inn && !out ? [mint, amt] : null);
  };
  // LP 程序指令列表; 每条指令名下挂它自己的 SPL 转账 (xf): 内层指令是平铺的, 一条 LP 指令之后、下一条 LP 指令之前的转账归它
  // (zap tx = 换币 + 开仓 + 入金三条指令, 靠这个把换币腿和入金腿分开; Anchor 事件 CPI 自调用不切组)
  const lp = [];
  let cur = null;
  const walk = (ix, top) => {
    const prog = PROGS[ix.programId];
    if (prog) {
      const buf = b58decode(String(ix.data || '')) || Buffer.alloc(0);
      const hex8 = buf.subarray(0, 8).toString('hex');
      if (hex8 !== EVENT_CPI) {
        const name = buf.length >= 8 ? DISC[`${prog}:${hex8}`] || null : null;
        cur = { p: prog, n: name, d: hex8, acc: ix.accounts || [] };   // d: 2026-09-30 起把 discriminator 也存下, IX 表后补名字时本地重解析即可 (reparseUnnamed)
        const tk = name && IX[prog][name] === 'open' ? ticksOf(prog, name, buf) : null;
        if (tk) cur.tk = tk;
        lp.push(cur);
      }
    } else if (top) cur = null;
    else { const x = xferOf(ix); if (x && cur) (cur.xf = cur.xf || []).push(x); }
    for (const inner of (ix.innerInstructions || [])) walk(inner, false);
  };
  for (const ix of (t.instructions || [])) walk(ix, true);
  const rec = { slot: t.slot, ts: Number(t.timestamp || 0) * 1000, type: t.type, src: t.source, fl, sol: +sol.toFixed(9) };
  if (lp.length) rec.lp = lp;
  // 2026-10-02 托管挂单 (Jupiter 限价单): 下单 = 本钱包把币转给托管地址 (无 LP 指令); 成交 = 托管里的币换成别的币打进本钱包, 撤单 = 原币退回,
  //   这两种 tx 里本钱包只有流入. 记下 to (无 LP 指令、只有流出的 tx 里本钱包转给谁多少) 和 from (只有流入的 tx 里别人付出多少), 回放时按地址接力成本
  //   (只有流出才记 to: 走非 LP 程序的换币 tx 里本钱包也有转给池子的腿, 那不是托管)
  const xs = (t.tokenTransfers || []).filter(x => x.mint && Number(x.tokenAmount) > 0);
  const sum = (o, a, m, q) => { const e = o[a] || (o[a] = {}); e[m] = +((e[m] || 0) + q).toFixed(12); };
  const to = {}, from = {};
  //   (v4) 原生 SOL 下的单: 本钱包把 SOL 系统转账进托管名下新建的 WSOL 账户, 撤单时托管关掉该账户、SOL 以原生退回 —— 两头都不在
  //   tokenTransfers 里, 只能看别人名下 WSOL 账户的余额变动 (他人真实样本 9 笔原生 SOL 挂单: 成交 3 / 撤单退回 6)
  const wsolAt = {};   // 别人名下的 WSOL 代币账户 → { u: 持有人, d: 本 tx 余额变动 }
  for (const a of (t.accountData || [])) for (const c of (a.tokenBalanceChanges || [])) {
    if (c.mint !== WSOL || !c.tokenAccount || !c.userAccount || c.userAccount === wallet) continue;
    const raw = c.rawTokenAmount || {}, e = wsolAt[c.tokenAccount] || (wsolAt[c.tokenAccount] = { u: c.userAccount, d: 0 });
    e.d += Number(raw.tokenAmount || 0) / 10 ** Number(raw.decimals != null ? raw.decimals : 9);
  }
  if (!lp.length && !xs.some(x => x.toUserAccount === wallet)) {
    for (const x of xs) if (x.fromUserAccount === wallet && x.toUserAccount && x.toUserAccount !== wallet) sum(to, x.toUserAccount, x.mint, Number(x.tokenAmount));
    //   原生 SOL 下单: 本钱包系统转账进别人名下的 WSOL 账户、该账户余额同时增加 → 记给账户持有人 (取两者较小: 建账户的租金不算)
    const sent = {};
    for (const n of (t.nativeTransfers || [])) if (n.fromUserAccount === wallet && wsolAt[n.toUserAccount]) sent[n.toUserAccount] = (sent[n.toUserAccount] || 0) + Number(n.amount || 0) / 1e9;
    for (const [acc, q] of Object.entries(sent)) if (wsolAt[acc].d > 0) sum(to, wsolAt[acc].u, WSOL, Math.min(q, wsolAt[acc].d));
  }
  //   from 记净付出 (转出 − 转入): 托管同时是成交路由的中转站 —— 卖单成交时 USDC 先进托管再转给本钱包, 换路时 USDT/中间币也在托管里过一手,
  //   按转出总额算会把过路的币当成付出, 占掉别的挂单存着的币 (他人真实 366 笔托管 tx 实测)
  if (!xs.some(x => x.fromUserAccount === wallet) && (xs.some(x => x.toUserAccount === wallet) || sol > 0)) {
    const net = {}, gross = {};
    for (const x of xs) {
      const q = Number(x.tokenAmount);
      if (x.fromUserAccount && x.fromUserAccount !== wallet) { sum(net, x.fromUserAccount, x.mint, q); sum(gross, x.fromUserAccount, x.mint, q); }
      if (x.toUserAccount && x.toUserAccount !== wallet) sum(net, x.toUserAccount, x.mint, -q);
    }
    for (const [a, ms] of Object.entries(gross)) for (const [m, g] of Object.entries(ms)) if (net[a][m] > g * 1e-9) sum(from, a, m, net[a][m]);
    //   (v4) 原生 SOL 退回: 别人名下 WSOL 余额减少、又不是作为代币转走的部分 = 关账户解包成了原生 SOL; 本钱包这笔收到原生 SOL 才记, 以收到的为上限
    //   (撤单 tx 里托管先把 WSOL 转进自己的临时账户再解包, 代币转账一进一出净额为 0, 所以看余额)
    if (sol > 0) {
      const unw = {};
      for (const e of Object.values(wsolAt)) if (e.d < 0) unw[e.u] = (unw[e.u] || 0) - e.d;
      let left = sol;
      for (const [u, q] of Object.entries(unw)) {
        const x = Math.min(q - Math.max(0, (net[u] && net[u][WSOL]) || 0), left);
        if (x > 1e-9) { sum(from, u, WSOL, x); left -= x; }
      }
    }
  }
  if (Object.keys(to).length) rec.to = to;
  if (Object.keys(from).length) rec.from = from;
  const sw = t.events && t.events.swap;
  if (sw && (sw.tokenInputs?.length || sw.tokenOutputs?.length || sw.nativeInput || sw.nativeOutput)) rec.swap = 1;
  return rec;
}
async function scanWallet(wallet, deadline) {
  const s = state();
  const W = s.d.wallets[wallet] || (s.d.wallets[wallet] = { txs: {}, pos: {}, done: false, oldest: null, partial: false, updatedAt: 0 });
  if (W.partial) return W;
  let before = null, added = 0, pages = 0;
  // 首扫: 从最新翻到底 (done=false 时从 oldest 继续); 增量: 从最新翻到碰见已知签名
  // 2026-09-28 审计修复: 增量扫描被预算/RPC/翻页上限打断时, 把当前分页游标落盘 W.resume; 下轮先从 resume 续扫到碰见已知签名 (补缺口),
  //   再从最新往下; 从最新往下只有「整页全部已知」才算追平. 旧版中断后下轮从最新起步, 碰到上轮刚扫的签名就停 → 中间一段永久缺口
  let mode = !W.done ? 'first' : (W.resume ? 'resume' : 'top');
  if (mode === 'first' && W.oldest) before = W.oldest;
  else if (mode === 'resume') before = W.resume;
  const halt = (why) => { if (mode !== 'first' && before) W.resume = before; W.stopped = why; save(); return W; };   // 首扫的断点是 W.oldest, 不用 resume
  while (true) {
    if (Date.now() > deadline) return halt('budget');
    const page = await heliusPage(wallet, before);
    if (!page) return halt('rpc');
    if (page.length === 0) {
      if (mode === 'resume') { delete W.resume; mode = 'top'; before = null; continue; }   // 续扫翻到底 = 缺口补完
      if (mode === 'first') W.done = true;
      break;
    }
    let known = 0, fresh = 0;
    for (const t of page) {
      if (!t.signature) continue;
      if (t.transactionError) continue;   // 失败 tx 不入库, 也不参与「整页已知」判定
      if (W.txs[t.signature]) { known++; continue; }
      W.txs[t.signature] = parseTx(wallet, t); added++; fresh++;
    }
    before = page[page.length - 1].signature;
    if (!W.oldest || (W.txs[before] && W.txs[before].ts <= (W.txs[W.oldest]?.ts ?? Infinity))) W.oldest = before;
    pages++;
    if (Object.keys(W.txs).length > RAW_LIMIT) { W.partial = true; W.txs = {}; W.pos = {}; delete W.resume; save(); return W; }
    if (mode === 'first') { if (page.length < 100) { W.done = true; break; } }
    else if (mode === 'resume') {
      if (known > 0 || page.length < 100) { delete W.resume; mode = 'top'; before = null; }   // 续到已知区 (或到底) = 缺口补完, 转去从最新往下
      else W.resume = before;
    } else if ((known > 0 && fresh === 0) || page.length < 100) break;   // 整页全部已知 (或到底) = 追平
    if (pages > 60) { if (mode === 'first') break; return halt('pages'); }   // 首扫维持原行为 (下轮从 oldest 续); 增量记 resume
    await sleep(150);
  }
  W.stopped = null; W.updatedAt = Date.now();
  save();
  return W;
}

// ---- 代币账户补扫 (2026-10-02) ----
// 转进「已经存在的代币账户」的 SPL 转账, 交易账户列表里只有代币账户、没有钱包主地址 → 按主地址拉的历史 (heliusPage) 拉不到,
//   账本和充提记录都漏 (实例: 三笔 USDC 充值全漏, 盈亏虚高同额). 主扫描追平后补扫:
//   列出钱包现有代币账户 (Token + Token-2022) → 每个账户 RPC getSignaturesForAddress (游标 W.ta[账户] = 已处理到的最新签名, 首扫翻到底)
//   → 账本里没有的签名按签名从 Helius 取解析 (POST /v0/transactions) 入库, 解析同 parseTx (tokenBalanceChanges 的 userAccount 仍是钱包)
//   只收「主扫描起步前 60 秒」之前的签名, 更新的留给下轮 —— 主扫描先走, 免得它把补进来的较新签名当「已知」提前判追平
//   已关闭的代币账户列不出来: 转进来后又转走并关户的那段历史仍会漏
const TOKEN_PROGS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
async function heliusRpc(method, params) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) { await sleep(1500 * (i + 1)); continue; }
      const j = await r.json();
      if (j && !j.error) return j.result;
      await sleep(1500 * (i + 1));
    } catch { await sleep(1500 * (i + 1)); }
  }
  return undefined;
}
async function heliusTxs(sigs) {
  for (let k = 0; k < 4; k++) {
    try {
      const r = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions: sigs }), signal: AbortSignal.timeout(60000) });
      if (r.ok) { const j = await r.json(); if (Array.isArray(j)) return j; }
      await sleep(2000 * (k + 1));
    } catch { await sleep(2000 * (k + 1)); }
  }
  return null;
}
async function scanTokenAccounts(wallet, deadline, scanStart) {
  const W = state().d.wallets[wallet]; if (!W || W.partial || !W.done) return;
  const cutoff = Math.floor(scanStart / 1000) - 60;
  const accs = [];
  for (const prog of TOKEN_PROGS) {
    const res = await heliusRpc('getTokenAccountsByOwner', [wallet, { programId: prog }, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    if (res === undefined) { deps.log(`[SOL] pnl-ledger 代币账户补扫 ${wallet.slice(0, 6)}: 列代币账户失败, 下轮续`); return; }
    for (const a of (res && res.value) || []) accs.push(a.pubkey);
  }
  W.ta = W.ta || {};
  const want = [];   // [代币账户, 新游标, [待取签名]]
  for (const ta of accs) {
    if (Date.now() > deadline) break;
    const until = W.ta[ta] || undefined;
    const got = []; let before, pages = 0, ok = true;
    while (pages < 5) {
      const res = await heliusRpc('getSignaturesForAddress', [ta, { limit: 1000, ...(until ? { until } : {}), ...(before ? { before } : {}) }]);
      if (!Array.isArray(res)) { ok = false; break; }
      got.push(...res); pages++;
      if (res.length < 1000) break;
      before = res[res.length - 1].signature;
    }
    if (!ok) continue;   // 这个账户本轮没拉全, 游标不动, 下轮重来
    if (pages >= 5 && got.length >= 5000) deps.log(`[SOL] pnl-ledger 代币账户补扫 ${wallet.slice(0, 6)}: ${ta.slice(0, 6)} 签名超 5000 条, 只补最近的`);
    const inWin = got.filter(x => x.blockTime && x.blockTime <= cutoff);   // 新的在前
    const missing = inWin.filter(x => !x.err && !W.txs[x.signature]).map(x => x.signature);
    want.push([ta, inWin.length ? inWin[0].signature : null, missing]);
    await sleep(120);
  }
  let added = 0;
  for (const [ta, cursor, missing] of want) {
    let fine = true;
    for (let i = 0; i < missing.length; i += 100) {
      if (Date.now() > deadline) { fine = false; break; }
      const arr = await heliusTxs(missing.slice(i, i + 100));
      if (!arr) { fine = false; break; }
      for (const t of arr) {
        if (!t || !t.signature || t.transactionError || W.txs[t.signature]) continue;
        const rec = parseTx(wallet, t);
        if (!Object.keys(rec.fl).length && !rec.sol && !rec.lp) continue;   // 与本钱包无关的变动 (理论上不会)
        W.txs[t.signature] = rec; added++;
      }
      await sleep(150);
    }
    if (fine && cursor) W.ta[ta] = cursor;   // 取全了才推进游标, 否则下轮从旧游标重来 (已入库的会被 W.txs 去重)
  }
  if (Object.keys(W.txs).length > RAW_LIMIT) { W.partial = true; W.txs = {}; W.pos = {}; delete W.resume; delete W.ta; }
  if (added) deps.log(`[SOL] pnl-ledger 代币账户补扫 ${wallet.slice(0, 6)}: ${accs.length} 个代币账户, 补入 ${added} 笔只经代币账户的交易`);
  save();
}

// ---- 同 slot 块内顺序 (2026-10-02) ----
//   Helius 解析结果只有 slot 和秒级时间戳, 同 slot 几笔的先后原先取决于入库顺序 (常常是倒的): 一笔开仓排在了同 slot 里
//   先发生的 USDC→SOL 换币前面, 开仓用的 SOL 没批次可扣, 按市价估 + 带星. 现对有 ≥2 笔的 slot 取 getBlock 签名表 (只要签名, ~130KB), 记块内序号 bi
async function fillBlockOrder(wallet, deadline) {
  const W = state().d.wallets[wallet]; if (!W) return 0;
  const bySlot = new Map();
  for (const [sig, t] of Object.entries(W.txs)) { const a = bySlot.get(t.slot) || bySlot.set(t.slot, []).get(t.slot); a.push(sig); }
  let n = 0;
  for (const [slot, sigs] of bySlot) {
    if (sigs.length < 2 || sigs.every(sg => W.txs[sg].bi != null)) continue;
    if (Date.now() > deadline) break;
    const r = await heliusRpc('getBlock', [slot, { transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
    const list = r && r.signatures; if (!Array.isArray(list)) continue;   // 没取到: 本轮按旧顺序, 下轮重试
    const idx = new Map(list.map((sg, i) => [sg, i]));
    for (const sg of sigs) if (idx.has(sg)) { W.txs[sg].bi = idx.get(sg); n++; }
  }
  return n;
}

// ---- 重解析 (2026-09-30): IX 表补名字后, 落盘记录里 n=null 的 LP 指令按新表重新命名; 旧记录没存 d 的按签名从 Helius 重拉 (POST /v0/transactions, 100 签名一批) ----
//   实例: Orca 新版加仓 increase_liquidity_by_token_amounts_v2 之前没命名, DJT/USDC 的 4 笔加仓被当 flow 判, zap 找零记成「已提回」
//   v3 (2026-10-02): v2 及以前的记录没有 to/from, 其中可能带的 (无 LP 指令且有流出 / 只有流入) 一并重拉
async function reparseUnnamed(wallet, deadline) {
  const W = state().d.wallets[wallet]; if (!W || W.partial || W.pv === PARSE_V) return 0;
  const refetch = []; let renamed = 0;
  const v3 = (W.pv || 0) < 3, v4 = (W.pv || 0) < 4;
  for (const [sig, rec] of Object.entries(W.txs)) {
    const vs = Object.values(rec.fl || {});
    if (v3 && ((!rec.lp && vs.some(v => v < 0)) || (vs.some(v => v > 0) && !vs.some(v => v < 0)))) { refetch.push(sig); continue; }
    if (v4 && ((!rec.lp && rec.sol < -0.001 && !vs.some(v => v > 0)) || (rec.sol > 0.001 && !vs.some(v => v < 0)))) { refetch.push(sig); continue; }
    if (!rec.lp || !rec.lp.some(ix => ix.n == null)) continue;
    if (rec.lp.every(ix => ix.n != null || ix.d)) { for (const ix of rec.lp) if (ix.n == null && ix.d) { const n = DISC[`${ix.p}:${ix.d}`]; if (n) { ix.n = n; renamed++; } } }
    else refetch.push(sig);
  }
  for (let i = 0; i < refetch.length; i += 100) {
    if (Date.now() > deadline) { deps.log(`[SOL] pnl-ledger 重解析 ${wallet.slice(0, 6)}: 预算用尽, 下轮续`); return renamed; }   // 不写 pv, 下轮继续
    const chunk = refetch.slice(i, i + 100);
    let arr = null;
    for (let k = 0; k < 4 && !arr; k++) {
      try {
        const r = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${key()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transactions: chunk }), signal: AbortSignal.timeout(60000) });
        if (r.ok) { const j = await r.json(); if (Array.isArray(j)) arr = j; }
        else await sleep(2000 * (k + 1));
      } catch { await sleep(2000 * (k + 1)); }
    }
    if (!arr) { deps.log(`[SOL] pnl-ledger 重解析 ${wallet.slice(0, 6)}: Helius 重拉失败, 下轮续`); return renamed; }
    for (const t of arr) { if (t && t.signature && W.txs[t.signature] && !t.transactionError) { const bi = W.txs[t.signature].bi; W.txs[t.signature] = parseTx(wallet, t); if (bi != null) W.txs[t.signature].bi = bi; renamed++; } }
    await sleep(150);
  }
  W.pv = PARSE_V;
  if (renamed || refetch.length) deps.log(`[SOL] pnl-ledger 重解析 ${wallet.slice(0, 6)}: 本地改名/重拉 ${renamed} 处 (重拉 ${refetch.length} 笔)`);
  save();
  return renamed;
}

// ---- 仓位识别 + 重放 ----
function positionKeysOf(ix) {
  // 开仓指令 → 该仓的标识账户 (Meteora position / Raydium personalPosition PDA / Orca position PDA)
  const a = ix.acc;
  // 2026-09-28 审计修复: Meteora initializePositionPda / initializePositionByOperator 账户序 [payer, base, position, lbPair, owner, ...] → position = a[2];
  //   initializePosition / initializePosition2 是 [payer, position, lbPair, owner, ...] → a[1]. 旧版一律取 a[1], 把 base 当成了仓位
  if (ix.p === 'Meteora') { const i = METEORA_POS_AT2.has(ix.n) ? 2 : 1; return a[i] ? [a[i]] : []; }
  if (ix.p === 'Raydium') { const k = a[2] ? pda('position', a[2], PROG_ID.Raydium) : null; return k ? [k] : []; }
  if (ix.p === 'Orca') { const k = a[3] ? pda('position', a[3], PROG_ID.Orca) : null; return k ? [k] : (a[2] ? [a[2]] : []); }
  return [];
}
// 价格观测表 obs[mint] = [{ts, p(稳定币计), pr 优先级}], 给「按当时价折算」用. 三种来源:
//   pr 0 = 本钱包双边存/取 + 该仓 tick 区间反推的池价 (Orca/Raydium): CLMM 双边数量比只由价格决定, 与流动性无关, 精确中间价
//   pr 1 = 纯换币 tx (不碰本钱包仓位) 的钱包净流向隐含价: 原有口径, 聚合器实际成交价
//   pr 2 = 本钱包换币腿 (LP 程序 swap 指令名下的转账) 的成交价: 含池子手续费 (卖出偏低/买入偏高约一个费率), 分单路由时单腿可能偏
//          主要用途是 zap tx (换币+开仓合一, 净流向不是价格, pr 1 不看它) 和 Meteora (没有 pr 0)
//   (2026-10-02) 托管挂单成交也记 pr 1: 本钱包只有流入, 付出的一边是之前收过本钱包同种币的地址 (托管) → 托管付出 / 本钱包收到 = 成交价
// 钱包净流水 (人类单位), 原生 SOL 折进 WSOL 项。回放 (记成本/提回) 与价格观测表共用这一份规则, 两边口径不会再分叉:
//   SOL 只在「本 tx 的 LP 指令 xf 里有 WSOL (SOL 是真实资金腿, 小额也计)」或「|ΔSOL| ≥ SOL_NOISE」或「非 LP tx 且 > 0.001」时计,
//   其余 (LP 操作里的租金/手续费噪声) 不计。2026-09-28 审计修复定的规则, 2026-10-01 抽成函数。
function walletFlow(t) {
  const fl = { ...t.fl };
  const solAmt = t.sol + (fl[WSOL] || 0);
  delete fl[WSOL];
  const lpWsol = (t.lp || []).some(ix => (ix.xf || []).some(([m]) => m === WSOL));
  if ((lpWsol && Math.abs(solAmt) > 1e-9) || Math.abs(solAmt) >= SOL_NOISE || (!t.lp && Math.abs(solAmt) > 0.001)) fl[WSOL] = solAmt;
  return fl;
}
function buildPriceObs(order, P, keys) {
  const obs = {};
  const add = (m, ts, p, pr, sg) => { if (p > 0 && Number.isFinite(p)) (obs[m] = obs[m] || []).push({ ts, p, pr, s: sg }); };   // 2026-09-28 审计修复: 记下来源 tx 签名 s, 供「同 tx 观测优先」
  const dec = m => { const x = state().d.tok[m]; return x && x.decimals != null ? x.decimals : null; };
  const sentTo = {};   // 收过本钱包代币的地址 → 收过的 mint
  for (const t of order) {
    for (const [a, ms] of Object.entries(t.to || {})) for (const m of Object.keys(ms)) (sentTo[a] = sentTo[a] || {})[m] = 1;
    for (const ix of (t.lp || [])) {
      if (!ix.xf || !ix.xf.length) continue;
      const kind = IX[ix.p][ix.n] || 'flow';
      const agg = {}; for (const [m, q] of ix.xf) agg[m] = (agg[m] || 0) + q;
      const ents = Object.entries(agg).filter(([, q]) => Math.abs(q) > 0);
      if (ents.length !== 2) continue;
      const [[m1, q1], [m2, q2]] = ents;
      if (!!STABLES[m1] === !!STABLES[m2]) continue;   // 要一边稳定币一边非稳定币
      if (kind === 'swap') {
        if (Math.sign(q1) === Math.sign(q2)) continue;
        const [sq, mm, mq] = STABLES[m1] ? [q1, m2, q2] : [q2, m1, q1];
        if (Math.abs(sq) >= 5) add(mm, t.ts, Math.abs(sq / mq), 2, t.sig);
      } else if (kind === 'open' || kind === 'dep' || kind === 'wd' || kind === 'flow') {
        if (ix.p === 'Meteora' || (ix.p === 'Raydium' && kind === 'wd')) continue;   // DLMM 是 bin; Raydium 减仓把手续费混进本金, 数量比失真
        if (Math.sign(q1) !== Math.sign(q2)) continue;   // 双边同向 (都存或都取) 才是仓位数量比
        const k = keys.find(k => ix.acc.includes(k) && P[k].p === ix.p); if (!k || !P[k].tk) continue;
        const d1 = dec(m1), d2 = dec(m2); if (d1 == null || d2 == null) continue;
        const aFirst = Buffer.compare(b58decode(m1) || Buffer.alloc(0), b58decode(m2) || Buffer.alloc(0)) < 0;   // 池子 A/B (token0/1) 按 mint 字节序
        const [mA, qA, dA, mB, qB, dB] = aFirst ? [m1, Math.abs(q1), d1, m2, Math.abs(q2), d2] : [m2, Math.abs(q2), d2, m1, Math.abs(q1), d1];
        const pAB = poolPriceFromAmounts(P[k].tk[0], P[k].tk[1], qA, qB, dA, dB); if (!pAB) continue;
        if (STABLES[mB]) add(mA, t.ts, pAB, 0, t.sig); else add(mB, t.ts, 1 / pAB, 0, t.sig);
      }
    }
    if (t._pos) continue;
    // 2026-10-01 修复 (SOL/BE 仓净利严重偏负的真因): 旧版直接读 t.fl, 而原生 SOL 只在 t.sol 里 (回放时才折进 WSOL), 所以 USDC↔SOL 换币
    //   从不产生 SOL 观测; 又没有 SOL 的活跃仓 → 现价表里 SOL 也是 0, 提回的 5.978 SOL 按 $0 估值。现在用与回放同一份 walletFlow。
    const fl = walletFlow(t);
    if (t.from && !Object.values(fl).some(v => v < 0)) {   // 托管挂单成交 (见上)
      const paid = {};
      for (const [a, ms] of Object.entries(t.from)) if (sentTo[a]) for (const [m, x] of Object.entries(ms)) if (sentTo[a][m]) paid[m] = (paid[m] || 0) + x;
      const pm = Object.entries(paid), got = Object.entries(fl).filter(([m, v]) => v > 0 && !(m === WSOL && v < SOL_NOISE && !paid[WSOL]));   // 顺带退的小额租金不算成交
      if (pm.length === 1 && got.length === 1) {
        const [[m1, x], [m2, q]] = [pm[0], got[0]];
        if (m1 !== m2 && !!STABLES[m1] !== !!STABLES[m2]) {
          if (STABLES[m1] && x >= 5) add(m2, t.ts, x / q, 1, t.sig);
          else if (STABLES[m2] && q >= 5) add(m1, t.ts, q / x, 1, t.sig);
          continue;
        }
      }
    }
    let usd = 0, non = 0, oppo = false;
    for (const [m, v] of Object.entries(fl)) { if (STABLES[m]) usd += v; else if (v) non++; }
    if (!usd || Math.abs(usd) < 5) continue;
    for (const [m, q] of Object.entries(fl)) if (!STABLES[m] && q && Math.sign(usd) !== Math.sign(q)) oppo = true;
    // 换币判据: Helius 标了 swap / 类型 SWAP; 或 (2026-10-01) 不含 LP 指令、只有一种非稳定币且与稳定币反向流动 —— 聚合器换币常被 Helius
    //   标成 UNKNOWN / INITIALIZE_ACCOUNT (本例 3 笔 USDC↔SOL 有 2 笔), 回放层记成本时本来就不看类型, 观测层同口径
    if (!(t.swap || t.type === 'SWAP' || (!t.lp && non === 1 && oppo))) continue;
    for (const [m, q] of Object.entries(fl)) if (!STABLES[m] && q && Math.sign(usd) !== Math.sign(q)) add(m, t.ts, Math.abs(usd / q), 1, t.sig);
  }
  return obs;
}
function poolPriceFromAmounts(lo, hi, qA, qB, dA, dB) {
  // rawB/rawA = (s − sa) / (1/s − 1/sb), s=√P 在 (sa, sb) 内单调递增 → 二分求 s; 返回 B per A (人类单位)
  if (!(qA > 0) || !(qB > 0) || !(lo < hi)) return null;
  const sa = Math.pow(1.0001, lo / 2), sb = Math.pow(1.0001, hi / 2);
  const target = (qB * 10 ** dB) / (qA * 10 ** dA);
  let l = sa, h = sb;
  for (let i = 0; i < 100; i++) { const m = (l + h) / 2; if ((m - sa) / (1 / m - 1 / sb) < target) l = m; else h = m; }
  const s = (l + h) / 2;
  if (s - sa < (sb - sa) * 1e-6 || sb - s < (sb - sa) * 1e-6) return null;   // 贴边 = 实际是单边, 不可信
  return s * s * Math.pow(10, dA - dB);
}
function impliedPriceNear(obs, mint, ts, sig) {
  // 时间最近的观测 (±3 天); 同一时刻 (同一 tx) 按优先级 pr 小者胜
  // 2026-09-28 审计修复: 同 tx (签名相同) 的观测最优先 (同一秒别的 tx 不抢); 返回 { p, d } (d = 与交易的时间差 ms), 调用方据此判 approx
  const arr = obs[mint] || [];
  let best = null, bd = 3 * 86400000, bp = 9;
  if (sig) {
    for (const o of arr) if (o.s === sig && o.pr < bp) { bp = o.pr; best = o.p; }
    if (best != null) return { p: best, d: 0 };
    bp = 9;
  }
  for (const o of arr) { const d = Math.abs(o.ts - ts); if (d < bd || (d === bd && o.pr < bp)) { bd = d; bp = o.pr; best = o.p; } }
  return best == null ? null : { p: best, d: bd };
}
// 充提记录 (flows.js) 用: 每钱包最近一次重放的价格观测 (只在内存, 不落盘; 重启后账本首轮重放完才有)
const obsByWallet = new Map();
function obsReady(wallet) { return obsByWallet.has(wallet); }
function histPrice(wallet, mint, ts, sig) {
  const ip = impliedPriceNear(obsByWallet.get(wallet) || {}, mint, ts, sig);
  return ip ? { p: ip.p, approx: ip.d > APPROX_OBS_MS } : null;
}
// 2026-10-02: SOL 历史价 (coingecko 小时价, 与充提记录同源). 附近 6h 没有观测的 SOL 以前退用 ±3 天的远观测、再没有就用现价 ——
//   一笔小额 SOL 转入 (gas 用) 前后 3 天无观测, 按现价入批次, 后面开的仓分到这批 SOL, 已关闭仓成本每轮随 SOL 现价漂几分钱.
//   computeWallet 是同步的: 缺的小时桶先记进 solNeed, runQueue 拉完再重放一次; 拉不到 (限流) 照旧退观测/现价并标 approx
const solHist = new Map();   // 小时桶 -> 美元价 (只在内存; 底层 coin-hist-cache.json 落盘, 重启后再取是本地命中)
let solNeed = null;
function solHistAt(ts) {
  const b = Math.floor(ts / 3600000);
  if (solHist.has(b)) return solHist.get(b);
  if (solNeed && deps.histSol) solNeed.set(b, ts);
  return 0;
}
async function fetchSolHist(need) {
  let got = 0;
  for (const [b, ts] of need) {
    let p = 0; try { p = Number(await deps.histSol(ts)) || 0; } catch {}
    if (p > 0) { solHist.set(b, p); got++; }
  }
  return got;
}
function priceAt(obs, mint, ts, cur, sig) {
  if (STABLES[mint]) return { p: 1, approx: false };
  const ip = impliedPriceNear(obs, mint, ts, sig);
  const c = cur[mint] || 0;
  // 2026-09-28 审计修复: 观测离交易 > 6h 标 approx (旧版 3 天内的观测一律当精确价)
  const ok = ip && (!(c > 0) || (ip.p <= c * 100 && ip.p >= c / 100));   // 隐含价与现价差 100 倍以上不可信
  if (ok && ip.d <= APPROX_OBS_MS) return { p: ip.p, approx: false };
  if (mint === WSOL) { const h = solHistAt(ts); if (h > 0) return { p: h, approx: false }; }   // 2026-10-02: SOL 附近没观测 → 当时小时价 (比远观测/现价准)
  if (ok) return { p: ip.p, approx: true };
  return { p: c, approx: true };
}
// 2026-10-02: 重放一遍收集缺的 SOL 小时价, 拉到了再重放一遍 (重放是纯本地计算)
async function computeWithHist(wallet, livePositions, name) {
  solNeed = new Map();
  let need;
  try { computeWallet(wallet, livePositions); } finally { need = solNeed; solNeed = null; }
  if (!need.size) return;
  const got = await fetchSolHist(need);
  if (got) computeWallet(wallet, livePositions);
  if (got < need.size) deps.log(`[SOL] pnl-ledger ${name || wallet.slice(0, 6)}: SOL 历史价 ${need.size - got}/${need.size} 个小时没取到, 按附近观测/现价估 (approx), 下轮重试`);
}
function computeWallet(wallet, livePositions) {
  const s = state();
  const W = s.d.wallets[wallet]; if (!W || W.partial) return;
  const cur = deps.prices() || {};
  const order = Object.entries(W.txs).map(([sig, t]) => ({ sig, ...t })).sort((a, b) => a.ts - b.ts || a.slot - b.slot || (a.bi ?? 0) - (b.bi ?? 0));   // 2026-10-02: 同 slot 按块内序号 bi (见 fillBlockOrder)
  // 1. 仓位集合: 开仓指令 + 当前活跃仓 (live)
  const P = W.pos;
  const staleBase = new Set();   // 2026-09-28 审计修复: 旧版把 Meteora initializePositionPda/ByOperator 的 a[1] (base 签名账户, 不是仓位) 当仓位键落了盘, 下面清掉 (否则开仓 tx 被它分走)
  for (const t of order) for (const ix of (t.lp || [])) {
    if (IX[ix.p][ix.n] !== 'open') continue;
    if (ix.p === 'Meteora' && METEORA_POS_AT2.has(ix.n) && ix.acc[1]) staleBase.add(ix.acc[1]);
    for (const k of positionKeysOf(ix)) { P[k] = P[k] || { p: ix.p, openTs: t.ts, evs: 0 }; if (!P[k].openTs) P[k].openTs = t.ts; if (ix.tk && !P[k].tk) P[k].tk = ix.tk; }
  }
  const liveKeys = new Set();
  for (const p of (livePositions || [])) {
    const k = p._activityKey || p.positionKey; if (!k) continue;
    liveKeys.add(k);
    P[k] = P[k] || { p: p.platform || 'Meteora', openTs: p.createdAt || 0, evs: 0 };
    if (!P[k].tk && P[k].p !== 'Meteora' && Number.isFinite(p.tickLower) && Number.isFinite(p.tickUpper) && p.tickLower < p.tickUpper) P[k].tk = [p.tickLower, p.tickUpper];   // 开仓不在扫描窗内的活跃仓, 区间取链上
  }
  for (const k of staleBase) if (P[k] && !liveKeys.has(k)) delete P[k];
  const keys = Object.keys(P);
  for (const t of order) { const src = W.txs[t.sig]; src._pos = (t.lp || []).some(ix => keys.some(k => ix.acc.includes(k))) ? 1 : 0; t._pos = src._pos; }
  const obs = buildPriceObs(order, P, keys);
  obsByWallet.set(wallet, obs);
  // 2. 时间线重放
  const lots = {};
  const consume = (mint, q, ts, sig) => {   // 2026-09-28 审计修复: 带上 tx 签名 (同 tx 观测优先)
    if (STABLES[mint]) return { cost: q, approx: false };
    const L = lots[mint];
    if (L && L.q > 0) {
      // 2026-10-02: 批次清空时 ax 一起清 (旧版 ax 粘住: 早年一笔估值进过批次, 之后同币种全部精确的买入/提回也一路带星)
      if (L.q >= q * 0.999999) { const c = L.c * Math.min(1, q / L.q), ax = !!L.ax; L.q -= q; L.c -= c; if (L.q < 1e-12) { L.q = 0; L.c = 0; L.ax = false; } return { cost: c, approx: ax }; }
      const c = L.c, ex = q - L.q; L.q = 0; L.c = 0; L.ax = false; const pr = priceAt(obs, mint, ts, cur, sig); return { cost: c + ex * pr.p, approx: true };
    }
    const pr = priceAt(obs, mint, ts, cur, sig); return { cost: q * pr.p, approx: true };
  };
  const addLot = (mint, q, c, ax) => { if (STABLES[mint] || !(q > 0)) return; const L = lots[mint] || (lots[mint] = { q: 0, c: 0, ax: false }); L.q += q; L.c += c; if (ax) L.ax = true; };
  // 2026-10-02 托管接力: 转给别人的币连成本挂在对方名下 esc[地址][mint] = {q, c, ax}; 之后只有流入的 tx 里该地址付出了这种币
  //   (Jupiter 限价单成交 = 托管的币换成别的币打进本钱包; 撤单 = 原币退回) → 按付出数量取走挂着的成本, 记给流入的币.
  //   旧版流入一律按观测价 (没有就现价) 估成本: 他人真实限价买单 16 笔重放偏差 −63%~+99%, 这些币再拿去做 LP, 开仓成本跟着错
  const esc = {};
  const C = {};
  const cOf = k => C[k] || (C[k] = { cost: 0, ret: 0, fees: 0, a: {}, cb: {}, n: 0, approx: false, feesUnknown: false, lastTs: 0, closed: false, mints: {} });
  // 2026-09-28 审计修复: 本 tx 每条仓位指令 (非 swap/aux) 名下的 xf 按仓归集 —— xfBy[k][mint] = 净额, colIn[k][mint] = 领费/奖励指令的流入,
  //   wdNoXf = 有减仓指令却没挂到任何转账的仓 (多半经包装程序中转, 它的 xf 不可信); 一条指令含多个仓时按仓数均分
  const ixFlows = (t, ops) => {
    const xfBy = new Map(), colIn = new Map(), wdNoXf = new Set();
    const bump = (map, k, m, q) => { const o = map.get(k) || map.set(k, {}).get(k); o[m] = (o[m] || 0) + q; };
    for (const ix of (t.lp || [])) {
      const kind = IX[ix.p][ix.n] || 'flow';
      if (kind === 'aux' || kind === 'swap') continue;
      const ks = [...ops.keys()].filter(k => ix.acc.includes(k) && P[k].p === ix.p);
      if (!ks.length) continue;
      if (!ix.xf || !ix.xf.length) { if (kind === 'wd') for (const k of ks) wdNoXf.add(k); continue; }
      for (const k of ks) for (const [m, q] of ix.xf) {
        bump(xfBy, k, m, q / ks.length);
        if (kind === 'col' && q > 0) bump(colIn, k, m, q / ks.length);
      }
    }
    return { xfBy, colIn, wdNoXf };
  };
  for (const t of order) {
    // 本 tx 涉及的仓位 + 操作类型
    const ops = new Map();   // key -> Set(kind)
    for (const ix of (t.lp || [])) {
      const kind = IX[ix.p][ix.n] || 'flow';
      if (kind === 'aux' || kind === 'swap') continue;   // 辅助/换币指令不是仓位操作 (换币腿只在 buildPriceObs 里用)
      for (const k of keys) if (ix.acc.includes(k) && P[k].p === ix.p) { const set = ops.get(k) || new Set(); set.add(kind); ops.set(k, set); }
    }
    // 钱包流水 (人类单位), 原生 SOL 折进 WSOL: 规则见 walletFlow (2026-10-01 与价格观测表共用)
    const fl = walletFlow(t);
    const outs = Object.entries(fl).filter(([, v]) => v < 0).map(([m, v]) => [m, -v]);
    const ins = Object.entries(fl).filter(([, v]) => v > 0);
    if (ops.size) {
      const { xfBy, colIn, wdNoXf } = ixFlows(t, ops);
      // 2026-09-28 审计修复 (同 tx 多仓): 旧版整 tx 钱包净流水按 1/N 均分 (一平一开的调仓 tx 会把 A 的提回分一半给 B, 同币种还会相抵成 0);
      //   现按每条 LP 指令自己的 xf 归属; xf 解释不了的剩余 (原生 SOL 租金、非 LP 程序的换币、没解出 xf 的指令) 才均分 —— 给没有 xf 的仓, 都有 xf 时给全部仓.
      //   单仓 tx 维持原口径: 整 tx 钱包净流水 (含原生 SOL, zap 的换币腿自然相抵)
      let perPos = null;
      if (ops.size > 1) {
        const all = [...ops.keys()];
        perPos = new Map(all.map(k => [k, { ...(xfBy.get(k) || {}) }]));
        const withXf = all.filter(k => xfBy.has(k)), noXf = all.filter(k => !xfBy.has(k));
        const tgt = noXf.length ? noXf : all;
        const mints = new Set([...Object.keys(fl), ...withXf.flatMap(k => Object.keys(xfBy.get(k)))]);
        for (const m of mints) {
          const w = fl[m] || 0; let sx = 0, sa = 0;
          for (const k of withXf) { const v = xfBy.get(k)[m] || 0; sx += v; sa += Math.abs(v); }
          const r = w - sx;
          if (Math.abs(r) <= 1e-9 + 1e-6 * Math.max(Math.abs(w), sa)) continue;   // 浮点残差
          for (const k of tgt) perPos.get(k)[m] = (perPos.get(k)[m] || 0) + r / tgt.length;
        }
      }
      for (const [k, set0] of ops) {
        const c = cOf(k);
        const pf = perPos && perPos.get(k);
        const o = pf ? Object.entries(pf).filter(([, v]) => v < -1e-12).map(([m, v]) => [m, -v]) : outs;
        const i = pf ? Object.entries(pf).filter(([, v]) => v > 1e-12) : ins;
        let outCost = 0, ax = false; const outCostBy = {};
        for (const [m, q] of o) { const r = consume(m, q, t.ts, t.sig); outCost += r.cost; outCostBy[m] = r.cost; if (r.approx) ax = true; }
        let inAx = false; const px = {}, pxA = {};
        for (const [m] of i) { const pr = priceAt(obs, m, t.ts, cur, t.sig); px[m] = pr.p; pxA[m] = pr.approx || !(pr.p > 0); if (pr.approx) inAx = true; }
        const val = arr => arr.reduce((sum, [m, q]) => sum + q * (px[m] || 0), 0);
        c.evs++; if (t.ts > c.lastTs) c.lastTs = t.ts;
        for (const [m] of o) c.mints[m] = 1; for (const [m] of i) c.mints[m] = 1;
        // 有名字的操作优先; 只有 flow (没对上名字 / rebalance) 时按净流向判: 只出=入金, 只进=减仓(或 COLLECT_FEES 类型=领费), 有进有出=调仓
        const named = new Set([...set0].filter(x => x !== 'flow'));
        const set = named.size ? named : new Set(o.length && !i.length ? ['dep'] : (i.length && !o.length ? [t.type === 'COLLECT_FEES' ? 'col' : 'wd'] : (o.length && i.length ? ['dep', 'wd'] : [])));
        const isDep = set.has('open') || set.has('dep'), isOut = set.has('wd') || set.has('close'), hasCol = set.has('col');
        // 2026-09-28 审计修复 (平仓领费拆分): Orca collectFees*/collectReward*、Meteora claimFee*/claimReward* 指令名下的 xf 就是手续费/奖励 → 直接计 fees,
        //   同 tx 的 decrease/remove 等其余流入计 ret. 旧版 tx 里只要有减仓/关仓就全计 ret + feesUnknown (平仓几乎都显示「不含已领」).
        //   Raydium decreaseLiquidity 把费和本金一起转出 → 仍 unknown; 本仓的减仓指令没有 xf (经包装程序中转, 转账都挂到最后一条 LP 指令下) → 不拆, 仍 unknown
        let feeIns = [], restIns = i, split = false;
        if (hasCol) {
          if (!isDep && !isOut) { feeIns = i; restIns = []; }   // 只领费 (原口径): 流入全是手续费/奖励
          else if (P[k].p !== 'Raydium' && colIn.has(k) && !wdNoXf.has(k)) {
            const have = Object.fromEntries(i);
            feeIns = Object.entries(colIn.get(k)).map(([m, q]) => [m, Math.min(q, have[m] || 0)]).filter(([, q]) => q > 0);   // 与本仓净流入取小 (同 tx 复投会把领到的费又存回去)
            const fm = Object.fromEntries(feeIns);
            restIns = i.map(([m, q]) => [m, q - (fm[m] || 0)]).filter(([, q]) => q > 1e-12);
            split = true;
          }
        }
        if (isDep) {
          c.cost += outCost; c.n++; if (ax) c.approx = true;
          for (const [m, q] of o) { c.a[m] = (c.a[m] || 0) + q; const cb = c.cb[m] || (c.cb[m] = { q: 0, cost: 0 }); cb.q += q; cb.cost += outCostBy[m] || 0; }
          if (!isOut) {   // 入金 tx 顺带的流入 (zap 找零): 成本、持币基线 a、按币拆分 cb 三处一起扣 (只扣成本会让 IL 虚报找零那么多); 2026-09-28: 领费部分 feeIns 不当找零
            // 2026-10-02 修复: 找零回到钱包, 按扣成本的同一市值入批次 (旧版只扣成本不入批次 → 下一笔用到这些币时批次不够, 差额按市价估 + 带星;
            //   连续 zap 加仓时, 后面几仓用到上一笔退回的币, 成本都是这么估出来的). 同 tx 有领费时下面 isOut||hasCol 段会把全部流入入批次, 这里不重复
            for (const [m, q] of restIns) { const v = q * (px[m] || 0); if (!(Math.abs(v) > 0)) continue; /* 仓位 NFT (+1, 无价) 之类不算找零 */ c.cost -= v; c.a[m] = (c.a[m] || 0) - q; const cb = c.cb[m] || (c.cb[m] = { q: 0, cost: 0 }); cb.q -= q; cb.cost -= v; if (!hasCol) addLot(m, q, v, pxA[m]); }
          }
        }
        if (isOut || hasCol) {
          c.fees += val(feeIns);
          if (isOut) {
            c.ret += val(restIns);
            if (P[k].p === 'Raydium' || (hasCol && !split)) c.feesUnknown = true;   // 本金与手续费一起转出, 拆不开
            for (const [m, q] of restIns) c.a[m] = (c.a[m] || 0) - q;   // 持币基线只扣本金 (手续费不是存进去的币)
          } else if (isDep && !split) c.feesUnknown = true;   // 2026-09-28 审计修复: 领费+入金 (复投) 拆不开: 流入已在上面按找零扣了成本, 不再重复计 ret (旧版成本、提回各记一次)
          if (inAx) c.approx = true;
          for (const [m, q] of i) addLot(m, q, q * (px[m] || 0), pxA[m]);   // 2026-10-02: 按市值入批次是记账口径 (同 EVM), 价格精确就不带星 (旧版写死 true)
        }
        if (set.has('close')) { c.closed = true; c.closeTs = t.ts; }
      }
      continue;
    }
    // 普通换币 / 转账 (2026-09-28 审计修复: 定价同样带 tx 签名, 同 tx 观测优先)
    if (outs.length && ins.length) {
      let outCost = 0, ax = false;
      for (const [m, q] of outs) { const r = consume(m, q, t.ts, t.sig); outCost += r.cost; if (r.approx) ax = true; }
      let inVal = 0; const vals = [];
      for (const [m, q] of ins) { const pr = priceAt(obs, m, t.ts, cur, t.sig); vals.push([m, q, q * pr.p]); inVal += q * pr.p; }
      for (const [m, q, v] of vals) addLot(m, q, inVal > 0 ? outCost * v / inVal : outCost / ins.length, ax);
    } else if (ins.length) {
      let carried = 0, cAx = false, hit = false;
      for (const [a, ms] of Object.entries(t.from || {})) for (const [m, x] of Object.entries(ms)) {
        const e = esc[a] && esc[a][m]; if (!e || !(e.q > 1e-12)) continue;
        hit = true; carried += e.c / e.q * x;   // 按挂着的均价计全部付出量; 付出比挂着的多 (下单在扫描窗之前) 时多出部分也按这个均价, 标 approx
        if (e.ax || x > e.q * 1.000001) cAx = true;
        const take = Math.min(x, e.q); e.c -= e.c * take / e.q; e.q -= take;
      }
      if (hit) {
        let inVal = 0; const vals = [];
        for (const [m, q] of ins) { const pr = priceAt(obs, m, t.ts, cur, t.sig); vals.push([m, q, q * pr.p]); inVal += q * pr.p; }
        for (const [m, q, v] of vals) addLot(m, q, inVal > 0 ? carried * v / inVal : carried / ins.length, cAx);
      } else for (const [m, q] of ins) { const pr = priceAt(obs, m, t.ts, cur, t.sig); addLot(m, q, q * pr.p, pr.approx || !(pr.p > 0)); }   // 外部转入按到账时市值记成本 (同充提记录的净入金口径); 2026-10-02: 价格精确就不带星 (旧版非稳定币一律带星)
    } else {
      for (const [m, q] of outs) {
        const r = consume(m, q, t.ts, t.sig);
        for (const [a, ms] of Object.entries(t.to || {})) {
          const x = ms[m]; if (!(x > 0)) continue;
          const e = (esc[a] = esc[a] || {})[m] || (esc[a][m] = { q: 0, c: 0, ax: false });
          e.q += x; e.c += r.cost * Math.min(1, x / q); if (r.approx) e.ax = true;
        }
      }
    }
  }
  // 3. 收官
  const sym = deps.symbols() || {};
  for (const k of keys) {
    const c = C[k]; const p = P[k];
    if (!c) { p.c = null; continue; }
    const mints = Object.keys(c.mints).filter(m => m !== WSOL || Math.abs(c.a[m] || 0) > 0 || c.mints[m]);
    const top = Object.entries(c.mints).map(([m]) => [m, Math.abs(c.a[m] || 0)]).sort((x, y) => y[1] - x[1]).slice(0, 2).map(x => x[0]);
    const nm = m => (sym[m] && sym[m].symbol) || STABLES[m] || (m === WSOL ? 'SOL' : m.slice(0, 4) + '…');
    const live = liveKeys.has(k);
    let status = live ? 'active' : (c.closed ? 'closed' : (c.ret > 0 || c.evs > 1 ? 'closed' : 'active'));
    // 2026-09-28 审计修复: 不在活跃缓存、却既没提回也没领过费 = 退出 tx 没被捕获 (或刚开仓还没进缓存) → note 'unseen' (报告里净利润置空, 不记 −成本 的假亏)
    const unseen = !live && !(c.ret > 0) && !(c.fees > 0);
    p.c = { cost: c.cost, ret: c.ret, fees: c.fees, a: c.a, cb: c.cb, n: c.n, approx: c.approx, feesUnknown: c.feesUnknown, openTs: p.openTs || 0, closeTs: status === 'closed' ? (c.closeTs || c.lastTs) : 0, status, note: unseen ? 'unseen' : (!live && !c.closed && status === 'closed' ? 'empty' : ''), pair: top.length === 2 ? `${nm(top[0])}/${nm(top[1])}` : (top[0] ? nm(top[0]) : '') , mints: mints };
  }
  W.lots = Object.fromEntries(Object.entries(lots).filter(([, L]) => L.q > 1e-9).map(([m, L]) => [m, { q: L.q, c: L.c, ax: L.ax }]));
  W.computedAt = Date.now();
}

// ---- 队列 ----
async function runQueue(liveByWallet, opts = {}) {
  if (!enabled()) return;
  const s = state();
  if (s.busy) return;
  s.busy = true;
  const deadline = Date.now() + (opts.budgetMs || 240 * 1000);
  try {
    const wallets = deps.wallets();
    for (const w of wallets) {
      if (Date.now() > deadline) break;
      try {
        const scanStart = Date.now();
        const W = await scanWallet(w.address, deadline);
        if (W.partial || W.stopped) { deps.log(`[SOL] pnl-ledger ${w.name}: ${W.partial ? '高频钱包放弃' : '未扫完 (' + W.stopped + '), 下轮续'}`); continue; }
        await scanTokenAccounts(w.address, deadline, scanStart);
        if (W.partial) { deps.log(`[SOL] pnl-ledger ${w.name}: 高频钱包放弃`); continue; }
        await reparseUnnamed(w.address, deadline);
        await fillBlockOrder(w.address, deadline);
        await computeWithHist(w.address, (liveByWallet && liveByWallet[w.address]) || [], w.name);
        save();
        const n = Object.values(W.pos).filter(P => P.c).length, cl = Object.values(W.pos).filter(P => P.c && P.c.status === 'closed').length;
        deps.log(`[SOL] pnl-ledger ${w.name}: ${Object.keys(W.txs).length} tx, ${n} 仓 (已关闭 ${cl})`);
      } catch (e) { console.error(`[SOL] pnl-ledger ${w.name}:`, e.message?.slice(0, 120)); }
    }
    s.lastRun = Date.now();
  } finally { s.busy = false; }
}

// ---- 只读 ----
function positionPnl(wallet, k) {
  if (!enabled()) return null;
  const W = state().d.wallets[wallet]; if (!W || W.partial) return null;
  const P = W.pos[k]; return P && P.c && P.c.cost > 0 ? P.c : null;
}
function walletStatus(wallet) {
  if (!enabled()) return { ledger: false, unsupported: true };
  const s = state(); const W = s.d.wallets[wallet];
  if (!W) return { ledger: true, pending: true, scanning: s.busy };
  return { ledger: true, partial: !!W.partial, scanning: s.busy, catchingUp: !!W.stopped, updatedAt: W.computedAt || 0, txCount: Object.keys(W.txs).length };
}
function walletReport(wallet, liveWallet, useLedger = true) {   // useLedger=false: 未勾选账本的钱包只按活跃仓出报告 (同 pnl-ledger)
  const status = walletStatus(wallet);
  const out = { ...status, positions: [], lots: [] };
  if (!useLedger) { out.ledgerStale = !!status.ledger; out.ledger = false; out.pending = false; out.scanning = false; }
  const liveMap = new Map();
  for (const p of (liveWallet?.positions || [])) if (p.liquidityActive) liveMap.set(p._activityKey || p.positionKey, p);
  const seen = new Set();
  const sym = deps.symbols() || {};
  const rowLive = (k, p) => ({
    key: k, protocol: p.protocol, platform: p.platform, tokenId: p.tokenId, pair: `${p.token0.symbol}/${p.token1.symbol}`, feeLabel: p.feeLabel,
    status: 'active', note: '', inRange: !!p.inRange, openTs: p.createdAt || 0, closeTs: 0, source: p.costSource || 'none',
    costUSD: p.costBasisUSD || 0, costApprox: !!p.costApprox, costBy: p.costByToken || null, valueUSD: p.positionValueUSD || 0, pendingFeesUSD: p.feesValueUSD || 0,
    collectedFeesUSD: p.collectedFeesUSD || 0, withdrawnUSD: p.withdrawnUSD || 0, hodlValueUSD: p.hodlValueUSD ?? null, ilUSD: p.ilUSD ?? null,
    netProfitUSD: p.costBasisUSD > 0 ? (p.netProfitUSD ?? null) : null, netProfitPct: p.costBasisUSD > 0 ? (p.netProfitPct ?? null) : null, feesUnknown: !!p.feesUnknown,
    tokens: [p.token0, p.token1].map(t => ({ address: t.address, symbol: t.symbol })),
  });
  if (useLedger && status.ledger && !status.partial && !status.pending) {
    const W = state().d.wallets[wallet];
    for (const [k, P] of Object.entries(W.pos)) {
      if (!P.c) continue;
      const live = liveMap.get(k);
      seen.add(k);
      if (live) { out.positions.push(rowLive(k, live)); continue; }
      const c = P.c;
      const net = c.ret + c.fees - c.cost;
      // 2026-09-28 审计修复: 不在当前活跃缓存的仓, 状态沿用账本 c.status (刚开仓 / 缓存暂缺时是 active), 不再一律写死 closed;
      //   没提回也没领过费 → unseen, 净利润置空 (同 EVM rowFromLedger); 账本判 active 但缓存里没有 = 现值未知, 净利润同样置空
      const status = c.status === 'active' ? 'active' : 'closed';
      const unseen = !(c.ret > 0) && !(c.fees > 0);
      const noNet = unseen || status === 'active';
      out.positions.push({
        key: k, protocol: PROTO[P.p] || P.p, platform: P.p, tokenId: k.slice(0, 8), pair: c.pair, feeLabel: null,
        status, note: status === 'active' ? '' : (unseen ? 'unseen' : c.note), inRange: null, openTs: c.openTs, closeTs: status === 'active' ? 0 : c.closeTs, source: 'ledger',
        costUSD: c.cost, costApprox: c.approx, costBy: c.cb || null, valueUSD: 0, pendingFeesUSD: 0, collectedFeesUSD: c.fees, withdrawnUSD: c.ret,
        hodlValueUSD: null, ilUSD: null, netProfitUSD: c.cost > 0 && !noNet ? net : null, netProfitPct: c.cost > 0 && !noNet ? net / c.cost * 100 : null, feesUnknown: c.feesUnknown,
        tokens: (c.mints || []).map(m => ({ address: m, symbol: (sym[m] && sym[m].symbol) || STABLES[m] || (m === WSOL ? 'SOL' : m.slice(0, 4) + '…') })),
      });
    }
    out.lots = Object.entries(W.lots || {}).map(([m, L]) => ({ token: m, qty: L.q, costUSD: L.c, avgCost: L.q > 0 ? L.c / L.q : 0, approx: L.ax }));
  }
  for (const [k, p] of liveMap) if (!seen.has(k)) out.positions.push(rowLive(k, p));
  return out;
}

module.exports = { init, enabled, runQueue, positionPnl, walletStatus, walletReport, histPrice, obsReady, ROUND_MS, _state: state, _test: { parseTx, computeWallet, computeWithHist, reparseUnnamed, fillBlockOrder, scanTokenAccounts, buildPriceObs, walletFlow, poolPriceFromAmounts, scanWallet, positionKeysOf, impliedPriceNear, priceAt } };   // 2026-09-28 审计修复: 多导出几个给独立脚本验证
