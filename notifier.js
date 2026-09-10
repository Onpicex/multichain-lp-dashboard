// notifier.js — LP 出区间 Telegram 通知 (哨兵 bot)
// 独立于前端访问运行: 每 intervalMin 分钟读一次本地各链 /positions 缓存(各链自有 10min 自主刷新),
// 对配置里勾选的钱包做 in-range 状态机: 连续 CONFIRM 轮观测到翻转才通知(防区间边界抖动),
// 新钱包/新仓位首见静默基线(挂单仓故意开在区间外, 不该进场就报警), 平仓仓位静默清理。
// 通知失败不翻转状态, 下轮自动重试。渠道: telegram_sentinel_bot(.env TG_BOT_TOKEN/TG_CHAT_ID)。
const fs = require('fs');
const path = require('path');

const CFG_FILE = process.env.NOTIFY_CFG_FILE || path.join(__dirname, 'notify-config.json');
const STATE_FILE = process.env.NOTIFY_STATE_FILE || path.join(__dirname, 'notify-state.json');
const TG_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT = process.env.TG_CHAT_ID || '';
const PORT = parseInt(process.env.PORT || '1788');

// chain → 本地 API 前缀 (与前端 apiBase() 一致)
const CHAIN_API = { bsc: '/api', eth: '/api/eth', rh: '/api/rh', base: '/api/base', sol: '/api/sol', arc: '/api/arc' };
const CHAIN_LABEL = { bsc: 'BSC', eth: 'ETH', rh: 'RH', base: 'Base', sol: 'SOL', arc: 'Arc' };
const CONFIRM = 2;                    // 连续 N 轮同向观测才确认翻转
const STALE_MS = 45 * 60 * 1000;      // 链缓存超过 45min 视为过旧, 本轮跳过该链
const TG_MAX = 3500;                  // 单条消息长度上限(TG 4096 留余量)

const DEFAULT_CFG = { enabled: true, channel: 'sentinel', intervalMin: 5, notifyRecover: true, wallets: {} };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, file);
}
function loadCfg() { return { ...DEFAULT_CFG, ...readJson(CFG_FILE, {}) }; }
function loadState() {
  const st = readJson(STATE_FILE, {});
  if (!st.keys) st.keys = {};       // "<chain>:<addr>:<proto>:<tokenId>" → {out, pend?, n?, ts}
  if (!st.base) st.base = {};       // "<chain>:<addr>" → 1 (已做过静默基线)
  return st;
}

function normAddr(chain, a) { return chain === 'sol' ? String(a) : String(a).toLowerCase(); }

function fmtP(v) {
  if (!v || isNaN(v)) return '?';
  if (v <= 1e-9) return '0';
  if (v >= 1e9) return '∞';
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.0001) return v.toFixed(6);
  return v.toExponential(3);
}

function fmtEvent(chain, walletName, p, out) {
  const pair = `${(p.token0 && p.token0.symbol) || '?'}/${(p.token1 && p.token1.symbol) || '?'}`;
  const head = `${out ? '🔴 出区间' : '🟢 回区间'} [${CHAIN_LABEL[chain] || chain}] ${walletName} ${pair} ${p.protocol || ''} #${p.tokenId}`;
  const cur = p.currentPrice, lo = p.lowerPrice, hi = p.upperPrice;
  let dir = '';
  if (cur > 0 && lo > 0 && hi > 0) {
    if (out) dir = cur < lo ? `\n现价 ${fmtP(cur)} 低于下界 ${fmtP(lo)}` : (cur > hi ? `\n现价 ${fmtP(cur)} 高于上界 ${fmtP(hi)}` : '');
    else dir = `\n现价 ${fmtP(cur)} 回到区间 [${fmtP(lo)} – ${fmtP(hi)}]`;
  }
  const val = p.totalValueUSD > 0 ? `\n仓位价值 $${Math.round(p.totalValueUSD).toLocaleString('en-US')}` : '';
  return head + dir + val;
}

async function sendTg(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[notify] TG 未配置(.env TG_BOT_TOKEN/TG_CHAT_ID), 跳过发送'); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  } catch (e) {
    console.error('[notify] TG 发送失败:', e.message);
    return false;
  }
}

async function sendTgChunked(lines) {
  let buf = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 2 > TG_MAX && buf.length) {
      if (!await sendTg(buf.join('\n\n'))) return false;
      buf = []; len = 0;
    }
    buf.push(line); len += line.length + 2;
  }
  if (buf.length) return sendTg(buf.join('\n\n'));
  return true;
}

let checking = false;
async function check() {
  if (checking) return;
  checking = true;
  try { await _checkInner(); }
  catch (e) { console.error('[notify] 巡检异常:', e.message); }
  finally { checking = false; }
}

