/* 贴进去 · PasteBridge — 页面世界基础层
 *
 * 该文件不依赖任何扩展 API，MAIN 世界与 ISOLATED 世界都能运行。
 * 样式一律走 CSSOM 属性赋值（node.style.xxx = ...），
 * 不使用 innerHTML / setAttribute('style') / new Function，
 * 以兼容开启 Trusted Types 与严格 CSP 的站点。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  const HOST_ID = '__wb_host__';
  const Z = '2147483647';

  function style(node, props) {
    for (const k in props) {
      try {
        node.style[k] = props[k];
      } catch (_) {
        /* 忽略不支持的属性 */
      }
    }
    return node;
  }

  function mk(tag, props, text) {
    const n = document.createElement(tag);
    if (props) style(n, props);
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------- 隔离宿主（Shadow DOM，避免站点样式污染） ---------- */

  function host() {
    let h = document.getElementById(HOST_ID);
    if (h) {
      if (!h.shadowRoot) h.attachShadow({ mode: 'open' });
      return h;
    }
    h = mk('div', {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      zIndex: Z,
      pointerEvents: 'none'
    });
    h.id = HOST_ID;
    h.attachShadow({ mode: 'open' });
    (document.documentElement || document.body).appendChild(h);
    return h;
  }

  let toastEl = null;
  let toastTimer = 0;

  function toast(msg, type = 'info', ms = 2600) {
    const root = host().shadowRoot;
    // 每次打开弹窗都会重新注入本文件，模块变量会被重置；
    // 所以先按 id 找回已经存在的节点，避免越攒越多。
    if (!toastEl || !toastEl.isConnected) toastEl = root.getElementById('__wb_toast');
    if (!toastEl) {
      toastEl = mk('div', {
        position: 'fixed',
        right: '18px',
        bottom: '18px',
        maxWidth: '360px',
        padding: '10px 14px',
        borderRadius: '10px',
        color: '#ffffff',
        background: '#111827',
        font: '13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        boxShadow: '0 10px 30px rgba(0, 0, 0, .28)',
        opacity: '0',
        transform: 'translateY(8px)',
        transition: 'opacity .18s ease, transform .18s ease',
        pointerEvents: 'none',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        zIndex: Z
      });
      toastEl.id = '__wb_toast';
      toastEl.setAttribute('role', 'status');
      root.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    style(toastEl, {
      background: type === 'ok' ? '#0f766e' : type === 'err' ? '#b91c1c' : '#111827',
      opacity: '0',
      transform: 'translateY(8px)'
    });
    // 强制重排，让过渡动画重新触发
    void toastEl.offsetWidth;
    style(toastEl, { opacity: '1', transform: 'translateY(0)' });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) style(toastEl, { opacity: '0', transform: 'translateY(8px)' });
    }, ms);
  }

  /* ---------- DOM 遍历（穿透 open shadow root） ---------- */

  function collectRoots() {
    const roots = [document];
    let budget = 30000;
    const scan = (root) => {
      let nodes;
      try {
        nodes = root.querySelectorAll('*');
      } catch (_) {
        return;
      }
      for (const n of nodes) {
        if (budget-- <= 0) return;
        if (n.shadowRoot) {
          roots.push(n.shadowRoot);
          scan(n.shadowRoot);
        }
      }
    };
    scan(document);
    return roots;
  }

  function activeElementDeep() {
    let a = document.activeElement;
    let guard = 0;
    while (a && a.shadowRoot && a.shadowRoot.activeElement && guard++ < 20) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  function inOwnUI(node) {
    let n = node;
    let guard = 0;
    while (n && guard++ < 30) {
      if (n.id === HOST_ID) return true;
      const root = n.getRootNode && n.getRootNode();
      if (root && root.host) {
        n = root.host;
        continue;
      }
      break;
    }
    return false;
  }

  function closestDeep(node, sel) {
    let n = node;
    let guard = 0;
    while (n && n.nodeType === 1 && guard++ < 40) {
      if (n.matches && n.matches(sel)) return n;
      const root = n.getRootNode && n.getRootNode();
      if (root && root.host) n = root.host;
      else break;
    }
    return null;
  }

  function isVisible(node) {
    if (!node || !node.isConnected) return false;
    let r;
    try {
      r = node.getBoundingClientRect();
    } catch (_) {
      return false;
    }
    if (r.width < 60 || r.height < 24) return false;
    let cs;
    try {
      cs = getComputedStyle(node);
    } catch (_) {
      return true;
    }
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (Number(cs.opacity) === 0) return false;
    return true;
  }

  /* ---------- 工具 ---------- */

  function squash(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 后台标签页里 requestAnimationFrame 会被节流到每秒一帧甚至停摆，
   * 所以必须带定时兜底，否则插入做完后流程会卡住不返回。 */
  const nextFrame = () =>
    new Promise((r) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        r();
      };
      try {
        requestAnimationFrame(fin);
      } catch (_) {}
      setTimeout(fin, 120);
    });

  async function frames(n = 2) {
    for (let i = 0; i < n; i++) await nextFrame();
  }

  NS.core = {
    HOST_ID,
    Z,
    style,
    mk,
    host,
    toast,
    collectRoots,
    activeElementDeep,
    inOwnUI,
    closestDeep,
    isVisible,
    squash,
    sleep,
    nextFrame,
    frames
  };
})();
