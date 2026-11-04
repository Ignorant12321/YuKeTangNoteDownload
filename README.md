# YuKeTangNoteDownload

下载雨课堂课程的知识索引（知识导引）和讲稿，提高学习效率。

## 用法

不需要装插件，直接在浏览器控制台运行。

1. 登录雨课堂，打开任意一节课程视频页，地址形如
   `https://www.yuketang.cn/ai-workspace/lms-graph/<classroom_id>/video/<leaf_id>?is_chapter=1`
2. `F12` → `Console`，把 [extract-notes.js](extract-notes.js) 的内容整段粘贴进去，回车。
3. 浏览器自动下载 `<课程名>_<区间>.md`，全文同时挂在 `window.__YKT_NOTES.markdown`。

默认提取 `1.1.1 ~ 1.1.2`，效果见 [sample-1.1.1-1.1.2.md](sample-1.1.1-1.1.2.md)。

## 配置

所有参数都写在 `window.YKT_NOTES_CONFIG` 里，粘贴脚本前先执行它。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `from` / `to` | `1.1.1` / `1.1.2` | 小节编号区间，按标题开头的数字匹配；`'*'` 表示全部 |
| `transcript` | `true` | 是否附带「附录」讲稿段落 |
| `knowledgeTime` | `true` | 知识导引是否标注视频时间段 |
| `concurrency` | `4` | 并发请求数 |
| `download` | `true` | 是否自动下载 .md |

完整配置（粘贴到控制台前执行，改哪个调哪个）：

```js
window.YKT_NOTES_CONFIG = {
  from: '1.1.1',        // 起始小节编号；改成 '*' 表示从头开始
  to: '1.1.2',          // 结束小节编号（含）；改成 '*' 表示到最后
  transcript: true,     // false 则只导出知识导引，不带讲稿
  knowledgeTime: true,  // false 则知识导引标题下不输出 > 00:18 – 01:51
  concurrency: 4,       // 并发请求数，卡就调小到 1~2
  download: true,       // false 则只在控制台输出，不下载文件
};

// 常用组合
// 整门课：  { from: '*', to: '*' }
// 第 3 章： { from: '3.1', to: '3.8' }
// 只要导引： { from: '*', to: '*', transcript: false }
```

## 输出结构

文档分成两棵树：正文只有知识导引，讲稿全部集中到文末的 `# 附录`。
标题层级与页面目录树的缩进一一对应，标题文字一律用目录原文，不做改写。

```
# 课程名称
## 第N章 XXX
### 1.1 XXX                     ← 节
#### 1.1.1 XXX                  ← 视频小节

<a id="k-<leaf_id>-0"></a>
##### [知识导引条目标题](#a-<leaf_id>-0)   ← 点击跳到附录
> 00:18 – 01:51                 ← 对应视频时间段
摘要正文

# 附录
## 第N章 XXX
### 1.1 XXX
#### 1.1.1 XXX

<a id="a-<leaf_id>-0"></a>
##### [知识导引条目标题](#k-<leaf_id>-0)   ← 点击跳回正文
###### 00:18                    ← 该时间段内的讲稿段落
段落正文
```

跳转规则：

- 锚点用 `<a id>` + `[标题](#id)`，id 由视频小节 id 和导引序号拼成，全文唯一。
- 讲稿段落按起始时间归到知识导引的 `[startTime, endTime)` 区间；落在区间空隙里的算给前一条。
- 早于第一条导引的段落没有归属，在附录里直接以 `##### 00:18` 平铺在小节标题下面。
- 某条导引在附录里没有对应段落时，正文的标题不加链接，避免出现点了没反应的死链。

第 3～5 章在目录里没有中间那层「节」，视频直接挂在章下面，所以两棵树都整体少一级：
`### 3.1 XXX` → `#### 知识导引条目标题` → `##### 讲稿段落`。

> 锚点写法在 GitHub、VS Code 内置预览、pandoc、静态站点里可直接跳转；
> Obsidian 不解析 HTML 锚点，需要改用 `[[#标题]]`。

## 接口

脚本复用当前页面的登录 Cookie，只额外带一个 `xtbz` 请求头（值取自同名 Cookie）。

| 用途 | 地址 |
| --- | --- |
| 课程目录树 | `GET /mooc-api/v1/lms/learn/course/chapter?cid=<classroom_id>&classroom_id=<classroom_id>` |
| 知识导引 | `GET /c27/online_courseware/leaf_knowledge/<leaf_id>/?classroom_id=<classroom_id>` |
| 讲稿 | `GET /c27/online_courseware/leaf_lecture_note/<leaf_id>/?classroom_id=<classroom_id>` |

目录树里「节」有两种形态：`section_leaf_list[i]` 下面挂 `leaf_list`（第 1、2 章），或节自身就是一个视频（第 3～5 章）。脚本两种都展开，并只保留 `leaf_type === 0` 的视频，跳过作业和考试。
