// 云函数 pay：微信支付接入（直连商户模式，CloudBase 云函数，Node.js）
//
// 商户：直连商户 1005453501（AppID wx340b0d192b546b18，JSAPI 支付，费率 1%，T+1）
// 金额铁律：¥98/年（9800 分），一次付清，不自动续费；金额只从服务端常量取，
// 客户端传来的金额一律不认（防改价）。会员期 365 天，续费在现有到期日上叠加。
//
// 部署注意（⚠️ 部署前必读）：
//   1. pay 云函数须开启「URL 化」或配置 HTTP 触发器，拿到函数 URL 后填到环境变量
//      WX_NOTIFY_URL 里（可带 ?action=payNotify，也可不带——收到 HTTP 请求时默认按
//      payNotify 处理）。微信支付回调只认这个地址，改地址后须在商户平台重新配置。
//   2. 凭证全部配在云函数环境变量里，绝不写进代码、日志或小程序端：
//        WX_MCHID            直连商户号（1005453501）
//        WX_APPID            小程序 AppID（wx340b0d192b546b18）
//        WX_API_V3_KEY       APIv3 密钥（32 位；只用于解密支付结果通知与平台证书）
//        WX_MCH_CERT_SERIAL  商户 API 证书序列号
//        WX_MCH_PRIVATE_KEY  商户 API 证书私钥 PEM；若在控制台粘贴时换行被转义成
//                            字面 \n，代码会自动还原（见 normalizePrivateKey）
//        WX_NOTIFY_URL       支付结果通知地址（即本函数的 URL 化地址）
//      缺任何一项时相关 action 返回 PAY_NOT_CONFIGURED（payNotify 因须回微信，
//      返回 {code:'FAIL'}，见 payNotify 注释）。
//   2b. 回调验签密钥（2026-11-19 实测：新商户默认公钥模式，微信不再签发平台证书，
//      GET /v3/certificates 对商户 1005453501 返回 404 RESOURCE_NOT_EXISTS，
//      故回调验签必须走微信支付公钥）：
//        WX_WECHATPAY_PUBLIC_KEY     微信支付公钥 PEM（商户平台 API安全下载的 pub_key.pem；
//                                    换行同样可用字面 \n 存储，代码自动还原）
//        WX_WECHATPAY_PUBLIC_KEY_ID  公钥 ID（PUB_KEY_ID_ 开头）
//      新商户只配这两项即可；老商户（仍有平台证书）可不配，走原平台证书路径。
//   3. 数据库集合 orders / members 须为「仅云函数可读写」（见 DATABASE.md）；
//      orders 建议建 outTradeNo 唯一索引，members 建议建 openid + expireAt 索引。
//   4. 本函数只用 Node.js 内置 crypto / https，不新增 npm 依赖；
//      package.json 保持只有 wx-server-sdk。
//   5. PAY_ENABLED（小程序端 utils/member.js）保持 false，直到部署后走完 ¥0.01
//      真实测试支付并通过才改 true，再提 1.2.1。
//
// 安全说明：
//   - openid 只取自云函数内置的微信上下文（cloud.getWXContext），客户端传来的不认；
//   - 日志只记 outTradeNo、订单状态、错误码，绝不记密钥、证书、私钥明文；
//   - 幂等：同一 outTradeNo 已是 PAID 时重复通知直接返回成功，不重复开通会员。
const crypto = require('crypto');
const https = require('https');
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

// ---- 常量（服务端定死，客户端传来的值一律不认）----
const MEMBERSHIP_DAYS = 365; // 会员期 12 个月
const AMOUNT_TOTAL = 9800; // 会员年费 ¥98（9800 分），2026-11-19 测完 1 分后恢复
const DESCRIPTION = 'Michael的早听晚读 年度会员'; // 下单商品描述（中性文案）
const WX_API_HOST = 'api.mch.weixin.qq.com';
const MAX_TIMESTAMP_SKEW_SECONDS = 300; // 通知时间戳允许偏差：5 分钟

