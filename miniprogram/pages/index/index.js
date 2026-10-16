const { EPISODES } = require('../../utils/episodes.js');

Page({
  data: { episodes: EPISODES },
  onLoad() {},
  goEpisode(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/episode/episode?id=${id}` });
  }
});
