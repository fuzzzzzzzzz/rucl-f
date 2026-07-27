# 本地图标

31 个 PNG 图标由固定版本的 Google Material Symbols SVG 生成。唯一清单 `manifest.json` 记录上游仓库、40 位 commit、每个 SVG 的 SHA-256、颜色和输出名。

- 样式：Material Symbols Outlined
- 画布：96 × 96 像素，透明背景
- 许可：Apache License 2.0
- 第三方声明：`THIRD_PARTY_NOTICES.md`

离线校验使用仓库中的 `third_party/material-symbols/` 源文件：

```powershell
npm run icons:check
npm run icons:generate
```

只有复核上游变化后才可执行 `node scripts/generate-material-icons.mjs --refresh-sources` 并更新清单校验和。
