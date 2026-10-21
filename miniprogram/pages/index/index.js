// 首页：节目单从服务器动态加载，加新节目不用重新上传小程序
// 底部迷你播放器：背景音频在别的期目页播放时，
// 返回主页也能看到正在播哪一期，并能暂停/继续/停止（David 要求）。
const DATA_BASE = 'https://lcb0378.github.io/michael-english-podcast/data';

const bgm = wx.getBackgroundAudioManager();
const RANGE_SIZE = 20; // 数字段大小：每 20 期一段（1–20、21–40、41–60…）

Page({
data: {
episodes: [], // 当前显示的节目（按所选数字段过滤后的）
allEpisodes: [], // 服务器返回的全量节目单
ranges: [], // 数字段：[{start, end, label}]，每 20 期一段，最新段在最前
activeRange: 0,
listIntoView: '',
loading: true,
nowPlaying: null, // {id, title, cover}：当前装在背景播放器里的那一期
npPlaying: false, // 它是否正在播放
},

onLoad() {
wx.request({
url: `${DATA_BASE}/episodes.json`,
success: (res) => {
// 排序定版（2026-10-21）：一律最新在前 volN 大到小，不依赖服务器数据顺序
const all = (res.data || []).slice().sort((a, b) =>
(parseInt(String(b.id).replace(/\D/g, ''), 10) || 0) - (parseInt(String(a.id).replace(/\D/g, ''), 10) || 0));
this.setData({ allEpisodes: all, loading: false});
this._buildRanges();
this._syncNp();
},
fail: () => {
this.setData({ loading: false});
wx.showToast({ title: '节目单加载失败', icon: 'none'});
},
});
this._bindBgm();
},

onShow() {
// 每次回到主页都重新注册监听：背景播放器是单例，单集页也会注册同一批
// 回调，后注册的会顶掉先注册的——不抢回来，主页就收不到暂停/停止通知，
// 图标不翻、停止后播放条变死条（2026-10-20 David 实测）。
this._bindBgm();
this._syncNp();
},

_bindBgm() {
bgm.onPlay(() => this._syncNp());
bgm.onPause(() => this._syncNp());
bgm.onStop(() => {
getApp().globalData.bgmEpId = null;
getApp().globalData.bgmEpInfo = null;
this._syncNp();
});
bgm.onEnded(() => this._syncNp());
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
const found = (this.data.allEpisodes || []).find(e => e.id === id);
info = found? { id: found.id, title: found.title, cover: found.cover}: { id, title: id.toUpperCase(), cover: ''};
app.globalData.bgmEpInfo = info;
}
this.setData({ nowPlaying: info, npPlaying:!bgm.paused});
},

// 迷你播放器：暂停/继续当前那一期（不切换节目）
// 不等事件回调，直接同步 UI 状态——回调可能被单集页顶掉，等它会让图标冻住。
npToggle(e) {
e.stopPropagation && e.stopPropagation();
if (!getApp().globalData.bgmEpId) return;
if (bgm.paused) {
bgm.play();
this.setData({ npPlaying: true});
} else {
bgm.pause();
this.setData({ npPlaying: false});
}
},

// 迷你播放器：✕ 关闭——停止播放并把播放条从主页移除（David 定版逻辑）
npStop(e) {
e.stopPropagation && e.stopPropagation();
bgm.stop();
const app = getApp();
app.globalData.bgmEpId = null;
app.globalData.bgmEpInfo = null;
this.setData({ nowPlaying: null, npPlaying: false});
},

// 点播放器条：回到正在播的那一期页面
npGo() {
const np = this.data.nowPlaying;
if (np) wx.navigateTo({ url: `/pages/episode/episode?id=${np.id}`});
},

// 按期号生成数字段（最新段排最前），并显示第一段（最新的一段）
_buildRanges() {
const all = this.data.allEpisodes || [];
const nums = all.map(e => parseInt(String(e.id).replace(/\D/g, ''), 10) || 0);
const maxN = nums.length ? Math.max(...nums) : 0;
const ranges = [];
for (let end = Math.ceil(maxN / RANGE_SIZE) * RANGE_SIZE; end >= 1; end -= RANGE_SIZE) {
const start = end - RANGE_SIZE + 1;
ranges.push({ start, end: Math.min(end, maxN), label: `${start}–${Math.min(end, maxN)}` });
}
this.setData({ ranges, activeRange: 0});
this._applyRange(0);
},

// 列表只显示所选数字段内的节目（保持最新在前的顺序），并滚回段首
_applyRange(idx) {
const r = (this.data.ranges || [])[idx];
if (!r) { this.setData({ episodes: this.data.allEpisodes || [] }); return; }
const list = (this.data.allEpisodes || []).filter(e => {
const n = parseInt(String(e.id).replace(/\D/g, ''), 10) || 0;
return n >= r.start && n <= r.end;
});
this.setData({ episodes: list, listIntoView: '' }, () => {
this.setData({ listIntoView: 'ep-top' });
});
},

selectRange(e) {
const idx = Number(e.currentTarget.dataset.idx);
if (idx === this.data.activeRange) return;
this.setData({ activeRange: idx });
this._applyRange(idx);
},

goEpisode(e) {
const id = e.currentTarget.dataset.id;
wx.navigateTo({ url: `/pages/episode/episode?id=${id}`});
}
});
