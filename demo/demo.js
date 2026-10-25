/* 演示页：挂载五种编辑器 + 拦截 paste，并把实例暴露给自动化测试
 *
 * 所有依赖都走「多 CDN 降级」加载：jsdelivr / cdnjs 在部分网络下会被重置，
 * 所以按 unpkg → BootCDN → npmmirror 的顺序依次尝试。
 */

const $ = (id) => document.getElementById(id);

const KINDS = ['cm5', 'cm6', 'monaco', 'ace', 'textarea', 'ce'];

const CDN = {
  cm5css: [
    'https://unpkg.com/codemirror@5.65.16/lib/codemirror.css',
    'https://cdn.bootcdn.net/ajax/libs/codemirror/5.65.16/codemirror.min.css',
    'https://registry.npmmirror.com/codemirror/5.65.16/files/lib/codemirror.css'
  ],
  cm5js: [
    'https://unpkg.com/codemirror@5.65.16/lib/codemirror.js',
    'https://cdn.bootcdn.net/ajax/libs/codemirror/5.65.16/codemirror.min.js',
    'https://registry.npmmirror.com/codemirror/5.65.16/files/lib/codemirror.js'
  ],
  cm5mode: [
    'https://unpkg.com/codemirror@5.65.16/mode/javascript/javascript.js',
    'https://cdn.bootcdn.net/ajax/libs/codemirror/5.65.16/mode/javascript.min.js',
    'https://registry.npmmirror.com/codemirror/5.65.16/files/mode/javascript/javascript.js'
  ],
  ace: [
    'https://unpkg.com/ace-builds@1.36.5/src-min-noconflict/ace.js',
    'https://registry.npmmirror.com/ace-builds/1.36.5/files/src-min-noconflict/ace.js',
    'https://cdn.bootcdn.net/ajax/libs/ace/1.36.5/ace.min.js'
  ],
  monacoLoader: [
    'https://unpkg.com/monaco-editor@0.52.2/min/vs/loader.js',
    'https://registry.npmmirror.com/monaco-editor/0.52.2/files/min/vs/loader.js'
  ],
  cm6: ['https://esm.sh/codemirror@6.0.1', 'https://registry.npmmirror.com/codemirror/6.0.1/files/dist/index.js']
};

const state = { cm5: null, cm6: null, monaco: null, ace: null, status: {}, settled: 0 };

const demo = (window.__demo = {
  ready: false,
  status: state.status,
  cdn: {},
  getValue,
  setValue,
  hideMonacoApi,
  reset
});

/* ---------------- 加载器 ---------------- */

function loadScript(urls, label) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= urls.length) {
        reject(new Error((label || 'script') + ' 全部 CDN 不可用'));
        return;
      }
      const url = urls[i++];
      const s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = () => resolve(url);
      s.onerror = () => {
        s.remove();
        next();
      };
      document.head.appendChild(s);
    };
    next();
  });
}

function loadCss(urls, label) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= urls.length) {
        reject(new Error((label || 'css') + ' 全部 CDN 不可用'));
        return;
      }
      const url = urls[i++];
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = url;
      l.onload = () => resolve(url);
      l.onerror = () => {
        l.remove();
        next();
      };
      document.head.appendChild(l);
    };
    next();
  });
}

/* ---------------- 状态 ---------------- */

function mark(kind, ok, err) {
  if (state.status[kind]) return;
  state.status[kind] = ok ? 'ok' : 'fail: ' + ((err && err.message) || err || '未知');
  state.settled++;
  renderStatus();
  if (state.settled >= KINDS.length) demo.ready = true;
}

function renderStatus() {
  const failed = KINDS.filter((k) => state.status[k] && state.status[k] !== 'ok');
  const el = $('status');
  if (!el) return;
  if (!failed.length && state.settled >= KINDS.length) {
    el.className = 'badge ok';
    el.textContent = '全部就绪 ' + KINDS.length + '/' + KINDS.length;
  } else {
    el.className = 'badge warn';
    el.textContent =
      '就绪 ' +
      (KINDS.length - failed.length) +
      '/' +
      KINDS.length +
      (failed.length ? '（' + failed.join(',') + ' 未加载）' : '');
  }
}

/* ---------------- 读取 / 写入 ---------------- */

function getValue(kind) {
  switch (kind) {
    case 'cm5':
      return state.cm5 ? state.cm5.getValue() : null;
    case 'cm6':
      return state.cm6 ? state.cm6.state.doc.toString() : null;
    case 'monaco':
      return state.monaco ? state.monaco.getValue() : null;
    case 'ace':
      return state.ace ? state.ace.getValue() : null;
    case 'textarea':
      return $('ta').value;
    case 'ce':
      return $('ce').innerText;
    default:
      return null;
  }
}

function setValue(kind, v) {
  switch (kind) {
    case 'cm5':
      if (state.cm5) state.cm5.setValue(v);
      return true;
    case 'cm6':
      if (state.cm6) {
        state.cm6.dispatch({ changes: { from: 0, to: state.cm6.state.doc.length, insert: v } });
      }
      return true;
    case 'monaco':
      if (state.monaco) state.monaco.setValue(v);
      return true;
    case 'ace':
      if (state.ace) state.ace.setValue(v, -1);
      return true;
    case 'textarea':
      $('ta').value = v;
      return true;
    case 'ce':
      $('ce').textContent = v;
      return true;
    default:
      return false;
  }
}

function reset() {
  KINDS.forEach((k) => setValue(k, ''));
}

/* ---------------- Monaco 全局 API 开关 ---------------- */

let realGetEditors = null;
let monacoApiHidden = false;

