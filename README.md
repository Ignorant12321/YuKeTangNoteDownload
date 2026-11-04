# YuKeTangNoteDownload

下载雨课堂课程的知识索引（知识导引）、讲稿和作业习题答案，提高学习效率。

## 用法（笔记提取）

不需要装插件，也不用填参数，粘贴脚本后弹面板操作。

|              功能               |                             展示                             |
| :-----------------------------: | :----------------------------------------------------------: |
|            获取来源             | ![image-20261104224340319](README.assets/image-20261104224340319.png) |
|          插件交互面板           | <img src="README.assets/image-20261104215342765.png" alt="image-20261104215342765" style="zoom:50%;" /> |
| 提取笔记（电脑<br />+浅色模式） | ![image-20261104215600207](README.assets/image-20261104215600207.png) |
|          手机+深色模式          | <img src="README.assets/image-20261104215946345.png" alt="image-20261104215946345" style="zoom:50%;" /> |

1. 登录雨课堂，打开任意一节课程视频页，地址形如
   `https://www.yuketang.cn/ai-workspace/lms-graph/<classroom_id>/video/<leaf_id>?is_chapter=1`
2. `F12` → `Console`，把 [extract-notes.js](extract-notes.js) 的内容整段粘贴进去，回车。
3. 页面左上方出现「雨课堂笔记提取」面板，自动加载本课程目录，**默认全部勾选**。
4. 要减少范围就点章 / 节的复选框取消整组，或搜索后点「清空」再单选 → 选导出格式 → 点「开始提取」。
5. 浏览器下载 `<课程名>.md`（和可选的 `.html`）。

效果见 [sample-1.1.1-1.1.2.md](sample-1.1.1-1.1.2.md) 与 [sample-1.1.1-1.1.2.html](sample-1.1.1-1.1.2.html)，
后者双击用浏览器打开就能看到目录、排版和深浅色切换。

## 面板

| 区域 | 说明 |
| --- | --- |
| 标题栏 | 按住可拖动，位置记在 `localStorage`；`—` 收起，`×` 关闭 |
| 搜索框 | 按小节 / 章 / 节标题过滤，组勾选只作用于过滤后可见的条目 |
| 全选 / 反选 / 清空 | 只作用于当前可见条目 |
| 目录树 | 章 → 节 → 视频三级，父级复选框带半选状态，点 ▸ ▾ 展开折叠；打开时默认全选 |
| 导出格式 | `Markdown (.md)` 或 `Markdown + HTML` |
| 附带讲稿附录 | 关掉则只导出知识导引，不生成附录树 |
| 标注时间段 | 关掉则知识导引标题下不输出 `> 00:18 – 01:51` |
| 并发数 | 1~8，卡或怕限流就调小 |
| 底部 | 进度条 + 计数；提取中时按钮变成「取消」 |

再次粘贴脚本只会重新唤出面板，不会重复注入；参数和面板位置都会记住。
面板配色跟随系统深浅色。

## 作业习题提取

另一个脚本 [extract-homework.js](extract-homework.js)，只出 HTML，没有面板。

1. 登录雨课堂，打开本课程任意页面（作业页或视频页都行）。
2. `F12` → `Console`，整段粘贴脚本，回车，浏览器直接下载 `<课程名>-习题第N章.html`。

如果需要改范围在粘贴前先执行（已经默认是全部章节的作业）：

```js
window.YKT_HW_CONFIG = { chapter: 3 };     // 只要第 3 章（默认 null = 全部章节）
window.YKT_HW_CONFIG = { open: false };    // 下载后不自动开新标签（默认会开）
```

排版与笔记的 HTML 一致：左侧目录栏**展开到每一题**（作业分组 + `题号 · 题型 · 题干前 26 字`），
分组**默认收缩**，滚动到某一题时才自动展开它所在的那一组、并收回上一组由脚本自己展开的
（你手动点开的不会被关掉）；窄屏收成抽屉，另有深浅色三态切换和打印样式。
效果见 [sample-homework.html](sample-homework.html)（全 6 份作业 / 148 题）。

