# eaze_editor_ui_sdk

Plugin-facing UI SDK for Eaze Editor. One logical action bus, two ends: **Java in the JVM**, **JavaScript in
the editor window**. A plugin jar can serve actions the UI calls, drive native dialogs and pickers, push toasts,
and receive events — without knowing anything about HTTP, WebSocket frames or Swing.

```
browser window                                    JVM (host + plugin jars)
eaze_ui_sdk.js  ── local listeners/handlers ─┐   ┌ UiCommandBus ── UiPluginScope ── plugin code
              │                              │   │      ▲
              │ request(action, payload)     │   │      │ EazeUiSdk.forPlugin("x").onAction(...)
              ▼                              ▼   ▼      │
        eaze_ui_sdk_bridge.js  <── STOMP ──>  UiSdkStompGateway + DefaultUiRuntime (pending ids, timeouts)
                                                    │
                                              NativePathProvider ── webui SwingNativePathProvider → PathSelector
```

* Browser asset docs (served by the host): `/js/eaze_editor_ui_sdk/README.md`
* No REST endpoint anywhere. Requests, replies and events are envelopes correlated by id over one socket.
* Package root `com.eazeeditor.core.uisdk`: Eaze Editor's plugin classloader is child-first but always delegates
  `com.eazeeditor.core.*` to the host, so every plugin shares the host's bus instance even if it bundles this jar.

## Gradle

This module is its own Gradle build root (`settings.gradle` → `rootProject.name = 'eaze_editor_ui_sdk'`).
Requires JDK 25 (Gradle toolchain) and Gradle 9.x; no wrapper jar is committed.

```groovy
// Host application (Spring Boot): auto-configuration does everything.
implementation project(':eaze_editor_ui_sdk')

// Plugin jar: compile against the API only — never bundle it into the artifact.
compileOnly project(':eaze_editor_ui_sdk')
```

Java 25, Spring dependencies are `compileOnly`, so a plain JVM host can use the module without Spring at all
(`new DefaultUiRuntime(provider)` + `EazeUiSdk.install(...)`).

```powershell
gradle clean build     # from this directory: builds only the SDK
```

A parent build that does `include 'eaze_editor_ui_sdk'` keeps working unchanged — Gradle resolves a single settings
file, the one at its own build root, and never descends into an included project directory looking for another.

## Host wiring

Spring Boot hosts need nothing beyond the dependency: `META-INF/spring/…AutoConfiguration.imports` registers

* a `UiRuntime` bean (installed into `EazeUiSdk`, shut down with the context),
* `StompUiBrowserTransport` + `UiSdkStompGateway` when `SimpMessagingTemplate` is present,
* `UiSdkWebSocketConfigurer`, which adds the SockJS endpoint `/ws/eaze-ui-sdk` **without** touching the host's own `WebSocketConfig`.

Expose real filesystem dialogs by providing one bean (webui does exactly this):

```java
@Component
class SwingNativePathProvider implements NativePathProvider {
   public PathSelectionResult select(PathSelectionRequest request) { /* modal chooser, serialised */ }
}
```

## Plugin API (`UiPluginScope`)

```java
UiPluginScope ui = EazeUiSdk.forPlugin("my-plugin");     // host code: EazeUiSdk.host()

// 1. Serve actions the browser (or another plugin) calls.
ui.onAction("myPlugin.reindex", req -> Map.of("indexed", service.reindex(req.getPayload())));

// 2. Drive the editor UI — blocking, human-scale timeouts (default 15 min).
ui.toastSuccess("Reindexed", "42 files");
if (ui.confirm("Delete build output?", "This cannot be undone.")) {
    Map<String, Object> answers = ui.showForm("New module", List.of(
        Map.of("name", "artifactId", "label", "Artifact id", "type", "text", "required", true)));
}

// 3. Conversation-style setup (chat bubbles; stepByStep renders a wizard).
Map<String, Object> plan = ui.askConversation("Scaffold", List.of(
    Map.of("name", "goal", "label", "What should it do?", "type", "textarea", "required", true)), false);

// 4. Real absolute paths via the host's native chooser (never throws; check isSelected()).
PathSelectionResult picked = ui.selectNativePath(PathSelectionRequest.directory("Project folder"));
String dir = ui.selectDirectory("Project folder");        // unwrap or throw UiSdkException(CANCELLED)

// 5. Events in both directions.
ui.publishEvent("myPlugin.synced", Map.of("files", 42));   // browser windows + JVM observers
ui.onEvent("editor.fileSaved", (event, payload, source) -> cache.invalidate(payload));

// 6. Unload: drops every handler and subscription this scope created.
ui.release();                                              // or EazeUiSdk.releasePlugin("my-plugin")
```

