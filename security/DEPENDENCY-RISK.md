# 依赖风险窄例外

复查截止：2026-08-26（自快照日起 30 天）。

## 云函数生产依赖

四个云函数均固定使用微信官方稳定版 `wx-server-sdk 4.0.2`。当前 `npm audit --omit=dev` 对每个函数报告 5 个 High、1 个 Moderate，来自其间接依赖 `@cloudbase/database`、`@cloudbase/node-sdk`、`axios`、`lodash.set` 和 `lodash.unset`，并汇总到直接依赖 `wx-server-sdk`。

自动修复建议会把 SDK 降级到旧主版本 `2.5.3`，因此本轮不执行 `npm audit fix --force`，也不升级 beta。业务代码不允许用户控制 SDK 请求目标 URL，并继续对路径、大小、身份和状态做服务端校验。

## 根开发依赖

根工具链的审计快照单独管理；它不会部署到云函数或小程序包。当前报告 9 个 High，汇总自 ESLint/Vitest 覆盖率链与 `sharp`。例外仍精确锁定实际 GitHub Advisory、安装版本、最大计数和根 lock hash，不能与生产依赖例外混用。

## 自动门禁

`security/dependency-risk-exception.json` 精确记录：

- 根及四个云函数 lock 文件的规范化 SHA-256；
- 实际漏洞包和安装版本；
- 每个 GitHub Advisory ID 与 URL；
- 各严重度最大数量；
- 最长 30 天的复查期限。

CI 每周定时重新运行真实 `npm audit`。任何 lock、安装版本、漏洞包、Advisory 集合、数量或期限变化都会失败，必须重新审查后才能更新快照。
