# 云函数依赖风险例外

复查期限：2026-08-13（30天）。

三个云函数直接使用微信官方 `wx-server-sdk 4.0.2`。当前 npm 报告 5 个 High、1 个 Moderate，涉及 `@cloudbase/database`、`@cloudbase/node-sdk`、`axios`、`lodash.set`、`lodash.unset`，并把风险汇总到直接依赖 `wx-server-sdk`。官方包内主要调用路径为 `wx-server-sdk → @cloudbase/node-sdk → @cloudbase/database / axios`。

小程序输入不能控制 SDK 请求的目标 URL；本项目也不把用户输入直接传给 axios。文件路径限定在当前用户目录，文本有长度和格式限制，状态变化在服务端重新检查。例外不等于风险消失，需跟踪 [wx-server-sdk 上游版本](https://www.npmjs.com/package/wx-server-sdk) 和 npm 报告中的 GitHub Advisory。

CI 会阻止以下情况：Critical 告警；不在例外清单中的新漏洞；新的直接生产依赖 High；任一锁文件指纹变化；超过复查日期。不得执行 `npm audit fix --force` 将 SDK 降级到旧主版本。
