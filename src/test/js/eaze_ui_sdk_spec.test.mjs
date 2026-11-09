/**
 * Node-runnable contract test for the UI SDK field-spec layer
 * (eaze_ui_sdk.js core + eaze_ui_sdk_spec.js).  No browser needed.
 *
 * Covers the data-integrity defects that do not require a DOM:
 *   D1  prototype-polluting answer keys (__proto__) are stored as own properties
 *   D6  invalid defaults are dropped/clamped WITH a diagnostic, never silently
 *   D7  one empty-answer encoding policy for every control type
 *   D10/D11 display labels fall back to something human-readable
 *   D12 unknown / mistyped spec keys are reported (and fatal in strict mode)
 *
 * Run: node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_spec.test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetDir = path.resolve(here, '../../main/resources/static/js/eaze_editor_ui_sdk');

function makeElement() {
   return {
      style: {}, dataset: {}, attributes: {}, children: [],
      setAttribute() { }, appendChild(child) { this.children.push(child); },
      addEventListener() { }, removeEventListener() { }, querySelector() { return null; },
      querySelectorAll() { return []; }, classList: { add() { }, remove() { }, contains() { return false; } }
   };
}

const sandbox = {
   console, setTimeout, clearTimeout, setInterval, clearInterval,
   Promise, JSON, Object, Array, Date, Math, Error, String, Number, Boolean, RegExp, Map, Set,
   crypto: globalThis.crypto,
   addEventListener() { }, removeEventListener() { },
   dispatchEvent() { return true; },
   CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; Object.assign(this, options || {}); } }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
   readyState: 'complete', head: makeElement(), body: makeElement(),
   createElement: () => makeElement(), createTextNode: (text) => ({ text }),
   getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
   addEventListener() { }, removeEventListener() { }
};

vm.createContext(sandbox);
// Silence the SDK's own console.warn noise; every warning is asserted explicitly below.
const quietConsole = Object.assign(Object.create(console), { warn() { }, info() { } });
sandbox.console = quietConsole;

for (const file of ['eaze_ui_sdk.js', 'eaze_ui_sdk_spec.js']) {
   vm.runInContext(readFileSync(path.join(assetDir, file), 'utf8'), sandbox, { filename: file });
}

const core = sandbox.eazeUiSdk.core;
const spec = core.spec;
if (!spec) throw new Error('core.spec missing — did eaze_ui_sdk_spec.js load?');

const results = [];
function check(name, fn) {
   try { const detail = fn(); results.push({ name, ok: true, detail: String(detail ?? '') }); }
   catch (error) { results.push({ name, ok: false, detail: error.message }); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function warningsOf(field) { return (field._warnings || []).join(' | '); }

/* -------------------------------------------------------------------- D1 */

check('proto-answer-key-is-an-own-property', () => {
   const field = spec.normalizeField({ name: '__proto__', type: 'text', value: 'polluted' }, 0, {});
   assert(warningsOf(field).includes('prototype'), 'expected a prototype-collision warning');

   const answers = {};
   core.safeSet(answers, field.name, field.value);

   assert(Object.prototype.hasOwnProperty.call(answers, '__proto__'), 'answer key was not stored');
   assert(JSON.stringify(answers) === '{"__proto__":"polluted"}', 'JSON lost the key: ' + JSON.stringify(answers));
   assert(sandbox.Object.getPrototypeOf(answers) === Object.prototype, 'prototype was mutated');
   assert({}.polluted === undefined && [].polluted === undefined, 'prototype pollution leaked globally');
   return JSON.stringify(answers);
});

check('constructor-and-prototype-keys-are-safe', () => {
   const answers = {};
   core.safeSet(answers, 'constructor', 'mine');
   core.safeSet(answers, 'prototype', 'mine');
   assert(answers.constructor === 'mine' && answers.prototype === 'mine', 'unsafe keys not stored as data');
   assert(Number.prototype.constructor === Number, 'Number.prototype was touched');
   return 'own data properties only';
});

/* -------------------------------------------------------------------- D6 */

check('invalid-color-default-is-dropped-with-warning', () => {
   const field = spec.normalizeField({ name: 'accent', label: 'Accent color', type: 'color', value: '#GGGGGG' }, 0, {});
   assert(field.value === undefined, 'invalid colour was kept: ' + field.value);
   assert(warningsOf(field).includes('#RRGGBB'), 'no colour diagnostic: ' + warningsOf(field));
   return warningsOf(field);
});

check('short-color-is-expanded-deterministically', () => {
   const field = spec.normalizeField({ name: 'accent', type: 'color', value: '#0AF' }, 0, {});
   assert(field.value === '#00aaff', 'expected #00aaff, got ' + field.value);
   return field.value;
});

