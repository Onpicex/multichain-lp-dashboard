# LP Dashboard - Uniswap V3 BSC

## 需求
- Web页面，端口 5179
- 扫描钱包 `0x6831fbc05ceaf0016b0f6f4623b031492f617d8d` 在 Uniswap V3 BSC 上的所有 LP 头寸
- 展示每个头寸的基础信息：交易对、费率、价格区间、当前价、是否 in-range、流动性、待领取手续费
- 接入 CoinGecko 免费 API 获取 USD 价值
- 每2小时自动刷新 + 手动刷新按钮

## 技术栈
- Node.js + Express (后端)
- ethers.js v6 (链上交互)
- 原生 HTML/CSS/JS (前端，单页面，不用框架)
- BSC 公共 RPC: https://bsc-dataseed.binance.org

## BSC 合约地址
- NonfungiblePositionManager: `0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613`
- UniswapV3Factory: `0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7`
- WBNB: `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c`

## 数据获取链路
1. `balanceOf(wallet)` → 持有多少个 V3 position NFT
2. `tokenOfOwnerByIndex(wallet, index)` → 每个 position 的 tokenId
3. `positions(tokenId)` → 头寸详情 (token0, token1, fee, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1)
4. ERC20 `symbol()` + `decimals()` → token 信息
5. Pool 合约 `slot0()` → 当前 sqrtPriceX96 和 tick
6. 计算 tick → price，判断 in-range
7. CoinGecko API 获取 USD 价格

## 展示信息（每个头寸）
- Token ID
- 交易对 (如 WBNB/USDT)
- 费率等级 (0.05% / 0.25% / 1%)
- 价格区间 (lower - upper)
- 当前价格
- 是否 In Range (✅/❌)
- 流动性数值
- Token0 数量 + Token1 数量（基于当前价格计算）
- 待领取手续费 (token0 + token1)
- USD 总价值 (头寸价值 + 未领取手续费)

## 页面设计
- 暗色主题（DeFi 风格）
- 顶部：钱包地址 + 总价值汇总 + 刷新按钮 + 上次刷新时间
- 卡片式展示每个头寸
- 响应式布局
- 自动每2小时刷新 + 手动刷新按钮