// ---- 凭证（全部来自环境变量）----
function normalizePrivateKey(raw) {
  if (!raw) return '';
  // 控制台粘贴 PEM 时换行常被存成字面 \n，在此还原为真实换行；
  // 已是真实换行的 PEM 不受影响。
  return raw.replace(/\\n/g, '\n').trim();
}

function getPayConfig() {
  return {
    mchid: process.env.WX_MCHID || '',
    appid: process.env.WX_APPID || '',
    apiV3Key: process.env.WX_API_V3_KEY || '',
    certSerial: process.env.WX_MCH_CERT_SERIAL || '',
    privateKey: normalizePrivateKey(process.env.WX_MCH_PRIVATE_KEY || ''),
    notifyUrl: process.env.WX_NOTIFY_URL || '',
    // 微信支付公钥（新商户回调验签用；老商户可留空走平台证书）
    publicKey: normalizePrivateKey(process.env.WX_WECHATPAY_PUBLIC_KEY || ''),
    publicKeyId: process.env.WX_WECHATPAY_PUBLIC_KEY_ID || '',
  };
}

function missingKeys(cfg, keys) {
  return keys.filter((k) => !cfg[k]);
}

// ---- 商户订单号：ML + 13 位毫秒时间戳 + 随机 4 位（DATABASE.md 约定格式）----
function generateOutTradeNo() {
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return 'ML' + Date.now() + rand;
}

function randomNonceHex(bytes) {
  return crypto.randomBytes(bytes || 16).toString('hex');
}

// ---- WECHATPAY2-SHA256-RSA2048 签名 ----
// 签名串：HTTP方法\nURL路径\n时间戳\n随机串\n请求体\n（每段后都有 \n，GET 请求体为空串）
function signWithPrivateKey(privateKeyPem, message) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message, 'utf8');
  sign.end();
  return sign.sign(privateKeyPem, 'base64');
}

function buildAuthHeader(opts) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonceHex(16);
  const body = opts.body || '';
  const message = [opts.method, opts.path, timestamp, nonce, body, ''].join('\n');
  const signature = signWithPrivateKey(opts.privateKeyPem, message);
  const authorization = 'WECHATPAY2-SHA256-RSA2048 '
    + 'mchid="' + opts.mchid + '",'
    + 'nonce_str="' + nonce + '",'
    + 'signature="' + signature + '",'
    + 'timestamp="' + timestamp + '",'
    + 'serial_no="' + opts.certSerial + '"';
  return { authorization, timestamp, nonce };
}

