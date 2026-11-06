/*
 * 雨课堂作业习题提取 —— 整段粘贴到浏览器控制台运行，直接下载 HTML，没有面板
 *
 * 步骤：
 *   1. 登录雨课堂，打开本课程任意一个页面（作业页或视频页都行）。
 *   2. F12 -> Console，把本文件内容整段粘贴进去，回车。
 *   3. 浏览器下载 `<课程名>-习题.html`。
 *
 * 改范围：粘贴前先执行
 *   window.YKT_HW_CONFIG = { chapter: null }   // null = 全部章节的作业
 *   window.YKT_HW_CONFIG = { chapter: 3 }      // 只要第 3 章
 */
(async function () {
  const CFG = Object.assign({ chapter: null, concurrency: 4, open: true }, window.YKT_HW_CONFIG || {});

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
  if (!cid) throw new Error('识别不到 classroom_id，请在课程页面运行本脚本');

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

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 题干本身是富文本，保留标签但去掉脚本和事件属性
  const safeHtml = (html) =>
    String(html || '')
      .replace(/<\s*(script|iframe|object|embed|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|iframe|object|embed|style)\b[^>]*\/?>/gi, '')
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
      .replace(/href\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, 'href=$1#');

  /* ---------- 收集作业小节 ---------- */

  const tree = (await getJSON(chapterUrl())).data;
  const chapterNum = (name) => Number(((String(name).match(/第\s*(\d+)\s*章/) || [])[1]) || null);

  const jobs = [];
  for (const ch of tree.course_chapter || []) {
    if (CFG.chapter != null && chapterNum(ch.name) !== CFG.chapter) continue;
    for (const sec of ch.section_leaf_list || []) {
      const items = sec.leaf_list && sec.leaf_list.length ? sec.leaf_list : [sec];
      for (const l of items) {
        // leaf_type 6 = 作业；视频是 0，考试走另一套接口，这里不碰
        if (l.leaf_type === 6 && l.id) jobs.push({ chapter: ch.name, leafId: l.id, name: l.name });
      }
    }
  }
  if (!jobs.length) throw new Error(`第 ${CFG.chapter} 章没有作业小节，或该章不存在`);
  console.log(`找到 ${jobs.length} 个作业：` + jobs.map((j) => j.name).join('、'));

  /* ---------- 逐份取题 ---------- */

  const pool = async (items, size, worker) => {
    const out = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(size, items.length) }, async () => {
        while (cursor < items.length) {
          const i = cursor++;
          out[i] = await worker(items[i], i);
        }
      })
    );
    return out;
  };

  const sheets = (await pool(jobs, CFG.concurrency, async (j) => {
    // 作业小节里的 leaf_type_id 就是 exercise_id
    const info = await getJSON(`/mooc-api/v1/lms/learn/leaf_info/${cid}/${j.leafId}/?classroom_id=${cid}`).then((r) => r.data);
    const exerciseId = info && info.content_info && info.content_info.leaf_type_id;
    if (!exerciseId) return { ...j, problems: [], error: '没有 exercise_id' };
    try {
      const detail = (await getJSON(`/c27/online_courseware/exercise/get_exercise_detail/${exerciseId}/?classroom_id=${cid}`)).data;
      console.log(`  ✓ ${j.name} —— ${(detail.problems || []).length} 题`);
      return { ...j, exerciseId, name: detail.name || j.name, problems: detail.problems || [] };
    } catch (e) {
      console.log(`  × ${j.name} —— ${e.message}`);
      return { ...j, exerciseId, problems: [], error: e.message };
    }
  })).filter((s) => s.problems.length);

  if (!sheets.length) throw new Error('没有取到任何题目');

  /* ---------- 渲染 ---------- */

  // 有的课（如科研伦理）题干和选项存的是整份 HTML 文档：
  // <!DOCTYPE html><html><head></head><body><p>…</p></body></html>
  // 直接塞进 div 里只能指望浏览器忽略 html/body 标签，不可靠，这里先剥掉外壳
  const unwrapDoc = (html) => {
    const s = String(html || '');
    const m = s.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return (m ? m[1] : s)
      .replace(/<!\s*doctype[^>]*>/gi, '')
      .replace(/<\/?\s*(?:html|head|body)\b[^>]*>/gi, '');
  };

  const toPlain = (html) =>
    unwrapDoc(html)
      .replace(/<\s*br\s*\/?>/gi, ' ')
      .replace(/<\/\s*(?:p|div|li|tr|h[1-6])\s*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  // 不同课程建题方式不同：判断题/多选题的 Answer 是数组，但有的课单选题直接给字符串 "A"，
  // 主观题/填空题给的是答案文本，所以先统一成数组
  const asArr = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);

  // 答案拆成 {key, text}：选择题 key=字母、text=选项文本；判断题整体是「正确/错误」；
  // 填空和主观题映射不到 key，答案本身就是文本
  const answerItems = (p) => {
    const c = p.content || {};
    const map = new Map((c.Options || []).map((o) => [String(o.key), toPlain(o.value)]));
    const isJudge = (c.TypeText || '').includes('判断');
    return asArr(c.Answer).map((raw) => {
      const k = String(raw);
      const v = map.get(k);
      if (v == null) return { key: '', text: toPlain(k) };
      if (isJudge) return { key: v, text: '' };
      return { key: k, text: v };
    });
  };

  const qAnchor = (s, p) => `q-${s.leafId}-${p.index}`;

  const qHtml = (s, p) => {
    const c = p.content || {};
    const opts = (c.Options || []).map((o) => `<li><b>${esc(o.key)}.</b> ${esc(toPlain(o.value))}</li>`).join('');
    const items = answerItems(p);
    const ans = items.length
      ? `<div class="hw-q-ans"><div class="hw-q-ans-label">正确答案：</div><ul class="hw-q-ans-list">` +
        items.map((it) => `<li><span class="hw-key">${esc(it.key + (it.text ? '.' : ''))}</span><span class="hw-val">${esc(it.text)}</span></li>`).join('') +
        `</ul></div>`
      : '<div class="hw-q-ans"><div class="hw-q-ans-label">正确答案：<span class="hw-q-none">（无客观答案）</span></div></div>';
    return `
      <article class="hw-q" id="${qAnchor(s, p)}">
        <h3 class="hw-q-head">
          <span class="hw-q-num">${esc(p.index)}</span>
          <span class="hw-q-type">${esc(c.TypeText || '题目')}</span>
          <span class="hw-q-score">${esc(c.Score)} 分</span>
        </h3>
        <div class="hw-q-body">${safeHtml(unwrapDoc(c.Body))}</div>
        ${opts ? `<ol class="hw-q-opts">${opts}</ol>` : ''}
        ${ans}
      </article>`;
  };

  const shortTitle = (p) => {
    const c = p.content || {};
    const text = toPlain(c.Body);
    return `${c.TypeText || '题目'} · ${text.length > 26 ? text.slice(0, 26) + '…' : text}`;
  };

  const CSS = `
:root{
  --fg:#23272e;--fg2:#5f6b76;--accent:#0f6dad;--accent-soft:#dcecf7;--wrong:#c0392b;--ok:#1a7f37;
  --rule:#e6e9ed;--soft:#f7f9fb;--page:#eef1f5;--panel:#fff;
  --serif:"Songti SC","STSong","SimSun",Georgia,serif;
  --sans:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{--fg:#d4d9df;--fg2:#98a2ad;--accent:#5aaee0;--accent-soft:#1d3a52;--wrong:#e57373;--ok:#3fb950;
    --rule:#2b323a;--soft:#1e242b;--page:#14181d;--panel:#1a1f25}
}
html[data-theme=light]{--fg:#23272e;--fg2:#5f6b76;--accent:#0f6dad;--accent-soft:#dcecf7;--wrong:#c0392b;--ok:#1a7f37;
  --rule:#e6e9ed;--soft:#f7f9fb;--page:#eef1f5;--panel:#fff}
html[data-theme=dark]{--fg:#d4d9df;--fg2:#98a2ad;--accent:#5aaee0;--accent-soft:#1d3a52;--wrong:#e57373;--ok:#3fb950;
  --rule:#2b323a;--soft:#1e242b;--page:#14181d;--panel:#1a1f25}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--fg);font-family:var(--sans);font-size:16px;line-height:1.778;padding-left:268px}
.hw-doc{max-width:820px;margin:26px auto;padding:52px 60px 64px;background:var(--panel);border-radius:4px;
  box-shadow:0 1px 3px rgba(0,0,0,.05),0 8px 28px rgba(0,0,0,.06)}
.hw-doc>*:first-child{margin-top:0}
h1,h2{font-family:var(--serif);color:var(--fg)}
h1{font-size:2em;text-align:center;margin:0 0 .5em;padding-bottom:.35em;border-bottom:3px double var(--rule)}
h2{font-size:1.4em;margin:2em 0 .8em;padding:.15em 0 .3em .55em;border-left:5px solid var(--accent);
  border-bottom:1px solid var(--rule);background:linear-gradient(90deg,var(--accent-soft) 0,transparent 42%)}
blockquote{margin:1em 0;padding:.5em 1em;background:var(--soft);border-left:4px solid var(--accent-soft);
  color:var(--fg2);font-size:.92em;border-radius:0 3px 3px 0}
.hw-q{margin:1.4em 0;padding:16px 18px;border:1px solid var(--rule);border-radius:6px;background:var(--panel)}
.hw-q-head{display:flex;align-items:center;gap:9px;margin:0 0 .6em;font:600 14px/1.4 var(--sans);color:var(--fg2)}
.hw-q-num{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;padding:0 6px;
  border-radius:12px;background:var(--accent);color:#fff;font-size:13px}
.hw-q-type{color:var(--accent);font-size:13px}
.hw-q-score{margin-left:auto;font-size:12px;color:var(--fg2)}
.hw-q-body{margin:.2em 0 .6em;text-align:justify}
.hw-q-body img{max-width:100%}
.hw-q-opts{margin:.4em 0;padding-left:1.6em;list-style:none}
.hw-q-opts li{margin:.2em 0}
.hw-q-opts li b{color:var(--accent);margin-right:.3em}
.hw-q-ans{margin:.7em 0 0;padding-top:.5em;border-top:1px dashed var(--rule);font-size:.94em;color:var(--fg2)}
.hw-q-ans-label{color:var(--fg2)}
.hw-q-ans-list{margin:.3em 0 0;padding:0 0 0 1.9em;list-style:none}
.hw-q-ans-list li{display:flex;gap:.45em;margin:.22em 0;line-height:1.6}
.hw-key{flex:none;color:var(--ok);font-weight:700}
.hw-key:empty{display:none}
.hw-val{text-align:justify;color:var(--fg)}
.hw-q-none{color:var(--fg2)}
#hw-toc{position:fixed;left:0;top:0;width:268px;height:100vh;overflow-y:auto;padding:14px 8px 40px;background:var(--panel);
  border-right:1px solid var(--rule);font-size:12.5px;line-height:1.5;z-index:5}
.hw-toc-title{font-weight:600;color:var(--fg2);padding:0 8px 8px;display:flex;justify-content:space-between}
.hw-toc-title i{font-style:normal;font-weight:400}
#hw-toc summary{display:flex;align-items:center;gap:4px;cursor:pointer;list-style:none;padding:3px 4px;border-radius:5px}
#hw-toc summary::-webkit-details-marker{display:none}
#hw-toc summary::before{content:"▸";flex:none;width:11px;color:var(--fg2);font-size:10px;transition:transform .15s}
#hw-toc details[open]>summary::before{transform:rotate(90deg)}
#hw-toc summary>a{flex:1;font-weight:600;color:var(--fg);padding:2px 0}
#hw-toc summary>i{color:var(--fg2);font-style:normal;font-size:11px;margin-right:4px}
#hw-toc ul{margin:2px 0 6px;padding-left:16px;list-style:none;border-left:1px solid var(--rule)}
#hw-toc li{margin:0}
#hw-toc a{display:block;color:var(--fg2);text-decoration:none;padding:3px 7px;border-radius:5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hw-toc li a b{color:var(--accent);font-weight:600;margin-right:3px}
#hw-toc a:hover{background:var(--soft);color:var(--accent)}
#hw-toc a.on{background:var(--accent-soft);color:var(--accent);font-weight:600}
#hw-theme-btn{position:fixed;right:14px;top:14px;z-index:6;height:28px;padding:0 12px;border:1px solid var(--rule);
  border-radius:14px;background:var(--panel);color:var(--fg2);font:12px/1 var(--sans);cursor:pointer}
#hw-theme-btn:hover{color:var(--accent);border-color:var(--accent)}
#hw-toc-btn{display:none;position:fixed;left:12px;top:12px;z-index:6;height:28px;padding:0 12px;border:1px solid var(--rule);
  border-radius:14px;background:var(--panel);color:var(--fg2);font:12px/1 var(--sans);cursor:pointer}
h2,.hw-q{scroll-margin-top:16px}
@media (max-width:980px){
  body{padding-left:0}
  #hw-toc{transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 30px rgba(0,0,0,.25)}
  body.toc-open #hw-toc{transform:none}
  #hw-toc-btn{display:block}
}
@media print{body{background:#fff;padding-left:0}#hw-toc,#hw-theme-btn,#hw-toc-btn{display:none}
  .hw-doc{max-width:none;margin:0;padding:0;box-shadow:none}.hw-q{page-break-inside:avoid;border-color:#ccc}}`;

  const JS = `
(function(){
  var KEY='ykt-hw-theme', root=document.documentElement, btn=document.getElementById('hw-theme-btn');
  var L={auto:'◐ 自动',light:'● 浅色',dark:'● 深色'};
  var get=function(){ return root.dataset.theme in L ? root.dataset.theme : 'auto' };
  btn.textContent=L[get()];
  btn.onclick=function(){ var o=['auto','light','dark']; var v=o[(o.indexOf(get())+1)%3];
    root.dataset.theme=v; btn.textContent=L[v]; try{localStorage.setItem(KEY,v)}catch(e){} };

  var toc=document.getElementById('hw-toc');
  document.getElementById('hw-toc-btn').onclick=function(){ document.body.classList.toggle('toc-open') };

  // 滚动高亮：命中当前视口顶部之上最近的一道题，并展开它所在的作业
  var links={}, items=[];
  Array.prototype.forEach.call(toc.querySelectorAll('a[href^="#"]'), function(a){
    links[a.getAttribute('href').slice(1)]=a;
  });
  Array.prototype.forEach.call(document.querySelectorAll('.hw-doc h2[id], .hw-doc .hw-q[id]'), function(el){
    if(links[el.id]) items.push(el);
  });
  var cur=null, autoOpened=null;
  function spy(){
    var pick=null;
    for(var i=0;i<items.length;i++){ if(items[i].getBoundingClientRect().top<=140) pick=items[i]; else break }
    if(pick===cur) return;
    if(cur) links[cur.id].classList.remove('on');
    cur=pick;
    if(!cur){ if(autoOpened){ autoOpened.open=false; autoOpened=null; } return; }
    var a=links[cur.id];
    a.classList.add('on');
    // 只展开当前题所在的一组，并收回上一组由本脚本展开的；用户手动点开的不去关它
    var d=a.closest('details');
    if(d && !d.open){
      if(autoOpened && autoOpened!==d) autoOpened.open=false;
      d.open=true; autoOpened=d;
    } else if(!d && autoOpened){
      autoOpened.open=false; autoOpened=null;
    }
    var box=toc.getBoundingClientRect(), r=a.getBoundingClientRect();
    if(r.top<box.top+8 || r.bottom>box.bottom-8) a.scrollIntoView({block:'nearest'});
  }
  addEventListener('scroll',spy,{passive:true}); addEventListener('resize',spy); spy();
})();`;

  const total = sheets.reduce((n, s) => n + s.problems.length, 0);
  const body = sheets
    .map((s) => `<h2 id="hw-${s.leafId}">${esc(s.name)}</h2>` + s.problems.map((p) => qHtml(s, p)).join(''))
    .join('\n');

  const tocHtml = sheets
    .map(
      (s) => `
  <details>
    <summary><a href="#hw-${s.leafId}">${esc(s.name)}</a><i>${s.problems.length}</i></summary>
    <ul>${s.problems
      .map((p) => `<li><a href="#${qAnchor(s, p)}"><b>${esc(p.index)}.</b> ${esc(shortTitle(p))}</a></li>`)
      .join('')}</ul>
  </details>`
    )
    .join('');

  const html = `<!doctype html>
<html lang="zh-CN" data-theme="auto"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(tree.course_name)} · 习题</title>
<style>${CSS}</style>
<script>try{document.documentElement.dataset.theme=localStorage.getItem('ykt-hw-theme')||'auto'}catch(e){}</script>
</head><body>
<button id="hw-theme-btn" title="切换主题"></button>
<button id="hw-toc-btn">☰ 目录</button>
<nav id="hw-toc">
  <div class="hw-toc-title">目录 <i>共 ${total} 题</i></div>
  ${tocHtml}
</nav>
<main class="hw-doc">
  <h1>习题</h1>
  <blockquote>${esc(tree.course_name)} · ${sheets.length} 份作业 · 共 ${total} 题 · ${new Date().toLocaleString()}</blockquote>
  ${body}
</main>
<script>${JS}</script>
</body></html>`;

  const stem = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');
  const filename = `${stem(tree.course_name)}-习题${CFG.chapter == null ? '' : '第' + CFG.chapter + '章'}.html`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  if (CFG.open) window.open(a.href, '_blank');

  window.__YKT_HW = { filename, html, sheets };
  console.log(`完成：${filename}（${sheets.length} 份作业 / ${total} 题）`);
})().catch((e) => console.error('[作业提取失败]', e && e.message ? e.message : e));
