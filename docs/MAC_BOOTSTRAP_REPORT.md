# Mac 原生启动验收报告

验收日期：2026-10-23（Asia/Shanghai）。结论：**本机开发启动与基础界面 PASS；Electron 中豆包未登录页面网络检查 BLOCKED**。未登录账号、未创建或提交真实生成任务，未接入模型 API、Ollama 或豆包工作模式。

## 工作区与环境

沿用 `/Users/zarkding/Documents/doubao-studio`，origin 为 `dorakoo/doubao-studio`，`main` 分支，HEAD 为 `7eeb7b67a518e47ee4296c36e5c5f17942a9cff0`，与已审查 v2.3.8 一致。开始时仅 `main/main.ts` 有用户的 Mac 标题栏修改，原样保留，未切换分支、重新克隆、stash、reset、clean、commit、push 或创建 Release。

实机为 macOS 15.3.1 / Apple Silicon arm64，无 Rosetta。使用现有 nvm Node **24.15.0**、用户级独立 pnpm **11.0.0**、锁定 Electron **33.4.11**；`file` 确认 Electron 为 Mach-O arm64，实际 renderer UA 也报告 Electron/33.4.11。未用 Linux、云端或模拟产品界面代替验收。详细环境与变量存在性见 [MAC_ENVIRONMENT.md](MAC_ENVIRONMENT.md)。

## 最小改动

| 文件 | 必要性 |
| --- | --- |
| `scripts/dev.mjs` | 先编译 contracts，再编译主进程；Mac 默认显式传 `mac-dev`；传递诊断/profile 参数；只在 Electron GUI 子进程 env 副本删除 `ELECTRON_RUN_AS_NODE`；保留端口检测并传实际地址；Vite 异常、Electron 退出、Ctrl+C/SIGTERM 时只回收本轮持有的子进程，无自动重启循环 |
| `main/utils/developmentProfile.ts` | 在 ready、单实例锁、Session 和数据读取前设置 `userData` 与 `sessionData`；只允许未打包程序选择 `mac-dev` / `mac-test`，拒绝任意路径、重复参数、user-data-dir 覆盖及持久目录符号链接 |
| `main/main.ts` | 接入上述初始化；独立测试 profile 跳过生产历史缓存迁移；保留用户已有 Mac 原生标题栏改动及 Windows 分支 |
| `package.json` | 增加明确可重复的 `dev:mac` 启动命令，无依赖或版本升级 |
| `vite.config.ts` | 将独立 renderer 开发服务也限制到 `127.0.0.1` |
| `tests/unit/developmentProfile.test.ts` | 8 项 profile 边界测试，覆盖隔离、复用、临时目录、路径/参数拒绝、符号链接及默认行为不变 |
| `.gitignore` | 忽略整个 `artifacts/mac/`，日志、截图和验收材料不进入版本库 |
| `docs/MAC_ENVIRONMENT.md` | 一次性环境事实 |
| `docs/MAC_BOOTSTRAP_REPORT.md` | 本报告、启动步骤与实机证据 |
| `docs/MAC_BASELINE_STATUS.json` | 机器可读状态、版本、profile、进程与阻断 |

`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.npmrc`、CI、原有测试与检查门槛均未更改。`allowBuilds` 仍仅允许 electron/esbuild；未放行全部依赖脚本。

## 实际验证结果

