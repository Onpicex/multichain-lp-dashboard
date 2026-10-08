// own-sync.js 单测: 临时目录造四份配置, 验证 切观察剔除 / 切自有补进 / 跟随自有不动 / 换地址 / 大小写与 sol 区分 / 其它字段保留 / 文件格式
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const { syncOwnFlag, syncAddrChange } = require('../own-sync');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-sync-'));
const w = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', a = A.toLowerCase(), B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const S1 = 'So1anaTestWa11et1111111111111111111111111111', S2 = 'So1anaTestWa11et2222222222222222222222222222';   // 合成地址 (模块不校验格式)
fs.writeFileSync(path.join(dir, 'fund-config.json'), JSON.stringify({ enabled: true, wallets: { sol: [S1, S2], rh: [a, B] } }, null, 2));
fs.writeFileSync(path.join(dir, 'pnl-config.json'), JSON.stringify({ enabled: true, wallets: { sol: [S1, S2] } }, null, 2));
fs.writeFileSync(path.join(dir, 'snapshot-config.json'), JSON.stringify({ enabled: true, observe: true, tz: 'Asia/Shanghai', wallets: { sol: [S1, S2] }, intervalMin: 5, lastRun: { ts: 1 } }, null, 2));
fs.writeFileSync(path.join(dir, 'notify-config.json'), JSON.stringify({ enabled: true, channel: 'sentinel', intervalMin: 5, wallets: {} }));
// 1. sol 切观察: 三份有 sol 名单的都剔除, notify (跟随自有) 不动; 其它字段保留
assert.deepStrictEqual(syncOwnFlag('sol', S2, false, dir).sort(), ['fund', 'pnl', 'snapshot']);
assert.deepStrictEqual(w('fund-config.json').wallets, { sol: [S1], rh: [a, B] });
assert.deepStrictEqual(w('pnl-config.json').wallets, { sol: [S1] });
const sp = w('snapshot-config.json'); assert.deepStrictEqual(sp.wallets, { sol: [S1] }); assert.strictEqual(sp.observe, true); assert.strictEqual(sp.tz, 'Asia/Shanghai'); assert.strictEqual(sp.intervalMin, 5); assert.deepStrictEqual(sp.lastRun, { ts: 1 });
assert.deepStrictEqual(w('notify-config.json').wallets, {});
// 2. 再切一次观察: 幂等, 无改动
assert.deepStrictEqual(syncOwnFlag('sol', S2, false, dir), []);
// 3. sol 切自有: 有显式名单的补进去 (末尾), 没名单的不动
assert.deepStrictEqual(syncOwnFlag('sol', S2, true, dir).sort(), ['fund', 'pnl', 'snapshot']);
assert.deepStrictEqual(w('fund-config.json').wallets.sol, [S1, S2]);
assert.deepStrictEqual(syncOwnFlag('sol', S2, true, dir), []);   // 幂等
// 4. 跟随自有的链 (rh 在 pnl 没名单): 不动; EVM 大小写不敏感
assert.deepStrictEqual(syncOwnFlag('rh', A, false, dir), ['fund']);
assert.deepStrictEqual(w('fund-config.json').wallets.rh, [B]);
assert.deepStrictEqual(w('pnl-config.json').wallets, { sol: [S1, S2] });
// 5. sol 大小写敏感: 小写化的地址不算同一个
assert.deepStrictEqual(syncOwnFlag('sol', S1.toLowerCase(), false, dir), []);
// 6. 换地址: 旧剔新补 (新为自有); 新地址非自有时只剔旧
const so = syncOwnFlag;
assert.deepStrictEqual(syncAddrChange('rh', B, A, true, dir), ['fund', 'fund']);
assert.deepStrictEqual(w('fund-config.json').wallets.rh, [A]);
// 7. 文件缺失 / 损坏: 跳过不抛
fs.writeFileSync(path.join(dir, 'pnl-config.json'), '{broken');
fs.unlinkSync(path.join(dir, 'notify-config.json'));
assert.deepStrictEqual(so('sol', S1, false, dir).sort(), ['fund', 'snapshot']);
// 8. 格式: fund 2 空格缩进, snapshot 600 权限
assert.ok(fs.readFileSync(path.join(dir, 'fund-config.json'), 'utf8').includes('\n  "wallets"'));
assert.strictEqual(fs.statSync(path.join(dir, 'snapshot-config.json')).mode & 0o777, 0o600);
fs.rmSync(dir, { recursive: true, force: true });
console.log('own-sync-test: all passed');
