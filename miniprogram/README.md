# Michael的早听晚读 · 微信小程序

## 这是什么
《Michael的早听晚读》的微信小程序版。现在是**可预览原型**：首页节目单 + Vol.01 跟读页（播放/单词高亮/点段跳转/语速/PDF下载），效果对标网页跟读版。

## 怎么预览
1. 安装 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
2. 导入本目录（`miniprogram/`），AppID 先用测试号（project.config.json 里已配 `touristappid`）
3. 预览时如提示域名不合法：开发工具 → 右上角「详情」→ 勾选「不校验合法域名」
   （因为音频/图片暂时走 GitHub Pages；正式上线前换成自己的 CDN 或微信云存储，并在小程序后台加白名单）

## 等你营业执照下来
1. 注册小程序，拿到正式 AppID，替换 `project.config.json` 里的 `appid`
2. 把音频/图片/PDF 搬到自己的 CDN 或云存储，改 `utils/episodes.js` 里的链接
3. 在开发者工具里点「上传」→ 小程序后台提交审核 → 发布

## 以后要加的（付费/账号体系）
- 微信登录 + 订阅制（按月/按学期）：现在原型没做，等产品定价定了再加
- 后台：节目单做成从服务器拉取，不用每期改代码发版

## 目录
- `pages/index/` — 首页节目单
- `pages/episode/` — 跟读页（核心）
- `utils/episodes.js` — 节目数据（每期往 EPISODES 里加一期）
