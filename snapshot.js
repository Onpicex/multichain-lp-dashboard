// snapshot.js — 资金每日快照 (/api/snapshot/*)
// 独立于前端访问运行: 每天到点(默认 00:05 Asia/Shanghai)读一次本地各链 /positions 缓存,
// 把「钱包余额(闲置) + LP 价值」按钱包落盘到 snapshots.json, 供「资金快照」页看每日增减。
// 数据来源与总览统计条同口径: lp = wallets[].totalUSD(含待领费), idle = idle.byWallet[].totalUSD
// (idle 只对「钱包资金查询」勾选的钱包存在; 未勾选的钱包只记 LP)。
// 配置 snapshot-config.json: { enabled, time:'HH:MM', tz, wallets:{<chain>: [addrs]} }
//   wallets.<chain> 未设置 = 该链全部钱包参与; [] = 全不参与; 数组 = 勾选子集 (与 fund-config 同语义)
// 到点时链缓存若超过 FRESH_MS 会先踢后台刷新并等待, 超时则用旧数据并打 stale 标记, 绝不空过一天。
const fs = require('fs');
const path = require('path');
const http = require('http');

const CFG_FILE = process.env.SNAPSHOT_CFG_FILE || path.join(__dirname, 'snapshot-config.json');
const DATA_FILE = process.env.SNAPSHOT_DATA_FILE || path.join(__dirname, 'snapshots.json');
const PORT = parseInt(process.env.PORT || '1788');

const CHAIN_API = { bsc: '/api', sol: '/api/sol', eth: '/api/eth', rh: '/api/rh', base: '/api/base' };
const CHAINS = Object.keys(CHAIN_API);
const DEFAULT_CFG = { enabled: true, time: '00:05', tz: 'Asia/Shanghai', wallets: {} };
const FRESH_MS = 12 * 60 * 1000;   // 链缓存年龄门槛: 超过则等一轮后台刷新
const WAIT_MS = 6 * 60 * 1000;     // 定时快照最多等待刷新的时间
const POLL_MS = 30 * 1000;
const LATE_MIN = 30;               // 晚于计划时间 30min 以上的补拍打 late 标记
const KEEP_DAYS = 730;
const TICK_MS = 60 * 1000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data, pretty) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function validTime(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')); }
function validTz(tz) { try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; } }
function loadCfg() {
  const c = { ...DEFAULT_CFG, ...readJson(CFG_FILE, {}) };
  if (!validTime(c.time)) c.time = DEFAULT_CFG.time;
  if (!validTz(c.tz)) c.tz = DEFAULT_CFG.tz;
  if (!c.wallets || typeof c.wallets !== 'object') c.wallets = {};
  c.enabled = c.enabled !== false;
  return c;
}
function loadData() {
  const d = readJson(DATA_FILE, {});
  if (!d.days || typeof d.days !== 'object') d.days = {};
  if (d.latest && typeof d.latest !== 'object') d.latest = null;
  return d;
}
function saveData(d) {
  // 只留最近 KEEP_DAYS 天
  const keys = Object.keys(d.days).sort();
  if (keys.length > KEEP_DAYS) for (const k of keys.slice(0, keys.length - KEEP_DAYS)) delete d.days[k];
  writeJson(DATA_FILE, d);
}

// 时区内的 日期 / HH:MM
function localParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  for (const x of f.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
function hmToMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }

function normAddr(chain, a) { return chain === 'sol' ? String(a) : String(a).toLowerCase(); }

