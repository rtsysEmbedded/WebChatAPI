'use strict';

// UI strings come from config/i18n/<lang>.json (section "ui"), served by
// /api/i18n/<lang>. Nothing user-visible is hardcoded in the markup.
window.I18n = (() => {
  let strings = {};
  let meta = { dir: 'ltr', locale: 'en' };

  function lookup(key) {
    return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), strings);
  }

  function t(key, vars = {}) {
    const s = lookup(key);
    if (typeof s !== 'string') return key;
    return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
      el.setAttribute('aria-label', el.title);
    });
  }

  async function load(lang) {
    const res = await fetch(`/api/i18n/${encodeURIComponent(lang)}`);
    if (!res.ok) throw new Error(`i18n ${lang}: ${res.status}`);
    const data = await res.json();
    strings = data.ui;
    meta = data.meta;
    document.documentElement.lang = lang;
    document.documentElement.dir = meta.dir;
    apply();
  }

  return { t, apply, load, get meta() { return meta; } };
})();
