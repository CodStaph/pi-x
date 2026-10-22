# 架构改进计划

> 适用范围：本 fork（`@agegr/pi-web` 0.10.x，pi SDK 1.3.0，Next 16，Tauri 2）
> 上游基线：`scripts/fork-ownership.json` 的 `upstreamBaseline`（`main@6fcd7d4` / v0.10.0）
> 性质：执行计划，不是 ADR。每完成一个阶段，把落地结论补进 `docs/merge-history.md` 或对应 ADR。
> 本文档由 fork 维护，不进入 upstream 漂移统计。
>
> 文中标注 **（新增）** 的文件当前**尚不存在**，是计划要创建的目标：`lib/pi/*`、`lib/session/state.ts`、
> `lib/composer-send.ts`、`lib/migrations/index.ts`、`lib/agent-error-codes.ts`、`scripts/measure-sdk-boundary.mjs`、
> `scripts/measure-session-scan.mjs`、`docs/agents/state-authority.md`、单实例一致性 ADR。其余路径均为现有文件。

---

## 0. 摘要

本项目的两个真实成本中心是**上游合并**与**SDK 升级**，不是文件行数。因此本计划按「演进韧性」排序，而不是按「代码整洁度」排序。

**如果只做三件事：**

1. `lib/pi/` SDK facade（命令契约 + 事件允许清单 + `drift:sdk` 棘轮）——对冲最高频的 SDK 升级成本。
2. CI 接入 `npm run drift` 与 ownership 派生哨兵——把已有治理机制从「人工执行」变成「自动拦截」。
3. `lib/migrations/` 集中迁移入口——为「一定会发生、发生时就晚了」的数据格式变化预埋可控点。

三件事都不移动 upstream-owned 代码、不改变用户可见行为，可各自独立落地。

---

## 1. 现状证据

### 1.1 规模（审查基线）

统计口径：排除 `*.test.mjs` 的行数；行数仅用于定位复杂度，不作为清理目标。

| 区域 | 文件数 | 行数 | 最大文件 |
|---|---:|---:|---|
| `components/` | 84 | 40,406 | `ChatInput.tsx` 3,491 · `AppShell.tsx` 3,202 · `SessionSidebar.tsx` 2,792 |
| `hooks/` | 23 | 5,285 | `useAgentSession.ts` 3,161 |
| `lib/` | 258 | 45,891 | `rpc-manager.ts` 2,801 · 三份 i18n 各 1,757 |
| `app/api/` | 83 | 7,959 | `files/[...path]/route.ts` 1,022 |
| `src-tauri/src/` | 11 | 2,664 | `lib.rs` 1,221 |

### 1.2 两个结构性指标

| 指标 | 当前值 | 含义 |
|---|---:|---|
| 直接 `import "@earendil-works/*"` 的非测试文件 | 70（`pi-coding-agent` 69 处） | SDK 变更的影响面 |
| `as unknown as` | 41（`rpc-manager.ts` 占 14） | 绕开类型系统的地方 |
| `sendAgentCommand` 调用点 | 49 | 命令协议的消费面 |
| `AgentSessionWrapper.send()` 的 `case` 分支 | 31 | 命令协议的供给面 |
| `from "@/lib/pi-types"` 的文件 | 53 | 已有准 facade 的覆盖 |

`lib/pi-types.ts` 已证明「结构类型适配」可行，但只覆盖**类型**；**值**（事件名、命令名、entry 结构、能力判断）仍散落在各处。

### 1.3 两条演进主轴

| 主轴 | 频率（近期证据） | 现有应对 |
|---|---|---|
| 上游合并 | 每月多次（segment E/F/G、v0.10.0 合并） | `scripts/fork-ownership.json`、`scripts/measure-fork-drift.mjs`、`test/merge-guards/fork-extractions.test.mjs`、`docs/merge-history.md` |
| SDK 升级 | 约每月一次（0.86 → 0.87.1 → 0.99 → 1.0.0 → 1.0.2 → 1.3.0） | 适配代码 + `AGENTS.md` 注释 + 回归测试 |

**结论：不要再新建治理体系。** 已有机制（risk 分级、cosmetic/structural 漂移区分、autoPushPolicy、merge-guard）质量很高，缺口在于**没有接入 CI**、且**哨兵清单靠人工维护**。

### 1.4 SDK 不可 fork（阶段 A 与分支决策的共同根据）

这条事实决定了阶段 A 为什么是「最高优先」而不是「更整洁的选择」。

| 核查项 | 结果 |
|---|---|
| SDK 来源 | `registry.npmjs.org`，7 个包：`pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-tui`、`pi-codemode`、`pi-mcp`、`pi-telemetry`（均 1.3.0） |
| 包内 `files` | `dist`、`docs`、`examples`、`schemas`、`CHANGELOG` — **无 `src/`** |
| 仓库中的 SDK 文件 | **0**（`git ls-files`）；`src-tauri/resources/server/node_modules` 是构建产物 |
| `patch-package` / `overrides` / `resolutions` / vendored fork | **全部没有** |
| 包内 `.ts` 构成 | 581 个：467 个 `.d.ts` + 102 个 `examples/*.ts` + 12 个依赖内 `.ts`；`dist` 内无任何非 `.d.ts` |

两个例外：

1. **sourcemap 内嵌源码（可还原）**：251 个 `.js.map` 中 242 个带 `sourcesContent`，合计约 262 万字符，路径形如 `../../src/core/session-manager.ts`。因此「读源核对」随时可做，例如 `AGENTS.md` 中「`getUsageCostBreakdown()` not exported by the SDK — keep the port in step with `core/usage-totals.ts`」这类要求是可执行的。
2. **`pi-tui` 的 native 模块带真实源码**（`native/{win32,darwin,linux}/src/*.{c,h,m}` + `napi.h`），因为 prebuilds 需要可编译/可审计。不属于 agent 核心逻辑。

**推论**：修改 SDK 行为只有四条路——上游 PR、升版本、在包装层适配、`patch-package`（当前无此机制）。因此 **`lib/pi/` facade 是唯一可行的隔离手段**，`AGENTS.md:425` 的「Upstream owns SDK adaptation」正是这条约束的制度化表达。

附带事实：`pi-coding-agent` 单包 36 MB（`dist` 20 MB），会被复制进桌面 `resources/server` —— 这是 `scripts/prepare-desktop.mjs` 中 `stageCompletePackage()` / `dedupeNestedPackages()` 存在的理由。

### 1.5 审查方式与限制

- 已执行：`tsc --noEmit` 通过；事件流/事件连接/请求安全/路径安全/会话增量扫描抽查测试 **62 通过、1 跳过、0 失败**。
- 未执行：全量 `npm test`、浏览器 E2E、桌面打包、性能压测。
- 因此本文档中涉及性能的条目一律以「先建立基线」为前提，不预设瓶颈。

---

## 2. 决策原则