function hideMonacoApi(on) {
  if (!window.monaco || !window.monaco.editor) return false;
  if (on) {
    if (!realGetEditors) realGetEditors = window.monaco.editor.getEditors;
    window.monaco.editor.getEditors = () => [];
  } else if (realGetEditors) {
    window.monaco.editor.getEditors = realGetEditors;
  }
  monacoApiHidden = !!on;
  const el = $('hideMonacoState');
  if (el) el.textContent = on ? '已隐藏（扩展会走 execCommand 通道）' : '';
  return true;
}

/* ---------------- 各编辑器初始化 ---------------- */

async function bootCM5() {
  try {
    await loadCss(CDN.cm5css, 'CodeMirror5 css');
    const url = await loadScript(CDN.cm5js, 'CodeMirror5');
    demo.cdn.cm5 = url;
    try {
      await loadScript(CDN.cm5mode, 'CodeMirror5 mode');
    } catch (_) {
      /* 没有语法高亮也能测插入 */
    }
    if (typeof window.CodeMirror === 'undefined') throw new Error('CodeMirror 未挂载');
    state.cm5 = window.CodeMirror($('host-cm5'), {
      value: '// CodeMirror 5\nfunction hello() {\n  return "hi";\n}\n',
      mode: 'javascript',
      lineNumbers: true,
      tabSize: 2,
      indentUnit: 2
    });
    mark('cm5', true);
  } catch (e) {
    mark('cm5', false, e);
  }
}

async function bootAce() {
  try {
    const url = await loadScript(CDN.ace, 'Ace');
    demo.cdn.ace = url;
    if (!window.ace) throw new Error('ace 未挂载');
    state.ace = window.ace.edit($('host-ace'));
    state.ace.setTheme('ace/theme/chrome');
    state.ace.session.setMode('ace/mode/javascript');
    state.ace.setValue('// Ace\nfunction hello() {\n\treturn "hi";\n}\n', -1);
    state.ace.setOptions({
      fontSize: '12px',
      showPrintMargin: false,
      tabSize: 2,
      useSoftTabs: false
    });
    mark('ace', true);
  } catch (e) {
    mark('ace', false, e);
  }
}

async function bootMonaco() {
  try {
    const url = await loadScript(CDN.monacoLoader, 'Monaco loader');
    demo.cdn.monaco = url;
    const base = url.replace(/\/loader\.js.*$/, '');
    // base 指向 .../min/vs，而 worker 里是按 vs/ 开头解析的，所以 baseUrl 要回退一层
    const workerBase = base.replace(/\/vs$/, '') + '/';

    // 跨域 CDN 下必须显式给出 worker 地址，否则 Monaco 的语言服务会报错
    self.MonacoEnvironment = {
      getWorkerUrl: function () {
        const code =
          'self.MonacoEnvironment={baseUrl:' +
          JSON.stringify(workerBase) +
          '};importScripts(' +
          JSON.stringify(workerBase + 'vs/base/worker/workerMain.js') +
          ');';
        return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code);
      }
    };

    await new Promise((resolve, reject) => {
      window.require.config({ paths: { vs: base } });
      window.require(['vs/editor/editor.main'], resolve, reject);
    });

    state.monaco = window.monaco.editor.create($('host-monaco'), {
      value: '// Monaco\nfunction hello() {\n\treturn "hi";\n}\n',
      language: 'javascript',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 12,
      scrollBeyondLastLine: false
    });
    mark('monaco', true);
  } catch (e) {
    mark('monaco', false, e);
  }
}

async function bootCM6() {
  let mod = null;
  let lastErr = null;
  for (const src of CDN.cm6) {
    try {
      mod = await import(/* @vite-ignore */ src);
      demo.cdn.cm6 = src;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  try {
    if (!mod || !mod.EditorView) throw lastErr || new Error('CodeMirror 6 未加载');
    state.cm6 = new mod.EditorView({
      doc: '// CodeMirror 6\nfunction hello() {\n\treturn "hi";\n}\n',
      extensions: [mod.basicSetup],
      parent: $('host-cm6')
    });
    mark('cm6', true);
  } catch (e) {
    mark('cm6', false, e);
  }
}

/* ---------------- 禁止粘贴模拟 ---------------- */

let blocked = 0;

function initPasteBlocker() {
  document.querySelectorAll('[data-kind] .host').forEach((host) => {
    ['paste', 'drop'].forEach((type) => {
      host.addEventListener(
        type,
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          blocked++;
          const el = $('blocked');
          if (el) el.textContent = '已拦截粘贴：' + blocked + ' 次';
          const panel = host.closest('.panel');
          if (panel) {
            panel.classList.add('shake');
            setTimeout(() => panel.classList.remove('shake'), 420);
          }
        },
        true
      );
    });
  });
}

/* ---------------- 启动 ---------------- */

initPasteBlocker();
mark('textarea', true);
mark('ce', true);

/* CM5 必须排在 Monaco 之前：
 * Monaco 的 loader.js 会定义全局 AMD 的 define，CM5 的 UMD 包装一旦检测到 define.amd
 * 就会走 define() 分支而不是挂 window.CodeMirror，导致编辑器根本建不起来。
 */
(async () => {
  await bootCM5();
  bootMonaco();
})();
bootAce();
bootCM6();

// 兜底：网络卡死时也要让 ready 变 true，否则测试会一直等
setTimeout(() => {
  KINDS.forEach((k) => {
    if (!state.status[k]) mark(k, false, '加载超时');
  });
  demo.ready = true;
}, 30000);

$('reset')?.addEventListener('click', reset);
$('hideMonaco')?.addEventListener('click', () => {
  if (!hideMonacoApi(!monacoApiHidden)) {
    const el = $('hideMonacoState');
    if (el) el.textContent = 'Monaco 尚未加载完成';
  }
});
