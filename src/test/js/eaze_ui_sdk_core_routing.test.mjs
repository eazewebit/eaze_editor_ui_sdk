/**
 * Node-runnable check for the browser core of the UI SDK (eaze_ui_sdk.js).
 *
 * It verifies the routing contract that makes JVM <-> browser calls work without
 * any HTTP endpoint:
 *   1. actions nothing local serves are relayed to transports,
 *   2. replies resolve exactly their own request id (correlation),
 *   3. a local listener/handler wins and never leaks to the transport,
 *   4. with neither a handler nor a transport the answer is NO_HANDLER,
 *   5. inbound JVM requests produce a correlated response envelope,
 *   6. JVM events fan out to onEvent subscribers.
 *
 * Run:  node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_core_routing.test.mjs
 * (exit code 0 = all green).  No browser needed — the DOM surface core touches
 * is stubbed, so this runs in CI without Chrome/WebView2.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = path.resolve(here, '../../main/resources/static/js/eaze_editor_ui_sdk/eaze_ui_sdk.js');

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
   readyState: 'complete',
   head: makeElement(),
   body: makeElement(),
   createElement: () => makeElement(),
   createTextNode: (text) => ({ text }),
   getElementById: () => null,
   querySelector: () => null,
   querySelectorAll: () => [],
   addEventListener() { }, removeEventListener() { }
};

vm.createContext(sandbox);
vm.runInContext(readFileSync(corePath, 'utf8'), sandbox, { filename: 'eaze_ui_sdk.js' });

const bootstrap = sandbox.eazeUiSdk;
if (!bootstrap) throw new Error('core did not expose window.eazeUiSdk');

/** Every check gets its own bus instance so transports cannot leak between them. */
function newSdk() {
   return bootstrap.core.createSdk();
}

/** Stand-in for eaze_ui_sdk_bridge.js: records outbound envelopes, injects replies. */
function installFakeJvm(sdkRef) {
   const sent = [];
   sdkRef.addTransport((envelope) => { sent.push(envelope); });
   return {
      sent,
      reply(envelope, result) {
         sdkRef.receive({
            id: envelope.id, type: 'eaze-ui-response', action: envelope.action, ok: true,
            result: result == null ? null : result, error: null
         }, { remote: true });
      },
      replyError(envelope, code, message) {
         sdkRef.receive({
            id: envelope.id, type: 'eaze-ui-response', action: envelope.action, ok: false,
            result: null, error: { code, message }
         }, { remote: true });
      }
   };
}

const results = [];
function check(name, fn) {
   return Promise.resolve().then(fn).then(
      (detail) => { results.push({ name, ok: true, detail: String(detail ?? '') }); },
      (error) => { results.push({ name, ok: false, detail: error.message }); }
   );
}

function assert(condition, message) {
   if (!condition) throw new Error(message);
}

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await check('relay-unknown-action-to-jvm', async () => {
   const sdk = newSdk();
   const jvm = installFakeJvm(sdk);

   const pending = sdk.request('ui.selectNativePath', { mode: 'directory' });
   await tick(0);
   assert(jvm.sent.length === 1, 'expected exactly one relayed envelope, got ' + jvm.sent.length);
   assert(jvm.sent[0].type === 'eaze-ui-request', 'wrong envelope type');

   jvm.reply(jvm.sent[0], { path: 'H:/picked' });
   const result = await pending;
   assert(result.path === 'H:/picked', 'result not propagated');
   return result.path;
});

await check('correlation-resolves-only-its-own-request', async () => {
   const sdk = newSdk();
   const jvm = installFakeJvm(sdk);

   const first = sdk.request('demo.first', { n: 1 });
   const second = sdk.request('demo.second', { n: 2 });
   await tick(0);
   assert(jvm.sent.length === 2, 'two requests should be relayed');

   jvm.reply(jvm.sent[1], 'second-value');
   const secondValue = await second;
   const early = await Promise.race([first, tick(30).then(() => '__still-pending__')]);

   assert(secondValue === 'second-value', 'wrong value for the second request');
   assert(early === '__still-pending__', 'a reply leaked into another request');

   jvm.reply(jvm.sent[0], 'first-value');
   assert((await first) === 'first-value', 'first request never resolved');
   return 'ids isolated';
});

