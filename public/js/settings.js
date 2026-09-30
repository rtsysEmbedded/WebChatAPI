'use strict';

// Settings panel. The form is generated from the schema the server sends
// (config.settingsPanel in config.json); labels come from ui.panel.* in the
// language files. Nothing about the individual fields is hardcoded here.
window.Settings = (() => {
  const { t } = window.I18n;
  const $ = (id) => document.getElementById(id);
  let sections = [];
  let values = {};
  let inputs = {}; // field id -> () => value

  function label(key, fallback) {
    const s = t(key);
    return s === key ? fallback : s;
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

  function fieldRow(field) {
    const value = values[field.id];
    const title = label(`panel.fields.${field.id}`, field.id);
    const hintKey = `panel.hints.${field.id}`;
    let row;

    if (field.type === 'boolean') {
      row = App.el('label', 'row gap check');
      const cb = App.el('input');
      cb.type = 'checkbox';
      cb.checked = !!value;
      row.append(cb, App.el('span', null, title));
      inputs[field.id] = () => cb.checked;
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
      } else {
        input = App.el('textarea', 'input');
        input.rows = 4;
        input.dir = 'auto';
        input.maxLength = field.maxLength;
        input.value = value || '';
        inputs[field.id] = () => input.value;
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

  function render() {
    const body = $('panel-body');
    body.innerHTML = '';
    inputs = {};
    for (const sec of sections) {
      const box = App.el('section', 'panel-section');
      box.append(App.el('h4', null, label(`panel.sections.${sec.id}`, sec.id)));
      for (const f of sec.fields) box.append(fieldRow(f));
      body.append(box);
    }
  }

  async function save(e) {
    e.preventDefault();
    const patch = {};
    for (const [id, get] of Object.entries(inputs)) patch[id] = get();
    try {
      ({ sections, values } = await Api.patch('/api/settings', patch));
      $('panel-dialog').close();
      App.toast(t('panel.saved'));
      await App.reloadConfig();
    } catch (err) {
      if (err.code === 'invalidSetting') App.toast(t('errors.invalidSetting', { provider: label(`panel.fields.${err.detail}`, err.detail) }));
      else App.toastError(err);
    }
  }

  async function reset() {
    if (!(await App.ask(t('panel.resetConfirm'), { okKey: 'panel.reset', danger: true }))) return;
    try {
      ({ sections, values } = await Api.del('/api/settings'));
      render();
      App.toast(t('panel.saved'));
      await App.reloadConfig();
    } catch (err) { App.toastError(err); }
  }

  return { init, open };
})();
