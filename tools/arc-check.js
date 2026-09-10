#!/usr/bin/env node
// =============================================================
// Arc 主网上线自检 — 给出 GO / NO-GO，是把 EVM_CHAINS.arc.pending 改成 false 的唯一依据。
//
//   用法:  node tools/arc-check.js
//          ARC_RPC=https://<官方主网RPC> node tools/arc-check.js
//
// 检查项:
//   1. RPC 可达 + eth_chainId === 5042
//   2. 6 个关键合约 eth_getCode 有代码
//   3. 交叉验证 (比"有代码"强得多, 沿用本仓库既有约定):
//        NonfungiblePositionManager.factory()  === v3.factory
//        V4 PositionManager.poolManager()      === v4.poolManager
//   4. 二分查块定位 V4 PoolManager 部署块 -> deployBlock (无区块浏览器可用, V4 仓位枚举必需)
//   5. 探 eth_getLogs 单段上限 / JSON-RPC batch 是否悬死 (决定要不要像 rh 那样置 noBatch)
//   6. 打印可直接粘贴的 EVM_CHAINS.arc 配置块
// =============================================================
const { ethers } = require('ethers');

const EXPECT_CHAIN_ID = 5042;
// 候选主网 RPC (2026-09-08 全部实测不可达; 上线后以 docs.arc.io/arc/references/connect-to-arc 为准)
const RPC_CANDIDATES = [
  process.env.ARC_RPC,
  'https://rpc.arc.io',
  'https://rpc.mainnet.arc.io',
  'https://arc.drpc.org',
].filter(Boolean);

// 来源 Uniswap sdk-core ARC_ADDRESSES —— 本脚本的全部意义就是把它们从"听说"变成"链上验证过"
const C = {
  'v3 factory':           '0xf0db7b58379503491d857db50ac9ece64c653918',
  'v3 NPM':               '0x39654a85a4c05127f5fd6ed22caec077a0fb1377',
  'v4 PoolManager':       '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  'v4 PositionManager':   '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',
  'v4 StateView':         '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  'Multicall3':           '0xcA11bde05977b3631167028862bE2a173976CA11',
  'USDC ERC20 预编译':    '0x3600000000000000000000000000000000000000',
};

const ok = s => `\x1b[32m✓\x1b[0m ${s}`;
const bad = s => `\x1b[31m✗\x1b[0m ${s}`;
const warn = s => `\x1b[33m!\x1b[0m ${s}`;
const fails = [];
const notes = [];

