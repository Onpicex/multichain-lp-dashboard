# nginx 配置快照（2026-09-10，2026-09-26 刷新，2026-09-28 审计修复）

这台机器上 `fucklp.com` 整个域名族的路由，只存在于服务器 `/etc/nginx/` 下，
机器挂了就得凭记忆重建 —— 故在此留一份快照。

| 本目录文件 | 服务器路径 | 权限 |
|---|---|---|
| `vhost-fucklp.conf` | `/etc/nginx/sites-available/fucklp` | 644 |
| `vhost-lp-dashboard.conf` | `/etc/nginx/sites-available/lp-dashboard` | 644 |
| `lp-token.map.example` | `/etc/nginx/lp-token.map`（**占位版**，服务器上是渲染后的真值） | **0600 root** |
| `snippet-fucklp-app.conf` | `/etc/nginx/snippets/fucklp-app.conf` | 644 |
| `snippet-fucklp-proxyhdr.conf` | `/etc/nginx/snippets/fucklp-proxyhdr.conf` | 644 |
| `snippet-fucklp-ssl.conf` | `/etc/nginx/snippets/fucklp-ssl.conf` | 644 |
| `snippet-lp-secheaders.conf` | `/etc/nginx/snippets/lp-secheaders.conf` | 644 |
| `snippet-lp-csp.conf` | `/etc/nginx/snippets/lp-csp.conf` | 644 |
| `snippet-cloudflare-realip.conf` | `/etc/nginx/snippets/cloudflare-realip.conf` | 644 |

**两个 vhost 共用同一组 snippet**，所以两份 vhost 必须一起看。**本仓是这组 nginx 配置的唯一真源**；
`rh-stocktokens` 仓的 `deploy/nginx/` 只保留占位版（不再要求两边同步），改这里、部署到服务器即可。

## 域名族划分
- `fucklp.com` → 公开导航页，nginx 静态托管 `/var/www/fucklp-home/index.html`，**不依赖任何 node 进程**
- `stock.fucklp.com` → 5180 的 `stocks.html`
- `meme.fucklp.com` → 5180 的 `memes.html`
- `lp.fucklp.com` → 5179（另含 `/1888/` V4 看板）
- `btc.fucklp.com` → 5182（btc-gex，2026-09-22 起，鉴权在应用层复用 stkauth）
- `/c/solstock/`、`/c/solpre/`、`/c/solmeme/`（09-27） → 5183（sol-stocks，写在 `snippet-fucklp-app.conf`，须排在 `/c/ → 5181` 之前）
- `__SERVER_IP__`（IP 直连，只有 80）→ **整站 301 到 `https://lp.fucklp.com`**（2026-09-28 起不再提供任何内容）

## LP 仪表盘鉴权（lp.fucklp.com）
- nginx `map $cookie_lpauth $lp_ok` 判固定令牌：没 cookie 的页面 302 `/login`，`/api/*` 401；免闸的只有 `= /login`（静态 `/var/www/lp-login`）、
  `= /api/lp-auth/login|logout`、两条老入口 301（`/stocks.html`、`/memes.html`）。
- **令牌不在 vhost 文件里**（2026-09-28 起）：`vhost-lp-dashboard.conf` 顶层 `include /etc/nginx/lp-token.map;`，
  该文件 **root:root 0600**，内容即 `lp-token.map.example` 把 `__LPAUTH_TOKEN__` 换成 48 位 hex。
  它必须和应用侧 `/home/ubuntu/lp-dashboard/.lpauth-token`（0600）**一字不差**，否则登录成功也进不去（失效方向是锁死，不是敞开）。
- **轮换流程**：服务器上 `bash tools/rotate-lp-token.sh` —— 生成新令牌 → 写 `.lpauth-token` → 渲染 `lp-token.map` → `nginx -t && reload` →
  校验两处 sha256 一致，任一步失败回滚旧文件；全程不打印令牌。应用 `lp-auth.js` 按 mtime 自动重读，**不用重启 5179**；所有旧 cookie 立刻失效。
- **登录限速**：`limit_req_zone $binary_remote_addr zone=lplogin:1m rate=6r/m;`（http 级，在 vhost 顶层）+
  `= /api/lp-auth/login` 里 `limit_req zone=lplogin burst=6 nodelay; limit_req_status 429;`。应用层另有「8 次失败锁 15 分钟」。
