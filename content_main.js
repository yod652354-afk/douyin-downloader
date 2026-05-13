console.log('[抖音下载器] 拦截器已启动，等待页面加载数据...');

// 解析视频数据的公共函数
function parseVideos(awemeList) {
  const videos = [];
  for (const item of awemeList) {
    const urlList = item.video?.play_addr?.url_list || [];
    const bitrateList = item.video?.bit_rate || [];
    let bestUrl = urlList[0] || '';
    
    if (bitrateList.length > 0) {
      const sorted = bitrateList.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
      const bestUrls = sorted[0]?.play_addr?.url_list || [];
      if (bestUrls[0]) bestUrl = bestUrls[0];
    }

    if (bestUrl) {
      videos.push({
        id: item.aweme_id,
        title: (item.desc || '无标题').replace(/[\\\\/:*?"<>|]/g, '_').substring(0, 60),
        author: item.author?.nickname || '未知作者',
        duration: item.duration || item.video?.duration || 15000,
        url: bestUrl,
        cover: item.video?.cover?.url_list?.[0] || ''
      });
    }
  }
  return videos;
}

const originFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originFetch.apply(this, args);
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
  
  // 同时匹配 喜欢(favorite)、收藏(collect)、作品(post)
  if (url.includes('/favorite/') || url.includes('/collect') || url.includes('/listcollection') || url.includes('/post/')) {
    response.clone().json().then(data => {
      if (data && data.aweme_list && data.aweme_list.length > 0) {
        const videos = parseVideos(data.aweme_list);
        console.log('[抖音下载器] Fetch拦截到', videos.length, '个视频来自:', url);
        window.postMessage({ source: '__douyinDL_page', type: 'INTERCEPT_VIDEOS', videos }, '*');
      }
    }).catch(e => console.error('[抖音下载器] Fetch解析错误:', e));
  }
  return response;
};

// 2. 拦截 XMLHttpRequest
const originXhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  this._douyinUrl = url;
  return originXhrOpen.call(this, method, url, ...rest);
};

const originXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(...rest) {
  this.addEventListener('load', function() {
    if (this._douyinUrl && (this._douyinUrl.includes('/favorite/') || this._douyinUrl.includes('/collect') || this._douyinUrl.includes('/listcollection') || this._douyinUrl.includes('/post/'))) {
      try {
        const data = JSON.parse(this.responseText);
        if (data && data.aweme_list && data.aweme_list.length > 0) {
          const videos = parseVideos(data.aweme_list);
          console.log('[抖音下载器] XHR拦截到', videos.length, '个视频来自:', this._douyinUrl);
          window.postMessage({ source: '__douyinDL_page', type: 'INTERCEPT_VIDEOS', videos }, '*');
        }
      } catch(e) {
        console.error('[抖音下载器] XHR解析错误:', e);
      }
    }
  });
  return originXhrSend.apply(this, rest);
};
