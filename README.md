# 抖音收藏下载器

Chrome 扩展，自动下载抖音收藏夹和喜欢列表中的视频，模拟观看行为规避检测。支持按视频描述分文件夹存储，并自动保存点赞前 3 的热门评论截图。

## 功能特性

### 核心功能
- **自动抓取** — 拦截 `fetch`/`XHR` 请求，自动捕获收藏页和喜欢页加载的视频数据
- **自动下载** — 模拟观看延迟后自动批量下载视频
- **评论截图** — 每个视频下载后自动获取点赞 Top 3 评论，渲染为 PNG 截图保存
- **分文件夹** — 视频按描述文字分文件夹存储，评论截图保存在对应文件夹
- **自定目录** — 支持在 popup 中自定义下载根目录名称
- **下载重试** — 视频下载失败自动重试 2 次，截图失败重试 1 次
- **运行日志** — popup 底部实时日志面板，诊断运行状态
- **暂停续传** — 支持暂停/继续下载队列

### 反爬机制
- 使用页面 MAIN world 代理请求评论 API，携带 `msToken` 等反爬参数
- 视频下载通过 content script 的 blob fetch 获取，自动携带 cookie 和 Referer
- 模拟观看等待（视频时长的 30%~50%，最长 30 秒），间隔随机 2~5 秒

## 文件结构

```
抖音收藏下载器/
├── manifest.json          # Chrome 扩展配置 (Manifest V3)
├── background.js          # Service Worker: 下载队列管理、状态机、重试逻辑
├── content_main.js        # MAIN world: fetch/XHR 拦截、参数缓存、API 代理
├── content.js             # ISOLATED world: 消息桥接、视频 blob 下载、Canvas 渲染
├── popup/
│   ├── popup.html         # 弹出窗口 UI
│   ├── popup.js           # 弹出窗口逻辑、状态渲染、日志显示
│   └── popup.css          # 深色主题样式
├── .gitignore
└── README.md
```

## 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                   抖音收藏页 (douyin.com)                 │
│                                                         │
│  ┌──────────────┐    postMessage    ┌──────────────┐   │
│  │content_main.js│ ◄──────────────► │  content.js   │   │
│  │  (MAIN world) │                  │(ISOLATED world)│   │
│  │              │                  │              │   │
│  │ • 拦截XHR    │                  │ • 消息桥接    │   │
│  │ • 拦截fetch  │                  │ • Blob下载    │   │
│  │ • 缓存token  │                  │ • Canvas渲染  │   │
│  │ • API代理    │                  │ • 日志转发    │   │
│  └──────────────┘                  └──────┬───────┘   │
│                                           │            │
└───────────────────────────────────────────┼────────────┘
                                            │ chrome.runtime
                                            │ sendMessage
┌───────────────────────────────────────────┼────────────┐
│                          Service Worker   │            │
│  ┌────────────────────────────────────────┴──────────┐ │
│  │                 background.js                      │ │
│  │                                                    │ │
│  │  • 下载队列管理  • 状态机 (idle→running→done)      │ │
│  │  • 模拟观看计时  • 下载重试(最多3次)               │ │
│  │  • chrome.downloads API 下载                       │ │
│  │  • 日志系统 (200条上限)                            │ │
│  └───────────────────────────────────────────────────┘ │
│                                           │            │
│                          STATE_UPDATE     │            │
│                                           ▼            │
│  ┌───────────────────────────────────────────────────┐ │
│  │                 popup/ (UI)                        │ │
│  │  • 状态标签 • 队列进度条 • 视频列表(30条)          │ │
│  │  • 控制按钮 • 目录配置   • 日志面板               │ │
│  └───────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 数据流

### 视频下载流程
```
用户滚动收藏页
  → content_main.js 拦截 XHR/fetch API 响应
  → 提取视频数据 (id, title, url, duration, cover)
  → postMessage 到 content.js
  → chrome.runtime.sendMessage 到 background.js
  → 加入下载队列

用户点击「开始」
  → processQueue() 逐个处理
  → 模拟观看等待 (视频时长30%~50%)
  → DOWNLOAD_BLOB 指令 → content.js
  → content.js: fetch(video.url) → blob → base64
  → SAVE_VIDEO_BLOB 消息 → background.js
  → chrome.downloads.download → 文件保存
  → 失败则自动重试 (最多3次)
```

### 评论截图流程
```
视频下载成功后
  → CAPTURE_COMMENTS 指令 → content.js
  → postMessage FETCH_COMMENTS_API → content_main.js
  → content_main.js: window.fetch(评论API, 带msToken/webid)
  → 返回评论数据 → 按 digg_count 排序取 Top 3
  → 头像预加载为 data URL
  → Canvas 2D 渲染评论卡片 (480xN px)
  → canvas.toBlob('image/png')
  → FileReader → base64 dataUrl
  → background.js: chrome.downloads.download → 保存
  → 失败则自动重试 (最多2次)
```

## 目录结构

```
Chrome 默认下载目录/
└── 抖音下载/                          ← 自定义根目录名
    ├── 猫咪国服兰陵王_76412188/       ← {视频描述}_{awemeID前8位}
    │   ├── 猫咪：国服兰陵王...mp4      ← 视频文件
    │   └── 评论截图.png               ← Top3评论截图
    └── 天下武功唯快不破_76408109/
        ├── 天下武功，唯快不破...mp4
        └── 评论截图.png
```

## 安装使用

### 1. 加载扩展
1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择项目文件夹

### 2. 使用
1. 打开抖音收藏页：`https://www.douyin.com/user/self?showTab=favorite_collection`
2. 向下滚动网页加载视频（扩展会自动抓取）
3. 点击扩展图标 → 设置下载目录名 → 点击「开始」
4. 观察日志面板确认下载进度

### 3. 调试
- 页面控制台 (F12) — content script 日志
- 扩展 Service Worker 控制台 (`chrome://extensions` → 检查视图) — background 日志
- Popup 日志面板 — 运行状态概览

## 权限说明

| 权限 | 用途 |
|---|---|
| `downloads` | 调用 Chrome 下载 API 保存视频和截图 |
| `storage` | 持久化下载目录名设置 |
| `tabs` | 查找抖音页面发送下载指令 |
| `scripting` | 注入 content script |
| `*.douyin.com/*` | 拦截抖音 API 请求 |
| `*.douyinvod.com/*` | 视频 CDN 下载 |
| `*.douyinpic.com/*` | 评论头像图片加载 |

## 技术要点

- **Manifest V3** Service Worker 架构
- **双世界注入**：MAIN world 拦截页面请求，ISOLATED world 桥接通信
- **Canvas 2D** 渲染评论截图（避免 SVG foreignObject 的 Canvas 污染问题）
- **base64 传输**：视频 blob 通过 base64 编码传输给 background（33% 开销）
- **反爬参数缓存**：从页面真实请求中提取 `msToken`、`webid` 等参数复用