1. **先新增旁路，后搬移核心。** 本项目周期性合并上游，git 不追踪跨文件移动；移动的代价不在写代码，而在之后每次合并。
2. **不新增架构层。** 不加 DI 容器、不加状态机库、不加 schema 校验库、不加数据库、不拆进程。TypeScript 联合类型 + 纯函数 + 现有 `node --test` 足够。
3. **每一步可独立回滚。** 单个 PR 内闭环，不产生「半迁移」状态。
4. **判 ownership 再决定是否拆分。** 见第 5 节判据表。
5. **行为变更与结构变更不混在一个 PR。**

---

## 阶段 A：SDK 边界收敛（最高优先）

**动机**：1.2 节的 70 个直接 import 与 41 处 `as unknown as` 是**唯一的破坏面**，而 1.4 节证明 SDK 不可 fork、只能隔开。SDK 约每月一次升级（0.86 → 1.3.0），每次都会围绕「事件名、命令名、entry 结构、只读属性、`isIdle` 语义」产生适配工作。目前这些工作以「代码 + `AGENTS.md` 注释 + 回归测试」留存，属于**人记**；阶段 A 把它们变成**机制**。

> 本阶段全部为新增文件，不动 upstream-owned 代码，也不改变用户可见行为。

### A1 命令契约 `lib/pi/session-commands.ts`

纯新增文件，不改现有实现。

```ts
export type AgentImage = { type: "image"; data: string; mimeType: string };

export type SessionCommand =
  | { type: "prompt"; message: string; images?: AgentImage[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "get_state" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "set_tools"; toolNames?: string[] }
  // …31 条命令逐条列出
  ;

export type CommandType = SessionCommand["type"];
export type CommandOf<T extends CommandType> = Extract<SessionCommand, { type: T }>;

/** 命令 → 返回值。缺一项即编译失败。 */
export interface CommandResultMap {
  get_state: AgentStateResponse;
  get_tools: ToolInfo[];
  prompt: PromptResult;
  // …
}

export type CommandMeta = {
  mutates?: true;                   // 计入 activeMutatingCommands
  allowedDuringReplacement?: true;   // 取代 COMMANDS_ALLOWED_DURING_SESSION_REPLACEMENT
  replacesSession?: true;            // 取代 SESSION_REPLACEMENT_COMMAND_TYPES
  waitsForExtensions?: boolean;      // 取代 shouldWaitForExtensions()
};

export const COMMAND_META = { /* … */ } satisfies Record<CommandType, CommandMeta>;
```

配套改动：

- `lib/agent-client.ts`：`sendAgentCommand<T extends CommandType>(id, cmd: CommandOf<T>): Promise<CommandResultMap[T]>`。
- `lib/rpc-manager.ts`：`send(command: SessionCommand)`，`switch` 自动窄化；`:206`、`:211`、`:590` 三处手写集合改读 `COMMAND_META`。
- `app/api/agent/[id]/route.ts`：入口加 `parseSessionCommand(body): { ok: true; command } | { ok: false; error; code }`。

**约束**

- 契约只描述**现有**返回结构，不顺手修正语义（否则会把回归混进重构）。
- 保留现有错误语义：400、`code`、prompt 类 `accepted: false`（`isPromptRejectedError()` 依赖它）。
- 手写窄化，不引入 zod/valibot。

**验收**

- `tsc --noEmit` 通过；删除至少 5 处调用点的显式泛型。
- 新增测试：`Object.keys(COMMAND_META)`、`CommandResultMap` 键集合、`SessionCommand["type"]` 三者一致。

#### 实施状态：已落地（2026-10-21）

落地时与上面的草稿有六处出入，均记录在此以免后来者「改回计划里的写法」：

| 计划 | 实际 | 原因 |
|---|---|---|
| `SessionCommand` 直接是命令联合 | 外层套 `ResumeToolPin = { toolNames?: string[] }` | route 恢复休眠会话时把工具 pin 传给 `startRpcSession()`，该字段可随任意命令到达 |
| `CommandResultMap` 描述 wrapper 返回值 | 描述 **HTTP** 结果 | `set_tools` 走 `setRpcSessionTools()` 重建会话，答 `{ sessionId, recreated }`；`send()` 对同名命令返回 `null` |
| `satisfies Record<CommandType, CommandMeta>` | 显式 `: Record<CommandType, CommandMeta>` 注解 | `commandTypesWith()` 需要按 flag 索引，`satisfies` 保留的字面量联合会报 TS2536 |
| 只有 `/api/agent/[id]` 解析 | `/api/agent/new` 也走同一份 `parseSessionCommand()` | 它是另一个把命令体直接交给 `session.send()` 的入口 |
| 只改一处路由校验 | `ensure_session` 视为路由级伪命令，不进入契约 | 它不发给 wrapper，只创建运行时 |
| — | 3 处 `hooks/useAgentSession.test.mjs` 断言随类型迁移 | `get_state` 的返回形状改为核对契约文件，并断言 hook 从契约导入 |

守卫测试 `lib/pi/session-commands.test.mjs` 固定了四件事：31 个命令、三张 flag 表的成员、两个路由都走契约、以及全仓不得再出现 `sendAgentCommand<…>` 显式类型参数或硬编码的命令集合。**加命令时它会让 `length === 31` 这条失败**——同时更新文档 1.2 节的计数。

改动面：新增 `lib/pi/session-commands.ts` 与测试；`lib/agent-client.ts`、`lib/rpc-manager.ts`、两个 agent 路由、`hooks/useAgentSession.ts`、`components/AppShell.tsx` 各改数行。`tsc`、`npm test`（2949 项，0 失败）、`npm run lint` 均通过。

### A2 事件映射 `lib/pi/events.ts`

`lib/agent-event-wire.ts` 目前是**按遗漏白名单**（只丢 `turn_start` / `turn_end` / `entry_appended`），其余全部前传；客户端 `handleAgentEvent` 的 `case` 靠人维护。`AGENTS.md` 对此的表述是「the wire forwards everything, the client switch must keep up」——一条纯靠纪律维持的约束。

SDK 每次加事件（0.86 一次性加了 `bash_execution_update`、`thinking_level_changed`、`session_info_changed`、`entry_appended`、`summarization_retry_*`、`compaction_start/end`），漏接的表现是**静默无效果**。

**改动**

1. `lib/pi/events.ts` 导出 `CLIENT_HANDLED_EVENTS`（显式集合）与 `SERVER_ONLY_EVENTS`。
2. 开发构建下，服务端对「已前传但未登记」的事件 `console.warn` 一次并计数。
3. 新增测试：`CLIENT_HANDLED_EVENTS` 与 `hooks/useAgentSession.ts` 的 `case` 分支集合一致。

**效果**：SDK 升级后第一次跑 dev 就能发现「多了 3 个没人处理的事件」，而不是等用户报「压缩进度条不显示」。

#### 实施状态：已落地（2026-10-21）

**暴露出的真实缺陷（已修）**：`entry_appended` 同时出现在 wire 的丢弃列表和客户端的 switch 里——两边都「处理」了它，实际上谁也没生效：extension 在空闲时写入 custom entry 后，transcript 不会刷新。`AGENTS.md` 描述的行为（"throttled idle-only transcript refresh"）从未跑起来过。现在 wire 把它作为**裸信号**前传（`{ type: "entry_appended" }`，剥离可达 1 MiB 的 entry），客户端的 2 秒节流刷新按原设计生效。

