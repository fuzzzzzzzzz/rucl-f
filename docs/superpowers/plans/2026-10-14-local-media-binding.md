# 本地图片审核文件绑定规则

> 执行方式：subagent-driven-development，测试先行，规格复核后进行质量复核。仅实现已批准签名回调设计中的独立本地规则，不部署、不购买、不更改现有上传或查询入口。

## 目标与边界

为未来事务适配器提供纯函数：创建文件绑定任务、处理已验签回调、检查上传令牌是否可消费。返回下一份完整记录，由未来适配器在同一事务中保存。纯函数不是数据库事务、上线审批或学生访问授权。

新增且仅新增实现文件 `cloudfunctions/api/media-audit-binding.js` 和测试 `tests/media-audit-binding.test.js`。复用 `media-safety.js` 的真实认证能力和状态转移，不 mock 验签。不修改 handler/index/resource-contract。当前上传逻辑不导入新组件。

## 明确的数据契约

输入为服务端普通 JSON 记录；不是任意 JavaScript 代理/访问器的解析入口。所有时间为正安全整数 epoch 毫秒，`expiresAt > now` 才未过期。

上传记录包含 `uploadTokenHash`（64位小写十六进制）、`ownerOpenid`（1至128位字母数字下划线或连字符）、`kind`（storage_scene/handover_proof）、`fileId`、`serverOwned:true`、`referenced:false`。若 `_id` 存在，须等于 uploadTokenHash。fileId 仅接受现有服务端路径形式：cloud://环境与桶名/storage-scenes或handover-proofs/server/8位日期/48位小写十六进制.jpg，目录须对应 kind。不得接受别的目录、查询字符串或路径穿越。

`discarding` 非空且不是 false，或存在非 null/undefined 的 `cleanupQueuedAt`，均不能作为有效上传。已引用、非服务端所有、身份/路径不完整的记录一律拒绝。此规则只覆盖尚未消费的上传，不是已发布照片访问授权。

任务包含 `bindingVersion:1`、相同的 `uploadTokenHash/ownerOpenid/kind/fileId`、有效 `traceId`（现有1至128位字母数字下划线或连字符）、`status` 和 `expiresAt`。上传记录新增 `audit:{version:1,traceId,status,expiresAt}`。二者的绑定字段和状态必须全部一致，才能转移或消费。旧记录、缺审核记录、版本不符、状态错配均拒绝；不做兼容性自动批准。

## 三个函数

1. `createMediaAuditBinding(registry, {traceId,expiresAt,now})`：只允许有效、未绑定上传；存在 audit（包括 null）时拒绝重新登记。成功返回 `{ok:true,task,registry}`，两份记录状态都是 pending，保留上传记录其他字段，不修改输入。失败 `{ok:false,reason}`，固定原因码。
2. `applyMediaAuditCallback(registry,task,decoded,{now})`：先验证记录绑定及有效上传，再调用现有 transitionMediaTask。必须使用真实 decodeSafeModeMediaCallback 返回的原对象；伪造或序列化克隆不可批准。返回 `{ok,changed,task,registry,reason?}`。无变化时保留原引用；合法转移时同步生成两份下一记录。特别注意 terminal_conflict 返回 ok:false 但 changed:true 时，两份状态必须一起转 error，未来事务不得因 ok:false 丢弃该阻断更新。重复无变化、回调错任务无变化、过期永不恢复通过。不记录或返回原始消息/密钥。
3. `checkMediaUploadConsumption(registry,task,{ownerOpenid,kind,uploadTokenHash,now})`：上传仍有效、所有绑定一致、调用身份与用途和令牌摘要一致、未过期且 task 与 audit 都 passed 才 `{ok:true}`；其他 `{ok:false,reason}`。不签发地址、不修改 referenced、不授予卡主或管理员查看权限。

创建时失败原因可用 invalid_clock/invalid_upload/invalid_task/already_bound；回调保留 transition 的固定原因，绑定错误用 binding_mismatch 或 invalid_upload/invalid_task；消费失败使用 invalid_clock/invalid_upload/invalid_task/binding_mismatch/identity_mismatch/expired/not_approved。原因码不携带个人信息。

## 执行清单

- [x] 写公开接口和行为测试，空实现或占位实现确认断言 RED，再实现 GREEN。覆盖两种用途、每个绑定字段错配、所有状态、过期边界、重复、冲突、清理、旧记录、伪造回调、不可变输入；通过真实加密签名夹具完成 create → decode → apply → consumption 集成。
- [x] 实现者自检；不新增依赖、SDK、日志、网络调用或现有入口导入。
- [x] 独立规格复核，修复后再次复核。
- [x] 独立质量复核，修复后再次复核。
- [x] 根代理独立执行完整 Vitest（含本模块用例）、客户端及 cloud TypeScript、定向 ESLint/Prettier、云函数语法检查并记录实际结果。
- [x] 更新本地验收记录和明确未完成项。

测试命令（工作目录为现有 review-readiness worktree）：

```powershell
& 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run tests/media-audit-binding.test.js tests/media-safety.test.js tests/media-callback-post.test.js
& 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run
& 'C:/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc -p tsconfig.cloudfunctions.json --noEmit
& 'C:/Program Files/nodejs/node.exe' node_modules/eslint/bin/eslint.js cloudfunctions/api/media-audit-binding.js tests/media-audit-binding.test.js
& 'C:/Program Files/nodejs/node.exe' node_modules/prettier/bin/prettier.cjs --check cloudfunctions/api/media-audit-binding.js tests/media-audit-binding.test.js
```

TypeScript 配置文件名已核实。根代理独立全量运行：53文件、1086项测试通过，测试输出开始时间00:42:07；客户端/云函数类型检查、定向ESLint/Prettier、27个云函数文件语法检查退出码均为0。根代理再次定向运行三文件441项通过，输出开始时间00:45:00。独立规格和质量复核均通过，各自重新执行三文件441项测试；本范围内无阻断问题。测试先行证据：空导出占位实现时174项均失败，正常的创建断言期望 pending 记录而得到 undefined，非导入或语法失败。

## 仍待接入的事项

数据库唯一任务登记、同事务持久化、回调先于登记的收件箱竞态、实际 HTTP/GET 握手、生产接收地址、访问地址签发及学生端提示均未实现。本轮不创建集合或公网路由，不改变旧文件行为，也不声称线上照片已受这些规则保护。
