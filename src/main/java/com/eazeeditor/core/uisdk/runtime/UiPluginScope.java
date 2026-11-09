package com.eazeeditor.core.uisdk.runtime;

import com.eazeeditor.core.uisdk.api.UiActionHandler;
import com.eazeeditor.core.uisdk.api.UiError;
import com.eazeeditor.core.uisdk.api.UiEventListener;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import com.eazeeditor.core.uisdk.api.UiSdkException;
import com.eazeeditor.core.uisdk.bus.UiCommandBus;
import com.eazeeditor.core.uisdk.model.PathSelectionRequest;
import com.eazeeditor.core.uisdk.model.PathSelectionResult;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * The plugin-facing half of the SDK.  A jar gets one of these from
 * {@code EazeUiSdk.forPlugin("my-plugin")} and can then
 *
 * <ul>
 *   <li><b>serve</b> actions the browser calls ({@link #onAction}),</li>
 *   <li><b>drive</b> the editor UI ({@link #showForm}, {@link #askConversation},
 *       {@link #confirm}, {@link #toast}) over the app-level bridge,</li>
 *   <li><b>pick real paths</b> natively ({@link #selectNativePath}).</li>
 * </ul>
 *
 * Every call is namespaced by {@link #pluginId()}; {@link #release()} drops all
 * registrations the scope created, which is what a host should call when it
 * unloads a plugin jar.
 */
public final class UiPluginScope {

   /** Dialogs may legitimately wait for a human; 15 minutes before we give up. */
   public static final long DEFAULT_UI_TIMEOUT_MS = 15L * 60L * 1000L;

   private final UiRuntime runtime;
   private final String pluginId;
   private final List<UiCommandBus.Subscription> owned = new ArrayList<>();

   public UiPluginScope(UiRuntime runtime, String pluginId) {
      this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
      this.pluginId = (pluginId == null || pluginId.trim().isEmpty()) ? "plugin" : pluginId.trim();
   }

   public String pluginId() {
      return pluginId;
   }

   public UiRuntime runtime() {
      return runtime;
   }

   // ------------------------------------------------------------------ //
   // Serving actions (browser -> JVM)
   // ------------------------------------------------------------------ //

   /** Handle an action coming from the editor UI or another plugin. */
   public synchronized UiCommandBus.Subscription onAction(String action, UiActionHandler handler) {
      UiCommandBus.Subscription subscription = runtime.bus().subscribe(action, pluginId, handler);
      owned.add(subscription);
      return subscription;
   }

   /** Observe fire-and-forget events (browser pushes included). */
   public synchronized UiCommandBus.Subscription onEvent(String event, UiEventListener listener) {
      UiCommandBus.Subscription subscription = runtime.bus().observe(event, listener);
      owned.add(subscription);
      return subscription;
   }

   /** Remove everything this scope registered (plugin unload). */
   public synchronized void release() {
      for (UiCommandBus.Subscription subscription : owned) {
         try {
            subscription.unsubscribe();
         } catch (RuntimeException ignored) {
            // best effort
         }
      }
      owned.clear();
      runtime.bus().unsubscribeAllOf(pluginId);
   }

   // ------------------------------------------------------------------ //
   // Two-way calls into the browser UI
   // ------------------------------------------------------------------ //

   public CompletableFuture<UiResponse> askBrowser(String action, Map<String, Object> payload) {
      return askBrowser(action, payload, DEFAULT_UI_TIMEOUT_MS);
   }

   public CompletableFuture<UiResponse> askBrowser(String action, Map<String, Object> payload, long timeoutMs) {
      UiRequest request = UiRequest.jvm(action, payload == null ? new LinkedHashMap<>() : payload, pluginId)
         .withTimeout(timeoutMs > 0 ? timeoutMs : DEFAULT_UI_TIMEOUT_MS);
      return runtime.sendToBrowser(request);
   }

   /** Blocking call; throws {@link UiSdkException} when the UI rejects or times out. */
   public Object awaitResult(String action, Map<String, Object> payload, long timeoutMs) {
      try {
         UiResponse response = askBrowser(action, payload, timeoutMs).get(timeoutMs + 5_000L, TimeUnit.MILLISECONDS);
         return response.unwrap();
      } catch (InterruptedException e) {
         Thread.currentThread().interrupt();
         throw new UiSdkException(UiError.TIMEOUT, "Interrupted while waiting for the editor UI.");
      } catch (java.util.concurrent.ExecutionException e) {
         Throwable cause = e.getCause() == null ? e : e.getCause();
         if (cause instanceof UiSdkException sdkException) {
            throw sdkException;
         }
         throw new UiSdkException(UiError.HANDLER_ERROR, String.valueOf(cause.getMessage()));
      } catch (java.util.concurrent.TimeoutException e) {
         throw new UiSdkException(UiError.TIMEOUT, "The editor UI did not answer within " + timeoutMs + " ms.");
      }
   }

   @SuppressWarnings("unchecked")
   public Map<String, Object> awaitMap(String action, Map<String, Object> payload, long timeoutMs) {
      Object result = awaitResult(action, payload, timeoutMs);
      return result instanceof Map<?, ?> ? (Map<String, Object>) result : Collections.emptyMap();
   }

   // ------------------------------------------------------------------ //
   // Toasts
   // ------------------------------------------------------------------ //

   /** Non-blocking toast in every editor window. */
   public void toast(String type, String title, String message) {
      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("type", type == null ? "info" : type);
      payload.put("title", title);
      payload.put("message", message);
      askBrowser("ui.showToast", payload, 10_000L);
   }

   public void toastSuccess(String title, String message) {
      toast("success", title, message);
   }

   public void toastInfo(String title, String message) {
      toast("info", title, message);
   }

   public void toastWarning(String title, String message) {
      toast("warning", title, message);
   }

   public void toastError(String title, String message) {
      toast("error", title, message);
   }

   // ------------------------------------------------------------------ //
   // Dialogs / forms / conversations
   // ------------------------------------------------------------------ //

   /** Simple alert; returns once the user acknowledged it. */
   public void alert(String title, String message) {
      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("title", title == null ? "Notice" : title);
      payload.put("message", message == null ? "" : message);
      awaitResult("ui.showDialog", payload, DEFAULT_UI_TIMEOUT_MS);
   }

   /** Yes/No prompt. {@code false} on Cancel/Esc instead of throwing. */
   public boolean confirm(String title, String message) {
      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("title", title == null ? "Confirm" : title);
      payload.put("message", message == null ? "" : message);
      payload.put("cancelBehavior", "resolve");

      try {
         Map<String, Object> result = awaitMap("ui.showDialog", payload, DEFAULT_UI_TIMEOUT_MS);
         if (Boolean.TRUE.equals(result.get("cancelled"))) {
            return false;
         }
         String button = String.valueOf(result.get("button"));
         return "ok".equalsIgnoreCase(button) || "confirm".equalsIgnoreCase(button) || "yes".equalsIgnoreCase(button);
      } catch (UiSdkException e) {
         if (UiError.CANCELLED.equals(e.getCode())) {
            return false;
         }
         throw e;
      }
   }

   /** Full-control dialog; see the module README for the option map. */
   public Map<String, Object> showDialog(Map<String, Object> options) {
      return awaitMap("ui.showDialog", options, DEFAULT_UI_TIMEOUT_MS);
   }

   /** Native-input form. Keys of {@code fields} follow the JS field contract. */
   public Map<String, Object> showForm(String title, List<Map<String, Object>> fields) {
      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("title", title == null ? "Input required" : title);
      payload.put("fields", fields == null ? Collections.emptyList() : fields);
      return awaitMap("ui.showForm", payload, DEFAULT_UI_TIMEOUT_MS);
   }

   /** Conversation-style answer set (chat bubbles in one dialog). */
   public Map<String, Object> askConversation(String title, List<Map<String, Object>> questions) {
      return askConversation(title, questions, false);
   }

   /** Conversation-style answer set; {@code stepByStep} renders a wizard. */
   public Map<String, Object> askConversation(String title, List<Map<String, Object>> questions, boolean stepByStep) {
      if (questions == null || questions.isEmpty()) {
         throw UiSdkException.invalidPayload("askConversation requires at least one question.");
      }

      Map<String, Object> payload = new LinkedHashMap<>();
      payload.put("title", title == null ? "A few questions" : title);
      payload.put("questions", questions);
      payload.put("stepByStep", stepByStep);
      return awaitMap("ui.askConversation", payload, DEFAULT_UI_TIMEOUT_MS);
   }

   // ------------------------------------------------------------------ //
   // Native filesystem (real absolute paths)
   // ------------------------------------------------------------------ //

   public PathSelectionResult selectNativePath(PathSelectionRequest request) {
      if (request != null && request.getSourcePluginId() == null) {
         request.setSourcePluginId(pluginId);
      }
      return runtime.selectPath(request);
   }

   public String selectDirectory(String title) {
      return runtime.selectPath(PathSelectionRequest.directory(title)).unwrap();
   }

   public String selectFile(String title, List<String> extensions) {
      PathSelectionRequest request = PathSelectionRequest.file(title);
      if (extensions != null) {
         request.setExtensions(extensions);
      }
      return runtime.selectPath(request).unwrap();
   }

   public List<String> selectFiles(String title, List<String> extensions) {
      PathSelectionRequest request = PathSelectionRequest.files(title);
      if (extensions != null) {
         request.setExtensions(extensions);
      }
      PathSelectionResult result = runtime.selectPath(request);
      return result.isSelected() ? result.getPaths() : Collections.emptyList();
   }

   // ------------------------------------------------------------------ //
   // Events + introspection
   // ------------------------------------------------------------------ //

   /** Broadcast to browser windows and other JVM plugins. */
   public boolean publishEvent(String event, Object payload) {
      return runtime.publishEvent(event, payload, pluginId);
   }

   public Map<String, Object> capabilities() {
      return runtime.capabilities();
   }

   @Override
   public String toString() {
      return "UiPluginScope{" + pluginId + "}";
   }
}
