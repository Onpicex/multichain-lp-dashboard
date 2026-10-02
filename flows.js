// =============================================================
// flows.js — 充提记录 (钱包 ↔ 外部账户的转入/转出) 与净入金: Ankr 链 (base/bsc/eth) + Solana
//   rh 不走这里: evm-adapter 自己按 Transfer 日志回溯 (funding-cache-rh.json), 注入形状与这里一致 (injectIdle 共用)
//
// 口径 (EVM, 2026-10-02 用真实流水逐笔核对):
//   - 数据: Ankr ankr_getTokenTransfers (代币腿, 带对方地址) + ankr_getTransactionsByAddress (顶层交易的原生币 value)
//   - 同一 tx 里钱包既有流入又有流出 = 换币/LP 存取/股票赎回/意图成交, 整笔不计 (无价代币的腿也参与这个判定)
//   - 只有单向的 tx 才逐腿判对方: 0x0 → 铸入/销毁; 同链监控钱包 → 内部; EOA (含 EIP-7702 委托) → 外部;
//     合约: 钱包自己发起的 tx = 跟协议交互 (LP 存取/领费/路由/跨链桥转出), 不计; 别人发起的 = 被动收付 (交易所的合约热钱包提现等), 计入,
//     发起人是监控钱包则记内部 (对方写发起人)。2026-10-02 实测 base 某交易所热钱包是合约, 只认 EOA 会漏掉从交易所来的充值
//   - 计价: 稳定币=1; 原生币/包装原生币=转账时点 coingecko 小时价 (拿不到先按现价并标 *, 下轮重试); 其他代币=现价近似 (标 *)
//   - 不计: 无定价途径的代币 (垃圾空投/仿冒币)、零额 (地址投毒)、< $1 灰尘
//   - 看不见: 合约内部调用转出的原生币 (Ankr 无 trace, 比如桥合约解包后打来的 ETH)
// 口径 (SOL): sol-ledger 账本记录里无 LP 指令、非换币、按 SOL 并入 WSOL 后单向的 tx (有代币腿时 |ΔSOL|<0.01 视为租金/手续费噪声);
//   其他代币优先用账本的价格观测 (该钱包 ±3 天内的换币成交价, 离转账 >6h 标 *), 没有再用现价 (标 *); 币已卖光又没观测的才丢
//   对方地址用 Helius 批量解析 (/v0/transactions) 补, 结果落盘不重拉
//   对方判定 (2026-10-02, 同 EVM「钱包自己发起的合约交互不计」): 本钱包付手续费 + 对方是程序账户 (PDA, 不在 ed25519 曲线上) = 协议存取, 不计;
//     本钱包付手续费、从普通地址转入 = 对方签了名 (转出必须源地址签名) = 用户自己控制的地址 (未加进钱包列表), 记入 C.self,
//     与它的往来 (含之前转过去的那笔) 标 self、不计合计。实例: 钱包把代币转到一个未登记的普通地址, 又由该地址签名转回, 两笔都是本钱包付费
//     转出同理 (2026-10-02 补): 本钱包付手续费、转给未登记普通地址时对方也在签名人里 = 同一方控制 (钱包 App 的托管地址), 记 self。
//     实例 = Jupiter 限价单: 下单时把币转进一个 App 生成的托管地址 (托管地址 + Jupiter 联署者都签名), 撤单由托管地址签名转回;
//     成交时由 Jupiter 付费从托管地址换币、所得直接从池子打进本钱包 (Helius 标 SWAP, solLegs 本来就跳过)。
//     只认「转回」的话, 成交的单永远等不到转回, 下单那笔会被记成提币, 盈亏虚高同额。签名人靠 getTransaction 取 (增强解析结果里没有), 只对这种转出腿查
// 内部互转照记 (带对方地址), 前端按当前视图的钱包集合判「内部」并不计合计; 单钱包视图下就是该钱包的充值/提币
// 缓存 flows-cache-<chain>.json (v2: 合约对手改按发起人判; v3: SOL 加账本价格观测; SOL v4: 自控地址/PDA 判定; SOL v5: 转出时对方联署也算自控 —— 版本不符整体重扫):
//   { v, wallets: { addr: { scannedTo|chk, stopped, raw, events, inUSD, outUSD, updatedAt } }, code, self (仅 SOL: { 自控地址: 1 }) }
// =============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ledger = require('./pnl-ledger');
const { PublicKey } = require('@solana/web3.js');

