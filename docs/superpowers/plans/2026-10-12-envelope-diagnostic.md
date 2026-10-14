# 请求外层格式只读诊断实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development. Root alone operates cloud services. No commits, installations, images, billing or formal release.

**Goal:** 在一次真实无图片调用中确认平台实际请求的字段名称，解释先前 `envelope` 拒绝。

**Architecture:** 不修改或放宽业务/图片入口。新临时包装先用已有身份 helper 验证有效五分钟口令、真实 SDK OpenID 摘要及固定环境唯一管理员，再读取外层字段名称；不读取其他字段内容。沿用原包回读、代码恢复与普通登录检查。

**Tech Stack:** Node.js、已有 CloudBase CLI 3.6.2、原包 wx-server-sdk、官方开发工具自动化连接。

**执行状态：** Task 1、Task 2 和 Task 3 的本次限定工作已完成。真实诊断与原包恢复通过；本地兼容修正通过回归及顺序规范/质量复核。用户随后明确允许一次官方静态测试图验证；Task 4 的打包前核对已完成，但测试图的浏览器预览被安全策略阻断，尚未部署或调用审核。

**后续状态：** 用户允许改用本地合成图。已完成一次真实审核请求，返回 `submitted:false / -604101`，无任务号；原接口恢复与测试文件删除均确认。没有再次提交，等待权限声明变更及下一次验证的明确授权。

## Task 1：专用临时入口

Ownership: `.release-evidence/api-envelope-diagnostic-20261012/` 中 `probe-native-submit.cjs`（原身份 helper 逐字节复制）、`probe-bridge.cjs`、`probe-index.cjs`、`diagnostic-run.mjs`、`diagnostic-check.cjs`。其余目录与云操作归 root。

- [x] 先编写并运行失败测试：额外平台字段在认证前不回显，认证后只返回字段名称；字段内容 getter 不执行；非法/过长/过多/含口令或账号值的字段名称不得回显；旧业务路由保留，失败独立恢复。

```js
const value = await main(
  { action: '__envelope_diagnostic_20261012', input: { token }, platformFlag: 'never-read' },
  context,
)
assert.equal(value.marker, 'envelope-diagnostic-v1')
assert.equal(value.stage, 'envelope')
assert.deepEqual(value.envelope, { keys: ['action', 'input', 'platformFlag'], keysMatch: false })
assert.equal(imageCalls, 0)
```

- [x] 原 helper 文件与前次字节完全一致。包装专用动作 `__envelope_diagnostic_20261012`，结果精确 `{marker, stage, checks, envelope}`，marker 是 `envelope-diagnostic-v1`。调用原 helper 仅传 own-data `event.input` 和可信 context，不能将外层其他键或 userInfo 作为身份。helper 的 `{checks:null}` 失败转为相同 stage、`checks:null,envelope:null`，认证失败不披露格式。
- [x] 只有原 helper 已通过真实身份/唯一管理员/时间窗口而返回十一项布尔时，读取 `Reflect.ownKeys(event)`。字段名最多 32 个，必须字符串、ASCII 标识符 `[A-Za-z_$][A-Za-z0-9_$]{0,63}`，不含实际口令、不含 64 位十六进制串或 `o` 加 27 位账号形式。拒绝 symbol、非法名、重复、越界时 stage `field_shape`、`envelope:null`；保留已认证布尔。任何字段值或 getter 均不读取。
- [x] 有效字段名称按 ASCII 排序，`envelope` 精确 `{keys,keysMatch}`；keysMatch 比较仅 `action/input` 加可选 `userInfo`。不匹配 stage `envelope`，匹配保留 helper 实际诊断 stage。不得通过放宽旧图片包装宣称图片审核可用。普通动作 `originalMain.call(this,event,context)` 原样转发。
- [x] 入口先 require 原包 original-main，再用原 SDK；不重复初始化、不增依赖。执行器复用原 API 控制器生命周期但去掉旧图片 invoke/record，自有真实官方 `wx.cloud.callFunction` 固定动作一次、25 秒限制、双层严格校验新返回形状，不返回原始错误/字段值。输出仅安全布尔/枚举/有限字段名称及整数错误码，私有回执独占创建。
- [x] 执行顺序 prepare/deploy/verifyDeployment/window/invokeDiagnostic/recordDiagnostic；更新尝试后独立 restore/verifyRestored/verifyLogin/dispose，包括部署回包失败。`--restore` 不生成新口令、不调用诊断，无自动重试。保持已有 CLI 45/180 秒边界、五分钟口令及最少 30 秒剩余。
- [x] 聚焦测试全通过后顺序规范、质量复核；不重跑无关全项目门禁。

