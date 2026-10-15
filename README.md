# LP Dashboard

Uniswap V3/V4 + Pancake V3 + Solana（Meteora / Raydium / Orca）LP 仪表盘（BSC / ETH / Robinhood Chain / Base / Arc / Solana 六链），
含仓位真实成本 / 无常损失 / 净利润、钱包盈亏账本（按仓位 / 按交易对）、充提记录与净入金、资金快照、出区间 Telegram 通知。

## 功能
- 多钱包 LP 头寸监控：钱包分「自有 / 观察」两类，`enabled` 总开关；钱包资金查询 / 钱包盈亏 / 资金快照 / 出区间通知四项功能各自按钱包「纳入」（缺省自有纳入、观察不纳入，设置页可逐个改）
- 实时价格区间 & 状态（区间内/外），出区间 Telegram 通知（`notifier.js`）
- 未领取手续费、日化收益率（领费后自动重算起点）、仓位真实成本 / 无常损失 / 净利润（桌面版与手机版都在「价值」下方显示净利润及百分比）
- 钱包盈亏账本（EVM `pnl-ledger.js`，Solana `sol-ledger.js`）：链上流水逐笔重放得到每个仓位的成本、已领费、提回、净利润；「按仓位」「按交易对」两种视角（同链同一对代币折叠成一行，点开看明细）
- 钱包资金查询的「总价值」含充提记录与净入金（`flows.js`：钱包 ↔ 外部账户的转入转出；自控地址、协议存取、Jupiter 限价单托管不记成充提）
- Backpack 只读接入（`backpack.js`，可选）：Solana 股票代币转账在账本里没有成交价时，按 Backpack 公开的美股 1 分钟 K 线取转账时刻那根的收盘价（不是估算、不标 `*`）；自有钱包与 Backpack 充值址 / 热钱包的往来记成自控（列出不计），Backpack 账户余额作一行「Backpack」并入自有钱包闲置余额；观察钱包只打交易所标签并给「其中交易所往来」小计，数字不变
- 每 5 分钟资金快照（`snapshot.js`），已实现 / 手续费累计按账本时间线回写历史点，账本修正不会算成当天收益
- 份额乘数：Solana Token-2022 `scaledUiAmount` 与 BSC ERC-8056 `uiMultiplier` 代币（拆股型股票代币）的仓位 / 闲置 / 账本 / 充提全部按钱包显示口径（缓存 `ui-mult-*.json`）
- 深蓝色调 UI，支持移动端

### Solana 盈亏口径（`sol-ledger.js`）
- 每笔开 / 加 / 减仓时刻的精确池价：Raydium 从该 tx 日志的 anchor 事件取 pool tick，Orca 从 Whirlpool `Traded` 事件取 `post_sqrt_price`；单边开仓刚进场不再显示假亏损
- Raydium 减仓把本金和手续费一笔转出：按 `DecreaseLiquidityEvent` 的 `fee_amount_0/1` 拆出手续费（取不到才整笔计提回并标「不含已领」）；Meteora / Orca 领费本来就是独立指令
- Jupiter 限价单成交买到的币按实付计成本；同 slot 多笔按块内序号排序；原生 SOL 与 WSOL 合并计

### Solana RPC（`sol-rpc.js`）
- `SOL_RPC=helius` 用 Helius 免费档做主节点：进程内统一限速（RPC 9/s、getProgramAccounts 4/s、Enhanced 2/s，仓位轮 / 账本 / 充提共用），`getProgramAccounts` 自动改写成 Helius 的 V2（10 → 1 积分），按 Helius 定价估算本月积分落盘 `helius-meter-sol.json`（估算值，以控制台为准）
- 多账号顺序接力：`HELIUS_KEY` → `HELIUS_KEY_2` … `HELIUS_KEY_5` 同一时刻只用一把，当前这把月积分用尽（Helius 回 429 "max usage reached"，或估算 ≥ `SOL_HELIUS_BUDGET`，默认 1000000）才切下一把；用尽的 key 每 `SOL_HELIUS_REPROBE_MS`（默认 6 小时）再探一次；全部用尽时仓位轮走 `SOL_RPC_FALLBACK`，账本等下一轮。日志和落盘只出现 key 的 sha256 前 8 位指纹
- 页面「强刷」最多同步等 30 秒，没跑完先回旧数据并标「后台刷新中」，前端每 10 秒轻探带回新数据（不再被 Cloudflare 100 秒掐线）
- `SOL_LEDGER_PRECHECK=1` 可开账本预检（追平态先用 1 积分看有没有新交易，没有就跳过 100 积分的解析页）；默认关