const CACHE_V = { sol: 5 };         // 按链分版本: 只改 SOL 口径时不逼 EVM 链整体重扫
const verOf = chainId => CACHE_V[chainId] || 3;
const RAW_LIMIT = 8000;            // 单钱包原始转账条数上限, 超过 = 高频 bot 钱包放弃 (同 rh FUNDING_RAW_LIMIT)
const DUST_USD = 1;
const DUST_PRE_USD = 0.2;           // 按现价连这个都不到的腿 (手续费级) 直接丢, 不去排 coingecko 历史价队列 (免费档 2.5s/次, 全进程共用一条)
const ROUND_MS = 10 * 60 * 1000;   // 后台轮询间隔 (Ankr 与账本共用一条串行队列, 不跟 5min 刷新走)
const ZERO = '0x0000000000000000000000000000000000000000';
const WSOL = 'So11111111111111111111111111111111111111112';
const SOL_STABLES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
const SOL_RENT_NOISE = 0.01;       // 有代币腿的 tx 里 |ΔSOL| 小于此 = ATA 租金/手续费 (建/关代币账户), 不当资金腿
const low = a => String(a || '').toLowerCase();
const hexNum = h => (typeof h === 'number' ? h : (String(h).startsWith('0x') ? parseInt(h, 16) : Number(h)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normAddr = (chainId, a) => (chainId === 'sol' ? String(a) : low(a));

let solDeps = null;   // sol-adapter 注入: { records(addr) → 账本钱包对象 | null, prices() → { mint: usd }, symbols() → { mint: { symbol } }, histPrice(addr, mint, ts, sig) → { p, approx } | null, obsReady(addr) }
function initSol(d) { solDeps = d; }
function heliusKey() { return (process.env.HELIUS_KEY || '').trim(); }
function enabled(chainId) { return chainId === 'sol' ? !!(heliusKey() && solDeps) : ledger.isAnkr(chainId); }

// ---- 缓存 ----
const caches = {};
function fileOf(chainId) { return path.join(__dirname, `flows-cache-${chainId}.json`); }
function cacheOf(chainId) {
  if (!caches[chainId]) {
    const f = fileOf(chainId);
    let d = null;
    if (fs.existsSync(f)) {
      try { d = JSON.parse(fs.readFileSync(f, 'utf8')); }
      catch (e) { try { fs.renameSync(f, `${f}.bad-${Date.now()}`); } catch {} console.error(`[${chainId}] flows 缓存损坏, 已改名留证重扫:`, e.message?.slice(0, 60)); }
    }
    if (!d || d.v !== verOf(chainId)) d = { v: verOf(chainId), wallets: {}, code: {} };
    caches[chainId] = d;
  }
  return caches[chainId];
}
function save(chainId) {
  try { const f = fileOf(chainId), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cacheOf(chainId))); fs.renameSync(tmp, f); }
  catch (e) { console.error(`[${chainId}] flows 落盘失败:`, e.message?.slice(0, 80)); }
}
function finish(W) {
  W.events.sort((a, b) => b.ts - a.ts);
  const cnt = W.events.filter(e => e.ct !== 'self');   // 与自控地址的往来列出但不计
  W.inUSD = cnt.filter(e => e.dir === 'in').reduce((s, e) => s + e.usd, 0);
  W.outUSD = cnt.filter(e => e.dir === 'out').reduce((s, e) => s + e.usd, 0);
}

