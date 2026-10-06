'use strict';

// Runtime settings edited in the UI's settings panel.
//
// config/config.json holds the defaults (in git). Changes made in the panel are
// stored as overrides { "<key>": value } in <dataDir>/<settingsPanel.file> and
// applied to the in-memory config at startup and on every save, so they take
// effect without a restart. Only fields declared in config.settingsPanel can be
// changed: the static `sections`, plus `providerFields` repeated for every
// enabled provider.
//
// Override keys are config paths, except for provider fields, which use the
// provider id instead of its array index: "providers.<id>.<field>". Provider API
// keys are not overrides; they are written to the secrets file (see config.js)
// and are never returned to the browser.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { config, log, saveProviderKey } = require('./config');
const { getProvider, providers } = require('./providers');

const S = config.settingsPanel;
let file = null;
let secrets = null;
let overrides = {};
let defaults = {}; // key -> value from config.json, captured before overrides
const listeners = [];

function providerFields() {
  return providers.flatMap((p) =>
    S.providerFields.map((f) => ({
      ...f,
      id: `provider.${p.id}.${f.id}`,
      path: `providers.${p.id}.${f.id}`,
      providerId: p.id,
      labelKey: `provider.${f.id}`,
      section: `provider.${p.id}`,
    })),
  );
}

const fields = [
  ...S.sections.flatMap((sec) => sec.fields.map((f) => ({ ...f, section: sec.id }))),
  ...providerFields(),
];

// Resolve an override key to a path inside the config object.
function configPath(key) {
  const m = /^providers\.([^.]+)\.(.+)$/.exec(key);
  if (!m) return key;
  return `providers.${config.providers.findIndex((p) => p.id === m[1])}.${m[2]}`;
}

function cfgGet(key) {
  return configPath(key)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), config);
}

// Assign the leaf on the existing object, so modules holding references to
// nested config objects see the new value.
function cfgSet(key, value) {
  const keys = configPath(key).split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], config)[last] = value;
}

function keysOf(field) {
  if (field.type === 'secret') return [];
  return field.type === 'model' ? [field.providerPath, field.modelPath] : [field.path];
}

class SettingError extends Error {
  constructor(fieldId) {
    super(fieldId);
    this.fieldId = fieldId;
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const KEY_RE = /^[\x21-\x7E]+$/;

// Validate a value for a field; returns { key: value } pairs to apply.
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
      if (field.nullable && !value.trim()) return { [field.path]: null };
      if (field.pattern && !new RegExp(field.pattern).test(value)) bad();
      return { [field.path]: value };
    case 'json': {
      if (value === null && field.nullable) return { [field.path]: null };
      const isArray = Array.isArray(value);
      const shapeOk = field.jsonType === 'array' ? isArray : value !== null && typeof value === 'object' && !isArray;
      if (!shapeOk || JSON.stringify(value).length > field.maxLength) bad();
      if (field.valuesType && Object.values(value).some((v) => typeof v !== field.valuesType)) bad();
      return { [field.path]: value };
    }
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
    case 'secret':
      if (value !== null && (typeof value !== 'string' || value.length > field.maxLength || !KEY_RE.test(value))) bad();
      return {};
    default:
      return bad();
  }
}

function valueOf(field) {
  if (field.type === 'model') {
    const providerId = cfgGet(field.providerPath);
    const modelId = cfgGet(field.modelPath);
    return providerId && modelId ? { providerId, modelId } : null;
  }
  if (field.type === 'secret') {
    const key = secrets.providerKeys[field.providerId];
    return { configured: !!key, last4: key && key.length >= 12 ? key.slice(-4) : null };
  }
  return cfgGet(field.path);
}

function values() {
  return Object.fromEntries(fields.map((f) => [f.id, valueOf(f)]));
}

// Static sections plus one section per provider. Provider fields carry their
// config.json default so the form can offer "restore defaults".
function schema() {
  const providerSections = providers.map((p) => ({
    id: `provider.${p.id}`,
    title: p.name,
    providerId: p.id,
    apiKeyEnv: p.apiKeyEnv,
    fields: fields
      .filter((f) => f.providerId === p.id)
      .map((f) => (f.type === 'secret' ? f : { ...f, default: defaults[f.path] })),
  }));
  return [...S.sections, ...providerSections];
}

async function init(dataDir, loadedSecrets) {
  file = path.join(dataDir, S.file);
  secrets = loadedSecrets;
  try {
    overrides = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log('server.log.settingsReadError', { file, error: err.message });
    overrides = {};
  }
  const allowed = new Set(fields.flatMap(keysOf));
  defaults = Object.fromEntries([...allowed].map((k) => [k, structuredClone(cfgGet(k))]));
  for (const [k, v] of Object.entries(overrides)) {
    if (allowed.has(k)) cfgSet(k, v);
    else delete overrides[k]; // field or provider was removed from config
  }
  if (Object.keys(overrides).length) log('server.log.settingsLoaded', { file, count: Object.keys(overrides).length });
}

function onChange(fn) {
  listeners.push(fn);
}

// The key from the secrets file, or, when it is removed, the environment variable.
function fallbackKey(providerId) {
  const p = providers.find((x) => x.id === providerId);
  return (p && process.env[p.apiKeyEnv]) || null;
}

// patch: { fieldId: value }. All values are validated before any is applied.
async function update(patch) {
  const changes = {};
  const keyChanges = {};
  for (const [id, value] of Object.entries(patch)) {
    const field = fields.find((f) => f.id === id);
    if (!field) throw new SettingError(id);
    const result = validate(field, value);
    if (field.type === 'secret') keyChanges[field.providerId] = value;
    else Object.assign(changes, result);
  }
  // Secrets file first: if it cannot be written, nothing else is applied.
  for (const [providerId, key] of Object.entries(keyChanges)) saveProviderKey(providerId, key);
  const changed = Object.keys(changes).filter((k) => !sameValue(cfgGet(k), changes[k]));
  for (const k of changed) {
    cfgSet(k, changes[k]);
    overrides[k] = changes[k];
  }
  for (const [providerId, key] of Object.entries(keyChanges)) {
    secrets.providerKeys[providerId] = key || fallbackKey(providerId);
    changed.push(`providers.${providerId}.apiKey`);
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

// Restore the config.json defaults and drop all overrides. Provider API keys
// are secrets, not settings, and are left untouched.
async function reset() {
  const changed = Object.keys(overrides);
  for (const k of changed) cfgSet(k, structuredClone(defaults[k]));
  overrides = {};
  await fsp.rm(file, { force: true });
  for (const fn of listeners) fn(changed);
  return values();
}

module.exports = { init, values, update, reset, onChange, schema, SettingError, fields };