关于题干文字：雨课堂的**学生作答接口** `get_exercise_list` 返回的题干是字体加密的
（`<span class="xuetangx-com-encrypted-font">`，码点是乱码，靠自定义字体映射才显示正常），
直接抓会拿到一堆乱码。而 **`get_exercise_detail`** 返回的是明文，而且 `content.Answer`
就是正确答案，所以脚本走后者。

答案单独成行，开头的字母或「正确/错误」用绿色标出：

```
正确答案：
A. 由于学科领域的差异，与受试者相关的非常详细的共通指南还很缺乏
B. 对于受试人，保护人的人格、自由、隐私，知情同意原则的一系列规范需要得到遵守
C. 对于实验动物，英国科学家罗素和伯奇1959年提出3R原则，即替代（replacement）……
```

判断题只有一个结论，所以显示成绿色的「正确」或「错误」，不带点号；选择题才带 `A.` 这种前缀。
填空和主观题映射不到选项 key，直接把答案文本原样输出；完全没有客观答案时显示「（无客观答案）」，
这时不生成列表。绿色走 `--ok` 变量，浅色 `#1a7f37`、深色 `#3fb950`，随主题切换。

只处理 `leaf_type === 6`（作业）。期末考试是另一套 exam 接口，这里没做。

### 不同课程的数据形态差异

雨课堂的作业数据并不统一，脚本对这几类都做了兼容，换课报一般不用再改：

| 差异 | 表现 | 处理 |
| --- | --- | --- |
| `content.Answer` 类型 | 判断题/多选题是数组 `["A","B"]`；**有的课单选题直接给字符串** `"A"` | `asArr()` 统一成数组；填空/主观类答案本身就是文本，映射不到 key 时原样输出 |
| 题干与选项存储 | 有的课存**整份 HTML 文档**：`<!DOCTYPE html><html><head></head><body><p>…</p></body></html>`（某门课 107 题里 106 题如此） | `unwrapDoc()` 先剥外壳取 `<body>` 内容，再走净化 |
| 选项文本 | `<div class="custom_ueditor_cn_body"><p>…</p><!--!doctype--></div>` | `toPlain()` 降成纯文本，避免块级标签把选项撑成两行 |

`<div>` 里塞整份文档这事浏览器**碰巧**能容错渲染（`html`/`body` 标签在 body 上下文里被忽略），
但那是不保证的行为，而且会污染 `document.body.children`，所以显式剥掉。

## 接口

脚本复用当前页面的登录 Cookie，只额外带一个 `xtbz` 请求头（值取自同名 Cookie）。

| 用途 | 地址 |
| --- | --- |
| 课程目录树 | `GET /mooc-api/v1/lms/learn/course/chapter?cid=<classroom_id>&classroom_id=<classroom_id>` |
| 知识导引 | `GET /c27/online_courseware/leaf_knowledge/<leaf_id>/?classroom_id=<classroom_id>` |
| 讲稿 | `GET /c27/online_courseware/leaf_lecture_note/<leaf_id>/?classroom_id=<classroom_id>` |
| 作业小节 → exercise_id | `GET /mooc-api/v1/lms/learn/leaf_info/<classroom_id>/<leaf_id>/?classroom_id=<classroom_id>`，取 `content_info.leaf_type_id` |
| 作业题目与正确答案 | `GET /c27/online_courseware/exercise/get_exercise_detail/<exercise_id>/?classroom_id=<classroom_id>` |
| 作业学生作答（题干加密，未使用） | `GET /mooc-api/v1/lms/exercise/get_exercise_list/<exercise_id>/<sku_id>/?classroom_id=<classroom_id>` |

目录树里「节」有两种形态：`section_leaf_list[i]` 下面挂 `leaf_list`（第 1、2 章），或节自身就是一个视频（第 3～5 章）。脚本两种都展开，并只保留 `leaf_type === 0` 的视频，跳过作业和考试。
