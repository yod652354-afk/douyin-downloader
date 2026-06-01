// Service Worker：管理下载队列和计时逻辑

let state = {
  queue: [],
  status: 'idle',  // idle | scanning | running | paused | done
  currentIndex: 0,
  completed: [],
  failed: [],
  downloadFolder: '抖音下载',
  logs: []         // { ts, type, msg }
};

// ===== 日志系统 =====
const LOG_TYPES = { info: 'ℹ', warn: '⚠', error: '✗', success: '✓' };

function addLog(type, msg) {
  const now = new Date();
  const ts = now.toTimeString().substring(0, 8);
  state.logs.push({ ts, type, msg });
  if (state.logs.length > 200) state.logs.shift();
  console.log(`[下载器][${type}] ${msg}`);
}

function clearLogs() {
  state.logs = [];
  addLog('info', '日志已清空');
}

addLog('info', 'Service Worker 已启动');

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
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\\s+/g, ' ').trim().substring(0, 80);
}

// 构造文件夹路径
function folderPath(video) {
  const desc = sanitizeFilename(video.title).substring(0, 50);
  const author = sanitizeFilename(video.author);
  return state.downloadFolder + '/' + desc + '-' + author;
}

// 执行单个视频下载（通过 content script 的 fetch blob → ArrayBuffer → background 下载）
async function downloadVideo(video, folderPath) {
  const fname = sanitizeFilename(video.title).substring(0, 50) + '_' + (video.id || '').substring(0, 8) + '.mp4';
  const fullPath = folderPath + '/' + fname;

  // 带连接重试的发送消息（页面刷新时自动恢复）
  return new Promise((resolve) => {
    const trySend = (retryCount) => {
      chrome.tabs.query({ url: '*://*.douyin.com/*' }, (tabs) => {
        if (tabs.length === 0) {
          addLog('error', '下载失败: 未找到抖音页面');
          resolve(false);
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { type: 'DOWNLOAD_BLOB', video: video, folderPath: folderPath, filename: fullPath }, (response) => {
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('Receiving end does not exist')) {
              addLog('warn', '页面刷新中，等待恢复 (' + (retryCount + 1) + ')...');
              setTimeout(() => trySend(retryCount + 1), 3000);
              return;
            }
            addLog('error', '下载通信失败: ' + msg);
            resolve(false);
          } else if (response && response.ok) {
            addLog('success', '视频下载触发: ' + fname);
            resolve(true);
          } else {
            addLog('error', '视频获取失败: ' + (response ? (response.error || '未知错误') : '无响应'));
            resolve(false);
          }
        });
      });
    };
    trySend(0);
  });
}

// 获取评论截图（转发给 content.js 渲染后接收 base64 PNG，由 background 下载）
async function captureComments(video, folderPath) {
  return new Promise((resolve) => {
    const trySend = (retryCount) => {
    chrome.tabs.query({ url: '*://*.douyin.com/*' }, (tabs) => {
      if (tabs.length === 0) {
        addLog('warn', '评论截图跳过: 未找到抖音页面');
        resolve(false);
        return;
      }

      chrome.tabs.sendMessage(tabs[0].id, { type: 'CAPTURE_COMMENTS', awemeId: video.id, folderPath: folderPath, title: video.title, author: video.author }, (response) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || '';
          if (msg.includes('Receiving end does not exist')) {
            addLog('warn', '页面刷新中(截图)，等待恢复...');
            setTimeout(() => trySend(retryCount + 1), 3000);
            return;
          }
          addLog('warn', '评论截图通信失败: ' + msg);
          resolve(false);
          return;
        }

        if (response && response.ok && response.dataUrl) {
          chrome.downloads.download({ url: response.dataUrl, filename: folderPath + '/评论截图.png', saveAs: false }, (downloadId) => {
            if (chrome.runtime.lastError) {
              addLog('error', '评论截图保存失败: ' + chrome.runtime.lastError.message);
              resolve(false);
            } else {
              addLog('success', '评论截图已保存 (id=' + downloadId + ')');

              // 同时保存纯文本版评论
              if (response.commentText) {
                const textDataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(response.commentText);
                chrome.downloads.download({ url: textDataUrl, filename: folderPath + '/评论.txt', saveAs: false }, (textId) => {
                  if (chrome.runtime.lastError) {
                    addLog('warn', '评论文本保存失败: ' + chrome.runtime.lastError.message);
                  } else {
                    addLog('success', '评论文本已保存 (id=' + textId + ')');
                  }
                });
              }

              resolve(true);
            }
          });
        } else {
          if (response && response.noComments) {
            addLog('info', '该视频暂无评论，跳过截图');
          } else {
            addLog('error', '评论截图生成失败: ' + (response ? response.error : '未知错误'));
          }
          resolve(false);
        }
      });
    });
    };
    trySend(0);
  });
}