async function rpcCall(url, method, params, timeoutMs = 8000) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 80)}`); }
  if (j.error) throw new Error(`${j.error.message} (code ${j.error.code})`);
  return j.result;
}

// --- 1. 找一个能用的 RPC ---
async function pickRpc() {
  console.log('\n[1/6] 探测主网 RPC');
  for (const url of RPC_CANDIDATES) {
    try {
      const cid = parseInt(await rpcCall(url, 'eth_chainId', []), 16);
      if (cid !== EXPECT_CHAIN_ID) {
        console.log(warn(`${url} -> chainId ${cid}，不是 Arc 主网 ${EXPECT_CHAIN_ID}${cid === 5042002 ? ' (这是测试网)' : ''}`));
        continue;
      }
      const bn = parseInt(await rpcCall(url, 'eth_blockNumber', []), 16);
      console.log(ok(`${url} -> chainId ${cid}，块高 ${bn.toLocaleString()}`));
      return { url, head: bn };
    } catch (e) {
      console.log(bad(`${url} -> ${e.message.slice(0, 80)}`));
    }
  }
  return null;
}

// --- 2. 合约有代码 ---
async function checkCode(url) {
  console.log('\n[2/6] 合约字节码');
  const present = {};
  for (const [name, addr] of Object.entries(C)) {
    try {
      const code = await rpcCall(url, 'eth_getCode', [addr, 'latest']);
      const bytes = (code.length - 2) / 2;
      present[name] = bytes > 0;
      console.log(bytes > 0 ? ok(`${name.padEnd(22)} ${addr}  ${bytes} 字节`)
                            : bad(`${name.padEnd(22)} ${addr}  无代码`));
      if (bytes === 0) fails.push(`${name} 在 ${addr} 上没有代码`);
    } catch (e) {
      console.log(bad(`${name.padEnd(22)} ${addr}  查询失败: ${e.message.slice(0, 50)}`));
      fails.push(`${name} eth_getCode 失败`);
    }
  }
  return present;
}

// --- 3. 交叉验证: 合约自己说出来的地址要对得上 ---
async function crossCheck(url) {
  console.log('\n[3/6] 交叉验证 (合约互指)');
  const provider = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
  const pairs = [
    ['v3 NPM.factory()', C['v3 NPM'], ['function factory() view returns (address)'], 'factory', C['v3 factory'], 'v3 factory'],
    ['v4 PositionManager.poolManager()', C['v4 PositionManager'], ['function poolManager() view returns (address)'], 'poolManager', C['v4 PoolManager'], 'v4 PoolManager'],
  ];
  for (const [label, addr, abi, fn, expect, expectName] of pairs) {
    try {
      const got = String(await new ethers.Contract(addr, abi, provider)[fn]()).toLowerCase();
      if (got === expect.toLowerCase()) console.log(ok(`${label} -> ${got}  == ${expectName}`));
      else { console.log(bad(`${label} -> ${got}  ≠ ${expectName} (${expect})`)); fails.push(`${label} 指向的地址与配置不符`); }
    } catch (e) {
      console.log(bad(`${label} 调用失败: ${e.message.slice(0, 60)}`));
      fails.push(`${label} 调用失败`);
    }
  }
}

// --- 4. 二分查 PoolManager 部署块 (V4 Transfer 日志枚举的扫描起点, 没有它 V4 仓位抓不全) ---
async function findDeployBlock(url, head) {
  console.log('\n[4/6] 定位 V4 PoolManager 部署块');
  const addr = C['v4 PoolManager'];
  const hasCode = async (bn) => {
    const code = await rpcCall(url, 'eth_getCode', [addr, '0x' + bn.toString(16)]);
    return code && code !== '0x';
  };
  try {
    if (!(await hasCode(head))) { console.log(bad('最新块上都没有代码，跳过')); return null; }
    if (await hasCode(0)) { console.log(ok('创世块即存在 (预部署), deployBlock = 0')); return 0; }
    let lo = 0, hi = head, steps = 0;
    while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); (await hasCode(mid)) ? hi = mid : lo = mid; steps++; }
    console.log(ok(`deployBlock = ${hi}  (二分 ${steps} 次${hi === 0 ? '' : `，前一块 ${lo} 无代码`})`));
    return hi;
  } catch (e) {
    console.log(warn(`定位失败 (RPC 可能非归档节点): ${e.message.slice(0, 70)}`));
    notes.push('deployBlock 未能自动定位，需人工从浏览器查 PoolManager 的创建交易');
    return null;
  }
}

// --- 5. RPC 能力: getLogs 单段上限 + batch 是否悬死 ---
async function probeCapabilities(url, head) {
  console.log('\n[5/6] RPC 能力');
  // 限速/超时是暂时的, 不能和"这个 RPC 根本不支持 getLogs"混为一谈 —— 前者误判会在上线当天
  // 报出假 NO-GO。故对疑似限速的失败退避重试一次, 且最终只降级为警告而不是硬失败。
  const transient = m => /rate limit|too many|429|timeout|abort|econnreset|503|502/i.test(m);
  let logsSpan = null, sawTransient = false;
  for (const span of [100000, 10000, 2000, 500]) {
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rpcCall(url, 'eth_getLogs', [{
          address: C['v4 PoolManager'],
          fromBlock: '0x' + Math.max(0, head - span).toString(16), toBlock: '0x' + head.toString(16),
        }], 15000);
        logsSpan = span; break;
      } catch (e) {
        lastErr = e.message;
        if (attempt === 0 && transient(lastErr)) { await new Promise(r => setTimeout(r, 3000)); continue; }
        break;
      }
    }
    if (logsSpan) { console.log(ok(`eth_getLogs 单段可取 ${span} 块`)); break; }
    if (transient(lastErr)) sawTransient = true;
    console.log(warn(`eth_getLogs ${span} 块 -> ${lastErr.slice(0, 60)}`));
  }
  if (!logsSpan) {
    if (sawTransient) {
      console.log(warn('getLogs 探测受限速干扰, 判定不可信'));
      notes.push('eth_getLogs 段长未能测出(疑似限速), 上线后请换个时段或换 RPC 重跑本项 — V4 仓位枚举依赖它');
    } else {
      fails.push('eth_getLogs 全部段长都失败 — 无子图+无浏览器时 V4 仓位无法枚举');
    }
  }

  let noBatch = false;
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'eth_chainId', params: [] }))),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (Array.isArray(j) && j.length === 5) console.log(ok('JSON-RPC batch 正常 (noBatch 不需要)'));
    else { noBatch = true; console.log(warn('batch 响应异常 -> 建议置 noBatch: true')); }
  } catch (e) {
    noBatch = true;
    console.log(warn(`batch 请求失败/超时 (${e.message.slice(0, 40)}) -> 置 noBatch: true (同 rh)`));
  }
  return { logsSpan, noBatch };
}

// --- 6. 输出配置块 ---
function printConfig(rpcUrl, deployBlock, caps) {
  const today = new Date().toISOString().slice(0, 10);
  console.log('\n[6/6] 可粘贴的 EVM_CHAINS.arc 配置片段\n');
  console.log(`    rpc: process.env.ARC_RPC || '${rpcUrl}',`);
  console.log(`    v3: {`);
  console.log(`      npm: '${C['v3 NPM']}',      // factory() 已链上验证 ${today}`);
  console.log(`      factory: '${C['v3 factory']}',`);
  console.log(`    },`);
  console.log(`    v4: {`);
  console.log(`      pm: '${C['v4 PositionManager']}',           // poolManager() 已链上验证 ${today}`);
  console.log(`      stateView: '${C['v4 StateView']}',`);
  console.log(`      poolManager: '${C['v4 PoolManager']}',`);
  console.log(`      deployBlock: ${deployBlock === null ? 'null,   // ← 未能自动定位, 需人工填' : `${deployBlock},`}`);
  console.log(`    },`);
  if (caps.noBatch) console.log(`    noBatch: true,   // 自检发现 batch 异常`);
  console.log(`    pending: false,   // ← 记得连同 server.js CHAINS 里的 arc 一起改 enabled:true 并删 pending`);
}

