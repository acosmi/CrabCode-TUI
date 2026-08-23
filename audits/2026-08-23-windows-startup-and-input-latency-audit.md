# CrabCode TUI Windows 启动慢 / 输入延迟 / 命令重复显示 根因审计与实施方案

- 审计日期：2026-08-23（America/Los_Angeles，机器时区 UTC-7）
- 审计版本：本地分支 `fix/shell-progress-tail-window`（已 rebase 到 `origin/main` = `050b53d`）
- 复现环境：Windows 11 Home China 26200，安装根 `C:\Users\fushihua\.local\share\crabcode\versions\1.0.36`，`bun 1.3.14`
- 对照环境：用户报告 macOS 同版本几乎无延迟
- 审计状态：五个 P0 根因全部实测确认，均给出唯一决定的修法；无待决项

---

## 一、结论摘要

三个症状对应五个互相独立的根因，其中两个是 Windows 专有放大，三个是跨平台逻辑缺陷。

| 症状 | 根因 | 平台 | 实测量级 |
|---|---|---|---|
| 输入/插入/命令延迟 5–20 秒 | **P0-1** 渲染器诊断日志在 UI 线程上「每个流事件一次 open/stat/write/close」 | Windows 专有放大 37× | 单会话 39,365 事件 × 1.675 ms ≈ **66 秒**阻塞 I/O |
| 启动约 30 秒 | **P0-2** 启动期完整插件/技能发现被执行两遍，第二遍独占 JS 单线程 | 跨平台，Windows 放大 5–8× | 第二遍 **20–70 秒**，期间不处理用户输入 |
| 启动约 30 秒 | **P0-3** marketplace 跨进程锁按「每插件一次」获取，饥饿后静默丢插件 | 跨平台，Windows 放大 | 单次饥饿 **6.4–7.9 秒**，实测丢 3 个插件 |
| 命令面板抖动/重排 | **P0-4** 命令目录被算两遍、发两遍，两次内容完全相同只是顺序不同 | 跨平台 | 两次 143,586 B，410 条完全相同，21 个位置顺序不同 |
| **一个命令在终端有 2 个** | **P0-5** 命令别名被当成独立命令下发，面板里同一命令出现 2–3 行 | **跨平台（Mac/Win 都有）** | `clear\|reset\|new`、`compact\|com` 等，多出 5 行 |

用户描述的「命令重复是全局 mac 和 win 都有」与 P0-5 完全吻合：它是纯投影逻辑缺陷，与平台无关。而「慢只在 Windows」与 P0-1/P0-2/P0-3 完全吻合：这三条的共同物理原因是 **Windows 每次文件元数据/句柄操作要穿过过滤驱动栈（Defender 等），单次 0.3–2 ms；macOS APFS 同样操作 10–30 µs**。凡是把「每事件一次系统调用」或「每插件一次锁」写进热路径的代码，在 macOS 上不可见，在 Windows 上就是数十秒。

---

## 二、证据等级与量化方法

- **直接实测**：用探针进程按真实协议驱动 `dist/tui-runtime/index.js`（真实用户配置目录，非临时配置），逐帧打时间戳；用 `DEBUG=1 CRABCODE_DEBUG_LOG_LEVEL=verbose` 取得 712 行带时间戳的启动日志；用 Node 复刻 Rust 的精确系统调用序列做微基准。
- **源码确认**：每条根因都定位到具体文件与函数。
- **推断**：macOS 侧数字为对照推断（未在本机执行），已在正文中标注。

### 2.1 关键实测数据

```
bun.exe --version                                    75 ms
bun -e 'process.exit(0)'                            104 ms
bootstrap → 首个 renderer_context setup 请求        5.8 s（最好）/ 9.7–13.0 s（常见）
initialize 往返                                     12.2 s（最少争用）/ 57 s / 77 s（有争用）
第二次 command_catalog_changed                      首次之后 +20 s / +33 s / +72 s
用户在 +18.4 s 提交的命令，运行时到 +51.1 s 才处理   停顿 32.7 s
进程链 shim→launcher→crabcode-tui.exe→bun.exe       21:49:08→09→10→12，共 4 s
```

### 2.2 Windows 文件系统微基准（本机实测）

```
Rust 现行序列 lstat+stat+open+fstat+write+close      1675 µs/次
常驻句柄 + 缓冲追加                                    45 µs/次
                                                    → 37 倍
锁周期 mkdir+stat+utimes+rmdir                       1.24 ms/次
marketplace.json (103,615 B) 读+解析+sha256           2.5 ms/次
插件缓存树遍历（17,115 目录 / 24,453 文件）           1.80 s 冷 / 1.93 s 热（Windows 无热加速）
读全部 14,422 个 .md（81.7 MB）                       2.61 s（181 µs/文件）
```