这是本阶段唯一的**行为变化**，也是「映射表自洽」的直接后果：一个事件不可能既被丢弃又被处理。

其余实现要点：

| 项 | 实际 | 原因 |
|---|---|---|
| 未知事件判据 | 运行时「已前传且不在 `CLIENT_HANDLED_EVENTS` 里」 | 不需要镜像 SDK 枚举，SDK 新增事件天然被覆盖 |
| 告警范围 | 仅开发构建；生产只计数 | 生产日志不刷屏，但 `getForwardedEventsWithoutHandler()` 仍可查 |
| `NOT_FORWARDED_EVENTS` | `turn_start` / `turn_end` / `session_shutdown` | 前两者 UI 由消息推导；后者由 SSE 直接断流 |
| 合成事件 | `CLIENT_SYNTHETIC_EVENTS` 单独标注 7 个 | 它们不在 SDK 联合里，混在一起会让「服务端 vs SDK」的边界失真 |
| 守卫测试 | `lib/pi/events.test.mjs`（8 项） | 客户端 switch ↔ 常量表、合成事件必被服务端 emit、两个集合不相交、诊断计数 |

同时更新了 `lib/agent-event-wire.test.mjs` 中「entry_appended 被丢弃」的旧断言。

### A3 entry 结构 `lib/pi/entries.ts`

把 `SessionEntry` 的结构断言与 `entryToUiMessage()` 的投影集中一处，取代 `session-reader.ts`、`rpc-manager.ts`、`session-list-scanner.ts` 各自的 `as unknown as SessionEntry[]`。

**验收**：`as unknown as SessionEntry` 的出现次数降为 1（facade 内部）。

#### 实施状态：已落地（2026-10-21）

**验收达成**：`as unknown as SessionEntry` 全仓只剩 `lib/pi/entries.ts` 内 1 处（另有一处出现在该文件的模块注释里），14 个调用点全部改为 facade。测试同时禁止调用点再次出现该断言。

与计划的出入：

| 计划 | 实际 | 原因 |
|---|---|---|
| `entryToUiMessage()` 一并搬进 facade | **未搬**，留在 `session-reader.ts` | 它依赖 6 个 session-reader 私有辅助（`deferToolResultBase64Images`、`getThinkingPreview`、`parseEntryTimestamp`、`slimToolResultMessage`、`normalizeToolCalls`、`BuildSessionContextOptions`）。搬移会把图像延迟加载与 thinking 预览一起拉进 facade，违背「不动行为」 |
| 只处理 `session-list-scanner.ts` | **它本来就不做这个断言**（自己解析 JSON 为内部结构）；真正需要收口的是 7 个文件 | 计划里的文件名是按 `getEntries()` 猜的 |
| 只收口 `as unknown as SessionEntry[]` | 同时清掉了 3 处 `entries as never`（`app/api/sessions/[id]/route.ts`）与 2 处 `sm.getEntries() as never`（context / reference 路由） | `as never` 是同一类绕过，只是更隐蔽 |
| `toSessionEntries()` 按已知类型过滤 | **保留全部 entry，不做过滤** | 过滤会吞掉 SDK 新增而镜像未建模的 entry，那会让 `readSessionToolSelection` / `getUsageCostBreakdown` / 树遍历静默漏数据 |
| `isSessionEntry()` 严格校验 | 只要求「对象且 `type` 是字符串」 | 与旧的盲目转换行为一致；足以拒绝 header 之外的坏行，又不替 SDK 判断形状 |

新增 `parseSessionEntryLines()` 取代 `session-reader.ts` 的私有 `parseSessionEntries()` 与 `app/api/sessions/[id]/route.ts` 里的 inline `flatMap`，两条路径现在是同一份容错解析。

5 处源码断言测试随实现更新（`context-route`、`detail-route`、`rpc-manager`、`CostRouting.wiring`），无一处靠恢复旧代码通过。

### A4 能力探测 `lib/pi/capabilities.ts`

用 feature detect 替代「版本号比较 / 注释说明」式分支。首批覆盖：

- `isIdle` 语义（`AgentSessionWrapper.isRunning()` 依赖它）；
- compaction 事件名（`compaction_start/end`，不再有 `auto_compaction_*`）；
- `state.systemPrompt` 只读；
- thinking level 的 clamp 行为。

**验收**：`capabilities.ts` 是唯一出现「SDK 行为差异判断」的地方。

#### 实施状态：已落地（2026-10-21）

落地时发现，代码里**没有**版本号比较，所以 A4 不是「把版本分支换成 feature detect」，而是「把散落的 feature detect 收成一处」。四处具体差异：

| 差异 | 原来的形式 | 现在 |
|---|---|---|
| `isIdle`（0.86+） | `isRunning()` 里 `inner.isIdle === false` | `sdkReportsBusy(inner, capabilities)` |
| `abortRetry` / `abortBranchSummary` | `inner.abortRetry?.()`、`inner.abortBranchSummary?.()` | `abortRetry(inner)` 等执行器，缺失时返回 `false` 且静默 |
| `setSteeringMode` / `setFollowUpMode` | `inner.setSteeringMode?.(…)` | 执行器，缺失时保持旧语义（静默 no-op，**不抛错**） |
| `bindExtensions` | 两处 `typeof … === "function"` | `hasBindExtensions(inner)` |
| `state.systemPrompt` | 内联读取（只读、`tsc` 看不见赋值会抛） | `replayStateSystemPrompt(inner)` 单一出口 |

与计划的出入：

- **thinking level 的 clamp 不需要探测**：`getAvailableThinkingLevels` 全仓从未被调用（只有注释），SDK 自己 clamp。因此不新增空 API，改为测试守卫「任何文件不得手动 clamp」。
- **compaction 事件名不需要探测**：`lib/pi/events.ts` 已在 A2 锁定客户端 switch，`auto_compaction_*` 不能回来。同样用测试守卫，不新增运行时检查。
- 计划里「首批覆盖四项」，实际交付 **5 项探测 + 2 项测试守卫**，因为前两项本质是「不需要探测，只需禁止复活」。

守卫测试 `lib/pi/capabilities.test.mjs`（8 项）在去注释后的代码上断言：`isIdle === false`、`abortRetry?.()`、`setSteeringMode?.(`、`typeof …bindExtensions`、`agent.state?.systemPrompt` 只允许出现在 capabilities.ts；`state.systemPrompt =` 全仓禁止；`auto_compaction_start/end` 与手动 clamp 全仓禁止。

`app/api/agent/running-events.test.mjs` 的 `isIdle` 断言随之改为「wrapper 调用 `sdkReportsBusy`，读取语义在 capabilities 内」。

### A5 棘轮 `npm run drift:sdk`

新增 `scripts/measure-sdk-boundary.mjs` + `scripts/sdk-boundary-baseline.json`：

| 指标 | 当前基线 | 方向 |
|---|---:|---|
| 直接 import SDK 的文件数 | 70 | 只减不增 |
| `as unknown as` | 41 | 只减不增 |
| `lib/pi/` 之外出现的 SDK 事件名字面量 | 待统计 | 只减不增 |