| 项目 | 状态 | 实机证据 / 限制 |
| --- | --- | --- |
| frozen-lockfile 安装 | PASS | pnpm 11.0.0 安装及最终复核均成功，复用已有依赖与 Electron 二进制；不冒称重新下载了全部包 |
| Electron 二进制 / 架构 | PASS | 33.4.11，Mach-O arm64；开发 Node 为 darwin/arm64 |
| contracts 构建 | PASS | 单独构建通过；移走生成的 dist 和 tsbuildinfo 后，修复后的启动器重新生成声明并成功启动；备份已归档保存 |
| TypeScript | PASS | 主进程、renderer、tests 均通过现有 `ts-check` |
| ESLint | PASS | **0 errors / 原有 149 warnings**，阈值未放宽 |
| 项目 / IPC / contracts 工程规则 | PASS | 现有全部 fixture 和边界检查通过 |
| 单元测试 | PASS | **57 files / 1154 tests**（含新增 8 项 profile 边界测试） |
| 生产 build | PASS | Vite renderer 与主进程均成功；保留原有大于 500 kB chunk 提示 |
| Electron 主进程 / preload / renderer / IPC | PASS | 真实 Mac Electron 窗口内容截图；API 回读版本 2.3.8；`--local-control` health 的 ready/rendererReady 均为 true；renderer 无 `window.require` |
| GUI 环境变量隔离 | PASS | 首轮仅在启动子进程环境显式设置 `ELECTRON_RUN_AS_NODE=1`，仍正常创建 GUI；未修改全局环境 |
| 端口冲突 | PASS | 原有 5173 实例保留，本轮自动使用 **127.0.0.1:5174**，Electron 实际加载该地址 |
| 非空主界面 / 偏好设置 / 添加任务对话框 | PASS | 检查真实 DOM 与稳定动画后的截图，只打开与取消，未添加任务或保存设置 |
| 本地无账号 Webview | PASS | 临时非持久分区加载本机 HTTP fixture 并回读 `MAC_WEBVIEW_READY`；guest 的 require、process、宿主 electronAPI 均不可用；fixture 不替换产品页面，不计作平台加载成功 |
| 豆包未登录页 | **BLOCKED** | 同一测试 Webview 导航公开首页，Electron 报 **ERR_SOCKET_NOT_CONNECTED (-15)**，日志含 TLS/socket handshake 失败；同机 curl 返回 **HTTP 200 / SSL verify 0**。确切原因未确定，不能宣称豆包页面已通过验收 |
| 固定 mac-dev 退出后再次启动 | PASS | 两次 profile 路径完全一致，两次 renderer 均显示账号列表/任务调度，账号和任务数为零 |
| Vite 异常与安全停止 | PASS | 只终止本轮 Vite 后，启动器回收 Electron；另两轮对本轮 launcher 发送 SIGTERM；确认本轮 PID/子进程退出，5174/CDP 9334 关闭，原有 Studio 进程保持存活 |
| Windows 实机回归 | NOT TESTED | 本轮为 Mac 实机；原 Windows 分支与路径保持，现有跨平台测试通过 |
| 真实登录 / 平台生成 / Dola 全链 | NOT TESTED | 本轮明确不执行；Dola 仍未完成真实端到端验收 |

未发现新的上游类型、测试或生产构建失败。确认了基线开发启动器的 contracts 顺序缺陷：暂时移走已生成声明后，原主进程编译报 17 处 `@doubao-studio/contracts` 找不到（退出码 2），本轮已修复。

验收过程中另有两类本轮检查脚本问题，均保留日志并修正：Ant Design 的“取 消”空格与 modal 动画导致一次性控件定位/截图时机失败；临时备份 `.d.ts` 放入 artifacts 后被 ESLint 扫到 4 个生成文件错误，已将备份完整归档并重跑完整 validate，未改检查规则、源测试或警告上限。这些不归为上游应用失败。

## 数据与安全边界

由 Electron `app.getPath('appData')` 推导的固定开发目录：

```text
/Users/zarkding/Library/Application Support/DoubaoStudioDevelopment/mac-dev
```

`userData` 和 `sessionData` 均在此目录，开发重启复用；源码不硬编码用户绝对路径。账号 JSON 为空，未创建账号；未读取、复制或导出官方豆包、Chrome、原 Studio 的 Cookie 或浏览器资料。

自动化单独使用 `app.getPath('temp')` + `mkdtemp`：

```text
/var/folders/s7/pw20tfcx1b51dr2w_683mrcm0000gn/T/doubao-studio-mac-test-yyD5xN
```

临时 profile 留在本机，未清 Cookie、Local Storage、IndexedDB、钥匙串或其他应用数据。profile 单元测试仅清理其自己创建的临时文件夹。

