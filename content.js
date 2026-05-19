// 隔离世界：桥接 MAIN world 和 background service worker
console.log('[抖音下载器] content.js 注入成功，环境: ISOLATED world');

// 监听来自页面 MAIN world 的消息
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.douyin.com') return;
  if (!e.data || e.data.source !== '__douyinDL_page') return;
  console.log('[抖音下载器] 收到来自页面的消息:', e.data);

  // 转发给 background
  chrome.runtime.sendMessage({ ...e.data }).catch(() => {});
});

// 监听来自 background 的指令
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[抖音下载器] 收到后台指令:', msg);
  if (msg.type === 'SCAN') {
    window.postMessage({ source: '__douyinDL_bridge', type: 'SCAN' }, '*');
    sendResponse({ ok: true });
  } else if (msg.type === 'DOWNLOAD_BLOB') {
    (async () => {
      try {
        console.log('[抖音下载器] 开始在页面内通过 Fetch 下载视频...', msg.video.title);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        const resp = await fetch(msg.video.url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const filename = 'douyin_' + msg.video.title.replace(/[\\\\/:*?"<>|]/g, '_').substring(0, 50) + '_' + msg.video.id + '.mp4';
        
        // 创建隐藏的 a 标签进行下载
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        
        // 延迟清理资源 (延长到 5 分钟)
        // 防止用户开启了“另存为”弹窗，或者视频过大导致写入硬盘超过 2 秒，从而引发 ERR_FILE_NOT_FOUND
        setTimeout(() => {
          if (document.body.contains(a)) {
            document.body.removeChild(a);
          }
          URL.revokeObjectURL(objectUrl);
        }, 300000);
        
        console.log('[抖音下载器] 页面内下载触发成功！');
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[抖音下载器] 页面内下载失败:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // 保持通道异步
  }
  return true;
});