「热遍历不比冷遍历快」这一条本身就是 Windows 元数据路径必然穿过过滤驱动的直接证据。

---

## 三、逐项根因

### P0-1 渲染器诊断日志在 UI 线程上逐事件同步写盘

**位置**：`crates/crabcode-tui/src/renderer_diagnostics.rs`
- `append_bounded_json_line()`（第 410 行）
- 调用链：`sdk_projection.rs:1451 record_envelope()` ← `lib.rs:1469 drain_runtime_events()`（**单一 UI 线程**）

**现行行为**：每一个 `RawEnvelope` 都执行

1. `reject_unsafe_file()` → `fs::symlink_metadata`
2. `fs::metadata(path)`（判断是否需要滚动）
3. `OpenOptions::open(path)`
4. `enforce_private_file()` → `file.metadata()`
5. `write_all` + `flush`
6. 句柄析构 → `CloseHandle`

外加每条记录一次 `canonical_type_shape` 序列化 + `Sha256::digest`。

**为什么默认就在跑**：`lib.rs:204` 无条件 `RendererDiagnostics::from_state_root(...)`，`new()` 总是构造 `Some(sink)`。模块注释明写「Metadata is recorded by default」。没有开关。

**量级**：本机 `~/.crabcode/debug/tui-renderer-metadata.jsonl` 记录到 `sequence` 0–39,365，其中 97%（4,933/5,071 现存行）是 `content_block_delta`——即**每个流式 token 一次完整的文件开闭**。
`39,365 × 1.675 ms ≈ 66 秒`纯阻塞 I/O，全部落在拥有键盘输入的那条线程上。
macOS 同样次数 ≈ 1.8 秒，分摊到数小时，不可见。（推断）

**这就是「打字、插入、命令都要等 5–20 秒」的直接机制**：`drain_runtime_events` 每处理一个事件就同步等 1.7 ms，一次回答的几千个 delta 就是几秒钟；输入抢占只能保证不被单个事件饿死，救不了整体节拍。

**决定的修法**（三项全做，无可选项）：

1. `DiagnosticSink` 持有一个进程生命周期内常驻的 `BufWriter<File>`；`record()` 只做 `write_all`，不再 stat/open/close。安全校验（symlink/regular-file）在**打开时做一次**。
2. 把写入移出 UI 线程：`RendererDiagnostics` 内部换成 `std::sync::mpsc::SyncSender<Vec<u8>>`（容量 4096）+ 一条专用写线程；发送用 `try_send`，队列满时丢弃并把丢弃计数累加到下一条记录的新字段 `dropped_since_last`。诊断永远不得阻塞渲染。
3. 滚动改为轮换：达到 `MAX_JOURNAL_BYTES` 时 `rename` 成 `tui-renderer-metadata.1.jsonl` 再新建，保留 1 代；现行 `options.truncate(true)` 会把整段历史直接丢掉，与「可回放」的设计目的自相矛盾。

**验收**：
- 新增 Rust 测试：连续 `record_envelope` 10,000 次，断言 UI 线程侧耗时 < 200 ms（现行本机 ≈ 16.7 s）。
- 新增测试：写线程阻塞时主线程 `record_envelope` 不阻塞，且 `dropped_since_last` 正确累加。
- 新增测试：超过上限后 `.1.jsonl` 存在且旧记录可读。

---

### P0-2 启动期完整插件/技能发现执行两遍

**位置**：`src/cli/print/queryExecutionCore.ts:3096-3103`

```ts
void installPluginsAndApplyMcpInBackground()
  .then(() => refreshPluginState())
  .catch(error => logError(error))
```

`refreshPluginState()` → `refreshActivePlugins()`（`src/utils/plugins/refresh.ts:72`）第一件事就是 `clearAllCaches()` + `clearPluginCacheExclusions()`，然后重新 `loadAllPlugins()` / `getPluginCommands()` / `getAgentDefinitionsWithOverrides()`，再 `commandCatalogLifecycle.refresh(commandLoader)`。

**证据**（同一次启动的 debug 日志）：

```
+53947  Found 73 plugins (73 enabled, 0 disabled)
+55518  Total plugin skills loaded: 262
+71914  Found 76 plugins (76 enabled, 0 disabled)     ← 第二遍完整重扫
+84614  Initialized versioned plugins system with 76 plugins
```

**量级**：本机插件缓存 76 个插件 / 17,115 目录 / 24,453 文件 / 14,422 个 .md。一遍发现 ≈ 树遍历 1.9 s + 读 md 2.6 s + 解析/去重/投影，实测两遍之间相隔 18 秒。第二遍期间 JS 单线程被同步 FS 调用占满，**运行时完全不处理用户输入**——实测 +18.4 s 提交的命令到 +51.1 s 才被处理。

