'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { fileURLToPath } = require('url');
const { clipboard } = require('electron');

const MAX_FILES = 20;

function sanitize(files) {
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const p = String(f || '').replace(/\u0000/g, '').trim();
    if (!p || seen.has(p)) continue;
    try {
      if (!fs.existsSync(p)) continue;
    } catch {
      continue;
    }
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

// Windows:剪贴板里的文件列表(Electron 44 的 clipboard 拿不到 CF_HDROP,借道 PowerShell)
function readFilesViaPowerShell() {
  return new Promise((resolve) => {
    const script =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
      '$l = Get-Clipboard -Format FileDropList; ' +
      'if ($l) { $l | ForEach-Object { if ($_ -is [string]) { $_ } elseif ($_.FullName) { $_.FullName } else { [string]$_ } } }';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        resolve(
          stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        );
      }
    );
  });
}

// 读取剪贴板中"复制的文件"的本地路径
async function readClipboardFilePaths() {
  let files = [];
  if (process.platform === 'win32') {
    files = await readFilesViaPowerShell();
  } else if (process.platform === 'darwin') {
    try {
      const url = await clipboard.read('public.file-url');
      if (url) files = [fileURLToPath(url)];
    } catch {}
  } else {
    try {
      const gnome = await clipboard.read('x-special/gnome-copied-files');
      if (gnome) {
        files = gnome
          .split(/\r?\n/)
          .slice(1)
          .map((u) => {
            try {
              return fileURLToPath(u);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }
    } catch {}
  }
  return sanitize(files);
}

// 在 guest 页面的聊天输入框中插入文本(兼容 React 受控组件与 contentEditable)
function insertPaths(contents, files, notifyResult) {
  const snippet = `(() => {
    try {
      const value = ${JSON.stringify(files.join('\n'))};
      const isEditable = (n) => !!n && (
        n.tagName === 'TEXTAREA' ||
        n.isContentEditable ||
        (n.tagName === 'INPUT' && !/^(button|checkbox|radio|file|submit|image)$/i.test(n.type || 'text'))
      );
      const vis = (n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
      let el = document.activeElement;
      let via = 'activeElement';
      if (!isEditable(el) || !vis(el)) {
        const cands = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"], input:not([type])')].filter(vis);
        el = cands[cands.length - 1] || cands[0];
        via = 'selector';
      }
      if (!isEditable(el)) return { ok: false, reason: 'no-input' };
      const dbg = {
        via,
        tag: el.tagName,
        id: el.id,
        cls: String(el.className).slice(0, 60),
        visible: vis(el),
        textareas: document.querySelectorAll('textarea').length,
        active: document.activeElement ? document.activeElement.tagName : 'none',
        before: (el.value !== undefined ? el.value : el.textContent).length,
      };
      el.focus();
      if (el.isContentEditable) {
        let done = false;
        try { done = document.execCommand('insertText', false, value); } catch (_) {}
        if (!done) {
          const sel = window.getSelection();
          const range = (sel && sel.rangeCount) ? sel.getRangeAt(0) : document.createRange();
          range.deleteContents();
          range.insertNode(document.createTextNode(value));
          range.collapse(false);
          if (sel) { sel.removeAllRanges(); sel.addRange(range); }
          el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        return { ok: true };
      }
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      let method = '';
      // 首选 execCommand:产生原生 beforeinput/input 事件,React 等框架可直接感知
      try {
        el.setSelectionRange(start, end);
        if (document.execCommand('insertText', false, value)) method = 'exec';
      } catch (_) {}
      if (!method) {
        // 兜底:原型 setter + input 事件
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        const next = el.value.slice(0, start) + value + el.value.slice(end);
        setter.call(el, next);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        method = 'setter';
      }
      const pos = start + value.length;
      try { el.setSelectionRange(pos, pos); } catch (_) {}
      dbg.method = method;
      dbg.after = (el.value !== undefined ? el.value : el.textContent).length;
      return { ok: true, dbg };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  })()`;

  contents
    .executeJavaScript(snippet)
    .then((res) => {
      console.log('[webview-files] insert raw:', JSON.stringify(res));
      notifyResult(res && res.ok ? { ok: true, count: files.length } : { ok: false, reason: (res && res.reason) || 'no-input' });
    })
    .catch((err) => notifyResult({ ok: false, reason: String((err && err.message) || err) }));
}

// webview 内粘贴决策:剪贴板是文本/图片 → 原生粘贴;是复制的文件 → 插入路径
async function handlePaste(contents, notifyResult) {
  try {
    const text = await clipboard.readText();
    if (text && text.length) {
      contents.paste();
      return;
    }
  } catch {}
  try {
    const files = await readClipboardFilePaths();
    if (files.length) {
      insertPaths(contents, files, notifyResult);
      return;
    }
  } catch {}
  // 剪贴板里是图片等非文本内容 → 原生粘贴,由页面自行处理
  contents.paste();
}

// 为 webview guest 挂载钩子:Ctrl+V 粘贴决策、拖拽转发、防误跳转 file://
function attachWebContentsHooks(contents, { notifyResult }) {
  if (contents.getType() !== 'webview') return;

  // 在按键阶段拦截 Ctrl+V(而非监听页面 paste 事件):主进程调用 contents.paste()
  // 派发的 paste 事件不会被任何监听器再次转发,避免"粘贴 → 转发 → 再粘贴"死循环
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'v' && (input.control || input.meta) && !input.alt && !input.shift) {
      e.preventDefault();
      handlePaste(contents, notifyResult);
    }
  });

  contents.on('ipc-message', (_e, channel, files) => {
    if (channel === 'webview:dropped-files' && Array.isArray(files)) {
      const list = sanitize(files);
      if (list.length) insertPaths(contents, list, notifyResult);
    }
  });

  // 兜底:任何情况下都不允许 guest 被拖拽带到 file:// 页面
  contents.on('will-navigate', (e, url) => {
    if (String(url).startsWith('file://')) e.preventDefault();
  });
}

module.exports = { attachWebContentsHooks, readClipboardFilePaths };
