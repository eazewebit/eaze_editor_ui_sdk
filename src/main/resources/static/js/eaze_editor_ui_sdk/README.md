# Eaze Editor UI SDK

Plugin-facing UI toolkit for Eaze Editor. It is a **two-way action bus**, not a markup framework:
JavaScript in the editor window and Java inside the JVM register actions on the same logical bus and
call each other with promises. Everything here ships inside the `eaze_editor_ui_sdk` Gradle module —
Spring Boot serves these files from the jar, so `webui` keeps no copy.

* Docs while running: <http://localhost:8080/js/eaze_editor_ui_sdk/README.md>
* Java entry point: `com.eazeeditor.core.uisdk.EazeUiSdk` (see the module README for the full API)
* Zero dependencies, zero build step, no REST endpoint in either direction.

## Load order

```html
<link rel="stylesheet" th:href="@{/css/eaze_editor_ui_sdk.css}">
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk.js}" defer></script>          <!-- core bus -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_css.js}" defer></script>      <!-- applyCss/loadScript/modules -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_toast.js}" defer></script>    <!-- ui.showToast -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_dialog.js}" defer></script>   <!-- showDialog/alert/confirm/prompt -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_spec.js}" defer></script>    <!-- field contract (pure, no DOM) -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_fields.js}" defer></script>   <!-- shared native inputs -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_form.js}" defer></script>     <!-- ui.showForm -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_conversation.js}" defer></script>
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_bridge.js}" defer></script>   <!-- STOMP bridge to the JVM -->
<script th:src="@{/js/eaze_editor_ui_sdk/eaze_ui_sdk_native.js}" defer></script>   <!-- ui.selectNativePath -->
```

`eazeUiSdk.ready` resolves when the DOM is parsed; loading a file twice is harmless (the singleton wins).

## Envelopes and routing

```jsonc
{ "id":"req-…", "type":"eaze-ui-request",  "action":"myPlugin.reindex", "payload":{}, "sourcePluginId":"host" }
{ "id":"req-…", "type":"eaze-ui-response", "ok":true, "result":{}, "error":null }
{ "id":"evt-…", "type":"eaze-ui-event",    "action":"myPlugin.synced",  "payload":{} }
```

| Situation | What `request()` does |
| --- | --- |
| a local listener or built-in handler exists | it serves the call; **nothing** is sent over the wire |
| nothing local serves it | relayed to every transport (the STOMP bridge → JVM bus) and resolved by the reply with the same `id` |
| `{ forwardToBridge: true }` | relayed even if something local exists |
| no transport connected and nothing local | rejects with `NO_HANDLER` / `BRIDGE_UNAVAILABLE` |

A remote reply can only settle a request that was actually relayed, so a late JVM answer can never hijack
a locally-served call. The **JVM** bus differs on purpose: the first registered handler owns an action and
returning `null` means "done, no result" (no fall-through), which keeps side-effecting handlers from running twice.

## Calling UI from JavaScript

```js
const ui = eazeUiSdk.createPluginApi('my-plugin');   // or use window.eazeUiSdk directly

await ui.showToast({ type: 'success', title: 'Saved', message: '42 files indexed' });
const answer = await ui.confirm('Delete build output?', 'This cannot be undone.');
const values = await ui.showForm({ title: 'New module', fields: [
    { name: 'artifactId', label: 'Artifact id', type: 'text', required: true },
    { name: 'jdk', label: 'JDK', type: 'select', options: ['21', '25'], value: '25' }
]});
const picked = await ui.selectNativePath({ title: 'Project folder', mode: 'directory' });  // -> H:/code/app
ui.registerListener('myPlugin.reindex', payload => ({ indexed: 42 }));                      // Java can call this
```

Cancellation always rejects with `EazeUiError(code:'CANCELLED')` (except `cancelBehavior:'resolve'`).
Errors carry stable codes: `CANCELLED`, `TIMEOUT`, `NO_HANDLER`, `INVALID_PAYLOAD`, `INVALID_FIELD`,
`LISTENER_ERROR`, `BRIDGE_UNAVAILABLE`, `UNSAFE_REQUEST`. A dismissal is always `CANCELLED`; a failure to
display never uses that code, so callers can tell "the user closed it" from "nothing showed up".