// 钱包资金查询的勾选 (fund-config.json): 未设置 = 只看自有钱包 (与总价值统计同口径)
function fundSelected(chainId, wallets) {
  let c = { enabled: true, wallets: {} };
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'fund-config.json'), 'utf8')); c = { enabled: j.enabled !== false, wallets: (j.wallets && typeof j.wallets === 'object') ? j.wallets : {} }; } catch {}
  if (!c.enabled) return [];
  const on = wallets.filter(w => w.enabled !== false);
  const sel = c.wallets[chainId];
  if (!Array.isArray(sel)) return on.filter(w => w.own === true);
  const s = new Set(sel.map(a => normAddr(chainId, a)));
  return on.filter(w => s.has(normAddr(chainId, w.address)));
}

// ---- 计价 ----
function curPrice(chainId, token) {
  if (chainId === 'sol') return (solDeps.prices() || {})[token] || 0;
  const st = ledger.flowApi.stateOf(chainId);
  return ((st && st.lastUsdPrices) || {})[token] || 0;
}
async function histNative(chainId, ts) {
  const id = chainId === 'sol' ? 'solana' : ledger.flowApi.cfgOf(chainId).nativePriceId;
  if (!id || !ts) return 0;
  try { return (await ledger.flowApi.coinUsdAt(id, ts)) || 0; } catch { return 0; }
}
// 返回 { price, ax, rp }: ax=近似价 (前端标 *), rp=原生币历史价没拿到 (按现价顶上, 下轮重试)
async function priceOf(chainId, token, isNative, ts) {
  const stables = chainId === 'sol' ? SOL_STABLES : ledger.flowApi.cfgOf(chainId).stables;
  if (stables[token]) return { price: 1, ax: 0, rp: 0 };
  if (isNative) {
    const p = await histNative(chainId, ts);
    if (p > 0) return { price: p, ax: 0, rp: 0 };
    const wn = chainId === 'sol' ? WSOL : low(ledger.flowApi.cfgOf(chainId).wrappedNative);
    return { price: curPrice(chainId, wn), ax: 1, rp: 1 };
  }
  return { price: curPrice(chainId, token), ax: 1, rp: 0 };
}
// 上轮没拿到历史价的原生币事件: 再试一次, 拿到就改成精确值
async function repriceNative(chainId, W) {
  let n = 0;
  for (const e of W.events) {
    if (!e.rp) continue;
    const p = await histNative(chainId, e.ts);
    if (p > 0) { e.usd = e.amt * p; delete e.rp; delete e.ax; n++; }
  }
  if (n) finish(W);
  return n;
}

