/* 存储层单元测试（不依赖浏览器）
 *
 *   node tests/store.mjs
 *
 * lib/store.js 通过可替换的 adapter 访问存储，
 * 所以这里用一个内存假实现就能覆盖迁移、去重、淘汰、导入导出。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PBStore = require('../lib/store.js');

function fakeAdapter(initial) {
  const data = Object.assign({}, initial);
  const state = { bytes: 0 };

  return {
    data,
    state,
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      if (Array.isArray(keys)) {
        const o = {};
        for (const k of keys) if (k in data) o[k] = data[k];
        return o;
      }
      return {};
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    async bytes() {
      if (state.bytes) return state.bytes;
      let n = 0;
      for (const k of Object.keys(data)) n += k.length * 2 + JSON.stringify(data[k] || '').length * 2;
      return n;
    }
  };
}

const results = [];
function check(name, ok, note) {
  results.push({ name, ok: !!ok, note: note || '' });
}

/* ---------------- 1. 从 v1 迁移 ---------------- */

{
  const a = fakeAdapter({
    history: [
      { id: 'h1', code: 'const a = 1;\nconst b = 2;', ts: 1000 },
      { id: 'h2', code: 'hello', ts: 900 }
    ],
    'choice:https://example.com': { kind: 'cm6', nth: 2 },
    draft: { code: 'draft text', ts: 500 }
  });
  PBStore.use(a);

  const settings = await PBStore.ready();
  check('迁移：写入 schemaVersion', settings.schemaVersion === 2, 'v=' + settings.schemaVersion);

  const inserts = await PBStore.listInserts();
  check('迁移：history → inserts', inserts.length === 2, '条数=' + inserts.length);
  check('迁移：保留预览', inserts[0].preview === 'const a = 1;', JSON.stringify(inserts[0].preview));

  const site = await PBStore.getSite('https://example.com');
  check('迁移：choice → sites', site && site.kind === 'cm6' && site.nth === 2, JSON.stringify(site));

  check('迁移：草稿原样保留', a.data.draft.code === 'draft text');
  check('迁移：旧键保留一版', Array.isArray(a.data.history));
}

/* ---------------- 2. 去重与置顶 ---------------- */

{
  const a = fakeAdapter({});
  PBStore.use(a);
  await PBStore.ready();

  const first = await PBStore.putClip({ text: 'duplicate me', src: { host: 'a.com' } });
  const second = await PBStore.putClip({ text: 'duplicate me', src: { host: 'b.com' } });

  check('去重：同一内容复用同一条', first.id === second.id, first.id + ' / ' + second.id);

  const idx = await PBStore.getClipIndex();
  check('去重：索引只有一条', idx.length === 1, '条数=' + idx.length);
  check('去重：命中次数累加', idx[0].hits === 2, 'hits=' + idx[0].hits);

  await PBStore.putClip({ text: 'pinned item', pin: true });
  await PBStore.pinClip(first.id, true);
  const after = await PBStore.getClipIndex();
  check('置顶：标记生效', after.filter((x) => x.pin).length === 2, JSON.stringify(after.map((x) => x.pin)));
}

/* ---------------- 3. 容量淘汰 ---------------- */

{
  const a = fakeAdapter({ settings: { schemaVersion: 2, historyLimit: 5 } });
  PBStore.use(a);
  await PBStore.ready();

  await PBStore.putClip({ text: 'keep me', pin: true });
  for (let i = 0; i < 12; i++) {
    await PBStore.putClip({ text: 'item ' + i });
  }

  const idx = await PBStore.getClipIndex();
  const pinned = idx.filter((x) => x.pin).length;
  const normal = idx.filter((x) => !x.pin).length;

  check('淘汰：普通项被裁到上限', normal <= 5, '普通=' + normal);
  check('淘汰：置顶项不受影响', pinned === 1, '置顶=' + pinned);
  check('淘汰：最新一条在最前', idx.find((x) => !x.pin).preview.indexOf('item 11') === 0, idx[0].preview);
}

/* ---------------- 4. 体积水位 ---------------- */

{
  const a = fakeAdapter({ settings: { schemaVersion: 2, historyLimit: 50 } });
  PBStore.use(a);
  await PBStore.ready();

  for (let i = 0; i < 6; i++) await PBStore.putClip({ text: 'big ' + i });

  // 把体积推到水位线以上，下一次写入应当触发淘汰
  a.state.bytes = 9 * 1024 * 1024;
  const before = (await PBStore.getClipIndex()).length;
  await PBStore.putClip({ text: 'trigger gc' });
  const after = await PBStore.getClipIndex();

  check('体积：超过 8MB 触发淘汰', after.length < before + 1, before + ' → ' + after.length);
}

