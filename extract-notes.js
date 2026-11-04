/*
 * 雨课堂课程笔记提取 —— 整段粘贴到浏览器控制台运行
 *
 * 步骤：
 *   1. 登录雨课堂，打开任意一节课程视频页，形如
 *      https://www.yuketang.cn/ai-workspace/lms-graph/<classroom_id>/video/<leaf_id>?is_chapter=1
 *   2. F12 -> Console，把本文件内容整段粘贴进去，回车。
 *   3. 浏览器会下载一个 .md 文件，全文同时挂在 window.__YKT_NOTES 上。
 *
 * 改提取范围：粘贴前先执行
 *   window.YKT_NOTES_CONFIG = { from: '*', to: '*' }   // 整门课
 * 或直接改下面 OPT 里的 from / to。
 */
(async function () {
  const OPT = Object.assign(
    {
      from: '1.1.1', // 起始小节编号；'*' 表示不限制
      to: '1.1.2', // 结束小节编号（含）
      transcript: true, // 是否附带讲稿附录
      knowledgeTime: true, // 知识导引是否标注视频时间段
      concurrency: 4,
      download: true,
    },
    window.YKT_NOTES_CONFIG || {}
  );

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
  if (!cid) throw new Error('识别不到 classroom_id，请在课程视频页运行本脚本');

  // 雨课堂的 c27 / mooc-api 接口要求带 xtbz 头，值就存在 cookie 里
  const headers = { xtbz: readCookie('xtbz') || 'ykt' };
  const getJSON = async (url) => {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
    const body = await res.json();
    if (body && body.success === false) throw new Error(url + ' → ' + (body.msg || '请求失败'));
    return body;
  };

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    const h = Math.floor(s / 3600);
    const rest = s % 3600;
    return h ? `${h}:${pad(Math.floor(rest / 60))}:${pad(rest % 60)}` : `${pad(Math.floor(rest / 60))}:${pad(rest % 60)}`;
  };

  // 目录树里「节」有两种形态：下面挂多个视频，或节本身就是一个视频
  const tree = (await getJSON(`/mooc-api/v1/lms/learn/course/chapter?cid=${cid}&classroom_id=${cid}`)).data;
  const leaves = [];
  for (const ch of tree.course_chapter || []) {
    for (const sec of ch.section_leaf_list || []) {
      const isGroup = !!(sec.leaf_list && sec.leaf_list.length);
      for (const l of isGroup ? sec.leaf_list : [sec]) {
        if (l.leaf_type !== 0 || !l.id) continue; // 只要视频，跳过作业/考试
        // depth 跟页面目录缩进一致：挂在水平台节下的是 4，节本身就是视频的是 3
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

  const numOf = (name) => {
    const m = /^(\d+(?:\.\d+)*)/.exec(String(name).trim());
    return m ? m[1] : null;
  };
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };

  const unlimited = OPT.from === '*' || OPT.to === '*';
  const picked = unlimited
    ? leaves
    : leaves.filter((l) => {
        const n = numOf(l.name);
        return n && cmp(n, OPT.from) >= 0 && cmp(n, OPT.to) <= 0;
      });
  if (!picked.length) throw new Error(`区间 ${OPT.from} ~ ${OPT.to} 没有匹配到视频小节`);
  console.log(`共 ${leaves.length} 个视频小节，本次提取 ${picked.length} 个`);

  const pool = async (items, size, worker) => {
    const out = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(size, items.length) }, async () => {
        while (cursor < items.length) out[cursor] = await worker(items[cursor], cursor++);
      })
    );
    return out;
  };

  const rows = await pool(picked, OPT.concurrency, async (l) => {
    const knowledge = await getJSON(`/c27/online_courseware/leaf_knowledge/${l.id}/?classroom_id=${cid}`)
      .then((r) => r.data || [])
      .catch(() => []);
    const note = OPT.transcript
      ? await getJSON(`/c27/online_courseware/leaf_lecture_note/${l.id}/?classroom_id=${cid}`)
          .then((r) => r.data || [])
          .catch(() => [])
      : [];
    console.log(`  ✓ ${l.name} —— 知识导引 ${knowledge.length} 条，讲稿 ${note.length} 段`);
    return { ...l, knowledge, note };
  });

  // 正文和附录是同一棵目录树的两种展开，用 <a id> 锚点互相跳转
  const body = [`# ${tree.course_name}`, '', `> 雨课堂 · 提取 ${picked.length} 个小节 · ${new Date().toLocaleString()}`, ''];
  const appendix = [];
  const st = { chapter: null, section: null };
  const stA = { chapter: null, section: null };

  const treePath = (arr, r, s) => {
    if (r.chapter !== s.chapter) {
      arr.push(`## ${r.chapter}`, '');
      s.chapter = r.chapter;
      s.section = null;
    }
    if (r.section && r.section !== s.section) {
      arr.push(`### ${r.section}`, '');
      s.section = r.section;
    }
    arr.push(`${'#'.repeat(r.depth)} ${r.name}`, '');
  };

  for (const r of rows) {
    if (!r.knowledge.length && !r.note.length) continue;

    // 讲稿段落按起始时间归到知识导引区间；空隙算给前一条，早于首条的单独列
    const groups = r.knowledge.map(() => []);
    const orphans = [];
    for (const p of r.note) {
      let idx = -1;
      for (let i = 0; i < r.knowledge.length; i++) if (Number(p.startTime) >= Number(r.knowledge[i].startTime)) idx = i;
      (idx < 0 ? orphans : groups[idx]).push(p);
    }

    treePath(body, r, st);
    r.knowledge.forEach((k, i) => {
      const linked = OPT.transcript && groups[i].length;
      body.push(`<a id="k-${r.id}-${i}"></a>`, '');
      body.push(`${'#'.repeat(r.depth + 1)} ${linked ? `[${k.headline}](#a-${r.id}-${i})` : k.headline}`, '');
      if (OPT.knowledgeTime) body.push(`> ${fmt(k.startTime)} – ${fmt(k.endTime)}`, '');
      body.push(String(k.summary || '').trim(), '');
    });

    if (!OPT.transcript || !r.note.length) continue;
    if (!appendix.length) appendix.push('# 附录', '');
    treePath(appendix, r, stA);

    for (const p of orphans)
      appendix.push(`${'#'.repeat(r.depth + 1)} ${fmt(p.startTime)}`, '', String(p.formalParagraphText || '').trim(), '');

    r.knowledge.forEach((k, i) => {
      if (!groups[i].length) return;
      appendix.push(`<a id="a-${r.id}-${i}"></a>`, '');
      appendix.push(`${'#'.repeat(r.depth + 1)} [${k.headline}](#k-${r.id}-${i})`, '');
      for (const p of groups[i])
        appendix.push(`${'#'.repeat(r.depth + 2)} ${fmt(p.startTime)}`, '', String(p.formalParagraphText || '').trim(), '');
    });
  }

  const markdown = body.concat(appendix.length ? ['', ...appendix] : []).join('\n');
  const safe = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_');
  const filename = `${safe(tree.course_name)}_${unlimited ? '全课程' : safe(OPT.from) + '-' + safe(OPT.to)}.md`;

  window.__YKT_NOTES = { filename, markdown, rows };
  if (OPT.download) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  console.log(`完成：${filename}（${markdown.length} 字符），全文见 window.__YKT_NOTES.markdown`);
  return markdown;
})();