**根本问题**：这是无条件的第二遍。绝大多数启动里磁盘上的插件集合与第一遍完全一致（P0-4 的实测证明了这一点：两次目录内容逐条相同）。

**决定的修法**：

1. 在 `refreshPluginState()` 入口加一个**发现指纹**：`installed_plugins.json` 的 `(mtimeMs, size)` + `known_marketplaces.json` 的 `(mtimeMs, size)` + 参与合并的各层 `settings.json` 的 `(mtimeMs, size)`，拼成字符串。第一遍结束时记录；第二遍开始时比对，**相同则整体跳过**（不调 `clearAllCaches()`，不重扫，不重发目录）。
2. `installPluginsForHeadless()` 若报告「本次没有安装/卸载任何插件」，直接不排 `refreshPluginState()`。指纹是第二道防线，用于 settings 在启动窗口内被改写的情况。
3. 插件遍历循环里每处理 8 个插件 `await new Promise(r => setImmediate(r))` 一次，把事件循环让出来，使得即便必须重扫，用户输入也能被及时处理。

**验收**：
- 新增单测：磁盘无变化时 `refreshPluginState()` 不调用 `clearAllCaches()`、不产生第二次 `commandCatalogPublisher.update()`。
- 新增单测：`installed_plugins.json` mtime 变化时仍然重扫。
- 手工验收：启动日志中 `Found N plugins` 只出现一次。

---

### P0-3 marketplace 跨进程锁按「每插件一次」获取，饥饿后静默丢插件

**位置**：
- `src/utils/plugins/marketplaceManager.ts:4594 getPluginByIdCacheOnly()`
- 调用方 `src/utils/plugins/pluginLoader/marketplaceLoader.ts:160`（在 `Promise.all(...map(async ...))` 里对 76 个插件各调一次）
- 锁实现 `src/utils/crossProcessResourceLock.ts`

**现行行为**：函数文档写着「cache only, no network calls, use this for startup paths that should never block」，实际上每次调用都：

1. 取全局跨进程锁 `marketplace-cache-mutation`
2. 在其内部再取 `known-marketplaces` 事务锁
3. 读 + `JSON.parse` + `sha256` 整个 103,615 B 的 `marketplace.json`
4. 可能回写注册表

对 76 个插件重复 76 次，每遍发现一次，一次启动两遍 → **152 次全局锁往返 + 152 次 103 KB 摘要计算**。

**重试预算**：`ASYNC_LOCK_ATTEMPTS = 32`，`retryDelayMs(n) = min(25·2ⁿ, 200)`
→ `25+50+100+200 + 200×28 = 5,975 ms`，之后 **throw**。

**失败后的处理是错的**：`getPluginByIdCacheOnly` 把异常 catch 成 `return null`（第 4659-4665 行），`marketplaceLoader.ts:161` 把 `null` 记成 `plugin-not-found`，插件被**静默丢弃**。

**实测后果**（同一次启动）：

```
+14015  Failed atomic marketplace plugin lookup for crabcode-setup@...  (ELOCKED，耗时 6.4 s)
+21973  Failed atomic marketplace plugin lookup for crablaw-cn@...      (耗时 7.4 s)
+29343  Failed atomic marketplace plugin lookup for agent-sdk-dev@...   (耗时 7.4 s)
+53950  Plugin loading errors: Plugin crabcode-setup not found in marketplace ...
+74227  Plugin not available for MCP: crabcode-setup@... - error type: plugin-not-found
+80263  MCP server "...html-video": Connection failed
```

**21.7 秒纯等待 + 3 个插件消失 + 3 个 MCP 服务器起不来 + 命令目录先按 73 个插件发一次再按 76 个发一次。**

**争用来源**：`proper-lockfile` 的 mkdir 锁没有公平性。一个进程在做 76 次紧凑的 lock/unlock 循环时，另一个进程连续 32 次抢锁失败是大概率事件。用户只要开着第二个 CrabCode 窗口（或后台还有 `acosmi-memory-orchestrator` / `crabcode-cron`），就必然踩到。

**决定的修法**：

1. **把锁提到批次外**。新增 `resolveMarketplacePluginsCacheOnly(pluginIds: readonly string[])`：一次获取 `marketplace-cache-mutation` 锁 → 一次读取并 sha256 校验 `marketplace.json` → 在内存快照上解析全部 76 个插件 → 释放锁。`marketplaceLoader.ts` 改为调用它一次，不再逐插件调用。锁往返从 152 次降到 2 次。
2. **锁获取失败不得降级为「插件不存在」**。`resolveMarketplacePluginsCacheOnly` 失败时抛出，由 `loadAllPlugins()` 捕获后**整遍重试一次**（重试前 `Bun.sleep(250)`）；两次都失败才把该遍标记为 `marketplace-unavailable` 并保留上一份有效目录，绝不发布一个残缺目录。
3. 重试预算从 32 次降到 12 次（`≈ 1.9 s`）。批次化之后单次临界区只有几毫秒，再等 6 秒毫无意义。

