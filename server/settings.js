'use strict';

// Runtime settings edited in the UI's settings panel.
//
// config/config.json holds the defaults (in git). Changes made in the panel are
// stored as overrides { "<config.path>": value } in <dataDir>/<settingsPanel.file>
// and applied to the in-memory config at startup and on every save, so they
// take effect without a restart. Only fields declared in
// config.settingsPanel.sections can be changed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config, log } = require('./config');
const { getProvider } = require('./providers');

const S = config.settingsPanel;
let file = null;
let overrides = {};
let defaults = {}; // path -> value from config.json, captured before overrides
const listeners = [];

const fields = S.sections.flatMap((sec) => sec.fields.map((f) => ({ ...f, section: sec.id })));

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Assign the leaf on the existing object, so modules holding references to
// nested config objects see the new value.
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function paths(field) {
  return field.type === 'model' ? [field.providerPath, field.modelPath] : [field.path];
}

class SettingError extends Error {
  constructor(fieldId) {
    super(fieldId);
    this.fieldId = fieldId;
  }
}

// Validate a value for a field; returns { path: value } pairs to apply.
function validate(field, value) {
  const bad = () => {
    throw new SettingError(field.id);
  };
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') bad();
      return { [field.path]: value };
    case 'number':
      if (value === null && field.nullable) return { [field.path]: null };
      if (typeof value !== 'number' || !Number.isFinite(value)) bad();
      if (value < field.min || value > field.max) bad();
      if (field.integer && !Number.isInteger(value)) bad();
      return { [field.path]: value };
    case 'text':
      if (typeof value !== 'string' || value.length > field.maxLength) bad();
      return { [field.path]: value };
    case 'select':
      if (!field.options.includes(value)) bad();
      return { [field.path]: value };
    case 'model':
      if (value === null) {
        if (!field.allowNone) bad();
        return { [field.providerPath]: null, [field.modelPath]: null };
      }
      if (!value || typeof value.providerId !== 'string' || typeof value.modelId !== 'string' || !value.modelId) bad();
      if (!getProvider(value.providerId)) bad();
      return { [field.providerPath]: value.providerId, [field.modelPath]: value.modelId.slice(0, 300) };
    default:
      return bad();
  }
}

function valueOf(field) {
  if (field.type === 'model') {
    const providerId = getPath(config, field.providerPath);
    const modelId = getPath(config, field.modelPath);
    return providerId && modelId ? { providerId, modelId } : null;
  }
  return getPath(config, field.path);
}

function values() {
  return Object.fromEntries(fields.map((f) => [f.id, valueOf(f)]));
}

function allowedPaths() {
  return new Set(fields.flatMap(paths));
}

async function init(dataDir) {
  file = path.join(dataDir, S.file);
  try {
    overrides = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log('server.log.settingsReadError', { file, error: err.message });
    overrides = {};
  }
  const allowed = allowedPaths();
  defaults = Object.fromEntries([...allowed].map((p) => [p, getPath(config, p)]));
  for (const [p, v] of Object.entries(overrides)) {
    if (allowed.has(p)) setPath(config, p, v);
    else delete overrides[p]; // field was removed from the schema
  }
  if (Object.keys(overrides).length) log('server.log.settingsLoaded', { file, count: Object.keys(overrides).length });
}

function onChange(fn) {
  listeners.push(fn);
}

// patch: { fieldId: value }. All values are validated before any is applied.
async function update(patch) {
  const changes = {};
  for (const [id, value] of Object.entries(patch)) {
    const field = fields.find((f) => f.id === id);
    if (!field) throw new SettingError(id);
    Object.assign(changes, validate(field, value));
  }
  const changed = Object.keys(changes).filter((p) => getPath(config, p) !== changes[p]);
  for (const p of changed) {
    setPath(config, p, changes[p]);
    overrides[p] = changes[p];
  }
  await persist();
  for (const fn of listeners) fn(changed);
  return values();
}

async function persist() {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(overrides, null, 2) + '\n');
  await fsp.rename(tmp, file);
}

// Restore the config.json defaults and drop all overrides.
async function reset() {
  const changed = Object.keys(overrides);
  for (const p of changed) setPath(config, p, defaults[p]);
  overrides = {};
  await fsp.rm(file, { force: true });
  for (const fn of listeners) fn(changed);
  return values();
}

module.exports = { init, values, update, reset, onChange, schema: () => S.sections, SettingError, fields };
