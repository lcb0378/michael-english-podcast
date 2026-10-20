// Michael的早听晚读 · 小程序入口
App({
  onLaunch() {
    // 预留：登录态、云开发初始化以后在这里加
  },
  globalData: {
    // 音频/图片暂时走 GitHub Pages，正式上线换自己的 CDN 或微信云存储
    cdnBase: 'https://lcb0378.github.io/michael-english-podcast/',
    // 背景音频单例当前装的是哪一期（episode 页换源校验用，见 episode.js）
    bgmEpId: null
  }
});