**验收**：
- 新增单测：76 个插件的解析只触发 1 次 `withMarketplaceCacheMutationLock`。
- 新增单测：锁不可用时不产生 `plugin-not-found`，而是抛出并被上层重试；两次失败后目录保持上一份内容。
- 手工验收：同时开两个 CrabCode 窗口，日志中不出现 `Failed atomic marketplace plugin lookup`。

---

### P0-4 命令目录重复下发，两次内容相同只是顺序不同

**位置**：
- `src/cli/directTuiCommandCatalogRefresh.ts` → `DirectTuiCommandCatalogPublisher.update()`
- `src/cli/commandCatalogProjection.ts` → `projectDirectTuiCommandCatalogEntries()`

**实测**：一次启动抓到两个 `crabcode_tui_command_catalog_changed`，间隔 20 s / 33 s / 72 s（随争用变化）：

```
两次都是 143,586 字节、410 条命令
逐条比对：内容不同的条目 0 条
名称顺序：21 个位置不同（第一处差异在 index 16）
```

即**语义完全相同，只是数组顺序不同**。顺序来自 `Promise.all` 的完成次序，非确定。

`update()` 无条件 `this.dirty = true` 并重发；Rust 侧 `tui_app.rs:10341 handle_command_catalog_changed()` 收到后整体替换 `self.commands` 并重建补全列表和命令面板。于是启动几十秒后，命令面板会毫无理由地重排一次；若此刻面板开着，光标下的列表会跳。

**决定的修法**：

1. `projectDirectTuiCommandCatalogEntries()` 返回前按 `name` 做稳定排序（`localeCompare` 不可用，用二进制序 `a.name < b.name`），消除非确定顺序。
2. `DirectTuiCommandCatalogPublisher` 增加 `lastDeliveredSerialized: string | undefined`；`update()` 先 `JSON.stringify(commands)`，与 `lastDeliveredSerialized` 相同则直接 return（不置 dirty、不排 drain）；`drain()` 发送成功后写入。

两条都做：排序保证「内容相同 ⇒ 序列化相同」，去重保证「序列化相同 ⇒ 不发」。只做其中一条无效。

**验收**：
- 新增单测：连续两次 `update()` 传入语义相同但顺序不同的数组，只发一次。
- 新增单测：投影输出对同一输入集合的任意输入顺序都产生同一数组。

---

### P0-5 命令别名被当成独立命令下发（「一个命令在终端有 2 个」）

**位置**：`src/cli/commandCatalogProjection.ts:71 projectDirectTuiCommandCatalogEntries()`

第 83 行 `getRoutableCommandInvocationNames(command)` 产出「规范名 + 全部别名」，第 84-135 行对**每一个名字都产出一条独立目录条目**，且共用同一份 `description` / `argumentHint`，没有任何别名标记。

**实测（用户当前真实目录，410 条命令）**：

```
描述完全相同因而在面板里表现为同一命令的分组：4 组，多出 5 行
  [clear | reset | new]                          <- 清空对话历史，释放上下文
  [compact | com]                                <- 清空对话历史但保留摘要在上下文中
  [skill-creator | create-skill]                 <- ...做成一个可复用的 CrabCode 技能
  [crabcode-browser | browser-automation]        <- 默认的内置浏览器自动化
```

Rust 侧 `tui_app.rs:5963 rebuild_completion_commands()` 只过滤 `hidden` 与保留名，无从知道 `reset`/`new` 是 `clear` 的别名，于是三行并列显示。**这就是用户看到的「一个命令在终端有 2 个」，且与平台无关，Mac 和 Windows 表现一致。**

**协议已经具备解法**：`CommandCatalogEntrySchema` 已有可选字段 `hidden: z.literal(true)`；Rust 侧 `hidden` 只影响补全与面板，不影响路由——`runtime_catalog_contains()`（`tui_app.rs:9173`）走的是未过滤的 `self.commands`，且既有测试 `tui_app.rs:28859` 已断言 `hidden-builtin` 仍可被提交执行。

**决定的修法**：`projectDirectTuiCommandCatalogEntries()` 中，规范名（`getRoutableCommandInvocationNames` 的第一个产出）保持现状；**其后每一个别名条目一律带 `hidden: true`**。命令本身的 `hidden` 为真时全部条目仍为 `hidden: true`。

效果：面板只显示 `/clear`、`/compact`、`/skill-creator`、`/crabcode-browser` 各一次；用户仍可直接输入 `/reset`、`/com`、`/create-skill` 并正常执行。

