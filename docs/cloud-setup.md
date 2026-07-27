# 微信云开发部署说明

当前环境 ID 已写入 `miniprogram/config/cloud.ts`。客户端只使用云端数据；登录失败时进入只读错误态，不会写入本机演示记录。

## 1. 数据库集合

`resources:deploy -- --phase=preflight --apply` 会以幂等方式创建缺失集合，并回读确认权限。集合范围如下：

- 身份：`users`、`userKeys`、`identityBindings`、`identityCorrectionRequests`；
- 核心：`foundCards`、`lostReports`、`matches`、`claims`、`claimAttempts`、`claimDecisions`、`handovers`、`messages`、`notificationOutbox`；
- 文件：`uploadedFiles`、`fileCleanupJobs`；
- 运营：`recordReports`、`reportRateLimits`、`riskReviews`、`feedback`、`dataDeletionRequests`、`deletionReceipts`、`dataIntegrityEvents`、`auditLogs`、`maintenanceState`、`cleanupCheckpoints`、`operationalMigrations`。
- 兼容与基础配置：`campuses`、`locations`、`reports`、`systemConfig`。即使旧集合已不再由当前代码写入，也必须保持 `ADMINONLY`，不得遗留客户端直读权限。

所有业务集合均设置为 `ADMINONLY`，客户端不能直接读写，小程序页面只调用经过鉴权的云函数。机器可读的集合和索引清单以 `security/cloud-resource-contract.json` 为准。

## 2. 主要查询形状

下表用于人工理解常见查询，不是部署清单。期限、outbox、删除 worker、消息未读、举报争议、文件反向引用等完整索引均由 `security/cloud-resource-contract.json` 声明，并由 `resources:deploy` 创建、`resources:readback` 回读；不要在控制台凭本表手工猜测或补建。

| 集合                         | 主要字段                                      |
| ---------------------------- | --------------------------------------------- |
| `users`                      | `openid` 升序（唯一；仅在迁移零冲突后创建）   |
| `foundCards`                 | `publisherOpenid` 升序、`createdAt` 降序      |
| `foundCards`                 | `studentHmac` 升序、`status` 升序             |
| `foundCards`                 | `status` 升序、`createdAt` 降序               |
| `lostReports`                | `ownerOpenid` 升序、`createdAt` 降序          |
| `lostReports`                | `ownerOpenid`、`studentHmac`、`status` 均升序 |
| `lostReports`                | `studentHmac`、`status` 均升序                |
| `claims`                     | `applicantOpenid`、`status` 均升序            |
| `claims`                     | `publisherOpenid`、`status` 升序              |
| `handovers`                  | `publisherOpenid` 升序、`completedAt` 降序    |
| `handovers`                  | `applicantOpenid` 升序、`completedAt` 降序    |
| `handovers`                  | `officialPointVerified` 升序                  |
| `messages`                   | `recipientOpenid` 升序、`createdAt` 降序      |
| `identityCorrectionRequests` | `status` 升序、`createdAt` 降序               |
| `recordReports`              | `status` 升序、`createdAt` 降序               |
| `fileCleanupJobs`            | `status` 升序、`notBefore` 升序               |
| `uploadedFiles`              | `fileId` 升序                                 |
| `uploadedFiles`              | `referenced` 升序、`createdAt` 升序           |
| `auditLogs`                  | `openid`、`action` 升序，`createdAt` 降序     |

`identityBindings` 使用学号 HMAC 作为文档 `_id`。旧数据中的 `identityStatus: verified` 兼容读取为 `profileBindingStatus: locked`，但界面不会宣称完成学校身份核验。

## 3. 云存储规则

云存储安全规则设置为客户端读取一律拒绝；只有非匿名登录用户可向 `temporary-cards/` 临时前缀写入自己创建的文件。规则修改通常需要约 1–3 分钟生效，部署后必须等待并运行远端回读校验。

长期保存的存放环境照片和取卡证明不由小程序直接调用 `wx.cloud.uploadFile`。小程序先把照片压缩到 1MB 以内，再调用 `uploadPrivateImage`；云函数保存文件并只向小程序返回一次性随机凭证，不返回文件 ID。后续发布、转交或完成交接时，云函数核对凭证所属账号和用途，业务记录中只保存服务端文件 ID。

校园卡原图是例外：它只上传到 `temporary-cards/{openid}` 供 OCR 使用，识别函数在 `finally` 中立即删除；删除失败会进入 `fileCleanupJobs`。

`security/storage.rules.json` 与资源契约保持一致：

```json
{
  "read": false,
  "write": "auth != null && auth.loginType != 'ANONYMOUS' && resource.openid == auth.openid && /^temporary-cards\\//.test(resource.path) == true"
}
```