CI 中失败信息必须是「请改走 `lib/pi/`，或显式调高基线并说明理由」，否则棘轮会被随手放宽。

#### 实施状态：已落地（2026-10-21）

交付物：`scripts/measure-sdk-boundary.mjs`、`scripts/sdk-boundary-baseline.json`、`scripts/sdk-boundary.test.mjs`（5 项）、`npm run drift:sdk`。

**第三个指标换了对象。** 计划里写的是「`lib/pi/` 之外出现的 SDK 事件名字面量」，实测不可用：`hooks/useAgentSession.ts` 的 switch 与 `lib/rpc-manager.ts` 的事件订阅本来就必须逐条写出事件名，它们不是"逃逸"，而是合法分发点——该指标永远只增不减。改为两个真正反映边界的数：

| 指标 | 基线 | 含义 |
|---|---:|---|
| `sdkImportFiles` | 70 | 直接 `import "@earendil-works/*"` 的源文件数 |
| `sdkImportStatements` | 89 | 逐条 `from "@earendil-works/*"` 的数量（一个文件可 import 多个包） |
| `unsafeAssertions` | **25** | `as unknown as` 出现次数（A1–A4 从 41 降到 25） |

三个实现决定：

1. **棘轮同时接进 `npm test`。** 测试里有一条「本仓库实测值不得超过基线」，所以 CI 已经在拦；`npm run drift:sdk` 是本地/人工入口，不是唯一防线。
2. **`--update` 必须显式调用，基线不自动跟随。** 报告打印 `baseline 日期` 与 `+n REGRESSED`，失败时输出固定的三条指引（走 `lib/pi/`、隔离到新的 facade 模块、或显式抬基线并写理由）。
3. **只扫源码，不扫测试。** `*.test.ts`、`node_modules`、点目录、`demo/` 都不计入，否则一个测试夹具就能让数字失真。

自检：把基线临时改小 1，脚本以 `exit=1` 报 `REGRESSED` 并打印指引；恢复后 `exit=0`。

基线变更记录：**2026-10-22**，`sdkImportFiles` 70 → 71、`sdkImportStatements` 89 → 90（阶段 D 的 `lib/migrations/index.ts` 需要 `getAgentDir()`），理由见基线文件的 `reason`。

---

## 阶段 B：会话状态模型化

**问题**：「是否在运行」由多源 OR 得出——SDK 的 `isIdle`、`isStreaming`、`isCompacting`、`isBashRunning`、`pendingPromptCount`、`sessionReplacement`。`AGENTS.md` 专门写了「`isRunning()` 必须 consult `isIdle`」，说明正确性目前靠注释与纪律。

**新增 `lib/session/state.ts`**（纯函数）：

```ts
export type SessionPhase =
  | { kind: "idle" }
  | { kind: "admitted" }                                  // 已接收 prompt，SDK 未起跑
  | { kind: "prompting"; retry?: { attempt: number; max: number } }
  | { kind: "compacting" }
  | { kind: "branch-summary" }
  | { kind: "bash" }
  | { kind: "replacing" };

export function reducePhase(phase: SessionPhase, event: { type: string }): SessionPhase;
export function isBusy(phase: SessionPhase): boolean;
```

**关键约束**：`retry` 必须是状态的一部分而不是布尔开关——重试退避期间 `isStreaming/isCompacting/isBashRunning` 全为 false，正是当初引入 `isIdle` 检查的原因。

**迁移：影子模式，不直接切换**

1. `AgentSessionWrapper` 同时计算新旧结果，不一致时 `console.warn` 并带上事件名。
2. 观察一个发布周期。
3. 无 warn 后把 `isRunning()` 换成 `isBusy(this.phase)`。
4. 有 warn 说明现有行为本身存在分歧——先修行为，再切换。

**验收**

- 纯函数测试：idle→prompt→`agent_end`；重试退避期间 `isBusy` 为真；auto-compaction 中为真；Stop 后立即为假。
- 产出 `docs/agents/state-authority.md`：每个状态维度的权威来源（SDK / HTTP 请求生命周期 / UI 临时态）。这张表比代码更能防回归。

#### 实施状态：已落地（2026-10-21，影子模式运行中）

交付物：`lib/session/state.ts`（`SessionPhase`、`reducePhase()`、`isBusy()`、`signalFromAgentEvent()`、`phaseFromFlags()`、`compareBusy()`）、`lib/session/state.test.mjs`（16 项）、`docs/agents/state-authority.md`。

`AgentSessionWrapper` 的接入是**影子模式**，不是切换：

- `advancePhase(signal)` 在每个信号上同时算「旧 flags 答案」与「新 phase」，把差异分成两个方向；
- **只有「flags 忙 / phase 闲」告警**（dev 下每种信号一次），因为那是会导致中途驱逐或关闭的方向；反方向只计数（`getPhaseMismatches()`），因为 `agent_end` 之后 phase 有意保持忙、flags 可能已读闲；
- `isRunning()` **仍是 flags 实现**，测试显式断言它没有切到 `isBusy()`——切换要等 `risky` 计数在一个发布周期里保持 0，条件写在 `docs/agents/state-authority.md`。

设计要点（与计划草稿的差异）：

| 计划 | 实际 | 原因 |
|---|---|---|
| `prompting` 单一状态 | 额外保留 `admitted`（已接收、未起跑） | 真实存在「已提交但 SDK 还没开跑」的阶段，`get_state.isPromptRunning` 就是这个 |
| `reducePhase(phase, event)` | `reducePhase(phase, signal)` + `signalFromAgentEvent(event)` 两个纯函数 | 事件里只有部分表示活动；分开后映射可独立测试，且不把 SDK 事件名再散一份 |
| 只覆盖 SDK 事件 | 增加 8 个 wrapper 级信号（admitted/settled/bash/branch-summary/replacement） | bash 没有 start/end SDK 事件；分支摘要与 fork/clone 是包装层行为 |
| `agent_end` 即空闲 | `agent_end` 保持忙，`agent_settled` 才落闲 | 与 SDK 的 `isIdle` 语义一致；提前落闲正是中途驱逐的来源 |
| 影子比较取值不一致就告警 | 按方向区分 | 否则每次正常运行结束都会告警一次，噪音掩盖真实问题 |

`phaseFromFlags()` 用来给「中途重开的 wrapper」播种，避免它的第一个信号与陈旧的 `idle` 比较。

---

## 阶段 C：按 ownership 边界的拆分

### C1 判据表

`fork-ownership.json` 的风险模型写得很清楚：

> “Rewritten JSX trees and code moved across files are what merge cleanly while being wrong.”

因此拆分必须先判归属：

| 要搬的东西 | 归属 | 结论 |
|---|---|---|
| 桌面 chrome、`ProjectPicker`、`path-ui` 这类 fork 自建逻辑 | fork-owned | **应该搬出**，搬出后该文件更接近 upstream 干净子集 |
| upstream 也在频繁修改的渲染/交互 | upstream-owned | **不要搬**，跨文件移动正是 git 无法追踪的静默风险 |
| 新增能力（契约、事件映射、状态 reducer） | 全新文件 | 直接写在 `lib/pi/`、`lib/session/`，不进 `driftedUpstreamFiles` |

