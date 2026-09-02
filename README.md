# 桌面日历小组件

> 基于 Electron 的桌面日历小组件，玻璃拟态风格，类似 macOS Widget / Win11 桌面便签。
> 数据用本地 SQLite 存储，纯离线可用，无云依赖。

## 功能

- **桌面小组件**：半透明无边框置顶窗口，可调透明度/宽高、置顶、鼠标穿透；
  支持**边缘/角落拖拽缩放**（无边框窗口无系统手柄，自实现 Pointer Capture 热区），
  松手后尺寸与位置自动落盘
- **月历视图**：含农历、节气、公历节日、农历节日（1900-2099）
- **待办清单**：常驻顶部，勾选即完成
- **日程管理**：点击日期添加/编辑/删除/完成，支持起止时间与颜色
- **重复日程**：每天 / 每周 / 每个工作日 / 每月 / 每年五种规则；
  月历与详情里带 ↻ 徽标；**完成状态按出现日独立记录**（9 月 3 日做完，9 月 4 日仍是未完成）；
  修改重复规则会重置其单次完成记录
- **可视化设置**：独立窗口，主题/尺寸/透明度/置顶/穿透/显示项一屏搞定
- **数据后端**：本地 SQLite（`node-sqlite3-wasm`，纯 WASM 零编译），配置存 JSON
- **托盘图标**：程序生成（无外部图片依赖），右键菜单控制显隐/穿透/置顶/退出
- **开机自启**：设置里勾选即可（`app.setLoginItemSettings`）
- **到点提醒**：带开始时间且未完成的日程到点弹系统通知，点击通知跳转对应日期
- **全局快捷键**：`Ctrl+Shift+C` 切换小组件显示
- **三套主题**：glacier（冰川）/ inkblot（墨迹）/ rose（玫瑰）

## 目录结构

```
desktop-calendar/
├── src/
│   ├── main.js          # 主进程：窗口 / 托盘 / IPC / SQLite / 提醒 / 自启
│   ├── preload.js       # 安全 IPC 桥（contextBridge）
│   ├── widget.html      # 桌面小组件页面
│   ├── widget.css       # 玻璃拟态样式 + 多主题
│   ├── widget.js        # 小组件主逻辑
│   ├── lunar.js         # 农历转换（1900-2099，无外部依赖）
│   ├── settings.html    # 设置窗口
│   ├── settings.css
│   └── settings.js      # 设置窗口逻辑
├── assets/              # 图标（由 scripts/gen-icon.js 生成）
│   ├── icon.png / icon.ico / tray.png
├── scripts/
│   ├── start.js         # 启动器（清掉 ELECTRON_RUN_AS_NODE 坑）
│   ├── gen-icon.js      # 纯 Node 生成 PNG + ICO 图标
│   ├── pack.js          # 离线打包（零下载，产出绿色 exe）
│   ├── repeat.test.js   # 重复规则单元测试（npm test）
│   ├── css-hidden.test.js # 静态检查：hidden 属性不被 CSS display 覆盖
│   ├── smoke-renderer.js # 渲染层冒烟测试（jsdom 模拟两窗口）
│   └── build.js         # electron-builder 打包（需联网）
├── dist/                # 打包产物（npm run pack 后生成）
└── package.json
```

## 快速开始

```bash
npm install
npm start
```

首次启动会自动创建数据库与配置：`%APPDATA%\desktop-calendar\`

## 下载 / 使用（给最终用户）

> 这个仓库本身**只放源代码**（`dist/` 打包产物被 .gitignore 排除，体积大不适合进 git）。
> 想直接拿到绿色版 exe，请走 **GitHub Releases**，不要 clone 本仓库。

### 从 Releases 下载

1. 打开仓库主页 → 点右侧 **Releases**（或 https://github.com/ljw1035/desktop-calendar/releases）
2. 找到最新版本，在 **Assets** 下下载 `desktop-calendar-win32-x64.zip`（约 106MB）
3. 解压后进入 `桌面日历-win32-x64/` 文件夹，**双击 `桌面日历.exe` 即可运行**，无需安装

> Windows SmartScreen 可能提示「Windows 保护你的电脑 / 未知发布者」——本应用未做代码签名。
> 点 **更多信息 → 仍要运行** 即可正常打开。

### 全新打包后如何发布新版本

```bash
npm run pack              # 生成 dist/桌面日历-win32-x64/
# 把该目录压成 zip（约 106MB），传到 GitHub Releases 作为新版本的 Assets
```

## 打包

### 方案 A：离线绿色包（推荐）

```bash
npm run pack
```

产出：`dist/桌面日历-win32-x64/桌面日历.exe`（约 259MB，**双击即用，无需安装**）。

原理：直接复用 `node_modules/electron/dist` 里已装好的运行时，把自己的代码放进
`resources/app`，**全程零网络请求**，不受 SSL 拦截影响。整个目录可随意移动，
压成 zip 即可分发。

### 方案 B：electron-builder 安装包装

```bash
npm run build          # portable 单文件
npm run build:dir      # 仅生成 win-unpacked 目录（更快，便于调试）
```

需要联网下载 electron / NSIS / winCodeSign 二进制。**若所在网络有 SSL 拦截，
会在下载阶段 `socket hang up` 失败** —— 此时请用方案 A。

## 交互速记

- **拖动**：按住日历空白处拖动
- **点击日期**：展开当日详情
- **右键日期**：快速添加日程
- **顶部 → ⚙**：打开设置窗口
- **顶部 → 🖱**：切换鼠标穿透（穿透后只能右键退出）
- **顶部 → ─**：隐藏小组件（保留在托盘）
- **顶部 → ✕**：关闭（保留在托盘）
- **托盘右键**：显示/隐藏、设置、穿透、置顶、退出
- **Ctrl+Shift+C**：全局切换小组件显示

## 数据存储位置

- 数据库：`%APPDATA%\desktop-calendar\calendar.db`
- 配置：`%APPDATA%\desktop-calendar\config.json`

备份/迁移只需拷贝这两个文件。设置窗口里有「打开数据目录」的等价操作，
也可执行 `npm run open-data-dir`。

## 已知限制

- 农历覆盖 1900-2099 年；节气日期有 ±1 天误差（日常使用足够）
- 离线绿色包未做代码签名，Windows SmartScreen 可能提示「未知发布者」，选「仍要运行」
- 离线包未用 rcedit 改写 exe 内嵌图标，因此**文件图标仍是 Electron 默认**；
  但窗口标题栏与任务栏显示的是我们自己的图标（`assets/icon.png`）
- 仅在 Windows x64 上验证；macOS / Linux 需相应调整打包脚本
- 提醒轮询间隔 30 秒，极端情况下通知可能延迟半分钟
