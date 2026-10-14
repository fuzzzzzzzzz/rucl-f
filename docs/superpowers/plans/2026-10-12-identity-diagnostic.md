# 图片安全入口身份诊断实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development; root alone performs cloud operations. No commits, installations, paid resources, image submissions, or formal release.

**Goal:** 用一次不含图片的真实开发工具调用定位此前 `unauthorized` 的拒绝位置，随后恢复原业务包。

**Architecture:** 在新私有目录 `.release-evidence/api-identity-diagnostic-20261012/` 使用原包入口包装。沿用已验证控制器的管理员映射、短时摘要绑定、代码回读和独立恢复，丢弃它的图片调用/任务记录方法。新 helper 仅检查真实 SDK 上下文和本人管理员角色，不含图片地址或审核接口调用。普通业务动作原样转发。

**Tech Stack:** Node.js、已安装 wx-server-sdk、CloudBase CLI 3.6.2、官方 miniprogram-automator。

## Task 1：只读诊断入口及有界执行器

状态：以下实现与聚焦验证均已完成；规范、质量复核通过。

Owned files in the private directory: `probe-native-submit.cjs`, `probe-bridge.cjs`, `probe-index.cjs`, `diagnostic-run.mjs`, `diagnostic-check.cjs`。文件名沿用旧包清单以复用恢复控制器，但新 helper 不是图片提交器。

- [ ] 测试先行：真实 helper 的管理员/口令/时间检查、缺失上下文、未知字段和 getter、角色不存在/重复/错误、来源及环境比较；测试入口正常转发和诊断执行失败后独立恢复。新增功能不存在时先观察失败。

```js
const result = await diagnostic({ action: '__identity_diagnostic_20261012', input: { token } }, context)
assert.equal(result.marker, 'identity-diagnostic-v1')
assert.equal(typeof result.stage, 'string')
assert.equal(providerImageCalls, 0)
```

- [ ] 精确专用动作是 `__identity_diagnostic_20261012`。只接受 `input.token`，仅容忍平台的顶层 `userInfo` 键且不读取它。失败仅返回固定拒绝枚举及 `checks:null`；不得输出额外键名、异常、环境值、账号标识或口令。
- [ ] 完整布尔观察必须先有有效五分钟口令、真实 SDK OpenID 与绑定管理员摘要一致、固定环境的唯一管理员记录。角色检查只读 `users.where({openid}).limit(2)`，显式固定环境，不能创建账号或写入任何记录。来源和命名空间是被观察对象，不作为授予图片操作权限的旁路：此入口根本没有图片操作。
- [ ] 返回值精确为 `{marker, stage, checks}`。布尔字段固定为 `sdkShapeMatches`、`namespaceMatches`、`contextNamespaceMatches`、`wxEnvironmentMatches`、`wxEnvironmentPresent`、`appIdMatches`、`sourceClientMatches`、`sourceDevtoolsMatches`、`callerMatches`、`roleMatches`、`windowMatches`。正常比较后的 stage 按旧拒绝顺序取 `sdk_shape / namespace / source / app_id / runtime_env / caller / role / ready`；前置失败枚举为 `envelope / input / config / nonce / expired / runtime / admin_lookup / already_used`。只返回这些字段和枚举，不返回原始来源或其他上下文。
- [ ] `diagnostic-run.mjs` 导入旧控制器 `createController` 以复用 prepare/deploy/readback/restore/login/dispose，但移除旧 `invoke / record` 方法；只增加 `invokeDiagnostic / recordDiagnostic`。调用真实 `wx.cloud.callFunction` 一次，25 秒上限，严格验证诊断形状；回执不含 submitted/trace 字段，也不伪造图片回执。
- [ ] 新执行器的唯一操作顺序为 prepare → deploy → verifyDeployment → window → invokeDiagnostic → recordDiagnostic；无论失败均独立 restore → verifyRestored → verifyLogin → dispose。`--restore` 只恢复、不生成口令或调用诊断。不自动重试。读写 CLI 的既有 45/180 秒上限、五分钟窗口与调用前最少 30 秒不变。
- [ ] 相关检查通过后，依次进行规范、质量复核，不跑无关全项目测试。

## Task 2：root 的一次真实诊断和恢复

- [ ] 新鲜回读 API 状态、配置和 CUSTOM 规则摘要，确认原包来源与恢复后已验证原包一致；机械复制原包与 SDK，不上传工作树中的未完成后台功能。完整路径清单及关键字节核对，恢复包保留。
- [ ] 只更新临时代码包，不改环境变量、权限、通知、云存储、套餐和真实卡片；真实管理员以短时口令执行一次诊断，不发送任何图片。
- [ ] 用原包恢复，确认完整清单、11 个关键文件哈希及无临时文件，环境和 CUSTOM 规则不变，普通登录正常；若恢复失败仅运行恢复模式。
- [ ] 将实际拒绝位置记入状态报告。得到诊断不等于图片审核通过；只有有证据的根因才能提出单项修复。任何后续图片审核任务不得冒充本次无图片诊断。

## 当前只读排除项

本次真实管理员登录成功；按本人编号查询唯一记录、按该记录 OpenID 查询同一账号最多两条记录，实际仅一条且角色 admin。未发现重复账号导致旧 helper 的唯一性检查失败。查询不输出标识，不涉及任何卡片数据。

## 实际执行记录

五个专用文件已实现，先观察 29 项缺失功能失败，最终聚焦检查 36/36 通过；规范、质量复核依次通过。未重跑无关完整项目检查。新鲜下载原包的全部 6,857 个文件哈希与前次保留原包一致；未绑定暂存包的完整清单及原文件字节核对通过，未修改 SDK 或业务文件。

本次只调用了一次无图片诊断，真实回执为 `identity-diagnostic-v1 / envelope / checks:null`。这把拒绝位置缩小到临时桥接的请求外层格式检查，尚未进入真实身份/角色比较；不能据此判断具体额外字段、来源或环境，也不将其写成照片审核成功。下一步需要诊断平台实际请求外层结构，不能猜测未知字段并直接放宽规则。

第一次流程退出码 1：诊断回执保存成功，恢复更新及普通登录成功，但 `verifyRestored` 未完成确认。执行器没有返回该恢复检查的原始异常；因此不推断具体失败原因。随后仅执行恢复模式，不生成口令、不再调用诊断或照片审核；最终结果另行补记。

恢复模式最终退出码 0，`ok:true / phase:complete / cleanupFailures:[]`。完整原包清单、11 个关键文件哈希和临时文件不存在检查通过；环境/权限规则保持原值，真实普通管理员登录正常。不声称本次恢复回读的全部 SDK 文件均逐字节重算。

私有证据位于 `.release-evidence/api-identity-diagnostic-20261012/`：`api-identity-diagnostic-private.json`、`api-identity-execution-summary.json`、`api-identity-restore-summary.json` 和 `restored-readback-ct3UuZ/bundle`。没有图片任务、真实卡片写入、购买、正式通知切换、提审或正式发布。