// ---- EVM (Ankr) ----
async function isEoa(chainId, addr, C) {
  if (addr in C.code) return C.code[addr] === 0;
  try {
    const code = await ledger.flowApi.providerFor(chainId).getCode(addr);
    const eoa = !code || code === '0x' || /^0xef0100/i.test(code);   // EIP-7702 委托的 EOA 仍是人
    C.code[addr] = eoa ? 0 : 1;
    return eoa;
  } catch { return null; }   // 拿不到: 本轮作废不推进游标, 下轮重判 (不按合约吞掉, 免得漏记真充值)
}
async function scanEvmWallet(chainId, addr, monitored, deadline) {
  const A = ledger.flowApi;
  const cfg = A.cfgOf(chainId), bc = cfg.ledgerFromAnkr, wn = low(cfg.wrappedNative);
  const nativeSym = cfg.nativeSymbol || (cfg.nativePriceId === 'binancecoin' ? 'BNB' : 'ETH');
  const C = cacheOf(chainId);
  const W = C.wallets[addr] || (C.wallets[addr] = { scannedTo: -1, stopped: null, raw: 0, events: [], inUSD: 0, outUSD: 0, updatedAt: 0 });
  if (W.stopped === 'budget') return W;
  if (!(curPrice(chainId, wn) > 0)) { W.stopped = 'rpc'; return W; }   // 价表还没加载: 这时扫会把有价代币当无价丢掉且游标前移, 等下轮
  await repriceNative(chainId, W);
  const latest = await A.providerFor(chainId).getBlockNumber();
  const from = W.scannedTo + 1, to = latest - 5;   // 留几块给索引追平
  if (from > to) { W.stopped = null; W.updatedAt = Date.now(); return W; }
  const byTx = new Map();   // hash -> { b, ts, legs }
  const selfTx = new Set();  // 钱包自己发起的 tx (B 段顶层交易 from = 钱包)
  const txOf = (h, b) => { let t = byTx.get(h); if (!t) byTx.set(h, t = { b, ts: 0, legs: [] }); return t; };
  let raw = W.raw || 0;
  const bot = () => { W.stopped = 'budget'; W.events = []; W.inUSD = 0; W.outUSD = 0; W.updatedAt = Date.now(); console.log(`[${chainId}] flows ${addr.slice(0, 10)}: 转账超 ${RAW_LIMIT} 条, 高频钱包放弃`); return W; };
  // A. 代币转账
  let token = null, pages = 0;
  do {
    if (Date.now() > deadline) { W.stopped = 'rpc'; return W; }
    const r = await A.ankrCall('ankr_getTokenTransfers', { address: addr, blockchain: [bc], fromBlock: from, toBlock: to, pageSize: 1000, pageToken: token || undefined, descOrder: false });
    if (!r) { W.stopped = 'rpc'; return W; }
    for (const x of (r.transfers || [])) {
      const c = low(x.contractAddress);
      if (!/^0x[0-9a-f]{40}$/.test(c)) continue;                 // 原生币条目 (无合约地址) 由 B 段的 tx.value 负责
      const f = low(x.fromAddress), t = low(x.toAddress);
      if (f === t || (f !== addr && t !== addr)) continue;
      if (BigInt(x.valueRawInteger || '0') === 0n) continue;      // 零额 = 地址投毒
      const b = Number(x.blockHeight); if (!(b >= from && b <= to)) continue;
      const tx = txOf(low(x.transactionHash), b);
      if (x.timestamp) tx.ts = Number(x.timestamp) * 1000;
      const dec = Number(x.tokenDecimals ?? 18);
      const amt = Number(x.value) || Number(BigInt(x.valueRawInteger)) / 10 ** dec;
      tx.legs.push({ li: String(Number(x.logIndex)), tok: c, dir: t === addr ? 'in' : 'out', cp: t === addr ? f : t, amt, sym: x.tokenSymbol || c.slice(0, 6) });
      raw++;
    }
    token = r.nextPageToken || null; pages++;
    if (raw > RAW_LIMIT) return bot();
  } while (token && pages < 200);
  if (token) { W.stopped = 'rpc'; return W; }   // 页数触顶还有下一页 = 没翻完, 不推进游标
  // B. 顶层交易的原生币 value (钱包发出 / 收到)
  token = null; pages = 0;
  do {
    if (Date.now() > deadline) { W.stopped = 'rpc'; return W; }
    const r = await A.ankrCall('ankr_getTransactionsByAddress', { address: addr, blockchain: [bc], fromBlock: from, toBlock: to, pageSize: 100, pageToken: token || undefined, descOrder: false, includeLogs: false });
    if (!r) { W.stopped = 'rpc'; return W; }
    for (const x of (r.transactions || [])) {
      const b = hexNum(x.blockNumber); if (!(b >= from && b <= to)) continue;
      if (x.status != null && hexNum(x.status) === 0) continue;   // 失败交易
      const f = low(x.from), t = low(x.to);
      const val = x.value ? BigInt(x.value) : 0n;
      raw++;
      if (f === addr) selfTx.add(low(x.hash));
      if (val === 0n || f === t || (f !== addr && t !== addr)) continue;
      const tx = txOf(low(x.hash), b);
      if (x.timestamp) tx.ts = hexNum(x.timestamp) * 1000;
      tx.legs.push({ li: 'v', tok: ZERO, native: true, dir: t === addr ? 'in' : 'out', cp: t === addr ? f : t, amt: Number(val) / 1e18, sym: nativeSym });
    }
    token = r.nextPageToken || null; pages++;
    if (raw > RAW_LIMIT) return bot();
  } while (token && pages < 500);
  if (token) { W.stopped = 'rpc'; return W; }
  // C. 判定 (全部腿拿齐才判, getCode 失败整轮作废)
  const seen = new Set(W.events.map(e => e.id));
  const add = [];
  for (const [h, tx] of byTx) {
    if (!tx.legs.length) continue;
    if (tx.legs.some(l => l.dir === 'in') && tx.legs.some(l => l.dir === 'out')) continue;   // 有进有出 = 交易行为
    if (!tx.ts) { try { const blk = await A.providerFor(chainId).getBlock(tx.b); tx.ts = blk ? blk.timestamp * 1000 : 0; } catch {} }
    for (const l of tx.legs) {
      const id = `${h}-${l.li}`;
      if (seen.has(id) || !(l.amt > 0)) continue;
      const isNative = !!l.native || l.tok === wn;
      // 先看有没有定价途径, 没有的 (垃圾/仿冒币) 不花 getCode
      if (!isNative && !cfg.stables[l.tok] && !(curPrice(chainId, l.tok) > 0)) continue;
      if (!cfg.stables[l.tok]) { const cur = curPrice(chainId, isNative ? wn : l.tok); if (cur > 0 && l.amt * cur < DUST_PRE_USD) continue; }   // 现价没加载 (0) 时不预判
      let ct, cp = l.cp;
      if (l.cp === ZERO) ct = l.dir === 'in' ? 'mint' : 'burn';
      else if (monitored.has(l.cp)) ct = 'internal';
      else {
        const eoa = await isEoa(chainId, l.cp, C);
        if (eoa === null) { W.stopped = 'rpc'; return W; }
        if (eoa) ct = 'external';
        else {
          if (selfTx.has(h)) continue;                              // 自己发起的合约交互 (LP/领费/路由/桥), 不计
          if (tx.ini === undefined) {                               // 别人发起: 查发起人 (一笔 tx 只查一次)
            try { const t = await A.providerFor(chainId).getTransaction(h); tx.ini = t && t.from ? low(t.from) : null; } catch { tx.ini = null; }
          }
          if (tx.ini === null) { W.stopped = 'rpc'; return W; }
          if (tx.ini === addr) continue;                            // 兜底: B 段漏了的自发交易
          if (monitored.has(tx.ini)) { ct = 'internal'; cp = tx.ini; }
          else ct = 'external';
        }
      }
      const { price, ax, rp } = await priceOf(chainId, l.tok === ZERO ? wn : l.tok, isNative, tx.ts);
      const usd = l.amt * price;
      if (!(usd >= DUST_USD)) continue;
      const e = { id, b: tx.b, ts: tx.ts, dir: l.dir, tok: l.tok, sym: l.sym, amt: l.amt, usd, cp, ct };
      if (ax) e.ax = 1; if (rp) e.rp = 1;
      add.push(e);
    }
  }
  W.events.push(...add);
  finish(W);
  W.raw = raw; W.scannedTo = to; W.stopped = null; W.updatedAt = Date.now();
  return W;
}