**验收**：
- 新增单测：带别名的命令投影出 1 条 `hidden` 未设置的条目 + N 条 `hidden: true` 条目。
- 新增 Rust 单测：`hidden: true` 的条目不进入 `completion_commands`，但 `runtime_catalog_contains` 为真且可提交。
- 手工验收：`/` 面板中 `clear`/`reset`/`new` 只剩一行。

---

### P1-6 启动进程链有四层

**证据**：`Win32_Process` 快照

```
1764  crabcode.exe        (~/.crabcode/bin 的 shim)          21:49:08
40180 crabcode.exe        (versions/1.0.36 的 launcher)      21:49:09
45600 crabcode-tui.exe    (真正的 Rust TUI)                  21:49:10
43912 bun.exe             (dist/tui-runtime/index.js)        21:49:12
```

**4 秒**只用于把进程链拉起来。Windows 每次 `CreateProcess` 要做映像加载 + Defender 扫描；`bun.exe` 98 MB、`crabcode-tui.exe` 12 MB。

**决定的修法**：`~/.crabcode/bin/crabcode.exe` 这层 shim 已经读取 `versions/.current` 才能定位 1.0.36，它没有理由再启动 `versions/1.0.36/crabcode.exe` 这层 launcher 去做同一件事。让 shim 解析出版本目录后**直接启动 `crabcode-tui.exe`**，砍掉中间一跳（1764 → 45600）。`versions/*/crabcode.exe` 保留，供 `process-tree-exec` 等子命令使用。

**验收**：进程树只剩 3 层；`Get-CimInstance Win32_Process` 中 `crabcode.exe` 的实例数从 2 降到 1。

---

### P1-7 ripgrep 对不存在的目录也会 spawn

**位置**：`src/utils/markdownConfigLoader.ts:546 loadMarkdownFiles()`

现行注释说「不做存在性预检查以避免 TOCTOU」，但 catch 分支本来就要处理竞态，预检查并不削弱正确性，只是省掉一次注定失败的进程创建。

**实测**：一次启动里对三个不存在的目录各 spawn 一次 `rg`：

```
+6339  rg error: C:\Program Files\CrabCode\.crabcode\commands  系统找不到指定的文件
+7633  rg error: C:\Program Files\CrabCode\.crabcode\agents    系统找不到指定的文件
+7634  rg error: C:\Users\fushihua\.crabcode\agents            系统找不到指定的文件
```

`6339 → 7634` 共 **1.3 秒**。

**决定的修法**：`loadMarkdownFiles()` 在 spawn 前做一次 `stat(dir)`，不是目录就直接 `return []`；catch 分支中的 `isFsInaccessible` 保留不动，用于处理预检查之后目录被删除的竞态。

**验收**：新增单测——目标目录不存在时不调用 `ripGrep`；目标目录在预检查后被删除时仍返回 `[]` 而不抛出。

---

### P1-8 `CRABCODE_DEBUG_LOGS_DIR` 被当作文件路径，指向目录时启动即崩溃

**位置**：`src/utils/debug.ts:230-237 getDebugLogPath()`

```ts
return getDebugFilePath()
  ?? process.env.CRABCODE_DEBUG_LOGS_DIR      // ← 直接当文件路径返回
  ?? join(getCrabCodeConfigHomeDir(), 'debug', `${getSessionId()}.txt`)
```

变量名是 `_DIR`，兜底分支也是「目录 + 文件名」，但中间分支把它当文件。**本次审计中按字面含义传目录，运行时立即崩溃**：

```
Error: EISDIR: illegal operation on a directory, write
    at appendFileSync (...index.js:48:9373)
EXIT 1
```

一个用于排障的开关本身会杀死进程，直接后果是本次审计无法使用 `CRABCODE_PROFILE_STARTUP`（其报告路径同样落在这条链上）。

**决定的修法**：中间分支改为——若该路径已存在且是目录，或以路径分隔符结尾，则返回 `join(value, `${getSessionId()}.txt`)`；否则按文件路径使用。

**验收**：新增单测覆盖三种取值（现有文件路径、现有目录、带尾分隔符的不存在路径）。

---

### P1-9 诊断日志滚动用截断而非轮换

**位置**：`crates/crabcode-tui/src/renderer_diagnostics.rs:424` 的 `options.truncate(true)`

达到 8 MB 上限时整个文件被清空。本机现存文件 `sequence` 范围 0–39,365 但只剩 5,071 行，即**已经丢过多轮历史**。与模块声明的「a presentation failure can be replayed」直接冲突。

**决定的修法**：并入 P0-1 第 3 项一起改为轮换保留 1 代。此处单列是为了明确它是一条独立的正确性缺陷，不是性能优化的副产品。