async function _checkInner() {
  const cfg = loadCfg();
  const st = loadState();
  st.lastRun = Date.now();
  if (!cfg.enabled) { writeJson(STATE_FILE, st); return; }

  const lines = [];        // 待发送的消息段
  const flips = [];        // 发送成功后才落盘的翻转 [{rec, out}]

  for (const [chain, apiBase] of Object.entries(CHAIN_API)) {
    const sel = (cfg.wallets && cfg.wallets[chain]) || [];
    if (!sel.length) continue;
    const selSet = new Set(sel.map(a => normAddr(chain, a)));

    let data;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${apiBase}/positions`, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (e) {
      console.error(`[notify] ${chain} 拉取失败:`, e.message);
      continue;
    }
    if (!data || !Array.isArray(data.wallets)) continue;
    if (data.timestamp && Date.now() - data.timestamp > STALE_MS) {
      console.log(`[notify] ${chain} 缓存过旧(${Math.round((Date.now() - data.timestamp) / 60000)}min), 本轮跳过`);
      continue;
    }

    const seen = new Set();
    for (const w of data.wallets) {
      const addr = normAddr(chain, w.address || '');
      if (!selSet.has(addr)) continue;
      const bkey = `${chain}:${addr}`;
      const isBaseline = !st.base[bkey];

      for (const p of (w.positions || [])) {
        if (!p.liquidityActive || typeof p.inRange !== 'boolean') continue;
        const key = `${chain}:${addr}:${p.protocol || ''}:${p.tokenId}`;
        seen.add(key);
        const out = !p.inRange;
        const rec = st.keys[key];
        if (!rec || isBaseline) { st.keys[key] = { out, ts: 0 }; continue; }  // 首见静默基线
        if (out === rec.out) { delete rec.pend; delete rec.n; continue; }     // 状态未变, 清抖动计数
        // 观测到翻转 → 去抖
        if (rec.pend === out) rec.n = (rec.n || 1) + 1;
        else { rec.pend = out; rec.n = 1; }
        if (rec.n >= CONFIRM) {
          if (out || cfg.notifyRecover !== false) {
            lines.push(fmtEvent(chain, w.name || addr, p, out));
            flips.push({ rec, out });
          } else {
            // 回区间但用户关了恢复通知: 静默翻转
            rec.out = out; delete rec.pend; delete rec.n;
          }
        }
      }
      if (isBaseline) st.base[bkey] = 1;
    }
    // 已消失的仓位(平仓/转出)静默清理 — 只清本链已勾选钱包的
    for (const k of Object.keys(st.keys)) {
      if (!k.startsWith(chain + ':')) continue;
      const a = k.split(':')[1];
      if (selSet.has(a) && !seen.has(k)) delete st.keys[k];
    }
  }

  if (lines.length) {
    const ok = await sendTgChunked(lines);
    if (ok) {
      for (const { rec, out } of flips) { rec.out = out; delete rec.pend; delete rec.n; rec.ts = Date.now(); }
      console.log(`[notify] 已通知 ${lines.length} 条区间事件`);
    } else {
      console.log(`[notify] 发送失败, ${lines.length} 条事件保留待下轮重试`);
    }
  }
  writeJson(STATE_FILE, st);
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  const cfg = loadCfg();
  const min = Math.min(120, Math.max(1, parseInt(cfg.intervalMin) || 5));
  timer = setTimeout(async () => { await check(); schedule(); }, min * 60 * 1000);
}

function mountNotifier(app, adminGuard) {
  const status = () => {
    const cfg = loadCfg();
    const st = loadState();
    return {
      enabled: cfg.enabled, channel: cfg.channel, intervalMin: cfg.intervalMin,
      notifyRecover: cfg.notifyRecover, wallets: cfg.wallets,
      channelReady: !!(TG_TOKEN && TG_CHAT),
      lastRun: st.lastRun || 0,
      tracked: Object.keys(st.keys).length,
    };
  };

  app.get('/api/notify/config', (req, res) => res.json(status()));

  app.post('/api/notify/config', adminGuard, (req, res) => {
    const b = req.body || {};
    const cfg = loadCfg();
    if (typeof b.enabled === 'boolean') cfg.enabled = b.enabled;
    if (typeof b.notifyRecover === 'boolean') cfg.notifyRecover = b.notifyRecover;
    if (b.intervalMin !== undefined) {
      const m = parseInt(b.intervalMin);
      if (!Number.isFinite(m) || m < 1 || m > 120) return res.status(400).json({ error: 'intervalMin 须为 1-120' });
      cfg.intervalMin = m;
    }
    if (b.wallets !== undefined) {
      if (typeof b.wallets !== 'object' || Array.isArray(b.wallets)) return res.status(400).json({ error: 'wallets 格式错误' });
      const w = {};
      for (const [chain, arr] of Object.entries(b.wallets)) {
        if (!CHAIN_API[chain]) continue;
        if (!Array.isArray(arr)) return res.status(400).json({ error: `wallets.${chain} 须为数组` });
        const clean = [...new Set(arr.filter(a => typeof a === 'string' && a.length > 0 && a.length <= 64).map(a => normAddr(chain, a.trim())))];
        if (clean.length > 200) return res.status(400).json({ error: `wallets.${chain} 超过 200 个` });
        if (clean.length) w[chain] = clean;
      }
      cfg.wallets = w;
    }
    writeJson(CFG_FILE, cfg);
    schedule();   // 间隔可能变了, 重排定时器
    res.json(status());
  });

  app.post('/api/notify/test', adminGuard, async (req, res) => {
    const ok = await sendTg('🔔 LP 仪表盘 · 出区间通知测试 — 哨兵通道正常');
    if (ok) res.json({ ok: true });
    else res.status(502).json({ error: TG_TOKEN ? 'Telegram 发送失败' : '服务器未配置 TG_BOT_TOKEN/TG_CHAT_ID' });
  });

  // 启动 2 分钟后首轮(等各链预热), 之后按配置间隔
  setTimeout(async () => { await check(); schedule(); }, 2 * 60 * 1000);
  console.log(`Notifier mounted (/api/notify/*), channel=${TG_TOKEN && TG_CHAT ? 'sentinel-tg' : 'UNCONFIGURED'}`);
}

module.exports = { mountNotifier, _test: { check, loadCfg, loadState, fmtEvent, sendTg } };