### C2 拆分顺序（冲突风险从低到高）

| 顺序 | 目标 | 做法 | 风险 |
|---|---|---|---|
| 1 | `lib/session/registry.ts` | 抽 `globalThis.__piSessions`、`__piStartLocks`、`__piStartingSessionCwds`、running listeners | 低：纯搬移 |
| 2 | `lib/session/commands/*.ts` | 每个 `case` → `(ctx, cmd) => Promise<unknown>`，`send()` 收缩为 lookup + 前置守卫 | 中：依赖阶段 A1 |
| 3 | `lib/session/start.ts` | 抽 `startRpcSession()`、模型/工具范围解析、恢复逻辑 | 中 |
| 4 | `lib/session/wrapper.ts` | 只剩生命周期 + 事件投影 | 高：上游改动最集中，须错开合并窗口 |
| 5 | `components/ChatInput.tsx` 的发送管线 | 抽 `lib/composer-send.ts` 纯函数 | 中：不触碰 JSX，可顺带替换 VM 测试 |

第 5 项的额外价值：`components/ChatInput.test.mjs` 现在用 TypeScript AST 定位 `handleSend`、transpile 后在 VM 里执行。这本身就说明发送管线是一个**可提取的纯函数**；提取后测试从「匹配源码 + 执行片段」变成「直接调函数」，既降行数又降低测试脆弱度。

### C3 硬性要求

- `lib/rpc-manager.ts` 保留为 re-export 兼容层，调用方分批改 import，绝不一次性全改。
- 每个 PR 只搬一个关注点；**不允许同一 PR 既搬移又改行为**。
- 第 5 项必须保留：滚动位置在 **render 阶段**保存（effect cleanup 里存会得到 0）、`contextLoadIdRef` 等单调整数守卫、`sessionHookMountedRef` 的 Strict Mode 顺序。
- **不要重排 `AppShell.tsx` 的 JSX 层级**：`components/AppShell.right-panel-row.test.mjs` 按结构匹配（顶栏/中列/面板嵌套关系），重排会在测试与上游合并上双重付费。只抽不改变 JSX 层级的 hook。

#### 实施状态：部分落地（2026-10-21）——C2-1 完成，其余按判据延后

**已完成：C2-1 `lib/session/registry.ts`。** 纯搬移，零行为变更：

| 搬出的内容 | 行数 |
|---|---:|
| `globalThis.__piSessions` / `__piStartLocks` / `__piStartingSessionCwds` / `__piRunningListeners` | 4 个声明 |
| `getRegistry()`（含 exit/SIGINT/SIGTERM 钩子）、`registerRpcWrapper()` | ~55 |
| `getLocks()`、`normalizeRpcCwd()`、`getStartingSessionCwds()`、`trackStartingSession()` | ~30 |
| `getRpcSession()`、`hasBusyRpcSessionForCwd()`、`destroyRpcSessionsForCwd()` | ~25 |
| running listeners、`subscribeRunningSessions()`、`notifyRunningChange()`、`getRunningRpcSessionIds()`、`getCompletionNotificationSuppressedRpcSessionIds()` | ~60 |

`registry.ts` 只用 `import type { AgentSessionWrapper }`，运行时依赖单向（rpc-manager → registry），无模块环。`lib/rpc-manager.ts` 保留 re-export，路由/测试的 import 不改。

**净减 47 行（2801 → 2754）。** 这个数字本身就是 C 阶段最重要的结论：拆文件对行数的收益很小，收益在职责边界与 ownership——`lib/session/registry.ts` 是 fork 自有文件，不进 `driftedUpstreamFiles`。

**逐项判定 C2-2～C2-5**（依据 C1 判据表，不是"没时间"）：

| 项 | 目标 | 归属判定 | 结论 |
|---|---|---|---|
| C2-2 | `lib/session/commands/*.ts`（31 个 `case` → handler） | fork-owned 逻辑，但 handler 需要 `pendingPromptCount`、`withSessionReplacement`、`emit`、`advancePhase` 等 20 余个 wrapper 私有成员 | **延后，前置 C2-4**。否则只能把 wrapper 转成 `ctx: any`，会拆掉 A 阶段刚建立的类型边界 |
| C2-3 | `lib/session/start.ts`（`startRpcSession`，约 230 行） | 与 wrapper 构造、registry 注册、subagent controller 耦合 | **与 C2-4 同窗**。单独搬会引入 rpc-manager ↔ start.ts 的值循环，收益（8% 文件体积）不抵风险 |
| C2-4 | `lib/session/wrapper.ts` | `fork-ownership.json`：`lib/rpc-manager.ts` structural **652 / high** | **必须独立窗口**。跨文件移动正是该文件 `reason` 警告的"clean merge 但语义错"；合并后要立即重算 drift |
| C2-5 | `lib/composer-send.ts` | `ChatInput.tsx` structural **1087 / high** | **只抽纯判定**（`submitsSlashCommandOnEnter` 一类），不搬整条发送管线：`handleSend` 依赖 20+ props/refs，而那段 VM 测试正是防"合并不被静默改写"的哨兵 |

**治理联动（已做）**：按 AGENTS.md「significant change to a shared file 后重跑 drift」，`scripts/fork-ownership.json` 里 `lib/rpc-manager.ts` 的 `drift`/`structuralDrift` 由 109/595 更新为 652/652，`reason` 记录了 registry 迁出与 wrapper/命令开关的迁移前置条件。

**顺带发现的既有偏差**：`node scripts/measure-fork-drift.mjs 6fcd7d4` 报告 `components/FileExplorer.tsx` 算出 medium 而 manifest 记 low（本次改动未触碰该文件）。这正是阶段 E1 要把 drift 接进 CI 的理由——人工执行的度量会漂移。

---

## 阶段 D：数据迁移层

目前 `rg -l 'migrat' lib` 无结果，而项目有至少四份**隐式 schema**，全部由用户长期持有、桌面升级不可回退：

| 数据 | 位置 | 现状 |
|---|---|---|
| 会话文件 | `~/.pi/agent/sessions/**.jsonl` | 有 `version` 字段，pi-web 内无迁移代码（依赖 SDK） |
| 模型配置 | `~/.pi/agent/models.json` | 手写校验 + 原子写 |
| MCP 配置 | `mcp.json` | undo + 原子写 |
| 全局设置 | `settings.json`（`enabledModels` 等） | 最小编辑策略 |

未来必然发生：SDK 改 session format（已发生过——`AGENTS.md` 记录 pi 会整文件重写）、或本 fork 增加字段。**唯一的可控点是「有一个集中的迁移入口」**，而它现在散落在各 route 的 `writeFileSync` 里。

**建议**

```ts
// lib/migrations/index.ts
export type Migration = { version: number; id: string; up(ctx: MigrationContext): Promise<void> };
export const MIGRATIONS: Migration[] = [];
```

- 幂等、只前进、按序执行；
- 失败时**只读降级**并明确告知，绝不覆盖用户数据；
- 迁移前做一次带时间戳的备份。

