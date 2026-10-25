/* 贴进去 · PasteBridge — 注入清单（单一来源）
 *
 * 这份清单被三个环境共用，任何一处增删页面脚本都只改这里：
 *   · background/sw.js    → importScripts('lib/files.js')
 *   · popup / workbench   → <script src="../lib/files.js">
 *   · Node 测试           → createRequire(import.meta.url)('../lib/files.js')
 *
 * 顺序即依赖顺序：core 打底，main 必须最后。
 */
(() => {
  'use strict';

  const FILES = {
    version: '2.1.2',
    page: [
      'page/core.js',
      'page/specs.js',
      'page/detect.js',
      'page/methods.js',
      'page/insert.js',
      'page/picker.js',
      'page/main.js'
    ]
  };

  if (typeof globalThis !== 'undefined') globalThis.PB_FILES = FILES;
  if (typeof module !== 'undefined' && module.exports) module.exports = FILES;
})();