检查了历史网络恢复：仅针对受限账号 partition 清 HTTP/DNS 缓存，但旧 junction 归档函数会跟随 realpath 目标，不能在本轮测试环境盲用。独立开发/测试 profile 跳过该生产迁移，Windows 正式路径逻辑保留；本轮未操作缓存迁移、系统代理、DNS、hosts 或 AmneziaVPN，也未关闭证书检查。

主 BrowserWindow 既有 `sandbox:false` 保留：这是基线的宿主 preload 配置，本轮未证明它必须关闭，后续安全评估应验证 preload 能否在 sandbox 下运行。`nodeIntegration:false`、`contextIsolation:true` 和默认 webSecurity 保持；测试 guest 无 Node/宿主 API。没有新增 `--no-sandbox`、证书忽略或远程页面 Node 权限。

按官方 [维护政策](https://www.electronjs.org/docs/latest/tutorial/electron-timelines) 和 [版本时间表](https://releases.electronjs.org/schedule)，Electron 33 已于 **2025-04-28** 结束维护。本轮成功仅表示隔离开发环境可启动，真实账号登录前须单独评估最小必要的安全升级并重新验证网页链路。

## 今后启动

在本机终端完整执行以下命令。固定使用已经安装的 Node/pnpm，不覆盖全局版本：

```bash
cd /Users/zarkding/Documents/doubao-studio
source "$HOME/.nvm/nvm.sh"
nvm use 24.15.0
export PATH="$HOME/.local/share/doubao-studio-tools/pnpm-11.0.0/node_modules/.bin:$PATH"
pnpm run dev:mac
```

需要重新安装依赖时，在同一目录和工具链下运行 `pnpm install --frozen-lockfile`；完整检查运行 `pnpm run validate`。普通启动不加 CDP/本机控制参数，CDP 默认关闭。不要直接运行 `electron .` 代替开发启动器，基线在未注入 Vite 地址时会显示开发诊断页。

在启动该命令的终端按 **Ctrl+C** 停止。Mac 关闭窗口按钮只关闭窗口，应用可能留在 Dock；可使用应用的正常退出操作，或根据当次 `[dev] launcher=...` 输出对该 **launcher PID** 执行 `kill -TERM <PID>`。不要按名称使用 `killall/pkill node/Electron`，也不要为腾出 5173 终止其他实例。

## 本轮进程与收尾

| 轮次 | launcher / Vite / Electron PID | 结束状态 |
| --- | --- | --- |
| 临时 mac-test + GUI/Webview 检查 | 10013 / 10016 / 10020 | 全部已停止，所有记录的后代也退出 |
| mac-dev 首次 / contracts 缺失重建 | 10162 / 10189 / 10197 | 模拟自有 Vite 退出后全部清理，无重启循环 |
| mac-dev 再次启动 | 10278 / 10286 / 10288 | 验证成功后 SIGTERM launcher，全部已停止 |

开始时已有的同项目 Vite **7471**、Electron **7474** 及其后代均保持存活（父 launcher 7470，未操作）。本轮新增常驻应用进程为 **0**，不承诺会话结束后维护任何进程。本轮使用的 5174 与 CDP 9334 已关闭。

## 证据与下一轮前置条件

详细日志、原始已有改动、版本信息与截图位于忽略的 `artifacts/mac/`，包括：`install.log`、`contracts-build.log`、`baseline-missing-contracts.log`、`validate.log`、`validate-artifact-layout-failure.log`、`validate-final.log`、`smoke-results.json`、`mac-dev-first.json`、`mac-dev-restart.json`、停止/异常清理 JSON，以及 `01-main-interface.png` 至 `07-mac-dev-restart.png`。截图来自这台 Mac 的实际隔离 Electron renderer，非浏览器模拟 UI；本地 fixture 清晰标注为测试页面，未用于替代豆包可达性验收。原生观察工具绑定到开始时已有的实例，因此未对那个实例执行 GUI 操作。

本轮到此停止。后续前置条件为：单独定位 Electron 33 的 TLS/socket 网络阻断；在真实账号登录前评估受支持 Electron 的必要安全升级及 sandbox 兼容性；网页能安全加载后再另行人工验收普通对话。未承诺 Dola、签名、安装包或任何后续业务功能完成。