优先级低于 A/B（现在没坏），但属于「用的时候来不及补」的类别。

#### 实施状态：已落地（2026-10-22），注册表刻意留空

交付：`lib/migrations/index.ts`（框架 + 空 `MIGRATIONS`）、`lib/migrations/index.test.mjs`（9 项）、`instrumentation-node.ts` 里的启动接入。

**为什么没有迁移条目。** 逐一核对了 pi-web 自有的四类文件，没有一类需要形状迁移：会话文件由 SDK 在打开时重写；`settings.json` / `models.json` / `mcp.json` 由各自的 `normalize*` 函数容忍旧值；`<agentDir>/desktop/cost-currency.json`、`agents/settings.json` 的字段演进都是「缺字段即默认」。**在仓库里放假迁移会直接改用户数据，是负资产。** 框架的价值是第一个真实需求出现时不必临时设计：新增迁移的四步写在模块注释里（幂等检查、`ctx.backup()`、下一个未用 version、跑两次的测试）。

框架语义（都有测试）：

| 语义 | 实现 |
|---|---|
| 幂等 | `<agentDir>/desktop/migrations.json` 账本按 `id` 记录；**每条成功后立即落盘**，崩溃不重放已完成项 |
| 只前进 | 没有 `down()`；回滚是新迁移。version 必须唯一，重复直接抛错且不写盘 |
| 失败不覆盖数据 | 失败项不记账（修好后重试）、后续项不执行、启动只记录不阻塞；改动前由迁移自己调 `ctx.backup()` 生成 `<file>.bak-<timestamp>` |
| 账本损坏视为空 | 为一个元数据文件拒绝启动，比重跑幂等迁移更糟 |

**「只读降级」的实际含义**：失败时 runner 不写账本、不继续、不重试，并记录 `getMigrationFailure()`；pi-web 继续运行（日志明确告知"running without it"）。没有把 agentDir 整体设为只读——那会牵动 20+ 个写入路径，属于过度设计。

**A5 棘轮抬了一次（记录在案）**：`lib/migrations/index.ts` 需要 `getAgentDir()`，`sdkImportFiles` 70 → **71**、`sdkImportStatements` 89 → **90**。理由写入 `scripts/sdk-boundary-baseline.json` 的 `reason`：启动期基础设施必须与 SDK 用同一种方式解析 `<agentDir>`（`PI_CODING_AGENT_DIR` 否则 `~/.pi/agent`），复刻会与 SDK 漂移。这是棘轮设计的正常使用（显式、有据、被记录），不是绕过。

---

## 阶段 E：治理闭环（CI）

### E1 `fork-ownership.json` 驱动的哨兵

`test/merge-guards/fork-extractions.test.mjs` 现在是手工清单，必然滞后于 `fork-ownership.json`。

**改动**：新增脚本读取 `risk === "high"` 的条目，断言每个高风险文件都有对应哨兵；缺失即失败。

### E2 CI 接入 `npm run drift`

`ci.yml` 目前只有 `lint` / `tsc` / `npm test` / `e2e`（`ci.yml:122`）。合并后忘记重算 risk，正是 `autoPushPolicy` 想拦的情况。

**实现注意**（否则会直接失败）：`measure-fork-drift.mjs` 的基线取「与最近同步的上游 tag 的 merge base」，因此 checkout 必须带完整历史：

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
    fetch-tags: true
