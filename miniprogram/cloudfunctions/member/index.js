// 云函数 member：会员相关接口（CloudBase 云函数，Node.js）
//
// 部署前置（见同目录 README.md）：
//   1. 在小程序后台开通云开发、创建环境；
//   2. 小程序端 utils/member.js 填入环境 ID（CLOUD_ENV）；
//   3. 在云开发控制台创建 orders / members / taobao_buyers 三个集合（字段见 DATABASE.md）。
//
// 商户模式未定：本函数不含任何微信支付调用；统一下单与支付回调在 pay 云函数里占位，
// 待商户模式（直连商户 vs 建行服务商）确定后再接入。
//
// 安全说明：
//   - openid 只取自云函数内置的微信上下文（cloud.getWXContext），客户端传来的 openid 一律不认；
//   - 手机号只取自微信侧的可信来源：getPhoneNumber 按钮回调的动态令牌 code，
//     云函数用微信服务端接口 wxa/business/getuserphonenumber 换取（AppSecret 只存服务端环境变量），
//     客户端传来的明文手机号一律不认；
//   - 淘宝买家名单管理（增/查）是运营操作：ADMIN_OPENIDS 环境变量配了白名单时只认白名单内的
//     管理员 openid，未配白名单时部署后须在控制台手工限制调用来源，见 README.md。
const cloud = require('wx-server-sdk');
const https = require('https');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// ---- 微信服务端接口直调（不用云调用 openapi） ----
// 云调用 phonenumber.getPhoneNumber 在本环境报 -501001 invalid wx openapi access_token，
// 说明该环境的微信 openapi 凭证不可用；改走服务端 HTTPS 接口，凭证是小程序 AppSecret
//（配在云函数环境变量 WX_APPSECRET 里，服务端专用，绝不下发到前端）。
// access_token 有效期 2 小时，进程内缓存，过期或报 40001/42001 时刷新重试一次。
let _wxToken = { value: '', expireAt: 0 };
function httpsJson(options, body) {
  return new Promise((resolve, reject) => {
    // POST 带 body 时必须显式给 Content-Length，否则 Node 用 chunked 分块传输，
    // 微信 api.weixin.qq.com 网关会直接 412 空响应拒掉（getuserphonenumber 的 412 即由此来）。
    // pay 云函数就是这么做的（callWechatApi 里显式设 Content-Length），它能调通。
    const headers = Object.assign({}, options.headers || {});
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(Object.assign({}, options, { headers }), (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('bad json status=' + res.statusCode + ' raw=' + String(data).slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
async function getWxAccessToken() {
  const now = Date.now();
  if (_wxToken.value && _wxToken.expireAt > now + 60000) return _wxToken.value;
  const appid = process.env.WX_APPID || 'wx340b0d192b546b18';
  const secret = process.env.WX_APPSECRET || '';
  if (!secret) throw new Error('WX_APPSECRET_NOT_CONFIGURED');
  const res = await httpsJson({
    hostname: 'api.weixin.qq.com', port: 443,
    path: '/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(appid) + '&secret=' + encodeURIComponent(secret),
    method: 'GET', headers: { 'User-Agent': 'michael-podcast-member/1.0' },
  });
  if (!res.access_token) throw new Error('token errcode=' + res.errcode + ' errmsg=' + (res.errmsg || ''));
  _wxToken = { value: res.access_token, expireAt: now + (res.expires_in ? res.expires_in * 1000 : 7200 * 1000) - 60000 };
  return _wxToken.value;
}
async function fetchPhoneByCode(code) {
  const doCall = (token) => httpsJson({
    hostname: 'api.weixin.qq.com', port: 443,
    path: '/wxa/business/getuserphonenumber?access_token=' + encodeURIComponent(token),
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'michael-podcast-member/1.0' },
  }, JSON.stringify({ code }));
  let token = await getWxAccessToken();
  let res = await doCall(token);
  if (res.errcode === 40001 || res.errcode === 42001) {
    // token 失效：清缓存重取一次再调
    _wxToken = { value: '', expireAt: 0 };
    token = await getWxAccessToken();
    res = await doCall(token);
  }
  return res;
}

const db = cloud.database();
const _ = db.command;

// 会员期：付款日起 12 个月（365 天），与架构文档 §1 一致
const MEMBERSHIP_DAYS = 365;

// 管理员 openid 白名单（逗号分隔，配在云函数环境变量 ADMIN_OPENIDS 里）。
// 未配置时名单管理接口拒绝一切调用——须先在部署时配好，或改走控制台手工维护名单。
function isAdmin(openid) {
  const list = (process.env.ADMIN_OPENIDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return false;
  return list.indexOf(openid) !== -1;
}

// 手机号归一化：去空格、去 +86 前缀，只留 11 位数字
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s-]/g, '');
  if (p.indexOf('+86') === 0) p = p.slice(3);
  return p;
}

function isMobile(phone) {
  return /^1[3-9]\d{9}$/.test(phone);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// ---- login：取调用者 openid（小程序端登录态用，不发密码、不发手机号）----
async function login(context) {
  const wxContext = cloud.getWXContext();
  return { ok: true, openid: wxContext.OPENID };
}

// ---- checkMember：查调用者是不是会员（按到期日判断）----
async function checkMember(context) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const now = new Date();
  const res = await db.collection('members')
    .where({ openid, expireAt: _.gt(now) })
    .orderBy('expireAt', 'desc')
    .limit(1)
    .get();
  const rec = (res.data && res.data[0]) || null;
  if (!rec) return { ok: true, isMember: false, expireAt: null };
  return { ok: true, isMember: true, expireAt: rec.expireAt, source: rec.source || null };
}

// ---- getMemberInfo：会员中心取数（自己的记录：到期日、开通日期、手机号、最近一笔已付订单）----
// 只返回调用者本人的数据（openid 取自云函数内置上下文）。lastOrder 取最近一笔 PAID
// 订单（JS 内取最大 paidAt，不依赖 paidAt 索引）；没有已付订单时 lastOrder 为 null
//（如淘宝绑定开通的会员），前端按 source 显示“淘宝年包”。
async function getMemberInfo(event, context) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const now = new Date();
  const memRes = await db.collection('members')
    .where({ openid, expireAt: _.gt(now) })
    .orderBy('expireAt', 'desc')
    .limit(1)
    .get();
  let rec = (memRes.data && memRes.data[0]) || null;
  if (!rec) {
    // 无有效会员：仍看一眼有没有过期的旧记录（给前端显示“已到期”与旧手机号）
    const anyRes = await db.collection('members').where({ openid }).limit(10).get();
    const list = (anyRes.data || []).filter((r) => r.expireAt);
    if (list.length) {
      list.sort((a, b) => new Date(b.expireAt) - new Date(a.expireAt));
      rec = list[0];
    }
  }
  const orderRes = await db.collection('orders').where({ openid, status: 'PAID' }).limit(10).get();
  const paid = (orderRes.data || []).filter((o) => o.paidAt);
  paid.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
  const o = paid[0] || null;
  const lastOrder = o ? {
    outTradeNo: o.outTradeNo,
    amount: o.amount,
    paidAt: o.paidAt,
    payMethod: o.payMethod || 'wechat_pay',
  } : null;
  if (!rec) {
    return { ok: true, isMember: false, expireAt: null, memberSince: null, source: null, phone: null, lastOrder };
  }
  return {
    ok: true,
    isMember: new Date(rec.expireAt) > now,
    expireAt: rec.expireAt,
    memberSince: rec.createdAt || null,
    source: rec.source || null,
    phone: rec.phone || null,
    lastOrder,
  };
}

// ---- bindPhone：一键获取手机号，绑定淘宝买家 ----
// 客户端传 event.code（wx.getPhoneNumber 按钮回调里的动态令牌，基础库 2.21.2+，5 分钟内一次有效）；
// 服务端用微信服务端接口 wxa/business/getuserphonenumber 换手机号，再与 taobao_buyers 名单核对。
// 注意：不要用云调用 cloud.openapi.phonenumber.getPhoneNumber——本环境报 -501001
// invalid wx openapi access_token，云调用凭证不可用；也不要用已不存在的 cloud.getPhoneNumber。
// 流程：名单里有这个手机号 → 开通/续期会员 12 个月（source=taobao），名单标记已绑定；
//       名单里没有 → 返回 NOT_TAOBAO_BUYER（前端提示用户核对手机号或联系运营者）。
async function bindPhone(event, context) {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const code = event.code || '';
  if (!code) {
    return { ok: false, code: 'NO_CODE', message: '未拿到手机号授权，请重新点选授权' };
  }
  let phoneRes;
  try {
    phoneRes = await fetchPhoneByCode(code);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    console.error('[bindPhone] getuserphonenumber throw:', msg);
    return { ok: false, code: 'PHONE_RESOLVE_FAILED', message: '手机号解析失败，请重试' };
  }
  // 服务端接口返回：{ errcode, errmsg, phone_info: { phoneNumber, purePhoneNumber, countryCode, watermark } }
  const phoneInfo = (phoneRes && phoneRes.phone_info) || null;
  if (!phoneInfo || !phoneInfo.phoneNumber || phoneRes.errcode !== 0) {
    const detail = 'errcode=' + phoneRes.errcode + ' errmsg=' + (phoneRes.errmsg || '');
    console.error('[bindPhone] getuserphonenumber bad response:', detail);
    return { ok: false, code: 'PHONE_RESOLVE_FAILED', message: '手机号解析失败，请重试' };
  }
  const phone = normalizePhone(phoneInfo.phoneNumber);
  if (!isMobile(phone)) {
    return { ok: false, code: 'BAD_PHONE', message: '手机号格式不正确' };
  }

  const buyerRes = await db.collection('taobao_buyers').where({ phone }).limit(1).get();
  const buyer = (buyerRes.data && buyerRes.data[0]) || null;
  if (!buyer) {
    return { ok: false, code: 'NOT_TAOBAO_BUYER', message: '没查到这个手机号的淘宝购买记录' };
  }
  if (buyer.boundOpenid && buyer.boundOpenid !== openid) {
    return { ok: false, code: 'ALREADY_BOUND', message: '这个手机号已绑定过另一个微信号' };
  }

  // 已是会员（无论来源）则不重复开新期：直接返回现有到期日（幂等）。
  // 同时把这次绑定的手机号存到会员记录上（会员中心要显示“绑定手机号”），
  // 并把淘宝买家标记为已绑定（避免同一手机号被绑到另一个微信号）。
  const now = new Date();
  const memRes = await db.collection('members')
    .where({ openid, expireAt: _.gt(now) })
    .orderBy('expireAt', 'desc')
    .limit(1)
    .get();
  if (memRes.data && memRes.data[0]) {
    const existing = memRes.data[0];
    if (!existing.phone) {
      await db.collection('members').doc(existing._id).update({ data: { phone } });
    }
    if (!buyer.bound) {
      await db.collection('taobao_buyers').doc(buyer._id).update({
        data: { bound: true, boundOpenid: openid, boundAt: now },
      });
    }
    return { ok: true, isMember: true, expireAt: existing.expireAt, alreadyMember: true };
  }

  const expireAt = addDays(now, MEMBERSHIP_DAYS);
  await db.collection('members').add({
    data: { openid, phone, expireAt, source: 'taobao', createdAt: now, taobaoOrderId: buyer.taobaoOrderId || null },
  });
  await db.collection('taobao_buyers').doc(buyer._id).update({
    data: { bound: true, boundOpenid: openid, boundAt: now },
  });
  return { ok: true, isMember: true, expireAt, alreadyMember: false };
}

// ---- listTaobaoBuyers：查淘宝买家名单（运营用，须管理员白名单）----
async function listTaobaoBuyers(event, context) {
  const wxContext = cloud.getWXContext();
  if (!isAdmin(wxContext.OPENID)) {
    return { ok: false, code: 'FORBIDDEN', message: '无权限' };
  }
  const limit = Math.min(Math.max(parseInt(event.limit, 10) || 100, 1), 500);
  const res = await db.collection('taobao_buyers')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return { ok: true, list: res.data || [] };
}

// ---- addTaobaoBuyer：增/改一条淘宝买家记录（运营用，须管理员白名单）----
// 入参：{ phone, taobaoOrderId, note }；按手机号去重，已存在则更新订单号与备注，
// 不动 bound / boundOpenid / boundAt（已绑定的记录不因重录而解绑）。
async function addTaobaoBuyer(event, context) {
  const wxContext = cloud.getWXContext();
  if (!isAdmin(wxContext.OPENID)) {
    return { ok: false, code: 'FORBIDDEN', message: '无权限' };
  }
  const phone = normalizePhone(event.phone);
  if (!isMobile(phone)) {
    return { ok: false, code: 'BAD_PHONE', message: '手机号格式不正确（须为 11 位大陆手机号）' };
  }
  const now = new Date();
  const found = await db.collection('taobao_buyers').where({ phone }).limit(1).get();
  if (found.data && found.data[0]) {
    await db.collection('taobao_buyers').doc(found.data[0]._id).update({
      data: {
        taobaoOrderId: event.taobaoOrderId || found.data[0].taobaoOrderId || null,
        note: event.note !== undefined ? event.note : (found.data[0].note || ''),
        updatedAt: now,
      },
    });
    return { ok: true, updated: true, phone };
  }
  const added = await db.collection('taobao_buyers').add({
    data: {
      phone,
      taobaoOrderId: event.taobaoOrderId || null,
      note: event.note || '',
      bound: false,
      boundOpenid: null,
      boundAt: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { ok: true, updated: false, phone, id: added._id };
}

exports.main = async (event, context) => {
  const action = (event && event.action) || '';
  try {
    switch (action) {
      case 'login': return await login(context);
      case 'checkMember': return await checkMember(context);
      case 'getMemberInfo': return await getMemberInfo(event, context);
      case 'bindPhone': return await bindPhone(event, context);
      case 'listTaobaoBuyers': return await listTaobaoBuyers(event, context);
      case 'addTaobaoBuyer': return await addTaobaoBuyer(event, context);
      default:
        return { ok: false, code: 'UNKNOWN_ACTION', message: '未知操作：' + action };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[member] error', action, err);
    return { ok: false, code: 'SERVER_ERROR', message: String((err && err.message) || err) };
  }
};