// ---- Solana (账本记录 + Helius 批量解析补对方) ----
async function heliusParse(sigs) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${heliusKey()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transactions: sigs }), signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(3000 * (i + 1)); continue; }
      if (!r.ok) { await sleep(2000 * (i + 1)); continue; }
      const j = await r.json();
      if (Array.isArray(j)) return j;
      await sleep(2000);
    } catch { await sleep(2000 * (i + 1)); }
  }
  return null;
}
// 一条账本记录 → 钱包视角的资金腿 [{ mint, amt(±) }]; 不是充提候选返回 null
function solLegs(t) {
  if (t.lp || t.swap || t.type === 'SWAP') return null;
  const fl = { ...t.fl };
  const sol = (Number(t.sol) || 0) + (fl[WSOL] || 0);
  delete fl[WSOL];
  const legs = Object.entries(fl).filter(([, a]) => Math.abs(a) > 1e-12).map(([mint, amt]) => ({ mint, amt }));
  if (Math.abs(sol) > 1e-9 && (!legs.length || Math.abs(sol) >= SOL_RENT_NOISE)) legs.push({ mint: WSOL, amt: sol });
  if (!legs.length) return null;
  if (legs.some(l => l.amt > 0) && legs.some(l => l.amt < 0)) return null;   // 有进有出 = 交易行为
  return legs;
}
// Helius 解析结果里找这条腿的对方 (同 mint、同方向、金额最大的那笔); 原生 SOL 先看 nativeTransfers 再看 WSOL 代币转账
function solCounterparty(p, wallet, mint, dir) {
  const pick = (arr, fromK, toK, amtK) => {
    let best = null, bv = -1;
    for (const x of (arr || [])) {
      const mine = dir === 'in' ? x[toK] === wallet : x[fromK] === wallet;
      const other = dir === 'in' ? x[fromK] : x[toK];
      if (!mine || other === wallet) continue;
      const v = Math.abs(Number(x[amtK]) || 0);
      if (v > bv) { bv = v; best = other || ''; }
    }
    return best;
  };
  const tok = (p.tokenTransfers || []).filter(x => x.mint === mint);
  if (mint === WSOL) {
    const n = pick(p.nativeTransfers, 'fromUserAccount', 'toUserAccount', 'amount');
    if (n != null) return n;
  }
  return pick(tok, 'fromUserAccount', 'toUserAccount', 'tokenAmount');
}
// 这笔 tx 的签名人 (Helius RPC); 失败返回 null, 调用方别把这笔标已查
async function solSigners(sig) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }] }), signal: AbortSignal.timeout(30000) });
      if (!r.ok) { await sleep(2000 * (i + 1)); continue; }
      const j = await r.json();
      const keys = j && j.result && j.result.transaction && j.result.transaction.message.accountKeys;
      if (keys) return new Set(keys.filter(k => k.signer).map(k => k.pubkey));
      await sleep(2000 * (i + 1));
    } catch { await sleep(2000 * (i + 1)); }
  }
  return null;
}
function onCurve(a) { try { return PublicKey.isOnCurve(new PublicKey(a).toBytes()); } catch { return true; } }   // 解析不了当普通地址 (走旧口径)
// 新认出的自控地址: 全部钱包里与它的旧事件 (比如先转出、后来才转回的那笔) 一起改标 self
function markSelf(C, cp) {
  if (C.self[cp]) return;
  C.self[cp] = 1;
  for (const W of Object.values(C.wallets)) {
    let hit = false;
    for (const e of W.events) if (e.cp === cp && e.ct !== 'self') { e.ct = 'self'; hit = true; }
    if (hit) finish(W);
  }
}
async function scanSolWallet(addr, monitored, deadline) {
  const C = cacheOf('sol');
  if (!C.self) C.self = {};
  const L = solDeps.records(addr);
  if (!L) return null;   // 没开账本的钱包: 无记录可用
  const W = C.wallets[addr] || (C.wallets[addr] = { chk: {}, stopped: null, events: [], inUSD: 0, outUSD: 0, updatedAt: 0 });
  if (L.partial) { W.stopped = 'budget'; W.events = []; W.inUSD = 0; W.outUSD = 0; W.updatedAt = Date.now(); return W; }
  if (!(curPrice('sol', WSOL) > 0)) { W.stopped = 'rpc'; return W; }   // 价表还没加载: 这时扫会把 tx 当无价标已查永久漏掉, 等下轮
  if (solDeps.obsReady && !solDeps.obsReady(addr)) { W.stopped = 'rpc'; return W; }   // 账本这次启动后还没重放过该钱包 (价格观测只在内存), 同上
  await repriceNative('sol', W);
  const syms = solDeps.symbols() || {};
  const cands = [];
  for (const [sig, t] of Object.entries(L.txs || {})) {
    if (W.chk[sig]) continue;
    const legs = solLegs(t);
    if (!legs) continue;
    cands.push({ sig, t, legs });
  }
  W.stopped = null;
  for (let i = 0; i < cands.length; i += 100) {
    if (Date.now() > deadline) { W.stopped = 'rpc'; break; }
    const batch = cands.slice(i, i + 100);
    const parsed = await heliusParse(batch.map(c => c.sig));
    if (!parsed) { W.stopped = 'rpc'; break; }
    const bySig = new Map(parsed.filter(Boolean).map(p => [p.signature, p]));
    for (const c of batch) {
      const p = bySig.get(c.sig);
      if (!p) continue;   // 这笔没解析回来, 下轮再试
      // 本钱包付费、转给未登记普通地址: 查对方是否也签了名 (托管地址), 是就先记自控, 下面这条腿直接标 self
      if (p.feePayer === addr) {
        const ask = c.legs.filter(l => l.amt < 0).map(l => solCounterparty(p, addr, l.mint, 'out')).filter(cp => cp && !monitored.has(cp) && !C.self[cp] && onCurve(cp));
        if (ask.length) {
          const sg = await solSigners(c.sig);
          if (!sg) { W.stopped = 'rpc'; continue; }   // 没查到, 不标已查, 下轮再试
          for (const cp of ask) if (sg.has(cp)) markSelf(C, cp);
        }
      }
      for (const l of c.legs) {
        const dir = l.amt > 0 ? 'in' : 'out', amt = Math.abs(l.amt);
        if (!SOL_STABLES[l.mint]) { const cur = curPrice('sol', l.mint); if (cur > 0 && amt * cur < DUST_PRE_USD) continue; }   // 现价没加载 (0) 时不预判, 免得整笔被标已查永久漏掉
        let { price, ax, rp } = await priceOf('sol', l.mint, l.mint === WSOL, c.t.ts);
        // 非稳定币/非 SOL: 优先账本的价格观测 (该钱包当时前后的换币成交价, ±3 天); 现价表里没有 (币已卖光) 时也靠它定价
        if (l.mint !== WSOL && !SOL_STABLES[l.mint] && solDeps.histPrice) {
          const h = solDeps.histPrice(addr, l.mint, c.t.ts, c.sig);
          if (h && h.p > 0) { price = h.p; ax = h.approx ? 1 : 0; rp = 0; }
        }
        const usd = amt * price;
        if (!(price > 0) || !(usd >= DUST_USD)) continue;
        const cp = solCounterparty(p, addr, l.mint, dir);
        const selfPaid = p.feePayer === addr, pda = !!cp && !onCurve(cp);
        if (selfPaid && pda) continue;   // 钱包自己发起、对方是程序账户 = 协议存取 (借贷/质押/跨链桥等), 不是充提
        if (cp && dir === 'in' && selfPaid && !pda && !monitored.has(cp)) markSelf(C, cp);   // 对方签名转给本钱包、本钱包付费 = 自控地址
        const ct = !cp ? (dir === 'in' ? 'mint' : 'burn') : (monitored.has(cp) ? 'internal' : C.self[cp] ? 'self' : 'external');
        const sym = l.mint === WSOL ? 'SOL' : (SOL_STABLES[l.mint] || (syms[l.mint] && syms[l.mint].symbol) || l.mint.slice(0, 4));
        const e = { id: `${c.sig}:${l.mint}`, ts: c.t.ts, dir, tok: l.mint, sym, amt, usd, cp: cp || '', ct };
        if (ax) e.ax = 1; if (rp) e.rp = 1;
        W.events.push(e);
      }
      W.chk[c.sig] = 1;
    }
  }
  finish(W);
  if (!W.stopped) W.updatedAt = Date.now();
  else if (!W.updatedAt && W.events.length) W.updatedAt = Date.now();
  return W;
}