## Task 2：一次真实调用、恢复与报告

- [x] 新鲜原包详情/权限摘要与代码下载；逐字节核对原包与前次已恢复版本，机械暂存不上传未完成工作树业务代码。
- [x] 仅更换临时代码包；真实管理员调用一次无图片诊断，不改环境、规则、存储、通知、套餐、业务数据。
- [x] 原包恢复并回读完整清单、关键字节、临时文件不存在、配置和规则，真实登录验证。若恢复未确认，仅执行恢复模式。
- [x] 保存真实字段名称与拒绝阶段。若认证前被拒，不猜测未知来源；若确认为平台额外字段，针对性准备本地格式兼容修正和回归测试。后续图片任务另需授权，不能冒充此次诊断。

## 实际根因与 Task 3：本地单项兼容修正

一次真实回执已经确认，外层键为 `action/input/tcbContext/userInfo`。十一项布尔观察中身份、角色、口令时间、命名空间、AppID 和运行环境均通过；实际来源精确匹配 `wx_devtools`，不匹配 `wx_client`。此前外层精确键检查只允许 `action/input` 加可选 `userInfo`，所以平台附加的 `tcbContext` 在进入照片提交器前即被拒绝。诊断和原包恢复均退出码 0，配置、规则、原清单、关键字节及普通登录通过。

Owned files for a fresh implementer: `.release-evidence/api-native-probe-20261012-context-compatible/probe-bridge.cjs`、`probe-native-submit.cjs`、`probe-index.cjs`、`compatibility-check.cjs`。只有本地准备，不创建 runner/bindings/staged，不部署、不调用照片审核。

- [x] 先按已获真实外层形状编写失败回归测试。机械复制前次开发工具版本的三个模块；只将 bridge 的可选外层字段从 `['userInfo']` 改为 `['userInfo','tcbContext']`，保持原动作与来源及 helper/入口全部字节不变。

```js
// Both metadata values are deliberately never inspected.
Object.defineProperty(event, 'tcbContext', {
  get() {
    throw new Error('must not read')
  },
})
const result = await bridge(event, context)
assert.equal(result.submitted, true) // Local fake provider response only; no cloud operation.
```

- [x] 验证可选 `tcbContext` 值从不读取、更不能作为身份；伪造 metadata 不能通过错误 SDK 身份/来源/环境、错误口令、非管理员、过期口令或未知额外字段。普通动作返回/抛出/receiver 不变。真实云端调用数必须为零。
- [x] helper 和 bootstrap 与前次源逐字节相等，bridge 差异仅可选字段清单与说明注释；聚焦检查后依次规范、质量复核。保存结果并请求下一次官方非学生测试图片提交授权，不把本地回归等同于线上照片审核完成。

## 本地修正与最终核对结果

完整限定差异只有 bridge 中可选键增加 `tcbContext` 和对应说明注释；不读取 metadata、不放宽来源或身份检查。helper 与 bootstrap 逐字节一致，既有专用动作与开发工具来源约束保持原值，未来执行器不需要假造回执来兼容。

旧桥接的真实形状回归先观察到 19/24 通过（有效 metadata 请求仍被外层拒绝），单项修正后 24/24 检查通过、退出码 0；主任务及两次独立复核均确认。这里是 24 个本地断言场景，Node 测试运行器汇总为 1 个检查文件，不与业务门禁测试数量混加。提供方是本地替身，没有真实 SDK 初始化或照片提交。普通路由、错误口令、伪造 metadata、错误真实身份/来源/环境、非管理员、重复角色、过期时间与未知字段的拒绝行为均保留。

