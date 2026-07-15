# 微信云开发部署说明

当前正式环境 ID 已写入 `miniprogram/config/cloud.ts`。正式构建的 `DEMO_MODE` 必须保持 `false`；登录失败时小程序会进入只读错误态，不会写入本机演示数据。

## 1. 数据库集合

在云开发数据库创建：

- 核心：`users`、`identityBindings`、`foundCards`、`lostReports`、`matches`、`claims`、`handovers`、`messages`；
- 文件：`uploadedFiles`、`fileCleanupJobs`；
- 运营：`identityCorrectionRequests`、`recordReports`、`riskReviews`、`feedback`、`dataDeletionRequests`、`auditLogs`。

所有集合均设置为客户端不可直接读写，并在控制台应用 `security/database.rules.json`。小程序页面只调用云函数。

## 2. 推荐索引

| 集合                         | 字段                                          |
| ---------------------------- | --------------------------------------------- |
| `users`                      | `openid` 升序（唯一）                         |
| `foundCards`                 | `publisherOpenid` 升序、`createdAt` 降序      |
| `foundCards`                 | `studentHmac` 升序、`status` 升序             |
| `foundCards`                 | `status` 升序、`createdAt` 降序               |
| `lostReports`                | `ownerOpenid` 升序、`createdAt` 降序          |
| `lostReports`                | `ownerOpenid`、`studentHmac`、`status` 均升序 |
| `lostReports`                | `studentHmac`、`status` 均升序                |
| `claims`                     | `applicantOpenid`、`status` 均升序            |
| `claims`                     | `publisherOpenid` 升序、`createdAt` 降序      |
| `handovers`                  | `publisherOpenid` 升序、`completedAt` 降序    |
| `handovers`                  | `applicantOpenid` 升序、`completedAt` 降序    |
| `handovers`                  | `officialPointVerified` 升序                  |
| `messages`                   | `recipientOpenid` 升序、`createdAt` 降序      |
| `identityCorrectionRequests` | `status` 升序、`createdAt` 降序               |
| `recordReports`              | `status` 升序、`createdAt` 降序               |
| `fileCleanupJobs`            | `status` 升序、`notBefore` 升序               |
| `uploadedFiles`              | `referenced` 升序、`createdAt` 升序           |
| `auditLogs`                  | `openid`、`action` 升序，`createdAt` 降序     |

`identityBindings` 使用学号 HMAC 作为文档 `_id`。旧数据中的 `identityStatus: verified` 兼容读取为 `profileBindingStatus: locked`，但界面不会宣称完成学校身份核验。

## 3. 云存储规则

进入“云开发 → 云存储 → 权限设置 → 自定义安全规则”，应用 `security/storage.rules.json`：

```json
{
  "read": false,
  "write": "auth != null && resource.openid == auth.openid"
}
```

客户端不能读取文件；只有创建者可以写入。客户端把图片上传到 `temporary-cards/{openid}`、`storage-scenes/{openid}`、`handover-proofs/{openid}`，云函数会再次检查目录和上传登记。环境照片只有云函数完成认领权限检查后才生成短时地址；取卡照片只有管理员处理争议时能生成短时地址。

规则保存后通常需要等待控制台生效，再按 `docs/RELEASE-GATE.md` 使用四类身份实测。

## 4. 云函数与环境变量

三个函数均使用 Node.js 20：

- `api`：`STUDENT_HMAC_SECRET`（至少32字节）、可选 `SUBSCRIPTION_TEMPLATE_ID`；
- `processCardImage`：`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_OCR_REGION`、`OCR_DAILY_GLOBAL_LIMIT`；
- `scheduledCleanup`：每天凌晨3点运行，不允许客户端调用。

`MINIPROGRAM_STATE` 在开发环境使用 `developer`，上线时改为 `formal`。订阅模板需要包含两个“事物”字段 `thing1`、`thing2`；模板未配置、用户未授权或发送失败时只保留站内消息，不影响业务状态。

密钥只放在云函数环境变量或部署环境中。不要把 AppSecret、腾讯云密钥或 `STUDENT_HMAC_SECRET` 写入仓库。

## 5. 部署

可在微信开发者工具中依次右键上传并选择“云端安装依赖”：

1. `cloudfunctions/api`；
2. `cloudfunctions/processCardImage`；
3. `cloudfunctions/scheduledCleanup`。

也可使用 `cloudbaserc.json` 部署。部署后确认 `dailyCleanup` 定时触发器只存在一份。

管理员账号只能由受控人员在 `users` 集合把 `role` 设置为 `admin`。客户端没有提升管理员权限的接口。

## 6. 上线前验证

本地先运行：

```powershell
npm run verify
npm run security:check
```

随后严格执行 `docs/RELEASE-GATE.md`。至少使用拾卡者、失主、管理员三个不同微信账号完成完整真机流程，并另用未确认用户验证文件不可访问。

当前 `wx-server-sdk 4.0.2` 的上游间接依赖风险采用30天例外，详见 `security/DEPENDENCY-RISK.md`；不得执行 `npm audit fix --force` 降级旧主版本。