**A dialogue never times out on its own.** `request()` carries no deadline unless the caller passes one (`{ timeoutMs: 30000 }`),
and neither do `showDialog` / `showForm` / `askConversation` / `selectNativePath`: the modal stays open and the promise stays
pending for as long as the human needs it. Opt in per call with a positive `timeoutMs`, or set a host-wide default through
`eazeUiSdk.core.config.requestTimeoutMs` before the SDK files load, when a caller genuinely cannot wait.

## Field contract (`eaze_ui_sdk_spec.js`)

Every field and every conversation question is normalised **before** a DOM node exists — identical rules in
Node and browser, covered by `src/test/js/eaze_ui_sdk_spec.test.mjs` (23 checks).

| Rule | Behaviour |
| --- | --- |
| answer keys | written through `Object.defineProperty`, so a field named `__proto__` becomes an own property (`{"__proto__":"x"}`) instead of mutating the prototype chain; such names are additionally reported as diagnostics |
| unknown spec keys | never dropped silently: alias/case near-misses (`placeHolder`, `defaultValue`, `choices`, `mandatory`) are adopted **with a warning**, anything else is reported and ignored. `{ strictFields: true }` turns any adjustment into an `INVALID_FIELD` rejection |
| invalid defaults | reported, never applied quietly: malformed colour/date/non-numeric → dropped + warning; out-of-range number → clamped to the bound + warning naming both values; select/radio default missing from `options` → dropped (multi-select keeps its valid members); checkbox accepts only booleans or `'true'`/`'false'` |
| warnings | shown under the field, collected by `eazeUiSdk.diagnostics()` / `core.drainDiagnostics()`, and attached as `_meta.warnings` when `{ includeMeta: true }`. Java plugins surface the same list in tool output via `FormSpecParser.warnings(specs)` |
| empty answers | one policy for every type — `emptyValue: 'null' \| 'string' \| 'omit'` (default `'null'`). Blank text, empty number, unanswered radio/checkbox and an untouched file field all encode identically; `'raw'` returns the untouched control value |
| multi-select | no placeholder row, `selectedIndex = -1` until something is genuinely picked, empty option values filtered — zero selections yields `[]`, never `[""]` |
| labels | always rendered. `{ hideLabel: true }` (what conversations use) keeps an accessible label plus `aria-label`/`aria-describedby`; a missing label falls back to the prettified name (`max_retries` → `max retries`) |
| validation text | quotes the human label — or `errorLabel`, which is what each conversation question sets — never an internal key such as `q1` |
| required enforcement | `validate()` **returns** the message it renders, so a submit in `showForm`/`askConversation` and the wizard's **Next** are blocked while any field is invalid. An error that merely looks red (returned `undefined`) used to let empty answers through — verified live: dialog stays open until the value is supplied |

File fields honour `multiple` in **both** modes. Result shape:

```jsonc
{ "mode":"native",  "multiple":true, "path":"H:/a.txt", "paths":["H:/a.txt","H:/b.txt"] }
{ "mode":"browser", "multiple":true, "path":null, "paths":[], "files":[{"name":"a.txt","size":12,"type":"text/plain"}] }
```

`paths` are real absolute paths only in `native` mode (the JVM picker); browsers cannot expose them, so a
browser selection carries descriptors in `files` instead.
`BRIDGE_UNAVAILABLE`, `UNSAFE_REQUEST`.

## The bridge (`eaze_ui_sdk_bridge.js`)

Application-level messaging over the host's STOMP broker — one long-lived SockJS socket, no HTTP:

