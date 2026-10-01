'use strict';

// Settings panel. The form is generated from the schema the server sends
// (config.settingsPanel in config.json, plus one section per provider); labels
// come from ui.panel.* in the language files. Nothing about the individual
// fields is hardcoded here.
window.Settings = (() => {
  const { t } = window.I18n;
  const $ = (id) => document.getElementById(id);
  let sections = [];
  let values = {};
  let inputs = {}; // field id -> () => value to send (undefined = unchanged)
  let setters = {}; // field id -> (value) => void, used to fill defaults
  const openAdvanced = new Set(); // provider section ids whose "Advanced" is expanded

  function label(key, fallback) {
    const s = t(key);
    return s === key ? fallback : s;
  }

  function fieldLabel(field) {
    return label(`panel.fields.${field.labelKey || field.id}`, field.id);
  }

  function findField(id) {
    for (const sec of sections) {
      const f = sec.fields.find((x) => x.id === id);
      if (f) return { field: f, section: sec };
    }
    return null;
  }

  // Provider fields are shown with their provider's name, since the same label
  // exists once per provider.
  function describeField(id) {
    const hit = findField(id);
    if (!hit) return id;
    return hit.section.providerId ? `${hit.section.title} · ${fieldLabel(hit.field)}` : fieldLabel(hit.field);
  }

  function init() {
    $('panel-form').addEventListener('submit', save);
    $('panel-reset').addEventListener('click', reset);
  }

  async function open() {
    try {
      ({ sections, values } = await Api.get('/api/settings'));
    } catch (err) {
      App.toastError(err);
      return;
    }
    // Model names are shown from the catalogues; load them if needed.
    if (!Models.groups.length) await Models.load().catch(() => {});
    render();
    $('panel-dialog').showModal();
  }

  function modelLabel(field, value) {
    if (!value) return t(`panel.none.${field.id}`);
    const m = Models.find(value.providerId, value.modelId, field.kind);
    return `${Models.providerName(value.providerId)} · ${m ? m.name : value.modelId}`;
  }

  function secretRow(field, title) {
    const value = values[field.id];
    const row = App.el('div', 'field');
    row.append(App.el('span', null, title));
    const input = App.el('input', 'input');
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.spellcheck = false;
    input.maxLength = field.maxLength;
    input.placeholder = t('panel.keyPlaceholder');
    const status = App.el('span', 'field-hint');
    const remove = App.el('button', 'btn ghost small', t('panel.keyRemove'));
    remove.type = 'button';
    let removed = false;
    const refresh = () => {
      if (removed) status.textContent = t('panel.keyRemoved');
      else if (value && value.configured) status.textContent = value.last4 ? t('panel.keySet', { last4: value.last4 }) : t('panel.keySetHidden');
      else status.textContent = t('panel.keyNotSet');
      remove.hidden = removed || !(value && value.configured);
    };
    input.addEventListener('input', () => {
      if (input.value) removed = false;
      refresh();
    });
    remove.addEventListener('click', () => {
      removed = true;
      input.value = '';
      refresh();
    });
    refresh();
    const line = App.el('div', 'model-field');
    line.append(input, remove);
    row.append(line, status);
    inputs[field.id] = () => (input.value.trim() ? input.value.trim() : removed ? null : undefined);
    return row;
  }

  function fieldRow(field) {
    const value = values[field.id];
    const title = fieldLabel(field);
    const hintKey = `panel.hints.${field.labelKey || field.id}`;
    let row;

    if (field.type === 'secret') {
      row = secretRow(field, title);
    } else if (field.type === 'boolean') {
      row = App.el('label', 'row gap check');
      const cb = App.el('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      row.append(cb, App.el('span', null, title));
      inputs[field.id] = () => cb.checked;
      setters[field.id] = (v) => { cb.checked = !!v; };
    } else if (field.type === 'model') {
      row = App.el('div', 'field');
      row.append(App.el('span', null, title));
      let current = value;
      const box = App.el('div', 'model-field');
      const shown = App.el('span', 'model-value');
      const choose = App.el('button', 'btn small', t('panel.choose'));
      choose.type = 'button';
      const none = App.el('button', 'btn ghost small', t('panel.clear'));
      none.type = 'button';
      none.hidden = !field.allowNone;
      const refresh = () => { shown.textContent = modelLabel(field, current); };
      choose.addEventListener('click', () => {
        Models.open(current, (sel) => { current = sel; refresh(); }, { kind: field.kind });
      });
      none.addEventListener('click', () => { current = null; refresh(); });
      refresh();
      box.append(shown, choose, none);
      row.append(box);
      inputs[field.id] = () => current;
    } else {
      row = App.el('label', 'field');
      row.append(App.el('span', null, title));
      let input;
      if (field.type === 'select') {
        input = App.el('select', 'input');
        for (const opt of field.options) {
          const o = App.el('option', null, label(`panel.options.${field.id}.${opt}`, opt));
          o.value = opt;
          input.append(o);
        }
        input.value = value;
        inputs[field.id] = () => input.value;
        setters[field.id] = (v) => { input.value = v; };
      } else if (field.type === 'number') {
        input = App.el('input', 'input');
        input.type = 'number';
        input.min = field.min;
        input.max = field.max;
        input.step = field.step;
        input.value = value == null ? '' : value;
        inputs[field.id] = () => {
          if (input.value.trim() === '' && field.nullable) return null;
          const n = Number(input.value);
          return Number.isFinite(n) ? n : NaN;
        };
        setters[field.id] = (v) => { input.value = v == null ? '' : v; };
      } else if (field.type === 'json') {
        input = App.el('textarea', 'input mono');
        input.rows = 4;
        input.dir = 'ltr';
        input.spellcheck = false;
        const show = (v) => (v === null || v === undefined ? '' : JSON.stringify(v, null, 2));
        input.value = show(value);
        inputs[field.id] = () => {
          const text = input.value.trim();
          if (!text) {
            if (field.nullable) return null;
            throw new SyntaxError(field.id);
          }
          return JSON.parse(text);
        };
        setters[field.id] = (v) => { input.value = show(v); };
      } else if (field.lines === 1) {
        input = App.el('input', 'input');
        input.type = 'text';
        input.dir = 'ltr';
        input.spellcheck = false;
        input.maxLength = field.maxLength;
        input.value = value || '';
        inputs[field.id] = () => input.value;
        setters[field.id] = (v) => { input.value = v || ''; };
      } else {
        input = App.el('textarea', 'input');
        input.rows = 4;
        input.dir = 'auto';
        input.maxLength = field.maxLength;
        input.value = value || '';
        inputs[field.id] = () => input.value;
        setters[field.id] = (v) => { input.value = v || ''; };
      }
      row.append(input);
    }

    const hint = t(hintKey);
    if (hint !== hintKey) {
      const wrap = App.el('div', 'field');
      wrap.append(row, App.el('span', 'field-hint', hint));
      return wrap;
    }
    return row;
  }

  function providerActions(sec) {
    const bar = App.el('div', 'model-field');
    const defaults = App.el('button', 'btn ghost small', t('panel.providerDefaults'));
    defaults.type = 'button';
    defaults.addEventListener('click', () => {
      for (const f of sec.fields) if (f.type !== 'secret' && setters[f.id]) setters[f.id](f.default);
    });
    const test = App.el('button', 'btn small', t('panel.testConnection'));
    test.type = 'button';
    test.addEventListener('click', () => testProvider(sec, test));
    bar.append(test, defaults);
    return bar;
  }

  function render() {
    const body = $('panel-body');
    body.innerHTML = '';
    inputs = {};
    setters = {};
    for (const sec of sections) {
      const box = App.el('section', 'panel-section');
      box.append(App.el('h4', null, sec.title || label(`panel.sections.${sec.id}`, sec.id)));
      if (sec.providerId) {
        box.append(App.el('span', 'field-hint', t('panel.providerFields.note')));
        if (sec.apiKeyEnv) box.append(App.el('span', 'field-hint', t('panel.keyEnvHint', { env: sec.apiKeyEnv })));
      }
      const advanced = App.el('details', 'panel-advanced');
      advanced.append(App.el('summary', null, t('panel.advanced')));
      advanced.open = openAdvanced.has(sec.id);
      advanced.addEventListener('toggle', () => {
        if (advanced.open) openAdvanced.add(sec.id);
        else openAdvanced.delete(sec.id);
      });
      let hasAdvanced = false;
      for (const f of sec.fields) {
        if (f.advanced) {
          advanced.append(fieldRow(f));
          hasAdvanced = true;
        } else {
          box.append(fieldRow(f));
        }
      }
      if (hasAdvanced) box.append(advanced);
      if (sec.providerId) box.append(providerActions(sec));
      body.append(box);
    }
  }

  // Collect the form into a patch. Throws { code: 'invalidJson', fieldId }.
  function collect() {
    const patch = {};
    for (const [id, get] of Object.entries(inputs)) {
      let v;
      try {
        v = get();
      } catch {
        throw { code: 'invalidJson', fieldId: id };
      }
      if (v !== undefined) patch[id] = v;
    }
    return patch;
  }

  function reportError(err) {
    if (err.code === 'invalidJson') App.toast(t('panel.invalidJson', { field: describeField(err.fieldId) }));
    else if (err.code === 'invalidSetting') App.toast(t('errors.invalidSetting', { provider: describeField(err.detail) }));
    else App.toastError(err);
  }

  async function persist() {
    ({ sections, values } = await Api.patch('/api/settings', collect()));
    await App.reloadConfig();
    await Models.load(true).catch(() => {});
  }

  async function save(e) {
    e.preventDefault();
    try {
      await persist();
      $('panel-dialog').close();
      App.toast(t('panel.saved'));
    } catch (err) { reportError(err); }
  }

  async function testProvider(sec, button) {
    button.disabled = true;
    const body = $('panel-body');
    const scroll = body.scrollTop;
    try {
      await persist();
      render();
      body.scrollTop = scroll;
      const res = await Api.post(`/api/providers/${encodeURIComponent(sec.providerId)}/test`, {});
      App.toast(res.ok ? t('panel.testOk', { count: res.count }) : t('panel.testFail', { error: res.error }));
    } catch (err) {
      reportError(err);
    } finally {
      button.disabled = false;
    }
  }

  async function reset() {
    if (!(await App.ask(t('panel.resetConfirm'), { okKey: 'panel.reset', danger: true }))) return;
    try {
      ({ sections, values } = await Api.del('/api/settings'));
      render();
      App.toast(t('panel.saved'));
      await App.reloadConfig();
      await Models.load(true).catch(() => {});
    } catch (err) { App.toastError(err); }
  }

  return { init, open };
})();
