'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'config.json');
const I18N_DIR = path.join(ROOT, 'config', 'i18n');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

const config = readJson(CONFIG_FILE);
// Prompt text sent to models (memory block, extraction instruction, file wrapper).
const prompts = readJson(resolvePath(config.prompts.file));

const i18n = {};
for (const lang of config.app.languages) {
  i18n[lang] = readJson(path.join(I18N_DIR, `${lang}.json`));
}

function lookup(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// Server-side translation (log lines and error messages). Falls back to the
// default language, then to the key itself so a missing string is visible.
function t(key, vars = {}, lang = config.app.serverLogLanguage) {
  let s = lookup(i18n[lang], key);
  if (s === undefined) s = lookup(i18n[config.app.defaultLanguage], key);
  if (s === undefined) return key;
  return String(s).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

function log(key, vars) {
  console.log(`[${new Date().toISOString()}] ${t(key, vars)}`);
}

// Load the .env file (path from config.secrets.envFile) into process.env.
// Variables already set in the real environment take precedence; a missing
// file is not an error. Runs at require time, before anything reads process.env.
function loadEnvFile() {
  if (!config.secrets.envFile) return;
  const file = resolvePath(config.secrets.envFile);
  if (typeof process.loadEnvFile !== 'function') {
    if (fs.existsSync(file)) log('server.log.envUnsupported', { file });
    return;
  }
  try {
    process.loadEnvFile(file);
    log('server.log.envLoaded', { file });
  } catch (err) {
    if (err.code !== 'ENOENT') log('server.log.envReadError', { file, error: err.message });
  }
}
loadEnvFile();

const secretsFile = resolvePath(process.env[config.secrets.fileEnv] || config.secrets.file);

function loadSecretsFile() {
  try {
    return readJson(secretsFile);
  } catch (err) {
    if (err.code !== 'ENOENT') log('server.log.secretsReadError', { file: secretsFile, error: err.message });
    return {};
  }
}

function saveSecretsFile(data) {
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// Secrets are resolved in this order: environment variable, then secrets file.
// Environment variables are the natural fit for free PaaS hosts.
function loadSecrets() {
  const file = loadSecretsFile();
  const env = config.secrets.env;
  const s = {
    pin: process.env[env.pin] || null,
    pinHash: process.env[env.pinHash] || file.pinHash || null,
    sessionSecret: process.env[env.sessionSecret] || file.sessionSecret || null,
    providerKeys: {},
  };
  for (const p of config.providers) {
    s.providerKeys[p.id] =
      process.env[p.apiKeyEnv] || (file.providers && file.providers[p.id] && file.providers[p.id].apiKey) || null;
  }
  if (!s.sessionSecret && config.secrets.autoGenerateSessionSecret) {
    s.sessionSecret = crypto.randomBytes(32).toString('hex');
    try {
      saveSecretsFile({ ...file, sessionSecret: s.sessionSecret });
      log('server.log.sessionSecretGenerated', { file: secretsFile });
    } catch (err) {
      log('server.log.sessionSecretEphemeral', { error: err.message });
    }
  }
  return s;
}

// Fill {name} placeholders in a template string.
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

module.exports = {
  ROOT,
  config,
  prompts,
  fill,
  i18n,
  t,
  log,
  resolvePath,
  secretsFile,
  loadSecretsFile,
  saveSecretsFile,
  loadSecrets,
};
