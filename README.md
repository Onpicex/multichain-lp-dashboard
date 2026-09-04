# LP Dashboard

Uniswap V3 + V4 LP 仪表盘（BSC 链）

## 功能
- 多钱包 LP 头寸监控
- 实时价格区间 & 状态（区间内/外）
- 未领取手续费计算
- 日化收益率估算（精确版：领费后自动重算起点）
- 深蓝色调 UI，支持移动端

## 技术栈
- **后端**: Node.js + Express + ethers.js
- **数据源**: Uniswap V3/V4 Subgraph (The Graph) + BSC RPC
- **前端**: 原生 HTML/CSS/JS（零依赖）

## 部署
```bash
npm install
node server.js
# 默认监听 0.0.0.0:5179
```

## 配置
编辑 `server.js` 顶部：
- `WALLETS` — 钱包地址列表
- `GRAPH_KEYS` — The Graph API Keys
- `PORT` — 监听端口
