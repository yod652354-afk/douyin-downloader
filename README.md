# 抖音收藏下载器

Chrome 扩展，自动下载抖音收藏夹中的视频，模拟观看行为规避检测。

## 修复记录 (2026-05-19)

### 安全修复
1. **XSS 漏洞** — 视频标题通过 `innerHTML` 插入前增加 `escapeHtml()` 转义，防止恶意脚本注入
2. **消息来源验证** — `postMessage` 监听增加 `origin` 校验，仅接受 `https://www.douyin.com` 来源的消息

### 逻辑修复
3. **竞态条件** — `processQueue()` 入口增加状态守卫，防止快速多次点击导致并发下载循环
4. **数组副作用** — `bitrateList.sort()` 改为 `[...bitrateList].sort()`，避免修改原始响应数据
5. **按钮文案** — "重新扫描"确认对话框改为"清空所有待下载列表并重新扫描"，与实际行为一致

### 稳定性修复
6. **Fetch 超时** — 视频下载 fetch 增加 60 秒 `AbortController` 超时，防止连接卡住
7. **多余权限** — 移除未使用的 `webRequest` 和 `declarativeNetRequest` 权限声明

### 体验优化
8. **Toast 提示** — 错误提示从阻塞式 `alert()` 弹窗改为非阻塞 toast 通知

## 文件结构

```
manifest.json       # 扩展配置
background.js       # Service Worker: 下载队列管理
content_main.js     # MAIN world: fetch/XHR 拦截
content.js          # ISOLATED world: 消息桥接
popup/
  popup.html        # 弹出窗口 UI
  popup.js          # 弹出窗口逻辑
  popup.css         # 样式
```
