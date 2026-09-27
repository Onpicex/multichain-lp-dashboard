// snapshot.js — 资金快照 (/api/snapshot/*), 2026-09-28 改为全自动
// 每 5 分钟从本地各链 /positions 缓存 + /pnl 报告里把「自有钱包」的资金与盈亏记一个点:
//   钱包余额 idle、LP 现值 lp (含待领费)、待领费 fees、活跃仓开仓成本 cost、未实现盈亏 np、
//   已实现盈亏 realized (已关闭仓 净利润合计)、累计已领手续费 collected、净入金 netIn (rh 初始资金回溯, 其它链 null)
// 三档保留: m5 (5 分钟级, 24 小时) / hourly (每小时最后一点, 30 天) / days (每日最后一点 = 日切, 永久; 兼容旧 days 记录)
// 没有开关以外的设置: 不用设时间, 不用手动拍; 范围 = 管理钱包里标「自有」的钱包 (snapshot-config.wallets.<chain> 可例外覆盖)
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
function writeJson(file, data, pretty) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)); fs.renameSync(tmp, file); }
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
async function summarizeChain(chain, data, sel) {
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
      if (wallets[k].netIn == null && rep.funding && typeof rep.funding.netUSD === 'number' && !rep.funding.partial) wallets[k].netIn = rep.funding.netUSD;
    } catch {}
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
  return { ...sum, dataTs: data.timestamp || 0, wallets };
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
  for (const ch of CHAINS) { try { posData[ch] = await fetchLocal(CHAIN_API[ch] + '/positions'); } catch { posData[ch] = null; } }
  const own = await collect(cfg, posData, ch => Array.isArray(cfg.wallets[ch]) ? cfg.wallets[ch] : ownAddrs(ch));
  const ts = Date.now();
  const lp = localParts(ts, cfg.tz);
  const data = loadData();
  if (own) {
    const entry = { ts, date: lp.date, time: lp.hm, tz: cfg.tz, ...own };
    data.m5.push(entry);
    data.m5 = data.m5.filter(e => ts - e.ts <= M5_KEEP_MS);
    const hk = lp.hour, hi = data.hourly.findIndex(e => e._h === hk), he = { ...entry, _h: hk };
    if (hi >= 0) data.hourly[hi] = he; else data.hourly.push(he);
    data.hourly = data.hourly.filter(e => ts - e.ts <= HOURLY_KEEP_MS);
    data.days[lp.date] = { ...entry, mode: 'auto' };
  }
  // 观察钱包: 小时级 + 日级 (5 分钟级省掉), 字段一样 (余额也查; 开了账本的还有盈亏)
  if (cfg.observe) {
    const obs = await collect(cfg, posData, ch => obsAddrs(ch));
    if (obs) {
      const entry = { ts, date: lp.date, time: lp.hm, tz: cfg.tz, ...obs };
      const hk = lp.hour, hi = data.obs.hourly.findIndex(e => e._h === hk), he = { ...entry, _h: hk };
      if (hi >= 0) data.obs.hourly[hi] = he; else data.obs.hourly.push(he);
      data.obs.hourly = data.obs.hourly.filter(e => ts - e.ts <= HOURLY_KEEP_MS);
      data.obs.days[lp.date] = { ...entry, mode: 'auto' };
    }
  }
  if (!own && !(cfg.observe && data.obs.days[lp.date] && data.obs.days[lp.date].ts === ts)) throw new Error('没有可记录的钱包 (没有标「自有」的钱包, 观察钱包也没数据)');
  saveData(data);
  lastError = null; lastTs = ts;
  return own ? data.days[lp.date] : data.obs.days[lp.date];
}
// 按作用域汇总各链: selOf(chain) 给该链的钱包地址列表; 返回 { lp, idle, ..., chains } 或 null (一个钱包都没有)
async function collect(cfg, posData, selOf) {
  const chains = {}, failed = [], stale = [];
  const tot = { lp: 0, idle: 0, total: 0, fees: 0, cost: 0, np: 0, realized: 0, collected: 0, netIn: null, active: 0, inRange: 0, n: 0 };
  for (const ch of CHAINS) {
    const sel = selOf(ch);
    if (!sel.length) continue;
    const d = posData[ch];
    if (!d) { failed.push(ch); continue; }
    const s = await summarizeChain(ch, d, sel);
    if (!s || !s.n) continue;
    const ageMin = Math.round((Date.now() - (s.dataTs || 0)) / 60000);
    if (ageMin * 60000 > STALE_MS) { s.stale = ageMin; stale.push(ch); }
    chains[ch] = s;
    for (const k of ['lp', 'idle', 'total', 'fees', 'cost', 'np', 'realized', 'collected', 'active', 'inRange', 'n']) tot[k] += s[k];
    if (s.netIn != null) tot.netIn = (tot.netIn || 0) + s.netIn;
  }
  if (!Object.keys(chains).length) return null;
  const entry = {};
  for (const k of KEYS) entry[k] = tot[k] == null ? null : round2(tot[k]);
  entry.active = tot.active; entry.inRange = tot.inRange; entry.n = tot.n; entry.chains = chains;
  if (failed.length) entry.failed = failed;
  if (stale.length) entry.stale = stale;
  return entry;
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const cfg = loadCfg();
    if (!cfg.enabled) return;
    const e = await takeSnapshot();
    console.log(`[snapshot] ${e.date} ${e.time}: total $${e.total} (lp $${e.lp} + idle $${e.idle}), np $${e.np}, realized $${e.realized}, chains=${Object.keys(e.chains || {}).join(',')}${e.stale ? ' stale=' + e.stale.join(',') : ''}`);
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
    try { writeJson(CFG_FILE, next, true); } catch (e) { return res.status(500).json({ error: '写入失败: ' + e.message }); }
    console.log(`[snapshot] config saved: enabled=${next.enabled}, overrides=${Object.keys(next.wallets).join(',') || '(none, 跟随自有)'}`);
    res.json(statusPayload());
  });
  // 列表: days (全部) + hourly (30d) + m5 (24h); 明细 (chains.wallets) 只随 days/hourly 带, m5 精简为总量以省流量
  app.get('/api/snapshot/list', (req, res) => {
    const data = loadData();
    const keys = Object.keys(data.days).sort();
    const days = keys.map(k => data.days[k]);
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

module.exports = { mountSnapshot, _test: { takeSnapshot, summarizeChain, localParts, loadCfg, loadData, tick, statusPayload } };
