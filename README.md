# LP Dashboard

Uniswap V3/V4 + Pancake V3 LP 仪表盘（BSC / ETH / Robinhood Chain / Base / Arc / Solana 六链），
含仓位真实成本 / 无常损失 / 净利润、钱包盈亏账本、资金快照、出区间 Telegram 通知。

## 功能
- 多钱包 LP 头寸监控（自有 / 观察两类钱包）
- 实时价格区间 & 状态（区间内/外），出区间 Telegram 通知（`notifier.js`）
- 未领取手续费计算、日化收益率估算（精确版：领费后自动重算起点）
- 钱包盈亏账本（`pnl-ledger.js` / `sol-ledger.js`）与每 5 分钟资金快照（`snapshot.js`）
- 深蓝色调 UI，支持移动端

## 技术栈
- **后端**: Node.js + Express + ethers.js（+ @solana/web3.js）
- **数据源**: 各链 RPC 扫链 + Uniswap Subgraph (The Graph) + Ankr / Helius
- **前端**: 原生 HTML/CSS/JS（零依赖，`public/index.html`）

## 部署
```bash
npm install
cp .env.example .env   # 按注释填值; 键名齐全, 值不要提交到脱敏仓
node server.js
# 默认监听 127.0.0.1:5179 (HOST 未设时应用回退 0.0.0.0 —— 生产 .env 必须写 HOST=127.0.0.1, nginx 是唯一入口)
```
生产环境用 systemd 常驻，nginx 反代（配置快照与说明见 [`deploy/nginx/README.md`](deploy/nginx/README.md)）。

## 鉴权 / 部署要点（2026-09-28 审计后）
- **把关的是 nginx，不是应用**：`lp.fucklp.com` 的 server 块用 `map $cookie_lpauth $lp_ok` 判固定令牌，没 cookie 的页面 302 `/login`、API 401，请求到不了 5179。
  应用侧 `lp-auth.js` 只校验用户名口令（`auth-users-lp.json`，scrypt）并下发那个令牌（cookie `lpauth`，1 年，HttpOnly，SameSite=Lax，https 下 Secure）。
- **令牌两处必须一致**：应用侧 `.lpauth-token` 与 nginx 侧 `/etc/nginx/lp-token.map`（0600 root，仓内只有占位版 `deploy/nginx/lp-token.map.example`）。
  轮换用 `bash tools/rotate-lp-token.sh`（服务器上跑，自动写两处 + reload + 校验，失败回滚；应用按 mtime 自动重读，不用重启）。
- **入口**：IP 直连 `__SERVER_IP__`（只有 80）整站 301 到 `https://lp.fucklp.com`；`lp.fucklp.com` 走 Cloudflare 橙云 + Origin CA 证书，
  nginx 用 `cloudflare-realip.conf` 还原真实客户端 IP，登录接口 `limit_req` 6 次/分钟，应用层再按 IP 8 次锁 15 分钟；
  应用只信 nginx 覆写的 `X-Real-IP`（不读 `CF-Connecting-IP` / `X-Forwarded-For`）。
- **账号与 stock./meme. 那套完全独立**（用户要求不通用）；`ADMIN_TOKEN` 设了以后写接口还要带 `x-admin-token` 头。
- **本仓是全量备份仓**：`.env`、`.lpauth-token`、`auth-users-lp.json`、各类 `*-cache*.json` / `snapshots.json` 有意跟踪；
  脱敏仓 `lp-dashboard-clean` 不含这些，同步前须针对性搜自有钱包地址与令牌。

## 配置
- `.env`：见 `.env.example`（RPC、The Graph key、Ankr/Helius key、`HOST`/`PORT`、`ADMIN_TOKEN`、TG bot 等）
- `wallets.json`（BSC）/ `wallets-<chain>.json`：钱包列表，三标 `enabled` / `own` / `ledger`（页面「管理钱包」可改）
- `snapshot-config.json` / `notify-config.json` / `fund-config.json` / `pnl-config.json`：页面内对应设置项落盘
