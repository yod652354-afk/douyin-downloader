const $ = id => document.getElementById(id);

function escapeHtml(str) {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

const STATUS_LABELS = {
  idle: ['空闲', 'idle'],
  scanning: ['扫描中...', 'scanning'],
  running: ['下载中', 'running'],
  paused: ['已暂停', 'paused'],
  done: ['已完成', 'done']
};

const VIDEO_STATUS = {
  pending: ['等待中', 'vs-pending'],
  watching: ['观看中', 'vs-watching'],
  downloading: ['下载中', 'vs-downloading'],
  done: ['✓ 完成', 'vs-done'],
  failed: ['✗ 失败', 'vs-failed']
};

let currentState = null;
let toastTimer = null;

function showToast(msg) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

function updateUI(state) {
  if (!state) return;
  currentState = state;

  // 状态标签
  const [label, cls] = STATUS_LABELS[state.status] || ['未知', 'idle'];
  const badge = $('status-badge');
  badge.textContent = label;
  badge.className = 'badge badge-' + cls;

  // 队列区域（无论是否有数据都显示，因为随时会被推入）
  $('queue-section').classList.remove('hidden');
  const total = state.queue ? state.queue.length : 0;
  
  if (total > 0) {
    const done = state.completed.length;
    const failed = state.failed.length;
    const remain = total - done - failed;

    $('stat-total').textContent = total;
    $('stat-done').textContent = done;
    $('stat-failed').textContent = failed;
    $('stat-remain').textContent = Math.max(0, remain);
    $('progress-bar').style.width = (total > 0 ? (done + failed) / total * 100 : 0) + '%';

    // 控制按钮
    $('btn-start').classList.toggle('hidden', state.status === 'running' || state.status === 'paused' || state.status === 'done');
    $('btn-pause').classList.toggle('hidden', state.status !== 'running');
    $('btn-resume').classList.toggle('hidden', state.status !== 'paused');

    // 视频列表（只显示最近的 30 个）
    const list = $('video-list');
    list.innerHTML = '';
    const items = state.queue.slice(0, 30);
    for (const v of items) {
      const [sLabel, sCls] = VIDEO_STATUS[v.status] || VIDEO_STATUS.pending;
      const waitInfo = v.status === 'watching' && v.waitMs
        ? '观看 ' + (v.waitMs / 1000).toFixed(0) + 's 后下载'
        : v.author + ' · ' + ((v.duration || 0) / 1000).toFixed(0) + 's';
      list.innerHTML += `
        <div class="video-item ${v.status}">
          <img class="video-thumb" src="${v.cover || ''}" onerror="this.style.display='none'">
          <div class="video-info">
            <div class="video-title">${escapeHtml(v.title)}</div>
            <div class="video-meta">${escapeHtml(waitInfo)}</div>
          </div>
          <span class="video-status ${sCls}">${sLabel}</span>
        </div>
      `;
    }
    if (state.queue.length > 30) {
      list.innerHTML += `<div style="text-align:center;color:#555;font-size:11px;padding:8px">还有 ${state.queue.length - 30} 个视频...</div>`;
    }
  } else {
    $('video-list').innerHTML = '<div style="text-align:center;color:#888;padding:20px 0;">队列为空<br>请在网页中向下滚动加载视频</div>';
  }

  // 显示错误提示
  if (state.error) {
    showToast(state.error);
    // 清除错误避免重复弹窗
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: { ...state, error: null } });
  }
}

// 按钮事件
$('btn-start').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CMD_START', fromStart: true });
});

$('btn-pause').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CMD_PAUSE' });
});

$('btn-resume').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CMD_RESUME' });
});

$('btn-rescan').addEventListener('click', () => {
  if (confirm('确认要清空所有待下载列表并重新扫描吗？')) {
    chrome.runtime.sendMessage({ type: 'CMD_SCAN' });
  }
});

// 接收状态更新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STATE_UPDATE') {
    updateUI(msg.state);
  }
});

// 初始化：获取当前状态
chrome.runtime.sendMessage({ type: 'CMD_GET_STATE' }, (resp) => {
  if (resp && resp.state) updateUI(resp.state);
});
