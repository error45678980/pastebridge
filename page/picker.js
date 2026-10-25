/* 贴进去 · PasteBridge — 多编辑器点选
 *
 * 多个候选时在页面上画编号徽章 + 虚线高亮框。
 * 高亮框是独立图层，绝不修改编辑器自身的 style，避免污染站点样式。
 */
(() => {
  'use strict';

  const NS = (window.__WB_NS__ = window.__WB_NS__ || {});
  const core = NS.core;

  let active = null;

  function cancel() {
    if (!active) return false;
    const a = active;
    active = null;
    a.cleanup();
    return true;
  }

  function pick(cands, onPick, onCancel) {
    cancel();

    const root = core.host().shadowRoot;
    const layer = core.mk('div', {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '0',
      height: '0',
      pointerEvents: 'none'
    });

    const bar = core.mk(
      'div',
      {
        position: 'fixed',
        left: '50%',
        top: '14px',
        transform: 'translateX(-50%)',
        padding: '8px 16px',
        borderRadius: '999px',
        background: '#111827',
        color: '#ffffff',
        font: '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        boxShadow: '0 8px 24px rgba(0, 0, 0, .3)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        zIndex: core.Z
      },
      '选择要插入的编辑器（' + cands.length + ' 个）· Esc 取消'
    );

    const boxes = [];
    const badges = [];

    cands.forEach((c, i) => {
      const box = core.mk('div', {
        position: 'fixed',
        border: '2px dashed #2563eb',
        background: 'rgba(37, 99, 235, .07)',
        borderRadius: '6px',
        boxSizing: 'border-box',
        pointerEvents: 'none',
        display: 'none',
        zIndex: core.Z
      });

      const badge = core.mk(
        'div',
        {
          position: 'fixed',
          width: '28px',
          height: '28px',
          borderRadius: '14px',
          background: '#2563eb',
          color: '#ffffff',
          font: '600 13px/28px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
          textAlign: 'center',
          cursor: 'pointer',
          pointerEvents: 'auto',
          boxShadow: '0 4px 14px rgba(37, 99, 235, .5)',
          userSelect: 'none',
          display: 'none',
          zIndex: core.Z
        },
        String(i + 1)
      );
      badge.setAttribute('data-wb-badge', String(i + 1));
      if (c.name) badge.title = c.label + ' · ' + c.name;

      const trigger = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        onPick(c, i);
      };
      badge.addEventListener('pointerdown', trigger, true);
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
      }, true);

      layer.appendChild(box);
      layer.appendChild(badge);
      boxes.push(box);
      badges.push(badge);
    });

    function place() {
      cands.forEach((c, i) => {
        let r;
        try {
          r = c.el.getBoundingClientRect();
        } catch (_) {
          r = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
        }
        const inView =
          r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;

        core.style(boxes[i], {
          left: r.left + 'px',
          top: r.top + 'px',
          width: r.width + 'px',
          height: r.height + 'px',
          display: inView ? 'block' : 'none'
        });

        const bx = Math.min(Math.max(8, r.left + 8), Math.max(8, innerWidth - 40));
        const by = Math.min(Math.max(8, r.top + 8), Math.max(8, innerHeight - 40));
        core.style(badges[i], { left: bx + 'px', top: by + 'px', display: inView ? 'block' : 'none' });
      });
    }

    let raf = 0;
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        place();
      });
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        if (onCancel) onCancel();
      }
    }

    function cleanup() {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule, true);
      window.removeEventListener('keydown', onKey, true);
      if (raf) cancelAnimationFrame(raf);
      if (layer.parentNode) layer.parentNode.removeChild(layer);
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }

    root.appendChild(layer);
    root.appendChild(bar);
    place();

    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule, true);
    window.addEventListener('keydown', onKey, true);

    active = { cleanup, place };
    return active;
  }

  NS.picker = { pick, cancel, isActive: () => !!active };
})();
