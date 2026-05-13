// Service Worker：管理下载队列和计时逻辑

let state = {
  queue: [],       // 待下载视频列表
  status: 'idle',  // idle | scanning | running | paused | done
  currentIndex: 0,
  completed: [],
  failed: []
};

// 广播状态给 popup
function broadcast(extra = {}) {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: { ...state, ...extra } }).catch(() => {});
}

// 休眠函数
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 清理文件名特殊字符
function sanitizeFilename(name) {
  return name.replace(/[\\\\/:*?"<>|]/g, '_').replace(/\\s+/g, ' ').trim().substring(0, 80);
}

// 执行单个视频下载
async function downloadVideo(video) {
  return new Promise((resolve) => {
    // 查找任何打开的抖音页面
    chrome.tabs.query({ url: '*://*.douyin.com/*' }, (tabs) => {
      if (tabs.length === 0) {
        state.error = '下载失败: 找不到打开的抖音网页，请保持抖音页面处于打开状态';
        broadcast();
        resolve(false);
        return;
      }
      
      // 让第一个找到的抖音页面去执行 Blob 下载
      chrome.tabs.sendMessage(tabs[0].id, { type: 'DOWNLOAD_BLOB', video: video }, (response) => {
        if (chrome.runtime.lastError) {
          state.error = '下载失败: 页面通信中断，请刷新抖音网页后再试';
          broadcast();
          resolve(false);
        } else if (response && response.ok) {
          resolve(true); // 下载成功
        } else {
          state.error = '页面内下载失败: ' + (response ? response.error : '未知错误');
          broadcast();
          resolve(false);
        }
      });
    });
  });
}

// 处理下载队列
async function processQueue() {
  while (state.status === 'running' && state.currentIndex < state.queue.length) {
    const video = state.queue[state.currentIndex];

    // 计算等待时间：视频时长的 30%~50%（模拟观看）
    const durationSec = (video.duration || 15000) / 1000;
    const factor = 0.30 + Math.random() * 0.20;
    const waitMs = Math.min(durationSec * factor * 1000, 30000); // 最多等 30 秒

    // 更新为"观看中"状态
    video.status = 'watching';
    video.waitMs = Math.round(waitMs);
    broadcast();

    await sleep(waitMs);
    if (state.status !== 'running') break;

    // 触发下载
    video.status = 'downloading';
    broadcast();

    const ok = await downloadVideo(video);
    if (ok) {
      video.status = 'done';
      state.completed.push(video.id);
    } else {
      video.status = 'failed';
      state.failed.push(video.id);
    }

    state.currentIndex++;
    broadcast();

    // 下载后随机间隔 2~5 秒再处理下一个
    await sleep(2000 + Math.random() * 3000);
  }

  if (state.currentIndex >= state.queue.length && state.status === 'running') {
    state.status = 'done';
    broadcast();
  }
}

// 监听消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 收到拦截到的视频数据（来自 content.js）
  if (msg.type === 'INTERCEPT_VIDEOS') {
    const newVideos = msg.videos;
    let added = 0;
    
    for (const v of newVideos) {
      // 去重：如果队列里还没有这个视频，就加进去
      if (!state.queue.find(item => item.id === v.id) && !state.completed.includes(v.id)) {
        state.queue.push({ ...v, status: 'pending' });
        added++;
      }
    }
    
    if (added > 0) {
      broadcast(); // 更新 UI
    }
  }

  // popup 指令
  if (msg.type === 'CMD_SCAN') {
    state.status = 'scanning';
    state.queue = [];
    broadcast();
    // 找到当前活跃的抖音 tab 并发送扫描指令
    chrome.tabs.query({ active: true, currentWindow: true, url: '*://*.douyin.com/*' }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN' }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('Content script未响应，可能需要刷新页面:', chrome.runtime.lastError);
            state.status = 'idle';
            broadcast({ error: '请先刷新抖音网页再点击扫描' });
          }
        });
      } else {
        // 如果没有抖音tab，尝试查找任何抖音tab
        chrome.tabs.query({ url: '*://*.douyin.com/*' }, (allTabs) => {
          if (allTabs[0]) {
             chrome.tabs.sendMessage(allTabs[0].id, { type: 'SCAN' }, (response) => {
               if (chrome.runtime.lastError) {
                 state.status = 'idle';
                 broadcast({ error: '请先刷新抖音网页再点击扫描' });
               }
             });
          } else {
            state.status = 'idle';
            broadcast({ error: '未找到抖音网页，请打开并刷新' });
          }
        });
      }
    });
    sendResponse({ ok: true });
  }

  if (msg.type === 'CMD_START') {
    if (state.queue.length > 0 && state.status !== 'running') {
      state.status = 'running';
      if (msg.fromStart) {
        state.currentIndex = 0;
        state.completed = [];
        state.failed = [];
        state.queue.forEach(v => { v.status = 'pending'; });
      }
      broadcast();
      processQueue();
    }
    sendResponse({ ok: true });
  }

  if (msg.type === 'CMD_PAUSE') {
    state.status = 'paused';
    broadcast();
    sendResponse({ ok: true });
  }

  if (msg.type === 'CMD_RESUME') {
    state.status = 'running';
    broadcast();
    processQueue();
    sendResponse({ ok: true });
  }

  if (msg.type === 'CMD_GET_STATE') {
    sendResponse({ state });
  }

  return true;
});
