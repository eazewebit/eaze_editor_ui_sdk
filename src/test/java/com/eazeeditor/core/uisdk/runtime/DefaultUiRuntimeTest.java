package com.eazeeditor.core.uisdk.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.eazeeditor.core.uisdk.EazeUiSdk;
import com.eazeeditor.core.uisdk.api.NativePathProvider;
import com.eazeeditor.core.uisdk.api.UiBrowserTransport;
import com.eazeeditor.core.uisdk.api.UiError;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import com.eazeeditor.core.uisdk.api.UiSdkException;
import com.eazeeditor.core.uisdk.model.PathSelectionRequest;
import com.eazeeditor.core.uisdk.model.PathSelectionResult;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class DefaultUiRuntimeTest {

   /** Records what the runtime pushes and lets a test answer as if it were a window. */
   private static final class FakeTransport implements UiBrowserTransport {
      private final List<Map<String, Object>> sent = Collections.synchronizedList(new ArrayList<>());
      private volatile String lastClientId;
      private volatile boolean available = true;

      @Override
      public String id() {
         return "fake";
      }

      @Override
      public boolean isAvailable() {
         return available;
      }

      @Override
      public boolean send(String clientId, Map<String, Object> envelope) {
         lastClientId = clientId;
         sent.add(envelope);
         return true;
      }
   }

   private static final class FakePicker implements NativePathProvider {
      @Override
      public PathSelectionResult select(PathSelectionRequest request) {
         if ("nope".equals(request.safeTitle(""))) {
            return PathSelectionResult.cancelled(request.normalizedMode());
         }
         return PathSelectionResult.selected(request.normalizedMode(), "H:/picked");
      }
   }

   @AfterEach
   void tearDown() {
      EazeUiSdk.shutdown();
   }

   private static UiRequest request(String action, Map<String, Object> payload) {
      return UiRequest.jvm(action, payload, "test-plugin");
   }

   @Test
   @DisplayName("JVM request travels over the transport and resolves on the correlated reply")
   void twoWayRoundTrip() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime(new FakePicker());
      FakeTransport transport = new FakeTransport();
      runtime.registerBrowserClient("win-1");
      runtime.registerTransport(transport);

      CompletableFuture<UiResponse> future =
         runtime.sendToBrowser(request("ui.showForm", Map.of("title", "Setup")));

      assertEquals(1, transport.sent.size());
      Map<String, Object> envelope = transport.sent.get(0);
      assertEquals("win-1", transport.lastClientId);
      assertEquals("eaze-ui-request", envelope.get("type"));
      assertEquals("ui.showForm", envelope.get("action"));

      String requestId = (String) envelope.get("id");
      boolean matched = runtime.completePending(UiResponse.ok(requestId, "ui.showForm", Map.of("name", "demo")));

      assertTrue(matched);
      UiResponse response = future.get(2, TimeUnit.SECONDS);
      assertTrue(response.isOk());
      assertEquals("demo", ((Map<?, ?>) response.getResult()).get("name"));
   }

   @Test
   @DisplayName("without a browser session the request fails fast instead of hanging")
   void noBrowserClient() {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      runtime.registerTransport(new FakeTransport());

      Throwable cause = null;
      try {
         runtime.sendToBrowser(request("ui.showToast", Map.of())).get(1, TimeUnit.SECONDS);
      } catch (Exception e) {
         cause = e.getCause() == null ? e : e.getCause();
      }

      assertInstanceOf(UiSdkException.class, cause);
      assertEquals(UiError.NO_BROWSER_CLIENT, ((UiSdkException) cause).getCode());
   }

   @Test
   @DisplayName("an unanswered request completes with a TIMEOUT response")
   void timeoutIsAnErrorResponse() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      runtime.registerBrowserClient("win-1");
      runtime.registerTransport(new FakeTransport());

      UiResponse response = runtime.sendToBrowser(request("ui.showDialog", Map.of()).withTimeout(60L))
         .get(3, TimeUnit.SECONDS);

      assertFalse(response.isOk());
      assertEquals(UiError.TIMEOUT, response.getError().getCode());
   }

   @Test
   @DisplayName("browser requests are dispatched on the JVM bus and answered")
   void inboundBrowserRequest() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      runtime.bus().subscribe("myPlugin.reindex", "my-plugin", req -> Map.of("files", 42));

      UiRequest inbound = UiRequest.fromMap(Map.of(
         "id", "req-1",
         "type", "eaze-ui-request",
         "action", "myPlugin.reindex",
         "origin", "browser",
         "clientId", "win-9",
         "payload", Map.of("scope", "all")));

      UiResponse response = runtime.handleBrowserRequest(inbound).get(2, TimeUnit.SECONDS);

      assertTrue(response.isOk());
      assertEquals("req-1", response.getId());
      assertEquals(42, ((Map<?, ?>) response.getResult()).get("files"));
      assertEquals("win-9", runtime.preferredBrowserClientId());
   }

   @Test
   @DisplayName("unknown actions from the browser answer NO_HANDLER")
   void inboundUnknownAction() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      UiResponse response = runtime.handleBrowserRequest(
         UiRequest.fromMap(Map.of("id", "r2", "action", "nope.nope", "clientId", "c"))).get(2, TimeUnit.SECONDS);

      assertFalse(response.isOk());
      assertEquals(UiError.NO_HANDLER, response.getError().getCode());
   }

   @Test
   @DisplayName("built-in capabilities and native selection are served by the runtime")
   void builtinHandlers() {
      DefaultUiRuntime runtime = new DefaultUiRuntime(new FakePicker());

      UiResponse capabilities = runtime.bus().invoke(UiRequest.jvm("ui.nativeCapabilities", Map.of(), "caller"));
      assertTrue(capabilities.isOk());
      assertEquals(true, ((Map<?, ?>) capabilities.getResult()).get("nativePathSelection"));

      UiResponse picked = runtime.bus().invoke(UiRequest.jvm("ui.selectNativePath",
         Map.of("mode", "directory", "title", "anything"), "caller"));
      assertTrue(picked.isOk());
      assertEquals("H:/picked", ((Map<?, ?>) picked.getResult()).get("path"));

      UiResponse cancelled = runtime.bus().invoke(UiRequest.jvm("ui.selectNativePath",
         Map.of("mode", "file", "title", "nope"), "caller"));
      assertFalse(cancelled.isOk());
      assertEquals(UiError.CANCELLED, cancelled.getError().getCode());
   }

   @Test
   @DisplayName("events reach local observers and every browser transport")
   void eventBroadcast() {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      FakeTransport transport = new FakeTransport();
      runtime.registerTransport(transport);

      AtomicIntegerHolder holder = new AtomicIntegerHolder();
      runtime.bus().observe("myPlugin.synced", (event, payload, source) -> holder.value++);

      assertTrue(runtime.publishEvent("myPlugin.synced", Map.of("ok", true), "my-plugin"));
      assertEquals(1, holder.value);
      assertEquals("eaze-ui-event", transport.sent.get(0).get("type"));
   }

   @Test
   @DisplayName("plugin scopes serve actions, drive the UI and release everything on unload")
   void pluginScopeLifecycle() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime(new FakePicker());
      EazeUiSdk.install(runtime);
      FakeTransport transport = new FakeTransport();
      runtime.registerBrowserClient("win-1");
      runtime.registerTransport(transport);

      UiPluginScope ui = EazeUiSdk.forPlugin("my-plugin");
      ui.onAction("myPlugin.ping", request -> "pong:" + request.getString("ping", ""));

      assertTrue(runtime.bus().hasHandler("myPlugin.ping"));
      assertEquals("pong:hi", runtime.bus()
         .invoke(UiRequest.jvm("myPlugin.ping", Map.of("ping", "hi"), "other")).getResult());

      ui.toastSuccess("Done", "all good");
      assertNotNull(transport.sent.isEmpty() ? null : transport.sent.get(0).get("action"));
      assertEquals("ui.showToast", transport.sent.get(0).get("action"));

      ui.release();
      assertFalse(runtime.bus().hasHandler("myPlugin.ping"));
   }

   private static final class AtomicIntegerHolder {
      private int value;
   }
}
