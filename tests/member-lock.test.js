// 付费墙锁定逻辑本地 mock 测试（Node，不连微信、不连云开发）
// 跑法：node tests/member-lock.test.js
// 覆盖：免费/锁定分界（Vol.01–03 免费、Vol.04 起锁定）与 fail-open 安全铁律——
// 后端未配置 / 调用失败 / 超时 / 会员未确认时，一律不锁内容。
'use strict';
const assert = require('node:assert/strict');

const MEMBER_PATH = '../miniprogram/utils/member.js';

function freshMember() {
  delete require.cache[require.resolve(MEMBER_PATH)];
  return require(MEMBER_PATH);
}

function mockWx(callImpl) {
  const calls = [];
  global.wx = {
    cloud: {
      init() {},
      callFunction(opts) {
        calls.push(opts);
        return callImpl(opts);
      },
    },
  };
  return calls;
}

function clearWx() { delete global.wx; }

const results = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push(['PASS', name]); })
    .catch((err) => { results.push(['FAIL', name + ' :: ' + err.message]); });
}

(async () => {
  // 1. 纯函数：期号解析与免费分界
  await test('volNum 解析：vol04=4，空值=0', () => {
    const m = freshMember();
    assert.equal(m.volNum('vol04'), 4);
    assert.equal(m.volNum('vol50'), 50);
    assert.equal(m.volNum(''), 0);
    assert.equal(m.volNum(null), 0);
  });
  await test('免费分界：Vol.01–03 免费，Vol.04/Vol.50 不免费', () => {
    const m = freshMember();
    assert.equal(m.isFreeVol('vol01'), true);
    assert.equal(m.isFreeVol('vol03'), true);
    assert.equal(m.isFreeVol('vol04'), false);
    assert.equal(m.isFreeVol('vol50'), false);
  });

  // 2. isLocked 矩阵
  await test('isLocked：免费期任何状态都不锁', () => {
    const m = freshMember();
    assert.equal(m.isLocked('vol01', { checked: true, isMember: false }), false);
    assert.equal(m.isLocked('vol03', { checked: true, isMember: false }), false);
  });
  await test('isLocked：Vol.04+ 已确认非会员才锁', () => {
    const m = freshMember();
    assert.equal(m.isLocked('vol04', { checked: true, isMember: false }), true);
    assert.equal(m.isLocked('vol50', { checked: true, isMember: false }), true);
  });
  await test('isLocked：会员不锁', () => {
    const m = freshMember();
    assert.equal(m.isLocked('vol04', { checked: true, isMember: true }), false);
  });
  await test('isLocked：状态未确认（null / checked:false）不锁', () => {
    const m = freshMember();
    assert.equal(m.isLocked('vol04', null), false);
    assert.equal(m.isLocked('vol04', undefined), false);
    assert.equal(m.isLocked('vol04', { checked: false, isMember: false }), false);
  });

  // 3. checkMember：后端未配置 → fail-open
  await test('checkMember 未配置环境：返回未确认，Vol.04 不锁', async () => {
    const m = freshMember();
    clearWx();
    const st = await m.checkMember();
    assert.equal(st.checked, false);
    assert.equal(st.reason, 'not-configured');
    assert.equal(m.isLocked('vol04', st), false);
  });

  // 4. checkMember：云函数确认非会员 → 锁 Vol.04+，不锁 Vol.01–03
  await test('checkMember 确认非会员：Vol.04 锁，Vol.03 不锁', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    mockWx(() => Promise.resolve({ result: { ok: true, isMember: false, expireAt: null } }));
    const st = await m.checkMember();
    assert.equal(st.checked, true);
    assert.equal(st.isMember, false);
    assert.equal(m.isLocked('vol04', st), true);
    assert.equal(m.isLocked('vol03', st), false);
    clearWx();
  });

  // 5. checkMember：云函数确认会员 → 不锁
  await test('checkMember 确认会员：Vol.50 不锁', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    mockWx(() => Promise.resolve({ result: { ok: true, isMember: true, expireAt: '2027-11-14T00:00:00.000Z' } }));
    const st = await m.checkMember();
    assert.equal(st.checked, true);
    assert.equal(st.isMember, true);
    assert.equal(m.isLocked('vol50', st), false);
    clearWx();
  });

  // 6. checkMember：云函数调用失败 → fail-open，不锁
  await test('checkMember 调用失败：返回未确认，Vol.04 不锁', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    mockWx(() => Promise.reject(new Error('network down')));
    const st = await m.checkMember();
    assert.equal(st.checked, false);
    assert.equal(m.isLocked('vol04', st), false);
    clearWx();
  });

  // 7. checkMember：云函数无响应 → 超时后 fail-open，不锁
  await test('checkMember 超时：返回未确认，Vol.04 不锁', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    m.__setCheckTimeoutForTest(50);
    mockWx(() => new Promise(() => {})); // 永不 resolve
    const st = await m.checkMember();
    assert.equal(st.checked, false);
    assert.equal(st.reason, 'TIMEOUT');
    assert.equal(m.isLocked('vol04', st), false);
    clearWx();
  });

  // 8. 缓存：5 分钟内第二次查询不重复调云函数
  await test('checkMember 缓存：第二次查询不重复调云函数', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    const calls = mockWx(() => Promise.resolve({ result: { ok: true, isMember: true } }));
    const st1 = await m.checkMember();
    const st2 = await m.checkMember();
    assert.equal(calls.length, 1);
    assert.equal(st1, st2);
    clearWx();
  });

  // 9. bindTaobaoBuyer 成功后缓存会员态
  await test('bindTaobaoBuyer 成功：返回 ok 并缓存为会员', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    mockWx(() => Promise.resolve({ result: { ok: true, isMember: true, expireAt: '2027-11-14T00:00:00.000Z' } }));
    const r = await m.bindTaobaoBuyer('mock-code');
    assert.equal(r.ok, true);
    assert.equal(m.getCachedState().isMember, true);
    assert.equal(m.isLocked('vol04', m.getCachedState()), false);
    clearWx();
  });

  // 10. createOrder：未配置云环境时直接返回 PAY_NOT_CONFIGURED，不调云函数
  // （PAY_ENABLED=true 是上线态；未开通路径改由“环境未配置”覆盖）
  await test('createOrder 未配置：返回 PAY_NOT_CONFIGURED，不调云函数', async () => {
    const m = freshMember();
    m.__setEnvForTest(''); // 未配置环境
    const calls = mockWx(() => Promise.resolve({ result: { ok: true } }));
    const r = await m.createOrder();
    assert.equal(r.code, 'PAY_NOT_CONFIGURED');
    assert.equal(calls.length, 0);
    clearWx();
  });

  // 11. getMemberInfo：未配置云环境时返回 NOT_CONFIGURED，不调云函数
  await test('getMemberInfo 未配置：返回 NOT_CONFIGURED，不调云函数', async () => {
    const m = freshMember();
    m.__setEnvForTest('');
    const calls = mockWx(() => Promise.resolve({ result: { ok: true } }));
    const r = await m.getMemberInfo();
    assert.equal(r.code, 'NOT_CONFIGURED');
    assert.equal(calls.length, 0);
    clearWx();
  });

  // 12. getMemberInfo：成功返回会员中心取数（到期日、手机号、最近一笔订单）
  await test('getMemberInfo 成功：返回会员中心取数', async () => {
    const m = freshMember();
    m.__setEnvForTest('test-env');
    mockWx(() => Promise.resolve({ result: {
      ok: true, isMember: true, expireAt: '2027-11-19T00:00:00.000Z',
      memberSince: '2026-11-19T00:00:00.000Z', source: 'wechat_pay', phone: null,
      lastOrder: { outTradeNo: 'ML1', amount: 1, paidAt: '2026-11-19T00:00:00.000Z' },
    } }));
    const r = await m.getMemberInfo();
    assert.equal(r.ok, true);
    assert.equal(r.isMember, true);
    assert.equal(r.lastOrder.amount, 1);
    assert.equal(r.phone, null);
    clearWx();
  });

  // 汇总
  let failed = 0;
  for (const [status, name] of results) {
    // eslint-disable-next-line no-console
    console.log(status + '  ' + name);
    if (status === 'FAIL') failed += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
