// 首页：节目单从服务器动态加载，加新节目不用重新上传小程序
const DATA_BASE = 'https://lcb0378.github.io/michael-english-podcast/data';

Page({
  data: { episodes: [], loading: true },
  onLoad() {
    wx.request({
      url: `${DATA_BASE}/episodes.json`,
      success: (res) => {
        this.setData({ episodes: res.data || [], loading: false });
      },
      fail: () => {
        this.setData({ loading: false });
        wx.showToast({ title: '节目单加载失败', icon: 'none' });
      },
    });
  },
  goEpisode(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/episode/episode?id=${id}` });
  }
});