function fetchLocal(pathname, timeoutMs = 90 * 1000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 从一条链的 /positions 缓存里按勾选汇总; 返回 null 表示该链无数据
function summarizeChain(chain, data, sel) {
  if (!data || !Array.isArray(data.wallets)) return null;
  const allow = Array.isArray(sel) ? new Set(sel.map(a => normAddr(chain, a))) : null;
  const wallets = {};
  const get = (addr, name) => {
    const k = normAddr(chain, addr);
    if (!wallets[k]) wallets[k] = { name: name || k.slice(0, 8), lp: 0, idle: 0, total: 0, fees: 0, active: 0, inRange: 0 };
    else if (name && !wallets[k].name) wallets[k].name = name;
    return wallets[k];
  };
  for (const w of data.wallets) {
    if (allow && !allow.has(normAddr(chain, w.address))) continue;
    const e = get(w.address, w.name);
    e.lp += w.totalUSD || 0;
    for (const p of (w.positions || [])) {
      e.fees += p.feesValueUSD || 0;
      if (p.liquidityActive) { e.active++; if (p.inRange) e.inRange++; }
    }
  }
  if (data.idle && data.idle.byWallet) {
    for (const [addr, w] of Object.entries(data.idle.byWallet)) {
      if (allow && !allow.has(normAddr(chain, addr))) continue;
      const e = get(addr, w.name);
      e.idle += w.totalUSD || 0;
      if (w.funding && typeof w.funding.netUSD === 'number') e.net = w.funding.netUSD;
    }
  }
  const sum = { lp: 0, idle: 0, total: 0, fees: 0, active: 0, inRange: 0, n: 0 };
  for (const e of Object.values(wallets)) {
    e.total = e.lp + e.idle;
    for (const k of ['lp', 'idle', 'total', 'fees', 'active', 'inRange']) e[k] = round2(e[k]), sum[k] += e[k];
    if (e.net !== undefined) e.net = round2(e.net);
    sum.n++;
  }
  for (const k of ['lp', 'idle', 'total', 'fees']) sum[k] = round2(sum[k]);
  return { ...sum, dataTs: data.timestamp || 0, wallets };
}
function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

let running = null;   // 进行中的快照 Promise (定时/手动共用, 防并发)
let lastError = null;

// mode: 'scheduled' | 'manual'; 定时模式会等待过旧链的后台刷新, 手动模式即拍即走
async function takeSnapshot(opts = {}) {
  if (running) return running;
  running = _takeSnapshot(opts).finally(() => { running = null; });
  return running;
}
async function _takeSnapshot({ mode = 'manual', late = false } = {}) {
  const cfg = loadCfg();
  const started = Date.now();
  const chains = {}, failed = [], stale = [];
  const pending = new Set(CHAINS);
  let deadline = mode === 'scheduled' ? started + WAIT_MS : started;   // 手动: 只取一轮
  const result = {};
  while (pending.size) {
    for (const ch of [...pending]) {
      try {
        const d = await fetchLocal(CHAIN_API[ch] + '/positions');
        result[ch] = d;
        const age = Date.now() - (d.timestamp || 0);
        // 读取本身已触发该链 stale-while-revalidate 后台刷新; 定时模式下过旧就等下一轮再读
        if (age <= FRESH_MS || Date.now() >= deadline) pending.delete(ch);
      } catch (e) {
        result[ch] = { _err: e.message };
        if (Date.now() >= deadline) pending.delete(ch);
      }
    }
    if (pending.size && Date.now() < deadline) await new Promise(r => setTimeout(r, POLL_MS));
    else break;
  }
  const tot = { lp: 0, idle: 0, total: 0, fees: 0, active: 0, inRange: 0, n: 0 };
  for (const ch of CHAINS) {
    const d = result[ch];
    if (!d || d._err) { failed.push(ch); continue; }
    const s = summarizeChain(ch, d, cfg.wallets[ch]);
    if (!s) { failed.push(ch); continue; }
    const ageMin = Math.round((Date.now() - (s.dataTs || 0)) / 60000);
    if (ageMin * 60000 > FRESH_MS) { s.stale = ageMin; stale.push(ch); }
    if (!s.n) continue;   // 该链没有参与快照的钱包(全未勾选/无钱包): 不占位
    chains[ch] = s;
    for (const k of ['lp', 'idle', 'total', 'fees', 'active', 'inRange', 'n']) tot[k] += s[k];
  }
  if (!Object.keys(chains).length && failed.length === CHAINS.length) throw new Error('所有链数据均不可用: ' + failed.join(','));
  const ts = Date.now();
  const lp = localParts(ts, cfg.tz);
  const entry = {
    ts, date: lp.date, time: lp.hm, tz: cfg.tz, mode,
    lp: round2(tot.lp), idle: round2(tot.idle), total: round2(tot.total), fees: round2(tot.fees),
    active: tot.active, inRange: tot.inRange, n: tot.n,
    chains,
  };
  if (late) entry.late = true;
  if (failed.length) entry.failed = failed;
  if (stale.length) entry.stale = stale;
  const data = loadData();
  if (mode === 'scheduled') {
    data.days[entry.date] = entry;            // 定时快照 = 当日正式记录 (覆盖同日手动占位)
  } else {
    data.latest = entry;                      // 手动 = 「最新」, 不覆盖已有的当日正式记录
    if (!data.days[entry.date]) data.days[entry.date] = entry;
  }
  saveData(data);
  lastError = null;
  console.log(`[snapshot] ${mode}${late ? ' (late)' : ''} ${entry.date} ${entry.time}: total $${entry.total} (lp $${entry.lp} + idle $${entry.idle}), chains=${Object.keys(chains).join(',') || '-'}${failed.length ? ' failed=' + failed.join(',') : ''}${stale.length ? ' stale=' + stale.join(',') : ''}`);
  return entry;
}

// --- 调度: 每分钟检查一次, 到点且当日无正式记录就拍 (进程重启/宕机漏拍也会在恢复后补拍) ---
let lastFailAt = 0;
function nextRunInfo(cfg, data) {
  const now = Date.now();
  const p = localParts(now, cfg.tz);
  const due = hmToMin(p.hm) >= hmToMin(cfg.time);
  const todayDone = !!(data.days[p.date] && data.days[p.date].mode === 'scheduled');
  return { today: p.date, due, todayDone };
}
async function tick() {
  try {
    const cfg = loadCfg();
    if (!cfg.enabled || running) return;
    const data = loadData();
    const { today, due, todayDone } = nextRunInfo(cfg, data);
    if (!due || todayDone) return;
    if (Date.now() - lastFailAt < 10 * 60 * 1000) return;   // 失败后 10min 再试
    const p = localParts(Date.now(), cfg.tz);
    const late = hmToMin(p.hm) - hmToMin(cfg.time) > LATE_MIN;
    console.log(`[snapshot] 定时快照开始 ${today}${late ? ' (补拍)' : ''}`);
    await takeSnapshot({ mode: 'scheduled', late });
  } catch (e) {
    lastFailAt = Date.now();
    lastError = e.message;
    console.error('[snapshot] 定时快照失败:', e.message);
  }
}

function mountSnapshot(app, adminGuard) {
  app.get('/api/snapshot/config', (req, res) => res.json(statusPayload()));
  app.post('/api/snapshot/config', adminGuard, (req, res) => {
    const body = req.body || {};
    const cur = loadCfg();
    const next = { enabled: body.enabled !== false, time: cur.time, tz: cur.tz, wallets: {} };
    if (body.time !== undefined) {
      if (!validTime(body.time)) return res.status(400).json({ error: '时间格式须为 HH:MM' });
      next.time = body.time;
    }
    if (body.tz !== undefined) {
      if (!validTz(body.tz)) return res.status(400).json({ error: '无效时区' });
      next.tz = body.tz;
    }
    const src = (body.wallets && typeof body.wallets === 'object') ? body.wallets : cur.wallets;
    for (const [ch, arr] of Object.entries(src)) {
      if (!CHAINS.includes(ch)) continue;
      if (Array.isArray(arr)) next.wallets[ch] = arr.slice(0, 60).map(a => String(a).slice(0, 64));
    }
    try { writeJson(CFG_FILE, next, true); } catch (e) { return res.status(500).json({ error: '写入失败: ' + e.message }); }
    console.log(`[snapshot] config saved: enabled=${next.enabled}, time=${next.time}, chains=${Object.keys(next.wallets).join(',') || '(all default)'}`);
    res.json(statusPayload());
  });
  app.get('/api/snapshot/list', (req, res) => {
    const data = loadData();
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 400, 1), KEEP_DAYS);
    const keys = Object.keys(data.days).sort();
    const days = keys.slice(Math.max(0, keys.length - limit)).map(k => data.days[k]);
    res.json({ days, totalDays: keys.length, latest: data.latest || null, ...statusPayload() });
  });
  app.post('/api/snapshot/now', adminGuard, async (req, res) => {
    if (running) return res.status(409).json({ error: '快照进行中, 请稍候' });
    try { res.json(await takeSnapshot({ mode: 'manual' })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/api/snapshot/day/:date', adminGuard, (req, res) => {
    const d = String(req.params.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: '日期格式须为 YYYY-MM-DD' });
    const data = loadData();
    if (!data.days[d]) return res.status(404).json({ error: '该日无快照' });
    delete data.days[d];
    if (data.latest && data.latest.date === d) data.latest = null;
    saveData(data);
    console.log(`[snapshot] day removed: ${d}`);
    res.json({ ok: true, totalDays: Object.keys(data.days).length });
  });

  setInterval(tick, TICK_MS);
  setTimeout(tick, 90 * 1000);   // 启动 90s 后首查 (给各链缓存预热留时间)
  console.log(`Snapshot mounted (/api/snapshot/*), daily at ${loadCfg().time} ${loadCfg().tz}`);
}

function statusPayload() {
  const cfg = loadCfg();
  const data = loadData();
  const keys = Object.keys(data.days).sort();
  const lastKey = keys[keys.length - 1];
  const { today, todayDone } = nextRunInfo(cfg, data);
  return {
    enabled: cfg.enabled, time: cfg.time, tz: cfg.tz, wallets: cfg.wallets,
    lastRun: lastKey ? { date: lastKey, ts: data.days[lastKey].ts, mode: data.days[lastKey].mode } : null,
    latestTs: data.latest ? data.latest.ts : null,
    totalDays: keys.length, today, todayDone, running: !!running, lastError,
  };
}

module.exports = { mountSnapshot, _test: { takeSnapshot, summarizeChain, localParts, loadCfg, loadData, tick, statusPayload } };