check('out-of-range-number-default-is-clamped-and-reported', () => {
   const field = spec.normalizeField({ name: 'parallelism', label: 'Parallelism', type: 'number', min: 1, max: 10, value: 42 }, 0, {});
   assert(field.value === 10, 'expected clamp to 10, got ' + field.value);
   assert(warningsOf(field).includes('clamped'), 'no clamp diagnostic');
   return warningsOf(field);
});

check('non-numeric-default-is-dropped', () => {
   const field = spec.normalizeField({ name: 'n', label: 'Count', type: 'number', value: 'four' }, 0, {});
   assert(field.value === undefined, 'non-numeric default survived');
   return warningsOf(field);
});

check('select-default-must-exist-in-options', () => {
   const field = spec.normalizeField({ name: 'jdk', label: 'JDK', type: 'select', options: ['17', '21'], value: '11' }, 0, {});
   assert(field.value === undefined, 'unknown option default survived');
   assert(warningsOf(field).includes('not among'), 'no membership diagnostic');
   return warningsOf(field);
});

check('multi-select-default-drops-only-invalid-members', () => {
   const field = spec.normalizeField({
      name: 'tags', label: 'Tags', type: 'select', multiple: true, options: ['a', 'b', 'c'], value: ['a', 'zz']
   }, 0, {});
   assert(Array.isArray(field.value) && field.value.join(',') === 'a', 'expected [a], got ' + JSON.stringify(field.value));
   assert(warningsOf(field).includes('zz'), 'invalid member not reported');
   return JSON.stringify(field.value);
});

check('checkbox-string-defaults-coerce-boolean-does-not', () => {
   const yes = spec.normalizeField({ name: 'ok', type: 'checkbox', value: 'true' }, 0, {});
   assert(yes.value === true, 'string "true" not coerced');
   const junk = spec.normalizeField({ name: 'ok2', label: 'Ok', type: 'checkbox', value: 'maybe' }, 0, {});
   assert(junk.value === undefined && warningsOf(junk).includes('boolean'), 'junk checkbox default survived');
   return 'true / warning';
});

check('date-defaults-are-format-and-range-checked', () => {
   const bad = spec.normalizeField({ name: 'd', label: 'Date', type: 'date', value: '2026/13/45' }, 0, {});
   assert(bad.value === undefined && warningsOf(bad).includes('format'), 'bad date survived');

   const before = spec.normalizeField({ name: 'd2', label: 'Date', type: 'date', min: '2026-01-01', value: '2025-12-31' }, 0, {});
   assert(before.value === undefined && warningsOf(before).includes('before min'), 'out-of-range date survived');

   const good = spec.normalizeField({ name: 'd3', type: 'date', value: '2026-02-01' }, 0, {});
   assert(good.value === '2026-02-01', 'valid date was dropped');
   return 'format + bounds enforced';
});

/* ------------------------------------------------------------- D10 / D11 */

check('display-label-falls-back-to-readable-text', () => {
   assert(spec.displayLabel({ name: 'q1' }) === 'Question q1', 'q1 fallback wrong');
   assert(spec.displayLabel({ name: 'max_retries' }) === 'max retries', 'snake_case fallback wrong');
   assert(spec.displayLabel({ name: 'q1', label: 'Retry policy?' }) === 'Retry policy?', 'explicit label ignored');
   assert(spec.displayLabel({ name: 'q1', errorLabel: 'Question 2' }) === 'Question 2', 'errorLabel ignored');
   return 'labels are human-readable';
});

/* ------------------------------------------------------------------- D7 */

check('empty-value-detection-covers-every-control-shape', () => {
   assert(spec.isEmptyValue(''), '"" must be empty');
   assert(spec.isEmptyValue([]), '[] must be empty');
   assert(spec.isEmptyValue(null), 'null must be empty');
   assert(!spec.isEmptyValue(false), 'false (unchecked box) is an answer, not a gap');
   assert(!spec.isEmptyValue(0), 'zero is an answer');
   assert(spec.isEmptyValue({ mode: 'native', path: null, paths: [], files: [] }), 'empty file result must be empty');
   assert(!spec.isEmptyValue({ mode: 'native', path: 'H:/a.txt', paths: ['H:/a.txt'], files: [] }), 'picked file is not empty');
   return 'consistent emptiness';
});

check('empty-policy-encodes-uniformly', () => {
   assert(spec.applyEmptyPolicy('', 'null') === null, "policy 'null' failed");
   assert(Array.isArray(spec.applyEmptyPolicy([], 'string')) && spec.applyEmptyPolicy([], 'string').length === 0,
       'empty multi-select stays [] under every policy (D2)');
   assert(spec.applyEmptyPolicy(null, 'omit') === spec.OMIT, "policy 'omit' failed");
   assert(spec.applyEmptyPolicy('x', 'null') === 'x', 'non-empty value was rewritten');
   // A multi-select with nothing picked answers "none" — [] IS the data; collapsing it re-creates D2.
   const kept = spec.applyEmptyPolicy([], 'null');
   assert(Array.isArray(kept) && kept.length === 0, 'empty multi-select must stay [] (D2)');
   assert(spec.isEmptyForPolicy([]) === false, 'arrays are not policy-empty');
   assert(spec.isEmptyValue([]) === true, 'arrays are still required-check empty');
   return 'one policy for every type';
});

