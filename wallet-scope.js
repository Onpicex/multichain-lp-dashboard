// wallet-scope.js — 钱包「纳入」范围 (2026-10-09 重设计第二版)
// 四项功能 (钱包资金查询 / 钱包盈亏 / 资金快照 / 出区间通知) 对每个钱包各有一个「纳入」开关, 存在钱包记录上的布尔字段:
//   fund / ledger (= 纳入盈亏, 沿用旧字段名: 观察钱包「开账本」就是它) / snap / notify
// 缺省规则: 字段缺省时 自有钱包 = 纳入, 观察钱包 = 不纳入; 显式 true/false 覆盖缺省 (改「自有/观察」标记不清显式值)
// 「启用/停用」(enabled) 是钱包总开关: 停用的钱包不抓仓位、不查余额, 任何功能都不纳入 (开关值保留, 重新启用后恢复)
// 自有/观察标记只决定它落在盈亏页 / 快照页的哪个范围 (自有 / 观察), 不再是范围本身
'use strict';
const fs = require('fs');
const path = require('path');

const FEATS = { fund: 'fund', pnl: 'ledger', snapshot: 'snap', notify: 'notify' };
const FEAT_FIELDS = Object.values(FEATS);
const FEAT_LABEL = { fund: '资金查询', ledger: '盈亏', snap: '快照', notify: '通知' };

function isOn(w) { return w.enabled !== false; }
function featOn(w, field) { return typeof w[field] === 'boolean' ? w[field] : w.own === true; }
function inScope(w, field) { return isOn(w) && featOn(w, field); }
function walletsFile(chain) { return chain === 'bsc' ? 'wallets.json' : `wallets-${chain}.json`; }
function readWallets(chain) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, walletsFile(chain)), 'utf8')); } catch { return []; } }
function scopeAddrs(chain, field) { return readWallets(chain).filter(w => inScope(w, field)).map(w => w.address); }

// PATCH /wallets/:address 共用: 从 body 取四个开关字段 (缺省 = 不改; true/false = 显式存值; null = 清掉显式值回到缺省规则); 其它 → { error }
function parseFeatPatch(body) {
  const feats = {};
  for (const f of FEAT_FIELDS) {
    const v = body[f];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'boolean') return { error: `${f} 须为布尔值 (或 null = 回到缺省)` };
    feats[f] = v;
  }
  return { feats };
}
function applyFeatPatch(w, feats) { for (const [f, v] of Object.entries(feats)) { if (v === null) delete w[f]; else w[f] = v; } }
// 可改字段的错误提示 (三个 PATCH 处理器共用)
const PATCH_FIELDS_HINT = '需要 name / address / enabled / own / ' + FEAT_FIELDS.join(' / ');

module.exports = { FEATS, FEAT_FIELDS, FEAT_LABEL, isOn, featOn, inScope, walletsFile, readWallets, scopeAddrs, parseFeatPatch, applyFeatPatch, PATCH_FIELDS_HINT };
