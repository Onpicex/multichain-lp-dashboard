// snapshot.js — 资金快照 (/api/snapshot/*), 2026-09-28 改为全自动
// 每 5 分钟从本地各链 /positions 缓存 + /pnl 报告里把「自有钱包」的资金与盈亏记一个点:
//   钱包余额 idle、LP 现值 lp (含待领费)、待领费 fees、活跃仓开仓成本 cost、未实现盈亏 np、
//   已实现盈亏 realized (已关闭仓 净利润合计)、累计已领手续费 collected、净入金 netIn (rh 初始资金回溯, 其它链 null)
// 三档保留: m5 (5 分钟级, 24 小时) / hourly (每小时最后一点, 30 天) / days (每日最后一点 = 日切, 永久; 兼容旧 days 记录)
// 没有开关以外的设置: 不用设时间, 不用手动拍; 范围 = 管理钱包里标「自有」的钱包 (snapshot-config.wallets.<chain> 可例外覆盖)
// 2026-10-02: 已实现 / 手续费累计按账本时间线回写历史点 (restate): 账本修正不再算成当天收益
const fs = require('fs');
const path = require('path');
const http = require('http');

const CFG_FILE = process.env.SNAPSHOT_CFG_FILE || path.join(__dirname, 'snapshot-config.json');
const DATA_FILE = process.env.SNAPSHOT_DATA_FILE || path.join(__dirname, 'snapshots.json');
const PORT = parseInt(process.env.PORT || '1788');

