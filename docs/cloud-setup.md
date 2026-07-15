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
| `uploadedFiles`              | `fileId` 升序                                 |
| `uploadedFiles`              | `referenced` 升序、`createdAt` 升序           |
| `auditLogs`                  | `openid`、`action` 升序，`createdAt` 降序     |

`identityBindings` 使用学号 HMAC 作为文档 `_id`。旧数据中的 `identityStatus: verified` 兼容读取为 `profileBindingStatus: locked`，但界面不会宣称完成学校身份核验。

## 3. 云存储规则

免费开发环境不支持自定义云存储规则。在“云开发 → 云存储 → 权限”中保持：

> 仅创建者可读写

长期保存的存放环境照片和取卡证明不由小程序直接调用 `wx.cloud.uploadFile`。小程序先把照片压缩到 1MB 以内，再调用 `uploadPrivateImage`；云函数保存文件并只向小程序返回一次性随机凭证，不返回文件 ID。后续发布、转交或完成交接时，云函数核对凭证所属账号和用途，业务记录中只保存服务端文件 ID。

校园卡原图是例外：它只上传到 `temporary-cards/{openid}` 供 OCR 使用，识别函数在 `finally` 中立即删除；删除失败会进入 `fileCleanupJobs`。

`security/storage.rules.json` 保留为将来升级到支持自定义规则的套餐时使用的更严格配置：

```json
{
  "read": false,
  "write": "auth != null && resource.openid == auth.openid"
}
```

在免费方案中，长期照片由云函数创建，因此普通小程序账号不是文件创建者。环境照片只有云函数完成认领权限检查后才生成短时地址；取卡照片只有管理员处理争议时能生成短时地址。这个边界仍必须按 `docs/RELEASE-GATE.md` 使用四类身份真机实测，不能只依赖代码判断。

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
