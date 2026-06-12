# 在 Codex 中创建虚拟桌面宠物

> 参考教程：<https://zhuanlan.zhihu.com/p/2034795997839221924>

> 💡 **本项目使用的图像资源即由此流程生成。** 资料包位于 [../assets/kotori-minami/](../assets/kotori-minami/)，包含 57 帧动画 + 精灵图，由 `/hatch-pet` Skill 输出后按本项目 9 个状态机重新解帧归档。

---

## 1. 安装宠物 Skill

在 Codex 聊天框中执行以下命令安装自定义宠物 Skill：

```shell
$skill-installer hatch-pet
```

安装完成后**重启 Codex**。

## 2. 绘制宠物

重启后，在聊天框中输入以下命令来生成宠物素材：

```shell
/hatch-pet 帮我创建一只南小鸟（Kotori）电子宠物。

宠物名称：南小鸟
宠物类型：像素风 Q 版人物
视觉风格：极简可爱，轮廓清晰，适合桌面悬浮
性格设定：温柔治愈，有一点天然呆，会提供贴心的陪伴与鼓励
主要颜色：亚麻色头发 + 琥珀色眼睛 + 音乃木坂学院制服配色（带绿色领结）
标志元素：标志性的侧边半扎发加绿色蝴蝶结，旁边可有一只 (・8・) 小鸟元素或羊驼元素

动作状态：
- idle —— 待机（带着甜美微笑轻轻晃动身体）
- working —— 画设计图 / 缝制打歌服中
- thinking —— 歪头咬手指，头顶冒出小问号
- waiting —— 双手捧脸，期待地看着屏幕
- done —— 开心转圈撒花，或者比个心
- sleeping —— 抱着羊驼玩偶趴下打瞌睡

要求：无背景、无文字、缩小后轮廓依然清晰
```

## 3. 启用宠物显示

再次**重启 Codex**，进入 **设置 → 外观**，滚动到页面底部，将刚才生成的宠物设置为桌面宠物。

## 4. 召唤宠物

在聊天框中输入以下任意命令即可在桌面上看到虚拟宠物：

```
/pet
```

或

```
/宠物
```

---

## 5. 与本项目的关系

Skill 默认输出的 6 个动作（idle / working / thinking / waiting / done / sleeping）需要按本项目的 **9 个状态机**重新生成、解帧、归档。完整的状态映射、精灵图规格、重新生成流程见：

- 资源目录：[../assets/kotori-minami/](../assets/kotori-minami/)（`frames/` 运行时帧 + `imagegen/` 生成产物与 prompt）
- 精灵图规格：[../desktop/docs/reference/spritesheet.md](../desktop/docs/reference/spritesheet.md)
- 事件 → 状态映射：[../desktop/docs/agent-hooks/events.md](../desktop/docs/agent-hooks/events.md)
