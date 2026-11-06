/*
 * 雨课堂笔记提取面板 —— 整段粘贴到浏览器控制台运行
 *
 * 步骤：
 *   1. 登录雨课堂，打开任意一节课程视频页，形如
 *      https://<雨课堂域名>/ai-workspace/lms-graph/<classroom_id>/video/<leaf_id>?is_chapter=1
 *      （www.yuketang.cn 或学校专属的 xxx.yuketang.cn 都行，脚本用的是相对路径）
 *   2. F12 -> Console，把本文件内容整段粘贴进去，回车，右下角弹出面板。
 *   3. 勾选要提取的小节（支持搜索），选导出格式，点「开始提取」。
 *
 * 面板可拖动，位置和参数记在 localStorage 里，下次打开自动恢复。
 * 再次粘贴本脚本只会重新唤出面板，不会重复注入。
 */
(() => {
  if (window.YKT_NOTE && window.YKT_NOTE.alive) {
    window.YKT_NOTE.open();
    return;
  }

  const STORE = 'ykt-note-panel';

  /* ---------------- 基础工具 ---------------- */

  const readCookie = (k) => {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };

  const cid =
    (location.pathname.match(/lms-graph\/(\d+)/) || [])[1] ||
    window.classroom_id ||
    window.classroomId ||
    readCookie('classroom_id') ||
    localStorage.getItem('classroomId');

  // 雨课堂自己的请求带的是这一组头：Xt-Agent / classroom-id / university-id / uv-id / xtbz。
  // www 上只带 xtbz 也放行，但学校专属域名（如 yjsncepu.yuketang.cn）会校验，
  // 缺了返回 error_code 80019（前端把它当 403 处理）。这些值都能从同名 Cookie 里取到。
  const buildHeaders = () => {
    const h = {
      Accept: 'application/json, text/plain, */*',
      'Xt-Agent': 'web',
      'classroom-id': String(cid),
      'university-id': readCookie('university_id'),
      'uv-id': readCookie('uv_id') || readCookie('university_id'),
      xtbz: readCookie('xtbz') || 'ykt',
    };
    const csrf = readCookie('csrftoken');
    if (csrf) h['X-CSRFToken'] = csrf;
    Object.keys(h).forEach((k) => {
      if (h[k] === '' || h[k] === 'undefined') delete h[k];
    });
    return h;
  };
  const headers = buildHeaders();

  const getJSON = async (url) => {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(url + ' → HTTP ' + res.status + (text ? '：' + text.slice(0, 300) : ''));
    }
    const body = await res.json();
    if (body && body.success === false) throw new Error(url + ' → ' + (body.msg || '请求失败'));
    return body;
  };

  // 目录接口只需要 cid + classroom_id；show_unpublished=0 跟页面保持一致，
  // 请求头才是不同部署的关键差异，见上面的 buildHeaders
  const chapterUrl = () => `/mooc-api/v1/lms/learn/course/chapter?cid=${cid}&classroom_id=${cid}&show_unpublished=0`;

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const rest = s % 3600;
    return h ? `${h}:${pad(Math.floor(rest / 60))}:${pad(rest % 60)}` : `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`;
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const saveBlob = (name, text, mime) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  /* ---------------- 目录树 ---------------- */

  // 页面目录里「节」有两种形态：下面挂多个视频，或节自身就是视频（第 3~5 章）。
  // depth 跟 TOC 的实际缩进对齐，作业/考试按 leaf_type 过滤掉。
  async function loadTree() {
    const data = (await getJSON(chapterUrl())).data;
    const leaves = [];
    for (const ch of data.course_chapter || []) {
      for (const sec of ch.section_leaf_list || []) {
        const isGroup = !!(sec.leaf_list && sec.leaf_list.length);
        for (const l of isGroup ? sec.leaf_list : [sec]) {
          if (l.leaf_type !== 0 || !l.id) continue;
          leaves.push({
            chapter: ch.name,
            section: isGroup ? sec.name : '',
            depth: isGroup ? 4 : 3,
            id: l.id,
            name: l.name,
          });
        }
      }
    }
    return { courseName: data.course_name, leaves };
  }

  /* ---------------- 文档模型 ---------------- */

  // 先生成中立节点，再分别序列化成 md / html，保证两种导出内容一致
  function buildNodes(courseName, rows, opt) {
    const main = [];
    const ap = [];
    main.push({ t: 'h', l: 1, text: courseName });
    main.push({ t: 'q', text: `雨课堂 · 提取 ${rows.length} 个小节 · ${new Date().toLocaleString()}` });

    const st = { chapter: null, section: null };
    const stA = { chapter: null, section: null };
    let seq = 0;
    const nid = () => `s-${++seq}`;
    const toc = [];
    let curCh = null;
    let curSec = null;
    let apTocId = null;

    // withToc 只给正文树打目录锚点；附录树复用同样的层级但不进目录，否则目录会翻倍
    const path = (arr, r, s, withToc) => {
      if (r.chapter !== s.chapter) {
        const node = { t: 'h', l: 2, text: r.chapter };
        if (withToc) {
          node.id = nid();
          curCh = { id: node.id, text: r.chapter, children: [] };
          curSec = null;
          toc.push(curCh);
        }
        arr.push(node);
        s.chapter = r.chapter;
        s.section = null;
      }
      if (r.section && r.section !== s.section) {
        const node = { t: 'h', l: 3, text: r.section };
        if (withToc) {
          node.id = nid();
          curSec = { id: node.id, text: r.section, children: [] };
          curCh.children.push(curSec);
        }
        arr.push(node);
        s.section = r.section;
      }
      const leaf = { t: 'h', l: r.depth, text: r.name };
      if (withToc) {
        leaf.id = nid();
        (curSec || curCh).children.push({ id: leaf.id, text: r.name, children: [] });
      }
      arr.push(leaf);
    };

    for (const r of rows) {
      if (!r.knowledge.length && !r.note.length) continue;

      // 讲稿段落归到知识导引的 [startTime, endTime) 区间，空隙算给前一条，早于首条的单独列
      const groups = r.knowledge.map(() => []);
      const orphans = [];
      for (const p of r.note) {
        let idx = -1;
        for (let i = 0; i < r.knowledge.length; i++) if (Number(p.startTime) >= Number(r.knowledge[i].startTime)) idx = i;
        (idx < 0 ? orphans : groups[idx]).push(p);
      }

      path(main, r, st, true);
      r.knowledge.forEach((k, i) => {
        main.push({
          t: 'h',
          l: r.depth + 1,
          text: k.headline,
          id: `k-${r.id}-${i}`,
          href: opt.transcript && groups[i].length ? `a-${r.id}-${i}` : null,
        });
        if (opt.knowledgeTime) main.push({ t: 'q', text: `${fmt(k.startTime)} – ${fmt(k.endTime)}` });
        main.push({ t: 'p', text: String(k.summary || '').trim() });
      });

      if (!opt.transcript || !r.note.length) continue;
      if (!ap.length) {
        const node = { t: 'h', l: 1, text: '附录' };
        node.id = nid();
        apTocId = node.id;
        ap.push(node);
      }
      path(ap, r, stA, false);

      for (const p of orphans) {
        ap.push({ t: 'h', l: r.depth + 1, text: fmt(p.startTime), cls: 'ts' });
        ap.push({ t: 'p', text: String(p.formalParagraphText || '').trim() });
      }
      r.knowledge.forEach((k, i) => {
        if (!groups[i].length) return;
        ap.push({ t: 'h', l: r.depth + 1, text: k.headline, id: `a-${r.id}-${i}`, href: `k-${r.id}-${i}` });
        for (const p of groups[i]) {
          ap.push({ t: 'h', l: r.depth + 2, text: fmt(p.startTime), cls: 'ts' });
          ap.push({ t: 'p', text: String(p.formalParagraphText || '').trim() });
        }
      });
    }
    // 附录排在目录末尾：它在主循环里生成，中途 push 会插到章节之间
    if (apTocId) toc.push({ id: apTocId, text: '附录', children: [] });
    return { nodes: main.concat(ap), toc };
  }

  function toMarkdown(nodes, toc) {
    const out = [];
    let tocDone = false;
    for (const n of nodes) {
      if (n.t === 'h') {
        // 锚点行必须与标题之间空一行，否则会被 CommonMark 当 HTML 块吞掉标题
        if (n.id) out.push(`<a id="${n.id}"></a>`, '');
        out.push(`${'#'.repeat(n.l)} ${n.href ? `[${n.text}](#${n.href})` : n.text}`, '');
      } else if (n.t === 'q') {
        out.push(`> ${n.text}`, '');
        if (!tocDone) {
          tocDone = true;
          out.push('## 目录', '');
          flatToc(toc).forEach((it) => out.push(`${'  '.repeat(it.d)}- [${it.text}](#${it.id})`));
          out.push('');
        }
      } else if (n.text) {
        out.push(n.text, '');
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // 把目录树摊平成「缩进 + 条目」，供 md 用
  function flatToc(list, d = 0) {
    const out = [];
    for (const it of list) {
      out.push({ id: it.id, text: it.text, d });
      if (it.children.length) out.push(...flatToc(it.children, d + 1));
    }
    return out;
  }

  function toHtml(nodes, title, toc) {
    const buf = [];
    for (const n of nodes) {
      if (n.t === 'h') {
        const attr = `${n.id ? ` id="${n.id}"` : ''}${n.cls ? ` class="${n.cls}"` : ''}`;
        const label = n.href ? `<a class="ykt-jump" href="#${n.href}">${esc(n.text)}</a>` : esc(n.text);
        buf.push(`<h${n.l}${attr}>${label}</h${n.l}>`);
      } else if (n.t === 'q') {
        buf.push(`<blockquote>${esc(n.text)}</blockquote>`);
      } else if (n.text) {
        buf.push(`<p>${esc(n.text)}</p>`);
      }
    }
    return [
      '<!doctype html>',
      '<html lang="zh-CN" data-theme="auto"><head><meta charset="utf-8">',
      `<meta name="viewport" content="width=device-width,initial-scale=1">`,
      `<title>${esc(title)}</title>`,
      `<style>${DOC_CSS}</style>`,
      `<script>try{document.documentElement.dataset.theme=localStorage.getItem('${THEME_KEY}')||'auto'}catch(e){}</script>`,
      '</head><body>',
      '<button id="ykt-toc-btn">☰ 目录</button>',
      '<button id="ykt-theme-btn" title="切换主题"></button>',
      `<nav id="ykt-toc">${tocNavHtml(toc)}</nav>`,
      '<article class="ykt-doc">',
      buf.join('\n'),
      '</article>',
      `<script>${DOC_JS}</script>`,
      '</body></html>',
    ].join('\n');
  }

  // 章用 <details> 折叠，节和视频用嵌套列表
  function tocNavHtml(list, depth = 0) {
    if (!list.length) return '';
    if (depth === 0) {
      return list
        .map((it) =>
          it.children.length
            ? `<details open><summary><a href="#${it.id}">${esc(it.text)}</a></summary>${tocNavHtml(it.children, 1)}</details>`
            : `<div class="ykt-toc-top"><a href="#${it.id}">${esc(it.text)}</a></div>`
        )
        .join('');
    }
    return `<ul>${list.map((it) => `<li>${it.children.length ? `<span><a href="#${it.id}">${esc(it.text)}</a></span>${tocNavHtml(it.children, 2)}` : `<a href="#${it.id}">${esc(it.text)}</a>`}</li>`).join('')}</ul>`;
  }

  /* ---------------- 导出 HTML 的排版（借鉴 VLOOK 的视觉语言） ---------------- */

  const THEME_KEY = 'ykt-note-theme';

  const DOC_JS = `
(function(){
  var KEY='${THEME_KEY}', root=document.documentElement, btn=document.getElementById('ykt-theme-btn');
  var LABEL={auto:'自动',light:'浅色',dark:'深色'};
  function get(){ return root.dataset.theme in LABEL ? root.dataset.theme : 'auto' }
  function set(v){ root.dataset.theme=v; try{localStorage.setItem(KEY,v)}catch(e){} label() }
  function label(){ btn.textContent=(get()==='auto'?'◐ ':'● ')+LABEL[get()] }
  btn.onclick=function(){ var o=['auto','light','dark']; set(o[(o.indexOf(get())+1)%3]) }
  label();

  var tocBtn=document.getElementById('ykt-toc-btn');
  tocBtn.onclick=function(){ document.body.classList.toggle('toc-open') };
  document.getElementById('ykt-toc').addEventListener('click',function(e){
    if(e.target.tagName==='A' && innerWidth<=1100) document.body.classList.remove('toc-open');
  });

  // 滚动高亮：找当前视口顶部之上最近的标题
  var links={}, items=[];
  document.querySelectorAll('#ykt-toc a[href^="#"]').forEach(function(a){
    links[a.getAttribute('href').slice(1)]=a;
  });
  document.querySelectorAll('.ykt-doc h2[id],.ykt-doc h3[id],.ykt-doc h4[id],.ykt-doc h1[id]').forEach(function(h){
    if(links[h.id]) items.push(h);
  });
  var cur=null;
  function spy(){
    var top=120, pick=null;
    for(var i=0;i<items.length;i++){ if(items[i].getBoundingClientRect().top<=top) pick=items[i]; else break }
    if(pick===cur) return;
    if(cur) links[cur.id].classList.remove('on');
    cur=pick;
    if(cur){
      links[cur.id].classList.add('on');
      var d=links[cur.id].closest('details'); if(d) d.open=true;
    }
  }
  addEventListener('scroll',spy,{passive:true}); addEventListener('resize',spy); spy();
})();`;

  const DOC_CSS = `
:root{
  --fg:#23272e;--fg2:#5f6b76;--accent:#0f6dad;--accent-soft:#dcecf7;
  --rule:#e6e9ed;--soft:#f7f9fb;--page:#eef1f5;--panel:#fff;--pill-fg:#fff;
  --serif:"Songti SC","STSong","SimSun",Georgia,"Times New Roman",serif;
  --sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{--fg:#d4d9df;--fg2:#98a2ad;--accent:#5aaee0;--accent-soft:#1d3a52;
    --rule:#2b323a;--soft:#1e242b;--page:#14181d;--panel:#1a1f25;--pill-fg:#14181d}
}
html[data-theme=light]{--fg:#23272e;--fg2:#5f6b76;--accent:#0f6dad;--accent-soft:#dcecf7;
  --rule:#e6e9ed;--soft:#f7f9fb;--page:#eef1f5;--panel:#fff;--pill-fg:#fff}
html[data-theme=dark]{--fg:#d4d9df;--fg2:#98a2ad;--accent:#5aaee0;--accent-soft:#1d3a52;
  --rule:#2b323a;--soft:#1e242b;--page:#14181d;--panel:#1a1f25;--pill-fg:#14181d}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--fg);font-family:var(--sans);font-size:16px;line-height:1.778;padding-left:272px}
.ykt-doc{max-width:880px;margin:28px auto;padding:60px 68px 72px;background:var(--panel);
  border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,.05),0 8px 28px rgba(0,0,0,.06)}
#ykt-toc{position:fixed;left:0;top:0;width:272px;height:100vh;overflow-y:auto;padding:16px 10px 48px;
  background:var(--panel);border-right:1px solid var(--rule);font-size:12.5px;line-height:1.55;z-index:5}
#ykt-toc a{color:var(--fg2);text-decoration:none;display:block;padding:2px 6px;border-radius:4px}
#ykt-toc a:hover{color:var(--accent);background:var(--soft)}
#ykt-toc a.on{color:var(--accent);background:var(--accent-soft);font-weight:600}
#ykt-toc summary{cursor:pointer;list-style:none}
#ykt-toc summary::-webkit-details-marker{display:none}
#ykt-toc summary::before{content:"▸";display:inline-block;width:12px;color:var(--fg2);transition:transform .15s}
#ykt-toc details[open]>summary::before{transform:rotate(90deg)}
#ykt-toc summary>a{display:inline-block;font-weight:600;color:var(--fg);padding:3px 6px}
#ykt-toc ul{margin:2px 0 6px;padding-left:20px;list-style:none;border-left:1px solid var(--rule)}
#ykt-toc li{margin:1px 0}
#ykt-toc-top,.ykt-toc-top{margin:6px 0}
#ykt-theme-btn{position:fixed;right:16px;top:16px;z-index:6;height:28px;padding:0 12px;border:1px solid var(--rule);
  border-radius:14px;background:var(--panel);color:var(--fg2);font:12px/1 var(--sans);cursor:pointer}
#ykt-theme-btn:hover{color:var(--accent);border-color:var(--accent)}
#ykt-toc-btn{display:none;position:fixed;left:12px;top:12px;z-index:6;height:28px;padding:0 12px;
  border:1px solid var(--rule);border-radius:14px;background:var(--panel);color:var(--fg2);font:12px/1 var(--sans);cursor:pointer}
@media (max-width:1100px){
  body{padding-left:0}
  #ykt-toc{transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 30px rgba(0,0,0,.25)}
  body.toc-open #ykt-toc{transform:none}
  #ykt-toc-btn{display:block}
}
.ykt-doc>*:first-child{margin-top:0}
.ykt-doc h1,.ykt-doc h2,.ykt-doc h3,.ykt-doc h4,.ykt-doc h5{font-family:var(--serif);font-weight:700;
  line-height:1.38;margin:1.9em 0 .85em;letter-spacing:.01em;color:var(--fg)}
.ykt-doc h1{font-size:2em;text-align:center;margin-top:0;padding-bottom:.4em;border-bottom:3px double var(--rule)}
.ykt-doc h1+h1,.ykt-doc blockquote+h1{margin-top:2.4em}
.ykt-doc h2{font-size:1.5em;padding:.15em 0 .3em .55em;border-left:5px solid var(--accent);
  border-bottom:1px solid var(--rule);background:linear-gradient(90deg,var(--accent-soft) 0,transparent 42%)}
.ykt-doc h3{font-size:1.28em;padding-left:.5em;border-left:3px solid var(--accent-soft)}
.ykt-doc h4{font-size:1.12em}
.ykt-doc h4::before{content:"";display:inline-block;width:.42em;height:.42em;margin-right:.5em;
  vertical-align:.1em;background:var(--accent);transform:rotate(45deg)}
.ykt-doc h5{font-size:1em;color:var(--accent);padding-bottom:.25em;border-bottom:1px dashed var(--rule)}
.ykt-doc h6,.ykt-doc h5.ts,.ykt-doc h4.ts{font-family:var(--sans);font-weight:600;font-size:.9em;
  color:var(--pill-fg);background:var(--accent);display:inline-block;padding:.12em .6em;border-radius:3px;margin:.9em 0 -.3em}
.ykt-doc p{margin:.75em 0;text-align:justify}
.ykt-doc blockquote{margin:1em 0;padding:.5em 1em;background:var(--soft);border-left:4px solid var(--accent-soft);
  color:var(--fg2);font-size:.94em;border-radius:0 3px 3px 0}
.ykt-doc a{color:var(--accent);text-decoration:none}
.ykt-doc a:hover{text-decoration:underline}
.ykt-jump{border-bottom:1px dotted var(--accent)}
.ykt-jump::after{content:"\\21C4";font-size:.72em;margin-left:.4em;color:var(--fg2)}
h1,h2,h3,h4,h5,h6{scroll-margin-top:18px}
@media print{
  body{background:#fff;padding-left:0}
  #ykt-toc,#ykt-theme-btn,#ykt-toc-btn{display:none}
  .ykt-doc{max-width:none;margin:0;padding:0;box-shadow:none}
  .ykt-jump::after{content:""}
  h2,h3,h4{page-break-after:avoid}
}`;

  /* ---------------- 面板样式 ---------------- */

  const PANEL_CSS = `
#ykt-note-panel{position:fixed;z-index:2147483647;left:24px;top:90px;width:340px;background:#fff;
  border:1px solid #dfe3e8;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.18);color:#23272e;
  font:13px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;user-select:none;overflow:hidden}
#ykt-note-panel *{box-sizing:border-box}
#ykt-note-panel .yn-head{display:flex;align-items:center;gap:7px;padding:9px 10px;background:#0f6dad;color:#fff;cursor:move}
#ykt-note-panel .yn-title{font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ykt-note-panel .yn-count{font-size:11px;opacity:.85;white-space:nowrap}
#ykt-note-panel .yn-head button{width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;
  color:#fff;font-size:14px;line-height:18px;cursor:pointer}
#ykt-note-panel .yn-head button:hover{background:rgba(255,255,255,.22)}
#ykt-note-panel .yn-body{padding:10px}
#ykt-note-panel .yn-min{display:none}
#ykt-note-panel.min .yn-body,#ykt-note-panel.min .yn-foot{display:none}
#ykt-note-panel .yn-search input{width:100%;height:28px;padding:0 8px;border:1px solid #dfe3e8;border-radius:5px;
  font:inherit;outline:none}
#ykt-note-panel .yn-search input:focus{border-color:#0f6dad;box-shadow:0 0 0 2px rgba(15,109,173,.14)}
#ykt-note-panel .yn-tools{display:flex;gap:6px;margin:7px 0}
#ykt-note-panel .yn-tools button{flex:1;height:24px;border:1px solid #dfe3e8;border-radius:5px;background:#f7f9fb;
  color:#3d4650;font:inherit;font-size:12px;cursor:pointer}
#ykt-note-panel .yn-tools button:hover{border-color:#0f6dad;color:#0f6dad}
#ykt-note-panel .yn-tree{height:230px;overflow-y:auto;border:1px solid #eef1f4;border-radius:6px;padding:4px 6px}
#ykt-note-panel .yn-row{display:flex;align-items:center;gap:5px;padding:2px 0;white-space:nowrap;overflow:hidden}
#ykt-note-panel .yn-row input{flex:none;margin:0}
#ykt-note-panel .yn-fold{flex:none;width:14px;color:#8b96a1;cursor:pointer;font-size:10px;text-align:center}
#ykt-note-panel .yn-name{overflow:hidden;text-overflow:ellipsis;cursor:pointer;flex:1}
#ykt-note-panel .yn-num{color:#a2abb4;font-size:11px}
#ykt-note-panel .yn-ch .yn-name{font-weight:600}
#ykt-note-panel .yn-sec{padding-left:16px}
#ykt-note-panel .yn-leaf{padding-left:32px;color:#454d55}
#ykt-note-panel .yn-leaf.on .yn-name{color:#0f6dad}
#ykt-note-panel .yn-empty{padding:24px 0;text-align:center;color:#a2abb4}
#ykt-note-panel .yn-opts{margin-top:9px;border-top:1px solid #eef1f4;padding-top:9px}
#ykt-note-panel .yn-rowline{display:flex;align-items:center;gap:8px;margin-bottom:7px}
#ykt-note-panel .yn-rowline>span{width:58px;color:#5f6b76;flex:none}
#ykt-note-panel select,#ykt-note-panel input[type=number]{height:26px;border:1px solid #dfe3e8;border-radius:5px;
  font:inherit;background:#fff;outline:none;flex:1}
#ykt-note-panel select{max-height:160px}
#ykt-note-panel input[type=number]{width:60px;flex:none;padding:0 6px}
#ykt-note-panel .yn-checks{display:flex;gap:14px;margin-bottom:7px}
#ykt-note-panel .yn-checks label{display:flex;align-items:center;gap:5px;cursor:pointer}
#ykt-note-panel .yn-foot{display:flex;align-items:center;gap:8px;padding:9px 10px;border-top:1px solid #eef1f4;background:#fafbfc}
#ykt-note-panel .yn-bar{flex:1;height:5px;border-radius:3px;background:#e8ecf0;overflow:hidden}
#ykt-note-panel .yn-bar i{display:block;height:100%;width:0;background:#0f6dad;transition:width .18s}
#ykt-note-panel .yn-status{font-size:11px;color:#7c8792;white-space:nowrap}
#ykt-note-panel .yn-run{height:27px;padding:0 13px;border:0;border-radius:5px;background:#0f6dad;color:#fff;
  font:inherit;font-weight:600;cursor:pointer}
#ykt-note-panel .yn-run:hover{background:#0c5c94}
#ykt-note-panel .yn-run.busy{background:#c9ced4;cursor:default}
#ykt-toast{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;
  padding:10px 20px;border-radius:6px;background:rgba(35,39,46,.92);color:#fff;font:13px/1.5 "PingFang SC",sans-serif;
  opacity:0;transition:opacity .18s;pointer-events:none;max-width:70vw;text-align:center}
@media (prefers-color-scheme:dark){
  #ykt-note-panel{background:#1a1f25;border-color:#2b323a;color:#d4d9df}
  #ykt-note-panel .yn-head{background:#123c58}
  #ykt-note-panel .yn-search input,#ykt-note-panel select,#ykt-note-panel input[type=number]{
    background:#141a20;border-color:#2b323a;color:#d4d9df}
  #ykt-note-panel .yn-search input:focus{border-color:#5aaee0;box-shadow:0 0 0 2px rgba(90,174,224,.2)}
  #ykt-note-panel .yn-tools button{background:#20272e;border-color:#2b323a;color:#b6c0ca}
  #ykt-note-panel .yn-tools button:hover{border-color:#5aaee0;color:#5aaee0}
  #ykt-note-panel .yn-tree{border-color:#2b323a}
  #ykt-note-panel .yn-fold{color:#7d8894}
  #ykt-note-panel .yn-leaf{color:#b6c0ca}
  #ykt-note-panel .yn-leaf.on .yn-name{color:#5aaee0}
  #ykt-note-panel .yn-num,#ykt-note-panel .yn-empty{color:#7d8894}
  #ykt-note-panel .yn-opts,#ykt-note-panel .yn-foot{border-color:#2b323a}
  #ykt-note-panel .yn-opts>div>span{color:#98a2ad}
  #ykt-note-panel .yn-foot{background:#161c22}
  #ykt-note-panel .yn-bar{background:#2b323a}
  #ykt-note-panel .yn-bar i{background:#5aaee0}
  #ykt-note-panel .yn-status{color:#98a2ad}
  #ykt-note-panel .yn-run{background:#1d6fb0}
  #ykt-note-panel .yn-run:hover{background:#5aaee0;color:#14181d}
  #ykt-note-panel .yn-run.busy{background:#39424c;color:#b6c0ca}
  #ykt-toast{background:rgba(212,217,223,.94);color:#14181d}
}`;

  /* ---------------- 状态 ---------------- */

  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE) || '{}');
    } catch (e) {
      return {};
    }
  })();

  const S = {
    leaves: [],
    courseName: '',
    picked: new Set(),
    open: new Set(),
    keyword: '',
    busy: false,
    cancel: false,
    keyLeaves: new Map(),
    opt: Object.assign({ format: 'md', transcript: true, knowledgeTime: true, concurrency: 4 }, saved.opt),
    pos: saved.pos || null,
  };

  const persist = () => localStorage.setItem(STORE, JSON.stringify({ opt: S.opt, pos: S.pos }));

  /* ---------------- 面板 ---------------- */

  let root, els;

  function buildPanel() {
    if (!document.getElementById('ykt-note-style')) {
      const style = document.createElement('style');
      style.id = 'ykt-note-style';
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
    }

    root = document.createElement('div');
    root.id = 'ykt-note-panel';
    root.innerHTML = `
      <div class="yn-head">
        <span class="yn-title">雨课堂笔记提取</span>
        <span class="yn-count">已选 0</span>
        <button class="yn-min" title="展开/收起">—</button>
        <button class="yn-close" title="关闭">×</button>
      </div>
      <div class="yn-body">
        <div class="yn-search"><input type="search" placeholder="搜索小节 / 章节"></div>
        <div class="yn-tools">
          <button data-act="all">全选</button>
          <button data-act="invert">反选</button>
          <button data-act="none">清空</button>
        </div>
        <div class="yn-tree"></div>
        <div class="yn-opts">
          <div class="yn-rowline"><span>导出格式</span>
            <select class="yn-format">
              <option value="md">Markdown (.md)</option>
              <option value="both">Markdown + HTML</option>
            </select>
          </div>
          <div class="yn-checks">
            <label><input type="checkbox" class="yn-transcript"><span>附带讲稿附录</span></label>
            <label><input type="checkbox" class="yn-time"><span>标注时间段</span></label>
          </div>
          <div class="yn-rowline"><span>并发数</span><input type="number" class="yn-conc" min="1" max="8" step="1"></div>
        </div>
      </div>
      <div class="yn-foot">
        <div class="yn-bar"><i></i></div>
        <div class="yn-status">加载中…</div>
        <button class="yn-run">开始提取</button>
      </div>`;
    document.body.appendChild(root);

    els = {
      count: root.querySelector('.yn-count'),
      search: root.querySelector('.yn-search input'),
      tree: root.querySelector('.yn-tree'),
      format: root.querySelector('.yn-format'),
      transcript: root.querySelector('.yn-transcript'),
      time: root.querySelector('.yn-time'),
      conc: root.querySelector('.yn-conc'),
      bar: root.querySelector('.yn-bar i'),
      status: root.querySelector('.yn-status'),
      run: root.querySelector('.yn-run'),
      head: root.querySelector('.yn-head'),
    };

    els.format.value = String(S.opt.format);
    els.transcript.checked = !!S.opt.transcript;
    els.time.checked = !!S.opt.knowledgeTime;
    els.conc.value = S.opt.concurrency;

    if (S.pos) {
      root.style.left = S.pos.x + 'px';
      root.style.top = S.pos.y + 'px';
    }

    bindDrag();
    root.querySelector('.yn-close').onclick = () => root.remove();
    root.querySelector('.yn-min').onclick = () => root.classList.toggle('min');
    els.search.oninput = () => {
      S.keyword = els.search.value;
      renderTree();
    };
    root.querySelectorAll('.yn-tools button').forEach((b) => {
      b.onclick = () => {
        const ids = visibleLeaves().map((l) => l.id);
        if (b.dataset.act === 'all') ids.forEach((i) => S.picked.add(i));
        if (b.dataset.act === 'none') ids.forEach((i) => S.picked.delete(i));
        if (b.dataset.act === 'invert') ids.forEach((i) => (S.picked.has(i) ? S.picked.delete(i) : S.picked.add(i)));
        renderTree();
      };
    });
    els.tree.addEventListener('change', onTreeChange);
    els.tree.addEventListener('click', (e) => {
      const fold = e.target.closest('.yn-fold');
      if (!fold) return;
      const key = fold.dataset.key;
      S.open.has(key) ? S.open.delete(key) : S.open.add(key);
      renderTree();
    });
    ['format', 'transcript', 'time', 'conc'].forEach((k) => {
      els[k].onchange = () => {
        S.opt.format = els.format.value;
        S.opt.transcript = els.transcript.checked;
        S.opt.knowledgeTime = els.time.checked;
        S.opt.concurrency = Math.min(8, Math.max(1, Number(els.conc.value) || 4));
        persist();
      };
    });
    els.run.onclick = run;
  }

  function bindDrag() {
    let dx = 0, dy = 0, active = false;
    els.head.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      active = true;
      dx = e.clientX - root.offsetLeft;
      dy = e.clientY - root.offsetTop;
      els.head.setPointerCapture(e.pointerId);
    });
    els.head.addEventListener('pointermove', (e) => {
      if (!active) return;
      root.style.left = Math.max(0, Math.min(innerWidth - 60, e.clientX - dx)) + 'px';
      root.style.top = Math.max(0, Math.min(innerHeight - 40, e.clientY - dy)) + 'px';
    });
    const stop = () => {
      if (!active) return;
      active = false;
      S.pos = { x: root.offsetLeft, y: root.offsetTop };
      persist();
    };
    els.head.addEventListener('pointerup', stop);
    els.head.addEventListener('pointercancel', stop);
  }

  /* ---------------- 树渲染 ---------------- */

  const visibleLeaves = () => {
    const kw = S.keyword.trim().toLowerCase();
    if (!kw) return S.leaves;
    return S.leaves.filter((l) => (l.chapter + ' ' + l.section + ' ' + l.name).toLowerCase().includes(kw));
  };

  function grouped() {
    const out = [];
    for (const l of visibleLeaves()) {
      let ch = out.find((c) => c.chapter === l.chapter);
      if (!ch) out.push((ch = { chapter: l.chapter, secs: [] }));
      let sec = ch.secs.find((s) => s.section === l.section);
      if (!sec) ch.secs.push((sec = { section: l.section, leaves: [] }));
      sec.leaves.push(l);
    }
    return out;
  }

  function renderTree() {
    const rows = [];
    const keyLeaves = new Map();
    for (const ch of grouped()) {
      const chKey = 'C:' + ch.chapter;
      const chOpen = S.open.has(chKey);
      const chLeaves = ch.secs.flatMap((s) => s.leaves);
      keyLeaves.set(chKey, chLeaves);
      rows.push(
        `<div class="yn-row yn-ch" data-key="${esc(chKey)}">
           <input type="checkbox" data-kind="ch" data-key="${esc(chKey)}" ${allOn(chLeaves) ? 'checked' : ''}>
           <span class="yn-fold" data-key="${esc(chKey)}">${chOpen ? '▾' : '▸'}</span>
           <span class="yn-name">${esc(ch.chapter)}</span>
           <span class="yn-num">${chLeaves.length}</span>
         </div>`
      );
      if (!chOpen) continue;
      for (const sec of ch.secs) {
        if (sec.section) {
          const sKey = 'S:' + ch.chapter + '|' + sec.section;
          const sOpen = S.open.has(sKey);
          keyLeaves.set(sKey, sec.leaves);
          rows.push(
            `<div class="yn-row yn-sec" data-key="${esc(sKey)}">
               <input type="checkbox" data-kind="sec" data-key="${esc(sKey)}" ${allOn(sec.leaves) ? 'checked' : ''}>
               <span class="yn-fold" data-key="${esc(sKey)}">${sOpen ? '▾' : '▸'}</span>
               <span class="yn-name">${esc(sec.section)}</span>
               <span class="yn-num">${sec.leaves.length}</span>
             </div>`
          );
          if (!sOpen) continue;
        }
        for (const l of sec.leaves) {
          rows.push(
            `<div class="yn-row yn-leaf ${S.picked.has(l.id) ? 'on' : ''}">
               <input type="checkbox" data-kind="leaf" data-id="${l.id}" ${S.picked.has(l.id) ? 'checked' : ''}>
               <span class="yn-name" title="${esc(l.name)}">${esc(l.name)}</span>
             </div>`
          );
        }
      }
    }
    S.keyLeaves = keyLeaves;
    els.tree.innerHTML = rows.length ? rows.join('') : '<div class="yn-empty">没有匹配的小节</div>';

    // 半选状态：组里只选了一部分时显示 indeterminate
    els.tree.querySelectorAll('input[data-kind=ch],input[data-kind=sec]').forEach((box) => {
      const set = box.dataset.kind === 'ch' ? chapterLeaves(box.dataset.key) : sectionLeaves(box.dataset.key);
      const on = set.filter((l) => S.picked.has(l.id)).length;
      box.indeterminate = on > 0 && on < set.length;
      box.checked = on === set.length && set.length > 0;
    });
    els.count.textContent = `已选 ${S.picked.size}`;
  }

  // 组勾选只作用于当前过滤后可见的小节，跟列表里显示的勾选状态保持一致
  const chapterLeaves = (key) => S.keyLeaves.get(key) || [];
  const sectionLeaves = (key) => S.keyLeaves.get(key) || [];
  const allOn = (leaves) => leaves.length > 0 && leaves.every((l) => S.picked.has(l.id));

  function onTreeChange(e) {
    const box = e.target;
    if (box.dataset.kind === 'leaf') {
      const id = Number(box.dataset.id);
      box.checked ? S.picked.add(id) : S.picked.delete(id);
      renderTree();
      return;
    }
    const set = box.dataset.kind === 'ch' ? chapterLeaves(box.dataset.key) : sectionLeaves(box.dataset.key);
    set.forEach((l) => (box.checked ? S.picked.add(l.id) : S.picked.delete(l.id)));
    S.open.add(box.dataset.key);
    if (box.dataset.kind === 'ch') set.forEach((l) => l.section && S.open.add('S:' + l.chapter + '|' + l.section));
    renderTree();
  }

  /* ---------------- 提取 ---------------- */

  let toastTimer;
  function toast(msg) {
    let t = document.getElementById('ykt-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'ykt-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.opacity = '0'), 3000);
  }

  async function run() {
    if (S.busy) {
      S.cancel = true;
      return;
    }
    const targets = S.leaves.filter((l) => S.picked.has(l.id));
    if (!targets.length) return toast('先勾选要提取的小节');

    S.busy = true;
    S.cancel = false;
    els.run.textContent = '取消';
    els.run.classList.add('busy');

    const rows = [];
    let done = 0;
    let cursor = 0;
    const step = async () => {
      while (cursor < targets.length && !S.cancel) {
        const l = targets[cursor++];
        const knowledge = await getJSON(`/c27/online_courseware/leaf_knowledge/${l.id}/?classroom_id=${cid}`)
          .then((r) => r.data || [])
          .catch(() => []);
        const note = S.opt.transcript
          ? await getJSON(`/c27/online_courseware/leaf_lecture_note/${l.id}/?classroom_id=${cid}`)
              .then((r) => r.data || [])
              .catch(() => [])
          : [];
        rows.push({ ...l, knowledge, note });
        done++;
        els.bar.style.width = Math.round((done / targets.length) * 100) + '%';
        els.status.textContent = `${done}/${targets.length}`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(S.opt.concurrency, targets.length) }, step));

    S.busy = false;
    els.run.textContent = '开始提取';
    els.run.classList.remove('busy');

    if (S.cancel) {
      els.status.textContent = '已取消';
      els.bar.style.width = '0';
      return toast('已取消，未生成文件');
    }

    // 并发回来的顺序是乱的，按目录里的原始次序排回去
    const rank = new Map(S.leaves.map((l, i) => [l.id, i]));
    rows.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const { nodes, toc } = buildNodes(S.courseName, rows, S.opt);
    const stem = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');
    const base = stem(S.courseName);

    saveBlob(`${base}.md`, toMarkdown(nodes, toc), 'text/markdown');
    if (S.opt.format === 'both') {
      // 连发两个 blob 会被 Chrome 拦成「允许多个下载」，错开一点更稳
      setTimeout(() => saveBlob(`${base}.html`, toHtml(nodes, S.courseName, toc), 'text/html'), 400);
    }

    els.status.textContent = '完成';
    els.bar.style.width = '100%';
    toast(`已导出 ${rows.length} 个小节${S.opt.format === 'both' ? '（.md + .html）' : ''}`);
  }

  /* ---------------- 启动 ---------------- */

  buildPanel();

  if (!cid) {
    els.status.textContent = '未识别到课程';
    els.tree.innerHTML = '<div class="yn-empty">请在课程视频页运行本脚本</div>';
    return;
  }

  loadTree()
    .then(({ courseName, leaves }) => {
      S.courseName = courseName;
      S.leaves = leaves;
      leaves.forEach((l) => S.picked.add(l.id)); // 默认全选，要减就用搜索或点章/节的复选框
      const current = Number((location.pathname.match(/video\/(\d+)/) || [])[1]);
      const here = leaves.find((l) => l.id === current) || leaves[0];
      if (here) {
        S.open.add('C:' + here.chapter);
        if (here.section) S.open.add('S:' + here.chapter + '|' + here.section);
      }
      renderTree();
      els.status.textContent = `共 ${leaves.length} 个小节`;
    })
    .catch((e) => {
      els.status.textContent = '加载失败';
      els.tree.innerHTML = `<div class="yn-empty">${esc(e.message)}</div>`;
    });

  window.YKT_NOTE = {
    alive: true,
    open: () => {
      if (!document.getElementById('ykt-note-panel')) {
        root = null;
        buildPanel();
        renderTree();
      }
      root.classList.remove('min');
      root.style.display = '';
    },
  };
})();
