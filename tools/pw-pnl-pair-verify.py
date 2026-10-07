#!/usr/bin/env python3
"""盈亏页「按交易对」视角验证 (2026-10-08)。走 SSH 隧道直连应用端口 (免 nginx 登录闸门): ssh -f -N -L 15179:127.0.0.1:5179 ubuntu@服务器
用法: pw_pair_verify.py <BASE> [local_index_html]
- BASE: 应用地址 (隧道 http://127.0.0.1:15179)
- 给了 local_index_html 就把 / 和 /index.html 换成本地文件 (验证未部署的改动); 不给就验线上原样
- /api/pnl/all 固定用夹具 (own/obs), 其余接口放行到 BASE
"""
import sys, os, json, re
from playwright.sync_api import sync_playwright

BASE = sys.argv[1]
LOCAL = sys.argv[2] if len(sys.argv) > 2 else None
FIXDIR = os.environ.get('PNL_FIXDIR', '/tmp/lpdash-pair')   # 夹具: 服务器上 curl 'http://127.0.0.1:5179/api/pnl/all?scope=own' > fix_own.json (obs 同理), 拉到本地该目录
FIX = {s: open(os.path.join(FIXDIR, 'fix_' + s + '.json'), 'rb').read() for s in ('own', 'obs')}
errors, res = [], {}

def route(r):
    u = r.request.url
    path = u.split('//', 1)[1].split('/', 1)[1] if '//' in u else u
    path = '/' + path
    if LOCAL and (path == '/' or path.startswith('/index.html') or path.startswith('/#') or path == ''):
        return r.fulfill(status=200, content_type='text/html; charset=utf-8', body=open(LOCAL, 'rb').read())
    if path.startswith('/api/pnl/all'):
        scope = 'obs' if 'scope=obs' in path else 'own'
        return r.fulfill(status=200, content_type='application/json', body=FIX[scope])
    return r.continue_()

def num(s):   # "$1,234.56" / "+$12.3" / "−$5" → float; "—" → None
    s = s.strip().split('\n')[0]
    if s in ('—', ''): return None
    neg = s.startswith('−') or s.startswith('-')
    m = re.search(r'[\d,]+(?:\.\d+)?', s)
    if not m: return None
    v = float(m.group(0).replace(',', ''))
    return -v if neg else v

