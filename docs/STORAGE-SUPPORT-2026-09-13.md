# 存储规则阻断复核与客服说明

检查日期：2026-09-13。结论：暂未解除，不满足提审条件。

## 本次实际结果

- 环境：cloud1-d4g2ccxaq372d5eb6。
- 当前存储规则：PRIVATE，rule 为 null；不是项目目标的 CUSTOM 规则。
- 套餐：个人版 baas_personal，NORMAL，到期时间 2027-01-13 23:59:59，自动续费关闭。
- DescribeBillingInfo 返回 EnvPaid=no、EnvCharged=no、EnvActivated=no。
- 再次提交项目原有精确规则被拒绝：OperationDenied.FreePackageDenied，`[ModifyStorageSafeRule] 当前套餐无法执行此操作`。
- 失败请求 ID：f58f3439-58db-4d7a-802e-436409ec818f。
- 未付款、未开通自动续费、未放宽权限、未部署业务变更。

## 可复制给腾讯云客服

我的 CloudBase 环境 cloud1-d4g2ccxaq372d5eb6 当前为个人版，状态 NORMAL，到期日 2027-01-13，但 DescribeBillingInfo 的 EnvPaid、EnvCharged、EnvActivated 都为 no。调用 ModifyStorageSafeRule 设置 CUSTOM 存储规则时返回 OperationDenied.FreePackageDenied（请求 ID：f58f3439-58db-4d7a-802e-436409ec818f）。官方文档说明安全规则功能本身免费。请确认：

1. 是环境未激活、体验资格限制、套餐权限异常，还是确需付费套餐？
2. 此个人版是否支持存储 CUSTOM 规则？如支持，请提供恢复或激活操作步骤。
3. 如确需付费，请说明最低支持套餐、实际费用及是否可在当前环境直接开通；请勿直接开通付费或自动续费。
4. 我需要禁止客户端读取，只允许非匿名用户写入自己创建的 temporary-cards/ 前缀文件；请确认这种规则在该环境可用。

不要向客服发送云密钥、学生姓名学号、OpenID 或用户照片。

## 解除后的复核

仅在账户能力恢复后重新应用现有精确契约，回读确认 CUSTOM 及规则内容逐项一致。规则生效后验证未登录/匿名用户拒绝、其他用户文件拒绝、非临时前缀拒绝、合法上传成功、客户端直接读取拒绝。不能用 PRIVATE 替代目标规则，也不能仅凭设置请求成功判定全部权限测试通过。

官方说明：[安全规则及计费](https://docs.cloudbase.net/rule/introduce)、[云存储安全规则](https://docs.cloudbase.net/storage/security-rules)。账户激活标记与错误之间的因果关系仍待客服确认，不能仅凭标记推断必须购买某个套餐。
