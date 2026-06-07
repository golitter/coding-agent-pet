# 精灵图规格

## 总体规格

| 属性 | 值 |
|---|---|
| 尺寸 | 1536×1872px |
| 网格 | 8 列 × 9 行 |
| 单元格 | 192×208px |
| 格式 | RGBA PNG, 透明背景 |
| 色度键 | #FF00FF (magenta, 用于背景提取) |

## 动画行布局

| 行号 | 状态 | 帧数 | 帧范围 (列) | 用途 |
|---|---|---|---|---|
| 0 | idle | 6 | 0-5 | 静息、呼吸、眨眼循环 |
| 1 | running-right | 8 | 0-7 | 向右拖动移动循环 |
| 2 | running-left | 8 | 0-7 | 向左拖动移动循环 |
| 3 | waving | 4 | 0-3 | 问候/打招呼手势 |
| 4 | jumping | 5 | 0-4 | 跳跃庆祝动画 |
| 5 | failed | 8 | 0-7 | 出错/失败反应 |
| 6 | waiting | 6 | 0-5 | 等待授权/输入 |
| 7 | running | 6 | 0-5 | 活跃工作中 |
| 8 | review | 6 | 0-5 | 审阅输出 |

总计 **55 帧**。

## 帧文件目录

```
kotori-minami/frames/
├── idle/            00.png, 01.png, 02.png, 03.png, 04.png, 05.png
├── running-right/   00.png, 01.png, 02.png, 03.png, 04.png, 05.png, 06.png, 07.png
├── running-left/    00.png, 01.png, 02.png, 03.png, 04.png, 05.png, 06.png, 07.png
├── waving/          00.png, 01.png, 02.png, 03.png
├── jumping/         00.png, 01.png, 02.png, 03.png, 04.png
├── failed/          00.png, 01.png, 02.png, 03.png, 04.png, 05.png, 06.png, 07.png
├── waiting/         00.png, 01.png, 02.png, 03.png, 04.png, 05.png
├── running/         00.png, 01.png, 02.png, 03.png, 04.png, 05.png
└── review/          00.png, 01.png, 02.png, 03.png, 04.png, 05.png
```

## 渲染参数

| 参数 | 值 |
|---|---|
| 原始尺寸 | 192×208px |
| 缩放因子 | 0.6 |
| 显示尺寸 | ~115×125px |
| 缩放方式 | `scaleProportionallyUpOrDown` |
| 帧率 | 10 FPS |

## 关联文件

- 精灵图合并: `kotori-minami/final/spritesheet.webp` / `spritesheet.png`
- 精灵图清单: `kotori-minami/frames/frames-manifest.json`
- 宠物定义: `kotori-minami/pet_request.json`
- 帧加载器: `desktop/mac/renderer/Sources/KotoriPet/FrameCache.swift`