with sync_playwright() as p:
    br = p.chromium.launch(channel='chrome', headless=True)
    ctx = br.new_context(viewport={'width': 1360, 'height': 900})
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)
    page.route('**/*', route)
    page.goto(BASE + '/#pnl', wait_until='domcontentloaded')
    page.wait_for_selector('#pnToolbar .tb-row', timeout=60000)
    # 工具栏有「视角」行
    labels = page.locator('#pnToolbar .filter-label').all_inner_texts()
    res['toolbar_labels'] = labels
    assert '视角' in labels, labels
    # 默认按仓位: 表头 10 列, 有「活跃仓位」节
    page.wait_for_selector('#pnTable table.pn-table', timeout=60000)
    secs = page.locator('#pnTable tr.pn-sec td').all_inner_texts()
    res['pos_sections'] = secs
    res['pos_rows'] = page.locator('#pnTable tbody tr:not(.pn-sec)').count()
    # 记录按仓位视角下每行的净利润 / 成本 以便核对
    def table_rows():
        return page.evaluate('''() => [...document.querySelectorAll('#pnTable tbody tr')].map(tr => ({cls: tr.className, g: tr.dataset.g || null, shown: tr.style.display !== 'none', tds: [...tr.querySelectorAll('td')].map(td => td.innerText)}))''')
    pos_rows = [r for r in table_rows() if 'pn-sec' not in r['cls']]
    # 切到按交易对
    page.locator('#pnToolbar .ftag', has_text='按交易对').click()
    page.wait_for_selector('#pnTable tr.pn-grow', timeout=10000)
    assert page.evaluate("localStorage.getItem('pnView')") == 'pair'
    secs2 = page.locator('#pnTable tr.pn-sec td').all_inner_texts()
    res['pair_sections'] = secs2
    rows2 = table_rows()
    grows = [r for r in rows2 if 'pn-grow' in r['cls']]
    mems = [r for r in rows2 if 'pn-gmem' in r['cls']]
    res['pair_groups'] = len(grows); res['pair_members'] = len(mems)
    assert len(mems) == len(pos_rows), (len(mems), len(pos_rows))
    assert all(not m['shown'] for m in mems), '明细行默认应隐藏'
    assert all(r['shown'] for r in grows)
    # 汇总核对: 用夹具直接算每组 (同一分组规则), 与页面组行的数字比
    fx = json.loads(FIX['own'])
    def key(r):
        tk = [t for t in (r.get('tokens') or []) if t.get('address')]
        use = tk
        if len(tk) > 2:
            syms = set(x.strip() for x in str(r.get('pair') or '').split('/'))
            m = [t for t in tk if t.get('symbol') in syms]
            use = m if len(m) >= 2 else [t for t in tk if not str(t.get('symbol') or '').endswith('…')]
        if not use: return r['chain'] + '|' + str(r.get('pair') or '')
        return r['chain'] + '|' + '|'.join(sorted(t['address'].lower() for t in use))
    exp = {}
    for r in fx['positions']:
        k = key(r); g = exp.setdefault(k, {'n': 0, 'cost': 0.0, 'np': 0.0, 'nNp': 0, 'value': 0.0, 'nAct': 0, 'fees': 0.0, 'wd': 0.0})
        g['n'] += 1
        if (r.get('costUSD') or 0) > 0: g['cost'] += r['costUSD']
        if r.get('netProfitUSD') is not None: g['np'] += r['netProfitUSD']; g['nNp'] += 1
        if r['status'] == 'active': g['nAct'] += 1; g['value'] += (r.get('valueUSD') or 0) + (r.get('pendingFeesUSD') or 0)
        g['fees'] += (r.get('pendingFeesUSD') or 0) + (r.get('collectedFeesUSD') or 0)
        g['wd'] += r.get('withdrawnUSD') or 0
    assert len(exp) == len(grows), (len(exp), len(grows))
    # 列: 0交易对 1状态 2开仓 3关闭/持有 4成本 5现值 6已提回 7手续费 8无常 9净利润
    mism = []
    for gr in grows:
        e = exp[gr['g']]; tds = gr['tds']
        n_txt = re.search(r'(\d+) 仓', tds[0]).group(1)
        checks = [('n', int(n_txt), e['n'], 0.5), ('cost', num(tds[4]) or 0, round(e['cost']), 1.0), ('np', num(tds[9]) or 0, e['np'], 0.011), ('value', num(tds[5]) or 0, round(e['value']) if e['nAct'] else 0, 1.0), ('fees', num(tds[7]) or 0, e['fees'], 0.011), ('wd', num(tds[6]) or 0, round(e['wd']), 1.0)]
        for name, got, want, tol in checks:
            if abs(got - want) > tol: mism.append((gr['g'][:40], name, got, want))
    res['sum_mismatch'] = mism
    assert not mism, mism
    # 展开/收起
    first = page.locator('#pnTable tr.pn-grow').first
    k = first.get_attribute('data-g')
    first.click()
    shown = page.evaluate('''k => [...document.querySelectorAll('#pnTable tr.pn-gmem')].filter(t => t.dataset.g === k).map(t => t.style.display !== 'none')''', k)
    assert shown and all(shown), shown
    assert 'open' in first.get_attribute('class')
    res['expand_first'] = {'key': k[:40], 'members': len(shown)}
    page.screenshot(path='/tmp/pair-1360-open.png', full_page=False)
    first.click()
    shown = page.evaluate('''k => [...document.querySelectorAll('#pnTable tr.pn-gmem')].filter(t => t.dataset.g === k).map(t => t.style.display !== 'none')''', k)
    assert not any(shown)
    # 展开后切钱包筛选 (重渲染) 保持展开
    first.click()
    wb = page.locator('#pnToolbar .tb-row', has_text='钱包').locator('.ftag')
    if wb.count() > 1:
        wb.nth(1).click(); page.wait_for_timeout(300)
        still = page.evaluate('''k => { const g=[...document.querySelectorAll('#pnTable tr.pn-grow')].find(t=>t.dataset.g===k); return g ? g.classList.contains('open') : 'gone'; }''', k)
        res['open_kept_after_filter'] = still
        wb.nth(0).click(); page.wait_for_timeout(300)
    # 宽度: 1360 下表格不横向溢出
    ov = page.evaluate('''() => { const w = document.querySelector('#pnTable'); const t = document.querySelector('#pnTable table'); return {wrap: w.clientWidth, table: t.scrollWidth, overflow: t.scrollWidth > w.clientWidth + 1}; }''')
    res['width_1360'] = ov
    assert not ov['overflow'], ov
    # 刷新后记忆视角
    page.reload(wait_until='domcontentloaded')
    page.wait_for_selector('#pnTable tr.pn-grow', timeout=60000)
    res['view_remembered'] = page.locator('#pnToolbar .ftag.active', has_text='按交易对').count() == 1
    # 观察范围也能跑
    page.locator('#pnToolbar .ftag', has_text='观察').click()
    page.wait_for_selector('#pnTable tr.pn-grow', timeout=60000)
    res['obs_groups'] = page.locator('#pnTable tr.pn-grow').count()
    page.screenshot(path='/tmp/pair-obs-1360.png', full_page=False)
    page.locator('#pnToolbar .ftag', has_text='自有').click()
    page.wait_for_selector('#pnTable tr.pn-grow', timeout=60000)
    # 手机宽度
    page.set_viewport_size({'width': 375, 'height': 800}); page.wait_for_timeout(400)
    ov2 = page.evaluate('''() => ({ doc: document.documentElement.scrollWidth, win: innerWidth, table: document.querySelector('#pnTable table').scrollWidth, wrap: document.querySelector('#pnTable').clientWidth })''')
    res['width_375'] = ov2
    page.locator('#pnTable tr.pn-grow').first.click()
    page.screenshot(path='/tmp/pair-375.png', full_page=False)
    # 切回按仓位
    page.set_viewport_size({'width': 1360, 'height': 900})
    page.locator('#pnToolbar .ftag', has_text='按仓位').click(); page.wait_for_timeout(300)
    res['back_pos_rows'] = page.locator('#pnTable tbody tr:not(.pn-sec)').count()
    assert res['back_pos_rows'] == len(pos_rows)
    assert page.locator('#pnTable tr.pn-grow').count() == 0
    br.close()
res['errors'] = errors
print(json.dumps(res, ensure_ascii=False, indent=1))
sys.exit(1 if errors else 0)