(async () => {
  console.log('===== Arc 主网上线自检 =====');
  console.log(`目标 chainId: ${EXPECT_CHAIN_ID} · 候选 RPC ${RPC_CANDIDATES.length} 个`);
  const picked = await pickRpc();
  if (!picked) {
    console.log('\n\x1b[31m结论: NO-GO\x1b[0m — 没有可用的 Arc 主网 RPC。');
    console.log('  主网预计 2026-09-16 上线; 上线后到 docs.arc.io/arc/references/connect-to-arc 取官方 RPC,');
    console.log('  用 ARC_RPC=<url> node tools/arc-check.js 重跑。');
    process.exit(1);
  }
  await checkCode(picked.url);
  await crossCheck(picked.url);
  const deployBlock = await findDeployBlock(picked.url, picked.head);
  const caps = await probeCapabilities(picked.url, picked.head);

  console.log('\n===== 结论 =====');
  if (fails.length) {
    console.log('\x1b[31mNO-GO\x1b[0m — 以下项未通过, 不要打开 pending 开关:');
    for (const f of fails) console.log('  · ' + f);
    process.exit(1);
  }
  for (const n of notes) console.log(warn(n));
  console.log('\x1b[32mGO\x1b[0m — 全部检查通过。');
  printConfig(picked.url, deployBlock, caps);
  console.log('\n后续: 填配置 -> pending:false -> server.js CHAINS 改 enabled:true 并删 pending -> 加钱包 -> 重启 -> 验证首轮抓取');
})();
