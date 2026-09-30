'use strict';

// Memory manager and character editor dialogs. Uses helpers exposed by App.
window.Features = (() => {
  const { t } = window.I18n;
  const $ = (id) => document.getElementById(id);
  let cfg = null;
  let memoryItems = [];
  let archiveItems = [];
  let archiveStatus = null;
  let activeTab = 'facts';
  let searchTimer = null;
  let characters = [];
  let editing = null; // character being edited (null = new)
  let editModel = null; // { providerId, modelId } chosen in the editor

  const ICONS = {
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  };

  function init(publicConfig) {
    cfg = publicConfig;
    $('memory-form').addEventListener('submit', addMemory);
    $('memory-clear').addEventListener('click', () => (activeTab === 'facts' ? clearMemory() : clearArchive()));
    document.querySelectorAll('.memory-tabs .tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('archive-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadArchive, cfg.ui.searchDebounceMs);
    });
    document.querySelector('.memory-tabs [data-tab="archive"]').hidden = !cfg.memory.archive.enabled;
    $('character-new').addEventListener('click', () => openEditor(null));
    $('character-form').addEventListener('submit', saveCharacter);
    $('ch-model-choose').addEventListener('click', () => {
      Models.open(editModel, (sel) => { editModel = sel; renderEditorModel(); });
    });
    $('ch-model-clear').addEventListener('click', () => { editModel = null; renderEditorModel(); });
    const temp = $('ch-temp');
    temp.min = cfg.chat.temperatureMin;
    temp.max = cfg.chat.temperatureMax;
    temp.step = cfg.chat.temperatureStep;
  }

  // ---- Memory -------------------------------------------------------------

  async function openMemory() {
    const hint = [t('memory.hint')];
    if (cfg.memory.autoExtract) hint.push(t('memory.autoHint'));
    if (!cfg.memory.enabled) hint.unshift(t('memory.disabled'));
    $('memory-hint').textContent = hint.join(' ');
    $('memory-input').maxLength = cfg.memory.maxItemChars;
    $('memory-dialog').showModal();
    await showTab(activeTab);
  }

  async function showTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.memory-tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.memory-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    if (tab === 'facts') await loadMemory();
    else await loadArchive();
  }

  // ---- Archive (saved conversation summaries) -----------------------------

  async function loadArchive() {
    const q = $('archive-search').value.trim();
    try {
      const res = await Api.get(`/api/memory/archive${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      archiveItems = res.items;
      archiveStatus = res.status;
    } catch (err) { App.toastError(err); }
    renderArchive();
  }

  function renderArchive() {
    const list = $('archive-list');
    list.innerHTML = '';
    if (archiveStatus) {
      $('archive-status').textContent = t('memory.archiveCount', {
        count: archiveStatus.count,
        mode: t(archiveStatus.mode === 'hybrid' ? 'memory.modeHybrid' : 'memory.modeKeyword'),
      });
    }
    $('memory-clear').hidden = !(archiveStatus && archiveStatus.count);
    if (!archiveItems.length) {
      list.append(App.el('div', 'notice', t(archiveStatus && archiveStatus.count ? 'models.noResults' : 'memory.archiveEmpty')));
      return;
    }
    for (const a of archiveItems) {
      const row = App.el('div', 'item');
      const body = App.el('div', 'item-body');
      const title = App.el('div', 'item-title', a.title);
      title.dir = 'auto';
      const subParts = [new Date(a.updatedAt).toLocaleDateString(I18n.meta.locale)];
      if (a.via && a.via.length) subParts.push(t('memory.matchedBy', { via: a.via.map((v) => t(`memory.${v}`)).join(' + ') }));
      const sub = App.el('div', 'item-sub', subParts.join(' · '));
      const snippet = App.el('div', 'archive-snippet', a.text.replace(/[#*_`>-]+/g, ' ').replace(/\s+/g, ' ').trim());
      snippet.dir = 'auto';
      const full = App.el('div', 'archive-body md');
      full.dir = 'auto';
      full.hidden = true;
      body.append(title, sub, snippet, full);
      const toggle = App.el('button', 'btn ghost small', t('memory.show'));
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        const open = full.hidden;
        if (open && !full.childNodes.length) Render.markdown(full, a.text, true);
        full.hidden = !open;
        snippet.hidden = open;
        toggle.textContent = t(open ? 'memory.hide' : 'memory.show');
      });
      const actions = App.el('div', 'item-actions');
      actions.append(
        toggle,
        App.iconButton(ICONS.trash, 'memory.delete', async () => {
          if (!(await App.ask(t('memory.archiveDeleteConfirm', { title: a.title }), { okKey: 'memory.delete', danger: true }))) return;
          try {
            await Api.del(`/api/memory/archive/${a.id}`);
            await loadArchive();
          } catch (err) { App.toastError(err); }
        }),
      );
      row.append(body, actions);
      list.append(row);
    }
  }

  async function clearArchive() {
    const count = archiveStatus ? archiveStatus.count : 0;
    if (!(await App.ask(t('memory.archiveClearConfirm', { count }), { okKey: 'memory.clearAll', danger: true }))) return;
    try {
      await Api.del('/api/memory/archive');
      await loadArchive();
    } catch (err) { App.toastError(err); }
  }

  async function loadMemory() {
    try {
      memoryItems = (await Api.get('/api/memory')).items;
    } catch (err) { App.toastError(err); }
    renderMemory();
  }

  function renderMemory() {
    const list = $('memory-list');
    list.innerHTML = '';
    $('memory-clear').hidden = !memoryItems.length;
    if (!memoryItems.length) {
      list.append(App.el('div', 'notice', t('memory.empty')));
      return;
    }
    for (const m of memoryItems.slice().reverse()) {
      const row = App.el('div', 'item');
      const body = App.el('div', 'item-body');
      const text = App.el('div', null, m.text);
      text.dir = 'auto';
      const sub = App.el('div', 'item-sub', `${t(`memory.${m.source === 'auto' ? 'auto' : 'manual'}`)} · ${new Date(m.createdAt).toLocaleDateString(I18n.meta.locale)}`);
      body.append(text, sub);
      const actions = App.el('div', 'item-actions');
      actions.append(
        App.iconButton(ICONS.edit, 'memory.edit', async () => {
          const value = await App.ask(t('memory.editPrompt'), { input: true, value: m.text });
          if (value == null || !value.trim() || value.trim() === m.text) return;
          try {
            await Api.patch(`/api/memory/${m.id}`, { text: value.trim() });
            await loadMemory();
          } catch (err) { App.toastError(err); }
        }),
        App.iconButton(ICONS.trash, 'memory.delete', async () => {
          try {
            await Api.del(`/api/memory/${m.id}`);
            await loadMemory();
          } catch (err) { App.toastError(err); }
        }),
      );
      row.append(body, actions);
      list.append(row);
    }
  }

  async function addMemory(e) {
    e.preventDefault();
    const input = $('memory-input');
    const text = input.value.trim();
    if (!text) return;
    try {
      await Api.post('/api/memory', { text });
      input.value = '';
      await loadMemory();
    } catch (err) { App.toastError(err); }
  }

  async function clearMemory() {
    const ok = await App.ask(t('memory.clearConfirm', { count: memoryItems.length }), { okKey: 'memory.clearAll', danger: true });
    if (!ok) return;
    try {
      await Api.del('/api/memory');
      await loadMemory();
    } catch (err) { App.toastError(err); }
  }

  // ---- Characters ---------------------------------------------------------

  async function loadCharacters() {
    characters = (await Api.get('/api/characters')).items;
    App.onCharactersChanged();
    return characters;
  }

  function getCharacter(id) {
    return characters.find((c) => c.id === id) || null;
  }

  async function openCharacters() {
    $('characters-dialog').showModal();
    try { await loadCharacters(); } catch (err) { App.toastError(err); }
    renderCharacters();
  }

  function renderCharacters() {
    const list = $('characters-list');
    list.innerHTML = '';
    if (!characters.length) {
      list.append(App.el('div', 'notice', t('characters.empty')));
      return;
    }
    for (const c of characters) {
      const row = App.el('div', 'item');
      const avatar = App.el('div', 'item-avatar', c.avatar);
      const body = App.el('div', 'item-body');
      const name = App.el('div', 'item-title', c.name);
      name.dir = 'auto';
      body.append(name);
      const subParts = [c.description, c.modelId].filter(Boolean);
      if (subParts.length) {
        const sub = App.el('div', 'item-sub', subParts.join(' · '));
        sub.dir = 'auto';
        body.append(sub);
      }
      const actions = App.el('div', 'item-actions');
      actions.append(
        App.iconButton(ICONS.edit, 'characters.edit', () => openEditor(c)),
        App.iconButton(ICONS.trash, 'characters.delete', async () => {
          if (!(await App.ask(t('characters.deleteConfirm', { name: c.name }), { okKey: 'characters.delete', danger: true }))) return;
          try {
            await Api.del(`/api/characters/${c.id}`);
            await loadCharacters();
            renderCharacters();
          } catch (err) { App.toastError(err); }
        }),
      );
      row.append(avatar, body, actions);
      list.append(row);
    }
  }

  function renderEditorModel() {
    const label = $('ch-model-label');
    if (!editModel) {
      label.textContent = t('characters.modelNone');
      $('ch-model-clear').hidden = true;
      return;
    }
    const m = Models.find(editModel.providerId, editModel.modelId);
    label.textContent = `${Models.providerName(editModel.providerId)} · ${m ? m.name : editModel.modelId}`;
    $('ch-model-clear').hidden = false;
  }

  function openEditor(c) {
    editing = c;
    const ch = cfg.characters;
    $('character-form-title').textContent = t(c ? 'characters.editTitle' : 'characters.newTitle');
    $('ch-avatar').maxLength = ch.avatarMaxLength;
    $('ch-name').maxLength = ch.nameMaxLength;
    $('ch-description').maxLength = ch.descriptionMaxLength;
    $('ch-avatar').value = c ? c.avatar : ch.defaultAvatar;
    $('ch-name').value = c ? c.name : '';
    $('ch-description').value = c ? c.description : '';
    $('ch-system').value = c ? c.systemPrompt : '';
    $('ch-temp').value = c && c.temperature != null ? c.temperature : '';
    $('ch-memory').checked = c ? c.useMemory !== false : cfg.memory.defaultOnForNewChats;
    $('ch-memory').closest('label').hidden = !cfg.memory.enabled;
    editModel = c && c.modelId ? { providerId: c.providerId, modelId: c.modelId } : null;
    renderEditorModel();
    $('character-dialog').showModal();
    $('ch-name').focus();
  }

  async function saveCharacter(e) {
    e.preventDefault();
    const tempRaw = $('ch-temp').value.trim();
    const temp = tempRaw === '' ? null : parseFloat(tempRaw);
    const body = {
      name: $('ch-name').value,
      avatar: $('ch-avatar').value,
      description: $('ch-description').value,
      systemPrompt: $('ch-system').value,
      temperature: Number.isFinite(temp) ? temp : null,
      useMemory: $('ch-memory').checked,
      providerId: editModel ? editModel.providerId : null,
      modelId: editModel ? editModel.modelId : null,
    };
    try {
      if (editing) await Api.patch(`/api/characters/${editing.id}`, body);
      else await Api.post('/api/characters', body);
      $('character-dialog').close();
      await loadCharacters();
      renderCharacters();
    } catch (err) { App.toastError(err); }
  }

  return {
    init,
    openMemory,
    openCharacters,
    loadCharacters,
    getCharacter,
    get characters() { return characters; },
  };
})();
