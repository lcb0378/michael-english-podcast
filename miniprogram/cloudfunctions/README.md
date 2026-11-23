# 云开发部署说明（付费会员后端）

> 状态：骨架已完成，**未部署**。部署须等：① 云开发环境创建；② 商户模式确定（直连商户 vs 建行服务商）后补 pay 云函数。

## 部署步骤（按顺序）

1. **开通云开发**：小程序后台 → 云开发 → 开通，创建一个环境（建议按量计费），记下环境 ID。
2. **建集合**：云开发控制台 → 数据库，新建 `orders`、`members`、`taobao_buyers` 三个集合
   （字段见 `DATABASE.md`）；三个集合权限一律设为**仅云函数可读写**。
3. **配管理员白名单**：`member` 云函数环境变量 `ADMIN_OPENIDS` 填运营者 openid（逗号分隔，
   可多个）。不配则名单管理接口拒绝一切调用，只能在控制台手工维护淘宝买家名单。
4. **填环境 ID**：小程序端 `utils/member.js` 的 `CLOUD_ENV` 填入第 1 步的环境 ID；
   同时把 `PAY_ENABLED` 保持 `false`（支付未接好之前购买按钮只提示“支付接入中”）。
5. **开发者工具关联**：`project.config.json` 已加 `"cloudfunctionRoot": "cloudfunctions/"`；
   用微信开发者工具打开 `miniprogram/`，右键 `cloudfunctions/member` → 上传并部署：
   云端安装依赖（`wx-server-sdk`），**不要**用“上传并部署：不上传 node_modules”之外的选项漏掉依赖。
   `cloudfunctions/pay` 同样上传部署（当前是占位实现，部署后只返回 PAY_NOT_CONFIGURED）。
6. **验证**：在开发者工具里用云函数测试面板调 `member` 的 `login` 与 `checkMember`
   （应返回 `ok: true`）；再在真机上打开小程序：未配置/未部署时首页与单集页须与 1.2.0
   行为一致（免费、不锁内容），见 `tests/member-lock.test.js` 的 fail-open 用例。
7. **手机号快速验证组件**：`getPhoneNumber`（淘宝买家一键绑定）须确认小程序后台已开通
   手机号快速验证组件（免费能力），部署时核对；未开通时绑定按钮会调取失败，前端会提示重试。

## 商户模式确定后要补的（pay 云函数）

直连模式已确定（商户号 1005453501），`pay/index.js` 已实现（2026-11-18，本地测试 8/8 通过，未部署）。
部署 pay 云函数前须配好以下 6 个环境变量（值走安全通道，不走聊天、不写进代码）：

| 环境变量 | 内容 |
|---|---|
| `WX_MCHID` | 直连商户号 1005453501 |
| `WX_APPID` | 小程序 AppID wx340b0d192b546b18 |
| `WX_API_V3_KEY` | APIv3 密钥（32 位，商户平台 API 安全里设） |
| `WX_MCH_CERT_SERIAL` | 商户 API 证书序列号 |
| `WX_MCH_PRIVATE_KEY` | 商户 API 证书私钥 PEM（`\\n` 字面转义会被代码自动还原） |
| `WX_NOTIFY_URL` | pay 云函数的回调地址（见下） |

回调地址：pay 云函数须开启 **URL 化**或配 **HTTP 触发器**，把地址填进 `WX_NOTIFY_URL`；未配时 createOrder 返回 `NOTIFY_URL_NOT_CONFIGURED`，不发起下单。

见 `pay/index.js` 文件头注释。关键确认项（David 2026-11-15 问建行客户经理）：
- 建行特约商户是否支持微信小程序支付；若支持：sub-mch_id、接入方式与凭证
  （建行网关 vs 微信服务商模式）、小程序后台绑定确认（David 扫码）；
- 必须是小程序内 JSAPI 支付，不只是收款码/H5。
- 模式确定后：补 createOrder（统一下单）与 payNotify（验签 + 幂等开通会员），
  再把 `utils/member.js` 的 `PAY_ENABLED` 改 `true`，最后走 1.2.1 提审。

## 目录

- `member/` — 会员接口：login / checkMember / bindPhone / listTaobaoBuyers / addTaobaoBuyer
- `pay/` — 支付占位：createOrder / payNotify（均返回 PAY_NOT_CONFIGURED，待商户模式确定后补）
- `DATABASE.md` — 三个集合的字段设计与安全规则