/* ---------------- 5. 超大单条 ---------------- */

{
  const a = fakeAdapter({});
  PBStore.use(a);
  await PBStore.ready();

  // 默认 capture.maxLen = 200000，先按这个上限截断
  const huge = 'x'.repeat(300 * 1024);
  const meta = await PBStore.putClip({ text: huge });
  const stored = await PBStore.getClipText(meta.id);

  check('超大：按 maxLen 截断', meta.len === 200000, 'len=' + meta.len);
  check('超大：正文与元数据一致', stored.length === meta.len, 'stored=' + stored.length);

  // 放宽 maxLen 后，256KB 的硬上限开始生效
  await PBStore.saveSettings({ capture: { maxLen: 500000 } });
  const meta2 = await PBStore.putClip({ text: 'y'.repeat(300 * 1024) });
  const stored2 = await PBStore.getClipText(meta2.id);

  check('超大：硬上限 256KB 生效', stored2.length === 256 * 1024, 'stored=' + stored2.length);
  check('超大：元数据记录原始长度', meta2.len === 300 * 1024, 'len=' + meta2.len);
}

/* ---------------- 6. 片段库 ---------------- */

{
  const a = fakeAdapter({});
  PBStore.use(a);
  await PBStore.ready();

  const s = await PBStore.putSnippet({ name: '常用头', text: '#include <stdio.h>', lang: 'c', tags: ['c'] });
  check('片段：创建成功', !!s && s.name === '常用头', JSON.stringify(s && s.name));

  const text = await PBStore.getSnippetText(s.id);
  check('片段：正文可读', text === '#include <stdio.h>', text);

  await PBStore.useSnippet(s.id);
  await PBStore.useSnippet(s.id);
  const idx = await PBStore.getSnipIndex();
  check('片段：使用次数累加', idx[0].used === 2, 'used=' + idx[0].used);

  await PBStore.putSnippet({ id: s.id, name: '改名了', text: 'new body' });
  const idx2 = await PBStore.getSnipIndex();
  check('片段：同 id 更新不重复', idx2.length === 1 && idx2[0].name === '改名了', JSON.stringify(idx2.map((x) => x.name)));

  await PBStore.removeSnippet(s.id);
  const idx3 = await PBStore.getSnipIndex();
  check('片段：删除生效', idx3.length === 0, '剩余=' + idx3.length);
}

/* ---------------- 7. 导出 / 导入 ---------------- */

{
  const a = fakeAdapter({});
  PBStore.use(a);
  await PBStore.ready();
  await PBStore.putClip({ text: 'exported clip' });
  await PBStore.putSnippet({ name: 'snip', text: 'snip body' });

  const dump = await PBStore.exportAll();
  check('导出：包含内容', dump.clips.length === 1 && dump.snips.length === 1, JSON.stringify({ c: dump.clips.length, s: dump.snips.length }));

  const b = fakeAdapter({});
  PBStore.use(b);
  const r = await PBStore.importAll(dump);
  const clips = await PBStore.getClipIndex();
  const text = await PBStore.getClipText(clips[0].id);

  check('导入：条数一致', r.clips === 1 && r.snips === 1, JSON.stringify(r));
  check('导入：正文可读', text === 'exported clip', text);
}

/* ---------------- 8. 清空 ---------------- */

{
  const a = fakeAdapter({});
  PBStore.use(a);
  await PBStore.ready();
  await PBStore.putClip({ text: 'a', pin: true });
  await PBStore.putClip({ text: 'b' });
  await PBStore.putClip({ text: 'c' });

  const kept = await PBStore.clearClips(true);
  check('清空：保留置顶', kept.length === 1 && kept[0].pin === true, '保留=' + kept.length);

  const kept2 = await PBStore.clearClips(false);
  check('清空：全清', kept2.length === 0, '剩余=' + kept2.length);
}

/* ---------------- 9. 类型猜测 ---------------- */

{
  check('类型：链接', PBStore.guessKind('https://example.com/a') === 'link');
  check('类型：代码', PBStore.guessKind('function a() {}') === 'code');
  check('类型：纯文本', PBStore.guessKind('今天天气不错') === 'text');
}

/* ---------------- 报告 ---------------- */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.note}`);
}
console.log('─'.repeat(70));
console.log(`${results.length - failed.length}/${results.length} 通过` + (failed.length ? '' : ' ✓'));
process.exit(failed.length ? 1 : 0);
