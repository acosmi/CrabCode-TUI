<p align="center">
  <img src=".github/assets/crab-code-logo.png" width="320" alt="CrabCode Logo">
</p>

<h1 align="center">CrabCode TUI</h1>

<p align="center">面向终端的开源编码智能体：Rust 原生界面，TypeScript 智能体运行时，隔离的 Go OAuth 账户桥。</p>

<p align="center"><a href="README.en.md">English</a> · <a href="https://github.com/acosmi/CrabCode-TUI/releases/latest">TUI 下载</a> · <a href="https://acosmi.com/zh/downloads">GUI 下载</a></p>

CrabCode TUI 是 CrabCode 的纯终端开源版本。Rust 进程独占终端、渲染和本地进程生命周期，直接拉起 TypeScript 业务运行时；需要账户 OAuth 登录时，再按需启动隔离的 Go Account Bridge。这里没有桌面/Web GUI、React/Ink 界面、AppServer、应用统一通信层、归档源码或内部项目方案。

## 安装

稳定版始终以 GitHub `latest` Release 的公开资产为准。普通安装不需要 GitHub CLI。每条命令只给**当前这台机器**装一份对应归档：不会一次装齐 macOS 与 Windows，也不会同时装 Apple Silicon 和 Intel。Release 里虽然同时放了三个平台的包，安装器每次只取本机那一份。

> `latest` 会随新版本变化，并会先执行远程 bootstrap。不设置 `CRABCODE_VERSION` 时，安装器从 `latest` 的 `checksums-sha256.txt` 自动解析当前平台的唯一归档，不再请求 `api.github.com`。需要钉死版本时，请使用下方的 `CRABCODE_VERSION` 或离线资产模式。

macOS（`uname -m` 自动选择：Apple Silicon → `arm64-darwin`，Intel → `x64-darwin`）：

```bash
curl -fsSL https://github.com/acosmi/CrabCode-TUI/releases/latest/download/install.sh | sh
```

Windows x64（Windows PowerShell 5.1 或 PowerShell 7）：

```powershell
irm https://github.com/acosmi/CrabCode-TUI/releases/latest/download/install.ps1 | iex
```

Linux 当前没有 GitHub Release 安装包，请从源码构建。`install.ps1` 以无 BOM 的可打印七位 ASCII 发布，避免 GitHub 以 `application/octet-stream` 返回脚本时，`irm | iex` 把首行注释解码成可执行的 `ï»¿#` 标记。

安装器会校验发布级 SHA-256 和包内逐文件 manifest。Windows ZIP 还可运行 `gh attestation verify <ZIP路径> --repo acosmi/CrabCode-TUI` 验证 GitHub build provenance；macOS 包使用 Release 中的 `macos-local-provenance.json` 及其 SSH 签名，不提供 GitHub attestation。正式包仅提供 macOS arm64、macOS x64 和 Windows x64，并内含 `crabcode`、原生 TUI、Bun、Memory/cron 侧车、ripgrep、浏览器后端、图像原生库和 Account Bridge。

### 安装变量

macOS 的 `install.sh` 与 Windows 的 `install.ps1` 都支持以下环境变量。操作系统与 CPU 架构没有对应变量，一律由本机自动识别。

| 变量 | 作用 | 默认值 / 约束 |
| --- | --- | --- |
| `CRABCODE_VERSION` | 固定安装版本，可写 `1.0.36` 或 `v1.0.36` | 未设置时从 `latest` 的校验清单自动选择当前平台那一条归档 |
| `CRABCODE_ASSET_DIR` | 从已下载资产离线安装 | 必须是绝对路径，并同时设置 `CRABCODE_VERSION`；目录需包含对应平台归档和 `checksums-sha256.txt` |
| `CRABCODE_BIN_DIR` | 放置稳定启动器 `crabcode` / `crabcode.exe` | macOS：`~/.local/bin`；Windows：`%USERPROFILE%\.crabcode\bin`；自定义时使用绝对路径 |
| `XDG_DATA_HOME` | 保存不可变版本目录 | macOS：`$HOME/.local/share`；Windows：`%USERPROFILE%\.local\share`；自定义时使用绝对路径 |

固定版本在线安装（以 `1.0.36` 为例）：

```bash
curl -fsSL https://github.com/acosmi/CrabCode-TUI/releases/download/v1.0.36/install.sh -o /tmp/crabcode-install.sh
CRABCODE_VERSION=1.0.36 sh /tmp/crabcode-install.sh
```

```powershell
$env:CRABCODE_VERSION = '1.0.36'
irm https://github.com/acosmi/CrabCode-TUI/releases/download/v1.0.36/install.ps1 | iex
Remove-Item Env:CRABCODE_VERSION
```

