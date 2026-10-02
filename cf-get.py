#!/usr/bin/env python3
# 过 Cloudflare 的 GET (2026-10-02): rh blockscout 在 CF 后面, node fetch / curl / 普通 requests 一律 403,
#   curl_cffi 仿 Chrome TLS 指纹能过. 用法: cf-get.py <url> → stdout 原样输出响应体; 非 200 退出码 2, 网络错误退出码 3
#   非 200 时 stderr 写 `HTTP <code>`, 带限流头的再加 ` reset=<ms>` (blockscout 按 IP 整 5 分钟窗口计数, 头里是到窗口结束的毫秒数)
#   python 解释器取 env CFFI_PYTHON (默认 /home/ubuntu/.venvs/cffi/bin/python, 里面 pip 装了 curl_cffi)
import sys
try:
    from curl_cffi import requests
except ImportError:
    sys.stderr.write('curl_cffi not installed\n'); sys.exit(4)
try:
    r = requests.get(sys.argv[1], impersonate='chrome', timeout=60)
except Exception as e:
    sys.stderr.write(str(e)[:200] + '\n'); sys.exit(3)
if r.status_code != 200:
    reset = r.headers.get('x-ratelimit-reset')
    sys.stderr.write(f'HTTP {r.status_code}' + (f' reset={reset}' if reset else '') + '\n'); sys.exit(2)
sys.stdout.buffer.write(r.content)