- **安全头**：`lp-secheaders.conf`（HSTS / nosniff / X-Frame-Options SAMEORIGIN / Referrer-Policy）include 到 `/`、`= /login`、`^~ /api/`、
  两条 lp-auth、`/1888/`；`lp-csp.conf`（CSP：同源 + inline + Google Fonts）只 include 到 `/` 与 `= /login`，**`/1888/` 不加 CSP**（V4 看板可能用外部 CDN 脚本）。
  `add_header` 不继承进「自己也有 add_header」的 location，所以是每个 location 各 include 一次，别图省事挪到 server 级。
- **Cloudflare 真实 IP**：`cloudflare-realip.conf`（CF 官方 IPv4/IPv6 网段 `set_real_ip_from` + `real_ip_header CF-Connecting-IP`）
  include 在 `lp.fucklp.com` 以及 `fucklp.com` / `stock.` / `meme.` / `btc.` 的 server 块；共用的 `fucklp-proxyhdr.conf` 同时把上游的
  `CF-Connecting-IP` 清空，应用一律读 `X-Real-IP`（= 还原后的 `$remote_addr`）。CF 网段变了同步该文件（`curl -s https://www.cloudflare.com/ips-v4`）。
- `server_tokens off` 在 lp 的两个 server 块（不暴露版本号）。

## 几条必须知道的
- **`lp.fucklp.com` 的 server 块必须待在 `vhost-lp-dashboard.conf` 里**：它引用的
  `$lp_ok`（map 在 `/etc/nginx/lp-token.map`，由该文件 include）与 `limit_req_zone lplogin` 都定义在该文件，
  sites-enabled 按字母序解析、`fucklp` 在前，拆开会「变量未定义 / zone 未定义」。
- **`lp.fucklp.com` 的端口 80 故意不做 301 跳 https**：CF 加密模式若被误设成 Flexible（走 80 回源），
  源站跳 https 会造成无限重定向。http→https 交给 CF 边缘的「始终使用 HTTPS」。
  IP 直连那个 `default_server` 不经 CF，所以它 301 到子域没有这个问题。
- **HTTPS = CF 代理 + Origin CA 证书**（`/etc/ssl/certs/fucklp-origin.pem`，
  SAN `fucklp.com` + `*.fucklp.com`，2041 到期）。该证书只有 CF 认，
  **小黄云必须开橙色**，灰云或直连 IP:443 报证书不受信任是设计如此。丢了去 CF 面板重签。
- **443 default_server 用 `ssl_reject_handshake on`**：未知 SNI / 扫 IP 直接拒握手。
- **重定向 location 会继承 server 级 `auth_basic`**，不显式写 `auth_basic off;`
  就变成「先输密码才肯跳转」（现已无 auth_basic，留作历史教训）。
- **nginx 字符串里的 `$` 是变量起始符**，`return 200 "...Disallow: /$\n..."` 会报
  `invalid variable name`。
- **realip 模块**：Ubuntu 的 `nginx-core` / `nginx-full` 内建 `ngx_http_realip_module`；`nginx -V 2>&1 | grep -o with-http_realip_module` 为空就得换包。

## 部署顺序（改完仓内快照后）
1. 拷 snippet 三个新文件到 `/etc/nginx/snippets/`（`lp-secheaders.conf`、`lp-csp.conf`、`cloudflare-realip.conf`），覆盖 `fucklp-proxyhdr.conf`、`fucklp-app.conf`。
2. 第一次：`sudo install -o root -g root -m 0600 deploy/nginx/lp-token.map.example /etc/nginx/lp-token.map`，
   然后 `sudo sed -i "s/__LPAUTH_TOKEN__/$(cat /home/ubuntu/lp-dashboard/.lpauth-token)/" /etc/nginx/lp-token.map`（沿用现有令牌，用户不用重登）；
   之后要换令牌就跑 `tools/rotate-lp-token.sh`。
3. 覆盖 `sites-available/lp-dashboard` 与 `sites-available/fucklp`。
4. `sudo nginx -t && sudo systemctl reload nginx`；失败就把 `.bak` 换回去再 reload（nginx -t 不过是不会 reload 的，线上不受影响）。
5. 验证：`curl -sI http://__SERVER_IP__/ | head -3`（301 到 lp.fucklp.com）；带 cookie 访问 `/api/snapshot/config` 看响应头有 HSTS/CSP；
   连错 7 次登录看 429；`tail -f /var/log/nginx/lp-dashboard.access.log` 里 `$remote_addr` 是真实 IP 而非 CF 网段。