真实无图片诊断证据：`.release-evidence/api-envelope-diagnostic-20261012/api-envelope-diagnostic-private.json` 和 `api-envelope-execution-summary.json`。原接口已经恢复且核对通过。兼容候选只保留四个本地文件在 `.release-evidence/api-native-probe-20261012-context-compatible/`，没有 runner、原包、暂存包、短时绑定或部署。已询问是否允许下一次官方非学生静态测试图验证；未用默认选项代替用户确认，未购买、提审、切换正式通知或发布。

## Task 4：用户授权的一次官方测试图与回调核对

用户通过问题回复明确选择“允许一次测试图验证”。本任务由 root 执行；不再修改代码、不开通收费套餐、不改真实学生卡片/通知/权限/正式版本。现有 helper 的固定图片为微信官方静态资源，不接收用户照片或任意图片地址。

- [ ] 新鲜下载原包、读取配置与 CUSTOM 规则摘要；完整文件哈希与最近确认原包相符，机械复制至本次目录的 original/staged。仅 staged.index.js 为包装，原入口另存 original-main，装入已复核的三个模块。
- [ ] 保持旧执行器源不变，调用 `execute(createController({directory: compatibleDirectory}))`。旧动作 `__media_native_probe_20261011` 与本地兼容包装匹配；真实 SDK 来源仍精确限定 wx_devtools。五分钟绑定、真实管理员映射、回读及调用前 30 秒边界不变。只调用一次，失败不重试图片。
- [ ] 无论提交结果如何，独立恢复原包、回读原清单及 11 个关键文件，确认配置/规则不变、临时文件移除和普通登录；恢复未确认时仅恢复或只读回查。
- [ ] 若返回 submitted:true，按实际 API 回执严格验证环境/name=api、任务号及摘要、时间，建立本次日志查询范围。不能把回执 name 改成旧专用提交器来套用验证器。只读 mediaSafetyProbe 的本环境 CLS 日志，用已有 collectEvidence 的通用任务结构匹配实际任务摘要，不返回原始日志或学生数据。若没有任务号则不做无效回调采集。
- [ ] 记录任务提交、对应事件、运行来源/AppID/环境匹配和最终结果各自状态；空日志不是绝对不存在，且测试日志链路通过不等于业务图片持久化与访问控制已完成。

### Task 4 本次未提交的具体边界

用户明确授权后，新鲜原包 6,857 个文件哈希再次与最近已确认原包相同；完整机械暂存核对通过。既有执行器 33 个 Node 用例和兼容检查文件的 24 个本地断言场景重新通过（运行器共 34 个条目），不重新运行全部业务门禁。没有创建短时绑定、部署代码或执行图片 invoke。

固定资源 HEAD 返回 200/image/png，但该元数据不能证明图片内容。Web 图片读取没有获得内容，随后内置浏览器明确拒绝访问原 newres.wechat.com 资源；尝试一张不同的官方公众号静态标识图（res.wx.qq.com/mpres 路径）也被安全策略拒绝。遵守拒绝边界，不通过其他浏览器、下载、代理或间接执行达到被禁止的图片查看目的；不推断它是审核 API、账号额度或回调配置错误。

截至本次结束，图片审核调用数为 0，没有 submitted/trace_id，没有回调查询、购买、正式版本操作或真实卡片变更。云端 API 本轮只读、未修改，无需再次恢复。需要用户提供一张确认没有个人信息的测试图，或明确同意改用本地非个人测试图并临时上传/审核后清理，再执行仍未使用的那一次审核授权。

## Task 5：已获用户确认的本地合成图

用户对“本地生成无个人信息测试图，临时上传、审核后删除，仍只一次、不购买不发布”回复 ok。本任务不访问或绕过先前被浏览器拦截的资源。图像由 root 生成，512×384 的几何色块 PNG；本地内容可检查，不含学生数据。

### 私有上传/清理辅助（实施者仅拥有两个文件）

Create `.release-evidence/api-synthetic-fixture-20261012/fixture-run.mjs` and `fixture-check.cjs`。root owns PNG and all cloud operations. Use TDD and sequential spec/quality review; no commits or installations.