---

### P2-10 磁盘残留未清理

**实测**（`~/.crabcode/`）：

| 残留 | 体积 | 说明 |
|---|---|---|
| `plugins/marketplaces/.marketplace-add-*.staging` × 4 | 31 MB | 来自 08-06 / 08-11 / 08-15 / 08-22 被中断的 marketplace 安装，进程早已退出 |
| `plugins/marketplaces/crabcode-plugins-official/` | 63 MB | 旧版非 generation 布局的孤儿目录，`known_marketplaces.json` 已指向 `-ae02062a-…` |
| `shell-snapshots/` | 219 个文件 | `src/utils/bash/ShellSnapshot.ts:439` 只写不清 |
| `versions/1.0.35/` | 244 MB | 升级到 1.0.36 后未回收 |

这些目录会被插件发现的树遍历反复扫到（见 P0-2 的 1.9 s 遍历成本），并持续增长。

**决定的修法**（全部在启动的后台任务里做，不阻塞首帧）：

1. 扫描 `plugins/marketplaces/.marketplace-add-<pid>-<uuid>.staging`，若目录 mtime 超过 1 小时**且** `<pid>` 对应进程已不存在，则删除。
2. `shell-snapshots/` 中 mtime 超过 7 天的 `snapshot-*.sh` 删除。
3. 启动成功并完成 `initialize` 后，删除 `versions/` 下既非 `.current` 也非当前进程所在的版本目录。
4. 孤儿 marketplace 目录：`known_marketplaces.json` 中未被任何条目的 `installLocation` 引用、且不以 `.staging` 结尾的顶层目录，删除。

**验收**：新增单测覆盖「pid 仍存活的 staging 不删」「7 天内的快照不删」「当前版本目录不删」。

---

### P2-11 插件 MCP 服务器经由 `.cmd` 批处理启动，Windows 上每个多一层进程

**证据**：

```
crabcode.exe process-tree-exec -- C:\Users\fushihua\AppData\Roaming\npm\bun.cmd --no-env-file --cwd ... server.js
```

`bun.cmd` 是 npm 的批处理垫片，Windows 上必须经 `cmd.exe` 执行。实测树中每个插件 MCP 服务器占 3 个进程（`crabcode.exe` 包装 + `cmd.exe` + 真正的 `bun.exe`）。

**决定的修法**：MCP 服务器命令解析时，若可执行名解析为 `bun`/`node` 且安装根（`versions/<v>/`）下存在同名 `.exe`，优先使用该 `.exe`；仅在缺失时回退到 PATH 解析。这同时消除了「插件用哪个 bun」的不确定性。

**验收**：新增单测——存在同级 `bun.exe` 时解析结果为该绝对路径；不存在时回退 PATH。

---

## 四、实施顺序

按「单位改动收益」排序，每一步独立可发布、独立可回滚。

| 步骤 | 内容 | 预期收益 | 涉及文件 |
|---|---|---|---|
| 1 | P0-1 诊断日志常驻句柄 + 专用写线程 + 轮换（含 P1-9） | 输入延迟从 5–20 s 降到不可感知 | `renderer_diagnostics.rs` |
| 2 | P0-5 别名条目标 `hidden` | 命令重复显示消失（Mac + Win） | `commandCatalogProjection.ts` |
| 3 | P0-4 投影稳定排序 + 发布端内容去重 | 命令面板不再无故重排 | `commandCatalogProjection.ts`、`directTuiCommandCatalogRefresh.ts` |
| 4 | P0-3 marketplace 锁批次化 + 失败不降级 | 启动省 6–22 s，插件不再丢 | `marketplaceManager.ts`、`marketplaceLoader.ts`、`crossProcessResourceLock.ts` |
| 5 | P0-2 发现指纹 + 跳过第二遍 + 让出事件循环 | 启动省 20–70 s | `queryExecutionCore.ts`、`refresh.ts` |
| 6 | P1-7 rg 预检查、P1-8 调试路径修正 | 启动省 1.3 s；排障开关可用 | `markdownConfigLoader.ts`、`debug.ts` |
| 7 | P1-6 砍掉一层 launcher | 启动省约 1 s | `scripts/install.ps1`、shim 源码 |
| 8 | P2-10 残留清理、P2-11 MCP 可执行解析 | 遍历成本随时间不再恶化 | 插件生命周期、MCP 传输层 |

步骤 1–5 完成后的预期：**首帧到可输入 ≈ 6–8 秒**（下界由 bun 加载 14.9 MB bundle + 一遍插件发现决定），**输入延迟回到毫秒级**，**命令面板每个命令只出现一次**。

---

## 五、明确不做的事

为避免过度工程，以下方案在本次审计中被评估后**明确否决**：

