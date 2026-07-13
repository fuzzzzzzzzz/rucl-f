# 云开发配置清单

## 集合

创建 `users`、`campuses`、`colleges`、`locations`、`foundCards`、`lostReports`、`matches`、`claims`、`handovers`、`messages`、`reports`、`auditLogs`、`systemConfig`。

所有业务写操作只允许通过云函数执行。客户端不得直接读取 `studentHmac`、私密特征、审核证据、微信身份标识和审计数据。公开卡片查询必须由云函数投影为脱敏结构。

## 必要配置

- `STUDENT_HMAC_SECRET`：至少32字节随机值，开发与生产环境不同。
- `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`：仅具备 OCR 调用权限。
- `AI_REVIEW_ENABLED=false`：首版固定关闭。
- `OCR_DAILY_GLOBAL_LIMIT`：试用期建议设置小额硬限制。

## 人工验收

- 配置隐私保护指引和用户隐私保护说明。
- 配置订阅消息模板：匹配提醒、审核结果、交接提醒。
- 添加体验成员并完成至少两台真机测试。
- 上线前删除所有测试记录并轮换云函数密钥。

## 已知依赖风险

截至本项目初始化时，`wx-server-sdk` 的当前版本仍通过 CloudBase 间接依赖被 `npm audit` 报告 6 项问题。降级会引入更多严重漏洞，因此暂不强制覆盖其内部依赖。部署前必须重新运行三个云函数目录的生产依赖审计，并优先升级到腾讯修复后的兼容版本。
