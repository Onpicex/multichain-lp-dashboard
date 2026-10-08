// own-sync.js — 钱包「自有 / 观察」标记变更时, 同步四项功能的「参与钱包」显式名单 (2026-10-09)
// 背景: 钱包资金查询 (fund-config) / 钱包盈亏 (pnl-config) / 资金快照 (snapshot-config) / 出区间通知 (notify-config) 各有 wallets.<chain>:
//   未设置 = 跟随自有 (只看标「自有」的钱包); 数组 = 本链单独设置的显式名单, 优先级高于 own 标记.
//   实例: 把某观察钱包改成「观察」后它仍出现在「自有」范围 —— 因为设置页四个「参与」开关把它写进了显式名单, 标记改了名单没改.
// 这里以标记为准: 切「观察」/ 删除钱包 → 从四份显式名单里剔除; 切「自有」→ 该链有显式名单时补进去 (自有钱包默认参与, 与前端开关首次物化 stOwnAddrs 一致).
//   「跟随自有」(没有显式名单) 的链不用动: 标记本身就是权威. 四份配置都是每次用时读文件 (无常驻内存副本), 改文件即生效.
const fs = require('fs');
const path = require('path');

const FILES = { fund: 'fund-config.json', pnl: 'pnl-config.json', snapshot: 'snapshot-config.json', notify: 'notify-config.json' };
const COMPACT = new Set(['notify']);   // notifier.js 自己落盘是紧凑 JSON, 其余三份 2 空格缩进: 保持各模块原格式
const MODE600 = new Set(['snapshot', 'notify']);   // 这两份模块落盘时 chmod 600, 这里同样

function norm(chain, a) { return chain === 'sol' ? String(a) : String(a).toLowerCase(); }

// 返回改动过的配置名数组 (['fund','pnl'] ...); 文件缺失/损坏/没有该链显式名单 → 跳过
function syncOwnFlag(chain, address, own, dir) {
  const base = dir || __dirname;
  const changed = [];
  const n = norm(chain, address);
  for (const [key, name] of Object.entries(FILES)) {
    const file = path.join(base, name);
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!cfg || typeof cfg !== 'object' || !cfg.wallets || typeof cfg.wallets !== 'object') continue;
    const arr = cfg.wallets[chain];
    if (!Array.isArray(arr)) continue;   // 跟随自有: 不动
    const has = arr.some(a => norm(chain, a) === n);
    if (own ? has : !has) continue;
    cfg.wallets[chain] = own ? [...arr, String(address)] : arr.filter(a => norm(chain, a) !== n);
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, COMPACT.has(key) ? JSON.stringify(cfg) : JSON.stringify(cfg, null, 2));
      if (MODE600.has(key)) { try { fs.chmodSync(tmp, 0o600); } catch {} }
      fs.renameSync(tmp, file);
      changed.push(key);
    } catch (e) { console.error(`[own-sync] ${name} 写入失败:`, e.message); }
  }
  if (changed.length) console.log(`[own-sync] ${chain} ${address} -> ${own ? '自有(补进显式名单)' : '观察/删除(从显式名单剔除)'}: ${changed.join(',')}`);
  return changed;
}

// 换地址 = 旧地址按删除处理, 新地址按其标记处理
function syncAddrChange(chain, oldAddr, newAddr, own, dir) {
  return [...syncOwnFlag(chain, oldAddr, false, dir), ...syncOwnFlag(chain, newAddr, !!own, dir)];
}

module.exports = { syncOwnFlag, syncAddrChange, _test: { FILES } };
