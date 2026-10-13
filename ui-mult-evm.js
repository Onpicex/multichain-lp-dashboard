// =============================================================
// ui-mult-evm.js — ERC-8056 份额乘数 (uiMultiplier) 读取与换算, EVM 链共用 (目前只接 BSC: server.js)
//   bStocks (Backed, BSC) 分红再投不改链上余额, 只改合约里的 uiMultiplier(): 钱包 / Backed 页面显示的份额 = 链上 raw × 乘数, 池子按 raw 成交.
//   做法与 sol-adapter 的 Token-2022 scaledUiAmount 同一套: 仓位数量 / 未领费 / 三价在定价前换成份额口径 (数量 × m, 价 × m1/m0), 美元价值不变;
//   账本 (pnl-ledger) / 充提记录 (flows) 内部仍按 raw, 出口数量按 uiMultOf 换份额口径; 给它们的现价表 (lastUsdPrices) 保持 raw 口径.
//   读法: Multicall3 aggregate3 (allowFailure) 批量 eth_call uiMultiplier() (selector 0xa60bf13d, uint256 / 1e18);
//   不是 ERC-8056 的合约 revert (USDT) 或回空 (零地址 / WBNB) → 1 (2026-10-13 bsc-dataseed 实测).
//   每个地址 30 分钟问一次, 读失败沿用上次; 落盘 ui-mult-evm.json ({ chain: { addrLower: { m, ts } } }), 重启后首轮仓位刷新前账本回填也有值.
// =============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const FILE = path.join(__dirname, 'ui-mult-evm.json');
const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';   // Multicall3 (四链同址, 含 bsc; 同 evm-adapter MC3_ADDR)
const MC3_ABI = ['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'];
const SEL = '0xa60bf13d';   // uiMultiplier()
const ZERO = '0x0000000000000000000000000000000000000000';
const TTL = 30 * 60 * 1000;
const CHUNK = 200;

let cfg = {};   // chainId -> { addrLower: { m, ts } }
try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) cfg = j; } catch {}
const at = {};  // chainId -> { addrLower: 上次读到的时刻 } (只在内存, 重启后首轮全读一遍)

function low(a) { return String(a || '').toLowerCase(); }
function uiMultOf(chainId, addr) {
  const c = cfg[chainId] && cfg[chainId][low(addr)];
  const v = c ? Number(c.m) : 1;
  return v > 0 && Number.isFinite(v) ? v : 1;
}
// 合理区间: 分红再投是 1.00x 级, 拆股也到不了 100 倍; 超出当读到了垃圾 (非 ERC-8056 合约的 fallback 也可能回 32 字节)
function sane(v) { return Number.isFinite(v) && v >= 0.1 && v <= 100; }

// addrs: 候选 token 地址 (任意大小写); symOf(addrLower) 可选, 只给日志用
async function refresh(chainId, provider, addrs, symOf) {
  const now = Date.now();
  const A = at[chainId] || (at[chainId] = {});
  const C = cfg[chainId] || (cfg[chainId] = {});
  const uniq = [...new Set((addrs || []).map(low))].filter(a => /^0x[0-9a-f]{40}$/.test(a) && a !== ZERO && !(C[a] && A[a] && now - A[a] < TTL));
  if (!uniq.length) return;
  const mc = new ethers.Contract(MC3, MC3_ABI, provider);
  const next = {};
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const batch = uniq.slice(i, i + CHUNK);
    let r = null, lastErr = null;
    for (let t = 0; t < 3; t++) {
      if (t) await new Promise(res => setTimeout(res, 1500 * t));
      try { r = await mc.aggregate3.staticCall(batch.map(a => ({ target: a, allowFailure: true, callData: SEL }))); break; } catch (e) { lastErr = e; }
    }
    if (!r) throw lastErr;
    batch.forEach((a, j) => {
      const x = r[j]; let m = 1;
      if (x && x.success && typeof x.returnData === 'string' && x.returnData.length === 66) {
        const v = Number(BigInt(x.returnData)) / 1e18;
        if (sane(v)) m = v;
      }
      next[a] = m; A[a] = now;
    });
  }
  const changed = [];
  for (const [a, m] of Object.entries(next)) { if (!C[a] || C[a].m !== m) changed.push(a); C[a] = { m, ts: now }; }
  if (changed.length) {
    try { const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg)); fs.renameSync(tmp, FILE); }
    catch (e) { console.error(`[${chainId}] 份额乘数落盘失败:`, String(e?.message || e).slice(0, 80)); }
    const scaled = Object.keys(C).filter(a => C[a].m !== 1);
    const nm = a => (typeof symOf === 'function' && symOf(a)) || a.slice(0, 8) + '…';
    console.log(`[${chainId}] ERC-8056 份额乘数更新: ${scaled.length ? scaled.map(a => `${nm(a)} ×${C[a].m.toFixed(6)}`).join(', ') : '(全部 = 1)'}`);
  }
}
// 仓位 (归一前原始方向, currentPrice = token1 per token0) 的数量 / 未领费 / 三价从 raw 换成份额口径;
//   总是写 uiMult0/1 (= 1 也写, 作「已换算」标记: 沿用上轮的仓位对象不再二次换算).
//   collectedFees 不动 (保持 raw —— Pancake enrichHistory 每轮都会覆盖它, 用到的地方按 uiMult 现算)
function applyUiMult(pos, m0, m1) {
  pos.uiMult0 = m0; pos.uiMult1 = m1;
  if (m0 === 1 && m1 === 1) return;
  for (const f of ['amount0', 'feesOwed0']) if (Number.isFinite(pos[f])) pos[f] *= m0;
  for (const f of ['amount1', 'feesOwed1']) if (Number.isFinite(pos[f])) pos[f] *= m1;
  const k = m1 / m0;   // 份额价 = raw 价 × m1/m0 (token1_ui / token0_ui)
  for (const f of ['currentPrice', 'lowerPrice', 'upperPrice']) if (pos[f] > 0) pos[f] *= k;
}
// raw 池价 (token1 per token0) ← 仓位里已换算的份额价; 定价推导 (getUSDPrices) 用, 定价表保持 raw 口径
function rawCurrentPrice(pos) { return pos.currentPrice * (pos.uiMult0 || 1) / (pos.uiMult1 || 1); }
// { addrLower: 数量 } 按各自乘数换成份额口径 (新对象, 不动来源)
function scaleAm(chainId, am) { const o = {}; for (const [a, q] of Object.entries(am || {})) o[a] = q * uiMultOf(chainId, a); return o; }

module.exports = { uiMultOf, refresh, applyUiMult, rawCurrentPrice, scaleAm, _file: FILE };
