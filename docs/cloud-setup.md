# 微信云开发开通与部署清单

这份清单按操作顺序编写。完成前，小程序会继续使用本机演示数据；不会因为云端尚未开通而无法预览。

## 1. 创建云环境

1. 打开微信开发者工具并进入本项目。
2. 点击工具栏中的「云开发」。
3. 根据页面提示创建一个开发环境。
4. 创建完成后复制环境 ID，通常形如 `cloud1-xxxx`。
5. 打开 `miniprogram/config/cloud.ts`，把环境 ID 填入 `CLOUD_ENV_ID` 的引号中。
6. 保存并重新编译。MY 页显示「云端数据已连接」才表示连接成功。

不要把 AppSecret、腾讯云密钥或其他密码写入这个文件。

## 2. 创建数据库集合

在「云开发 → 数据库」中创建以下集合：

- `users`
- `identityBindings`
- `foundCards`
- `lostReports`
- `matches`
- `claims`
- `handovers`
- `messages`
- `reports`
- `auditLogs`
- `campuses`
- `locations`
- `systemConfig`

所有集合的数据权限均选择「仅管理端可读写」。小程序页面不直接读写数据库，所有操作都经过云函数检查。

## 3. 创建数据库索引

在对应集合的「索引管理」中添加以下组合索引。没有索引时，部分查询会在云端直接报错。

| 集合          | 字段顺序                                              |
| ------------- | ----------------------------------------------------- |
| `users`       | `openid` 升序，并设置为唯一                           |
| `users`       | `identityStatus` 升序                                 |
| `foundCards`  | `publisherOpenid` 升序、`createdAt` 降序              |
| `foundCards`  | `studentHmac` 升序、`status` 升序                     |
| `foundCards`  | `status` 升序、`createdAt` 降序                       |
| `lostReports` | `ownerOpenid` 升序、`createdAt` 降序                  |
| `lostReports` | `ownerOpenid` 升序、`studentHmac` 升序、`status` 升序 |
| `lostReports` | `studentHmac` 升序、`status` 升序                     |
| `messages`    | `recipientOpenid` 升序、`createdAt` 降序              |
| `matches`     | `foundCardId` 升序、`lostReportId` 升序，并设置为唯一 |
| `claims`      | `cardId` 升序、`applicantOpenid` 升序、`status` 升序  |
| `claims`      | `applicantOpenid` 升序                                |
| `auditLogs`   | `openid` 升序、`createdAt` 降序                       |
| `auditLogs`   | `action` 升序、`createdAt` 降序                       |
| `auditLogs`   | `openid` 升序、`action` 升序、`createdAt` 降序        |

`identityBindings` 使用学号 HMAC 作为文档 `_id`，不需要额外索引。它用于保证同一个学号不能被多个微信账号重复绑定。首次保存后，姓名和学号会锁定；查询和认领必须同时匹配这两个字段。

如果云端已经有旧版 `users` 数据，只有同时保存了姓名 HMAC 和学号 HMAC 的记录才会自动变成可用状态。仅有旧 `identityVerified` 字段的记录不会被直接信任，用户需要重新填写姓名和学号。

## 4. 配置云存储权限

进入「云开发 → 云存储 → 权限设置 → 自定义安全规则」，使用以下规则：

```json
{
  "read": "resource.openid == auth.openid",
  "write": "auth != null && auth.loginType != 'ANONYMOUS' && resource.openid == auth.openid && resource.size <= 8388608 && (/^temporary-cards\\//.test(resource.path) || /^storage-scenes\\//.test(resource.path))"
}
```

这表示用户只能读取自己上传的文件，并且只能向本项目规定的两个目录上传。云函数仍可读取和删除这些文件。

## 5. 配置云函数调用权限

进入「云开发 → 云函数 → 权限控制」，只允许已登录的小程序用户调用前两个函数：

```json
{
  "*": {
    "invoke": false
  },
  "api": {
    "invoke": "auth.loginType != 'ANONYMOUS' && auth != null"
  },
  "processCardImage": {
    "invoke": "auth.loginType != 'ANONYMOUS' && auth != null"
  },
  "scheduledCleanup": {
    "invoke": false
  }
}
```

`scheduledCleanup` 由定时任务运行，不需要让小程序页面直接调用。

