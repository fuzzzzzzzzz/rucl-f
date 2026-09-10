# 依赖风险审查：仍阻断发布

## 2026-09-10 复查结果

旧例外已于 2026-08-26 到期，且本轮锁文件已变化。`dependency-risk-exception.json` 保留为历史批准记录，不能用于批准当前依赖；没有延长日期或扩大允许范围。`npm run security:check` 应继续失败，不能宣称完整门禁通过。

- 根工具链已升级到稳定版 `vitest` / `@vitest/coverage-v8` 4.1.11、`sharp` 0.35.4，并应用兼容的传递依赖修复。当前根 `npm audit --json` 为零漏洞。
- 四个生产锁已应用兼容修复，移除新增 `qs` 风险；各自仍为 5 High、1 Moderate。SDK 仍固定 4.0.2。2026-09-10 官方 npm registry 的 latest 为 4.0.2，beta 为 4.0.3-beta.1；未采用 beta、强制降级或跨版本覆盖传递依赖。
- Vitest 4.1.11 的 Node 声明为 `^20.0.0 || ^22.0.0 || >=24.0.0`，sharp 为 `>=20.9.0`，均接受项目 Node 20.19。升级后 182 项测试通过，31 个图标校验通过；首次覆盖率验证未达现有分支阈值，未降低阈值，后续测试修复另行验证。

### 生产可达性：已确认的边界及未关闭的问题

检查实际安装的 `@cloudbase/database` 1.4.3，`lodash.set` 4.3.2 与 `lodash.unset` 4.5.2 的调用位于 `dist/commonjs/realtime/virtual-websocket-client.js` 的实时变更字段应用路径。当前四个云函数业务源码未发现 `.watch()` 调用。这是降低可达性的证据，不是对后续 SDK 调用或动态路径的永久豁免。

检查 `@cloudbase/node-sdk` 3.17.2，`axios` 0.27.2 除公开 request 包装器外，还在 `dist/utils/metadata.js` 的 `lookup()` 中访问 `http://metadata.tencentyun.com`，供平台识别和凭证发现使用。因此不能声称 Axios 完全不可达。SDK 有 30/200 ms 的元数据请求超时，但超时不能证明重定向、代理配置和原型污染类问题全部得到缓解；部署环境的代理和元数据响应行为尚无验证证据。

业务 OCR 上传经 `consumeOcrUploadAuthorization()`、`requireAuthorizedOcrUpload()` 校验身份、一次性凭证、过期时间与预期路径后才下载；OCR 外部服务使用原生 HTTPS。这限制用户输入直接控制下载路径，但并不足以证明所有 SDK Axios advisory 不可利用。

结论：剩余生产风险保持发布阻断。解除前必须获得稳定上游修复，或逐 advisory 补齐真实调用链及部署环境缓解验证，再批准不超过 30 天、绑定精确版本/advisory/锁哈希的新例外。不能仅修改旧例外日期或哈希。

### 一手证据

- [Vitest 修复及攻击前提](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)：4.1.11 修复；3.x 不计划回补。
- [sharp / libheif 修复](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)。
- [lodash.set 原型污染及无修复版本](https://github.com/advisories/GHSA-p6mc-m468-83gw)。
- [lodash.unset 原型污染](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg)。
- [Axios 绝对 URL SSRF](https://github.com/advisories/GHSA-jr5f-v2jv-69x6)。

## 历史例外快照（已失效）

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
