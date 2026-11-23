# 会员数据库设计说明（云开发数据库）

> 架构文档：`~/workspace/goals/michael-s-daily-english-podcast/files/小程序付费会员_架构与申请准备_2026-11-09.md`
> 云函数：同目录 `member/`（会员接口）、`pay/`（支付占位，商户模式未定）。
> 内容仍走腾讯云 COS 静态托管；云开发只管订单与会员。**第一阶段只做小程序内门禁**——
> 直接拼 COS 链接仍能打开，防不住分享；真上锁（COS 私有读 + 签名 URL + 会员校验）是第二阶段工程。

## 集合总览

| 集合 | 用途 | 写入口 |
|---|---|---|
| `orders` | 每一笔购买订单（小程序支付） | pay 云函数（待商户模式确定后补） |
| `members` | 会员记录（openid → 到期日） | member.bindPhone（淘宝绑定）、pay.payNotify（支付回调，待补） |
| `taobao_buyers` | 淘宝买家名单（手机号 → 淘宝订单） | member.addTaobaoBuyer（运营）、控制台手工录入 |

## 1. orders（订单）

| 字段 | 类型 | 说明 |
|---|---|---|
| `outTradeNo` | string | 商户订单号（服务端生成，唯一；格式建议 `ML` + 时间戳 + 随机 4 位） |
| `openid` | string | 下单人 openid（取自云函数微信上下文，客户端传来的不认） |
| `amount` | number | 金额（分），固定 9800（¥98/年）；服务端常量，客户端传来的金额不认 |
| `status` | string | `UNPAID` 未付 / `PAID` 已付 / `REFUNDED` 已退款 |
| `payMethod` | string | `wechat_pay`（直连商户 / 建行服务商，模式确定后填） |
| `transactionId` | string | 微信支付订单号（回调后回填，未付时 null） |
| `paidAt` | date | 支付成功时间（回调后回填） |
| `createdAt` | date | 下单时间 |
| `updatedAt` | date | 最后更新时间 |

索引建议：`outTradeNo`（唯一）、`openid + createdAt`（查某人订单）。

## 2. members（会员）

| 字段 | 类型 | 说明 |
|---|---|---|
| `openid` | string | 会员的微信 openid（主键含义；云开发自动另有 `_openid`，本字段显式存一份便于查询） |
| `expireAt` | date | 会员到期日；判断标准：`expireAt > 现在` 即为会员 |
| `source` | string | 来源：`wechat_pay` 小程序支付 / `taobao` 淘宝绑定 |
| `phone` | string | 手机号（淘宝绑定时存；微信支付开通的会员若之后绑定淘宝手机号，也会补存到这条记录上） |
| `taobaoOrderId` | string | 淘宝订单号（仅 source=taobao 时有） |
| `createdAt` | date | 开通时间 |

索引建议：`openid + expireAt`（checkMember 查询用）。

规则：
- 会员期 12 个月（365 天），自开通日起算；到期后 Vol.04+ 重新锁定，续费即重新开通。
- 同一 openid 已是会员时不再重复开新期（bindPhone 幂等返回现有到期日；支付回调须同样幂等：同一订单只开通一次）。
- 手机号只存于淘宝绑定场景；小程序支付开通的会员不收集手机号（之后绑定淘宝手机号时会补存）。
- 会员中心取数：member.getMemberInfo（只返回调用者本人的记录：到期日、开通日期、手机号、最近一笔 PAID 订单的金额与付款时间）。

## 3. taobao_buyers（淘宝买家名单）

| 字段 | 类型 | 说明 |
|---|---|---|
| `phone` | string | 手机号（11 位大陆手机号，归一化去 +86/空格；唯一键含义） |
| `taobaoOrderId` | string | 淘宝订单号（年包 ¥98；试听包 ¥1 的三期本来就免费，不用录） |
| `note` | string | 备注（如买家旺旺名） |
| `bound` | boolean | 是否已绑定微信号 |
| `boundOpenid` | string | 已绑定的微信 openid（未绑定为 null） |
| `boundAt` | date | 绑定时间（未绑定为 null） |
| `createdAt` | date | 录入时间 |
| `updatedAt` | date | 最后更新时间 |

索引建议：`phone`（唯一，bindPhone 查询用）。

规则：
- 一个手机号只绑定一个微信号；已绑定的记录重录订单号时不解绑。
- 名单由运营者维护：小程序端 addTaobaoBuyer（须管理员白名单）或云开发控制台手工录入。
- 隐私：名单只含“手机号 + 淘宝订单号”，不存买家姓名、地址等其他信息。

## 安全规则（云开发控制台设置）

- 三个集合的**数据库权限一律设为“仅云函数可读写”**（不开放小程序端直连数据库）；
  小程序端只能调云函数，拿不到整表数据。
- `member` 云函数的名单管理接口另有管理员 openid 白名单（环境变量 `ADMIN_OPENIDS`），
  未配置白名单时接口拒绝一切调用。
- openid 与手机号只取自微信侧的可信来源（云函数上下文 / getPhoneNumber 的 code 动态令牌，云调用换取），
  客户端传来的 openid、明文手机号一律不认。