// ---- 微信支付 API v3 通用调用（只用 Node.js 内置 https）----
function httpsRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { method: opts.method, hostname: opts.hostname, path: opts.path, headers: opts.headers, timeout: 10000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, raw: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function callWechatApi(opts) {
  const body = opts.bodyObj ? JSON.stringify(opts.bodyObj) : '';
  const auth = buildAuthHeader({
    method: opts.method,
    path: opts.path,
    body,
    mchid: opts.cfg.mchid,
    certSerial: opts.cfg.certSerial,
    privateKeyPem: opts.cfg.privateKey,
  });
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: auth.authorization,
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const res = await httpsRequest({
    method: opts.method,
    hostname: WX_API_HOST,
    path: opts.path,
    headers,
    body,
  });
  let data = null;
  try { data = JSON.parse(res.raw); } catch (e) { /* 非 JSON 时保留 raw */ }
  return { statusCode: res.statusCode, data, raw: res.raw };
}

// ---- AES-256-GCM 解密（APIv3 密钥解密平台证书与通知 resource）----
// ciphertext 为 base64：密文 + 16 字节 auth tag；associated_data / nonce 为原文字符串。
function aesGcmDecrypt(apiV3Key, associatedData, nonce, ciphertextBase64) {
  const key = Buffer.from(apiV3Key, 'utf8');
  const data = Buffer.from(ciphertextBase64, 'base64');
  const authTag = data.slice(data.length - 16);
  const cipherText = data.slice(0, data.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'));
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

// ---- 平台证书（内存缓存，按 serial_no 取；过期失效后重新拉取）----
const certCache = new Map(); // serial_no -> { pem, expireTime }

async function getPlatformCertPem(serial, cfg) {
  const cached = certCache.get(serial);
  if (cached && cached.expireTime > Date.now()) return cached.pem;
  const res = await callWechatApi({ method: 'GET', path: '/v3/certificates', bodyObj: null, cfg });
  if (res.statusCode !== 200 || !res.data || !Array.isArray(res.data.data)) {
    throw new Error('拉取平台证书失败 status=' + res.statusCode);
  }
  for (const item of res.data.data) {
    const enc = item.encrypt_certificate;
    if (!enc) continue;
    const pem = aesGcmDecrypt(cfg.apiV3Key, enc.associated_data, enc.nonce, enc.ciphertext);
    certCache.set(item.serial_no, {
      pem,
      expireTime: Date.parse(item.expire_time) || (Date.now() + 3600 * 1000),
    });
  }
  const found = certCache.get(serial);
  if (!found) throw new Error('未找到匹配的平台证书 serial=' + serial);
  return found.pem;
}

// 用平台证书公钥验签：签名串为 时间戳\n随机串\n原始请求体\n
function verifySignatureWithCert(certPem, message, signatureBase64) {
  const verify = crypto.createVerify('RSA-SHA256');
  verify.update(message, 'utf8');
  verify.end();
  return verify.verify(certPem, Buffer.from(signatureBase64, 'base64'));
}

// ---- createOrder：统一下单（JSAPI），返回 wx.requestPayment 参数 ----
async function createOrder(event, context) {
  const cfg = getPayConfig();
  const missing = missingKeys(cfg, ['mchid', 'appid', 'certSerial', 'privateKey', 'notifyUrl']);
  if (missing.length) {
    if (!cfg.notifyUrl) {
      return { ok: false, code: 'NOTIFY_URL_NOT_CONFIGURED', message: '支付未配置：缺少 WX_NOTIFY_URL 环境变量（回调地址）' };
    }
    return { ok: false, code: 'PAY_NOT_CONFIGURED', message: '支付未配置：缺少商户凭证环境变量' };
  }

  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  if (!openid) {
    return { ok: false, code: 'NO_OPENID', message: '未拿到微信 openid' };
  }

  const now = new Date();
  const outTradeNo = generateOutTradeNo();
  await db.collection('orders').add({
    data: {
      outTradeNo,
      openid,
      amount: AMOUNT_TOTAL,
      status: 'UNPAID',
      payMethod: 'wechat_pay',
      transactionId: null,
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    },
  });

  let res;
  try {
    res = await callWechatApi({
      method: 'POST',
      path: '/v3/pay/transactions/jsapi',
      bodyObj: {
        appid: cfg.appid,
        mchid: cfg.mchid,
        description: DESCRIPTION,
        out_trade_no: outTradeNo,
        notify_url: cfg.notifyUrl,
        amount: { total: AMOUNT_TOTAL, currency: 'CNY' },
        payer: { openid },
      },
      cfg,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pay] createOrder api error', outTradeNo, err);
    return { ok: false, code: 'CREATE_ORDER_FAILED', message: '统一下单请求失败，请重试' };
  }
  if (res.statusCode !== 200 || !res.data || !res.data.prepay_id) {
    // 微信返回的错误体只含错误码与提示，不含凭证；截断后记日志便于排障
    // eslint-disable-next-line no-console
    console.error('[pay] createOrder failed', outTradeNo, res.statusCode, (res.raw || '').slice(0, 500));
    return { ok: false, code: 'CREATE_ORDER_FAILED', message: '统一下单失败，请重试' };
  }

  const prepayId = res.data.prepay_id;
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = randomNonceHex(16);
  const pkg = 'prepay_id=' + prepayId;
  // 调起支付的签名串：appId\ntimeStamp\nnonceStr\npackage\n
  const paySign = signWithPrivateKey(cfg.privateKey, [cfg.appid, timeStamp, nonceStr, pkg, ''].join('\n'));
  return {
    ok: true,
    outTradeNo,
    payParams: { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign },
  };
}

// ---- payNotify：支付结果通知（云函数 URL 化 / HTTP 触发入口）----
// 微信要求：处理成功回 {code:'SUCCESS', message:'成功'}；失败回 {code:'FAIL', ...}
// （微信收到 FAIL 会重试通知）。本函数收到的 event 为 HTTP 事件：event.body 是
// 原始请求体字符串（可能是 base64），event.headers 是请求头。
function notifyFail(message) {
  return { code: 'FAIL', message };
}
function notifySuccess() {
  return { code: 'SUCCESS', message: '成功' };
}

async function payNotify(event, context) {
  const cfg = getPayConfig();
  const missing = missingKeys(cfg, ['mchid', 'appid', 'apiV3Key', 'certSerial', 'privateKey']);
  if (missing.length) {
    // 注意：payNotify 须回微信固定格式，故此处返回 FAIL（微信会重试），
    // 而不是 createOrder 那种 {ok:false, code:'PAY_NOT_CONFIGURED'}。
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify missing config');
    return notifyFail('支付未配置：缺少商户凭证环境变量');
  }

  // 1. 取原始 body（验签必须用原始字符串）与请求头（键名统一转小写）
  let rawBody = '';
  if (typeof event.body === 'string') {
    rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  } else if (event.body) {
    rawBody = JSON.stringify(event.body);
  }
  const headers = event.headers || {};
  const h = {};
  Object.keys(headers).forEach((k) => { h[String(k).toLowerCase()] = headers[k]; });
  const signature = h['wechatpay-signature'] || '';
  const timestamp = h['wechatpay-timestamp'] || '';
  const nonce = h['wechatpay-nonce'] || '';
  const serial = h['wechatpay-serial'] || '';

  // 2. 校验时间戳在 5 分钟内（防重放）
  const ts = parseInt(timestamp, 10);
  if (!signature || !timestamp || !nonce || !serial || Number.isNaN(ts)
      || Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_TIMESTAMP_SKEW_SECONDS) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify bad headers/timestamp serial=', serial);
    return notifyFail('请求头或时间戳校验失败');
  }

  // 3. 按 Wechatpay-Serial 查验签公钥（key map：公钥 ID → 微信支付公钥；
  //    其他序列号走平台证书下载。新商户默认公钥模式、平台证书接口返回 404，
  //    故公钥是主路径，平台证书只作备用；灰度期两种签名可能并存，必须按 serial
  //    查表、不能按前缀二分、不能 fallback 到默认证书。）
  let verifyPem = '';
  if (cfg.publicKeyId && serial === cfg.publicKeyId && cfg.publicKey) {
    verifyPem = cfg.publicKey;
  } else {
    try {
      verifyPem = await getPlatformCertPem(serial, cfg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[pay] payNotify get cert failed serial=', serial, err);
      return notifyFail('平台证书获取失败');
    }
  }
  let verified = false;
  try {
    verified = verifySignatureWithCert(
      verifyPem,
      [timestamp, nonce, rawBody, ''].join('\n'),
      signature,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify verify error serial=', serial, err);
  }
  if (!verified) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify signature verify failed serial=', serial);
    return notifyFail('签名校验失败');
  }

  // 4. 解密 resource 得到通知明文
  let notify;
  try {
    const bodyJson = JSON.parse(rawBody);
    const resource = bodyJson.resource || {};
    const plain = aesGcmDecrypt(cfg.apiV3Key, resource.associated_data, resource.nonce, resource.ciphertext);
    notify = JSON.parse(plain);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify decrypt failed serial=', serial, err);
    return notifyFail('通知解密失败');
  }

  const outTradeNo = notify.out_trade_no || '';
  const transactionId = notify.transaction_id || '';

  // 5. 校验商户号 / AppID 与金额（与服务端记录一致才认）
  if (notify.mchid && notify.mchid !== cfg.mchid) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify mchid mismatch', outTradeNo);
    return notifyFail('商户号不一致');
  }
  if (notify.appid && notify.appid !== cfg.appid) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify appid mismatch', outTradeNo);
    return notifyFail('AppID 不一致');
  }

  // 仅 SUCCESS 才处理；其他状态（CLOSED / REVOKED / PAYERROR 等）只确认收到，
  // 回 SUCCESS 让微信停止重试。
  if (notify.trade_state !== 'SUCCESS') {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify non-success state', outTradeNo, notify.trade_state);
    return notifySuccess();
  }

  // 6. 按 outTradeNo 查订单（幂等锚点）
  const orderRes = await db.collection('orders').where({ outTradeNo }).limit(1).get();
  const order = (orderRes.data && orderRes.data[0]) || null;
  if (!order) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify order not found', outTradeNo);
    return notifyFail('订单不存在');
  }
  const total = notify.amount && notify.amount.total;
  if (total !== undefined && total !== order.amount) {
    // eslint-disable-next-line no-console
    console.error('[pay] payNotify amount mismatch', outTradeNo, total, order.amount);
    return notifyFail('订单金额不一致');
  }
  // 已是 PAID：重复通知，直接成功，不重复开通
  if (order.status === 'PAID') {
    return notifySuccess();
  }

  const now = new Date();
  const paidAt = notify.success_time ? new Date(notify.success_time) : now;
  await db.collection('orders').doc(order._id).update({
    data: { status: 'PAID', transactionId: transactionId || null, paidAt, updatedAt: now },
  });

  // 7. 开通会员：已有未到期会员则在现有到期日上延 365 天（续费叠加），
  //    否则从现在起 365 天。source='wechat_pay'，不存手机号。
  //    （同一订单只开通一次：第 6 步已把订单置 PAID，重复通知在第 6 步即返回。）
  const memRes = await db.collection('members')
    .where({ openid: order.openid, expireAt: _.gt(now) })
    .orderBy('expireAt', 'desc')
    .limit(1)
    .get();
  const existing = (memRes.data && memRes.data[0]) || null;
  const oneYearMs = MEMBERSHIP_DAYS * 24 * 60 * 60 * 1000;
  if (existing) {
    const newExpireAt = new Date(existing.expireAt.getTime() + oneYearMs);
    await db.collection('members').doc(existing._id).update({ data: { expireAt: newExpireAt } });
  } else {
    await db.collection('members').add({
      data: {
        openid: order.openid,
        expireAt: new Date(now.getTime() + oneYearMs),
        source: 'wechat_pay',
        createdAt: now,
      },
    });
  }
  return notifySuccess();
}

exports.main = async (event, context) => {
  // action 来源：云函数调用的 event.action，或 HTTP 触发的 ?action=payNotify；
  // 直接收到 HTTP 请求（带 httpMethod）时默认按 payNotify 处理。
  const action = (event && event.action)
    || (event && event.queryStringParameters && event.queryStringParameters.action)
    || '';
  try {
    switch (action) {
      case 'createOrder':
        return await createOrder(event, context);
      case 'payNotify':
        return await payNotify(event, context);
      default:
        if (event && event.httpMethod) return await payNotify(event, context);
        return { ok: false, code: 'UNKNOWN_ACTION', message: '未知操作：' + action };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[pay] error', action, err);
    // payNotify 走 HTTP 回调：未知异常也返回 FAIL，让微信重试
    if (action === 'payNotify' || (event && event.httpMethod)) {
      return { code: 'FAIL', message: '系统异常' };
    }
    return { ok: false, code: 'SERVER_ERROR', message: String((err && err.message) || err) };
  }
};

// 仅供本地测试导入的内部函数（云函数入口只用 exports.main；不含任何凭证）
module.exports._internal = {
  generateOutTradeNo,
  normalizePrivateKey,
  signWithPrivateKey,
  verifySignatureWithCert,
  buildAuthHeader,
  aesGcmDecrypt,
};