离线安装时，把安装器、对应平台归档和 `checksums-sha256.txt` 放进同一目录：

```bash
CRABCODE_VERSION=1.0.36 CRABCODE_ASSET_DIR=/绝对路径/CrabCode安装资产 sh /绝对路径/CrabCode安装资产/install.sh
```

```powershell
$env:CRABCODE_VERSION='1.0.36'; $env:CRABCODE_ASSET_DIR='C:\CrabCode安装资产'; & "$env:CRABCODE_ASSET_DIR\install.ps1"
```

离线模式不会访问网络，CPU 架构由安装器自动识别。`CRABCODE_CONFIG_DIR` 不是安装位置变量，它只用于隔离安装后的运行时配置和会话。

开源 TUI 与 GUI 的程序、安装目录和发布链完全分离。为避免同机测试或多产品复用默认 `~/.crabcode` 状态根，隔离运行时显式设置绝对路径 `CRABCODE_CONFIG_DIR`；该变量同时约束 Rust、TypeScript、memory、cron 与 renderer diagnostics。升级版继续保留默认状态位置，避免破坏既有 TUI 会话与配置。

### GUI（独立产品，不在本仓库开源）

需要桌面图形界面时，请从 [CrabCode GUI 官方下载页](https://acosmi.com/zh/downloads) 获取。GUI 的源码、构建工程、应用通信实现和安装包不属于本仓库，也不会以隐藏目录、归档文件或历史分支的方式混入纯 TUI 开源边界。

## 账户、GO 会员与模型

安装后可通过账户入口完成 OAuth 登录，第三方模型账户的支持范围和操作方式见[Go OAuth 账户桥](#go-oauth-账户桥能力支持账户与用法)。注册账户即赠送 **6 个月 GO 订阅会员**；邀请好友可获得**重置次数**。GO 会员当前可使用 **DeepSeek-V4、Mino、Qwen 3.7 快速版**。

这里的 **GO 是 CrabCode 的产品会员名称，不是 Go 编程语言**。赠送资格、可用地区、模型上下线、额度、重置规则和服务条款以登录时的线上服务实际展示为准；仓库的 MIT 源码许可证不授予订阅、模型额度、第三方 API、托管服务或商标权益。

## 当前架构

| 层 | 当前实现 | 职责 |
| --- | --- | --- |
| 核心底层 | Rust | 终端所有权、输入/渲染、启动器、进程监督、沙箱基础、记忆、搜索、定时任务及本地生命周期 |
| 业务层 | TypeScript | 智能体编排、会话、工具调用、权限决策、模型与账户业务逻辑；编译为单一 TUI 运行时 bundle |
| 账户接入 | Go | 独立、loopback-only 的 Account Bridge，处理 OAuth 凭据与提供方协议；不通过 FFI 嵌入 Rust/TS 进程 |

```text
Terminal
  └─ Rust crabcode launcher / native TUI
       ├─ Rust memory, search and cron sidecars
       └─ private structured stdio
            └─ TypeScript agent runtime (bundled Bun)
                 └─ Go Account Bridge（仅在 OAuth 账户流程需要时）
```

Rust TUI 与 TypeScript 之间使用进程私有的结构化标准输入/输出协议，不经过 GUI/AppServer 或所谓“统一应用通信层”。Account Bridge 只监听受限回环地址，发布包会在登录前验证其版本、平台、来源签名、插件、SBOM 和第三方许可材料。

## Go OAuth 账户桥：能力、支持账户与用法

`components/oauthapi-llm` 不是需要用户单独部署的远程 Go 服务，也不是把上游管理 API 原样暴露出来的通用代理。它是 CrabCode 发布包内置、按需启动、仅绑定受限 loopback 的私有侧车，负责：

- 发起浏览器 OAuth 或设备码授权，并由 TUI 自动轮询登录结果；
- 在 Rust/TypeScript 进程之外加密保存 OAuth 凭据，刷新并隔离提供方 token；
- 发现已连接账户、可用模型和每个“账户 × 模型”的固定不透明路由；
- 把 CrabCode 使用的 Claude Messages 请求边界转换为各提供方协议，并按模型元数据公开工具调用、思考、视觉、JSON、上下文窗口等能力；
- 在每轮调用前重新校验连接器、账户、路由、模型能力、冷却和配额状态；在提供方支持时展示用量窗口与重置时间；
- 支持连接多个账户、选择账户模型路由、刷新状态以及移除本地授权。

当前 CrabCode Account Bridge 的固定连接器如下。这里列的是**账户 OAuth/设备码登录**，不是 API Key 接入；具体模型与额度由当前发布版适配、对应账户方案及提供方状态共同决定，以 TUI 实际显示为准。

| TUI 入口 | 登录的账户 | 授权方式 | Go 内部提供方 |
| --- | --- | --- | --- |
| OpenAI | 具有 Codex 使用资格的 OpenAI / ChatGPT 账户 | 浏览器 OAuth | `codex` |
| Anthropic | Claude 账户 | 浏览器 OAuth | `claude` |
| Google | 可用于 Gemini CLI 的 Google 账户；通过固定、已验证插件接入 | 浏览器 OAuth | `gemini-cli` |
| xAI | Grok / xAI 账户 | 设备码：打开验证页并输入 TUI 显示的代码 | `xai` |
| Qwen Code | Qwen Code 账户 | 设备码 | `qwen` |
| Kimi Code | Kimi Code 账户 | 设备码 | `kimi` |
| Z Code | Z.AI Coding Plan 账户 | 设备码 | `zai` |

使用步骤：

1. 启动 `crabcode`，在对话输入框执行 `/model manage`。
2. 选择“本地账户接入”→“启动账户运行环境”（尚未就绪时）→“连接账户”。首次使用可能需要同意地区资格检测。
3. 选择连接器。浏览器 OAuth 会打开授权页；设备码流程会同时显示验证地址、设备代码和过期时间。
4. 在浏览器完成授权并返回 TUI；面板会自动轮询。成功后选择带有连接器、账户和用量信息的模型路由，即可设为当前模型。
5. 回到同一页面可刷新账户/用量/路由，或移除账户及其本地加密凭据。

连接器是否可点选还取决于签名连接器目录、当前地区、条款状态、真实账户一致性验证及固定发行工件；不可用项会留在列表中并显示禁用原因。API Key 或自定义兼容端点应走“自定义模型”，不属于 Account Bridge。

CrabCode 发行版有意禁用了上游的直接凭据命令和公开管理面：不要运行 `oauthapi-llm --codex-login` 等上游参数，不要直接调用其进程私有接口，也不要把回环端口暴露到局域网或公网。需要独立、自托管的通用代理时，请直接使用上游 CLIProxyAPI，而不是把 CrabCode 侧车当作其可替代发行版。

## OAuth 上游来源与差异

账户接入侧车 `components/oauthapi-llm` 基于 MIT 许可的 [`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI) 二次开发，固定来源为 [`v7.2.71`](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.71) / commit [`5b7f2361ee27d195f6514dde08656f6e4773a9a4`](https://github.com/router-for-me/CLIProxyAPI/commit/5b7f2361ee27d195f6514dde08656f6e4773a9a4)。感谢原项目及其贡献者为 OAuth 登录与提供方协议适配打下基础。

上游固定版本将自身定位为面向 CLI 的 OpenAI/Gemini/Claude/Codex/Grok 兼容代理，并提供 OAuth、多账户和协议转换能力，详见其 [`v7.2.71 README`](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.71/README.md)。CrabCode 只复用了并加固其中与上述固定账户桥有关的能力；上游的通用 API Key 提供方、公开兼容代理、远程管理、任意插件和直接 CLI 登录方式不属于 CrabCode 的公开运行面。

CrabCode 的改动包括白标、回环面收敛、固定账户路由、地区/连接器策略验证、凭据加固、固定插件及发行验证。该衍生组件不是 Router-For.ME 官方发行版，也不代表任何模型服务商背书。完整来源、修改说明和许可证见 [`components/oauthapi-llm/NOTICE`](components/oauthapi-llm/NOTICE)、[`UPSTREAM.lock`](components/oauthapi-llm/UPSTREAM.lock) 与 [`LICENSE`](components/oauthapi-llm/LICENSE)。

## 全仓 Rust 目标

维护者的长期目标是让产品运行时最终实现为**全仓 Rust**。现阶段不是“已经全 Rust”：核心底层已是 Rust，业务层仍为 TypeScript，OAuth 账户桥仍为 Go。

迁移遵循这些原则：

- 新增底层、跨层协议和高可靠能力优先用 Rust；
- 先固定行为、协议、状态机与安全边界，再逐段替换 TypeScript/Go 实现；
- OAuth 迁移必须在凭据隔离、提供方兼容、签名验证和故障恢复达到同等或更高水平后进行；
- 只有功能等价、回归测试和回滚路径均完成，才会移除 Bun 或 Go 运行依赖。

因此当前 TypeScript 与 Go 代码是受支持的正式过渡实现，不是归档代码；路线目标也不会被误写成当前事实。

迁移不是按文件机械重写，而是按已经冻结的行为边界交付。当前 TypeScript→Rust 实现登记如下：

| 行为边界 | TypeScript 权威 | Rust 等价实现/迁移落点 |
| --- | --- | --- |
| StructuredIO、进程、背压、关联请求、关闭 | `src/entrypoints/sdk`、`src/cli/structuredIO.ts` | `crates/crabcode-tui/src/sdk_runtime.rs`、`runtime_host.rs` |
| 消息、流事件、进度、附件、结果投影 | `src/types`、`src/Tool.ts` | `sdk_projection.rs`、`scrollback_projection.rs`、`agent_view.rs` |
| 启动、工作区信任、引导与会话选择 | `src/cli/crabcodeTuiBridgeProtocol.ts` | `tui_app.rs`、`session_picker.rs`、`terminal.rs` |
| 模型、账户、用量、插件与保留命令 | `src/cli/directTui*Actions.ts` | `sdk_runtime.rs`、`model_management.rs`、`usage_plugin_management.rs`、`retained_command_surface.rs` |
| 终端输入、绘制、暂停恢复与退出 | TS 只提供业务事件 | `app_event_loop.rs`、`terminal.rs`、`tui_app.rs`、`tui_ui.rs` |

`bun run check:capabilities` 使用 TypeScript 编译器展开当前公共与进程私有联合类型，生成 `crates/crabcode-tui/src/generated_renderer_contract.rs`。每个协议族都记录明确的 `rustOwner`；TS 新增分支而 Rust 尚未认领时，检查或原生测试会失败，避免迁移期间出现静默能力漂移。

## 仓库包含什么

| 模块 | 源码位置 |
| --- | --- |
| 原生终端界面与纯 TUI 启动器 | `crates/crabcode-tui`、`crates/crabcode-cli` |
| 智能体与工具直连运行时 | `src`，唯一入口为 `src/entrypoints/tuiRuntime.ts` |
| 定时任务侧车 | `crates/crabcode-cron` 及其 Rust 依赖闭包 |
| 记忆与搜索 | `libs/acosmi-memory`、`libs/acosmi-se` |
| OAuth Account Bridge | `components/oauthapi-llm` |
| 修订/固定的终端、图表和平台依赖 | `third_party` 与相关渲染 crate |
| 构建、验证和发行 | `scripts`、`.github/workflows` |

`bun run check:boundary` 会失败关闭地拒绝 GUI/AppServer/Ink 路径、额外 crate/脚本/工作流、不可达 TypeScript 源码、归档与二进制工件、内部计划和 `AGENTS.md`/`CLAUDE.md` 等项目指令文件。

## 从源码构建

预编译包的普通用户不需要以下工具。源码开发需要 Bun 1.3.11+、Rust 1.92+、`components/oauthapi-llm/go.mod` 指定的 Go 版本和 Git：

```bash
git clone https://github.com/acosmi/CrabCode-TUI.git
cd CrabCode-TUI
bun install --frozen-lockfile
bun run build
```

也可以分别构建：

```bash
bun run build:ts
bun run build:rust
bun run build:memory
bun run build:account-bridge
```

开发态启动方式：

```bash
bun run build:ts
CRABCODE_TUI_RUNTIME_SCRIPT="$PWD/dist/tui-runtime/index.js" \
CRABCODE_TUI_BUN="$(command -v bun)" \
cargo run --manifest-path crates/Cargo.toml \
  -p crabcode-tui --features terminal-lifecycle-tests
```

正式启动器只接受同一不可变版本目录中的闭合运行时布局；上面的环境变量仅在测试/开发 feature 下生效。

## 验证

```bash
bun run check
bun run test
bun run test:rust
bun run test:memory
bun run test:search
bun run test:account-bridge
bun run smoke:tui
```

`bun run ci` 执行完整本地校验。预发 CI 会在 macOS arm64、原生 macOS x64 与 Windows x64 构建并回放同一提交的候选包；签名 tag 工作流会重新构建 Windows x64 并生成 GitHub build provenance。正式 macOS 包使用独立的双次装配、回放与 SSH 签名本地构建来源证明；除 `checksums-sha256.txt` 本身外，公开资产均由该 SHA-256 清单约束。

## 开源与许可证

CrabCode TUI 原创代码采用 [MIT License](LICENSE)。仓库内的衍生与 vendored 组件继续适用其各自的 Apache-2.0、MIT 或其他许可证；发布包内附精确依赖版本的许可材料和来源清单。详见 [开源范围与许可证说明](OPEN_SOURCE.zh-CN.md)、[第三方声明](THIRD_PARTY_NOTICES.md)、[贡献指南](CONTRIBUTING.zh-CN.md) 与 [安全策略](SECURITY.zh-CN.md)。
