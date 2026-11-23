// 会员状态工具（付费墙共用：首页 + 单集页 + 购买页）
//
// ★ 安全铁律：后端未部署 / 未配置 / 调用失败 / 超时时，一律保持现有免费行为（fail-open），
//   绝不因后端缺失把用户锁在内容外面。锁定只在一种情况下发生：云函数已确认该用户不是会员。
//
// 配置（部署时改这两处，见 cloudfunctions/README.md）：
//   CLOUD_ENV：云开发环境 ID，未创建环境前留空；
//   PAY_ENABLED：支付接好之前保持 false（购买按钮只提示“支付接入中”）；
//     商户模式确定、pay 云函数接好后再改 true。
let CLOUD_ENV = 'michael-podcast-d0fbngep770f0d12';
const PAY_ENABLED = true; // ⚠️ 临时为 ¥0.01 测试打开；测完、提 1.2.1 前再确认一次

// 价格（展示用；真正收钱的金额只从服务端常量取，客户端传来的金额服务端一律不认）
const PRICE_CNY = 98;
const PRICE_TEXT = '¥98/年';
const MEMBERSHIP_TEXT = '12 个月';

const FREE_MAX_VOL = 3; // Vol.01–03 免费，Vol.04 起会员才能看
const CHECK_TIMEOUT_MS = 3000; // 会员查询超时（毫秒），超时按未确认处理（不锁）
const CACHE_TTL_MS = 5 * 60 * 1000; // 会员状态缓存 5 分钟

let _cloudInited = false;
let _state = null; // { checked, isMember, expireAt, reason }
let _stateAt = 0;
let _inflight = null;
let _checkTimeoutMs = CHECK_TIMEOUT_MS;

// 仅供本地 mock 测试改配置用（生产代码不调用）
function __setEnvForTest(env) { CLOUD_ENV = env || ''; _cloudInited = false; }
function __setCheckTimeoutForTest(ms) { _checkTimeoutMs = ms; }
function __resetCacheForTest() { _state = null; _stateAt = 0; _inflight = null; }

function logEvent(name, data) {
  // eslint-disable-next-line no-console
  console.log('[member]', name, data || '');
}

function volNum(id) {
  const n = parseInt(String(id || '').replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function isFreeVol(id) {
  return volNum(id) <= FREE_MAX_VOL;
}

// 锁定判定：只有“已确认非会员”才锁；其它一切情况（免费期、会员、未配置、调用失败、超时）都不锁
function isLocked(id, state) {
  if (isFreeVol(id)) return false;
  if (!state || !state.checked) return false;
  return !state.isMember;
}

function isConfigured() {
  return !!CLOUD_ENV && typeof wx !== 'undefined' && !!wx.cloud;
}

function _ensureCloud() {
  if (_cloudInited) return true;
  if (!isConfigured()) return false;
  try {
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    _cloudInited = true;
    return true;
  } catch (err) {
    logEvent('cloud-init-failed', err);
    return false;
  }
}

function _withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, code: 'TIMEOUT' }); }
    }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, code: 'CALL_FAILED', error: e }); } },
    );
  });
}

// 查会员状态（带缓存 + 超时）。任何失败都返回 { checked: false }，调用方按“不锁”处理。
function checkMember(force) {
  const now = Date.now();
  if (!force && _state && now - _stateAt < CACHE_TTL_MS) return Promise.resolve(_state);
  if (_inflight) return _inflight;
  if (!isConfigured() || !_ensureCloud()) {
    _state = { checked: false, isMember: false, expireAt: null, reason: 'not-configured' };
    _stateAt = now;
    return Promise.resolve(_state);
  }
  _inflight = _withTimeout(
    wx.cloud.callFunction({ name: 'member', data: { action: 'checkMember' } }),
    _checkTimeoutMs,
  ).then((res) => {
    _inflight = null;
    // 成功时 res = { result: {...} }（云函数回包）；超时/调用失败时 res 本身就是 { ok:false, code }，无 result 字段
    const r = (res && res.result) || res || {};
    if (r.ok && typeof r.isMember === 'boolean') {
      _state = { checked: true, isMember: r.isMember, expireAt: r.expireAt || null, reason: '' };
    } else {
      logEvent('checkMember-failed', r);
      _state = { checked: false, isMember: false, expireAt: null, reason: (r && r.code) || 'call-failed' };
    }
    _stateAt = Date.now();
    return _state;
  });
  return _inflight;
}

function getCachedState() {
  return _state;
}

// 调 pay 云函数统一下单（占位：商户模式未定，服务端返回 PAY_NOT_CONFIGURED）
function createOrder() {
  if (!PAY_ENABLED || !isConfigured() || !_ensureCloud()) {
    return Promise.resolve({ ok: false, code: 'PAY_NOT_CONFIGURED' });
  }
  return _withTimeout(
    wx.cloud.callFunction({ name: 'pay', data: { action: 'createOrder' } }),
    _checkTimeoutMs,
  ).then((res) => (res && res.result) || res || { ok: false, code: 'CALL_FAILED' });
}

// 会员中心取数：到期日、开通日期、手机号、最近一笔已付订单（无缓存，每次现查）
function getMemberInfo() {
  if (!isConfigured() || !_ensureCloud()) {
    return Promise.resolve({ ok: false, code: 'NOT_CONFIGURED' });
  }
  return _withTimeout(
    wx.cloud.callFunction({ name: 'member', data: { action: 'getMemberInfo' } }),
    _checkTimeoutMs,
  ).then((res) => (res && res.result) || res || { ok: false, code: 'CALL_FAILED' });
}

// 淘宝买家一键绑定：code 来自 getPhoneNumber 的动态令牌，服务端用云调用换手机号后与名单核对
// 绑定要走微信服务端换手机号 + 两次数据库写，3 秒经常不够：单独给 10 秒超时
function bindTaobaoBuyer(code) {
  if (!code) return Promise.resolve({ ok: false, code: 'NO_CODE' });
  if (!isConfigured() || !_ensureCloud()) {
    return Promise.resolve({ ok: false, code: 'NOT_CONFIGURED' });
  }
  return _withTimeout(
    wx.cloud.callFunction({ name: 'member', data: { action: 'bindPhone', code } }),
    10000,
  ).then((res) => {
    const r = (res && res.result) || res || { ok: false, code: 'CALL_FAILED' };
    if (r.ok) {
      _state = { checked: true, isMember: true, expireAt: r.expireAt || null, reason: '' };
      _stateAt = Date.now();
    }
    return r;
  });
}

module.exports = {
  FREE_MAX_VOL,
  PRICE_CNY,
  PRICE_TEXT,
  MEMBERSHIP_TEXT,
  PAY_ENABLED,
  volNum,
  isFreeVol,
  isLocked,
  isConfigured,
  checkMember,
  getMemberInfo,
  getCachedState,
  createOrder,
  bindTaobaoBuyer,
  logEvent,
  __setEnvForTest,
  __setCheckTimeoutForTest,
  __resetCacheForTest,
};