这里必须保留 `*` 通配配置，这是 CloudBase 权限规则的必填项。可对照 [CloudBase 云函数安全规则](https://docs.cloudbase.net/cloud-function/security-rules)。

## 6. 设置云函数环境变量

### `api` 云函数

- `STUDENT_HMAC_SECRET`：至少 32 字节的随机字符串，开发和正式环境使用不同值。

可在 PowerShell 中运行下面的命令生成随机值，生成后只粘贴到云函数环境变量中：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

### `processCardImage` 云函数

- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`
- `TENCENT_OCR_REGION`，建议先使用 `ap-guangzhou`
- `OCR_DAILY_GLOBAL_LIMIT`：每天最多识别多少张图片；未填写时默认 100，试用阶段建议填 `30`

腾讯云密钥只给予 OCR 所需权限，不要使用主账号的永久全权限密钥。没有配置 OCR 时，用户仍可以手动填写姓名和学号，原始卡片照片会被删除。

使用 `cloudbaserc.json` 部署前，需要在当前 PowerShell 会话中设置上述变量以及 `STUDENT_HMAC_SECRET`。配置文件中的 `{{env.*}}` 是占位符，不是实际密钥；部署时会读取当前环境变量。不要把实际值写入仓库。

## 7. 上传并部署云函数

在微信开发者工具的目录树中依次右键以下文件夹，选择「上传并部署：云端安装依赖」：

1. `cloudfunctions/api`
2. `cloudfunctions/processCardImage`
3. `cloudfunctions/scheduledCleanup`

`cloudbaserc.json` 已包含 `scheduledCleanup` 和每天凌晨 3 点执行的 `dailyCleanup` 定时触发器。使用 CloudBase CLI 部署时会按配置创建；如果使用微信开发者工具手工上传，请在控制台确认触发器确实存在，避免重复创建。

三个函数均使用 `Nodejs20.19`。`processCardImage` 超时为 20 秒，高于内部 OCR 请求的 10 秒网络超时；`scheduledCleanup` 超时为 60 秒。

## 8. 配置管理员

1. 在 `users` 集合找到管理员自己的记录。
2. 将该记录的 `role` 改为 `admin`；普通用户保持 `student`。
3. 管理员重新打开小程序，从「MY → 管理员控制台」进入处理队列。
4. 姓名和学号只对应一张校园卡时不会进入队列；出现多条相似记录时，管理员结合卡片特点和实际交卡信息核对。
5. 管理员在现场确认归还后点击“确认归还”，系统会同步结束相关卡片、认领申请和失卡登记。

不要从客户端提供“设置管理员”接口，管理员角色只能由受控的管理端配置。

## 9. 手工验收

按下面顺序测试：

1. MY 页显示「云端数据已连接」。
2. 填写“我的信息”，退出页面后再次进入，信息仍然存在。
3. 保存姓名和学号后，SEARCH 和失卡登记可以正常使用。
4. 用测试学号登记一张失卡。
5. 用另一个微信测试用户发布相同学号的拾卡记录。
6. 原失主进入「MY → 消息提醒」，应看到“发现相似校园卡”。
7. 只有一条匹配记录且卡片已交到官方交卡点时，SEARCH 页面直接显示该交卡点；个人保管位置不能显示。
8. 再发布一条相同姓名和学号的测试卡片，SEARCH 应隐藏两条记录的具体存放地点，并提示等待管理员核对。
9. 管理员批准重复匹配中的正确记录后，「MY → 我的认领」显示官方交接地点。
10. 管理员现场确认归还后，卡片、认领申请和失卡登记都应进入已归还状态。

## 10. 上线前仍需完成

- 在微信公众平台填写用户隐私保护说明。
- 配置匹配提醒、审核结果和交接提醒的订阅消息模板。
- 至少使用两台真机、两个微信账号完成发布和找回测试。
- 删除测试记录，重新生成正式环境的 `STUDENT_HMAC_SECRET`。
- 重新执行三个云函数目录的依赖安全检查。

## 11. 当前依赖检查说明

三个云函数当前使用微信官方 `wx-server-sdk 4.0.2`。本机在 2026-07-13 执行 `npm audit --omit=dev` 时，每个云函数都报告 6 个来自官方 SDK 内部依赖的警告，其中 5 个为高风险、1 个为中风险。

现在不用你手动降级或强制替换依赖，那样可能造成云函数不兼容。正式上线前必须再次检查微信官方 SDK 是否发布了修复版本；若仍未修复，需要先完成风险评估再发布。
