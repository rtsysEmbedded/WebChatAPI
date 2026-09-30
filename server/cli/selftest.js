'use strict';

// Offline sanity checks: config/i18n consistency, PIN hashing, session
// tokens, model normalisation and SSE parsing. Run with: npm run check

const assert = require('assert');
const { config, i18n } = require('../config');
const auth = require('../auth');
const { normalizeModel, sseJson } = require('../providers');
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

  console.log('selftest: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
