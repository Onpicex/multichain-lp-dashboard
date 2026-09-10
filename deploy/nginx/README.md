# nginx 配置快照（2026-09-10）

这台机器上 `fucklp.com` 整个域名族的路由，只存在于服务器 `/etc/nginx/` 下，
机器挂了就得凭记忆重建 —— 故在此留一份快照。

| 本目录文件 | 服务器路径 |
|---|---|
| `vhost-fucklp.conf` | `/etc/nginx/sites-available/fucklp` |
| `vhost-lp-dashboard.conf` | `/etc/nginx/sites-available/lp-dashboard` |
| `snippet-fucklp-app.conf` | `/etc/nginx/snippets/fucklp-app.conf` |
| `snippet-fucklp-proxyhdr.conf` | `/etc/nginx/snippets/fucklp-proxyhdr.conf` |
| `snippet-fucklp-ssl.conf` | `/etc/nginx/snippets/fucklp-ssl.conf` |

**两个 vhost 共用同一组 snippet**，所以两份 vhost 必须一起看。同一份快照在
`rh-stocktokens` 仓的 `deploy/nginx/` 下也有一份（那边负责 stock./meme. 子域），
**改了一处记得同步另一处**。

## 域名族划分
- `fucklp.com` → 公开导航页，nginx 静态托管 `/var/www/fucklp-home/index.html`，**不依赖任何 node 进程**
- `stock.fucklp.com` → 5180 的 `stocks.html`
- `meme.fucklp.com` → 5180 的 `memes.html`
- `lp.fucklp.com` → 5179（另含 `/1888/` V4 看板）

## 几条必须知道的
- **`lp.fucklp.com` 的 server 块必须待在 `vhost-lp-dashboard.conf` 里**：它引用的
  `map $cookie_lpauth` 定义在该文件，而 sites-enabled 按字母序解析、`fucklp` 在前，
  拆开会「变量未定义」。
- **端口 80 故意不做 301 跳 https**：CF 加密模式若被误设成 Flexible（走 80 回源），
  源站跳 https 会造成无限重定向。http→https 交给 CF 边缘的「始终使用 HTTPS」。
- **HTTPS = CF 代理 + Origin CA 证书**（`/etc/ssl/certs/fucklp-origin.pem`，
  SAN `fucklp.com` + `*.fucklp.com`，2041 到期）。该证书只有 CF 认，
  **小黄云必须开橙色**，灰云或直连 IP:443 报证书不受信任是设计如此。丢了去 CF 面板重签。
- **443 default_server 用 `ssl_reject_handshake on`**：未知 SNI / 扫 IP 直接拒握手。
- **重定向 location 会继承 server 级 `auth_basic`**，不显式写 `auth_basic off;`
  就变成「先输密码才肯跳转」。
- **nginx 字符串里的 `$` 是变量起始符**，`return 200 "...Disallow: /$\n..."` 会报
  `invalid variable name`。