- [ ] 先写失败测试，验证固定环境/AppID、随机限定路径、上传返回文件号精确对应路径、URL 只来自该文件的 HTTPS 临时地址、输出严格形状、错误不泄露原文/签名、删除只作用于该已确认文件；不自动重试。
- [ ] 导出 `uploadFixture(client,{cloudPath,base64})`、`getFixtureURL(client,receipt)`、`deleteFixture(client,receipt)`、`patchStagedMediaURL(source,url)`。只通过传入的真实官方自动化 client.evaluate；每步 25 秒边界。上传先核对实际 AppID 与普通 API login 的 admin 角色；文件写入开发工具自己的 USER_DATA_PATH（仅这张随机文件），随后 wx.cloud.uploadFile，固定 ENV。

```js
const receipt = await uploadFixture(client, {
  cloudPath: 'mediaSafetyProbe-fixtures/20261012/' + randomHex + '.png',
  base64,
})
const url = await getFixtureURL(client, receipt)
const staged = patchStagedMediaURL(originalHelperSource, url)
// No runtime/source/admin/nonce checks change: only the fixed test URL literal.
await deleteFixture(client, receipt)
```

- [ ] cloudPath 精确 `mediaSafetyProbe-fixtures/20261012/[0-9a-f]{32}.png`。receipt 精确 `{fileID,cloudPath}`，fileID 必须本 ENV 的 cloud:// 标识、无控制字符/query/fragment，路径后缀与随机 cloudPath 一致。上传前 PNG base64 严格检查、字节大小不超过 1 MiB；保存回执后 URL/删除前再次验证。所有异常只固定 errorKind，不输出原错误或 errMsg。
- [ ] URL 来自 wx.cloud.getTempFileURL 的唯一 fileList 条目、status=0 且 fileID 对应；HTTPS、无用户名/口令/fragment、受信腾讯云存储后缀域名（myqcloud.com/tcb.qcloud.la/tcloudbase.com/tcb.qcloud.com/cloudbase.net）、解码 pathname 以该精确随机 cloudPath 结尾，最大 4096 字符。该 URL 不输出、不写入普通报告，只存在私有暂存包。
- [ ] URL 机械替换函数只匹配 helper 唯一 `const MEDIA_URL = ...` 行，JSON.stringify URL，并校验除该行之外全部字节不变。canonical helper、bridge、bootstrap 和旧执行器不改。临时包后续由既有控制器做哈希/回读与恢复。URL 数据不作为 JavaScript 执行。
- [ ] 删除只有 wx.cloud.deleteFile 的唯一精确 fileID/status=0 回执才确认，未知/额外回执拒绝；不得删除目录、其他文件或学生照片。上传失败可能存在临时文件时 root 用精确已知 cloudPath 做只读回查，不猜测宽泛目标。认证/上传/链接失败均不进入图片审核。

### root 的一次真实操作

- [ ] 生成并本地查看 PNG；旧原包与未绑定暂存已有证据，重新确认云端 ModTime/配置未漂移后复用，不重复冷哈希全部 SDK。
- [ ] 真实管理员临时上传，私有保存 fileID/cloudPath/内容摘要/时间；取得该文件 URL，机械修改暂存 helper 唯一测试地址，核对鉴权正文完全相同。不修改环境、规则、真实业务记录或 canonical 源。
- [ ] 执行既有受限控制器一次；无论结果都恢复与回读原包/规则/普通登录。收到任务号后只读核对对应事件，不假造旧提交器名称。
- [ ] 无任务或未尝试审核时及时删除测试图；任务已受理时保留至收到终态或明确等待边界，再只清理这一个测试对象，确认删除回执。记录提交与回调各自状态，不宣称正式图片业务闭环或正式发布就绪。

### Task 5 实际结果与新阻塞

协作实施任务因用量限制终止，没有产生源文件；主任务未切换账号/模型或重复派发协作请求。在当前会话完成两个私有辅助文件，先观察 20 项缺失功能失败，再观察额外路径回归的一项失败，最终 21/21 通过；另做语法与逐项自查。本次没有第二个独立协作复核，不冒充此前兼容代码的独立复核覆盖新辅助。

实际本地图片 512×384、3,586 字节，仅绿/蓝色几何块与边框，已本地查看。通过真实管理员临时上传，回执环境及随机路径校验通过；临时 HTTPS URL 仅保存在私有暂存包的固定测试地址数据行，没有显示或写入普通报告，原鉴权正文与 canonical helper 完全相同。