长期照片由云函数创建，因此普通小程序账号不是文件创建者。环境照片只有云函数完成认领权限检查后才生成短时地址；取卡照片只有管理员处理争议时能生成短时地址。这个边界仍必须按 `docs/RELEASE-GATE.md` 使用多角色真机实测，不能只依赖代码判断。

## 4. 云函数与环境变量

四个函数均使用 Node.js 20：

- `api`：`STUDENT_HMAC_SECRET`（至少32字节）、可选 `SUBSCRIPTION_TEMPLATE_ID`；
- `processCardImage`：`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_OCR_REGION`、`OCR_DAILY_GLOBAL_LIMIT`；
- `scheduledCleanup`：每天凌晨3点运行，不允许客户端调用。
  - 分页删除超过60天的 `auditLogs`；安全审计日志最多保存60天。
  - 继续处理照片删除队列；账号删除产生的照片任务使用 `account_deleted` 原因。
- `deletionWorker`：定时处理已审批的数据删除任务，不允许客户端调用；运维迁移额外要求临时的 `OPERATIONAL_MIGRATION_TOKEN`，迁移入口默认只做 `inventory` 或 `dryRun`。

管理员批准数据删除申请时，服务端会先检查进行中的认领、待处理争议和7天取卡照片保留期。满足条件后解除用户与 OpenID、姓名和学号绑定，删除或匿名化业务数据，将照片写入 `fileCleanupJobs`，并仅在 `deletionReceipts` 中保留不含姓名、学号和 OpenID 的幂等处理凭证。

本版本不接入微信手机号验证，不收集手机号，也不以手机号状态阻塞发布或认领。

`MINIPROGRAM_STATE` 不设默认值。开发部署必须显式传入 `developer`，正式发布门禁必须显式传入 `formal`。订阅模板需要包含两个“事物”字段 `thing1`、`thing2`；模板未配置、用户未授权或发送失败时只保留站内消息，不影响业务状态。

密钥只放在云函数环境变量或部署环境中。不要把 AppSecret、腾讯云密钥或 `STUDENT_HMAC_SECRET` 写入仓库。

## 5. 部署

先运行 `npm run resources:deploy` 查看零写入 dry-run。迁移令牌必须是至少32字符的临时高熵值，只能同时放在当前进程和 `deletionWorker` 云函数环境变量中，不得写入命令输出、证据文件、仓库或文档。实际部署必须使用显式阶段：

1. `--phase=preflight --apply`：部署 `ADMINONLY`、存储/函数安全规则及非唯一索引；
2. `npm run migration:capture -- --mode=inventory --output=inventory.json` 直接调用远端 `deletionWorker` 生成原始盘点回包；如发现身份或角色冲突立即停止；
3. `npm run migration:capture -- --mode=dry-run --output=apply-dry-run.json` 复核迁移范围；
4. 人工确认后运行 `npm run migration:capture -- --mode=apply --confirm-apply --output=apply.json` 完成安全回填。脚本不会把令牌写入证据；
5. 在15分钟内运行 `npm run resources:deploy -- --phase=post-migration --migration-validation=.release-evidence/apply.json --apply`。脚本只接受远端原始调用回包，并校验环境 ID、`0.6.0` worker 版本、生成时间、完整零冲突扫描以及 `userKeys`/OpenID 回填结果，不能用手工平铺字段替代；
6. 迁移结束后立即轮换或移除远端 `OPERATIONAL_MIGRATION_TOKEN`，并从当前进程清除；
7. 运行 `npm run resources:readback -- --phase=post-migration`，逐项比对数据库、存储、函数规则和索引；存储规则部署后等待 1–3 分钟再复核。

使用 `cloudbaserc.json` 部署 `api`、`processCardImage`、`scheduledCleanup` 和 `deletionWorker` 后，确认每个定时触发器只存在一份。开发部署显式设置 `MINIPROGRAM_STATE=developer`；本轮不使用 `formal`，也不提交微信审核。

管理员账号只能由受控人员在 `users` 集合把 `role` 设置为 `admin`。客户端没有提升管理员权限的接口。

## 6. 上线前验证

本地先运行：

```powershell
npm run verify
npm run security:check
```

随后严格执行 `docs/RELEASE-GATE.md`。至少使用拾卡者、失主、管理员三个不同微信账号完成完整真机流程，并另用未确认用户验证文件不可访问。

当前 `wx-server-sdk 4.0.2` 的上游间接依赖风险采用30天例外，详见 `security/DEPENDENCY-RISK.md`；不得执行 `npm audit fix --force` 降级旧主版本。
