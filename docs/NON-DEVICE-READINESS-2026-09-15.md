# 0.6.1 非真机验收记录（2026-09-15）

## 结论

暂不可提审。代码检查通过，不等于最终提审证据齐备。没有提交微信审核、发布、购买套餐或修改十位学号规则。

## 代码与自动检查

- 主整改 PR：<https://github.com/fuzzzzzzzzz/rucl-f/pull/11>，已合并；实现提交 `5933e8e`，合并提交 `58782fb`。
- 主分支 Windows/Linux CI：<https://github.com/fuzzzzzzzzz/rucl-f/actions/runs/34955996528>，通过。
- 云端依赖打包修复提交 `ec62f8a`，PR <https://github.com/fuzzzzzzzzz/rucl-f/pull/12> 已合并；Windows/Linux CI <https://github.com/fuzzzzzzzzz/rucl-f/actions/runs/34957773586> 均通过。
- 追加修复后本地 `npm run verify` 通过：36 个测试文件、308 项测试；statements 84.98%、branches 76.64%、functions 86.81%、lines 88.22%，关键模块门禁通过。
- 五个依赖树均有效，npm audit 零漏洞；没有使用过期安全例外。
- 格式、客户端/云函数 lint 与 typecheck、云函数语法、图标、版本、资源契约、包体积、LF、密钥扫描及 diff 检查通过。主包源文件约 399 KiB。

## 云端部署与回读

目标 `cloud1-d4g2ccxaq372d5eb6`，通知目标保持 `developer`。

- 30 个业务集合全部 ADMINONLY，41 项索引全部匹配，云函数调用规则匹配。
- 四个函数新版代码已上传；最终状态均已观察为 Active。清理函数配置补齐 developer 和现有订阅模板，未输出或替换密钥。
- 四个最终云端部署包已下载到忽略目录核对：API 10 个、OCR 5 个、清理 6 个、删除 6 个源文件/配置与本地逐字节一致；四个包的入口均可加载，兼容依赖均为真实目录而非链接。没有对 downloaded worker 执行业务 main。
- 每日清理及每小时删除定时器仍启用；未手工触发真实用户清理或删除。
- API 非法 action 被新版 handler 拒绝：请求 `9fa7752c-7ea7-4ce6-9cb9-311b11c5d225`。
- OCR 无登录调用被拒绝：请求 `e9b6a10e-7393-4fa6-add7-0fe1fcc6b7c6`。
- 删除工作器未授权运维调用被拒绝：请求 `1757f06a-c856-4187-b997-18530d4b0e3d`。
- 上述仅证明启动与对应拒绝路径，不证明真机成功闭环、付费 OCR 成功或定时清理已执行。
- 只读聚合：notificationOutbox 与 dataDeletionRequests 均为空；fileCleanupJobs 有 8 条 done。历史 done 标记不能证明本轮真实文件删除验收。
- 存储仍为 PRIVATE，没有切换权限；不把它记作 ADMINONLY 契约通过。
- 套餐只读回查为个人版、NORMAL，有效期至 2027-01-13 23:59:59；未购买或升级。
- 经用户要求继续，按固定截止时间 2026-07-17T15:20:07.176Z，仅删除 createdAt 早于截止时间的 8 条 auditLogs 与 5 条 messages，随后同一条件统计归零。删除请求分别为 `24788f1e-1a31-4dcb-8ff4-ad2773281cf5`、`cd687af7-6b66-4f26-8b50-572f5670f6fa`；没有删除账号、认领、卡片或照片，没有保留本地过期信息副本，不提供本次操作直接恢复。

## 部署故障及恢复

CLI 的“Code updated”只代表更新请求成功，不代表最终函数可运行。首次在线安装的兼容依赖存在链接打包问题，试调用返回启动异常；改用本地 tarball 后在线安装仍发生 `ResourceNotFound.Package`。先恢复原函数，确认 API 可执行，再改为携带已安装依赖部署，最终新版 API/OCR/删除工作器能正常进入权限校验。

当前四个函数 `installDependency: false`。部署前必须分别执行各云函数目录的 `npm ci`，再执行完整门禁；不得只上传源码或依赖云端重新安装。兼容包使用随仓库保存的 tarball，回归测试验证其内容与源码一致、安装结果不是符号链接且 SDK 实际可调用。已保存的旧云端代码备份位于被忽略的 `.release-evidence/rollback-*-20260915`，不得提交其中内容。

## 仍缺证据及解除步骤

1. 开发版上传已解除：用户开启服务端口后，CLI 确认登录并成功上传 0.6.1，实际包 398299 字节（约 389 KB）。回执保存在忽略目录 `.release-evidence/upload-0.6.1-20260915.json`；未提交审核或发布。
2. 真机与切换：本轮不执行真机；接近 2 MiB 的 OCR 传输、照片清晰度、三角色闭环和新版兼容需最终开发版复验。验收通过、用户切换和维护窗口就绪后才切 ADMINONLY 并回读、验证拒绝访问；当前套餐支持情况尚未通过实际切换证明。
3. 微信后台：隐私指引生效状态、类目、订阅模板字段及审核说明仍需最终页面证据；不沿用未经确认的旧建议。
4. 密钥轮换：曾暴露密钥的轮换状态尚无确认，不索取或展示新密钥。
5. 定时运行已补充证据（2026-09-16）：实际任务使用 `maintenanceState/scheduledCleanup`，并非此前误查的 `cleanupCheckpoints`；后者为空不能证明任务没有执行。只读回查显示更新时间为北京时间 2026-09-16 03:00:24.881，lastCompletedPhase 为 notifications、nextPhase 为 expiredCards、游标为空，与完成一轮清理相符。当前超过 60 天的 auditLogs/messages 数量均为零；notificationOutbox 和 dataDeletionRequests 为空。请求 ID：`b9f92bff-a91e-427a-98b6-af3e658bc8ae`。此证据确认清理任务实际推进，不代替所有异常、照片删除及账号删除的真机验收，也不证明尚无待处理申请的删除 worker 已执行真实删除。

以上任一阻断未解除，不标记“可以点击提交审核”。