await check('local-listener-wins-and-nothing-leaks', async () => {
   const sdk = newSdk();
   const jvm = installFakeJvm(sdk);

   sdk.registerListener('demo.localOnly', (payload) => ({ local: true, saw: payload }));
   const result = await sdk.request('demo.localOnly', { n: 7 });

   assert(result.local === true, 'listener did not handle the request');
   assert(jvm.sent.length === 0, 'request leaked to the transport despite a local listener');
   return JSON.stringify(result.saw);
});

await check('no-handler-when-nothing-can-answer', async () => {
   const sdk = newSdk();
   const error = await sdk.request('demo.absolutely.nothing', {}).then(() => null, (e) => e);
   assert(error && error.code === 'NO_HANDLER', 'expected NO_HANDLER, got ' + (error && error.code));
   return error.code;
});

await check('jvm-request-is-answered-with-correlated-envelope', async () => {
   const sdk = newSdk();
   sdk.registerListener('demo.fromJava', (payload) => ({ doubled: payload.value * 2 }));

   const response = await sdk.dispatch({
      id: 'jvm-req-1', type: 'eaze-ui-request', action: 'demo.fromJava',
      sourcePluginId: 'mock-jvm', payload: { value: 21 }
   });

   assert(response.type === 'eaze-ui-response', 'dispatch must return a response envelope');
   assert(response.id === 'jvm-req-1', 'response id does not match the request id');
   assert(response.ok === true && response.result.doubled === 42, 'wrong result: ' + JSON.stringify(response.result));
   return response.id + ' -> ' + JSON.stringify(response.result);
});

await check('jvm-events-reach-onEvent-subscribers', async () => {
   const sdk = newSdk();
   let received = null;
   sdk.onEvent('myPlugin.synced', (payload) => { received = payload; });

   const handled = sdk.receive({
      id: 'evt-1', type: 'eaze-ui-event', action: 'myPlugin.synced', payload: { files: 3 }
   }, { remote: true });

   assert(handled === true, 'event envelope was not accepted');
   assert(received && received.files === 3, 'event payload did not reach the subscriber');
   return JSON.stringify(received);
});

await check('jvm-event-falls-through-to-built-in-handler', async () => {
   const sdk = newSdk();
   let rendered = null;
   sdk.core.registerHandler('ui.showToast', (payload) => { rendered = payload; return { id: 'toast-1' }; });

   const handled = sdk.receive({
      id: 'evt-2', type: 'eaze-ui-event', action: 'ui.showToast', sourcePluginId: 'java-plugin',
      payload: { type: 'success', title: 'JVM toast', message: 'pushed from java' }
   }, { remote: true });

   await tick(5);
   assert(handled === true, 'event push was not accepted');
   assert(rendered && rendered.title === 'JVM toast', 'built-in handler did not render the push');
   return JSON.stringify(rendered);
});

await check('onEvent-listener-owns-the-event-no-double-render', async () => {
   const sdk = newSdk();
   let listened = null, rendered = 0;
   sdk.onEvent('ui.showToast', (payload) => { listened = payload; });
   sdk.core.registerHandler('ui.showToast', () => { rendered += 1; return { id: 'toast-x' }; });

   sdk.receive({ id: 'evt-3', type: 'eaze-ui-event', action: 'ui.showToast', payload: { title: 'owned' } }, { remote: true });
   await tick(5);

   assert(listened && listened.title === 'owned', 'onEvent listener did not receive the event');
   assert(rendered === 0, 'built-in handler must stay out when a listener owns the event');
   return 'single delivery';
});

await check('unknown-event-without-handler-is-ignored', async () => {
   const sdk = newSdk();
   const handled = sdk.receive({ id: 'evt-4', type: 'eaze-ui-event', action: 'demo.nothing.here', payload: {} }, { remote: true });
   assert(handled === false, 'an unserveable event must report handled=false, got ' + handled);
   return 'ignored';
});
const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
   console.log((entry.ok ? 'PASS ' : 'FAIL ') + entry.name + (entry.detail ? ' — ' + entry.detail : ''));
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
