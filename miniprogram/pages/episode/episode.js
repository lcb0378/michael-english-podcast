// 跟读页：节目数据从服务器动态加载；播放 + 单词高亮 + 点段跳转 + 语速 + PDF下载
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
    rates: [0.85, 1, 1.5],
    seeking: false,
  },

  onLoad(opts) {
    const id = opts.id || 'vol01';
    wx.request({
      url: `${DATA_BASE}/${id}.json`,
      success: (res) => {
        const ep = res.data;
        this.setData({ ep, loading: false });
        wx.setNavigationBarTitle({ title: `${ep.id.toUpperCase()} · ${ep.title}` });
        bgm.title = `Michael的早听晚读 ${ep.id.toUpperCase()}`;
        bgm.epname = ep.title;
        bgm.singer = 'Michael的早听晚读';
      },
      fail: () => {
        this.setData({ loading: false });
        wx.showToast({ title: '节目加载失败', icon: 'none' });
      },
    });

    bgm.onPlay(() => this.setData({ playing: true }));
    bgm.onPause(() => this.setData({ playing: false }));
    bgm.onStop(() => this.setData({ playing: false, curBlock: -1, curWord: -1 }));
    bgm.onEnded(() => this.setData({ playing: false }));
    bgm.onTimeUpdate(() => this.updateHighlight());
    bgm.onCanplay(() => {
      this.setData({ durTime: fmt(bgm.duration) });
    });
  },

  togglePlay() {
    if (!this.data.ep) return;
    if (this.data.playing) {
      bgm.pause();
    } else {
      if (!bgm.src) {
        bgm.src = this.data.ep.audio; // 首次设置会自动播放
        bgm.playbackRate = this.data.rate;
      } else {
        bgm.play();
      }
    }
  },

  updateHighlight() {
    if (!this.data.ep) return;
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
    const d = { curTime: fmt(bgm.currentTime) };
    if (!this.data.seeking && bgm.duration) {
      d.progress = Math.round((bgm.currentTime / bgm.duration) * 1000);
    }
    if (bi !== this.data.curBlock) {
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
    } else if (wi !== this.data.curWord) {
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
    if (t >= b.start && t < b.end) {
      this.togglePlay(); // 点正在读的段：原地暂停/继续
    } else {
      if (!bgm.src) {
        bgm.src = this.data.ep.audio;
        bgm.playbackRate = this.data.rate;
      }
      bgm.seek(b.start + 0.03);
      if (!this.data.playing) bgm.play();
    }
  },

  onSeeking(e) {
    this.setData({ seeking: true, progress: e.detail.value });
  },

  onSeek(e) {
    const v = e.detail.value;
    this.setData({ seeking: false });
    if (!this.data.ep || !bgm.duration) return;
    if (!bgm.src) {
      bgm.src = this.data.ep.audio;
      bgm.playbackRate = this.data.rate;
    }
    bgm.seek((v / 1000) * bgm.duration);
    if (!this.data.playing) bgm.play();
  },

  setRate(e) {
    const r = parseFloat(e.currentTarget.dataset.r);
    this.setData({ rate: r });
    bgm.playbackRate = r;
  },

  downloadPdf() {
    const ep = this.data.ep;
    if (!ep) return;
    wx.showLoading({ title: '下载中…' });
    wx.downloadFile({
      url: ep.pdf,
      success(res) {
        wx.hideLoading();
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'pdf',
            fail() { wx.showToast({ title: '打开失败', icon: 'none' }); },
          });
        } else {
          wx.showToast({ title: '下载失败', icon: 'none' });
        }
      },
      fail() {
        wx.hideLoading();
        wx.showToast({ title: '下载失败', icon: 'none' });
      },
    });
  },
});
