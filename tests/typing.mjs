/* 键入计划器单元测试（不依赖浏览器）
 *
 *   node tests/typing.mjs
 *
 * 这里断言的是「命令序列」而不是真实键入效果——
 * 因为 Playwright 自己占着 CDP，扩展的 chrome.debugger 在自动化环境里常常附不上。
 * 而真正容易错的地方（裸 Enter、Tab 移焦点、emoji 被切碎）恰恰都在命令序列里。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../lib/typing.js');

const results = [];
const check = (name, ok, note) => results.push({ name, ok: !!ok, note: note || '' });

const stepsOf = (list, method) => list.filter((s) => s.method === method);
/* 一次换行 = rawKeyDown + keyUp 两条，这里只数真正触发的那个 */
const entersOf = (list) =>
  list.filter((s) => s.params && s.params.key === 'Enter' && s.params.type !== 'keyUp');

/* ---------------- 整段写入 ---------------- */

{
  const p = T.planInsert('const a = 1;');
  check(
    '整段：单条 insertText',
    p.length === 1 && p[0].method === 'Input.insertText' && p[0].params.text === 'const a = 1;',
    'steps=' + p.length
  );
}

{
  const p = T.planInsert('a\nb\nc');
  check(
    '多行无空行：仍走整段',
    p.length === 1 && p[0].params.text === 'a\nb\nc',
    'steps=' + p.length
  );
}

{
  const p = T.planInsert('a\n\nb');
  const es = entersOf(p);
  check('空行：拆成逐行写入', stepsOf(p, 'Input.insertText').length === 2, 'inserts=' + stepsOf(p, 'Input.insertText').length);
  check(
    '空行：行间用 Shift+Enter',
    es.length === 2 && es.every((s) => s.params.modifiers === 8),
    'enters=' + es.length
  );
}

{
  const p = T.planInsert('a\n\n\nb');
  const es = entersOf(p);
  check('连续空行：不丢行', es.length === 3 && stepsOf(p, 'Input.insertText').length === 2, 'enters=' + es.length);
}

/* ---------------- 逐字模拟 ---------------- */

{
  const k = T.planKeys('ab');
  check('逐字：两字符四条命令', k.steps.length === 4, 'steps=' + k.steps.length);
  check(
    '逐字：keyDown 带 text 与 code',
    k.steps[0].params.type === 'keyDown' &&
      k.steps[0].params.text === 'a' &&
      k.steps[0].params.code === 'KeyA' &&
      k.steps[0].params.windowsVirtualKeyCode === 65,
    JSON.stringify(k.steps[0].params)
  );
  check('逐字：keyUp 不带 text', k.steps[1].params.type === 'keyUp' && k.steps[1].params.text === undefined);
}

{
  const k = T.planKeys('A');
  check(
    '大写：带 Shift 修饰',
    k.steps[0].params.modifiers === 8 && k.steps[0].params.text === 'A',
    'modifiers=' + k.steps[0].params.modifiers
  );
}

{
  const k = T.planKeys('中文');
  check(
    '中文：不发按键，走 insertText',
    k.steps.length === 1 && k.steps[0].method === 'Input.insertText' && k.steps[0].params.text === '中文',
    'steps=' + k.steps.length
  );
}

{
  const k = T.planKeys('中\na');
  check(
    '混排：中文合并 + 换行 + 按键',
    k.steps[0].method === 'Input.insertText' &&
      k.steps[0].params.text === '中' &&
      k.steps[1].params.key === 'Enter' &&
      k.steps[3].params.text === 'a',
    'steps=' + k.steps.length
  );
}

{
  const k = T.planKeys('a\nb');
  const es = entersOf(k.steps);
  check('换行：全部 Shift+Enter', es.length === 1 && es.every((s) => s.params.modifiers === 8), 'enters=' + es.length);
  check(
    '换行：绝无裸 Enter',
    !k.steps.some((s) => s.params && s.params.key === 'Enter' && !s.params.modifiers),
    '裸 Enter 数=0'
  );
}

{
  const k = T.planKeys('a\tb', { tabAsSpaces: 2 });
  check(
    'Tab：绝不发 VK 9',
    !k.steps.some((s) => s.params && s.params.windowsVirtualKeyCode === 9),
    'VK9 数=0'
  );
  check('Tab：替换为两个空格', k.steps.some((s) => s.params.text === '  '));
}

{
  const family = '👨‍👩‍👧‍👦';
  const k = T.planKeys(family);
  check(
    'emoji：按 grapheme 整体写入',
    k.steps.length === 1 && k.steps[0].params.text === family,
    'steps=' + k.steps.length + ' text=' + JSON.stringify(k.steps[0].params.text)
  );
}

{
  const k = T.planKeys('x'.repeat(50), { maxChars: 10 });
  check('上限：截断并标记', k.meta.chars === 10 && k.meta.truncated === true, JSON.stringify(k.meta));
}

{
  const k = T.planKeys('()=>{}');
  check(
    '符号：映射为真实键码',
    stepsOf(k.steps, 'Input.dispatchKeyEvent').length === 12,
    'keyEvents=' + stepsOf(k.steps, 'Input.dispatchKeyEvent').length
  );
}

/* ---------------- 对外入口 ---------------- */

{
  const auto = T.planTyping('abc', { mode: 'auto' });
  check('auto：整段优先且带 fallback', auto.mode === 'insert' && !!auto.fallback && auto.fallback.length > 0);

  const ins = T.planTyping('abc', { mode: 'insert' });
  check('insert：不带 fallback', ins.fallback === null);

  const keys = T.planTyping('abc', { mode: 'keys' });
  check(
    'keys：只产出按键事件',
    keys.mode === 'keys' && keys.steps.every((s) => s.method === 'Input.dispatchKeyEvent')
  );

  const meta = T.planTyping('a\nb\nc', {}).meta;
  check('meta：行数与字符数', meta.lines === 3 && meta.chars === 5, JSON.stringify(meta));
}

{
  const empty = T.planTyping('', {});
  check('空文本：不产生命令', empty.steps.length === 0);
}

/* ---------------- 报告 ---------------- */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.note}`);
}
console.log('─'.repeat(70));
console.log(`${results.length - failed.length}/${results.length} 通过` + (failed.length ? '' : ' ✓'));
process.exit(failed.length ? 1 : 0);