- **不拆分 14.9 MB 的 runtime bundle**。实测最好一次 bootstrap 5.8 s，其中 bun 自身仅 0.1 s；主要成本在配置/认证/插件索引，而不是模块求值。拆包会引入产物绑定校验（`verify-tui-runtime-source-binding.mjs`）的大量返工，收益不成比例。
- **不改用异步 FS 重写插件发现**。Bun 的异步 FS 在 Windows 上仍走同一套过滤驱动，单次成本不变；真正的收益来自「不做第二遍」和「批次化锁」，即减少操作次数而非改变操作形态。
- **不给诊断日志加环境变量开关**。开关会让「默认路径」和「排障路径」行为分叉，反而更难复现问题。正确做法是把默认路径本身做到零成本（P0-1）。
- **不引入新的进程内缓存层**。P0-2 的指纹比对复用已有的 `installed_plugins.json` / `known_marketplaces.json` 元数据，不新增状态文件。

---

## 六、可立即执行的环境清理（与代码修改无关）

以下操作只作用于用户本机状态，对当前安装立即生效，可在代码修复前先做：

```bash
# 1. 已中断的 marketplace 暂存目录（08-06 / 08-11 / 08-15 三个，对应进程均已退出）
#    审计探针自身产生的三个（19.8 MB）已在审计结束时删除
rm -rf ~/.crabcode/plugins/marketplaces/.marketplace-add-*.staging

# 2. 孤儿 marketplace 目录（63 MB，known_marketplaces.json 已不再引用）
rm -rf ~/.crabcode/plugins/marketplaces/crabcode-plugins-official

# 3. 7 天前的 shell 快照（219 个中的大部分）
find ~/.crabcode/shell-snapshots -name 'snapshot-*.sh' -mtime +7 -delete

# 4. 旧版本目录（244 MB）
rm -rf ~/.local/share/crabcode/versions/1.0.35
```