复用旧执行器，实际只调用一次，回执 `submitted:false / -604101`。完整执行器汇总 `ok:true / phase:complete / cleanupFailures:[]` 只表示独立恢复与登录检查成功；进程因审核未受理退出码 1。无 trace_id，不发起无效回调查询，不能标记审核链路通过。

原包完整清单、11 个关键文件、临时入口不存在、配置/CUSTOM 规则及普通登录均确认恢复。随后只删除该上传回执指向的随机测试 PNG，服务回执唯一 fileID/status=0，删除退出码 0；本地 PNG 保留作为可重建副本。不删除学生文件、目录或其他记录。

新鲜线上原包和当前本地 api 均没有 config.json。实际旧 api 代码调用 `security.msgSecCheck`、`subscribeMessage.send`，本次临时 helper 调用 `security.mediaCheckAsync`。[CloudBase 官方排错说明](https://docs.cloudbase.net/faq/knowledge/cloud-call-604101-permission-error) 将 -604101 与 config.json 的 permissions.openapi 声明缺失/不正确关联，要求通过微信开发者工具重新上传使声明生效，并说明可能有约十分钟缓存。结合实际回执及缺少声明，这是下一项有证据的修复方向，不将缺少文件单独作为线上权限全貌的绝对证明。

下一步位置：api 云函数目录 → config.json → permissions.openapi；准备精确的接口清单，保留文字审核/通知既有用途并补图片审核，不使用通配或扩大客户端访问。未修改任何接口声明、服务权限或通知模式，已单独询问是否允许变更并再验证一次，不把本轮“一次”授权用于自动重试。

私有证据：`.release-evidence/api-native-probe-20261012-context-compatible/api-submission.json`、`api-execution-summary.json`、同目录 restored-readback；`.release-evidence/api-synthetic-fixture-20261012/fixture-intent-private.json`、`fixture-upload-private.json`、`fixture-delete-private.json`。任务号为空，回调状态未通过；没有购买、正式提审/发布或真实卡片数据变更。

## Task 6：补接口声明后的一次新验证

用户明确回复“允许补权限并验证一次”。新增 `cloudfunctions/api/config.json`，精确声明 `security.msgSecCheck`、`security.mediaCheckAsync`、`subscribeMessage.send`；不增加客户端调用权限，不发送通知。配置回归先因文件缺失失败，再通过。原有受限包装与合成图辅助重新通过局部检查，不重跑整个发布门禁。

- [x] 新鲜下载线上原业务包，确认与最近恢复包相同；仅添加 config.json，SDK 和业务文件不变。通过官方微信开发者工具 CLI 上传 basename 为 api 的私有目录，不上传尚未完成的工作树业务代码。
- [x] 回读运行配置、环境变量/触发器/访问规则及代码，确认除声明外没有变化；普通登录可用。按官方约十分钟缓存说明等待后，才创建短时口令。
- [x] 使用全新随机路径与新回执、新控制器目录进行一次合成图片审核；不复用已消耗口令或失败回执。无论结果，恢复原业务入口（保留已批准的权限声明），检查临时入口消失和普通登录。
- [ ] 真正受理后匹配真实任务回调，终态后只删除该测试对象；未受理则立即清理。记录任务、回调、业务接入状态，失败不自动再提交。

### Task 6 权限上传与业务恢复

官方开发者工具 CLI 指定私有 api 目录、固定环境和项目、remote-npm-install=false，退出码 0。18:20:25 回读运行时、内存、超时仍相同；环境变量、触发器和 CUSTOM 访问规则摘要均未变。其后的真实 login 返回 -504002 / code exit unexpected，未提交图片。只读运行日志确认该异常退出，未出现明确缺模块证据，因此不猜测唯一根因。

立即用原业务完整包加已批准 config.json 恢复代码。18:23 的真实普通 admin login 已恢复，运行配置/访问规则不变；线上下载的 6,858 文件完整哈希与原 6,857 文件加唯一 config.json 精确一致。新一次私有测试目录以此为恢复基线，已与旧已消耗绑定/日志隔离。图片调用仍为 0，等待官方权限缓存窗口后才执行本次唯一调用。

18:30:25 权限缓存等待窗口结束后，复用既有受限执行器进行本次唯一审核调用。18:31:31 实际回执 `submitted:true`，含真实任务号及一致 SHA 摘要；不是模拟结果。控制器退出码 0，`ok:true / phase:complete / cleanupFailures:[]`。部署与恢复时都额外核对 config.json 摘要；业务原包恢复、临时入口移除、运行配置/访问规则、普通登录全部确认。权限错误不再出现，但不能据此标记最终图片审查通过。

18:33、18:34 的两次本环境 mediaSafetyProbe 日志核对，未找到实际任务对应的事件；第二次返回行数 0，没有截断。不把空日志当成绝对不会回调。仅使用 api 实际回执构造本次任务范围，未伪造专用提交器名称，未重发图片。合成测试对象暂时保留供异步审查读取；需在终态或明确等待边界后精确清理，未改变真实业务图片状态。

本轮证据：`.release-evidence/api-openapi-permission-20261012/`（权限声明/官方上传/业务恢复）；`.release-evidence/api-permission-probe-20261012/`（独立新回执、恢复和回调记录）；`.release-evidence/api-permission-fixture-20261012/`（单个新随机对象的上传回执）。合成图暂存流程成功后，外层退出清理曾将同步 disconnect 的 undefined 当 Promise 调用 catch，导致该临时脚本退出码 1；disconnect 已执行，没有影响已验证的暂存包，也不把该脚本退出码标记为 0。实际审核控制器使用原有有界清理，真实退出码为 0。

### Task 6 收尾：请求已受理，最终回调仍未确认

本次实际只提交一次审核。等待约三十分钟，19:01 进行最后一项只读查询：真实回执保持 name=api，任务号摘要相符；收尾查询限定从提交时刻至当时，回执最多三十五分钟、窗口最多三十五分钟，仅查询本环境指定接收函数日志，没有扩大到其他用户或函数。最后返回行数 0、无截断；记录 absenceIsDefinitive=false，不推断迟到回调绝对不存在或归因某个未查明配置。

等待边界后按上传回执精确删除该合成对象，唯一服务回执 status=0，删除脚本退出码 0。保留本地 PNG 可重建副本，没有删除学生图片/记录。19:03 最终普通 admin login、运行参数、环境变量/触发器及 CUSTOM 访问规则检查再次通过，退出码 0；原业务入口已恢复且保留权限声明，无额外审核调用、通知、购买或正式发布。

结论：补权限及这一次真实请求验证完成，-604101 已不再出现；请求受理成功，不等于最终图片审核通过。回调链路仍未验证通过，业务持久化/照片访问状态/正式发布门禁也不能因此标为完成。对应第四项保留未完成状态；后续先核对平台消息推送绑定和真实投递，不自动重发审核。

最终证据：`api-permission-probe-20261012/final-validation-summary.json`、该目录最后 receiver-log-evidence 文件、`api-permission-fixture-20261012/fixture-delete-private.json`。

## Task 7：只读核对消息绑定与接收端空请求

用户回复继续后，先只读核对，不重发图片、不修改消息订阅或学生访问权限。通过已安装电脑操作组件 @oai/sky 选择真实微信开发者工具/云开发控制台窗口；未操作认证、安全设置或绕过浏览器拦截，也未使用控制台内嵌 URL/私有协议凭据做接口调用。后续界面文本仅保留可见名称/值，省略内嵌 URL。

19:07 左右实际设置页面：设置 → 其他设置 → 消息推送，模式为“云函数”；列表唯一 event / wxa_media_check → cloud1-d4g2ccxaq372d5eb6 / mediaSafetyProbe，操作是“停用 / 删除”，即当前启用。不能再以绑定缺失或停用作为已确定原因。函数列表确认已部署；普通日志页面能看到 API 本轮真实调用及普通维护函数报告，当前没有接收函数报告。

新鲜下载接收端，入口/诊断模块/package.json 与既有已核对源相同；package-lock 与 4 个 SDK 关键文件也匹配。只调用一次管理通道的空对象 {}，实际返回 received:true，退出码 0；没有 MsgType、Event、version、trace_id、用户数据或审核任务调用。仅写固定诊断日志，不发送通知、不写业务数据，也不把管理来源当微信真实回调。

19:14 相同 CLS 主题和 function_name:mediaSafetyProbe 筛选返回 12 行，找到一条固定诊断 marker，eventMatches=false、traceHash=null，无错误日志或截断。说明接收代码能运行，当前日志检索也能观察到普通控制调用。19:17 再查询真实任务提交前 5 秒至当时的限定历史窗口，仍只有该空请求控制记录，实际任务匹配数 0。管理空请求的 SDK 环境/AppID/source 缺失是预期控制现象，不代表真实平台事件的字段结论。

本轮缩小到平台事件投递段，尚未确定具体平台原因。没有盲改业务代码、扩大规则或标记回调通过。停用再启用现有测试绑定是验证“平台订阅实际应用状态”的下一项试验，不宣称它已确定能修复；须用户在 UI 动作前明确确认，并单独允许一次新的合成图请求。已询问，不沿用上一轮已耗尽的“一次”授权。

证据：`.release-evidence/api-callback-diagnostic-20261012/receiver-readback-check.json`、`empty-invoke-intent.json`、`empty-invoke-result.json`、`empty-invoke-log-check.json`、`historical-task-log-check.json`。本轮真实图片审核调用数 0。

## Task 8：用户批准刷新唯一绑定并再验证一次

用户明确回复“允许刷新绑定并验证一次”。通过官方云开发控制台，只操作唯一 event / wxa_media_check → cloud1-d4g2ccxaq372d5eb6 / mediaSafetyProbe：停用 → 确定，实际列表显示“启用 / 删除”；随后启用 → 确定，实际列表重新显示“停用 / 删除”。没有删除绑定、改模式、换环境/函数或触碰学生访问权限。11:23:00 UTC 刷新后再次读取页面，模式、绑定身份和启用状态均匹配。它是订阅生效状态试验，不声称已确定平台根因或最终投递通过。

- [x] 下载 API 新鲜原包，完整哈希与上轮保留权限声明的恢复包相符；新目录与旧已消耗口令/回执隔离。
- [x] 使用既有已检查合成 PNG、全新随机对象路径；仅暂存 helper 的固定测试地址数据行替换，鉴权检查不变。不使用学生照片。
- [x] 复用受限控制器，只调用一次。恢复原业务入口并回读原清单、关键文件、权限声明和配置/规则/普通登录。
- [x] 日志只查询本次真实任务，排除上一轮任务和空请求控制记录；三十分钟等待边界后精确删除本次对象。失败不自动新增审核请求、不购买、不发布。
- [ ] 真正观察到本轮任务对应的最终回调；当前限定等待窗口内未确认，不能标记通过。

本次独立目录：`.release-evidence/api-binding-refresh-probe-20261012/`、`.release-evidence/api-binding-refresh-fixture-20261012/`。

### Task 8 请求与恢复结果

新鲜 API 6,858 文件完整哈希与上轮恢复基线相同，原权限声明、运行参数、环境变量/触发器和 CUSTOM 规则不变。已有兼容模块的 24 项本地断言、合成图辅助 21 项和权限配置 1 项重新通过（Node 运行器 23 个条目）。生成全新随机对象与独立回执，只更改私有暂存测试地址字面量，鉴权正文不变。

19:28:23 本轮唯一真实审核请求返回 submitted:true，新的实际 trace_id/摘要已私有保存。控制器退出码 0，ok:true、phase:complete、cleanupFailures:[]；权限文件在部署/恢复回读中额外匹配，原业务入口、完整清单/关键文件、配置/规则及普通登录均恢复。没有部署未完成工作树的业务代码或重用上一轮口令。

早期两次接收日志查询返回 0 行，无截断，尚未找到新任务回调；不与上一轮任务或管理空请求混淆，也不把请求已受理当最终审查通过。本次仅刷新原绑定状态，没有变更推送模式或扩大调用权限。

待等待终态或本轮三十分钟边界后精确清理新合成对象，不新增审核请求。暂不将“尚未发布正式版”或某个平台条件猜测写为原因，公开参考没有给出本账号此问题的确定证据。

### Task 8 最终结果与清理

19:58:43 到达本轮三十分钟等待边界后，最后只读查询仍返回 0 行、匹配任务数 0、无截断。收尾查询保持真实 api 回执和任务摘要，查询起点为实际提交时刻，检查窗口最多三十五分钟；absenceIsDefinitive=false。只能确认本窗口未观察到回调，不能断言平台绝不投递或已找到具体根因。

随后仅删除本轮上传回执对应的合成 PNG，唯一服务回执 status=0，清理脚本退出码 0。本地合成图副本保留、可以重建；学生照片、业务记录及其他文件未删除。19:59:18 新鲜普通 admin login、运行配置、环境变量/触发器及 CUSTOM 访问规则检查均通过，收尾脚本退出码 0。原业务入口已恢复，权限声明保留；本轮除已批准的唯一审核请求外没有新增提交、通知、购买或正式发布，绑定仍保持启用。

结论：绑定刷新及一次真实受理验证已执行完并清理，刷新后回调链路仍未验证通过，不能记为图片审核业务闭环完成或正式发布就绪。已有证据排除了本轮缺少绑定、接收函数完全不能运行和日志查询完全无效；平台投递段仍需进一步定位，不再自动重复相同试验或改权限。是否采用其他回调方式、联系平台支持等外部动作，须明确范围后另行授权。

最终证据：`.release-evidence/api-binding-refresh-probe-20261012/final-validation-summary.json`、该目录最后的 receiver-log-evidence 文件、`.release-evidence/api-binding-refresh-fixture-20261012/fixture-delete-private.json`。

## Task 9：用户继续后，只读排除日志筛选遗漏并准备平台排查材料

没有重发图片、调用接收函数、修改规则/绑定或重复部署。接收源确认即使事件类型/任务不匹配也尝试写固定诊断日志；管理控制请求能运行且日志能读到。

20:11:16 的新鲜查询以相同环境的接收日志主题为范围，窗口 19:10:00 至 20:11:09（UTC+08:00），两条独立筛选：function_name:mediaSafetyProbe 返回 12 行，其中 1 条固定空请求控制记录；唯一诊断标记筛选返回同一条控制记录。本轮真实任务匹配均为 0，均无截断或未识别标记。覆盖了本轮等待边界之后的记录，但仍保持 absenceIsDefinitive=false，不把未观察到等同绝不投递。

官方 GetFunctionLogs 接口文档说明它已下线，因此没有尝试已弃用接口；GetRequestStatus 需要真实函数执行请求 ID，不能用审核 trace_id 替代。当前已知只有控制请求的执行记录，不能伪造真实回调请求来查状态。

已准备 `docs/PLATFORM-CALLBACK-SUPPORT-2026-10-12.md` 和仅含定位字段的私有材料，未向平台提交。下一步涉及外部协调：请官方依据真实审核任务号查询事件生成/路由/拒绝原因，并确认客户端 invoke 规则与平台投递的关系。在取得明确依据前不进行第四项猜测性修改或改接收架构。提交工单/发送诊断材料须用户授权，不把本轮“继续”解释为授权外部联系。

## Task 10：明确提交询问后的“继续”授权与工单界面阻塞

此前最终问题明确询问是否允许将诊断材料提交给腾讯云技术支持，并声明不含学生信息或凭据、不购买服务；用户随后回复“继续”，作为这次限定提交的直接同意。授权只适用于技术支持，不适用于公开社区、采购、新测试、权限或发布。

内置浏览器帮助中心目前仅显示公共社区 Issue 和 AI 助手入口，未将私人任务资料发往这些渠道。转到腾讯云官方在线支持，页面检测到既有登录账号，使用“立即登录”恢复会话。正式工单产品选择页 https://console.cloud.tencent.com/workorder/category 随后显示 Oops / 对不起，获取用户信息时遇到了错误，点击重试！。一次可见重试按钮操作后再次观察相同错误；没有反复尝试认证、另换账号或绕过网页调用私有接口。

截至 20:24（UTC+08:00），没有进入可确认的工单提交表单，没有填写诊断正文或上传附件，没有创建工单、购买或授权平台资源访问。仅将本地私有材料标记为用户已批准提交但界面阻塞；页面保留待用户恢复账号信息加载。不能把支持网站登录恢复当作工单已提交。
