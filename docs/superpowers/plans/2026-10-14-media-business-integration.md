# 图片安全检查业务接入 Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: use superpowers:subagent-driven-development. 用户要求连续执行，不逐项询问继续；每个实现后先规格复核再质量复核。保留脏工作区，不提交、部署或购买。

**Goal:** 完成实际照片上传、状态查询、照片消费与访问检查及学生端等待代码，为正式部署做准备；不是只增加独立规则。

**Architecture:** uploadedFiles 内嵌mediaTask/audit，mediaAuditEvents用任务摘要作主键保存提前结果及索引；回调验真后事务保存，有MAC证明的结果才能批准。所有实际入口使用同一服务，照片保留期与任务等待期限分离。

**Tech Stack:** 现有wx-server-sdk、Node crypto、云数据库事务、TypeScript小程序、Vitest。不新增依赖。

**2026-10-14追加授权：** 用户明确允许将本轮改动提交并推送至现有GitHub仓库运行Windows/Linux CI；允许仅创建mediaAuditEvents集合并设ADMINONLY。该授权仅覆盖这两项准备操作，取代此前对它们的不提交/不创建限制；不授权业务部署、公网开放、其他权限修改、购买、提审或发布。

## Task 1：事务及审核服务

Files: 新增cloudfunctions/api/media-audit-service.js、tests/media-audit-service.test.js；复用media-safety/media-audit-binding/domain；暂不修改现有入口。导出createMediaAuditService({cloud,database,config,now})，方法begin(uploadTokenHash)、acceptCallback(decoded)、status(openid,uploadTokenHash)、requireConsumable(database,openid,uploadTokenHash,kind)、isFileApproved(database,fileId,kind)，及configured布尔值。

- [x] RED：空导出占位下执行至少“提前真实回调→begin→两份passed状态→可消费”和“伪造对象无写入”断言。

```js
const decoded = decodeSafeModeMediaCallback(encryptedRequest, config, { now: clock })
expect(await service.acceptCallback(decoded)).toBe(true)
expect(await service.begin(uploadHash)).toMatchObject({ status: 'passed' })
expect(await service.requireConsumable(db, owner, uploadHash, 'storage_scene')).toMatchObject({ fileId })
```

- [x] GREEN：实现以下精确规则，不把跨请求数据库写入当纯函数测试。
  - 配置是现有{token,encodingAESKey,appId}，缺/坏配置禁用照片服务，不影响普通登录；时钟必须正安全整数。
  - 等待期限35分钟，提前结果无绑定保留一天。begin在事务中登记submitting后外部调用SDK，一次临时地址获取及一次mediaCheckAsync；事务忙重试只重试事务，不重试SDK。
  - SDK保留callable openapi代理，通过cloud.openapi({appid:config.appId}).security.mediaCheckAsync；结果camel/raw字段必须一致、明确数字0及有效trace才能绑定。
  - 上传记录内嵌完整mediaTask。mediaAuditEvents记录仅版本、应用ID、traceId、绑定uploadHash、状态、first/lastReceivedAt、expiresAt、MAC。MAC用AES解码密钥和JSON定序数组，receipt/approval标签分离，恒时比较。
  - acceptCallback先用transitionMediaTask校验原认证对象，未经验证零数据库写入。事务保存提前结果；同结果不变，冲突为error，不能恢复passed。绑定已引用照片时仍能将冲突变为阻断，不能因referenced=true忽略冲突。
  - begin绑定事务检查原上传仍存在、未引用/清理、仍属于此次submission；读取提前结果时验证MAC、应用/任务一致、接收时间位于此次请求起止期限。不可给未知/旧/跨文件结果批准。
  - 通过时保存与身份/文件/用途/trace/期限/decisionAt绑定的approvalProof；requireConsumable校验该证明和原纯函数消费规则；isFileApproved另按已引用记录验证证明及身份文件绑定，不以过去的审核等待期限否定已完成合法审批。
  - status仅本人令牌、仅状态及expiresAt输出；pending/submitting过期在事务中转expired，passed已超消费期限只返回expired，不毁掉已引用合法照片的通过证明。
  - 全部数据库异常、MAC不正确、提前回调不一致、SDK超时/畸形等阻断；不抛给学生原始任务/地址/身份/错误。网络阶段有界（获取地址/审核提交各5秒），不自动重复审核。
  - 读取缺文档复用getOptionalDocument；事务忙复用withTransactionRetry。无日志、无秘密或文件ID返回给客户端状态响应。
- [x] GREEN复核：真实AES/SHA1、带读写冲突/回滚的内存事务边界，SDK仅在外部边界用完整结果双替身；覆盖并发、提前、晚到、重复、错误、清理/删除、MAC篡改、服务缺配置、上传与读取隔离及发布后保留期。
- [x] 规格复核及质量复核通过后进入Task 2。2026-10-14两轮复核通过；根任务独立重跑5媒体套件523项、完整门禁55文件1168项，均退出码0。此结论仅覆盖本地Task 1。

Run: `node node_modules/vitest/vitest.mjs run tests/media-audit-service.test.js tests/media-audit-binding.test.js tests/media-safety.test.js tests/media-callback-post.test.js`；cloud tsc与定向ESLint/Prettier。

## Task 2：实际API入口

Files: 修改cloudfunctions/api/handler.js、tests/backend-api.test.js；新增tests/media-business-api.test.js（如需共用内存数据库，提取至tests/helpers而不降低原断言）。