另外：把 `C:\Users\fushihua\.local\share\crabcode\` 与 `C:\Users\fushihua\.crabcode\plugins\` 加入 Windows Defender 的排除路径。这不是代码缺陷的替代品，但它直接削掉本审计中所有 Windows 放大系数的主要来源（实测热遍历不比冷遍历快，即每次元数据操作都在过滤驱动里往返）。

---

## 七、复现脚本

审计使用的探针位于会话临时目录，关键三支：

- `startup.mjs`——按真实协议完成 setup 握手并发 `initialize`，逐帧打时间戳；用于测得 bootstrap / initialize / 目录下发的时间线。
- `fsbench2.mjs`——用 Node 复刻 `append_bounded_json_line` 的精确系统调用序列，对比常驻句柄；用于测得 1675 µs vs 45 µs。
- `dupcheck.mjs`——按 `description + argumentHint` 分组抓出别名重复条目；用于测得 4 组 / 5 行冗余。

三支脚本均只读取用户既有配置，不写入业务状态；`startup.mjs` 每次运行会触发一次真实的插件发现，因而在 `plugins/marketplaces/` 下留下 `.staging` 目录。本次审计产生的三个（pid 11880 / 1376 / 24740，共 19.8 MB）已在审计结束时确认进程已退出后删除；08-06、08-11、08-15 三个是审计之前就存在的，保留待用户确认后清理。

---

## 八、实施结果（2026-08-23 回写）

八个步骤全部处置完毕：七项实施并通过验收，一项经实证否决。每一项均由独立子代理实施、由主控独立复核。

| 步骤 | 结论 | 关键实测 |
|---|---|---|
| 1 · P0-1 + P1-9 | **已实施** | 调用线程 10,000 次记录 161–196 ms（原 16.7 s）；UI 线程零文件 I/O |
| 2 · P0-5 | **已实施**（一次返工） | 活体目录可见行 410 → 405，四组别名各塌成一行 |
| 3 · P0-4 | **已实施** | 两份活体载荷稳定排序后逐字节相同 ⇒ 第二次下发被抑制 |
| 4 · P0-3 | **已实施** | 锁往返 76 → 1（每次启动 152 → 2）；重试预算 5,775 ms → 1,775 ms |
| 5 · P0-2 | **已实施** | 磁盘无变化时整遍跳过，不清缓存、不重扫、不重发目录 |
| 6 · P1-7 + P1-8 | **已实施** | EISDIR 崩溃已复现并验证修复；`CRABCODE_PROFILE_STARTUP` 恢复可用 |
| 7 · P1-6 | **否决，不实施** | 见下 |
| 8 · P2-10 + P2-11 | **已实施** | 只读探针在真实机器上判定与第六节手工清单逐项吻合 |

### 8.1 P1-6 否决理由（本审计的自我更正）

本审计第 250-265 节对该项的成本模型**是错的**，据此给出的修法**不可实施**。更正如下。

**成本模型错误**：原文用「`bun.exe` 98 MB、`crabcode-tui.exe` 12 MB」论证 `CreateProcess` 昂贵，但被砍掉的那一跳既不是 bun 也不是 TUI，而是 `versions/<v>/crabcode.exe`——实测仅 1,051,648 字节。该跳实测中位成本 1.54 s，方差 0.2–4.4 s（Defender 扫描主导）。

**三个阻塞点**（任一都足以否决）：

1. `native_tui_bootstrap.rs:49-64` 无条件执行 `MemoryRuntimeCoordinator::resolve(&state_root, &caller_executable)` + `ensure()`。`resolve_binary()` 在 `caller_executable` 同级目录找 `acosmi-memory-orchestrator.exe`，而 shim 所在的 `~/.crabcode/bin/` 下**只有 `crabcode.exe` 一个文件**（已核实）→ 硬失败。唯一的修法是传入 `generation/crabcode.exe` 冒充 `current_exe()`，而**同一个参数**被 `has_selected_generation_authority()` 当作身份权威证明使用（`is_generation_launcher()` 要求路径形如 `<versions>/<semver>/crabcode.exe`，shim 结构上永不满足）。这等于伪造权威证明。
2. 直连会取消 generation launcher 侧的 `acquire_or_adopt` 复验层，交给 Bun 的 `LEASE_OWNER_PID` / `exec_path` 会变成 shim 的（位于 `versions/` 之外），违反租约分层语义。
3. shim 是**故意的陈旧代码**（`.current` 原子替换、shim 不同步替换）。其编译期子命令白名单无法覆盖未来版本新增的子命令，「不确定时走旧路径」在陈旧白名单上原理性无法实现。

**结论**：以约 1.5 秒收益换取上述任一不变量的削弱不成立。代码零改动。

**替代方向**（已评估，本次未实施，供后续决策）：把中间跳变便宜而非删除它——(a) 由 `install.ps1` 为安装根申请 Defender 排除项，收益上界高于砍一跳且不触碰 generation 语义；(b) 把 `memory.ensure()` 与 `crabcode-tui.exe` 的 `CreateProcess` 并行化（现为严格串行），完全在 generation launcher 内部完成。

### 8.2 对本审计其它条目的更正

- **P0-3 的重试预算算术**：正确值是 `5,775 ms → 1,775 ms`（11 次 sleep 间隔），原文的 5,975/1,900 多算了一次 sleep。
- **P0-2 修法第 2 项的内部矛盾**：原文第 129 行既说「装机器报告无变更就直接不排 `refreshPluginState()`」，又说「指纹是第二道防线，用于 settings 在启动窗口内被改写的情况」。二者不可兼得：完全不调用则指纹永不被查。实施按自洽读法——报告有变更即全扫；报告无变更仍进函数但由指纹裁决（稳态约 9 次 `statSync` 后立即返回）。稳态行为等价于「不排」，同时真正保住第二道防线。
- **P0-5 修法的边界情形**：原文「规范名（第一个产出）保持现状」按字面理解会让**规范名已被更早 first-wins 所有者占走**的命令变成零可见行，与本节自述效果「各一次」冲突。实施采用「已产出行序号」：每条命令的第一个**实际产出**行保持可见，其后隐藏。

### 8.3 第六节环境清理的处置

未手工执行。第 8 步 P2-10 的代码路径对同一批对象给出**完全相同的判决**，且带 pid 存活检测、mtime 门槛、`known_marketplaces.json` 引用校验等护栏，而手工 `rm -rf` 没有。只读探针在真实机器上的判决：3 个 staging 全删（pid 均已退出，存龄 188–401 h）、快照删 141 留 82、`versions/1.0.35` 删、`crabcode-plugins-official`（63 MB 孤儿）删。这些将在下次正常启动的后台空闲任务中自动完成。

### 8.4 已知的宿主既有失败（非本次引入）

在纯净 HEAD worktree 上复现，与本次改动无关：

- `bun run check:tui-command-capabilities`：校验器解析 `(pass) <name>` 行，而本机 Bun 1.3.11 一行都不输出，故所有证据标记恒为 `passes=0`。HEAD 上报出逐字相同的错误。
- `bun run check:capabilities`：`generated_renderer_contract.rs` 陈旧，HEAD 上同样报出。
- `tests/unit` 中 8 个文件在 HEAD 上同样失败，多为 Windows 路径分隔符或 NTFS 非法路径（如测试试图 `mkdir` 一个以冒号结尾的目录）。
- `cargo clippy -- -D warnings`：`crabcode-pager-render` 的 `Duration` 仅在 `#[cfg(unix)]` 下使用，Windows 上报 unused import。clippy 不在 `bun run ci` 链上。