// 处理下载队列
async function processQueue() {
  if (state.status !== 'running') return;
  addLog('info', '开始处理下载队列，共 ' + state.queue.length + ' 个视频');

  while (state.status === 'running' && state.currentIndex < state.queue.length) {
    const video = state.queue[state.currentIndex];
    const vFolder = folderPath(video);

    addLog('info', '[' + (state.currentIndex + 1) + '/' + state.queue.length + '] ' + video.title);

    // 计算等待时间：视频时长的 30%~50%（模拟观看）
    const durationSec = (video.duration || 15000) / 1000;
    const factor = 0.30 + Math.random() * 0.20;
    const waitMs = Math.min(durationSec * factor * 1000, 30000);

    video.status = 'watching';
    video.waitMs = Math.round(waitMs);
    broadcast();

    addLog('info', '模拟观看中... ' + (waitMs / 1000).toFixed(0) + 's');
    await sleep(waitMs);
    if (state.status !== 'running') break;

    // 触发下载（最多 3 次尝试：1 次初始 + 2 次重试）
    video.status = 'downloading';
    broadcast();

    let downloadOk = false;
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (state.status !== 'running') break;
      if (attempt > 1) {
        addLog('warn', '下载重试 ' + (attempt - 1) + '/2: ' + video.title.substring(0, 30));
        video.status = 'downloading';
        broadcast();
        await sleep(3000 + Math.random() * 3000);
      }
      downloadOk = await downloadVideo(video, vFolder);
      if (downloadOk) break;
      if (attempt < maxRetries) {
        addLog('warn', '下载失败，准备重试 (' + attempt + '/' + maxRetries + ')');
      }
    }

    if (downloadOk) {
      // 下载成功后获取评论截图（最多 2 次尝试）
      video.status = 'fetching_comments';
      broadcast();

      let captureOk = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (state.status !== 'running') break;
        if (attempt > 1) {
          addLog('warn', '截图重试: ' + video.title.substring(0, 30));
          await sleep(2000 + Math.random() * 2000);
        }
        captureOk = await captureComments(video, vFolder);
        if (captureOk) break;
      }

      video.status = 'done';
      state.completed.push(video.id);
      addLog('success', '完成: ' + video.title);
    } else {
      video.status = 'failed';
      state.failed.push(video.id);
      addLog('error', '失败(已重试' + (maxRetries - 1) + '次): ' + video.title);
    }

    state.currentIndex++;
    broadcast();

    // 下载后随机间隔 2~5 秒再处理下一个
    await sleep(2000 + Math.random() * 3000);
  }

  if (state.currentIndex >= state.queue.length && state.status === 'running') {
    state.status = 'done';
    addLog('success', '队列处理完毕! 成功: ' + state.completed.length + ', 失败: ' + state.failed.length);
    broadcast();
  }
}

// ===== 监听消息 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // 收到拦截到的视频数据（来自 content.js）
  if (msg.type === 'INTERCEPT_VIDEOS') {
    const newVideos = msg.videos;
    let added = 0;

    for (const v of newVideos) {
      if (!state.queue.find(item => item.id === v.id) && !state.completed.includes(v.id)) {
        state.queue.push({ ...v, status: 'pending' });
        added++;
      }
    }

    if (added > 0) {
      addLog('info', '新捕获 ' + added + ' 个视频 (总计 ' + state.queue.length + ')');
      broadcast();
    }
  }

  // content.js 注入就绪
  if (msg.type === 'CONTENT_READY') {
    addLog('info', '页面已就绪');
    // 如果正在等待扫描，自动触发
    if (state.status === 'scanning') {
      chrome.tabs.query({ url: '*://*.douyin.com/*' }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN' });
        }
      });
    }
    sendResponse({ ok: true });
  }

  // 来自 content.js 的日志转发
  if (msg.type === 'LOG') {
    addLog(msg.logType || 'info', '[页面] ' + msg.message);
    sendResponse({ ok: true });
  }

  // popup 指令: 扫描
  if (msg.type === 'CMD_SCAN') {
    state.status = 'scanning';
    state.queue = [];
    addLog('info', '等待页面就绪后自动扫描...');
    broadcast();
    sendResponse({ ok: true });
  }

  // popup 指令: 开始
  if (msg.type === 'CMD_START') {
    if (state.queue.length > 0 && state.status !== 'running') {
      state.status = 'running';
      if (msg.fromStart) {
        state.currentIndex = 0;
        state.completed = [];
        state.failed = [];
        state.queue.forEach(v => { v.status = 'pending'; });
        addLog('info', '开始全新下载任务');
      } else {
        addLog('info', '继续下载');
      }
      broadcast();
      processQueue();
    }
    sendResponse({ ok: true });
  }

  // popup 指令: 暂停
  if (msg.type === 'CMD_PAUSE') {
    state.status = 'paused';
    addLog('info', '已暂停');
    broadcast();
    sendResponse({ ok: true });
  }

  // popup 指令: 继续
  if (msg.type === 'CMD_RESUME') {
    state.status = 'running';
    addLog('info', '已恢复');
    broadcast();
    processQueue();
    sendResponse({ ok: true });
  }

  // popup 指令: 获取状态
  if (msg.type === 'CMD_GET_STATE') {
    sendResponse({ state });
  }

  // popup 指令: 设置下载目录
  if (msg.type === 'CMD_SET_FOLDER') {
    state.downloadFolder = msg.folder || '抖音下载';
    addLog('info', '下载目录已设置为: ' + state.downloadFolder);
    broadcast();
    sendResponse({ ok: true });
  }

  // 接收 content.js 发来的视频 base64 dataUrl，blob 转存并下载
  if (msg.type === 'SAVE_VIDEO_BLOB') {
    try {
      const filename = msg.filename || 'video.mp4';
      chrome.downloads.download({ url: msg.dataUrl, filename: filename, saveAs: false }, (downloadId) => {
        if (chrome.runtime.lastError) {
          addLog('error', '视频保存失败: ' + chrome.runtime.lastError.message + ' | file=' + filename);
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          addLog('success', '视频已保存: ' + filename + ' (id=' + downloadId + ')');
        }
      });
      sendResponse({ ok: true });
    } catch (e) {
      addLog('error', '处理视频数据失败: ' + e.message + ' | file=' + (msg.filename || 'unknown'));
      sendResponse({ ok: false, error: e.message });
    }
  }

  // popup 指令: 清空日志
  if (msg.type === 'CMD_CLEAR_LOGS') {
    clearLogs();
    broadcast();
    sendResponse({ ok: true });
  }

  return true;
});
