console.log('[抖音下载器] content.js 注入成功，环境: ISOLATED world');

// 转发日志到 background
function logToBg(type, msg) {
  console.log('[抖音下载器][' + type + '] ' + msg);
  chrome.runtime.sendMessage({ type: 'LOG', logType: type, message: msg }).catch(() => {});
}

// 监听来自页面 MAIN world 的消息（仅转发视频拦截，评论响应由 fetchCommentsViaMain 消费）
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.douyin.com') return;
  if (!e.data || e.data.source !== '__douyinDL_page') return;
  if (e.data.type === 'COMMENTS_RESPONSE') return; // 由 fetchCommentsViaMain 独占
  console.log('[抖音下载器] 收到来自页面的消息:', e.data);
  chrome.runtime.sendMessage({ ...e.data }).catch(() => {});
});

// 清理文件名
function safeName(str, maxLen) {
  return str.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, maxLen);
}

// ===== 评论获取：通过 MAIN world 代理（携带页面反爬参数）=====
const pendingRequests = {};
let reqIdCounter = 0;

// 监听来自 MAIN world 的评论 API 响应
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.douyin.com') return;
  if (!e.data || e.data.source !== '__douyinDL_page') return;
  if (e.data.type === 'COMMENTS_RESPONSE') {
    const { requestId, ok, data, error } = e.data;
    const pending = pendingRequests[requestId];
    if (pending) {
      delete pendingRequests[requestId];
      if (ok && data && data.comments) {
        pending.resolve(data.comments);
      } else {
        pending.reject(new Error(error || '评论数据为空'));
      }
    }
  }
  if (e.data.type === 'SHARE_URL_RESPONSE') {
    const { requestId, ok, shortUrl, error } = e.data;
    const pending = pendingRequests[requestId];
    if (pending) {
      delete pendingRequests[requestId];
      if (ok && shortUrl) pending.resolve(shortUrl);
      else pending.reject(new Error(error || '获取分享链接失败'));
    }
  }
});

function fetchCommentsViaMain(awemeId) {
  return new Promise((resolve, reject) => {
    const requestId = ++reqIdCounter;
    pendingRequests[requestId] = { resolve, reject };
    window.postMessage({
      source: '__douyinDL_bridge',
      type: 'FETCH_COMMENTS_API',
      awemeId,
      requestId
    }, '*');

    // 10 秒超时
    setTimeout(() => {
      if (pendingRequests[requestId]) {
        delete pendingRequests[requestId];
        reject(new Error('评论API请求超时'));
      }
    }, 10000);
  });
}

function fetchShareUrlViaMain(awemeId) {
  return new Promise((resolve, reject) => {
    const requestId = ++reqIdCounter;
    pendingRequests[requestId] = { resolve, reject };
    window.postMessage({
      source: '__douyinDL_bridge',
      type: 'FETCH_SHARE_URL',
      awemeId,
      requestId
    }, '*');
    setTimeout(() => {
      if (pendingRequests[requestId]) {
        delete pendingRequests[requestId];
        reject(new Error('分享链接请求超时'));
      }
    }, 5000);
  });
}

function topComments(comments, n) {
  return [...comments].sort((a, b) => (b.digg_count || 0) - (a.digg_count || 0)).slice(0, n);
}