Blocking helpers (`confirm`, `showForm`, …) throw `UiSdkException` with the same codes the browser uses
(`CANCELLED`, `TIMEOUT`, `NO_HANDLER`, `INVALID_PAYLOAD`, `HANDLER_ERROR`, `BRIDGE_UNAVAILABLE`).
Non-blocking callers use `askBrowser(action, payload)` → `CompletableFuture<UiResponse>`.

## Wire contract (shared with `eaze_ui_sdk_bridge.js`)

| Direction | Name |
| --- | --- |
| browser → JVM | STOMP publish `/app/eaze-ui-sdk/request` |
| JVM → one window | `/topic/eaze-ui-sdk/client/{clientId}` — replies and directed events |
| JVM → all windows | `/topic/eaze-ui-sdk/events` — broadcast pushes |
| endpoint | SockJS `/ws/eaze-ui-sdk` (module-owned; the host keeps its own `/ws`) |

Envelope `type`: `eaze-ui-request` | `eaze-ui-response` | `eaze-ui-event`; errors are `{code,message,details}` and
travel as successful frames, so a failed UI action never looks like a transport fault.

## Semantics worth knowing

* **JVM dispatch is first-wins.** The first handler registered for an action owns it; returning `null` means
  "handled, no result" — it does *not* fall through to the next handler (side effects run once). The browser bus
  additionally lets listeners intercept built-ins.
* **Correlation is by request id**, and a remote reply only settles a request that was actually relayed.
* **Timeouts complete, they never hang**: `sendToBrowser` finishes with a `TIMEOUT` error response; the JS side
  rejects with `EazeUiError(code:'TIMEOUT')`.
* **Native pickers are serialised** on one thread (`PathSelector` shows modal Swing dialogs; stacked modals deadlock).
* **Window bookkeeping is best-effort**: client ids are refreshed by inbound traffic and pruned after 5 min idle.

## Extending

| Goal | How |
| --- | --- |
| Another transport (Electron IPC, WebView2 host channel) | implement `UiBrowserTransport` (`id`, `isAvailable`, `priority`, `send(clientId, envelope)`), call `runtime.registerTransport(...)`; mirror it in JS with `eazeUiSdk.addTransport(fn)` + `receive(raw,{remote:true})` |
| New UI capability from Java | add a built-in action in the browser (`core.registerHandler('ui.x', …)`) and call `scope.askBrowser("ui.x", payload)` — no Java change needed |
| New JVM capability for plugins | register an action handler; JS calls it with `eazeUiSdk.request('myPlugin.x', payload)` (no local listener → relayed automatically) |

## Tests

```powershell
.\gradlew.bat :eaze_editor_ui_sdk:test                                        # 14 JUnit tests: bus semantics, correlation, timeouts, scope lifecycle
node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_core_routing.test.mjs         # 6 checks: relay, id isolation, local priority, NO_HANDLER, inbound, events
node eaze_editor_ui_sdk/src/test/js/eaze_ui_sdk_bridge.test.mjs               # 5 checks: topics, clientId, inbound reply, event fan-out, disconnect
```

Interactive check without booting the whole editor: serve `src/main/resources/static` and open
`/js/eaze_editor_ui_sdk/demo/harness.html?mockJvm=1&selftest=1` (in-page fake JVM transport) or `?sdkDemo=1`
(widget panel). See also `await eazeUiSdkDemo.runSelfTest()`.
