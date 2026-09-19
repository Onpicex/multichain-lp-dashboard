#!/usr/bin/env node
// tools/pcs-check.js — PancakeSwap V3 (BSC) 接入自检: 不起服务, 直接用 pancake-bsc.js 跑 wallets.json 里的钱包,
// 打印每个活跃仓的对数 + 事件历史回扫结果。数学助手与 server.js 同款 (复制而非 require, server.js 一 require 就 listen)。
// 用法: node tools/pcs-check.js [--wallet 0x...] [--rounds N]   (在 lp-dashboard 目录下跑; 读 .env 的 BSC_RPC)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const args = process.argv.slice(2);
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DIR = path.join(__dirname, '..');
const provider = new ethers.JsonRpcProvider(process.env.BSC_RPC || 'https://bsc-dataseed.binance.org', 56, { staticNetwork: true });

const ERC20_ABI = ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'];
const tokenInfoCache = {};
async function getTokenInfo(address) {
  const addr = address.toLowerCase();
  if (tokenInfoCache[addr]) return tokenInfoCache[addr];
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  try { const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]); return (tokenInfoCache[addr] = { symbol, decimals: Number(decimals), address }); }
  catch { return (tokenInfoCache[addr] = { symbol: addr.slice(0, 6) + '...', decimals: 18, address, _fallback: true }); }
}
function tickToPrice(tick, d0, d1) { return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1); }
function sqrtPriceX96ToPrice(s, d0, d1) { const q = Number(s) / Math.pow(2, 96); return q * q * Math.pow(10, d0 - d1); }
function getTokenAmounts(liquidity, sqrtPriceX96, tickLower, tickUpper, d0, d1) {
  const liq = Number(liquidity); if (liq === 0) return { amount0: 0, amount1: 0 };
  const sp = Number(sqrtPriceX96) / Math.pow(2, 96), sl = Math.pow(1.0001, tickLower / 2), su = Math.pow(1.0001, tickUpper / 2);
  let a0 = 0, a1 = 0;
  if (sp <= sl) a0 = liq * (1 / sl - 1 / su); else if (sp >= su) a1 = liq * (su - sl); else { a0 = liq * (1 / sp - 1 / su); a1 = liq * (sp - sl); }
  return { amount0: a0 / Math.pow(10, d0), amount1: a1 / Math.pow(10, d1) };
}
function feeLabel(fee) { const m = { 100: '0.01%', 500: '0.05%', 2500: '0.25%', 3000: '0.3%', 10000: '1%' }; return m[Number(fee)] || `${(Number(fee) / 10000).toFixed(2)}%`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function batchedAll(items, fn, batchSize = 5) { const out = []; for (let i = 0; i < items.length; i += batchSize) { out.push(...await Promise.all(items.slice(i, i + batchSize).map(fn))); if (i + batchSize < items.length) await sleep(300); } return out; }
async function withRetry(fn, retries = 3, delayMs = 1000) { for (let i = 0; i < retries; i++) { try { return await fn(); } catch (e) { if (i === retries - 1) throw e; await sleep(delayMs * (i + 1)); } } }

(async () => {
  const pcs = require(path.join(DIR, 'pancake-bsc')).create({ ethers, provider, getTokenInfo, tickToPrice, sqrtPriceX96ToPrice, getTokenAmounts, feeLabel, batchedAll, withRetry, sleep, dir: argv('--dir', DIR) });
  let wallets = [];
  const one = argv('--wallet');
  if (one) wallets = [{ address: one.toLowerCase(), name: 'cli' }];
  else { try { wallets = JSON.parse(fs.readFileSync(path.join(DIR, 'wallets.json'), 'utf8')).filter(w => w.enabled !== false); } catch (e) { console.error('wallets.json:', e.message); process.exit(1); } }
  const rounds = parseInt(argv('--rounds', '1'));
  const all = [];
  for (const w of wallets) {
    const t = Date.now();
    const ps = await pcs.fetchWalletPositions(w);
    console.log(`\n== ${w.name} ${w.address}: ${ps.length} active Pancake V3 positions (${Date.now() - t}ms)`);
    all.push(...ps);
  }
  for (let r = 1; r <= rounds; r++) {
    const t = Date.now();
    await pcs.enrichHistory(all);
    console.log(`\n-- enrichHistory round ${r}: ${Date.now() - t}ms  stats=${JSON.stringify(pcs.stats().lastRound)}`);
    if (!all.some(p => p.histPending || !p.createdAt)) break;
  }
  for (const p of all) {
    console.log(`\n#${p.tokenId} ${p.token0.symbol}/${p.token1.symbol} ${p.feeLabel} ${p.staked ? '[staked]' : ''} ticks ${p.tickLower}~${p.tickUpper} cur ${p.currentTick} ${p.inRange ? 'IN' : 'OUT'}`);
    console.log(`   amounts ${p.amount0.toFixed(4)} / ${p.amount1.toFixed(4)}   fees ${p.feesOwed0.toFixed(6)} / ${p.feesOwed1.toFixed(6)}   price ${p.currentPrice} [${p.lowerPrice} ~ ${p.upperPrice}]`);
    console.log(`   createdAt ${p.createdAt ? new Date(p.createdAt).toISOString() : '-'}   lastCollectAt ${p.lastCollectAt ? new Date(p.lastCollectAt).toISOString() : '-'}   collected ${p.collectedFees.token0} / ${p.collectedFees.token1}${p.histPending ? '   (histPending)' : ''}   pendingCake ${p.pendingCake}`);
  }
  console.log('\nrpcs:', pcs.stats().rpcs.map(r => `${r.url.replace(/\/v1\/[0-9a-f]{20,}/, '/v1/…')} ok=${r.ok} fail=${r.fail}`).join(' | '));
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
