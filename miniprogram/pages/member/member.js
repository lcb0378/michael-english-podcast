// 购买页：开通会员 + 淘宝买家一键绑定
//
// 支付未接好之前（utils/member.js 的 PAY_ENABLED 为 false），购买按钮只提示“支付接入中”，
// 不发起任何真实下单；商户模式确定、pay 云函数接好后再把开关打开。
const member = require('../../utils/member.js');

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 金额（分）→ ¥x.xx；淘宝绑定开通的没有订单金额，前端按 source 显示
function fmtAmount(fen) {
  if (fen === undefined || fen === null || Number.isNaN(Number(fen))) return '';
  return '¥' + (Number(fen) / 100).toFixed(2);
}

// 手机号脱敏：138****1234
function maskPhone(phone) {
  const p = String(phone || '');
  if (p.length !== 11) return p;
  return p.slice(0, 3) + '****' + p.slice(7);
}

Page({
  data: {
    from: '',
    payEnabled: member.PAY_ENABLED,
    priceText: member.PRICE_TEXT,
    membershipText: member.MEMBERSHIP_TEXT,
    memberState: null,
    expireText: '',
    memberInfo: null, // 会员中心取数：{ isMember, expireAt, memberSince, source, phone, lastOrder }
    buyDateText: '',
    amountText: '',
    phoneText: '',
    buying: false,
    binding: false,
    bindResult: '',
  },

  onLoad(opts) {
    this.setData({ from: opts.from || '' });
    this._refreshState(false);
    this._refreshMemberInfo();
  },

  onShow() {
    // 从别处回来（如绑定后）也刷新一次，避免显示旧状态
    this._refreshMemberInfo();
  },

  _refreshState(force) {
    return member.checkMember(force).then((st) => {
      this.setData({ memberState: st, expireText: st && st.expireAt ? fmtDate(st.expireAt) : '' });
      return st;
    });
  },

  // 会员中心取数：购买日期、支付金额、绑定手机号
  _refreshMemberInfo() {
    return member.getMemberInfo().then((info) => {
      if (!info || !info.ok) return info;
      const lastOrder = info.lastOrder || null;
      const buyDate = (lastOrder && lastOrder.paidAt) || info.memberSince || '';
      const amount = lastOrder
        ? fmtAmount(lastOrder.amount)
        : (info.source === 'taobao' ? '淘宝年包' : '');
      this.setData({
        memberInfo: info,
        buyDateText: fmtDate(buyDate),
        amountText: amount,
        phoneText: info.phone ? maskPhone(info.phone) : '未绑定',
      });
      return info;
    });
  },

  refreshTap() {
    this._refreshState(true);
    this._refreshMemberInfo();
  },

  // 购买/续费：支付未接好时只提示；接好后调统一下单并调起微信支付
  // isRenew=true 时是续费，成功提示“续费成功”；否则是首次开通，提示“开通成功”
  // 后端 payNotify 已处理续费顺延：未到期从当前到期日起 +365 天，已到期从现在起 +365 天
  _startPay(isRenew) {
    if (this.data.buying) return;
    if (!this.data.payEnabled) {
      wx.showToast({ title: '支付接入中，稍后回来就能直接购买', icon: 'none', duration: 2600 });
      return;
    }
    this.setData({ buying: true });
    member.createOrder().then((res) => {
      this.setData({ buying: false });
      if (res && res.code === 'PAY_NOT_CONFIGURED') {
        wx.showToast({ title: '支付接入中，稍后回来就能直接购买', icon: 'none', duration: 2600 });
        return;
      }
      if (!res || !res.ok || !res.payParams) {
        wx.showToast({ title: '下单失败，请稍后再试', icon: 'none' });
        return;
      }
      const p = res.payParams;
      wx.requestPayment({
        timeStamp: p.timeStamp,
        nonceStr: p.nonceStr,
        package: p.package,
        signType: p.signType || 'RSA',
        paySign: p.paySign,
        success: () => {
          this._refreshState(true).then(() => {
            wx.showToast({ title: isRenew ? '续费成功' : '开通成功', icon: 'success' });
          });
          this._refreshMemberInfo();
        },
        fail: () => {
          wx.showToast({ title: '支付未完成', icon: 'none' });
        },
      });
    });
  },

  // 首次开通
  buyTap() {
    this._startPay(false);
  },

  // 已是会员：续费（同一下单+支付流程，后端按未到期顺延处理）
  renewTap() {
    this._startPay(true);
  },

  // 淘宝买家一键绑定：getPhoneNumber 拿到的动态令牌 code 交给服务端换手机号、与名单核对
  onGetPhoneNumber(e) {
    if (this.data.binding) return;
    const code = (e.detail && e.detail.code) || '';
    if (!code) {
      wx.showToast({ title: '需要授权手机号才能绑定', icon: 'none' });
      return;
    }
    this.setData({ binding: true, bindResult: '' });
    member.bindTaobaoBuyer(code).then((res) => {
      this.setData({ binding: false });
      if (res && res.ok) {
        this._refreshState(true);
        this._refreshMemberInfo();
        this.setData({ bindResult: res.alreadyMember ? '你已经是会员了，无需重复绑定。' : '绑定成功，会员已开通。' });
        return;
      }
      const code = (res && res.code) || '';
      if (code === 'NOT_TAOBAO_BUYER') {
        this.setData({ bindResult: '没查到这个手机号的淘宝购买记录：请确认微信绑定的手机号与淘宝下单时留的手机号是同一个。' });
      } else if (code === 'ALREADY_BOUND') {
        this.setData({ bindResult: '这个手机号已绑定过另一个微信号，不能重复绑定。' });
      } else if (code === 'NOT_CONFIGURED') {
        this.setData({ bindResult: '绑定服务正在接入中，请稍后再试。' });
      } else if (code === 'NO_CODE') {
        this.setData({ bindResult: '未拿到手机号授权，请重新点选授权。' });
      } else if (code === 'TIMEOUT') {
        this.setData({ bindResult: '绑定超时了（网络或服务器慢），请点刷新看手机号是不是已经绑上了——超时也可能已经成功了。' });
      } else if (code === 'PHONE_RESOLVE_FAILED') {
        this.setData({ bindResult: '手机号解析失败，请重新点绑定再试一次。' });
      } else if (code === 'SERVER_ERROR') {
        this.setData({ bindResult: '服务器出错，请稍后再试。' });
      } else if (code === 'CALL_FAILED') {
        this.setData({ bindResult: '调用失败，请检查网络后重试。' });
      } else if (code === 'BAD_PHONE') {
        this.setData({ bindResult: '手机号格式不正确。' });
      } else {
        this.setData({ bindResult: '绑定失败，请稍后再试。' });
      }
    });
  },

  // 回到首页开始学习（首页是 tabBar 页，用 switchTab）
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 回到刚才那期（从单集页锁定跳转过来时）；否则返回上一页
  goEpisode() {
    const from = this.data.from;
    if (from) {
      wx.redirectTo({ url: '/pages/episode/episode?id=' + from });
    } else {
      wx.navigateBack();
    }
  },
});
