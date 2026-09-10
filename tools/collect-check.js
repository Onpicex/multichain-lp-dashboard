#!/usr/bin/env node
// 领费时间填充自检: 拿 positions-cache-<chain>.json 里的真实活跃仓跑一遍 fillLastCollect,
// 打印每仓的 lastCollectAt 与「当前日化」新旧对比。只读头寸缓存, 不写 positions-cache。
// 用法: node22 tools/collect-check.js [chain...]   默认 base eth rh
require("dotenv").config();
const fs = require("fs"), path = require("path");
const { _collectTest } = require("../evm-adapter.js");

const chains = process.argv.slice(2).length ? process.argv.slice(2) : ["base", "eth", "rh"];
const fmtTs = ms => ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "-";

(async () => {
  for (const chain of chains) {
    const f = path.join(__dirname, "..", `positions-cache-${chain}.json`);
    let saved; try { saved = JSON.parse(fs.readFileSync(f, "utf8")); } catch { console.log(`[${chain}] 无缓存, 跳过`); continue; }
    const wallets = (saved.data?.wallets || saved.wallets || []).map(w => ({
      ...w, positions: (w.positions || []).map(p => ({ ...p, lastCollectAt: p.protocol === "V3" && chain === "rh" ? p.lastCollectAt : 0 })),
    }));
    const t0 = Date.now();
    await _collectTest.fillLastCollect(chain, wallets);
    console.log(`[${chain}] 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const w of wallets) for (const p of w.positions) {
      if (!p.liquidityActive) continue;
      const cs = p.lastCollectAt || p.createdAt;
      const oldD = (Date.now() - p.createdAt) / 86400000, newD = (Date.now() - cs) / 86400000;
      const base = p.positionValueUSD > 0 ? (p.feesValueUSD / p.positionValueUSD) * 100 : 0;
      const oldR = oldD > 0 ? base / oldD : 0, newR = newD > 0 ? base / newD : 0;
      const mark = p.lastCollectAt ? "↻" : " ";
      console.log(`  ${mark} ${w.name.padEnd(10)} ${p.protocol} #${String(p.tokenId).padEnd(9)} ${(p.token0.symbol + "/" + p.token1.symbol).padEnd(16)} 建仓 ${fmtTs(p.createdAt)}  领费 ${fmtTs(p.lastCollectAt)}  日化 ${oldR.toFixed(2)}% -> ${newR.toFixed(2)}%`);
    }
  }
  process.exit(0);
})();