// ---- 队列 ----
const running = {};
// wallets: 该链全部钱包配置 (含停用/观察, 用来判「内部」); 只扫资金查询勾选的 (默认自有)
async function runQueue(chainId, wallets, opts = {}) {
  if (!enabled(chainId) || running[chainId]) return;
  running[chainId] = true;
  const deadline = Date.now() + (opts.budgetMs || 180 * 1000);
  try {
    const monitored = new Set(wallets.map(w => normAddr(chainId, w.address)));
    for (const w of fundSelected(chainId, wallets)) {
      if (Date.now() > deadline) break;
      const a = normAddr(chainId, w.address);
      try {
        const W = chainId === 'sol' ? await scanSolWallet(a, monitored, deadline) : await scanEvmWallet(chainId, a, monitored, deadline);
        if (!W) continue;
        save(chainId);
        console.log(`[${chainId}] flows ${w.name}: ${W.stopped === 'budget' ? '高频钱包放弃' : `${W.events.length} 笔, 充 $${W.inUSD.toFixed(0)} 提 $${W.outUSD.toFixed(0)}${W.stopped === 'rpc' ? ' (未扫完下轮续)' : ''}`}`);
      } catch (e) { console.error(`[${chainId}] flows ${w.name}:`, e.message?.slice(0, 120)); }
    }
  } finally { running[chainId] = false; }
}