const CHAIN_API = { bsc: '/api', sol: '/api/sol', eth: '/api/eth', rh: '/api/rh', base: '/api/base', arc: '/api/arc' };
const CHAINS = Object.keys(CHAIN_API);
const DEFAULT_CFG = { enabled: true, tz: 'Asia/Shanghai', wallets: {}, observe: true };   // observe: 观察钱包也记 (小时级 + 日级)
const TICK_MS = 5 * 60 * 1000;
const M5_KEEP_MS = 24 * 3600 * 1000;
const HOURLY_KEEP_MS = 30 * 86400000;
const STALE_MS = 12 * 60 * 1000;   // 链缓存超过这个年龄: 记录上打 stale 标 (数据照记)
const KEYS = ['lp', 'idle', 'total', 'fees', 'cost', 'np', 'realized', 'collected', 'netIn'];

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data, pretty) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  try { fs.chmodSync(tmp, 0o600); } catch {}   // 2026-09-28 审计修复: 落盘 600 (快照含钱包地址与资产明细, 不给同机其他用户读)
  fs.renameSync(tmp, file);
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; } }
function loadCfg() {
  const c = { ...DEFAULT_CFG, ...readJson(CFG_FILE, {}) };
  if (!validTz(c.tz)) c.tz = DEFAULT_CFG.tz;
  if (!c.wallets || typeof c.wallets !== 'object') c.wallets = {};
  c.enabled = c.enabled !== false;
  c.observe = c.observe !== false;
  delete c.time;
  return c;
}
function loadData() {
  const d = readJson(DATA_FILE, {});
  if (!d.days || typeof d.days !== 'object') d.days = {};
  if (!Array.isArray(d.m5)) d.m5 = [];
  if (!Array.isArray(d.hourly)) d.hourly = [];
  if (!d.obs || typeof d.obs !== 'object') d.obs = { hourly: [], days: {} };
  if (!Array.isArray(d.obs.hourly)) d.obs.hourly = [];
  if (!d.obs.days || typeof d.obs.days !== 'object') d.obs.days = {};
  delete d.latest;   // 旧「最新」行: 现在 days[今天] 就是最新
  return d;
}
function saveData(d) { writeJson(DATA_FILE, d); }
function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function localParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {}; for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, hour: `${p.year}-${p.month}-${p.day} ${p.hour}` };
}
function normAddr(chain, a) { return chain === 'sol' ? String(a) : String(a).toLowerCase(); }
// 该链的钱包记录 (启用的)
function chainWallets(chain) {
  const file = chain === 'bsc' ? 'wallets.json' : `wallets-${chain}.json`;
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8')).filter(w => w.enabled !== false); } catch { return []; }
}
function ownAddrs(chain) { return chainWallets(chain).filter(w => w.own === true).map(w => w.address); }      // 自有 (wallets.<chain> 未设置时的默认快照范围)
function obsAddrs(chain) { return chainWallets(chain).filter(w => w.own !== true).map(w => w.address); }      // 观察 (别人的)
function fetchLocal(pathname, timeoutMs = 60 * 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: timeoutMs }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`)); try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 一条链: 按范围汇总各钱包 { name, lp, idle, total, fees, cost, np, realized, collected, netIn, active, inRange }
// prevChain = 上一条 entry 里该链的汇总 (chains[chain]); 某钱包 /pnl 失败时沿用它的 realized/collected (2026-09-28)
// tls = Map「链:钱包」→ 时间线 (可省): 本轮报告完整的钱包登记进去, 供 restate 回写历史点
async function summarizeChain(chain, data, sel, prevChain, tls) {
  if (!data || !Array.isArray(data.wallets)) return null;
  const allow = new Set(sel.map(a => normAddr(chain, a)));
  if (!allow.size) return null;
  const wallets = {};
  const get = (addr, name) => {
    const k = normAddr(chain, addr);
    if (!wallets[k]) wallets[k] = { name: name || k.slice(0, 8), lp: 0, idle: 0, total: 0, fees: 0, cost: 0, np: 0, realized: 0, collected: 0, netIn: null, active: 0, inRange: 0 };
    else if (name && !wallets[k].name) wallets[k].name = name;
    return wallets[k];
  };
  for (const w of data.wallets) {
    if (!allow.has(normAddr(chain, w.address))) continue;
    const e = get(w.address, w.name);
    e.lp += w.totalUSD || 0;
    for (const p of (w.positions || [])) {
      e.fees += p.feesValueUSD || 0;
      if (p.liquidityActive) { e.active++; if (p.inRange) e.inRange++; if (p.costBasisUSD > 0) { e.cost += p.costBasisUSD; e.np += p.netProfitUSD || 0; } }
    }
  }
  if (data.idle && data.idle.byWallet) {
    for (const [addr, w] of Object.entries(data.idle.byWallet)) {
      if (!allow.has(normAddr(chain, addr))) continue;
      const e = get(addr, w.name);
      e.idle += w.totalUSD || 0;
      if (w.funding && typeof w.funding.netUSD === 'number' && !w.funding.partial) e.netIn = w.funding.netUSD;
    }
  }
  // 已实现盈亏 / 累计已领费: 各钱包 /pnl 报告 (全在内存, 便宜)
  const pnlStale = [];
  for (const addr of sel) {
    const k = normAddr(chain, addr);
    if (!wallets[k]) continue;
    try {
      const rep = await fetchLocal(`${CHAIN_API[chain]}/pnl?wallet=${encodeURIComponent(addr)}`, 30000);
      let realized = 0, collected = 0, any = false;
      for (const r of (rep.positions || [])) {
        if (r.status !== 'active' && typeof r.netProfitUSD === 'number' && Math.abs(r.netProfitUSD) < 1e9) { realized += r.netProfitUSD; any = true; }
        if (typeof r.collectedFeesUSD === 'number' && r.collectedFeesUSD < 1e9) collected += r.collectedFeesUSD;
      }
      wallets[k].realized = any ? realized : 0;
      wallets[k].collected = collected;
      if (tls) { const tl = timelineOf(rep); if (tl) tls.set(`${chain}:${k}`, tl); }
      if (wallets[k].netIn == null && rep.funding && typeof rep.funding.netUSD === 'number' && !rep.funding.partial) wallets[k].netIn = rep.funding.netUSD;
    } catch (e) {
      // 2026-09-28 审计修复: /pnl 失败不再静默记 0 (已实现盈亏曲线会掉零): 沿用上一点该钱包的 realized/collected(/netIn) 并标 pnlStale。
      //   cost/np 来自本轮 /positions 的活跃仓字段, 与 /pnl 无关, 保留本轮值不用旧的
      const pw = prevChain && prevChain.wallets && prevChain.wallets[k];
      if (pw) {
        wallets[k].realized = Number(pw.realized) || 0;
        wallets[k].collected = Number(pw.collected) || 0;
        if (wallets[k].netIn == null && pw.netIn != null) wallets[k].netIn = pw.netIn;
      }
      pnlStale.push(k);
      console.warn(`[snapshot] ${chain} ${k.slice(0, 10)} /pnl 失败 (${e.message}): ${pw ? '沿用上一点' : '无上一点, 记 0'}`);
    }
  }
  const sum = { lp: 0, idle: 0, total: 0, fees: 0, cost: 0, np: 0, realized: 0, collected: 0, netIn: null, active: 0, inRange: 0, n: 0 };
  for (const e of Object.values(wallets)) {
    e.total = e.lp + e.idle;
    for (const k of ['lp', 'idle', 'total', 'fees', 'cost', 'np', 'realized', 'collected']) { e[k] = round2(e[k]); sum[k] += e[k]; }
    if (e.netIn != null) { e.netIn = round2(e.netIn); sum.netIn = (sum.netIn || 0) + e.netIn; }
    sum.active += e.active; sum.inRange += e.inRange; sum.n++;
  }
  for (const k of ['lp', 'idle', 'total', 'fees', 'cost', 'np', 'realized', 'collected']) sum[k] = round2(sum[k]);
  if (sum.netIn != null) sum.netIn = round2(sum.netIn);
  const out = { ...sum, dataTs: data.timestamp || 0, wallets };
  if (pnlStale.length) out.pnlStale = pnlStale;   // 2026-09-28 审计修复: 本链 /pnl 失败、沿用了上一点的钱包
  return out;
}

let running = null, lastError = null, lastTs = 0;
async function takeSnapshot() {
  if (running) return running;
  running = _take().finally(() => { running = null; });
  return running;
}
async function _take() {
  const cfg = loadCfg();
  const posData = {};   // 每链 /positions 只拉一次, 两个作用域共用
  for (const ch of CHAINS) {
    try { posData[ch] = await fetchLocal(CHAIN_API[ch] + '/positions'); }
    catch (e) { posData[ch] = null; console.warn(`[snapshot] ${ch} /positions 拉取失败: ${e.message}`); }
  }
  // 「上一条」只用来沿用失败链 / 失败钱包的数值: 自有取最近的 m5 (退而 hourly / days), 观察取最近的 obs.hourly (退而 obs.days)
  const before = loadData();
  const tls = new Map();   // 本轮各钱包的账本时间线 (两个作用域共用: 同一钱包的报告与作用域无关)
  const own = await collect(cfg, posData, ch => Array.isArray(cfg.wallets[ch]) ? cfg.wallets[ch] : ownAddrs(ch), lastEntry(before.m5, before.hourly, before.days), tls);
  // 观察钱包: 小时级 + 日级 (5 分钟级省掉), 字段一样 (余额也查; 开了账本的还有盈亏)
  const obs = cfg.observe ? await collect(cfg, posData, ch => obsAddrs(ch), lastEntry(before.obs.hourly, [], before.obs.days), tls) : null;
  if (!own && !obs) throw new Error('没有可记录的钱包 (没有标「自有」的钱包, 观察钱包也没数据)');
  const ts = Date.now();
  const lp = localParts(ts, cfg.tz);
  // 2026-09-28 审计修复: 所有 await 结束后才 loadData→改→saveData (中间无 await), 与 DELETE /day/:date 的 load→save 不再交错,
  //   不会把刚删掉的日子从旧底稿里写回 (原先 loadData 在 obs 那次 await 之前, 有丢更新窗口)
  const data = loadData();
  let result = null;
  if (own) {
    const entry = { ts, date: lp.date, time: lp.hm, tz: cfg.tz, ...own };
    data.m5.push(entry);
    data.m5 = data.m5.filter(e => ts - e.ts <= M5_KEEP_MS);
    const hk = lp.hour, hi = data.hourly.findIndex(e => e._h === hk), he = { ...entry, _h: hk };
    if (hi >= 0) data.hourly[hi] = he; else data.hourly.push(he);
    data.hourly = data.hourly.filter(e => ts - e.ts <= HOURLY_KEEP_MS);
    if (dayWritable(data.days[lp.date], entry)) data.days[lp.date] = { ...entry, mode: 'auto' };
    result = { ...entry, mode: 'auto' };
  }
  if (obs) {
    const entry = { ts, date: lp.date, time: lp.hm, tz: cfg.tz, ...obs };
    const hk = lp.hour, hi = data.obs.hourly.findIndex(e => e._h === hk), he = { ...entry, _h: hk };
    if (hi >= 0) data.obs.hourly[hi] = he; else data.obs.hourly.push(he);
    data.obs.hourly = data.obs.hourly.filter(e => ts - e.ts <= HOURLY_KEEP_MS);
    if (dayWritable(data.obs.days[lp.date], entry)) data.obs.days[lp.date] = { ...entry, mode: 'auto' };
    if (!result) result = { ...entry, mode: 'auto' };
  }
  const rs = restate([data.m5, data.hourly, Object.values(data.days), data.obs.hourly, Object.values(data.obs.days)], tls);
  if (rs.length) console.log(`[snapshot] 历史回写 (账本时间线): ${rs.join('; ')}`);
  saveData(data);
  lastError = null; lastTs = ts;
  return result;
}
// 2026-09-28 审计修复: 日切记录只让「完整」点覆盖 —— 本轮有 carried (沿用) 的点不覆盖当日已有的完整记录 (只进 m5/hourly);
//   当日还没记录、或已有的那条本身也是 carried 时才写
function dayWritable(existing, entry) {
  if (!(entry.carried && entry.carried.length)) return true;
  if (!existing) return true;
  return !!(existing.carried && existing.carried.length);
}
// 该作用域最近的一条 entry (按 ts 最大): 先 5 分钟级, 再小时级, 再日级 (只认新版带 chains 的记录)
function lastEntry(m5, hourly, days) {
  const pick = arr => (Array.isArray(arr) && arr.length) ? arr.reduce((a, b) => (((b && b.ts) || 0) > ((a && a.ts) || 0) ? b : a)) : null;
  return pick(m5) || pick(hourly) || pick(Object.values(days || {}).filter(e => e && e.chains)) || null;
}
// 按作用域汇总各链: selOf(chain) 给该链的钱包地址列表; prev = 该作用域上一条 entry (沿用用, 可 null)
// 返回 { lp, idle, ..., chains, failed?, stale?, carried?, pnlStale? } 或 null (一个钱包都没有)
async function collect(cfg, posData, selOf, prev, tls) {
  const chains = {}, failed = [], stale = [], carried = [];
  const tot = { lp: 0, idle: 0, total: 0, fees: 0, cost: 0, np: 0, realized: 0, collected: 0, netIn: null, active: 0, inRange: 0, n: 0 };
  const prevChains = (prev && prev.chains && typeof prev.chains === 'object') ? prev.chains : {};
  const addTot = s => {
    for (const k of ['lp', 'idle', 'total', 'fees', 'cost', 'np', 'realized', 'collected', 'active', 'inRange', 'n']) tot[k] += Number(s[k]) || 0;
    if (s.netIn != null) tot.netIn = (tot.netIn || 0) + s.netIn;
  };
  for (const ch of CHAINS) {
    const sel = selOf(ch);
    if (!sel.length) continue;
    const d = posData[ch];
    // 2026-09-28 审计修复: 整链拉取失败 (null / 非 2xx) 或本作用域有钱包本轮抓取失败 (载荷 failedWallets / 钱包对象 _stale)
    //   => 该链沿用上一条 entry 的数值并记 carried (原先整链失败直接不计, 总资产曲线瞬间掉一条链; 部分失败则把沿用的旧仓位当新数据记)
    const broken = d ? failedInSel(ch, d, sel) : [];
    if (!d) failed.push(ch);   // failed 标保留: 链整体不可达
    if (!d || broken.length) {
      const pc = prevChains[ch];
      if (pc) {
        const { stale: _omit, ...copy } = pc;   // 上一条的 stale 分钟数不再适用
        const s = { ...copy, carried: true, carriedFrom: pc.carriedFrom || (prev && prev.ts) || 0 };
        if (broken.length) s.failedWallets = broken;
        chains[ch] = s; carried.push(ch); addTot(s);
        continue;
      }
      if (!d) continue;   // 整链失败且无上一条可沿用: 只能不计 (与原先一致)
      // 部分钱包失败且无上一条: 只好按载荷尽力汇总 (失败钱包带的是上轮仓位), 仍记 carried 提示不新鲜
    }
    const s = await summarizeChain(ch, d, sel, prevChains[ch], tls);
    if (!s || !s.n) continue;
    if (broken.length) { s.carried = true; s.failedWallets = broken; carried.push(ch); }
    const ageMin = Math.round((Date.now() - (s.dataTs || 0)) / 60000);
    if (ageMin * 60000 > STALE_MS) { s.stale = ageMin; stale.push(ch); }
    chains[ch] = s;
    addTot(s);
  }
  if (!Object.keys(chains).length) return null;
  const entry = {};
  for (const k of KEYS) entry[k] = tot[k] == null ? null : round2(tot[k]);
  entry.active = tot.active; entry.inRange = tot.inRange; entry.n = tot.n; entry.chains = chains;
  if (failed.length) entry.failed = failed;
  if (stale.length) entry.stale = stale;
  if (carried.length) entry.carried = carried;
  // 2026-09-28 审计修复: 某钱包 /pnl 失败沿用了上一点 => 顶层 pnlStale: ["<chain>:<addr>", ...] (m5 精简版也带, 前端打标)
  const pnlStale = [];
  for (const [ch, s] of Object.entries(chains)) for (const a of (s.pnlStale || [])) pnlStale.push(`${ch}:${a}`);
  if (pnlStale.length) entry.pnlStale = pnlStale;
  return entry;
}
// 2026-10-02: 历史回写 —— 账本修正 / 迟到的账让已关闭仓的净利润、已领手续费变了, 原先整笔差额落在「最新一点」, 当天收益凭空跳一截
//   (例: 当日修了账本, Base 两个早已清空的钱包「今日收益」+580, 实为历史仓位的口径修正)。
//   现每轮用本轮报告的时间线 (平仓时间 + 净利润 / 每笔领费的时间 + 金额) 重算全部历史点该钱包的 realized / collected, 差额回到它真正发生的时刻。
//   幂等: 每次都由时间线直接算, 不累加差额; 报告不完整 (扫描中 / 补扫中 / 缺价) 的钱包不登记, 时间线缺口 (缺平仓时间 / 领费明细对不上合计) 的那一项保留原值。
//   平仓时间与快照点比较用该链 /positions 数据时刻 (dataTs): 数据里还活跃的仓算在未实现里, 不再同时算进已实现
function timelineOf(rep) {
  if (!rep || !rep.ledger || rep.partial || rep.pending || rep.catchingUp || rep.priceMiss) return null;
  let closes = [];
  const fees = [];
  for (const r of (rep.positions || [])) {
    if (r.status !== 'active' && typeof r.netProfitUSD === 'number' && Math.abs(r.netProfitUSD) < 1e9) {
      if (closes && r.closeTs > 0) closes.push([r.closeTs, r.netProfitUSD]); else closes = null;
    }
    if (typeof r.collectedFeesUSD === 'number' && r.collectedFeesUSD < 1e9) {
      const col = r.collectedFeesUSD;
      const lg = Array.isArray(r.feeLog) ? r.feeLog : null;
      const logOk = lg && lg.every(x => Array.isArray(x) && x[0] > 0 && typeof x[1] === 'number') && Math.abs(lg.reduce((a, x) => a + x[1], 0) - col) < 0.01;
      fees.push({ open: r.openTs || 0, close: r.status !== 'active' ? (r.closeTs || 0) : 0, col, log: logOk ? lg : null });
    }
  }
  return { closes, fees };
}
function realizedAt(tl, t) {
  if (!tl.closes) return null;
  let v = 0;
  for (const [ts, x] of tl.closes) if (ts <= t) v += x;
  return v;
}
function collectedAt(tl, t) {
  let v = 0;
  for (const f of tl.fees) {
    if (!f.col) continue;
    if (f.log) {
      if (f.log[f.log.length - 1][0] <= t) v += f.col;   // 全部领完 (与报告合计逐位一致)
      else for (const [ts, x] of f.log) { if (ts > t) break; v += x; }
      continue;
    }
    if (f.close > 0 && f.close <= t) { v += f.col; continue; }
    if (f.open > 0 && f.open > t) continue;
    return null;   // 这个仓在该时点领了多少不知道 → 整个钱包这项保留原值
  }
  return v;
}
// lists: 若干 entry 数组 (m5 / hourly / days / obs.*); 返回改动摘要 [`链:钱包 字段 N 点 (最大 Δ)`]
function restate(lists, tls) {
  const stat = {};
  if (!tls || !tls.size) return [];
  for (const list of lists) for (const e of (list || [])) {
    if (!e || !e.chains || typeof e.chains !== 'object' || !(e.ts > 0)) continue;
    let hit = false;
    for (const [ch, s] of Object.entries(e.chains)) {
      if (!s || !s.wallets || typeof s.wallets !== 'object') continue;
      const t = s.dataTs > 0 ? Math.min(s.dataTs, e.ts) : e.ts;
      let chHit = false;
      for (const [k, w] of Object.entries(s.wallets)) {
        const tl = tls.get(`${ch}:${k}`);
        if (!tl || !w) continue;
        chHit = true;
        for (const [f, v] of [['realized', realizedAt(tl, t)], ['collected', collectedAt(tl, t)]]) {
          if (v == null) continue;
          const nv = round2(v), d = round2(nv - (Number(w[f]) || 0));
          if (!d) continue;
          w[f] = nv;
          const x = stat[`${ch}:${k.slice(0, 10)} ${f}`] || (stat[`${ch}:${k.slice(0, 10)} ${f}`] = { n: 0, max: 0 });
          x.n++; if (Math.abs(d) > Math.abs(x.max)) x.max = d;
        }
      }
      if (chHit) { for (const f of ['realized', 'collected']) s[f] = round2(Object.values(s.wallets).reduce((a, w) => a + (Number(w && w[f]) || 0), 0)); hit = true; }
    }
    // 链汇总 / 顶层总数一律由下层重加 (同一点的 hourly / days 与 m5 共用 chains 对象, 不能只在「本条有改动」时才重算)
    if (hit) for (const f of ['realized', 'collected']) e[f] = round2(Object.values(e.chains).reduce((a, s) => a + (Number(s && s[f]) || 0), 0));
  }
  return Object.entries(stat).map(([k, x]) => `${k} ${x.n} 点 (最大 Δ ${x.max > 0 ? '+' : ''}${x.max})`);
}
// 载荷里「本轮抓取失败」且落在本作用域的钱包: 顶层 failedWallets (EVM 小写 / SOL base58) 或钱包对象 _stale: true
function failedInSel(chain, d, sel) {
  const allow = new Set(sel.map(a => normAddr(chain, a)));
  const bad = new Set();
  for (const a of (Array.isArray(d.failedWallets) ? d.failedWallets : [])) { const k = normAddr(chain, a); if (allow.has(k)) bad.add(k); }
  for (const w of (Array.isArray(d.wallets) ? d.wallets : [])) { if (w && w._stale === true) { const k = normAddr(chain, w.address || ''); if (allow.has(k)) bad.add(k); } }
  return [...bad];
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const cfg = loadCfg();
    if (!cfg.enabled) return;
    const e = await takeSnapshot();
    console.log(`[snapshot] ${e.date} ${e.time}: total $${e.total} (lp $${e.lp} + idle $${e.idle}), np $${e.np}, realized $${e.realized}, chains=${Object.keys(e.chains || {}).join(',')}${e.stale ? ' stale=' + e.stale.join(',') : ''}${e.failed ? ' failed=' + e.failed.join(',') : ''}${e.carried ? ' carried=' + e.carried.join(',') : ''}${e.pnlStale ? ' pnlStale=' + e.pnlStale.length : ''}`);   // 2026-09-28 审计修复: 日志带 failed/carried/pnlStale
  } catch (e) { lastError = e.message; console.error('[snapshot] 记录失败:', e.message); }
  finally { ticking = false; }
}

function statusPayload() {
  const cfg = loadCfg();
  const data = loadData();
  const keys = Object.keys(data.days).sort();
  const lastKey = keys[keys.length - 1];
  const today = localParts(Date.now(), cfg.tz).date;
  return {
    enabled: cfg.enabled, observe: cfg.observe, tz: cfg.tz, wallets: cfg.wallets, intervalMin: TICK_MS / 60000,
    obsDays: Object.keys(data.obs.days).length,
    lastRun: lastKey ? { date: lastKey, ts: data.days[lastKey].ts, mode: data.days[lastKey].mode } : null,
    lastTs: lastTs || (lastKey ? data.days[lastKey].ts : null), todayPoints: data.m5.filter(e => e.date === today).length,
    totalDays: keys.length, today, running: !!running, lastError,
  };
}

function mountSnapshot(app, adminGuard) {
  app.get('/api/snapshot/config', (req, res) => res.json(statusPayload()));
  app.post('/api/snapshot/config', adminGuard, (req, res) => {
    const body = req.body || {};
    const cur = loadCfg();
    const next = { enabled: body.enabled !== false, observe: body.observe === undefined ? cur.observe : body.observe !== false, tz: cur.tz, wallets: {} };
    if (body.tz !== undefined) { if (!validTz(body.tz)) return res.status(400).json({ error: '无效时区' }); next.tz = body.tz; }
    const src = (body.wallets && typeof body.wallets === 'object') ? body.wallets : cur.wallets;
    for (const [ch, arr] of Object.entries(src)) { if (!CHAINS.includes(ch)) continue; if (Array.isArray(arr)) next.wallets[ch] = arr.slice(0, 60).map(a => String(a).slice(0, 64)); }
    try { writeJson(CFG_FILE, next, true); } catch (e) { console.error('[snapshot] 配置写入失败:', e.message); return res.status(500).json({ error: '写入失败, 请查看服务日志' }); }   // 2026-09-28 审计修复: 不回显文件路径
    console.log(`[snapshot] config saved: enabled=${next.enabled}, overrides=${Object.keys(next.wallets).join(',') || '(none, 跟随自有)'}`);
    res.json(statusPayload());
  });
  // 列表: days (全部) + hourly (30d) + m5 (24h); 明细 (chains.wallets) 只随 days/hourly 带, m5 精简为总量以省流量
  app.get('/api/snapshot/list', (req, res) => {
    const data = loadData();
    const keys = Object.keys(data.days).sort();
    const days = keys.map(k => data.days[k]);
    // 2026-09-28 审计修复: m5 只剥 chains, 顶层 failed/stale/carried/pnlStale 原样带出 (days/hourly 整条带, 含 chains[ch].carried/failedWallets/pnlStale)
    const m5 = data.m5.map(e => { const { chains, ...rest } = e; return rest; });
    // 观察作用域: 日级全部 + 小时级只带最近 7 天 (钱包多, 省流量)
    const okeys = Object.keys(data.obs.days).sort();
    const obs = { days: okeys.map(k => data.obs.days[k]), hourly: data.obs.hourly.filter(e => Date.now() - e.ts <= 7 * 86400000) };
    res.json({ days, hourly: data.hourly, m5, obs, totalDays: keys.length, ...statusPayload() });
  });
  app.post('/api/snapshot/now', adminGuard, async (req, res) => {
    try { res.json(await takeSnapshot()); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/snapshot/day/:date', adminGuard, (req, res) => {
    const d = String(req.params.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: '日期格式须为 YYYY-MM-DD' });
    const data = loadData();
    if (!data.days[d]) return res.status(404).json({ error: '该日无快照' });
    delete data.days[d]; saveData(data);
    res.json({ ok: true, totalDays: Object.keys(data.days).length });
  });
  setInterval(tick, TICK_MS);
  setTimeout(tick, 150 * 1000);   // 启动 150s 后首记 (给各链缓存预热留时间)
  console.log('Snapshot mounted (/api/snapshot/*), 每 5 分钟自动记录自有钱包资金与盈亏');
}

module.exports = { mountSnapshot, _test: { takeSnapshot, summarizeChain, collect, dayWritable, lastEntry, failedInSel, localParts, loadCfg, loadData, tick, statusPayload, timelineOf, realizedAt, collectedAt, restate } };
