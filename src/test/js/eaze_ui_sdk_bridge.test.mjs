/**
 * Node-runnable check for eaze_ui_sdk_bridge.js — the STOMP transport that carries
 * SDK envelopes between the browser and the JVM bus.
 *
 * A fake SockJS/Stomp pair stands in for the real broker, so the assertions cover
 * the parts that are actually ours:
 *   1. connect() subscribes the broadcast topic AND this window's own topic with two
 *      distinct subscription ids (stomp-websocket keys its subscription map on
 *      headers.id — one shared header object silently drops the first subscription),
 *   2. outbound requests are published as JSON to /app/eaze-ui-sdk/request with the
 *      window's clientId attached (that is how Java finds its way back),
 *   3. an inbound reply resolves the matching request,
 *   4. a JVM-initiated request is dispatched locally and the reply is published,
 *   5. disconnect() unregisters the transport (calls then stop leaving the page).
 *
 * Every check runs against BOTH STOMP generations, because hosts ship different ones:
 *   - 'legacy'  stomp-websocket 2.x — the build webui actually serves
 *     (`send(destination, headers, body)`, NO `publish`),
 *   - 'modern'  @stomp/stompjs compat layer (`publish({destination, headers, body})`).
 * A mock that only implements one of them hides a total bridge failure from CI, which
 * is exactly how "Editor window unavailable / legacy dialog" once slipped through.
 *
 * Run: node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_bridge.test.mjs
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

function makeSandbox() {
   const store = {};
   const sandbox = {
      console, setTimeout, clearTimeout, setInterval, clearInterval,
      Promise, JSON, Object, Array, Date, Math, Error, String, Number, Boolean, RegExp, Map, Set,
      addEventListener() { }, removeEventListener() { },
      dispatchEvent() { return true; },
      CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; Object.assign(this, options || {}); } },
      sessionStorage: {
         getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
         setItem: (key, value) => { store[key] = String(value); }
      },
      location: { search: '' }
   };

   sandbox.window = sandbox;
   sandbox.globalThis = sandbox;
   sandbox.document = {
      readyState: 'complete',
      head: makeElement(), body: makeElement(),
      createElement: () => makeElement(), createTextNode: (text) => ({ text }),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener() { }, removeEventListener() { }
   };

   vm.createContext(sandbox);
   return sandbox;
}

function loadScript(sandbox, file) {
   vm.runInContext(readFileSync(path.join(assetDir, file), 'utf8'), sandbox, { filename: file });
}

/**
 * Minimal STOMP peer.  `api` selects the library generation to emulate:
 *   legacy -> stomp-websocket 2.x (send(), zero-arg connect with _parseConnect rules,
 *            subscription map keyed by headers.id)
 *   modern -> @stomp/stompjs compat (publish({destination, headers, body}))
 */