// ---- 只读: 注入 /positions 的 idle 与 /pnl ----
function fundingOf(chainId, addr) {
  const W = cacheOf(chainId).wallets[normAddr(chainId, addr)];
  if (!W || (!W.updatedAt && W.stopped !== 'budget')) return null;
  if (W.stopped === 'budget') return { partial: true };
  return { inUSD: W.inUSD || 0, outUSD: W.outUSD || 0, netUSD: (W.inUSD || 0) - (W.outUSD || 0), partial: false, catchingUp: W.stopped === 'rpc',
    events: W.events.map(({ rp, ...e }) => e) };
}
function fundingSummary(f) {
  if (!f) return null;
  if (f.partial) return { inUSD: 0, outUSD: 0, netUSD: 0, partial: true, catchingUp: false };
  return { inUSD: f.inUSD, outUSD: f.outUSD, netUSD: f.netUSD, partial: false, catchingUp: !!f.catchingUp };
}
// idle.byWallet[a].funding + idle.funding 汇总 (fOf: 地址 → fundingOf 形状 | null)
function injectIdle(idle, fOf) {
  if (!idle || !idle.byWallet) return;
  let fin = 0, fout = 0, anyData = false; const partialNames = [];
  for (const [a, wI] of Object.entries(idle.byWallet)) {
    const f = fOf(a);
    if (!f) { delete wI.funding; continue; }
    anyData = true;
    wI.funding = f;
    if (f.partial) { partialNames.push(wI.name); continue; }
    fin += f.inUSD; fout += f.outUSD;
  }
  if (anyData) idle.funding = { inUSD: fin, outUSD: fout, netUSD: fin - fout, partialWallets: partialNames };
  else delete idle.funding;
}

module.exports = { initSol, enabled, runQueue, fundingOf, fundingSummary, injectIdle, fundSelected, ROUND_MS, _test: { solLegs, solCounterparty, scanEvmWallet, scanSolWallet, cacheOf } };