## 技术栈
- **后端**: Node.js + Express + ethers.js（+ @solana/web3.js，Solana 请求统一经 `sol-rpc.js` 出口）
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
| `HELIUS_KEY` | **建议**（免费档） | `SOL_RPC=helius` 时的 Solana 仓位主节点 + 钱包盈亏账本 / 充提的 Solana 数据源 | `SOL_RPC=helius` 退回公共节点；Solana 只有现值与手续费，没有成本与历史仓位 |
| `HELIUS_KEY_2` … `HELIUS_KEY_5` | 可选 | 第一把 Helius 月积分用尽后顺序接力（免费档每把 100 万积分 / 月；钱包多、账本开得多时一把不够，实际用量看日志里的积分计量） | 单账号；用尽后仓位轮走备胎、账本等积分重置 |
| `BACKPACK_API_KEY` + `BACKPACK_API_SECRET` | 可选（只读权限即可） | Backpack 账户余额并入自有钱包闲置余额、充值地址识别（自有钱包 ↔ Backpack 往来记成自控）；`BACKPACK_SOL_WALLET` 指定并入哪个自有钱包（留空取有 Backpack 往来的自有钱包） | 不并入余额、充值地址只认内置热钱包；股票代币 1 分钟 K 线定价走公开接口，不需要 key |
| `SOL_RPC` / `SOL_RPC_FALLBACK` | 建议 `helius` | Solana 仓位读取的主节点 / 备胎（主节点连续 429 或 Helius 全部用尽时切过去） | 默认公共节点会限流，钱包多了会刷不出来；solanavibestation 免费档可当备胎 |
| `ETH_RPC` / `BASE_RPC` / `RH_RPC` / `ARC_RPC` / `BSC_RPC` / `LOG_RPC` | 可选 | 各链仓位读取与日志扫描 | 都有公共默认值，能跑；自有节点更稳 |
| `TG_BOT_TOKEN` + `TG_CHAT_ID` | 可选 | 出区间 Telegram 通知 | 不发通知，其余功能不受影响 |
| `ADMIN_TOKEN` | 可选 | 写接口（改钱包 / 快照 / 通知 / 资金配置）鉴权 | 只靠 nginx 登录闸门；裸跑在公网务必设 |
| `HOST` / `PORT` | 可选 | 监听地址与端口 | 默认 `127.0.0.1:5179`，只给本机 nginx 反代；别改成 `0.0.0.0` |

没有 The Graph 子图的链（Robinhood Chain、Arc）本来就全走链上，不受 `GRAPH_KEYS` 影响。
- `wallets.json`（BSC）/ `wallets-<chain>.json`：钱包列表；字段 `enabled`（总开关）、`own`（自有 / 观察）与四个「纳入」开关 `fund` / `ledger` / `snap` / `notify`（缺省：自有纳入、观察不纳入；页面「管理钱包」与各设置页签可改，`wallet-scope.js` 统一取范围）
- `snapshot-config.json` / `notify-config.json` / `fund-config.json` / `pnl-config.json`：页面内对应设置项落盘
- `known-addrs.json`（可选，不入库）：已知交易所地址表，充提表按它打标签并出「其中交易所往来」小计；样例见 `known-addrs.example.json`，60 秒内重读
- 运行时产物（都在 `.gitignore`）：`pnl-ledger-*.json` 账本、`flows-cache-*.json` 充提缓存、`ui-mult-*.json` 份额乘数缓存、`helius-meter-sol.json` Helius 积分计量、`backpack-cache.json` Backpack 缓存、各类 `*-cache*.json` / `snapshots.json`

## 近期变化
- 2026-10-16：Backpack 只读接入（`backpack.js`）：Solana 股票代币转账按 Backpack 1 分钟 K 线定价、自有钱包 ↔ Backpack 往来标自控、账户余额并入自有钱包闲置余额；充提表交易所标签与「其中交易所往来」小计（`known-addrs.example.json`）
- 2026-10-15：Solana 主节点切 Helius 免费档（`sol-rpc.js`：限速 / getProgramAccounts V2 / 积分计量 / 多 key 顺序接力）；Sol 强刷不再阻塞；Raydium 减仓按日志事件拆出手续费
- 2026-10-13：份额乘数（Solana Token-2022 `scaledUiAmount` / BSC ERC-8056 `uiMultiplier`）
- 2026-10-10：Solana 盈亏改按每笔操作时刻的精确池价（Raydium 日志 tick / Orca `Traded` 事件）
- 2026-10-09：设置页重设计：四项功能按钱包「纳入」，自有 / 观察标记只决定落在哪个范围
- 2026-10-08：钱包盈亏新增「按交易对」视角
- 2026-10-02：充提记录与净入金；开仓成本全部精确（Jupiter 限价单、SOL 自控地址 / 协议存取识别）；快照的已实现 / 手续费按账本时间线回写
- 2026-10-01：开源
