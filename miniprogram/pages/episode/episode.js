// 跟读页：节目数据从服务器动态加载；播放 + 单词高亮 + 点段跳转 + 语速 + PDF下载
//
// 背景音频是全局单例：bgm.src 一旦赋值就一直属于那一期，
// 旧代码只在 `!bgm.src` 时才赋值，导致切到任何一期都继续播第一次打开的那期。
// 修订原则：用 app.globalData.bgmEpId 记录“当前 src 属于哪一期”，
// 凡归属不是本期，播放/点段/拖动都先换源；页面卸载时解绑自己注册的监听。
const DATA_BASE = 'https://lcb0378.github.io/michael-english-podcast/data';
const CURSOR_LEAD = 0.9; // 高亮提前量（秒），与网页版一致

const bgm = wx.getBackgroundAudioManager();

function fmt(t) {
t = Math.max(0, Math.floor(t || 0));
return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

Page({
data: {
ep: null,
loading: true,
playing: false,
progress: 0,
curTime: '0:00',
durTime: '0:00',
curBlock: -1,
curWord: -1,
rate: 1,
rates: [0.9, 1, 1.1, 1.5],
seeking: false,
// 互动答题（2026-10-21）：Part 3 点选 + Part 4 句型练习点选，核对判分
quizVm: null, keysH: [], keyC: [], keyCL: [],
selH: [], markH: [], selC: [], markC: [], selP: [], markP: [],
score3: '', score4: '',
// 讲义富文本标签默认样式（排版标准 v1：正文 28/1.8，段距 16）
tagStyle: {
p: 'margin: 0 0 16rpx; line-height: 1.8;',
div: 'line-height: 1.8;',
ul: 'margin: 8rpx 0 16rpx; padding-left: 40rpx;',
li: 'line-height: 1.8; margin-bottom: 8rpx;',
},
},

_epId: null,
_pendingSeek: null, // 换源后等 onCanplay 再 seek 的绝对秒数
_pendingSeekRatio: null, // 换源后等 onCanplay 再 seek 的比例（进度条拖动）

_isMine() {
return!!this._epId && getApp().globalData.bgmEpId === this._epId;
},

// 把指定位置的本期音频装进背景播放器（赋值 src 会自动开始播放）
_loadSrc(seekTo) {
const ep = this.data.ep;
if (!ep) return;
bgm.title = `Michael的早听晚读 ${ep.id.toUpperCase()}`;
bgm.epname = ep.title;
bgm.singer = 'Michael的早听晚读';
bgm.coverImgUrl = ep.cover;
bgm.src = ep.audio; // 换源点：赋值后自动播放新的一期
getApp().globalData.bgmEpId = this._epId;
getApp().globalData.bgmEpInfo = { id: ep.id, title: ep.title, cover: ep.cover };
bgm.playbackRate = this.data.rate;
this._pendingSeek = (typeof seekTo === 'number')? seekTo: null;
this.setData({ progress: 0, curTime: '0:00', durTime: '0:00', curBlock: -1, curWord: -1});
},

onLoad(opts) {
const id = opts.id || 'vol01';
this._epId = id;

// 【播放逻辑定版】播放器里装着别期时（无论在播还是暂停）：进页立即停掉旧期并清出播放器，
// 本期不自动开播——和冷启动一样，等用户点播放才播（先浏览再听）；
// 装的就是本期则完全不动（续播/暂停状态、进度原样保留）。
const curEp = getApp().globalData.bgmEpId;
if (curEp && curEp!== id) {
bgm.stop();
getApp().globalData.bgmEpId = null;
getApp().globalData.bgmEpInfo = null;
}

// 注册监听（保存引用，onUnload 时解绑，避免多页面实例互相干扰）
this._h = {
onPlay: () => this.setData({ playing: true}),
onPause: () => this.setData({ playing: false}),
onStop: () => {
getApp().globalData.bgmEpId = null;
getApp().globalData.bgmEpInfo = null;
this.setData({ playing: false, curBlock: -1, curWord: -1});
},
onError: () => {
wx.showToast({ title: '音频加载失败，请检查网络后重试', icon: 'none'});
this.setData({ playing: false});
},
onEnded: () => this.setData({ playing: false}),
onTimeUpdate: () => this.updateHighlight(),
onCanplay: () => {
this.setData({ durTime: fmt(bgm.duration)});
if (this._pendingSeek!= null) {
bgm.seek(this._pendingSeek);
this._pendingSeek = null;
} else if (this._pendingSeekRatio!= null && bgm.duration) {
bgm.seek(this._pendingSeekRatio * bgm.duration);
this._pendingSeekRatio = null;
}
},
};
bgm.onPlay(this._h.onPlay);
bgm.onPause(this._h.onPause);
bgm.onStop(this._h.onStop);
bgm.onEnded(this._h.onEnded);
bgm.onTimeUpdate(this._h.onTimeUpdate);
bgm.onCanplay(this._h.onCanplay);
bgm.onError(this._h.onError);

wx.request({
url: `${DATA_BASE}/${id}.json`,
success: (res) => {
const ep = res.data;
// Section 编号（2026-10-21 定版）：按小节名变化给每节第一块打 sec 号，
// Part 1 显示「Section N」分节标题，与 Part 3 标题配对的 Section 1–6 对应。
let _secNo = 0, _lastTitle = null;
(ep.blocks || []).forEach((b) => {
if (b.title !== _lastTitle) { _secNo++; _lastTitle = b.title; b.sec = _secNo; } else { b.sec = 0; }
});
this.setData(Object.assign({ ep, loading: false }, this._buildQuiz(ep)));
wx.setNavigationBarTitle({ title: `${ep.id.toUpperCase()} · ${ep.title}`});
// 若背景里装的就是本期，同步一次按钮与时长显示（状态原样不动）
// 是别期的话 onLoad 里已停掉清掉，本页静静等用户点播放，不自动开播
if (this._isMine()) {
this.setData({ playing:!bgm.paused, durTime: fmt(bgm.duration)});
}
},
fail: () => {
this.setData({ loading: false});
wx.showToast({ title: '节目加载失败', icon: 'none'});
},
});
},

onUnload() {
if (!this._h) return;
const off = (fn, cb) => { if (typeof bgm[fn] === 'function') bgm[fn](cb);};
off('offPlay', this._h.onPlay);
off('offPause', this._h.onPause);
off('offStop', this._h.onStop);
off('offEnded', this._h.onEnded);
off('offTimeUpdate', this._h.onTimeUpdate);
off('offCanplay', this._h.onCanplay);
off('offError', this._h.onError);
// 注意：不在这里 stop —— 背景音频本就该在离开页面后继续播；
// 换期靠 _isMine 校验，不靠停播。
},

// 视频与背景音频互斥（与网页版同规矩，2026-10-21）：播视频先停音频，播音频先停视频
_video() {
if (!this._videoCtx) this._videoCtx = wx.createVideoContext('epVideo', this);
return this._videoCtx;
},

onVideoPlay() {
if (bgm.src && !bgm.paused) bgm.pause();
this.setData({ playing: false });
},

onHide() {
if (this.data.ep && this.data.ep.video && this._videoCtx) this._videoCtx.pause();
},

togglePlay() {
if (!this.data.ep) return;
if (this.data.ep.video) this._video().pause();
if (this.data.playing && this._isMine()) {
bgm.pause();
} else if (!this._isMine() ||!bgm.src) {
this._loadSrc(); // 不是本期（或还没装过）：换成本期并播放
} else {
bgm.play();
}
},

// ---- 互动答题（2026-10-21 定版）：点选 → 核对答案 → 对勾/叉号 + 正确答案，可改可重做 ----
_buildQuiz(ep) {
const g = ep.guide || {};
const keys = g.keys || {};
const st = { quizVm: null, keysH: [], keyC: [], keyCL: [], selH: [], markH: [], selC: [], markC: [], selP: [], markP: [], score3: '', score4: '', cwVm: null, cwSel: -1, cwFilled: [], cwMark: [], cwScore: '', cwGrid: [], cwUsed: [] };
if (keys.headings && keys.headings.length && g.quiz && g.quiz.length >= 2) {
const headingsOpts = [];
(g.quiz[0].extra || '').split('\n').slice(1).forEach((ln) => {
const m = ln.match(/^([A-F])[.、]\s*(.*)$/);
if (m) headingsOpts.push({ letter: m[1], text: m[2], i: headingsOpts.length });
});
const choiceQs = (g.quiz[1].questions || []).map((q) => {
const lines = q.split('\n');
const options = [];
lines.slice(1).forEach((ln) => {
const m = ln.match(/^([A-D])[.、]\s*(.*)$/);
if (m) options.push(m[1] + '. ' + m[2]);
});
return { stem: lines[0], options };
});
const hasCw = !!(g.crossword && g.crossword.words && g.crossword.words.length);
const choiceOk = keys.choice && choiceQs.length === keys.choice.length;
const headingsOk = !hasCw && keys.headings && headingsOpts.length === keys.headings.length;
if (choiceOk && (headingsOk || hasCw)) {
st.quizVm = { headingsOpts, choiceQs };
st.keyC = keys.choice.map((L) => L.charCodeAt(0) - 65);
st.keyCL = keys.choice;
st.selC = keys.choice.map(() => -1);
st.markC = keys.choice.map(() => null);
if (headingsOk) {
st.keysH = keys.headings;
st.selH = keys.headings.map(() => -1);
st.markH = keys.headings.map(() => null);
}
}
if (hasCw) {
const ws = g.crossword.words;
st.cwVm = {
across: ws.map((w, i) => ({ w, i })).filter((x) => x.w.dir === 'A').sort((a, b) => a.w.num - b.w.num),
down: ws.map((w, i) => ({ w, i })).filter((x) => x.w.dir === 'D').sort((a, b) => a.w.num - b.w.num),
bank: ws.map((w, i) => i).sort(() => Math.random() - 0.5),
};
st.cwSel = -1;
st.cwFilled = ws.map(() => '');
st.cwUsed = ws.map(() => false);
st.cwMark = ws.map(() => null);
st.cwScore = '';
st.cwGrid = this._cwGrid(g.crossword, st.cwFilled, -1, st.cwMark);
}
}
if (g.practice && g.practice.groups) {
st.selP = g.practice.groups.map((gr) => gr.items.map(() => -1));
st.markP = g.practice.groups.map((gr) => gr.items.map(() => null));
}
return st;
},

_set(path, val) { const d = {}; d[path] = val; this.setData(d); },

pickH(e) {
const i = +e.currentTarget.dataset.i, o = +e.currentTarget.dataset.o;
this._set(`selH[${i}]`, o);
if (this.data.markH[i] !== null) this._set(`markH[${i}]`, null);
},

pickC(e) {
const q = +e.currentTarget.dataset.q, o = +e.currentTarget.dataset.o;
this._set(`selC[${q}]`, o);
if (this.data.markC[q] !== null) this._set(`markC[${q}]`, null);
},

check3() {
const { selH, keysH, selC, keyC, quizVm } = this.data;
let right = 0;
const total = keysH.length + keyC.length;
const markH = selH.map((s, i) => { const ok = s >= 0 && quizVm.headingsOpts[s].letter === keysH[i]; if (ok) right++; return ok; });
const markC = selC.map((s, i) => { const ok = s === keyC[i]; if (ok) right++; return ok; });
this.setData({ markH, markC, score3: right === total ? `🎉 ${right} / ${total}，全部答对，就是今日 MVP！` : `答对 ${right} / ${total} 题，改一改错题，再核对一次。` });
},

reset3() {
this.setData({ selH: this.data.keysH.map(() => -1), markH: this.data.keysH.map(() => null), selC: this.data.keyC.map(() => -1), markC: this.data.keyC.map(() => null), score3: '' });
},

// ---- 填字游戏（2026-10-21 新增，替代 Part 3 标题配对）：点提示/格子选词条 → 点词库填入 → 核对判分 ----
_cwCells(cw, i) {
const w = cw.words[i];
const dr = w.dir === 'D' ? 1 : 0, dc = w.dir === 'A' ? 1 : 0;
const out = [];
for (let k = 0; k < w.word.length; k++) out.push([w.row + dr * k, w.col + dc * k]);
return out;
},

_cwGrid(cw, filled, sel, mark) {
const rows = [];
const letterAt = {}, stateAt = {}, selAt = {};
cw.words.forEach((w, i) => {
if (!filled[i]) return;
this._cwCells(cw, i).forEach(([r, c], k) => {
letterAt[r + ',' + c] = filled[i][k];
if (mark[i] !== null) stateAt[r + ',' + c] = mark[i] ? 'ok' : 'bad';
});
});
if (sel >= 0) this._cwCells(cw, sel).forEach(([r, c]) => { selAt[r + ',' + c] = 1; });
const startNum = {};
cw.words.forEach((w) => { startNum[w.row + ',' + w.col] = w.num; });
const filledCells = {};
cw.words.forEach((w, i) => this._cwCells(cw, i).forEach(([r, c]) => { filledCells[r + ',' + c] = 1; }));
for (let r = 0; r < cw.nrows; r++) {
const row = [];
for (let c = 0; c < cw.ncols; c++) {
const k = r + ',' + c;
row.push(filledCells[k] ? { blank: false, num: startNum[k] || '', letter: letterAt[k] || '', sel: !!selAt[k], st: stateAt[k] || '' } : { blank: true });
}
rows.push(row);
}
return rows;
},

_cwRefresh(extra) {
const cw = this.data.ep.guide.crossword;
const cwUsed = cw.words.map((w) => this.data.cwFilled.includes(w.word));
const d = Object.assign({ cwGrid: this._cwGrid(cw, this.data.cwFilled, this.data.cwSel, this.data.cwMark), cwUsed }, extra || {});
this.setData(d);
},

cwTapClue(e) {
const i = +e.currentTarget.dataset.i;
if (this.data.cwFilled[i]) {
this._set(`cwFilled[${i}]`, '');
this._set(`cwMark[${i}]`, null);
}
this.setData({ cwSel: i }, () => this._cwRefresh());
},

cwTapCell(e) {
const r = +e.currentTarget.dataset.r, c = +e.currentTarget.dataset.c;
const cw = this.data.ep.guide.crossword;
const hits = [];
cw.words.forEach((w, i) => {
if (this._cwCells(cw, i).some(([rr, cc]) => rr === r && cc === c)) hits.push(i);
});
if (!hits.length) return;
let pick = hits[0];
if (hits.length > 1 && hits.includes(this.data.cwSel)) pick = hits.find((h) => h !== this.data.cwSel);
this.cwTapClue({ currentTarget: { dataset: { i: pick } } });
},

cwTapChip(e) {
const wi = +e.currentTarget.dataset.wi;
const cw = this.data.ep.guide.crossword;
const sel = this.data.cwSel;
if (sel < 0) { wx.showToast({ title: '先点一条提示，选中一个空位', icon: 'none' }); return; }
if (cw.words[wi].word.length !== cw.words[sel].word.length) { wx.showToast({ title: '长度对不上，换一个词试试', icon: 'none' }); return; }
const filled = this.data.cwFilled.slice();
filled.forEach((f, i) => { if (f === cw.words[wi].word) filled[i] = ''; });
filled[sel] = cw.words[wi].word;
this.setData({ cwFilled: filled, cwMark: this.data.cwMark.map((m, i) => (i === sel || filled[i] !== this.data.cwFilled[i]) ? null : m) }, () => this._cwRefresh());
},

cwCheck() {
const cw = this.data.ep.guide.crossword;
let right = 0;
const mark = cw.words.map((w, i) => { const ok = this.data.cwFilled[i] === w.word; if (ok) right++; return ok; });
this.setData({ cwMark: mark, cwScore: right === cw.words.length ? `🎉 ${right} / ${cw.words.length}，全部答对，就是今日 MVP！` : `答对 ${right} / ${cw.words.length} 题，点错的词条可以清空重选，再核对一次。` }, () => this._cwRefresh());
},

cwReset() {
const cw = this.data.ep.guide.crossword;
this.setData({ cwFilled: cw.words.map(() => ''), cwMark: cw.words.map(() => null), cwSel: -1, cwScore: '' }, () => this._cwRefresh());
},

pickP(e) {
const ds = e.currentTarget.dataset;
this._set(`selP[${ds.g}][${ds.i}]`, +ds.o);
if (this.data.markP[ds.g][ds.i] !== null) this._set(`markP[${ds.g}][${ds.i}]`, null);
},

check4() {
const prac = this.data.ep.guide.practice;
let right = 0, total = 0;
const markP = prac.groups.map((gr, gi) => gr.items.map((it, ii) => {
if (it.answer === undefined) return null;
total++;
const ok = this.data.selP[gi][ii] === it.answer;
if (ok) right++;
return ok;
}));
this.setData({ markP, score4: right === total ? `🎉 ${right} / ${total}，全部答对，就是今日 MVP！` : `答对 ${right} / ${total} 题，改一改错题，再核对一次。` });
},

reset4() {
const prac = this.data.ep.guide.practice;
this.setData({ selP: prac.groups.map((gr) => gr.items.map(() => -1)), markP: prac.groups.map((gr) => gr.items.map(() => null)), score4: '' });
},

updateHighlight() {
if (!this.data.ep ||!this._isMine()) return; // 播的不是本期，本页不跟着走
const t = bgm.currentTime + CURSOR_LEAD;
const blocks = this.data.ep.blocks;
let bi = -1, wi = -1;
for (let i = 0; i < blocks.length; i++) {
if (t >= blocks[i].start && t < blocks[i].end) {
bi = i;
const words = blocks[i].words;
for (let j = 0; j < words.length; j++) {
if (t >= words[j].t) wi = j; else break;
}
break;
}
}
const d = { curTime: fmt(bgm.currentTime)};
if (!this.data.seeking && bgm.duration) {
d.progress = Math.round((bgm.currentTime / bgm.duration) * 1000);
}
if (bi!== this.data.curBlock) {
d.curBlock = bi;
d.curWord = wi;
this.setData(d);
if (bi >= 0) {
const q = wx.createSelectorQuery();
q.selectAll('.block').boundingClientRect();
q.selectViewport().scrollOffset();
q.exec(res => {
const rects = res[0], scroll = res[1];
if (rects && rects[bi]) {
wx.pageScrollTo({
scrollTop: scroll.scrollTop + rects[bi].top - 220,
duration: 300,
});
}
});
}
} else if (wi!== this.data.curWord) {
d.curWord = wi;
this.setData(d);
} else {
this.setData(d);
}
},

tapBlock(e) {
if (!this.data.ep) return;
const idx = e.currentTarget.dataset.idx;
const b = this.data.ep.blocks[idx];
const t = bgm.currentTime || 0;
if (this._isMine() && t >= b.start && t < b.end) {
this.togglePlay(); // 点正在读的段：原地暂停/继续
} else if (!this._isMine() ||!bgm.src) {
this._loadSrc(b.start + 0.03); // 换源并在 canplay 后跳到该段
} else {
bgm.seek(b.start + 0.03);
if (!this.data.playing) bgm.play();
}
},

onSeeking(e) {
this.setData({ seeking: true, progress: e.detail.value});
},

onSeek(e) {
const v = e.detail.value;
this.setData({ seeking: false});
if (!this.data.ep) return;
if (!this._isMine() ||!bgm.src) {
this._loadSrc();
this._pendingSeekRatio = v / 1000;
return;
}
if (!bgm.duration) return;
bgm.seek((v / 1000) * bgm.duration);
if (!this.data.playing) bgm.play();
},

setRate(e) {
const r = parseFloat(e.currentTarget.dataset.r);
this.setData({ rate: r});
bgm.playbackRate = r;
},

downloadPdf() {
const ep = this.data.ep;
if (!ep) return;
wx.showLoading({ title: '下载中…'});
wx.downloadFile({
url: ep.pdf,
success(res) {
wx.hideLoading();
if (res.statusCode === 200) {
wx.openDocument({
filePath: res.tempFilePath,
fileType: 'pdf',
fail() { wx.showToast({ title: '打开失败', icon: 'none'});},
});
} else {
wx.showToast({ title: '下载失败', icon: 'none'});
}
},
fail() {
wx.hideLoading();
wx.showToast({ title: '下载失败', icon: 'none'});
},
});
},
});