check('implicit-control-values-are-not-answers', () => {
   // color/range always report a value; the contract treats an untouched control as unanswered.
   const color = spec.normalizeField({ name: 'c', label: 'C', type: 'color' }, 0, {});
   assert(color.value === undefined || color.value === null, 'no colour default must stay unset');
   const good = spec.normalizeField({ name: 'c2', label: 'C2', type: 'color', value: '#ABCD12' }, 0, {});
   assert(String(good.value).toLowerCase() === '#abcd12', 'valid colour default kept');
   return 'no invented #000000';
});

check('internal-annotations-are-not-reported-as-unknown-keys', () => {
   const first = spec.normalizeField({ name: 'a', label: 'A', type: 'text' }, 0, {});
   assert(first._displayLabel === 'A', 'display label expected');
   const again = spec.normalizeField(Object.assign({}, first, { _warnings: [] }), 1, {});
   const noise = (again._warnings || []).filter(w => /_displayLabel|_warnings/.test(w));
   assert(noise.length === 0, 're-normalising must not report SDK bookkeeping keys: ' + noise.join(' | '));
   return 'idempotent normalisation';
});

/* ------------------------------------------------------------------ D12 */

check('unknown-key-is-reported-and-case-typos-adopted', () => {
   const field = spec.normalizeField({ name: 'a', label: 'A', type: 'text', placeHolder: 'hint', defualt: 3 }, 0, {});
   const notes = warningsOf(field);
   assert(notes.includes('placeHolder'), 'case typo not reported: ' + notes);
   assert(field.placeholder === 'hint', 'case typo was not adopted');
   assert(notes.includes('defualt'), 'unknown key swallowed silently: ' + notes);
   return notes;
});

check('alias-keys-are-adopted-with-a-warning', () => {
   const field = spec.normalizeField({ name: 'a', label: 'A', type: 'text', defaultValue: 'hi', help: 'hint' }, 0, {});
   assert(field.value === 'hi', 'defaultValue alias not adopted');
   assert(field.helper === 'hint', 'help alias not adopted');
   return warningsOf(field);
});

check('strict-mode-rejects-unknown-keys', () => {
   let error = null;
   try { spec.normalizeField({ name: 'a', type: 'text', bogusKey: 1 }, 0, { strict: true }); }
   catch (e) { error = e; }
   assert(error && error.code === 'INVALID_FIELD', 'strict mode did not throw INVALID_FIELD');
   assert(String(error.message).includes('bogusKey'), 'error does not name the key');
   return error.code;
});

check('empty-options-are-reported-for-choice-types', () => {
   const field = spec.normalizeField({ name: 'mode', label: 'Mode', type: 'select' }, 0, {});
   assert(warningsOf(field).includes('options'), 'missing options not reported');
   return warningsOf(field);
});

check('blank-option-values-are-dropped-with-warning', () => {
   const field = spec.normalizeField({ name: 'x', label: 'X', type: 'select', options: ['', 'a', 'b'] }, 0, {});
   assert(field.options.length === 2, 'empty option survived');
   assert(warningsOf(field).includes('empty value'), 'empty option not reported');
   return warningsOf(field);
});

check('duplicate-answer-keys-are-reported', () => {
   const fields = spec.normalizeFields([{ name: 'dup', type: 'text' }, { name: 'dup', type: 'text' }], {});
   assert(warningsOf(fields[1]).includes('Duplicate'), 'duplicate key not reported');
   return warningsOf(fields[1]);
});

check('unsupported-type-still-throws-invalid-payload', () => {
   let error = null;
   try { spec.normalizeField({ name: 'x', type: 'richtext' }, 0, {}); } catch (e) { error = e; }
   assert(error && error.code === 'INVALID_PAYLOAD', 'bad type must stay fatal');
   return error.code;
});

check('diagnostics-are-collected-and-drainable', () => {
   const sdk = sandbox.eazeUiSdk.core.createSdk();
   sdk.core.diagnose('TEST', 'synthetic warning', { a: 1 });
   assert(sdk.diagnostics().length === 1, 'diagnostic not recorded');
   assert(sdk.drainDiagnostics()[0].message === 'synthetic warning', 'drain returned the wrong entry');
   assert(sdk.diagnostics().length === 0, 'drain did not clear the buffer');
   return 'collect + drain';
});

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
   console.log((entry.ok ? 'PASS ' : 'FAIL ') + entry.name + (entry.detail ? ' — ' + entry.detail : ''));
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
