# 同步图片审核单次验证计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次由主会话执行，不派发协作任务。

**Goal:** 在当前环境验证一次 security.imgSecCheck 是否可用，随后恢复原业务和接口声明，不开放回调入口。

**Architecture:** 使用线上原包的独立快照，仅在私有暂存包增加同步接口声明及短时管理员测试入口。合成 PNG 直接作为 Buffer 提交，不生成云存储文件；来源使用逐次 context，不用进程残留或调用者 event 作为身份。只执行一次真实审核，不自动重试。

**Tech Stack:** 官方微信开发者工具 CLI / miniprogram-automator、现有 wx-server-sdk、CloudBase CLI 3.6.2、Node 内置测试。

---

### Task 1: 前置检查

- [x] 只读确认 CloudBase 登录与 api Active。
- [x] 用官方 cli auto 打开既有隔离项目，确认真实 AppID 和普通 admin login；没有关闭其他应用或更改安全配置。
- [ ] 新鲜下载原包，记录完整文件清单、运行配置与访问规则摘要；独立生成声明包，仅添加 security.imgSecCheck，保留原三项。

### Task 2: 受限入口

**Files:** `.release-evidence/sync-image-probe-20261013/probe.cjs`、`probe-check.cjs`、`run.mjs`。

- [ ] 先写断言并执行缺失实现失败：`assert.ok(fs.existsSync(modulePath), '同步入口尚未实现')`。
- [ ] 实现严格动作/口令字段、五分钟窗口、逐次 context 环境/AppID/OpenID/source、管理员数据库角色复核；其他动作原样转发 originalMain。
- [ ] 保留 SDK 原生 openapi 代理，调用 `security.imgSecCheck({media:{contentType:'image/png',value:fixture}})`；结果仅固定状态/整数错误码。不打印原文、凭据或图片。
- [ ] 运行 `node --test .release-evidence/sync-image-probe-20261013/probe-check.cjs`，覆盖身份/上下文/重放/提供方返回/原业务转发；通过才允许部署。

### Task 3: 一次真实调用与恢复

- [ ] 官方 CLI 上传声明包，回读完整包及原运行配置/访问规则；声明缓存等待时不部署短时入口。
- [ ] 绑定新短时口令与当前管理员哈希，部署测试包并回读；仅一次调用。失败不自动重试。
- [ ] 不论部署或调用是否失败，独立恢复原包及原声明，完整清单回读、运行配置/规则核对、普通 admin login 检查。
- [ ] 保存固定字段汇总，清楚区分测试可用性与正式审核业务接入；不购买、不提审、不发布，不修改真实卡片记录。

实际遇到认证或受限上下文缺失时停止，不降低校验。当前授权仅覆盖这一次可用性验证，不覆盖永久切换业务审核架构。

## 本轮执行结果

- 已取得新鲜原包及 6,858 文件清单；声明包仅 config.json 改为原三项加 security.imgSecCheck。业务工作树和 SDK 未上传。
- 私有入口先因缺少实现失败，再通过 13 项本地检查；临时入口未部署，合成图未调用 OpenAPI，也没有创建云存储对象。
- 第一次官方上传声明后出现普通登录 -504002；原声明包恢复后仍有该异常。“仅更新代码”恢复使普通管理员登录恢复。初次该路径的收尾汇总标记 readback 失败，不冒充汇总通过；另做独立核对后确认当时 Active 且运行配置/规则摘要无差异。
- 按既有稳定代码恢复路径重新准备声明仍未通过；控制器未记录具体失败子步骤，因此不把错误归因于确定的依赖、权限缓存或图片接口不可用。没有自动重发任何图片。
- 最终独立恢复返回 cleanupFailures:[]，生成 restored-readback-W39CFU；完整原包校验、运行配置/规则和管理员登录通过。之后新一次只读普通登录再次返回 ok:true/admin:true。state-private.json 为 restored:true、auditInvocationAttempted:false、没有 declarationConfirmedAt。
- 因准备流程未通过，Task 3 的唯一审核调用未执行，同步可用性未验证；正式审核业务接入、正式发布条件未完成。后续架构试验应先明确新范围，不继续修改正在运行的 api。