```

### E3 ESLint 分层约束（零新依赖）

`eslint.config.mjs` 目前只关掉 3 条 react-hooks 规则。加一段导入方向约束：

```js
{
  files: ["lib/shared/**", "lib/pi/**"],
  rules: {
    "no-restricted-imports": ["error", { patterns: ["@/lib/server/*", "fs", "node:*"] }],
  },
}
```

**理由**：目录可以慢慢迁，导入方向立刻就能守住。

### E4 未知事件可观测（与 A2 配套）

见阶段 A2 第 2 条。落 CI 的部分：测试断言 `CLIENT_HANDLED_EVENTS` 无过期条目（SDK 已删除的事件不应留在清单里）。

#### 实施状态：已落地（2026-10-22）

| 子项 | 交付 | 说明 |
|---|---|---|
| E1 | `scripts/check-ownership-sentinels.mjs` + 7 项测试 + `npm run check:ownership` | 五条规则：manifest 路径存在、high 必须有哨兵或显式豁免（`"sentinels": "none"`（无需守卫）/ `"elsewhere"`（守卫在专用测试里），两者都要 `sentinelReason`）、豁免与覆盖不可并存、`origin` 必须是 manifest 条目、`movedTo` 必须存在 |
| E2 | `ci.yml` 新增 `ownership` job；`drift` 的基线改为 manifest 的 commit；`drift` 在 risk 不符时 `exitCode = 1` | job 不跑 `npm ci`（只依赖 Node 内置与 manifest），`fetch-depth: 0` + `fetch-tags: true` |
| E3 | `eslint.config.mjs`：`lib/pi/**/*.ts` 禁止 `@earendil-works/*` 与 Node 内置模块 | 用临时违规文件验证过规则确实报错，随后删除 |
| E4 | 无新代码 | A2 已覆盖：`CLIENT_HANDLED_EVENTS` 必须与 `handleAgentEvent` 的 case 集合完全一致、合成事件必须被服务端 emit。这两条都在 `npm test` 里，CI 已在跑 |

**E1 第一次运行就抓到一个真实缺口**：`components/ChatInput.tsx` 是 manifest 里的 high 风险文件，但没有任何哨兵。补的条目守 `composer-send-button`、`composer-attach-button`、`composer-trigger-hint`、`data-state={compact`、`onSetDefaultModel`（后者是 fork 独有的默认模型星标）。

**E2 顺带修好了 `npm run drift` 本身**：`fork-ownership.json` 的 `upstreamBaseline` 是给人读的 `"main@6fcd7d4 (v0.10.0)"`，`git diff` 无法解析它——`npm run drift` 在本地一直直接崩溃（我在阶段 C 只能用 `node scripts/measure-fork-drift.mjs 6fcd7d4` 手动传参）。现在新增 `upstreamBaselineCommit: "6fcd7d4"`，脚本优先用它。

同时补全了两处 manifest 偏差（drift 脚本现在会对「记录值与计算值不符」返回非零）：

| 文件 | 修正 | 依据 |
|---|---|---|
| `components/FileExplorer.tsx` | `low` → `medium`，19 → 62 行 / 35 structural | 重算值越过 medium 阈值（30） |
| `components/SettingsPanel.tsx` | 新增条目：`high`，816 / 665 structural | 该文件一直有哨兵（`FORK_FEATURES`）却从未进 manifest，E1 的「`origin` 必须在 manifest」规则把它暴露出来 |

**已知缺口（部分闭合）**：drift 只校验「manifest 有条目但 risk 不符」，不校验「计算为 medium/high 却完全没进 manifest」。P0 阶段补全了 5 个**未登记的 high**（`hooks/useAgentSession.ts`、`lib/i18n/messages/{en,zh-CN,zh-TW}.ts`、`app/api/files/[...path]/route.ts`，全部 `"sentinels": "elsewhere"` 指向各自的专用测试），因此 `autoPushPolicy` 现在能拦住它们。仍有 22 个 medium 未登记，闭合它们需要逐条写 `reason`，属于独立工作量。

---

## 阶段 F：文档与测试治理

### F1 文档指针校验

`AGENTS.md` 459 行 + `docs/adr/` 7 篇 + `docs/agents/` 13 篇。这类文档的价值全部在于**指针准确**，一旦文件被移动/删除，读者会被误导。

**改动**：新增测试，抽取文档中的反引号路径与 markdown 链接，校验目标存在（白名单放外部链接、生成产物、`~/` 路径）。

### F2 测试分层

| 类型 | 位置 | 定位 |
|---|---|---|
| 合并哨兵（源码正则 / AST 提取 / JSX 结构） | `test/merge-guards/*.test.mjs` | 防「clean merge 但语义回退」，**保留** |
| 行为测试 | 与实现同目录 `*.test.mjs` | 防功能回归 |
| 纯函数表驱动 | `lib/**/**.test.mjs` 内 `describe` 或独立 `*.cases.mjs` | 抗重构 |

**迁移方式**：一次只搬一个文件，且必须先把该文件里至少 3 条 `assert.match` 改写成行为断言作为示范。不要一次性批量改名——那会让「哪些哨兵已经失效」无从判断。

### F3 性能：先测量再优化

`session-reader.ts`、`file-access.ts`、会话扫描中的同步 fs 调用是否构成瓶颈，目前**没有数据**。这些路径承载大量正确性注释，误改风险高于收益。

**改动**：`scripts/measure-session-scan.mjs`（造 10 / 100 / 1000 个会话文件，测 `listAllSessions` 冷/热耗时与 `readFileSync` 占比）。已有 `lib/session-list-scanner.bench.mjs` 可复用。

**在拿到基线之前不要改动这些路径。**

### F4 错误码集中

`AgentCommandError` 已带 `code`，但只有少数几个被正式定义。新增 `lib/agent-error-codes.ts`，让服务端 `{ error, code }` 的 code 集中定义、前端按常量判断，减少「新增错误分支忘记处理 → 静默失败」。

#### 实施状态：已落地（2026-10-22）

| 子项 | 交付 |
|---|---|
| F1 | `scripts/check-doc-links.mjs`（618 个引用）、`scripts/doc-link-allowlist.json`（8 条理由）、6 项测试、`npm run check:docs`、CI 步骤 |
| F2 | 哨兵文件迁到 `test/merge-guards/fork-extractions.test.mjs`（28 项）；新增 `test/merge-guards/README.md`；`run-tests.mjs` 扫描 `test/`；12 个引用同步更新 |
| F3 | `scripts/measure-session-scan.mjs`（子进程 + 临时 agentDir，冷/热两次测量）；实测：10 文件冷 20.8ms / 热 2.3ms，50 文件冷 44.7ms / 热 10.0ms |
| F4 | `lib/agent-error-codes.ts`（`prompt_rejected` / `invalid_command`）+ 两个 agent 路由与 `agent-client.ts` 改用常量 + 4 项测试 |

**F1 的三条判定规则**（否则全是噪音）：
- 只校验以仓库自有根开头的路径（`app/`、`lib/`、`components/`、`docs/`…）；
- 裸文件名（`settings.json`、`core/usage-totals.ts`）跳过——它们指运行期文件，不是仓库路径；
- 已刻意删除/示例/尚未创建/「明确说明不是路由」的路径进 allowlist，每条必须有理由，且 **allowlist 里未被引用的条目会让检查失败**（否则豁免会腐烂）。

第一次运行抓到 21 处，按原因分别处理：`lib/startup-preferences.ts`（刻意删除，3 处）、`app/api/models/test`（文档明说不是路由，2 处）、`components/McpPanel.tsx` + `lib/mcp-config.ts`（merge-history 的历史记录）、`lib/i18n/messages/ja.ts`（i18n 指令里的示例）、C 阶段尚未创建的 `lib/session/start.ts` / `lib/session/wrapper.ts` / `lib/composer-send.ts`；另有一处文档表述改为 `<agentDir>/desktop/cost-currency.json`（原写法会被当成仓库路径）。

**F2 的取舍**：计划要求「先把 3 条 `assert.match` 改写成行为断言再搬文件」，实际只做了迁移。原因是唯一符合条件的候选是 `components/ChatInput.test.mjs` 的 VM 测试，而它依赖 C2-5（抽出 `lib/composer-send.ts`）——在管线抽出来之前改写，只能把脆弱断言换成另一种脆弱断言。文档里保留了这条前置关系。

**F3 的结论**：先有基线，不改代码。50 文件冷启动 44.7 ms、热 10.0 ms，远未到需要优化同步 fs 的程度；`session-reader.ts` 保持原样。脚本用子进程 + `PI_CODING_AGENT_DIR` 指向临时目录，因此永远不会碰用户的真实会话。

**F4 的范围**：只收口 agent 路由的 HTTP 契约（2 个 code）。models/MCP/import 各有自己的词汇表，混在一起会让「这个 code 属于哪个契约」重新变模糊。

---

## 分支策略：独立发布 + 受控同步

本计划的任何阶段都**不**意味着与上游切割。先把两个容易混淆的概念分开：

| 概念 | 现状 |
|---|---|
| **独立发布** | **已经是**。`package.json` 为 `@agegr/pi-web` 0.10.0（非 private），`npm publish --access public`；Tauri 签名发布走 `release.yml`；组件版本清单走 `release:manifest` / `release:verify` |
| **与上游切割** | **尚未，且不应由这次重构触发**。当前形态是「独立发布 + 受控同步」 |

现状证据：`scripts/fork-ownership.json` 共 25 个被改动的上游文件，risk 分布 `high 7 / medium 5 / low 13`，disposition **全部 `accepted`**；`autoPushPolicy.blockOnRisk = ["high","medium"]`。也就是说上游同步早已是**人工把关的受控分叉**，不是自动跟随。

### 各阶段对合并成本的影响

| 阶段 | 动作性质 | 对「继续合并上游」的影响 |
|---|---|---|
| A（`lib/pi/` facade） | 全新文件 | 无影响（不进 `driftedUpstreamFiles`） |
| B（状态 reducer） | 新增 + 影子模式 | 无影响（切换前不改行为） |
| C1/C2-1~3（registry、commands、start） | 搬移 `lib/rpc-manager.ts` 内部 | 略增一次冲突，之后该文件对上游只剩薄壳 |
| C2-4（`wrapper.ts`） | 搬移上游改动最集中的部分 | 风险最高，须错开合并窗口 |
| C2-5（`lib/composer-send.ts`） | 抽 fork-owned 管线 | 降低冲突（`ChatInput.tsx` 更接近上游子集） |
| D（`lib/migrations/`） | 全新文件 | 无影响 |
| E/F（CI、文档、测试） | 全新 | 无影响 |

净效果：**合并成本持平或下降**。本计划不做「切到 forks 目录」这类动作，也不引入 SDK 打补钉机制。

### 反而降低切割必要性的理由

切割的真正成本不在 UI，而在 **SDK 适配**（1.4 节：SDK 无源码、约每月升级一次、`AGENTS.md:425` “Upstream owns SDK adaptation”）。切割意味着：自己承担每月适配；SDK 出 bug 时无源码可改，只能等上游或引入 `patch-package`；自己维护 `node-pty` / `quickjs-wasi` 的 staging、ABI 守卫与 `dedupeNestedPackages()`。

因此正确顺序是：**先有 facade，切割才「可承受」；没有 facade，切割等于一次性接手 70 个文件的 SDK 耦合。** 本计划做的是把切割变成可选，不是导致切割。

### 切割的触发阈值

达到以下任一条件时再讨论切割，而不是现在：

| 触发条件 | 当前状态 | 阈值建议 |
|---|---|---|
| 上游持续引入 fork 已明确拒绝的 UI | `AGENTS.md:426` 列了 7 项 declined | 连续 2 个上游版本需要回滚**同一项** declined UI |
| SDK 适配方向与 fork 需求冲突，必须改 SDK 内部 | 无冲突，走 facade | 需要 `patch-package` 才能修的问题出现 ≥ 2 次 |
| 人工审核成为瓶颈 | 12/25 文件使同步常走 PR | 连续 10 个上游版本中，人工修正 > 30% 的冲突文件 |
| 上游停止维护 / 换协议 / 许可证变更 | 无迹象 | — |

### 光谱与定位

```
L0 自动跟随        autoPushPolicy 允许 low-risk 自动推
L1 定期同步 + PR   ← 当前实际状态，也是本计划的目标位置
L2 选择性 cherry-pick   只吸收安全提交，跳过 UI 变更
L3 完全分叉        vendor SDK、自建迁移层、放弃 merge-guard
```

**目标：留在 L1，用上面的阈值决定是否降到 L2。** L3 需要一整套新基建（vendor SDK + 源码级维护 + 独立回归基线），代价远高于现在的合并工作。

---

## 排期与量化目标

| 阶段 | 内容 | 工期 | 可量化验收 |
|---|---|---|---|
| A | `lib/pi/` facade + `drift:sdk` | 1.5 周 | 31 命令 100% 有类型；`as unknown as` 41 → ≤34；棘轮入库 |
| B | 状态 reducer + 影子模式 | 1 周 | `isRunning()` 单一入口；retry/compaction 纯函数测试通过 |
| C | registry → commands → start → wrapper → composer | 2–3 周 | 单文件 ≤1,200 行；`as unknown as` ≤20；`wrapper.ts` 错开合并窗口 |
| D | `lib/migrations/` | 3 天 | 迁移入口 + 一次真实迁移（如 session `version` 读取） |
| E | CI 闭环 | 1 天 | drift + ownership 哨兵进 CI；lint 分层生效 |
| F | 文档/测试/基线 | 1 周 | 文档指针校验通过；扫描基线入库 |

总计约 6–7 周，每阶段结束产品行为不变、可单独发布。

---

## 未来压点预判

用于验证上面的排序：如果某个未来能力最先压垮的模块不在 A–C 覆盖范围内，说明排序需要重估。

| 未来能力 | 最先吃不住的地方 | 现在可预埋的最小改动 |
|---|---|---|
| 多会话并行运行（定时任务已并行） | running 集合、SSE 复用、idle timeout、通知去重 | 并发语义进状态 reducer，明确上限与回收 |
| 更多 MCP / codemode 工具 | 事件 wire 的透传面、`tool_execution_*` 裁剪 | 显式事件允许清单（A2） |
| 会话累积到千级 | 会话扫描索引、`file-access` 的 roots 重建 | 规模基准进 CI（F3） |
| 远程/移动访问（已支持 `dev:lan`） | `proxy.ts` 的 loopback 假设、单进程写锁 | 单实例 ADR（见下） |
| 桌面多窗口 | `globalThis` 会话注册表、桌面 token | 单实例 ADR + 每窗口 lease |
| 输入框继续加功能（语音、更多引用） | `ChatInput.tsx` 3,491 行 | 发送管线抽成纯函数（C2-5） |

### 单实例一致性 ADR（建议新开一篇）

`globalThis` 注册表、启动锁、SSE 广播隐含**单进程**，但产品形态允许桌面 App 与 `npx pi-web` 同时运行并共享 `~/.pi/agent`。代码里已有分散应对（scheduler 文件 lease、`removeStoredCredentialIfType` 的文件锁、`server-launcher.cjs` 的父进程看门狗），但**没有成文边界**。

ADR 应包含：哪些状态必须跨进程一致、用什么机制、哪些允许各进程独立，并附一张**写入路径清单**（新增写入点时在 PR 模板里勾选）。

---

## 明确不做

| 不做 | 理由 |
|---|---|
| 为减少行数搬移 upstream-owned 代码 | `fork-ownership.json` 的 `reason` 已明确这是「clean merge 后语义错误」的来源 |
| 引入 DI 容器 / 装饰器 | 一个目录 + 映射表 + 棘轮指标足够 |
| 引入 zod/valibot 统一校验 | 项目当前零此类依赖，手写窄化足够，且不扩大打包面 |
| 引入数据库替代 `.jsonl` | 破坏「与 pi CLI 共享会话文件」这一核心前提 |
| 拆后端进程 / 引入 worker | 单用户本地场景，收益远小于 IPC 与生命周期复杂度 |
| 按行数切割文件 | 只有按域拆分（如 `mcp-config-helpers.ts`）才是正确方向 |
| 删除源码匹配型测试 | 它们是 fork 合并的实际防线，应集中（F2）而非移除 |
| 在拿到基线前优化同步 fs 路径 | 正确性注释密集，误改风险高（F3） |
| 无触发条件就引入 `patch-package` / vendored SDK / 切割上游 | 见「分支策略」一节的阈值；当前目标位置是 L1 |

---

## PR 检查清单（护栏）

复制到 PR 描述，逐条勾选：

- [ ] 本 PR 是否**只做**结构变更或**只做**行为变更？
- [ ] 新增/修改的文件是否属于 upstream-owned？（对照 `fork-ownership.json`）改动后是否需要重算 `risk` / `structuralDrift`？
- [ ] 是否新增了对 `@earendil-works/*` 的直接 import？能否改走 `lib/pi/`？
- [ ] 是否新增了 SDK 事件分支？是否同步 `CLIENT_HANDLED_EVENTS`？
- [ ] 是否新增了会话命令？是否同步 `SessionCommand` / `CommandResultMap` / `COMMAND_META`？
- [ ] 是否新增了写 `~/.pi/agent/**` 的路径？是否需要文件锁？
- [ ] 跨文件移动了代码？是否加了 merge-guard 哨兵？
- [ ] 涉及 `useAgentSession` / `ChatWindow`？是否保留滚动 render 阶段保存、单调整数守卫、Strict Mode 挂载顺序？
- [ ] 涉及 `AppShell.tsx` 的 JSX 层级？`components/AppShell.right-panel-row.test.mjs` 是否仍通过？
- [ ] 新增数据文件或字段？是否需要 `lib/migrations/` 条目？