function installFakeStomp(sandbox, api) {
   const broker = {
      api: api || 'modern',
      published: [],
      byDestination: {},
      clients: 0,
      connectHeaders: null
   };

   sandbox.SockJS = function SockJS(url) { this.url = url; };

   const record = (destination, headers, body) => broker.published.push({ destination, headers, body });

   const deliverToDestination = (destination, envelope) => {
      const entry = broker.byDestination[destination];
      if (!entry) throw new Error('nothing subscribed on ' + destination);
      entry.callback({ body: JSON.stringify(envelope), headers: {} });
   };

   function makeClient(socket) {
      const client = {
         socket,
         connected: false,
         counter: 0,
         subscriptions: {},          // keyed by subscription id — mirrors the real library
         debug() { }
      };

      if (broker.api === 'legacy') {
         // stomp-websocket 2.x exposes send(), never publish(); connect() takes a
         // variable argument list and is declared with zero parameters.
         client.connect = function () {
            const args = Array.prototype.slice.call(arguments);
            let headers = {}, onConnect = null, onError = null;

            if (args.length === 2) { headers = args[0] || {}; onConnect = args[1]; }
            else if (args.length === 3 && typeof args[1] === 'function') { headers = args[0] || {}; onConnect = args[1]; onError = args[2]; }
            else if (args.length === 3) { headers = { login: args[0], passcode: args[1] }; onConnect = args[2]; }
            else { headers = { login: args[0], passcode: args[1] }; onConnect = args[2]; onError = args[3]; }

            broker.clients += 1;
            broker.connectHeaders = headers;
            client.connected = true;
            setTimeout(() => { if (onConnect) onConnect({ command: 'CONNECTED', headers: {} }); }, 0);
         };
         client.send = function (destination, headers, body) { record(destination, headers, body); };
         client.subscribe = function (destination, callback, headers) {
            const opts = headers || {};
            if (!opts.id) opts.id = 'sub-' + (client.counter++);
            client.subscriptions[opts.id] = callback;      // same id twice => first callback is lost
            broker.byDestination[destination] = { callback, headers: Object.assign({}, opts), id: opts.id };
            return { id: opts.id, destination, unsubscribe() { } };
         };
         client.disconnect = function (cb) { client.connected = false; if (cb) cb(); };
      } else {
         client.connect = function (headers, onConnect, onError) {
            broker.clients += 1;
            broker.connectHeaders = headers;
            client.connected = true;
            setTimeout(() => { if (onConnect) onConnect({ type: 'CONNECTED' }); }, 0);
         };
         client.publish = function (message) { record(message.destination, message.headers, message.body); };
         client.subscribe = function (destination, callback, headers) {
            const opts = headers || {};
            if (!opts.id) opts.id = 'sub-' + (client.counter++);
            client.subscriptions[opts.id] = callback;
            broker.byDestination[destination] = { callback, headers: Object.assign({}, opts), id: opts.id };
            return { id: opts.id, destination, unsubscribe() { } };
         };
         client.disconnect = function (cb) { client.connected = false; if (cb) cb(); };
      }

      return client;
   }

   sandbox.Stomp = { over: (socket) => makeClient(socket) };

   broker.deliver = deliverToDestination;
   broker.publishedBodies = () => broker.published.map((m) => JSON.parse(m.body));
   return broker;
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

async function boot(api) {
   const sandbox = makeSandbox();
   loadScript(sandbox, 'eaze_ui_sdk.js');
   // The bridge reads its config at load time: keep auto-connect off for the test.
   sandbox.eazeUiSdk.core.config.bridge = { enabled: true, autoConnect: false };
   const broker = installFakeStomp(sandbox, api);
   loadScript(sandbox, 'eaze_ui_sdk_bridge.js');
   await sandbox.eazeUiSdk.ready;
   return { sdk: sandbox.eazeUiSdk, broker, sandbox };
}

for (const api of ['modern', 'legacy']) {
   const tag = (name) => name + ' [' + api + ']';

   await check(tag('connect-subscribes-both-topics'), async () => {
      const { sdk, broker } = await boot(api);
      const connected = await sdk.bridge.connect();

      assert(connected === true, 'connect() did not resolve true');
      assert(sdk.bridge.isConnected(), 'bridge reports disconnected after connect');
      assert(!!broker.byDestination['/topic/eaze-ui-sdk/events'], 'broadcast topic not subscribed');

      const ownTopic = '/topic/eaze-ui-sdk/client/' + sdk.bridge.clientId;
      assert(!!broker.byDestination[ownTopic], 'own client topic not subscribed: ' + Object.keys(broker.byDestination));

      // Two live subscriptions must carry two different STOMP subscription ids, otherwise
      // the library drops one callback and JVM pushes silently disappear.
      const eventsSub = broker.byDestination['/topic/eaze-ui-sdk/events'];
      const ownSub = broker.byDestination[ownTopic];
      assert(eventsSub.id !== ownSub.id, 'both subscriptions share id ' + eventsSub.id);

      // The bridge announces itself so Java can push before the page's first request.
      const hello = broker.publishedBodies()
         .find((body) => body.type === 'eaze-ui-event' && body.action === 'ui.bridge.connected');
      assert(hello, 'no ui.bridge.connected announcement published on connect');
      assert(hello.payload.clientId === sdk.bridge.clientId, 'announcement carries the wrong clientId');
      return ownTopic + ' via ' + sdk.bridge.status().stompApi;
   });

   await check(tag('outbound-request-carries-client-id'), async () => {
      const { sdk, broker } = await boot(api);
      await sdk.bridge.connect();

      const pending = sdk.request('ui.selectNativePath', { mode: 'directory' });
      await tick(0);

      const requests = broker.publishedBodies().filter((body) => body.type === 'eaze-ui-request');
      assert(requests.length === 1, 'expected exactly one published request envelope, got ' + requests.length);

      const message = broker.published.filter((m) => m.destination === '/app/eaze-ui-sdk/request' && JSON.parse(m.body).type === 'eaze-ui-request')[0];
      assert(!!message, 'no frame published to /app/eaze-ui-sdk/request');

      const body = JSON.parse(message.body);
      assert(body.type === 'eaze-ui-request', 'wrong envelope type');
      assert(body.clientId === sdk.bridge.clientId, 'clientId missing from the envelope');

      broker.deliver('/topic/eaze-ui-sdk/client/' + sdk.bridge.clientId, {
         id: body.id, type: 'eaze-ui-response', action: body.action, ok: true,
         result: { path: 'H:/from-java' }, error: null
      });

      const result = await pending;
      assert(result.path === 'H:/from-java', 'reply did not resolve the request');
      return result.path;
   });

   await check(tag('jvm-request-is-answered-over-the-socket'), async () => {
      const { sdk, broker } = await boot(api);
      await sdk.bridge.connect();

      sdk.registerListener('demo.fromJava', (payload) => ({ seen: payload.value }));
      const topic = '/topic/eaze-ui-sdk/client/' + sdk.bridge.clientId;

      broker.deliver(topic, {
         id: 'jvm-42', type: 'eaze-ui-request', action: 'demo.fromJava',
         sourcePluginId: 'java-plugin', payload: { value: 9 }
      });
      await tick(5);

      const reply = broker.publishedBodies().find((body) => body.id === 'jvm-42');
      assert(reply, 'no reply published for the JVM request');
      assert(reply.type === 'eaze-ui-response', 'reply has wrong type');
      assert(reply.ok === true && reply.result.seen === 9, 'wrong reply payload: ' + JSON.stringify(reply));
      return JSON.stringify(reply.result);
   });

   await check(tag('inbound-event-reaches-onEvent'), async () => {
      const { sdk, broker } = await boot(api);
      await sdk.bridge.connect();

      let received = null;
      sdk.onEvent('myPlugin.synced', (payload) => { received = payload; });
      broker.deliver('/topic/eaze-ui-sdk/events', {
         id: 'evt-9', type: 'eaze-ui-event', action: 'myPlugin.synced', payload: { files: 12 }
      });

      assert(received && received.files === 12, 'event did not reach the subscriber');
      return JSON.stringify(received);
   });

   await check(tag('disconnect-stops-relaying'), async () => {
      const { sdk, broker } = await boot(api);
      await sdk.bridge.connect();
      assert(sdk.bridge.disconnect('test') === true, 'disconnect returned false');
      assert(!sdk.bridge.isConnected(), 'still connected after disconnect');

      const error = await sdk.request('ui.selectNativePath', {}).then(() => null, (e) => e);
      assert(error && error.code === 'NO_HANDLER', 'expected NO_HANDLER after disconnect, got ' + (error && error.code));
      assert(broker.publishedBodies().filter((body) => body.type === 'eaze-ui-request').length === 0, 'a request was still published after disconnect');
      return error.code;
   });
}

const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
   console.log((entry.ok ? 'PASS ' : 'FAIL ') + entry.name + (entry.detail ? ' — ' + entry.detail : ''));
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
