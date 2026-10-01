'use strict';

// Offline sanity checks: config/i18n consistency, PIN hashing, session
// tokens, model normalisation and SSE parsing. Run with: npm run check

const assert = require('assert');
const { config, i18n } = require('../config');
const auth = require('../auth');
const { normalizeModel, sseJson, passesFilter } = require('../providers');
const { classify } = require('../features');
const { prompts, fill } = require('../config');

function keys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

async function main() {
  // Every language must define the same keys as the default language.
  const base = new Set(keys({ ui: i18n[config.app.defaultLanguage].ui, server: i18n[config.app.defaultLanguage].server }));
  for (const [lang, data] of Object.entries(i18n)) {
    const own = new Set(keys({ ui: data.ui, server: data.server }));
    const missing = [...base].filter((k) => !own.has(k));
    const extra = [...own].filter((k) => !base.has(k));
    assert.deepStrictEqual({ lang, missing, extra }, { lang, missing: [], extra: [] });
    assert.ok(['ltr', 'rtl'].includes(data.meta.dir));
  }

  // Provider ids must be unique.
  const ids = config.providers.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, ids.length);

  // PIN hashing round trip.
  const hash = await auth.hashPin('123456');
  assert.ok(await auth.verifyPin('123456', hash));
  assert.ok(!(await auth.verifyPin('123457', hash)));
  assert.ok(auth.validatePinFormat('1234'));
  assert.ok(!auth.validatePinFormat('12'));

  // Session tokens: valid, tampered, and invalidated by a PIN change.
  const secrets = { pinHash: hash, sessionSecret: 'x'.repeat(64), pin: null };
  const token = auth.createToken(secrets);
  assert.ok(auth.verifyToken(token, secrets));
  assert.ok(!auth.verifyToken(token.slice(0, -2) + 'aa', secrets));
  assert.ok(!auth.verifyToken(token, { ...secrets, pinHash: await auth.hashPin('999999') }));

  // Sliding expiry: a fresh token needs no renewal, an old one does.
  assert.ok(!auth.needsRenewal(token));
  const realNow = Date.now;
  Date.now = () => realNow() + (config.auth.sessionRenewAfterHours + 1) * 3600e3;
  try {
    assert.ok(auth.needsRenewal(token));
    assert.ok(auth.verifyToken(token, secrets));
  } finally {
    Date.now = realNow;
  }

  // Model normalisation for both provider shapes.
  const clean = config.providers.find((p) => p.id === 'cleanapis');
  const m1 = normalizeModel(clean, {
    id: 'a', name: 'A', context_window: 128000, capabilities: ['vision', 'reasoning'],
    pricing: { input_per_1k: 0.001, output_per_1k: 0.002 },
  });
  assert.strictEqual(m1.contextLength, 128000);
  assert.strictEqual(m1.inputPrice, 0.001 / 1000);
  assert.ok(m1.vision && m1.reasoning);
  const or = config.providers.find((p) => p.id === 'openrouter');
  const m2 = normalizeModel(or, {
    id: 'b/c', name: 'C', context_length: 1000, architecture: { input_modalities: ['text', 'image'] },
    pricing: { prompt: '0.000002', completion: '-1' }, supported_parameters: ['reasoning'],
  });
  assert.strictEqual(m2.inputPrice, 0.000002);
  assert.strictEqual(m2.outputPrice, null);
  assert.ok(m2.vision && m2.reasoning);
  assert.ok(!m2.video);
  const m3 = normalizeModel(or, { id: 'v', architecture: { input_modalities: ['text', 'video'] } });
  assert.ok(m3.video && !m3.vision);

  // Model filters: scalar, array and absent fields.
  assert.ok(passesFilter({ field: 'type', allow: ['embedding'] }, { type: 'embedding' }));
  assert.ok(!passesFilter({ field: 'type', allow: ['embedding'] }, { type: 'chat' }));
  assert.ok(passesFilter({ field: 'a.b', allow: ['text'] }, { a: { b: ['image', 'text'] } }));
  assert.ok(passesFilter(null, {}));

  // Attachment classification: extension first, then MIME type.
  assert.strictEqual(classify('main.c', ''), 'text');
  assert.strictEqual(classify('Report.PDF', 'application/octet-stream'), 'pdf');
  assert.strictEqual(classify('clip.mov', 'video/quicktime'), 'video');
  assert.strictEqual(classify('noext', 'image/png'), 'image');
  assert.strictEqual(classify('tool.exe', 'application/x-msdownload'), null);
  for (const k of Object.values(config.attachments.kinds)) assert.ok(k.maxBytes > 0 && k.extensions.length);

  // Prompt templates contain the placeholders the code fills in.
  assert.ok(prompts.memory.block.includes('{items}'));
  assert.ok(prompts.memory.item.includes('{text}'));
  for (const v of ['{memory}', '{conversation}']) assert.ok(prompts.memory.extract.user.includes(v));
  assert.ok(prompts.memory.extract.item.includes('{n}') && prompts.memory.extract.line.includes('{text}'));

  // Memory extraction answers: plain, fenced, and wrapped in prose.
  const { parseJsonObject } = require('../context');
  assert.deepStrictEqual(parseJsonObject('{"add":["a"],"remove":[]}'), { add: ['a'], remove: [] });
  assert.deepStrictEqual(parseJsonObject('```json\n{"add":["b"]}\n```'), { add: ['b'] });
  assert.deepStrictEqual(parseJsonObject('Sure {x} here: {"add":["c"],"remove":[2]} done.'), { add: ['c'], remove: [2] });
  assert.strictEqual(parseJsonObject('no json here'), null);
  assert.ok(prompts.attachments.document.includes('{name}') && prompts.attachments.document.includes('{text}'));
  assert.strictEqual(fill('a {x} {y}', { x: '{y}' }), 'a {y} {y}'); // substituted text is not re-expanded

  // SSE parsing: comments ignored, frames split across chunks, [DONE] stops.
  const enc = new TextEncoder();
  const chunks = [': ping\n\ndata: {"a"', ':1}\r\n\ndata: {"a":2}\n\ndata: [DONE]\n\ndata: {"a":3}\n\n'].map((s) => enc.encode(s));
  const out = [];
  for await (const j of sseJson(chunks)) out.push(j.a);
  assert.deepStrictEqual(out, [1, 2]);

  // Settings panel schema: unique ids, existing config paths, labels in
  // every language, and validation of bad values.
  const settings = require('../settings');
  const fieldIds = settings.fields.map((f) => f.id);
  assert.strictEqual(new Set(fieldIds).size, fieldIds.length);
  const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  for (const f of settings.fields) {
    const ps = f.type === 'model' ? [f.providerPath, f.modelPath] : [f.path];
    for (const p of ps) assert.notStrictEqual(getPath(config, p), undefined, `missing config path ${p}`);
    for (const [lang, data] of Object.entries(i18n)) {
      assert.ok(data.ui.panel.fields[f.id], `${lang}: missing ui.panel.fields.${f.id}`);
      if (f.type === 'model' && f.allowNone) assert.ok(data.ui.panel.none[f.id], `${lang}: missing ui.panel.none.${f.id}`);
      for (const opt of f.options || []) assert.ok(data.ui.panel.options[f.id][opt], `${lang}: missing option ${f.id}.${opt}`);
    }
  }
  {
    const tmpS = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'wca-settings-'));
    await settings.init(tmpS);
    const before = config.memory.archive.retrieval.topK;
    await assert.rejects(settings.update({ topK: 999 }), settings.SettingError);
    await assert.rejects(settings.update({ extractModel: { providerId: 'nope', modelId: 'x' } }), settings.SettingError);
    await assert.rejects(settings.update({ unknownField: 1 }), settings.SettingError);
    const v = await settings.update({ topK: 7, extractModel: null });
    assert.strictEqual(config.memory.archive.retrieval.topK, 7);
    assert.strictEqual(v.extractModel, null);
    await settings.reset();
    assert.strictEqual(config.memory.archive.retrieval.topK, before);
    require('fs').rmSync(tmpS, { recursive: true, force: true });
  }

  // Archive: FTS query sanitising, RRF, and a real SQLite round trip
  // (keyword mode, temporary directory).
  const archive = require('../archive');
  assert.strictEqual(archive.ftsQuery('STM32F407 "x" OR-drop پروژه‌ام'), '"stm32f407" OR "or" OR "drop" OR "پروژه" OR "ام"');
  assert.strictEqual(archive.ftsQuery('a ! ?'), '');
  assert.deepStrictEqual(archive.fuse([['a', 'b'], ['b', 'c']], 60).map(([id]) => id), ['b', 'a', 'c']);
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wca-selftest-'));
  try {
    archive.init(tmp, {});
    const e1 = await archive.upsertConversation({ conversationId: 'c1', title: 'UART driver', text: 'Baudrate 115200 on STM32F407, deadline Friday.' });
    await archive.upsertConversation({ conversationId: 'c2', title: 'سفر', text: 'برنامهٔ سفر به برلین در ماه مه.' });
    const again = await archive.upsertConversation({ conversationId: 'c1', title: 'UART driver v2', text: 'Baudrate 921600 on STM32F407.' });
    assert.strictEqual(again.id, e1.id); // same conversation → replaced, not duplicated
    assert.strictEqual(archive.status().count, 2);
    assert.strictEqual((await archive.search('which baudrate for stm32f407?'))[0].title, 'UART driver v2');
    assert.strictEqual((await archive.search('سفر برلین'))[0].conversationId, 'c2');
    assert.strictEqual((await archive.search('stm32f407', { excludeConversationId: 'c1' })).length, 0);
    assert.ok(archive.remove(e1.id) && archive.status().count === 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('selftest: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
