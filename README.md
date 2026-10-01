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
- **本仓不含任何运行数据与凭据**：`.env`、`.lpauth-token`、`auth-users-lp.json`、各类 `*-cache*.json` / `snapshots.json` / 账本文件
  均在 `.gitignore` 里；六个 `wallets*.json` 是空数组，按自己的钱包填。

## 配置
- `.env`：见 `.env.example`（RPC、The Graph key、Ankr/Helius key、`HOST`/`PORT`、`ADMIN_TOKEN`、TG bot 等）

### 各 key 是否必填

全部留空也能启动，六条链的活跃仓位、现值、未领手续费都走链上 RPC 直读；下面这些 key 决定的是「有没有历史数据、快不快」。

| 变量 | 必要程度 | 影响范围 | 留空后果 |
|---|---|---|---|
| `GRAPH_KEYS` | **强烈建议**（免费档即可，可填多个逗号分隔轮转） | ETH / Base 的 V3 建仓时间与已领费、V4 仓位枚举与建仓价值；BSC V4 枚举 | 仓位仍能枚举（V4 退回链上日志扫描 / blockscout，大户钱包明显变慢），但 ETH / Base 的「当前日化」「建仓价值 / 差价」「已领费」大面积缺失 |
| `PCS_LOG_RPCS` | **强烈建议**（NodeReal 免费 key 即可） | BSC Pancake V3 的领费记录与建仓价值（需扫链上日志） | 退到公共兜底端点：每次只能扫 5000 块、一笔 1.5～7 秒，深历史会被 403，老仓位的建仓价值可能一直补不上 |
| `ANKR_KEY` | 可选（Freemium 免费档） | 钱包盈亏账本的 Base / ETH / BSC 数据源 | 这几条链只有开仓时价值，没有历史仓位与成本 |
| `HELIUS_KEY` | 可选（免费档） | 钱包盈亏账本的 Solana 数据源 | Solana 只有现值与手续费，没有成本与历史仓位 |
| `SOL_RPC` | 建议换 | Solana 仓位读取 | 默认公共节点会限流，钱包多了会刷不出来；Helius / solanavibestation 免费档都行 |
| `ETH_RPC` / `BASE_RPC` / `RH_RPC` / `ARC_RPC` / `BSC_RPC` / `LOG_RPC` | 可选 | 各链仓位读取与日志扫描 | 都有公共默认值，能跑；自有节点更稳 |
| `TG_BOT_TOKEN` + `TG_CHAT_ID` | 可选 | 出区间 Telegram 通知 | 不发通知，其余功能不受影响 |
| `ADMIN_TOKEN` | 可选 | 写接口（改钱包 / 快照 / 通知 / 资金配置）鉴权 | 只靠 nginx 登录闸门；裸跑在公网务必设 |
| `HOST` / `PORT` | 可选 | 监听地址与端口 | 默认 `127.0.0.1:5179`，只给本机 nginx 反代；别改成 `0.0.0.0` |

没有 The Graph 子图的链（Robinhood Chain、Arc）本来就全走链上，不受 `GRAPH_KEYS` 影响。
- `wallets.json`（BSC）/ `wallets-<chain>.json`：钱包列表，三标 `enabled` / `own` / `ledger`（页面「管理钱包」可改）
- `snapshot-config.json` / `notify-config.json` / `fund-config.json` / `pnl-config.json`：页面内对应设置项落盘