function generateCommentText(title, totalCount, comments, author, shareUrl) {
  const safeTitle = title.replace(/[<>&"']/g, '').substring(0, 80);
  let text = '';
  if (author) text += '@' + author + '\n';
  if (shareUrl) text += '🔗 ' + shareUrl + '\n';
  text += '\n抖音评论 - ' + safeTitle + '\n';
  text += '共获取 ' + totalCount + ' 条评论，以下为点赞最高的 ' + comments.length + ' 条\n';
  text += '='.repeat(50) + '\n\n';

  const medals = ['\u{1F947}', '\u{1F948}', '\u{1F949}']; // 🥇🥈🥉
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const prefix = medals[i] || ('  #' + (i + 1));
    text += prefix + '  ' + c.nickname + '\n';
    text += '     点赞: ' + c.likes.toLocaleString() + '\n';
    text += '     ' + c.text + '\n\n';
  }
  return text;
}

async function avatarToDataUrl(comments) {
  const results = [];
  for (const c of comments) {
    let dataUrl = '';
    const thumb = c.user?.avatar_thumb?.url_list?.[0] || c.user?.avatar_medium?.url_list?.[0] || '';
    if (thumb) {
      try {
        const resp = await fetch(thumb);
        if (resp.ok) {
          const blob = await resp.blob();
          dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        }
      } catch (e) { /* 头像加载失败，使用占位 */ }
    }
    results.push({
      nickname: (c.user?.nickname || '用户').replace(/[<>&"']/g, ''),
      text: (c.text || '').replace(/[<>&"']/g, '').substring(0, 200),
      likes: c.digg_count || 0,
      avatarDataUrl: dataUrl
    });
  }
  return results;
}

function renderCommentsSvg(title, comments) {
  const cardW = 480;
  const cardPad = 14;
  const headerH = 56;
  const totalH = headerH + comments.length * 110 + 20;

  const avatarPlaceholder = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect fill="#333" width="40" height="40"/><text x="20" y="26" text-anchor="middle" fill="#666" font-size="18">?</text></svg>'
  );

  const commentCards = comments.map((c, i) => {
    const avatar = c.avatarDataUrl || avatarPlaceholder;
    const bg = i % 2 === 0 ? '#1a1a2e' : '#16213e';
    return `
    <div style="display:flex;align-items:flex-start;gap:12px;padding:12px 14px;margin-bottom:8px;background:${bg};border-radius:8px;border:1px solid #2a2a3a;">
      <img src="${avatar}" width="36" height="36" style="border-radius:50%;flex-shrink:0;object-fit:cover;" />
      <div style="flex:1;min-width:0;">
        <div style="color:#e0e0e0;font-size:13px;font-weight:600;margin-bottom:4px;">${c.nickname}</div>
        <div style="color:#aaa;font-size:12px;line-height:1.5;word-break:break-all;margin-bottom:6px;">${c.text}</div>
        <div style="color:#ff6b35;font-size:11px;">&#x1F44D; ${c.likes.toLocaleString()}</div>
      </div>
      <span style="color:#ff2d55;font-size:20px;font-weight:700;flex-shrink:0;">#${i + 1}</span>
    </div>`;
  }).join('');

  const safeTitle = title.replace(/[<>&"']/g, '').substring(0, 80);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cardW}" height="${totalH}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0d0d0f"/>
        <stop offset="100%" stop-color="#141418"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/>
    <foreignObject width="${cardW}" height="${totalH}">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:-apple-system,sans-serif;color:#e8e8ec;padding:${cardPad}px;width:${cardW - cardPad * 2}px;box-sizing:border-box;">
        <div style="text-align:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #2a2a3a;">
          <div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:2px;">${safeTitle}</div>
          <div style="font-size:11px;color:#666;">热门评论 Top ${comments.length}</div>
        </div>
        ${commentCards}
      </div>
    </foreignObject>
  </svg>`;
}

// 使用 Canvas 2D 渲染评论截图（避免 SVG foreignObject 导致 Canvas 污染）
async function renderToPngCanvas(title, comments) {
  const W = 480;
  const pad = 14;
  const headerH = 56;
  const cardH = 100;
  const H = headerH + comments.length * cardH + 20;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // 背景
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#0d0d0f');
  bgGrad.addColorStop(1, '#141418');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // 标题
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 15px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  const safeTitle = title.replace(/[<>&"']/g, '').substring(0, 80);
  ctx.fillText(safeTitle, W / 2, pad + 20);

  ctx.fillStyle = '#666';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('热门评论 Top ' + comments.length, W / 2, pad + 38);

  // 分隔线
  ctx.strokeStyle = '#2a2a3a';
  ctx.beginPath();
  ctx.moveTo(pad, headerH);
  ctx.lineTo(W - pad, headerH);
  ctx.stroke();

  // 评论卡片
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const y0 = headerH + 8 + i * cardH;
    const cardBg = i % 2 === 0 ? '#1a1a2e' : '#16213e';

    // 卡片背景
    ctx.fillStyle = cardBg;
    ctx.strokeStyle = '#2a2a3a';
    ctx.beginPath();
    ctx.roundRect(pad, y0, W - pad * 2, cardH - 8, 8);
    ctx.fill();
    ctx.stroke();

    // 头像
    const avatarImg = await new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = c.avatarDataUrl || '';
    });

    const ax = pad + 12, ay = y0 + 14;
    if (avatarImg) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(ax + 18, ay + 18, 18, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(avatarImg, ax, ay, 36, 36);
      ctx.restore();
    } else {
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.arc(ax + 18, ay + 18, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#666';
      ctx.font = '16px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('?', ax + 18, ay + 25);
    }

    // 排名
    ctx.fillStyle = '#ff2d55';
    ctx.font = 'bold 18px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('#' + (i + 1), W - pad - 10, ay + 22);

    // 昵称
    const nameX = ax + 48;
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(c.nickname, nameX, ay + 14);

    // 评论文本
    ctx.fillStyle = '#aaa';
    ctx.font = '11px -apple-system, sans-serif';
    const maxTextW = W - nameX - 50;
    const text = wrapText(ctx, c.text, maxTextW);
    text.slice(0, 3).forEach((line, li) => {
      ctx.fillText(line, nameX, ay + 30 + li * 16);
    });

    // 点赞
    ctx.fillStyle = '#ff6b35';
    ctx.font = '11px -apple-system, sans-serif';
    ctx.fillText('👍 ' + c.likes.toLocaleString(), nameX, ay + 78);
  }

  return new Promise(resolve => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else resolve(null);
    }, 'image/png');
  });
}

// 文本自动换行
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let current = '';
  for (const ch of text) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

async function renderToPng(svgMarkup) {
  // 不使用，兼容旧接口
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 480;
      canvas.height = img.naturalHeight || 300;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob 失败'));
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('SVG 图片加载失败'));
    };
    img.src = url;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function doCaptureComments(awemeId, title, author) {
  // 获取分享短链接
  let shareUrl = '';
  try { shareUrl = await fetchShareUrlViaMain(awemeId); } catch (e) {}

  const comments = await fetchCommentsViaMain(awemeId);
  if (!comments || comments.length === 0) {
    logToBg('info', '视频 ' + title.substring(0, 20) + ' 暂无评论');
    return { ok: true, noComments: true };
  }

  const top3 = topComments(comments, 3);
  logToBg('info', '获取到 ' + comments.length + ' 条评论，取 Top3');

  // 文本取 Top10
  const topText = topComments(comments, 10).map(c => ({
    nickname: (c.user?.nickname || '用户').replace(/[<>&"']/g, ''),
    text: (c.text || '').replace(/[<>&"']/g, '').substring(0, 200),
    likes: c.digg_count || 0
  }));

  const withAvatars = await avatarToDataUrl(top3);

  // 生成纯文本版评论（含分享链接）
  const commentText = generateCommentText(title, comments.length, topText, author, shareUrl);

  const pngBlob = await renderToPngCanvas(title, withAvatars);
  if (!pngBlob) {
    return { ok: false, error: 'Canvas 渲染失败' };
  }
  const dataUrl = await blobToDataUrl(pngBlob);
  return { ok: true, dataUrl: dataUrl, commentText: commentText };
}

// ===== 消息监听 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[抖音下载器] 收到后台指令:', msg);

  if (msg.type === 'SCAN') {
    window.postMessage({ source: '__douyinDL_bridge', type: 'SCAN' }, '*');
    sendResponse({ ok: true });
  } else if (msg.type === 'CAPTURE_COMMENTS') {
    logToBg('info', '开始截图评论: ' + (msg.title || '').substring(0, 30));
    doCaptureComments(msg.awemeId, msg.title, msg.author || '')
      .then(result => {
        logToBg(result.ok && !result.noComments ? 'success' : 'info', '评论截图完成');
        sendResponse(result);
      })
      .catch(e => {
        logToBg('error', '评论截图失败: ' + e.message);
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  } else if (msg.type === 'DOWNLOAD_BLOB') {
    (async () => {
      try {
        logToBg('info', '开始获取视频: ' + (msg.video.title || '').substring(0, 30));
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000);
        const resp = await fetch(msg.video.url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);

        const blob = await resp.blob();
        const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
        logToBg('info', '视频获取完成, 大小: ' + sizeMB + 'MB, 发送中...');

        // 用 FileReader 转 base64 传输（33% 开销，支持约 40MB 视频）
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('读取文件失败'));
          reader.readAsDataURL(blob);
        });

        chrome.runtime.sendMessage({
          type: 'SAVE_VIDEO_BLOB',
          dataUrl: dataUrl,
          filename: msg.filename,
          folderPath: msg.folderPath
        });
        sendResponse({ ok: true });
      } catch (e) {
        logToBg('error', '视频获取失败: ' + e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  return true;
});
