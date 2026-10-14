# 临时 API 原生审核验证计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 在用户明确允许的现有 `api` 通道验证一次官方非个人图片，并移除临时入口；不购买、不改变卡片数据、不正式发布。

**Architecture:** 基于新下载的线上 API 原包，仅包装 `index.js`。普通动作原样转发，专用动作使用已有原生提交鉴权组件；临时包内只有管理员和随机口令摘要、五分钟截止时间，不改线上环境变量、权限或通知设置。执行结束用原包恢复，并下载比对和验证登录。

**Tech Stack:** Node.js、已有 wx-server-sdk、官方 CloudBase CLI 3.6.2、微信开发者工具官方自动化 SDK。

## Task 1：受限桥接入口

Files: `.release-evidence/api-native-probe-20261011/probe-bridge.cjs`、`probe-index.cjs`、`probe-bridge-check.cjs`。

- [x] 先写转发、非法请求、短时配置、原生鉴权、幂等和初始化检查，执行 `node --test .release-evidence/api-native-probe-20261011/probe-bridge-check.cjs`，观察新增入口不存在导致的失败。
- [x] 实现 `createApiProbeBridge({ originalMain, cloud, bindings, actualEnvironmentId })`，只有 `action === '__media_native_probe_20261011'` 时拦截，接受 `input: { token }`；平台附带的 `userInfo` 不参与鉴权。其他动作保持原参数、this、回包和异常。
- [x] 入口调用固定环境和 AppID 的 `createNativeMediaSubmit`，沿用 SDK 原生来源、当前管理员摘要、实时角色、短时令牌、固定官方图片及单进程闭包内一次调用限制；不声称跨实例全局幂等。配置无效仅拒绝测试，不破坏普通动作。
- [x] `probe-index.cjs` 连接原版 `original-main.cjs`、SDK 同一实例、`probe-bindings.json` 和桥接模块；不修改原初始化。
- [x] 重跑相关检查；规范、质量复核均通过，桥接聚焦检查 16 项通过。本轮不提交 Git，不把私有包纳入生产源码。

## Task 2：打包、一次调用和恢复

Files: `.release-evidence/api-native-probe-20261011/original/`（原包，只读）、`staged/`（临时包）、`api-run.mjs`、`api-run-check.cjs`。

- [x] 通过官方客户端刷新 AppID 与管理员登录，仅按本人账号编号查询唯一管理员映射；口令使用 `randomBytes(32).toString('hex')`，明文只留控制进程。
- [x] 机械复制原包，核对所有原文件仅入口允许改变；原包含 6,857 文件，暂存包的 6,856 个非入口原文件全字节核对一致，原入口备份及原生 helper 复制一致。摘要配置在执行时生成，固定 `tokenHash`、`adminOpenidHash`、`notBefore`、`expiresAt = notBefore + 300000`，不修改 SDK 或业务处理文件。
- [x] 保存不含环境秘密的原包摘要及恢复日志，检查原 API 的状态、环境变量摘要和调用规则仍一致；只执行 `fn code update api --dir staged`，不执行配置更新或权限操作。
- [x] 等待 Active 并下载回读关键代码匹配，确认窗口至少剩余 30 秒；真实客户端仅调用一次 `api / __media_native_probe_20261011`，严格验证回包，不自动重试，数字错误码可以记录，原始异常与身份值不得输出。
- [x] 无论部署/回读/调用是否失败，都用 `fn code update api --dir original` 恢复；验证恢复包的完整文件清单、无符号链接、11 个业务/入口/SDK 关键文件字节，以及原环境、CUSTOM 权限模式和规则未变，并验证普通登录可用。执行窗口内不重复 6,857 文件冷读取；这不是恢复包全字节证明。恢复失败只运行恢复模式，不重复审核。
- [ ] 真实 task 回执与对应回调另行核对；取得 task 不等于图片通过。没有对应证据不得将内容安全或正式发布门禁勾为通过。

## 交付边界

本轮只针对新入口和恢复跑相关测试；本地业务代码没有变时，不重复全部 762 项测试。保留已有失败与本轮实际结果，更新真机前状态报告。旧临时函数继续关闭，真实卡片记录、照片、通知及正式版本不变。

## 2026-10-11 实际执行结果

桥接 16 项检查通过，控制器 30/30 聚焦测试通过；权限模式遗漏先由测试复现，再要求唯一 CUSTOM 条目修复，最终规范、质量复核通过。线上仅部署临时包并调用一次，21:04:56 返回 `submitted:false / unauthorized`，没有任务号；没有重试图片审核或检索虚构回调。

第一次自动恢复的 `restore / verifyRestored` 失败，首次恢复回读仍含临时文件，不记为成功。随后仅执行 `--restore`，最终退出码 0，恢复、关键代码回读、环境/规则及普通管理员登录均通过，临时入口已移除。私有脱敏结果位于 `api-execution-summary.json`，保留首次失败与恢复证据。

本地 helper 强制 `SOURCE === 'wx_client'`，而此次调用来自开发者工具。官方资料区分 `wx_devtools` 与 `wx_client`（[CloudBase 官方说明](https://docs.cloudbase.net/vm/access_vm)）。这提供了来源不匹配的排查方向，未取得本次服务端来源枚举，不能直接断言唯一根因。不能跳过 AppID、SDK 身份、管理员、短时口令及环境检查；再次临时部署/调用应取得新的明确授权，本次一次调用不自动重开。

## 用户续授权后的开发工具专用验证

用户明确同意：“允许继续一次验证”。新私有目录 `.release-evidence/api-native-probe-20261011-devtools/` 中仅增加显式 `expectedSource` 配置：默认依然是精确 `wx_client`，这个临时桥接固定为精确 `wx_devtools`，不接受其他来源或绕过身份。机械差异和旧保护回归共 40/40 通过，规范与质量复核通过；线上业务源码未作相应修改。

第一次新部署失败于 `deploy`，没有进入 `invoke`，图片接口调用为零。恢复、回读和普通登录成功；该轮日志、过期摘要配置和基线保留在 `deploy-failed-no-invoke-1/`。失败类型当时未保留，不能事后断言原因。

本地 CLI 源码显示默认 COS 路径会打包两次，因此仅将更新等待上限从 120 秒调至 180 秒，并补上白名单失败类型；读取仍为 45 秒、口令窗口仍为五分钟、调用前仍至少剩余 30 秒。新增测试先失败后通过，控制器现在 33/33，通过最终规范和质量复核。没有增加自动重试逻辑。

保留无调用失败证据后，进行一次有界的手动部署补试，21:29:48 仅调用一次，依然为 `submitted:false / unauthorized`。最终恢复流程全部通过；进程退出码为 1，因为图片未提交，返回中的 `ok:true` 仅表示控制流程及恢复成功，不能写成审核成功。新回读目录 `restored-readback-mJUdpA/` 确认无临时文件、关键原文件及完整清单一致，环境/CUSTOM 规则未变，普通管理员登录成功。

来源单项调整未消除拒绝，也没有本次服务端校验分项结果；真实 SDK 来源、AppID/身份/环境或角色等具体拒绝位置仍未知。没有再发图片请求、虚构任务/回调、修改卡片记录、购买资源、正式通知或正式发布。这轮授权已用完，后续若需临时服务端分项诊断，应明确说明仅返回固定枚举/布尔、无图片提交，并重新取得授权。