| Direction | Wire name |
| --- | --- |
| browser → JVM | publish `/app/eaze-ui-sdk/request` (envelope + this tab's `clientId`) |
| JVM → this window | subscribe `/topic/eaze-ui-sdk/client/{clientId}` (replies, directed events) |
| JVM → every window | subscribe `/topic/eaze-ui-sdk/events` (broadcast pushes) |
| endpoint | SockJS `/ws/eaze-ui-sdk`, registered by the module itself (`UiSdkWebSocketConfigurer`) |

Each browser tab keeps one `clientId` in `sessionStorage`, so reconnects keep routing intact. Reconnect retries indefinitely by default (`reconnectDelayMs: 3000`, growing to `maxReconnectDelayMs: 20000`; `maxReconnectAttempts: -1` never gives up, `0` never retries) — the editor outlives backend restarts.

On the JVM side that socket **is** the window: the SUBSCRIBE above binds it, and when a socket disconnects every request still waiting on that
window is answered with `BRIDGE_UNAVAILABLE` — an unanswered dialogue can no longer park a plugin thread forever. A reconnect re-binds under the same
`clientId`, so a socket lost during a network blip leaves an open question answerable instead of releasing it early.

Configure before the file loads:

```js
eazeUiSdk.core.config.bridge = { enabled: false };   // never touch the network (tests, offline pages)
// endpoint / requestDestination / eventsTopic / clientTopicPrefix / connectTimeoutMs / debug
```

API: `eazeUiSdk.bridge.connect()`, `.disconnect()`, `.isConnected()`, `.status()`, `.clientId`.
`eazeUiSdk.subscribeBackendEvents()` / `unsubscribeBackendEvents()` remain as aliases. Requests that must be
answered by Java (`ui.selectNativePath`, `ui.nativeCapabilities`) trigger a lazy connect automatically.

## Talking to Java

Register an action and any window (or another plugin) can call it:

```js
const off = eazeUiSdk.registerListener('myPlugin.applyPatch', payload => ({ applied: payload.patch.length }));
```

Java side of the same conversation (`eaze_editor_ui_sdk` on the plugin's classpath):

```java
UiPluginScope ui = EazeUiSdk.forPlugin("my-plugin");

ui.onAction("myPlugin.reindex", req -> Map.of("indexed", service.reindex(req.getPayload()))); // JS calls this
ui.askBrowser("myPlugin.applyPatch", Map.of("patch", List.of(...)));                            // JS listener answers
ui.toastSuccess("Reindexed", "42 files");                                                       // push a toast
String dir = ui.selectDirectory("Pick project folder");                                         // native Swing picker
```

See the module README (`eaze_editor_ui_sdk/README.md`) for dialogs, forms, conversations and events from Java.

`ui.selectNativePath()` normally relays to the JVM's Swing picker, but a **local** handler wins first and no bridge is required in that case —
a plugin may supply its own chooser (and a test harness may mock one) simply by registering `ui.selectNativePath`. Both answer shapes are
accepted: the JVM envelope `{status:'SELECTED', path, paths, mode}` and the plain `{path, paths, mode}`. An explicit `{status:'CANCELLED'}` rejects
with `CANCELLED`; any other explicit status rejects with that error's own code. Without a bridge *and* without a local handler it rejects with
`BRIDGE_UNAVAILABLE` — never with a fake path.
## Testing without Spring Boot

`demo/harness.html` loads the SDK exactly like `/ai_code_editor` does. Serve the module's static root, e.g.

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory eaze_editor_ui_sdk/src/main/resources/static
```

| Flag | Effect |
| --- | --- |
| `?sdkDemo=1` | floating demo panel (`eazeUiSdkDemo.show()`), widget self test via `await eazeUiSdkDemo.runSelfTest()` |
| `?mockJvm=1` | installs an in-page fake JVM transport (`window.__sdkJvmMock`: `calls`, `onCall`, `push`, `ask`) — no WebSocket, no Java |
| `?selftest=1` | runs `eazeUiSdkHarness.runBridgeTest()` and prints the report (needs `?mockJvm=1`) |

Headless equivalents (no browser at all):

```powershell
node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_core_routing.test.mjs   # relay, correlation, local priority, events
node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_bridge.test.mjs         # topics, clientId, inbound replies, disconnect
```

## Adding another transport

`eazeUiSdk.addTransport(fn)` returns a remover. `fn(envelope)` is called for anything this window cannot serve
itself (and for `emitEvent`). Return `false` when the envelope could not be delivered; feed incoming data back
through `eazeUiSdk.receive(raw, { remote: true })`. That is all `eaze_ui_sdk_bridge.js` does — a Java↔JS bridge
over Electron IPC or a WebView2 host message channel is ~30 lines.

## Security notes

* No `eval`, no inline `<script>` execution and no cross-origin script loading unless a plugin explicitly opts in
  (`allowInlineScript` / `allowRemoteScripts`, both off by default).
* Dialog HTML is sanitised with DOMPurify when present, otherwise stripped to text; all widget content is built
  with `textContent` / `dataset`, never string-concatenated HTML.
* Toast stacks are capped (5 per position) so a chatty plugin cannot bury the editor.
* Nothing here exposes an HTTP endpoint; the JVM side authenticates nothing because it accepts envelopes only
  from windows already authenticated by the host's own WebSocket/SockJS handshake.
