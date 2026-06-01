try {
console.log('[抖音下载器] 拦截器已启动，等待页面加载数据...');

// 缓存可复用的反爬参数（从拦截的请求 URL 中提取）
let cachedParams = {
  msToken: '',
  webid: '',
  uifid: '',
  verifyFp: '',
  fp: '',
  aid: '6383',
  device_platform: 'webapp',
  channel: 'channel_pc_web'
};

function extractParams(urlStr) {
  try {
    const u = new URL(urlStr);
    const keys = ['msToken', 'webid', 'uifid', 'verifyFp', 'fp', 'aid', 'device_platform', 'channel'];
    for (const k of keys) {
      const v = u.searchParams.get(k);
      if (v) cachedParams[k] = v;
    }
  } catch (e) { /* ignore */ }
}

// 解析视频数据的公共函数
function parseVideos(awemeList) {
  const videos = [];
  for (const item of awemeList) {
    const urlList = item.video?.play_addr?.url_list || [];
    const bitrateList = item.video?.bit_rate || [];
    let bestUrl = urlList[0] || '';

    if (bitrateList.length > 0) {
      const sorted = [...bitrateList].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
      const bestUrls = sorted[0]?.play_addr?.url_list || [];
      if (bestUrls[0]) bestUrl = bestUrls[0];
    }

    if (bestUrl) {
      videos.push({
        id: item.aweme_id,
        title: (item.desc || '无标题').replace(/[\\/:*?"<>|]/g, '_').substring(0, 60),
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

  extractParams(url);

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
  extractParams(url);
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
        // 跳过非 JSON 响应
        if (this.responseText && this.responseText.length > 0 && this.responseText[0] === '{') {
          console.error('[抖音下载器] XHR解析错误:', e, '| 前80字:', this.responseText.substring(0, 80));
        }
      }
    }
  });
  return originXhrSend.apply(this, rest);
};

// 3. 为 ISOLATED world 提供评论 API 代理（MAIN world 有完整页面上下文）
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (!e.data || e.data.source !== '__douyinDL_bridge') return;

  if (e.data.type === 'SCAN') {
    console.log('[抖音下载器] 收到扫描指令');
  }

  if (e.data.type === 'FETCH_COMMENTS_API') {
    const { awemeId, requestId } = e.data;

    const base = 'https://www-hj.douyin.com/aweme/v1/web/comment/list/';
    const params = new URLSearchParams({
      aweme_id: awemeId,
      cursor: '0',
      count: '20',
      item_type: '0',
      device_platform: cachedParams.device_platform || 'webapp',
      aid: cachedParams.aid || '6383',
      channel: cachedParams.channel || 'channel_pc_web',
      pc_client_type: '1',
      version_code: '170400',
      version_name: '17.4.0',
      cookie_enabled: 'true',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      screen_width: '1920',
      screen_height: '1080',
      platform: 'PC'
    });
    if (cachedParams.webid) params.set('webid', cachedParams.webid);
    if (cachedParams.msToken) params.set('msToken', cachedParams.msToken);
    if (cachedParams.verifyFp) params.set('verifyFp', cachedParams.verifyFp);
    if (cachedParams.fp) params.set('fp', cachedParams.fp);
    if (cachedParams.uifid) params.set('uifid', cachedParams.uifid);

    const url = base + '?' + params.toString();
    console.log('[抖音下载器] MAIN world 代理请求评论API:', url);

    // 使用 window.fetch（会经过页面自身的 fetch 拦截器链，自动附加 a_bogus 等签名参数）
    window.fetch(url, { credentials: 'include' })
      .then(resp => {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.text();
      })
      .then(text => {
        try {
          const data = JSON.parse(text);
          window.postMessage({
            source: '__douyinDL_page',
            type: 'COMMENTS_RESPONSE',
            requestId,
            ok: true,
            data
          }, '*');
        } catch (e) {
          window.postMessage({
            source: '__douyinDL_page',
            type: 'COMMENTS_RESPONSE',
            requestId,
            ok: false,
            error: 'JSON解析失败: ' + e.message + ' | 前80字: ' + (text || '').substring(0, 80)
          }, '*');
        }
      })
      .catch(e => {
        window.postMessage({
          source: '__douyinDL_page',
          type: 'COMMENTS_RESPONSE',
          requestId,
          ok: false,
          error: e.message
        }, '*');
      });
  }

  if (e.data.type === 'FETCH_SHARE_URL') {
    const { awemeId, requestId } = e.data;
    const base = 'https://www.douyin.com/aweme/v1/web/web_shorten/';
    const target = 'https://www.iesdouyin.com/share/video/' + awemeId + '/';
    const params = new URLSearchParams({
      target: target, belong: 'aweme', persist: '1',
      device_platform: cachedParams.device_platform || 'webapp',
      aid: cachedParams.aid || '6383',
      channel: cachedParams.channel || 'channel_pc_web',
      pc_client_type: '1', version_code: '170400', version_name: '17.4.0',
      cookie_enabled: 'true', browser_language: 'zh-CN',
      browser_platform: 'Win32', browser_name: 'Chrome',
      screen_width: '1920', screen_height: '1080', platform: 'PC'
    });
    if (cachedParams.webid) params.set('webid', cachedParams.webid);
    if (cachedParams.msToken) params.set('msToken', cachedParams.msToken);

    console.log('[抖音下载器] 请求分享链接: awemeId=' + awemeId);
    window.fetch(base + '?' + params.toString(), { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(d => {
        const result = d?.short_url || d?.data?.short_url || d?.share_url || JSON.stringify(d).substring(0, 200);
        console.log('[抖音下载器] 分享链接API响应: ' + result);
        window.postMessage({ source: '__douyinDL_page', type: 'SHARE_URL_RESPONSE', requestId, ok: true, shortUrl: d?.short_url || d?.data?.short_url || '' }, '*');
      })
      .catch(e => {
        console.error('[抖音下载器] 分享链接请求失败: ' + e.message);
        window.postMessage({ source: '__douyinDL_page', type: 'SHARE_URL_RESPONSE', requestId, ok: false, error: e.message }, '*');
      });
  }
});

} catch (e) {
  console.error('[抖音下载器] 拦截器启动失败:', e.message, e.stack);
}
window.addEventListener('error', (e) => {
  console.error('[抖音下载器] 全局错误:', e.message, 'at', e.filename, ':', e.lineno);
});
