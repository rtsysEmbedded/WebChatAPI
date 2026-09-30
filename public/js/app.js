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
    attachments: [], // pending uploads: { key, id, name, kind, size, status, preview }
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
    b.append(icon(ICONS[name] || name));
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
      const title = el('span', 'conv-title', characterAvatar(c.characterId) + (c.title || t('sidebar.untitled')));
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
      providerId: conv.providerId, modelId: conv.modelId, characterId: conv.characterId || null, pinned: !!conv.pinned,
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
      updateCharacterLabel();
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
      characterId: null,
      useMemory: state.cfg.memory.defaultOnForNewChats,
    };
  }

  // ---- Characters -----------------------------------------------------------

  // Selecting a character for a new chat copies its defaults into the draft;
  // its system prompt is applied by the server on every request.
  function selectCharacter(ch) {
    const d = state.draft;
    const base = newDraft();
    d.characterId = ch ? ch.id : null;
    d.temperature = ch && ch.temperature != null ? ch.temperature : base.temperature;
    d.useMemory = ch ? ch.useMemory !== false : base.useMemory;
    if (ch && ch.modelId) Object.assign(d, { providerId: ch.providerId, modelId: ch.modelId });
    renderCharacterPicker();
    updateCharacterLabel();
    updateModelLabel();
  }

  function renderCharacterPicker() {
    const box = $('character-chips');
    const list = Features.characters;
    $('character-picker').hidden = !!state.current || !list.length;
    box.innerHTML = '';
    const current = state.draft ? state.draft.characterId : null;
    const chip = (ch) => {
      const b = el('button', 'chip' + ((ch ? ch.id : null) === current ? ' active' : ''));
      b.type = 'button';
      b.append(el('span', null, ch ? ch.avatar : state.cfg.characters.defaultAvatar));
      const name = el('span', null, ch ? ch.name : t('characters.default'));
      name.dir = 'auto';
      b.append(name);
      if (ch && ch.description) b.title = ch.description;
      b.addEventListener('click', () => selectCharacter(ch));
      return b;
    };
    box.append(chip(null), ...list.map(chip));
  }

  function updateCharacterLabel() {
    const s = settingsSource();
    const ch = s && s.characterId ? Features.getCharacter(s.characterId) : null;
    const label = $('character-label');
    label.hidden = !ch;
    if (ch) {
      label.textContent = `${ch.avatar} ${ch.name}`;
      label.dir = 'auto';
      label.title = ch.description || ch.name;
    }
  }

  function characterAvatar(id) {
    const ch = id ? Features.getCharacter(id) : null;
    return ch ? `${ch.avatar} ` : '';
  }

  function onCharactersChanged() {
    if (!state.cfg) return;
    if (state.draft && state.draft.characterId && !Features.getCharacter(state.draft.characterId)) {
      state.draft.characterId = null;
    }
    renderCharacterPicker();
    updateCharacterLabel();
    renderConvList();
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
    $('set-memory').checked = s.useMemory !== false;
    $('set-memory-field').hidden = !state.cfg.memory.enabled;
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
      useMemory: $('set-memory').checked,
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
      // Inline images from conversations created before uploads existed.
      const imgs = el('div', 'msg-images');
      for (const src of m.images) {
        const img = el('img');
        img.src = src;
        img.alt = '';
        imgs.append(img);
      }
      wrap.append(imgs);
    }
    if (m.attachments && m.attachments.length) {
      const files = el('div', 'msg-files');
      for (const a of m.attachments) files.append(renderSentAttachment(a));
      wrap.append(files);
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
      const ids = (m.attachments || []).map((a) => a.id);
      if (!ta.value.trim() && !ids.length) return;
      runChat({ content: ta.value, attachments: ids, editFromMessageId: m.id });
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
    if (state.attachments.some((a) => a.status === 'uploading')) { toast(t('chat.uploading')); return; }
    const ready = state.attachments.filter((a) => a.status === 'ready');
    if (!content.trim() && !ready.length) return;
    const s = settingsSource();
    if (!s.modelId) { openModelPicker(); return; }

    const model = Models.find(s.providerId, s.modelId);
    if (model && ready.some((a) => a.kind === 'image') && !model.vision) toast(t('chat.noVisionWarning'));
    if (model && ready.some((a) => a.kind === 'video') && !model.video) {
      if (!(await ask(t('chat.noVideoWarning'), { okKey: 'chat.sendAnyway' }))) return;
    }

    if (!state.current) {
      try {
        const c = await Api.post('/api/conversations', state.draft);
        state.current = c;
        upsertSummary(c);
        history.replaceState(null, '', `#/c/${c.id}`);
        renderCharacterPicker();
      } catch (err) { toastError(err); return; }
    }
    const pending = state.attachments;
    $('prompt').value = '';
    autosize();
    state.attachments = [];
    renderAttachments();
    if (!(await runChat({ content, attachments: ready.map((a) => a.id) }))) {
      // Nothing was stored server-side: give the user their text and files back.
      $('prompt').value = content;
      autosize();
      state.attachments = pending;
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
    let finished = false;
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
          finish(); // the answer is complete; a 'memory' event may still follow
        } else if (event === 'memory') {
          const lines = [];
          if (data.added.length) lines.push(t('memory.updated', { facts: data.added.map((m) => m.text).join(' · ') }));
          if (data.removed.length) lines.push(t('memory.removed', { facts: data.removed.map((m) => m.text).join(' · ') }));
          if (data.error) lines.push(t('memory.failed', { error: data.error }));
          toast(lines.join('\n'));
        }
      }, controller.signal);
    } catch (err) {
      if (finished) return !!node; // connection closed after the answer was complete
      if (err.name === 'AbortError') assistant.stopped = true;
      else if (!node) toastError(err);
      else assistant.error = errorText(err);
    } finally {
      finish();
    }
    return !!node;

    function finish() {
      if (finished) return;
      finished = true;
      if (frame) cancelAnimationFrame(frame);
      if (state.stream && state.stream.controller === controller) state.stream = null;
      setStreaming(false);
      if (node && state.current === conv) {
        if (!conv.messages.some((m) => m.id === assistant.id)) conv.messages.push(assistant);
        renderMessages();
      }
      $('prompt').focus();
    }
  }

  function stop() {
    if (state.stream) state.stream.controller.abort();
  }

  // ---- Attachments ----------------------------------------------------------

  const KIND_ICONS = { pdf: '📕', docx: '📘', text: '📄', video: '🎬', image: '🖼️' };

  function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  // Classify like the server does (extension first, then MIME type) so that
  // obviously unsupported or oversized files are rejected before uploading.
  function classify(file) {
    const kinds = state.cfg.attachments.kinds;
    const dot = file.name.lastIndexOf('.');
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    for (const [kind, k] of Object.entries(kinds)) if (k.extensions.includes(ext)) return kind;
    for (const [kind, k] of Object.entries(kinds)) if (k.mimeTypes.includes(file.type)) return kind;
    return null;
  }

  function fileChip(tag, a, sub) {
    const chip = el(tag, 'file-chip');
    chip.append(el('span', 'file-icon', KIND_ICONS[a.kind] || KIND_ICONS.text));
    const meta = el('span', 'file-meta');
    const name = el('span', 'file-name', a.name);
    name.title = a.name;
    meta.append(name, el('span', 'file-sub', sub));
    chip.append(meta);
    return chip;
  }

  function attachmentInfo(a) {
    const parts = [formatSize(a.size)];
    if (a.pages) parts.push(t('chat.pages', { n: a.pages }));
    if (a.truncated) parts.push(t('chat.truncated'));
    return parts.join(' · ');
  }

  function renderSentAttachment(a) {
    const url = `/api/uploads/${a.id}`;
    if (a.kind === 'image') {
      const img = el('img');
      img.src = url;
      img.alt = a.name;
      img.loading = 'lazy';
      return img;
    }
    if (a.kind === 'video') {
      const v = el('video');
      v.src = url;
      v.controls = true;
      v.preload = 'metadata';
      return v;
    }
    const link = fileChip('a', a, attachmentInfo(a));
    link.href = url;
    link.download = a.name;
    link.title = t('chat.download');
    return link;
  }

  function renderAttachments() {
    const box = $('attachments');
    box.innerHTML = '';
    box.hidden = !state.attachments.length;
    for (const a of state.attachments) {
      const wrap = el('div', `attachment ${a.status === 'uploading' ? 'uploading' : ''} ${a.status === 'error' ? 'failed' : ''}`);
      let preview;
      if (a.kind === 'image' && a.preview) {
        preview = el('img');
        preview.src = a.preview;
        preview.alt = a.name;
      } else if (a.kind === 'video' && a.preview) {
        preview = el('video');
        preview.src = a.preview;
        preview.muted = true;
      } else {
        const sub = a.status === 'uploading' ? t('chat.uploading') : a.status === 'error' ? a.error : attachmentInfo(a);
        preview = fileChip('div', a, sub);
      }
      preview.title = a.status === 'error' ? a.error : a.name;
      const rm = el('button', null, '×');
      rm.type = 'button';
      rm.title = t('chat.removeFile');
      rm.addEventListener('click', () => removeAttachment(a));
      wrap.append(preview, rm);
      box.append(wrap);
    }
  }

  function removeAttachment(a) {
    state.attachments = state.attachments.filter((x) => x !== a);
    if (a.preview) URL.revokeObjectURL(a.preview);
    if (a.id) Api.del(`/api/uploads/${a.id}`).catch(() => {});
    renderAttachments();
  }

  function addFiles(files) {
    const cfg = state.cfg.attachments;
    for (const f of files) {
      if (state.attachments.length >= cfg.maxFilesPerMessage) { toast(t('errors.tooManyFiles')); break; }
      const kind = classify(f);
      if (!kind) { toast(t('errors.unsupportedFile', { provider: f.name })); continue; }
      if (f.size > cfg.kinds[kind].maxBytes) {
        toast(`${t('errors.fileTooLarge')} ${f.name} (${formatSize(f.size)} > ${formatSize(cfg.kinds[kind].maxBytes)})`);
        continue;
      }
      const a = { key: Math.random(), id: null, name: f.name, kind, size: f.size, status: 'uploading' };
      if (kind === 'image' || kind === 'video') a.preview = URL.createObjectURL(f);
      state.attachments.push(a);
      Api.upload(f)
        .then((meta) => Object.assign(a, meta, { status: 'ready' }))
        .catch((err) => Object.assign(a, { status: 'error', error: errorText(err) }))
        .finally(() => {
          if (a.status === 'error') toast(`${a.name}: ${a.error}`);
          renderAttachments();
        });
    }
    renderAttachments();
  }

  function fileAccept() {
    return Object.values(state.cfg.attachments.kinds).flatMap((k) => k.extensions).join(',');
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
    renderCharacterPicker();
    updateCharacterLabel();
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
      Features.init(state.cfg);
      window.addEventListener('hashchange', route);
    }
    await Features.loadCharacters().catch(toastError);
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
    $('file-input').accept = fileAccept();
    $('open-memory').addEventListener('click', () => { closeSidebar(); Features.openMemory(); });
    $('open-characters').addEventListener('click', () => { closeSidebar(); Features.openCharacters(); });
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
      const files = [...(e.clipboardData ? e.clipboardData.files : [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const main = document.querySelector('.main');
    main.addEventListener('dragover', (e) => e.preventDefault());
    main.addEventListener('drop', (e) => {
      e.preventDefault();
      addFiles([...e.dataTransfer.files]);
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

  return { toast, toastError, el, iconButton, ask, onCharactersChanged };
})();