- [x] RED：先断言uploadPrivateImage缺图片同意时零上传；pending返回仅token/status；createFoundCard及交接消费pending失败且数据库/通知不变；getPrivateImageStatus外人不能查询；未批准文件不进入客户端查看地址的SDK签发路径（服务端提交微信审核所需的内部读取地址除外）。
- [x] 接入服务至运行时，以服务端配置构造，不接受客户端config/source/status；新增getPrivateImageStatus active策略，无approve/callback动作。
- [x] 上传照片使用独立`2026-10-14-image-v1`同意版本，调用begin并返回令牌及状态；原失败清理保持。consume和证明OCR前requireConsumable；发布、官方转交、交接的原事务仍消费一次。
- [x] temporaryFileUrl(s)传入明确kind并经过isFileApproved；官方地点的文字解锁保持，未批准旧照片不得解锁非官方地点。保持角色和本人身份约束。
- [x] 旧测试正常照片夹具改为真正v1审批完整记录，不删除原安全断言；补异常和并发回归。45项新增业务测试，含审核冲突、URL异常、并发交接幂等及显式证明保留期限；根任务7套件672项通过。
- [x] 规格/质量复核、后端全量测试通过。评审发现的重叠交接误报与重复审批状态已修复；真实证明保留期限在签名前后均检查。规格复审和质量复审均通过；2026-10-14 10:15根任务完整npm run verify退出码0，56文件1213项通过。

## Task 3：学生端同意及等待

Files: miniprogram/services/cloud-card-service.ts、shared图片等待组件、content-safety-consent.ts、涉及的found/transfer/claims页面、privacy文案和对应测试。

- [x] RED：服务端返回pending时不能调用发布/交接；检查失败不得消费；同路径稍后重试只查询旧凭证，不重传；不同登录账号不能复用缓存；缓存有界并尊重expiresAt；不暴露fileId。
- [x] 独立图片同意后上传。照片状态查询有界等待，短时间仍pending则明确提示“照片还在安全检查中，请稍后再次提交，无需重新上传”；后台任务继续，不自动再次提交审核。
- [x] 在内存按当前账号、用途、照片路径保留令牌/expiry，成功消费或拒绝/过期后清理；取消/替换照片适时丢弃本人旧上传；后台故障不演示成功。
- [x] 当前账号采用登录回包的服务器账号id，不能用部分显示的姓名/学号或readyPromise对象当缓存隔离键。登录刷新保留同账号可恢复等待，账号切换和未确认账号不复用旧上传。
- [x] 查询等待总时限20秒，单次网络查询另有5秒时限；状态异常、响应丢失及离页均不触发自动重复上传/检查。上传未确认时也有界退出，晚到结果不能继续发布或跨账号应用。
  - 阅读同意说明的时间不计入处理期限；启动连接等待另有上限，启动承诺永不完成时也必须释放按钮。5秒是单次查询超时，不是规定的轮询间隔。
  - 已有合法令牌遇到未知状态时阻断业务、保留令牌供稍后查询；迟到上传回包必须完整合法且仍属于当前账号/环境，才能保存令牌。畸形回包不得先保存令牌再校验。
  - 隐藏页面只阻止尚未发送的业务请求，不等同于主动丢弃照片；回到页面后可复用原上传。明确替换或取消照片才清理本人未消费上传。
- [x] 更新实际页面状态，按钮防重复与离页清理；学生可读提示，保留手动OCR输入，不把OCR当图片审核。
- [x] 规格/质量复核及客户端服务集成测试。发现并修复4项规格缺口及2项质量缺口，复审均通过；根任务独立213项客户端/后端专项通过，最新完整verify退出0，57文件1271项通过。仅证明本地Task 3，不代表线上部署、正式回调或最终真机验收。

## Task 4：配置、清理、部署包及发布审计

- [x] 新增mediaAuditEvents ADMINONLY本地资源契约及规则；消息记录一天无绑定后或上传已删后按_id分页清理；清理时限/游标/删除审批回归，不创建线上集合。32项真实处理器测试包含事务快照/冲突回滚及205条分页，另有2项嵌套删除回归；规格/质量复核通过。
- [x] 将media-safety、media-callback-post、media-audit-binding、media-audit-service四个实际安全模块纳入覆盖率关键文件门禁（语句/行/函数90%，分支85%），不能只统计旧模块。最新完整门禁已实际收集并逐文件通过，共11个关键运行模块；早期独立预检仅作为历史检查点。
- [x] 本地部署模板为API补齐三个既有MEDIA_CALLBACK环境占位项，资源检查拒绝缺失或源码真实值；不创建密钥、不增加函数和公网路由。原变量、函数与触发器保持。
- [ ] 正式签名接收函数/包与网关适配依据实际平台契约和官方协议实现。配置密钥不写源码；GET握手和真实HTTP联通独立验证，不假设纯POST测试是配置成功。
- [x] 本地隐私文案和审核员说明同步独立图片检查、等待重试、用途和旧记录限制；说明稿不冒充线上验收证据。
- [ ] 微信后台隐私/UGC等补充资料生效与实际图片处理一致，最新证据待核实。
- [x] 根任务最新完整npm run verify退出0：58文件1314项及全部代码门禁通过。独立复核实际coverage JSON四个媒体模块均达标。
- [ ] 最新云权限/索引/函数/任务、套餐/平台资料、CI和证据门禁逐项完成。现有30集合权限/42索引已只读核对，仍缺新集合、精确存储、正式回调、匹配CI和平台证据；10条通知投递失败待核实。不填写占位passed，不降低已批准门禁。
- [ ] 需要域名、公网设置、计费或敏感后台认证时向用户明确指出具体范围，其他可完成工作继续；真机保留最终待验项。完成状态只按完整正式准备范围判断。

## 当前完整目标审计

上一目标前任务属于进展：新增绑定规则与53文件/1086项本地验证。仍未证明实际上传/访问闭环、完整发布门禁、资源一致性、平台生效、CI或正式接收配置。当前goal保持active，不能把任一Task通过等同于整个目标完成。
