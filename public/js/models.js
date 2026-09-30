'use strict';

// Model catalogue + picker dialog. Models come from each provider's
// /models endpoint via the backend (cached there).
window.Models = (() => {
  const { t } = window.I18n;
  // Catalogues per kind: [{ providerId, providerName, models, error, detail }]
  const catalogs = { chat: [], embedding: [] };
  let kind = 'chat'; // kind shown in the open dialog
  let groups = catalogs.chat;
  let cfg = null;
  let onSelect = null;
  let current = null; // { providerId, modelId }
  let activeTab = 'all';
  let focusIndex = -1;
  let visibleItems = [];

  const $ = (id) => document.getElementById(id);
  const dialog = $('model-dialog');

  function init(publicConfig) {
    cfg = publicConfig;
    $('model-search').addEventListener('input', () => { focusIndex = -1; renderList(); });
    $('filter-vision').addEventListener('change', renderList);
    $('models-refresh').addEventListener('click', async () => {
      await load(true, kind);
      renderTabs();
      renderList();
    });
    $('model-search').addEventListener('keydown', onKey);
  }

  async function load(refresh = false, k = 'chat') {
    $('model-list').innerHTML = '';
    const note = document.createElement('div');
    note.className = 'notice';
    note.textContent = t('models.loading');
    $('model-list').append(note);
    const params = new URLSearchParams({ kind: k });
    if (refresh) params.set('refresh', '1');
    catalogs[k] = await Api.get(`/api/models?${params}`);
    if (k === kind) groups = catalogs[k];
    return catalogs[k];
  }

  function find(providerId, modelId, k = 'chat') {
    const g = catalogs[k].find((x) => x.providerId === providerId);
    return g ? g.models.find((m) => m.id === modelId) || null : null;
  }

  function providerName(providerId) {
    const g = catalogs.chat.find((x) => x.providerId === providerId) || catalogs.embedding.find((x) => x.providerId === providerId);
    return g ? g.providerName : providerId;
  }

  function firstAvailable() {
    for (const g of catalogs.chat) if (g.models.length) return { providerId: g.providerId, modelId: g.models[0].id };
    return null;
  }

  function formatPrice(perToken) {
    if (perToken == null) return '–';
    const ui = cfg.ui;
    return `${ui.priceCurrencySymbol}${(perToken * ui.pricePerTokens).toFixed(ui.priceDecimals)}`;
  }

  function formatCount(n) {
    return new Intl.NumberFormat(I18n.meta.locale, { notation: 'compact' }).format(n);
  }

  function formatContext(n) {
    if (!n) return '';
    if (n >= 1e6) return t('models.contextM', { n: +(n / 1e6).toFixed(n % 1e6 ? 2 : 0) });
    return t('models.contextK', { n: Math.round(n / 1000) });
  }

  function renderTabs() {
    const box = $('provider-tabs');
    box.innerHTML = '';
    const tabs = [{ id: 'all', name: t('models.allProviders') }].concat(
      groups.map((g) => ({ id: g.providerId, name: `${g.providerName} (${g.models.length})` })),
    );
    for (const tab of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (tab.id === activeTab ? ' active' : '');
      b.textContent = tab.name;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { activeTab = tab.id; renderTabs(); renderList(); });
      box.append(b);
    }
  }

  function matches(m, terms) {
    const hay = `${m.name} ${m.id}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  }

  function renderList() {
    const list = $('model-list');
    list.innerHTML = '';
    visibleItems = [];
    const terms = $('model-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const onlyVision = $('filter-vision').checked;
    let shown = 0;
    let total = 0;

    for (const g of groups) {
      if (activeTab !== 'all' && activeTab !== g.providerId) continue;
      const title = document.createElement('div');
      title.className = 'model-group-title';
      title.textContent = g.providerName;
      list.append(title);

      if (g.error) {
        const n = document.createElement('div');
        n.className = 'notice error';
        n.textContent = t(`errors.${g.error}`, { provider: g.providerName }) + (g.detail ? ` — ${g.detail}` : '');
        list.append(n);
        continue;
      }
      const models = g.models.filter((m) => matches(m, terms) && (!onlyVision || m.vision));
      total += models.length;
      if (!models.length) {
        const n = document.createElement('div');
        n.className = 'notice';
        n.textContent = t(kind === 'embedding' && !g.models.length ? 'panel.noEmbeddingModels' : 'models.noResults');
        list.append(n);
        continue;
      }
      for (const m of models) {
        if (shown >= cfg.ui.maxModelResults) break;
        shown++;
        list.append(modelItem(g, m));
      }
    }
    if (shown < total) {
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = t('models.truncated', { shown, total });
      list.append(n);
    }
  }

  function modelItem(g, m) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'model-item';
    if (current && current.providerId === g.providerId && current.modelId === m.id) b.classList.add('selected');

    const line = document.createElement('div');
    line.className = 'model-line';
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = m.name;
    const id = document.createElement('span');
    id.className = 'model-id';
    id.textContent = m.id;
    line.append(name, id);

    const info = document.createElement('div');
    info.className = 'model-info';
    const parts = [];
    if (m.contextLength) parts.push(formatContext(m.contextLength));
    if (m.inputPrice != null || m.outputPrice != null) {
      parts.push(t('models.price', { input: formatPrice(m.inputPrice), output: formatPrice(m.outputPrice), per: formatCount(cfg.ui.pricePerTokens) }));
    }
    for (const p of parts) {
      const s = document.createElement('span');
      s.textContent = p;
      info.append(s);
    }
    for (const [flag, key] of [['vision', 'models.vision'], ['video', 'models.video'], ['reasoning', 'models.reasoning']]) {
      if (!m[flag]) continue;
      const s = document.createElement('span');
      s.className = 'badge';
      s.textContent = t(key);
      info.append(s);
    }
    b.append(line, info);

    if (cfg.ui.showModelDescriptions && m.description) {
      const d = document.createElement('div');
      d.className = 'model-desc';
      d.textContent = m.description;
      b.append(d);
    }
    b.addEventListener('click', () => choose(g.providerId, m.id));
    visibleItems.push({ el: b, providerId: g.providerId, modelId: m.id });
    return b;
  }

  function onKey(e) {
    if (!visibleItems.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusIndex = Math.max(0, Math.min(visibleItems.length - 1, focusIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      visibleItems.forEach((it, i) => it.el.classList.toggle('focus', i === focusIndex));
      visibleItems[focusIndex].el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = visibleItems[Math.max(0, focusIndex)];
      choose(it.providerId, it.modelId);
    }
  }

  function choose(providerId, modelId) {
    dialog.close();
    if (onSelect) onSelect({ providerId, modelId });
  }

  // options.kind: 'chat' (default) or 'embedding'.
  async function open(selection, callback, options = {}) {
    kind = options.kind || 'chat';
    groups = catalogs[kind];
    activeTab = 'all';
    current = selection;
    onSelect = callback;
    dialog.querySelector('.dialog-head h3').textContent = t(kind === 'embedding' ? 'panel.embeddingModelsTitle' : 'models.title');
    $('model-search').value = '';
    focusIndex = -1;
    dialog.showModal();
    $('model-search').focus();
    if (!groups.length) {
      try { await load(false, kind); } catch (err) { window.App.toastError(err); }
    }
    renderTabs();
    renderList();
  }

  return { init, load, open, find, providerName, firstAvailable, formatPrice, get groups() { return catalogs.chat; } };
})();
