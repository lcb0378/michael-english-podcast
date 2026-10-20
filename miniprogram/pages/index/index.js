// 首页：节目单从服务器动态加载，加新节目不用重新上传小程序
// 底部迷你播放器：背景音频在别的期目页播放时，
// 返回主页也能看到正在播哪一期，并能暂停/继续/停止（David 要求）。
const DATA_BASE = 'https://lcb0378.github.io/michael-english-podcast/data';

const bgm = wx.getBackgroundAudioManager();

Page({
data: {
episodes: [],
loading: true,
nowPlaying: null, // {id, title, cover}：当前装在背景播放器里的那一期
npPlaying: false, // 它是否正在播放
},

onLoad() {
wx.request({
url: `${DATA_BASE}/episodes.json`,
success: (res) => {
this.setData({ episodes: res.data || [], loading: false});
this._syncNp();
},
fail: () => {
this.setData({ loading: false});
wx.showToast({ title: '节目单加载失败', icon: 'none'});
},
});
// 首页是根页面，整个生命周期只注册一次监听即可
bgm.onPlay(() => this._syncNp());
bgm.onPause(() => this._syncNp());
bgm.onStop(() => {
getApp().globalData.bgmEpId = null;
getApp().globalData.bgmEpInfo = null;
this._syncNp();
});
bgm.onEnded(() => this._syncNp());
},

onShow() {
this._syncNp();
},

_syncNp() {
const app = getApp();
const id = app.globalData.bgmEpId;
if (!id) {
if (this.data.nowPlaying) this.setData({ nowPlaying: null, npPlaying: false});
return;
}
let info = app.globalData.bgmEpInfo;
if (!info || info.id!== id) {
const found = (this.data.episodes || []).find(e => e.id === id);
info = found? { id: found.id, title: found.title, cover: found.cover}: { id, title: id.toUpperCase(), cover: ''};
app.globalData.bgmEpInfo = info;
}
this.setData({ nowPlaying: info, npPlaying:!bgm.paused});
},

// 迷你播放器：暂停/继续当前那一期（不切换节目）
npToggle(e) {
e.stopPropagation && e.stopPropagation();
if (!getApp().globalData.bgmEpId) return;
if (bgm.paused) bgm.play(); else bgm.pause();
},

// 迷你播放器：停止播放（播放器条随之消失）
npStop(e) {
e.stopPropagation && e.stopPropagation();
bgm.stop();
},

// 点播放器条：回到正在播的那一期页面
npGo() {
const np = this.data.nowPlaying;
if (np) wx.navigateTo({ url: `/pages/episode/episode?id=${np.id}`});
},

goEpisode(e) {
const id = e.currentTarget.dataset.id;
wx.navigateTo({ url: `/pages/episode/episode?id=${id}`});
}
});
