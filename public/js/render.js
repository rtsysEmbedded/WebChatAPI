'use strict';

// Markdown -> sanitized HTML. Model output is untrusted, so every render
// goes through DOMPurify before it touches the DOM.
window.Render = (() => {
  const { t } = window.I18n;

  marked.setOptions({ gfm: true, breaks: false });

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for non-secure (http) origins where the Clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function decorateCodeBlocks(root, highlight) {
    root.querySelectorAll('pre > code').forEach((code) => {
      const pre = code.parentElement;
      if (pre.parentElement.classList.contains('code-block')) return;
      const lang = (/language-([\w+#.-]+)/.exec(code.className) || [])[1] || '';
      const wrap = document.createElement('div');
      wrap.className = 'code-block';
      const head = document.createElement('div');
      head.className = 'code-head';
      const label = document.createElement('span');
      label.textContent = lang || t('chat.code');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = t('chat.copyCode');
      btn.addEventListener('click', async () => {
        if (await copyText(code.textContent)) {
          btn.textContent = t('chat.copied');
          setTimeout(() => { btn.textContent = t('chat.copyCode'); }, 1500);
        }
      });
      head.append(label, btn);
      pre.replaceWith(wrap);
      wrap.append(head, pre);
      if (highlight && window.hljs) {
        try { hljs.highlightElement(code); } catch { /* unknown language */ }
      }
    });
  }

  // `final` = the message is complete; syntax highlighting runs only then,
  // because re-highlighting on every streamed token is expensive.
  function markdown(el, text, final) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
    decorateCodeBlocks(el, final);
  }

  return { markdown, copyText };
})();
