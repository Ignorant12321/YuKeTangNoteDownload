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
   `https://<任意雨课堂域名>/ai-workspace/lms-graph/<classroom_id>/video/<leaf_id>?is_chapter=1`
   （域名不限：`www.yuketang.cn`、学校专属的 `xxx.yuketang.cn` 都可以，见下）
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

## 接口

| 用途 | 地址 |
| --- | --- |
| 课程目录树 | `GET /mooc-api/v1/lms/learn/course/chapter?cid=<classroom_id>&classroom_id=<classroom_id>&show_unpublished=0` |
| 知识导引 | `GET /c27/online_courseware/leaf_knowledge/<leaf_id>/?classroom_id=<classroom_id>` |
| 讲稿 | `GET /c27/online_courseware/leaf_lecture_note/<leaf_id>/?classroom_id=<classroom_id>` |
| 作业小节 → exercise_id | `GET /mooc-api/v1/lms/learn/leaf_info/<classroom_id>/<leaf_id>/?classroom_id=<classroom_id>`，取 `content_info.leaf_type_id` |
| 作业题目与正确答案 | `GET /c27/online_courseware/exercise/get_exercise_detail/<exercise_id>/?classroom_id=<classroom_id>` |
| 作业学生作答（题干加密，未使用） | `GET /mooc-api/v1/lms/exercise/get_exercise_list/<exercise_id>/<sku_id>/?classroom_id=<classroom_id>` |

