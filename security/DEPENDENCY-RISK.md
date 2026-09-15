# 依赖风险审查

## 当前结论：2026-09-12 本地依赖安全门禁通过

根工具链及四个云函数实际安装依赖树均有效，五份 `npm audit` 均为零漏洞。`npm run security:check` 不再使用任何风险例外：缺失或失败的审计响应、非零漏洞计数、残留漏洞条目或无效依赖树均会阻止通过。旧例外 JSON 原样保留，仅作历史记录。

最后的独立 `lodash.set` 4.3.2 已由项目内透明适配包 `@kale/lodash-set-compat` 1.0.0 替换。适配器仅导出官方 `lodash` 4.18.1 的 `lodash/set`，没有复制或修改上游实现，没有冒充官方 lodash.set 发布版本。原型写入测试在旧依赖上先失败，替换后危险数组路径与普通嵌套/数组更新测试均通过。实现和 MIT 许可证来自锁文件固定的官方 Lodash 包，部署包必须保留其 LICENSE。

每个云函数包含自身 `vendor/lodash-set` 和 `.npmrc`（`install-links=true`），不依赖工作树外部目录；四份 `npm ci` 和 `npm ls` 均已验证。初次安装留下的错误嵌套链接已从锁文件移除，干净安装后不会依赖错误链接回退。所有本地适配包均使用相同代码；微信 SDK 保持 4.0.2，未升级 beta、未降级、未执行强制 audit fix。

这仅解除本地依赖审计阻断，不等同于正式提审通过。最终 CI、云端安装/SDK canary、权限契约及用户真机验收仍须完成，尚未部署这些变更。

以下按时间保留调查过程；其中“仍阻断”描述的是当时快照，不是当前依赖审计结论。

## 2026-09-12 修复进展

### Axios 兼容替换验收（同日续查）

四个云函数已为 `@cloudbase/node-sdk@3.17.2` 下的 Axios 设置精确 override 0.33.0，微信 SDK 仍为 4.0.2。旧版的继承属性 GET 请求体回归测试先失败，替换后四份安装均通过。针对实际 SDK `metadata.lookup()`，使用仅监听 127.0.0.1 的本地 HTTP 服务验证 JSON 成功响应、503 错误和请求超时；测试不访问腾讯元数据或读取真实凭证。完整 280 项测试和原有覆盖率门槛通过。上述测试不是云端凭证发现或真实存储下载的 canary，部署前仍需补齐。

四份新审计均为 4 High、0 Moderate。直接 advisory 只剩 `GHSA-p6mc-m468-83gw`（lodash.set）；其他三个条目是 `@cloudbase/database`、`@cloudbase/node-sdk`、`wx-server-sdk` 的依赖链汇总，不是四个独立漏洞。当前 `@cloudbase/database` latest 仍为 1.4.3，`lodash.set` latest 仍为 4.3.2，没有直接稳定修复版。该剩余风险尚未批准豁免，安全门禁继续保持失败。

- 官方 registry 的 `wx-server-sdk` latest 仍为 4.0.2；其精确依赖 `@cloudbase/node-sdk` 3.17.2，而后者精确依赖 Axios 0.27.2。未升级 beta 或按 audit 建议降级 SDK。
- 四个云函数对 `@cloudbase/database@1.4.3` 下的 `lodash.unset` 设置精确 override 为稳定版 4.18.0。普通 `npm update` 无法越过原来的精确版本 4.5.2，因此这里明确记录为经过本地验证的传递依赖替换，而不是上游 SDK 已修复。
- 回归测试先在旧版复现：`unset({}, ['__proto__', marker])` 删除了 Object.prototype 上的测试属性。替换后四个函数均拒绝该原型路径，同时正常嵌套属性删除仍通过。全部 272 项测试、覆盖率门槛及 ESLint 通过；测试仅使用隔离本地对象，不涉及真实数据。
- 各云函数审计由 5 High、1 Moderate 降为 5 High；剩余主要为 Axios 和 lodash.set 及其上游汇总。该替换尚未部署，完整 SDK 云端 canary 和最终版本验收仍需执行。
- Axios 0.33.0 是上游维护的 v0.x 安全修复版本，见 [官方发布说明](https://github.com/axios/axios/releases/tag/v0.33.0) 和 [GHSA-mmx7-hfxf-jppx](https://github.com/advisories/GHSA-mmx7-hfxf-jppx)。SDK 将 Axios 精确锁定为 0.27.2，不能仅依据 audit 的修复版本字段宣称替换兼容；后续需对实际 SDK 元数据请求路径进行回归验证。
- 旧风险例外未延期，整体安全门禁仍阻断发布。

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
