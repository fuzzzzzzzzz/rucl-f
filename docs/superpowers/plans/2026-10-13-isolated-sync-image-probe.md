# 独立临时同步审核验证计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次是已批准的诊断，由当前主会话执行，不派发协作任务。

**Goal:** 用一个临时云函数从管理通道验证一次无个人信息 PNG 的同步审核，结束删除函数，不修改 api。

**Architecture:** 创建随机新名称的 Event 函数，使用现有已固定版本 SDK；继承环境默认 invoke=false，不创建 HTTP 路由或触发器。函数只接受五分钟随机口令与本次 SCF namespace；仅管理通道调用。一个不提交图片的 readiness 调用后，只执行一次检查，结果限制为布尔/枚举/整数。所有结果后都精确删除本轮创建的函数，再确认原规则和 api 状态/普通登录。

**Tech Stack:** CloudBase CLI 3.6.2、官方微信开发者工具仅用于该临时函数的接口声明、既有 wx-server-sdk 4.0.2、Node 内置测试。

### Task 1: 本地与边界

- [x] 只读确认 api Active、管理登录有效、通配拒绝学生、使用现有角色。
- [ ] 先运行 `node --test .release-evidence/isolated-sync-image-probe-20261013/probe-check.cjs`，确认缺失实现失败；实现后检查正确口令、错误环境、过期、仅准备调用、重复调用、提供方返回与异常隐藏。
- [ ] 本地源只保存在私有证据目录；不修改 cloudfunctions/api，不安装依赖、不提供用户可访问的新入口、不上传学生图片。

### Task 2: 单次真实验证

- [ ] 保存原 api 配置/ModTime/规则摘要及原函数名单，确认随机名称原先不存在。所有写操作只允许这个新名字。
- [ ] 官方声明仅 security.imgSecCheck；SDK 及函数代码用管理部署路径读回验证，runtime/handler/timeout/memory/namespace/无触发器及默认拒绝调用必须成立。部署失败也进入精确清理。
- [ ] 在接口声明准备成功后绑定短时口令，先确认 readiness（不调用图片审核），再保存已尝试标记并管理调用一次 check。失败不重发；不通过 event 伪造微信 OPENID/SOURCE，不把 IAM 控制请求冒充学生真机请求。
- [ ] 成功仅说明此接口在该管理调用上下文对该合成图可用，不代表已完成学生图片业务接入；管理上下文不支持则据实报告。

### Task 3: 清理

- [ ] 精确删除本轮唯一函数并确认原名单恢复；不删除 api、旧诊断函数、其他云文件或数据。
- [ ] 原 api ModTime/运行配置/规则摘要及普通管理员登录复查，保存固定字段结果。
- [ ] 不购买、不升级、不发布。临时函数源保留本地可重建副本；云端删除无法原地撤销，属于用户批准的测试收尾。

## 执行记录

本地入口先观察缺失实现失败，再通过8项检查。所用临时名称为 mediaSyncVerify20261013_fdbbe205，原先不存在；仅这个名称可以被部署、更新或删除，不复用 fn code update 对 api 的既有封装。

第一次准备返回 phase:readback，未执行图片检查；初次删除回查未立即看到名单恢复，后续独立查询确认临时函数已不存在，原7个函数均保留。补充安全元数据诊断及删除后的短时名单回查后，保持源、配置、规则不变重新准备同一临时名称成功；读回完整文件清单与关键文件相符。

真实元数据确认 Active / Event / Nodejs20.19 / index.main / 15秒 / 128MiB，使用既有角色且无触发器；运行配置差异为空。原 api 的 ModTime、环境变量/触发器/规则摘要未变；规则仍为原6条，临时函数没有显式允许条目、继承invoke=false。第一轮失败的具体单一根因仍未证实，不将新增诊断记录冒充已确定原因。

目前 prepared-summary.json 为 ready:true；等待约十分钟声明缓存窗口后才绑定新的五分钟口令。该等待期间图片审核调用为0，尚未确认接口可用。管理通道 readiness 成功后才执行一次 check；IAM调用不冒充学生真机身份。

### 最终结果

已等待声明窗口，绑定新的五分钟口令、回读临时包及私有访问规则。真实 IAM readiness 返回 ready:true，因此本次不是函数启动或准备阶段失败。随后仅发出一次 check，函数实际调用同步接口并返回 checked:true/status:error/code:-501001；没有自动重试，不能标记图片内容审核通过。

本地固定版本 wx-server-sdk 将 -501001 映射为 SYS_ERR / resource system error；提供方其他未映射错误也可能折叠到此码。因此只能确认当前管理调用路径没有得到审核通过结果，不能据此确定接口下线、配额耗尽、权限缺失、照片违规或唯一具体根因；也不能断言学生真机上下文同样不可用。本次测试图仅几何图形，与校园卡文字识别/OCR不是同一个接口。

执行汇总 ok:true/phase:complete/cleanupFailures:[] 表示控制流程和收尾完成，不代表审核通过。已精确删除 mediaSyncVerify20261013_fdbbe205，原 api 的 ModTime、运行配置/环境变量/触发器及访问规则未变，没有新建云存储对象。其后独立普通登录返回 ok:true/admin:true。本地源与合成图保留，可重建临时函数，但没有重建或再发图片请求。

证据：.release-evidence/isolated-sync-image-probe-20261013/execution-summary.json、final-summary.json；普通登录新鲜结果在 .release-evidence/sync-image-probe-20261013/login-diagnostic-summary.json。后续需要平台进一步定位通用错误，不把本次单次授权扩展为更多图片请求、开放客户端调用、购买或正式发布。
