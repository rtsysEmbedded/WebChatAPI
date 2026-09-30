'use strict';

window.App = (() => {
  const { t } = window.I18n;
  const $ = (id) => document.getElementById(id);
  const STORE = { theme: 'wca.theme', lang: 'wca.lang', model: 'wca.lastModel' };

  const state = {
    cfg: null,
    convs: [],
    current: null, // full conversation (with messages) or null for a new chat
    draft: null, // settings for a chat that has not been created yet
    images: [], // pending image data URLs
    stream: null, // { controller }
  };

  // ---- Small utilities ------------------------------------------------------

  function storeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function errorText(err) {
    const key = `errors.${err.code || 'internal'}`;
    const base = t(key, { provider: err.detail || '', max: Math.round(state.cfg.chat.maxImageBytes / 1048576) });
    if (base === key) return err.message || t('errors.internal');
    return err.detail && !base.includes(err.detail) ? `${base} — ${err.detail}` : base;
  }
  function toastError(err) { toast(errorText(err)); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(path) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'icon');
    s.innerHTML = path;
    return s;
  }
  const ICONS = {
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    retry: '<path d="M4 4v6h6M20 20v-6h-6"/><path d="M5.5 15a7 7 0 0012 2.5M18.5 9A7 7 0 006.5 6.5"/>',
    pin: '<path d="M9 4h6l-1 6 4 4H6l4-4-1-6zM12 14v6"/>',
    rename: '<path d="M4 20h16M6 16l9.5-9.5 3 3L9 19H6v-3z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  };

  function iconButton(name, titleKey, onClick) {
    const b = el('button', 'icon-btn');
    b.type = 'button';
    b.title = t(titleKey);
    b.setAttribute('aria-label', b.title);
    b.append(icon(ICONS[name]));
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(b); });
    return b;
  }

  // Generic text prompt / confirm built on <dialog>.
  function ask(message, { input = false, value = '', okKey = 'common.ok', danger = false } = {}) {
    return new Promise((resolve) => {
      const dlg = $('prompt-dialog');
      $('prompt-message').textContent = message;
      const inp = $('prompt-input');
      inp.hidden = !input;
      inp.value = value;
      const ok = $('prompt-ok');
      ok.textContent = t(okKey);
      ok.classList.toggle('danger', danger);
      const form = $('prompt-form');
      const finish = (result) => {
        form.removeEventListener('submit', onSubmit);
        dlg.removeEventListener('close', onClose);
        resolve(result);
      };
      const onSubmit = (e) => { e.preventDefault(); dlg.close(); finish(input ? inp.value : true); };
      const onClose = () => finish(input ? null : false);
      form.addEventListener('submit', onSubmit);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
      if (input) { inp.focus(); inp.select(); }
    });
  }

  // ---- Theme & language -----------------------------------------------------

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    $('hljs-dark').disabled = !dark;
    $('hljs-light').disabled = dark;
  }

  function currentTheme() {
    return storeGet(STORE.theme) || state.cfg.ui.defaultTheme;
  }

  // ---- Auth -----------------------------------------------------------------

  function showView(name) {
    $('boot').hidden = true;
    $('login-view').hidden = name !== 'login';
    $('app-view').hidden = name !== 'app';
  }

  function showLogin(status) {
    showView('login');
    const err = $('login-error');
    err.hidden = true;
    if (status && !status.pinConfigured) {
      err.textContent = t('errors.pinNotConfigured');
      err.hidden = false;
    }
    $('pin-input').value = '';
    $('pin-input').focus();
  }

  async function onLogin(e) {
    e.preventDefault();
    const err = $('login-error');
    const pin = $('pin-input').value.trim();
    const btn = e.submitter || $('login-form').querySelector('button');
    btn.disabled = true;
    err.hidden = true;
    try {
      await Api.post('/api/auth/login', { pin });
      await startApp();
    } catch (ex) {
      err.textContent = ex.code === 'locked'
        ? t('errors.locked', { minutes: Math.ceil((ex.retryAfter || 60) / 60) })
        : errorText(ex);
      err.hidden = false;
      $('pin-input').select();
    } finally {
      btn.disabled = false;
    }
  }

  async function logout() {
    await Api.post('/api/auth/logout').catch(() => {});
    state.current = null;
    showLogin();
  }

  // ---- Conversations sidebar -------------------------------------------------

  function groupKey(iso, pinned) {
    if (pinned) return 'sidebar.pinned';
    const d = new Date(iso);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const day = 86400e3;
    if (d >= start) return 'sidebar.today';
    if (d >= start - day) return 'sidebar.yesterday';
    if (d >= start - 7 * day) return 'sidebar.last7';
    if (d >= start - 30 * day) return 'sidebar.last30';
    return 'sidebar.older';
  }

  function renderConvList() {
    const box = $('conv-list');
    box.innerHTML = '';
    const q = $('conv-search').value.trim().toLowerCase();
    const items = state.convs.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
    let lastGroup = null;
    for (const c of items) {
      const g = groupKey(c.updatedAt, c.pinned);
      if (g !== lastGroup) {
        box.append(el('div', 'conv-group', t(g)));
        lastGroup = g;
      }
      const item = el('div', 'conv-item' + (state.current && state.current.id === c.id ? ' active' : ''));
      const title = el('span', 'conv-title', c.title || t('sidebar.untitled'));
      title.dir = 'auto';
      const actions = el('span', 'conv-actions');
      actions.append(
        iconButton('pin', c.pinned ? 'sidebar.unpin' : 'sidebar.pin', () => updateConv(c.id, { pinned: !c.pinned })),
        iconButton('rename', 'sidebar.rename', () => renameConv(c)),
        iconButton('trash', 'sidebar.delete', () => deleteConv(c)),
      );
      item.append(title, actions);
      item.addEventListener('click', () => { location.hash = `#/c/${c.id}`; closeSidebar(); });
      box.append(item);
    }
  }

  async function refreshConvs() {
    state.convs = await Api.get('/api/conversations');
    renderConvList();
  }

  function upsertSummary(conv) {
    const summary = {
      id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
      providerId: conv.providerId, modelId: conv.modelId, pinned: !!conv.pinned,
    };
    state.convs = [summary].concat(state.convs.filter((c) => c.id !== conv.id));
    state.convs.sort((a, b) => (b.pinned - a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
    renderConvList();
  }

  async function updateConv(id, patch) {
    try {
      const c = await Api.patch(`/api/conversations/${id}`, patch);
      if (state.current && state.current.id === id) Object.assign(state.current, { ...c, messages: state.current.messages });
      upsertSummary(c);
      updateModelLabel();
      return c;
    } catch (err) { toastError(err); return null; }
  }

  async function renameConv(c) {
    const title = await ask(t('sidebar.renamePrompt'), { input: true, value: c.title });
    if (title != null && title.trim()) updateConv(c.id, { title: title.trim() });
  }

  async function deleteConv(c) {
    if (!(await ask(t('sidebar.deleteConfirm', { title: c.title || t('sidebar.untitled') }), { okKey: 'sidebar.delete', danger: true }))) return;
    try {
      await Api.del(`/api/conversations/${c.id}`);
      state.convs = state.convs.filter((x) => x.id !== c.id);
      if (state.current && state.current.id === c.id) location.hash = '#/';
      renderConvList();
    } catch (err) { toastError(err); }
  }

  // ---- Model & settings -----------------------------------------------------

  function settingsSource() {
    return state.current || state.draft;
  }

  function newDraft() {
    const chat = state.cfg.chat;
    let last = null;
    try { last = JSON.parse(storeGet(STORE.model) || 'null'); } catch { /* ignore */ }
    return {
      providerId: last ? last.providerId : null,
      modelId: last ? last.modelId : null,
      systemPrompt: chat.defaultSystemPrompt,
      temperature: chat.defaultTemperature,
      maxTokens: chat.defaultMaxTokens,
      reasoningEffort: '',
    };
  }

  function ensureDraftModel() {
    const d = state.draft;
    if (d.modelId && Models.find(d.providerId, d.modelId)) return;
    if (d.modelId && !Models.groups.length) return; // catalogue not loaded yet
    const first = Models.firstAvailable();
    if (first) Object.assign(d, first);
  }

  function updateModelLabel() {
    const s = settingsSource();
    const label = $('model-button-label');
    if (!s || !s.modelId) { label.textContent = t('models.choose'); return; }
    const m = Models.find(s.providerId, s.modelId);
    label.textContent = m ? m.name : s.modelId;
    $('model-button').title = `${Models.providerName(s.providerId)} · ${s.modelId}`;
  }

  function openModelPicker() {
    const s = settingsSource();
    Models.open(s ? { providerId: s.providerId, modelId: s.modelId } : null, async (sel) => {
      storeSet(STORE.model, JSON.stringify(sel));
      if (state.current) await updateConv(state.current.id, sel);
      else Object.assign(state.draft, sel);
      updateModelLabel();
    });
  }

  function providerSupportsEffort(providerId) {
    const p = state.cfg.providers.find((x) => x.id === providerId);
    return !!(p && p.supportsReasoningEffort);
  }

  function openSettings() {
    const s = settingsSource();
    const chat = state.cfg.chat;
    $('set-system').value = s.systemPrompt || '';
    const temp = $('set-temp');
    temp.min = chat.temperatureMin;
    temp.max = chat.temperatureMax;
    temp.step = chat.temperatureStep;
    temp.value = s.temperature != null ? s.temperature : chat.defaultTemperature;
    $('set-temp-out').textContent = temp.value;
    $('set-max').value = s.maxTokens || '';
    const effort = $('set-effort');
    effort.innerHTML = '';
    for (const v of chat.reasoningEfforts) {
      const o = el('option', null, t(`settings.effort.${v || 'default'}`));
      o.value = v;
      effort.append(o);
    }
    effort.value = s.reasoningEffort || '';
    $('set-effort-field').hidden = !providerSupportsEffort(s.providerId);
    $('settings-dialog').showModal();
  }

  async function saveSettings(e) {
    e.preventDefault();
    const max = parseInt($('set-max').value, 10);
    const patch = {
      systemPrompt: $('set-system').value,
      temperature: parseFloat($('set-temp').value),
      maxTokens: Number.isInteger(max) && max > 0 ? max : null,
      reasoningEffort: $('set-effort').value,
    };
    $('settings-dialog').close();
    if (state.current) await updateConv(state.current.id, patch);
    else Object.assign(state.draft, patch);
  }

  // ---- Messages -------------------------------------------------------------

  function nearBottom() {
    const m = $('messages');
    return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
  }
  function scrollToBottom() {
    const m = $('messages');
    m.scrollTop = m.scrollHeight;
  }

  function copyButton(getText) {
    return iconButton('copy', 'chat.copy', async (b) => {
      if (await Render.copyText(getText())) {
        b.replaceChildren(icon(ICONS.check));
        setTimeout(() => b.replaceChildren(icon(ICONS.copy)), 1500);
      }
    });
  }

  function usageLabel(u) {
    if (!u) return '';
    return t('chat.tokens', { input: u.prompt_tokens ?? '–', output: u.completion_tokens ?? '–' });
  }

  function renderUser(m) {
    const wrap = el('div', 'msg user');
    wrap.dataset.id = m.id;
    if (m.images && m.images.length) {
      const imgs = el('div', 'msg-images');
      for (const src of m.images) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        imgs.append(img);
      }
      wrap.append(imgs);
    }
    if (m.content) {
      const bubble = el('div', 'bubble', m.content);
      bubble.dir = 'auto';
      wrap.append(bubble);
    }
    const meta = el('div', 'msg-meta');
    meta.append(copyButton(() => m.content), iconButton('edit', 'chat.edit', () => startEdit(wrap, m)));
    wrap.append(meta);
    return wrap;
  }

  // Assistant message element with an update() method used while streaming.
  function renderAssistant(m, isLast) {
    const wrap = el('div', 'msg assistant');
    wrap.dataset.id = m.id;
    const reasoning = el('details', 'reasoning');
    const summary = el('summary', null, t('chat.reasoning'));
    const rBody = el('div', 'reasoning-body');
    rBody.dir = 'auto';
    reasoning.append(summary, rBody);
    const bubble = el('div', 'bubble md');
    bubble.dir = 'auto';
    const error = el('div', 'msg-error');
    const meta = el('div', 'msg-meta');
    wrap.append(reasoning, bubble, error, meta);

    function update(msg, { streaming = false } = {}) {
      reasoning.hidden = !msg.reasoning;
      rBody.textContent = msg.reasoning || '';
      if (streaming && msg.reasoning && !msg.content) {
        reasoning.open = true;
        summary.textContent = t('chat.thinking');
      } else if (streaming) {
        summary.textContent = t('chat.reasoning');
      }
      Render.markdown(bubble, msg.content, !streaming);
      bubble.classList.toggle('typing', streaming);
      error.hidden = !msg.error;
      error.textContent = msg.error ? t('chat.errorPrefix', { error: msg.error }) : '';

      meta.innerHTML = '';
      if (streaming) return;
      meta.append(copyButton(() => msg.content));
      if (isLast) meta.append(iconButton('retry', 'chat.regenerate', () => runChat({ regenerate: true })));
      const info = [msg.modelId];
      if (msg.stopped) info.push(t('chat.stopped'));
      const usage = usageLabel(msg.usage);
      if (usage) info.push(usage);
      meta.append(el('span', 'label', info.filter(Boolean).join(' · ')));
    }
    update(m);
    wrap.update = update;
    return wrap;
  }

  function renderMessages() {
    const box = $('messages');
    box.querySelectorAll('.msg').forEach((n) => n.remove());
    const msgs = state.current ? state.current.messages : [];
    $('empty-state').hidden = msgs.length > 0;
    msgs.forEach((m, i) => {
      box.append(m.role === 'user' ? renderUser(m) : renderAssistant(m, i === msgs.length - 1));
    });
    scrollToBottom();
  }

  function startEdit(wrap, m) {
    if (state.stream) return;
    const box = el('div', 'edit-box');
    const ta = el('textarea', 'input');
    ta.value = m.content;
    ta.dir = 'auto';
    const row = el('div', 'row gap');
    const cancel = el('button', 'btn ghost small', t('common.cancel'));
    const save = el('button', 'btn primary small', t('chat.saveAndSend'));
    cancel.type = save.type = 'button';
    row.append(cancel, save);
    box.append(ta, row);
    const old = [...wrap.childNodes];
    wrap.replaceChildren(box);
    ta.focus();
    cancel.addEventListener('click', () => wrap.replaceChildren(...old));
    save.addEventListener('click', () => {
      if (!ta.value.trim() && !(m.images && m.images.length)) return;
      runChat({ content: ta.value, images: m.images || [], editFromMessageId: m.id });
    });
  }

  // ---- Sending & streaming --------------------------------------------------

  function setStreaming(on) {
    $('send-button').hidden = on;
    $('stop-button').hidden = !on;
  }

  async function send(e) {
    if (e) e.preventDefault();
    if (state.stream) return;
    const content = $('prompt').value;
    const images = state.images.slice();
    if (!content.trim() && !images.length) return;
    const s = settingsSource();
    if (!s.modelId) { openModelPicker(); return; }
    const model = Models.find(s.providerId, s.modelId);
    if (images.length && model && !model.vision) toast(t('chat.noVisionWarning'));

    if (!state.current) {
      try {
        const c = await Api.post('/api/conversations', state.draft);
        state.current = c;
        upsertSummary(c);
        history.replaceState(null, '', `#/c/${c.id}`);
      } catch (err) { toastError(err); return; }
    }
    $('prompt').value = '';
    autosize();
    state.images = [];
    renderAttachments();
    if (!(await runChat({ content, images }))) {
      // Nothing was stored server-side: give the user their text back.
      $('prompt').value = content;
      autosize();
      state.images = images;
      renderAttachments();
    }
  }

  async function runChat(body) {
    const conv = state.current;
    if (!conv || state.stream) return false;
    const controller = new AbortController();
    state.stream = { controller };
    setStreaming(true);

    const assistant = { id: null, role: 'assistant', content: '', reasoning: '', modelId: conv.modelId, usage: null, error: null };
    let node = null;
    let frame = 0;
    const paint = () => {
      frame = 0;
      if (!node) return;
      const stick = nearBottom();
      node.update(assistant, { streaming: true });
      if (stick) scrollToBottom();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

    try {
      await Api.streamChat(conv.id, body, (event, data) => {
        if (event === 'start') {
          conv.messages = data.messages;
          Object.assign(conv, data.conversation);
          upsertSummary(conv);
          renderMessages();
          assistant.id = data.assistantId;
          node = renderAssistant(assistant, true);
          $('messages').append(node);
          node.update(assistant, { streaming: true });
          scrollToBottom();
        } else if (event === 'delta') {
          assistant[data.type === 'reasoning' ? 'reasoning' : 'content'] += data.text;
          schedule();
        } else if (event === 'usage') {
          assistant.usage = data.usage;
        } else if (event === 'done') {
          Object.assign(assistant, data.message);
          Object.assign(conv, data.conversation);
          upsertSummary(conv);
        }
      }, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError') assistant.stopped = true;
      else if (!node) toastError(err);
      else assistant.error = errorText(err);
    } finally {
      if (frame) cancelAnimationFrame(frame);
      state.stream = null;
      setStreaming(false);
      if (node && state.current === conv) {
        if (!conv.messages.some((m) => m.id === assistant.id)) conv.messages.push(assistant);
        renderMessages();
      }
      $('prompt').focus();
    }
    return !!node;
  }

  function stop() {
    if (state.stream) state.stream.controller.abort();
  }

  // ---- Attachments ----------------------------------------------------------

  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    box.hidden = !state.images.length;
    state.images.forEach((src, i) => {
      const a = el('div', 'attachment');
      const img = el('img');
      img.src = src;
      img.alt = '';
      const rm = el('button', null, '×');
      rm.type = 'button';
      rm.title = t('chat.removeImage');
      rm.addEventListener('click', () => { state.images.splice(i, 1); renderAttachments(); });
      a.append(img, rm);
      box.append(a);
    });
  }

  function addFiles(files) {
    const chat = state.cfg.chat;
    for (const f of files) {
      if (!chat.allowedImageTypes.includes(f.type)) { toast(t('errors.invalidImage')); continue; }
      if (f.size > chat.maxImageBytes) {
        toast(t('errors.imageTooLarge', { max: Math.round(chat.maxImageBytes / 1048576) }));
        continue;
      }
      if (state.images.length >= chat.maxImagesPerMessage) { toast(t('errors.tooManyImages')); break; }
      const reader = new FileReader();
      reader.onload = () => { state.images.push(reader.result); renderAttachments(); };
      reader.readAsDataURL(f);
    }
  }

  // ---- Navigation -----------------------------------------------------------

  async function route() {
    if (state.stream) stop();
    const m = /^#\/c\/([a-f0-9-]{36})$/.exec(location.hash);
    if (m) {
      try {
        state.current = await Api.get(`/api/conversations/${m[1]}`);
      } catch (err) {
        toastError(err);
        location.hash = '#/';
        return;
      }
    } else {
      state.current = null;
      state.draft = newDraft();
      ensureDraftModel();
    }
    renderConvList();
    renderMessages();
    updateModelLabel();
    $('prompt').focus();
  }

  function newChat() {
    closeSidebar();
    if (location.hash === '#/' || !location.hash) route();
    else location.hash = '#/';
  }

  function openSidebar() { $('app-view').classList.add('sidebar-open'); }
  function closeSidebar() { $('app-view').classList.remove('sidebar-open'); }

  function autosize() {
    const ta = $('prompt');
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }

  // ---- Boot -----------------------------------------------------------------

  let appStarted = false;

  async function startApp() {
    showView('app');
    if (!appStarted) {
      appStarted = true;
      Models.init(state.cfg);
      window.addEventListener('hashchange', route);
    }
    await refreshConvs().catch(toastError);
    await route();
    Models.load()
      .then(() => {
        if (!state.current) ensureDraftModel();
        updateModelLabel();
      })
      .catch(toastError);
  }

  function bindEvents() {
    $('login-form').addEventListener('submit', onLogin);
    $('logout').addEventListener('click', logout);
    $('new-chat').addEventListener('click', newChat);
    $('conv-search').addEventListener('input', renderConvList);
    $('toggle-sidebar').addEventListener('click', openSidebar);
    $('scrim').addEventListener('click', closeSidebar);
    $('model-button').addEventListener('click', openModelPicker);
    $('settings-button').addEventListener('click', openSettings);
    $('settings-form').addEventListener('submit', saveSettings);
    $('set-temp').addEventListener('input', (e) => { $('set-temp-out').textContent = e.target.value; });
    $('composer').addEventListener('submit', send);
    $('stop-button').addEventListener('click', stop);
    $('attach-button').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

    const prompt = $('prompt');
    prompt.addEventListener('input', autosize);
    prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && state.cfg.ui.sendOnEnter) {
        e.preventDefault();
        send();
      }
    });
    prompt.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const main = document.querySelector('.main');
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('drop', (e) => {
      e.preventDefault();
      addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
    });

    document.querySelectorAll('dialog [data-close]').forEach((b) => {
      b.addEventListener('click', () => b.closest('dialog').close());
    });

    $('theme-select').addEventListener('change', (e) => {
      storeSet(STORE.theme, e.target.value);
      applyTheme(e.target.value);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme()));

    $('lang-select').addEventListener('change', async (e) => {
      storeSet(STORE.lang, e.target.value);
      await I18n.load(e.target.value);
      renderConvList();
      renderMessages();
      updateModelLabel();
    });

    window.addEventListener('auth-expired', () => showLogin());
  }

  async function boot() {
    try {
      state.cfg = await Api.get('/api/public-config');
      document.title = state.cfg.app.name;
      document.querySelectorAll('.app-name').forEach((n) => { n.textContent = state.cfg.app.name; });

      let lang = storeGet(STORE.lang);
      if (!state.cfg.app.languages.includes(lang)) lang = state.cfg.app.defaultLanguage;
      await I18n.load(lang);
      const langSel = $('lang-select');
      for (const code of state.cfg.app.languages) {
        const o = el('option', null, t(`languages.${code}`));
        o.value = code;
        langSel.append(o);
      }
      langSel.value = lang;

      const theme = currentTheme();
      $('theme-select').value = theme;
      applyTheme(theme);
      bindEvents();

      const status = await Api.get('/api/auth/status');
      if (status.authenticated) await startApp();
      else showLogin(status);
    } catch (err) {
      $('boot').textContent = err.message;
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  return { toast, toastError };
})();
