package com.eazeeditor.core.uisdk.runtime;

import com.eazeeditor.core.uisdk.api.NativePathProvider;
import com.eazeeditor.core.uisdk.api.UiBrowserTransport;
import com.eazeeditor.core.uisdk.api.UiError;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import com.eazeeditor.core.uisdk.api.UiSdkException;
import com.eazeeditor.core.uisdk.bus.UiCommandBus;
import com.eazeeditor.core.uisdk.model.PathSelectionRequest;
import com.eazeeditor.core.uisdk.model.PathSelectionResult;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;

/**
 * Default {@link UiRuntime}: owns the bus, the registered browser transports and
 * the request-id correlation table that makes two-way communication work without
 * a single HTTP endpoint.
 *
 * <p>Threads: one cached pool dispatches inbound browser traffic (a handler may
 * block on a modal dialog without stalling the host's message broker) and one scheduler serves only the
 * deadlines a caller explicitly opted into.  Both are daemon pools so they never keep the JVM alive.
 *
 * <p>Because dialogue requests carry no deadline by default, a window that disappears has to report it:
 * {@link #releaseBrowserClient(String)} fails everything addressed to it with
 * {@link UiError#BRIDGE_UNAVAILABLE} (the STOMP layer calls it when the socket drops) so blocked plugin
 * threads resume instead of waiting forever.
 */
public final class DefaultUiRuntime implements UiRuntime {

   public static final String VERSION = "1.0.0";

   /** Built-in actions served by the host itself. */
   public static final String ACTION_SELECT_NATIVE_PATH = "ui.selectNativePath";
   public static final String ACTION_CAPABILITIES = "ui.nativeCapabilities";

   /**
    * Requests carry <em>no</em> deadline unless the caller opted into one with
    * {@link UiRequest#withTimeout(long)}.  A dialogue may stay open for as long as the human
    * needs it, so an unanswered request simply stays pending until a window answers.
    */
   public static final long NO_TIMEOUT_MS = 0L;

   /** @deprecated There is no implicit browser timeout any more — use {@link #NO_TIMEOUT_MS}. */
   @Deprecated
   public static final long DEFAULT_BROWSER_TIMEOUT_MS = NO_TIMEOUT_MS;

   private final UiCommandBus bus = new UiCommandBus();
   private final CopyOnWriteArrayList<UiBrowserTransport> transports = new CopyOnWriteArrayList<>();
   private final ConcurrentMap<String, PendingEntry> pending = new ConcurrentHashMap<>();
   private final LinkedHashSet<String> knownClients = new LinkedHashSet<>();

   private final ScheduledExecutorService timeouts =
      Executors.newSingleThreadScheduledExecutor(daemonFactory("eaze-ui-sdk-timeout"));
   private final java.util.concurrent.ExecutorService inbound =
      Executors.newCachedThreadPool(daemonFactory("eaze-ui-sdk-inbound"));

   private volatile NativePathProvider nativePathProvider;
   private volatile boolean shutdown;

   public DefaultUiRuntime() {
      this(null);
   }

   public DefaultUiRuntime(NativePathProvider provider) {
      this.nativePathProvider = provider;
      registerBuiltinHandlers();
   }

   // ------------------------------------------------------------------ //
   // UiRuntime — identity
   // ------------------------------------------------------------------ //

   @Override
   public String version() {
      return VERSION;
   }

   @Override
   public Map<String, Object> capabilities() {
      List<String> transportIds = new ArrayList<>();
      for (UiBrowserTransport transport : transports) {
         transportIds.add(transport.id() + (transport.isAvailable() ? "" : " (down)"));
      }

      List<String> clients;
      synchronized (knownClients) {
         clients = new ArrayList<>(knownClients);
      }

      Map<String, Object> map = new java.util.LinkedHashMap<>();
      map.put("version", VERSION);
      map.put("nativePathSelection", isNativePathSelectionAvailable());
      map.put("browserConnected", hasBrowserTransport());
      map.put("transports", transportIds);
      // Which editor windows announced themselves: a missing entry here is the single
      // most common reason a plugin call falls back to legacy rendering.
      map.put("browserClients", clients);
      map.put("preferredBrowserClient", preferredBrowserClientId());
      map.put("pendingRequests", pending.size());
      map.put("jvmActions", new ArrayList<>(bus.actions()));
      return map;
   }

   @Override
   public UiCommandBus bus() {
      return bus;
   }

   // ------------------------------------------------------------------ //
   // Browser channel
   // ------------------------------------------------------------------ //

   @Override
   public void registerTransport(UiBrowserTransport transport) {
      if (transport == null) {
         return;
      }

      transports.removeIf(existing -> existing.id().equals(transport.id()));
      transports.add(transport);
      transports.sort(Comparator.comparingInt(UiBrowserTransport::priority));
   }

   @Override
   public void unregisterTransport(UiBrowserTransport transport) {
      if (transport != null) {
         transports.remove(transport);
      }
   }

   @Override
   public boolean hasBrowserTransport() {
      for (UiBrowserTransport transport : transports) {
         if (transport.isAvailable()) {
            return true;
         }
      }
      return false;
   }

   @Override
   public void registerBrowserClient(String clientId) {
      if (clientId == null || clientId.trim().isEmpty()) {
         return;
      }

      String value = clientId.trim();
      synchronized (knownClients) {
         knownClients.remove(value);
         knownClients.add(value);
      }
   }

   @Override
   public void touchClient(String clientId) {
      registerBrowserClient(clientId);
   }

   @Override
   public String preferredBrowserClientId() {
      synchronized (knownClients) {
         String latest = null;
         for (String candidate : knownClients) {
            latest = candidate;
         }
         return latest;
      }
   }

   /**
    * Forget a browser window that went away and fail every pending request addressed to it with
    * {@link UiError#BRIDGE_UNAVAILABLE}.
    *
    * <p>A dialogue carries no deadline by default, so the transport has to report a lost window itself:
    * without this a plugin thread blocked in {@code UiPluginScope.awaitResult} would wait forever the moment
    * the editor closes without answering.  Requests aimed at another window stay untouched and a reconnecting
    * window registers again through its next envelope.
    *
    * @return how many pending requests were released (0 when this client had nothing outstanding)
    */
   @Override
   public int releaseBrowserClient(String clientId) {
      String value = clientId == null ? null : clientId.trim();
      if (value == null || value.isEmpty()) {
         return 0;
      }

      synchronized (knownClients) {
         knownClients.remove(value);
      }

      int released = 0;
      for (Map.Entry<String, PendingEntry> candidate : pending.entrySet()) {
         if (!value.equals(candidate.getValue().clientId())) {
            continue;
         }

         if (pending.remove(candidate.getKey(), candidate.getValue())) {
            candidate.getValue().cancelTimer();
            candidate.getValue().future().completeExceptionally(new UiSdkException(UiError.BRIDGE_UNAVAILABLE,
               "The editor window '" + value + "' disconnected before answering."));
            released++;
         }
      }

      return released;
   }

   @Override
   public CompletableFuture<UiResponse> sendToBrowser(UiRequest request) {
      CompletableFuture<UiResponse> future = new CompletableFuture<>();
      if (request == null || request.getAction() == null) {
         future.completeExceptionally(new UiSdkException(UiError.INVALID_PAYLOAD, "A request needs an action name."));
         return future;
      }

      if (shutdown) {
         future.completeExceptionally(new UiSdkException(UiError.BRIDGE_UNAVAILABLE, "The UI SDK runtime is shut down."));
         return future;
      }

      UiBrowserTransport transport = pickTransport();
      if (transport == null) {
         future.completeExceptionally(new UiSdkException(UiError.BRIDGE_UNAVAILABLE,
            "No browser transport is connected — open the editor UI and retry."));
         return future;
      }

      String clientId = request.getClientId() != null ? request.getClientId() : preferredBrowserClientId();
      if (clientId == null) {
         future.completeExceptionally(new UiSdkException(UiError.NO_BROWSER_CLIENT,
            "No Eaze Editor window has registered with the UI SDK yet."));
         return future;
      }

      // No deadline unless the caller opted into one: a dialogue waits as long as the human needs it.
      long timeoutMs = request.getTimeoutMs();
      ScheduledFuture<?> timer = timeoutMs > 0L
         ? timeouts.schedule(() -> expire(request.getId(), timeoutMs), timeoutMs, TimeUnit.MILLISECONDS)
         : null;

      PendingEntry entry = new PendingEntry(future, timer, clientId);
      PendingEntry previous = pending.putIfAbsent(request.getId(), entry);
      if (previous != null) {
         entry.cancelTimer();
         future.completeExceptionally(new UiSdkException(UiError.INVALID_PAYLOAD,
            "Duplicate request id '" + request.getId() + "'."));
         return future;
      }

      try {
         if (!transport.send(clientId, request.toMap())) {
            completeExceptionally(request.getId(), UiError.BRIDGE_UNAVAILABLE,
               "The browser transport could not deliver the request.");
         }
      } catch (RuntimeException e) {
         completeExceptionally(request.getId(), UiError.BRIDGE_UNAVAILABLE, String.valueOf(e.getMessage()));
      }

      return future;
   }

   @Override
   public boolean completePending(UiResponse response) {
      if (response == null || response.getId() == null) {
         return false;
      }

      PendingEntry entry = pending.remove(response.getId());
      if (entry == null) {
         return false;
      }

      entry.cancelTimer();
      entry.future().complete(response);
      return true;
   }

   @Override
   public boolean publishEvent(String action, Object payload, String sourcePluginId) {
      if (action == null || action.trim().isEmpty()) {
         return false;
      }

      String name = action.trim();
      bus.publishEvent(name, payload, sourcePluginId);

      Map<String, Object> envelope = new java.util.LinkedHashMap<>();
      envelope.put("id", UiRequest.newId());
      envelope.put("type", "eaze-ui-event");
      envelope.put("action", name);
      envelope.put("sourcePluginId", sourcePluginId == null ? "java" : sourcePluginId);
      envelope.put("payload", payload == null ? Map.of() : payload);

      boolean delivered = false;
      for (UiBrowserTransport transport : transports) {
         if (!transport.isAvailable()) {
            continue;
         }

         try {
            delivered |= transport.send(null, envelope);
         } catch (RuntimeException e) {
            // one broken transport must not stop the others
         }
      }
      return delivered;
   }

   @Override
   public void ingestBrowserEvent(String action, Object payload, String sourcePluginId) {
      if (action != null && !action.trim().isEmpty()) {
         bus.publishEvent(action.trim(), payload, sourcePluginId);
      }
   }

   // ------------------------------------------------------------------ //
   // Inbound browser traffic
   // ------------------------------------------------------------------ //

   @Override
   public CompletableFuture<UiResponse> handleBrowserRequest(UiRequest request) {
      if (request == null) {
         return CompletableFuture.completedFuture(
            UiResponse.error(null, null, UiError.INVALID_PAYLOAD, "Empty envelope."));
      }

      registerBrowserClient(request.getClientId());
      return bus.invokeAsync(request, inbound);
   }

   // ------------------------------------------------------------------ //
   // Native capabilities
   // ------------------------------------------------------------------ //

   @Override
   public PathSelectionResult selectPath(PathSelectionRequest request) {
      PathSelectionRequest safe = request == null ? new PathSelectionRequest() : request;
      NativePathProvider provider = nativePathProvider;

      if (provider == null || !provider.isAvailable()) {
         return PathSelectionResult.error(UiError.NATIVE_UNAVAILABLE,
            "This host does not provide a native path picker.");
      }

      try {
         PathSelectionResult result = provider.select(safe);
         return result == null ? PathSelectionResult.cancelled(safe.normalizedMode()) : result;
      } catch (RuntimeException e) {
         return PathSelectionResult.error("PICKER_FAILED", String.valueOf(e.getMessage()));
      }
   }

   @Override
   public boolean isNativePathSelectionAvailable() {
      NativePathProvider provider = nativePathProvider;
      return provider != null && provider.isAvailable();
   }

   @Override
   public void setNativePathProvider(NativePathProvider provider) {
      this.nativePathProvider = provider;
   }

   // ------------------------------------------------------------------ //
   // Lifecycle
   // ------------------------------------------------------------------ //

   @Override
   public void shutdown() {
      shutdown = true;
      for (PendingEntry entry : pending.values()) {
         entry.cancelTimer();
         // Not a deadline expiring: the channel itself is going away. TIMEOUT would tell a plugin that the
         // human was too slow, which is exactly what this SDK no longer ever claims without an opt-in.
         entry.future().completeExceptionally(new UiSdkException(UiError.BRIDGE_UNAVAILABLE,
            "The UI SDK runtime is shut down."));
      }
      pending.clear();
      timeouts.shutdownNow();
      inbound.shutdownNow();
   }

   // ------------------------------------------------------------------ //
   // Internals
   // ------------------------------------------------------------------ //

   private void registerBuiltinHandlers() {
      bus.subscribe(ACTION_SELECT_NATIVE_PATH, "eaze-ui-sdk", request -> {
         PathSelectionRequest selection = PathSelectionRequest.fromMap(request.getPayload());
         if (selection.getSourcePluginId() == null) {
            selection.setSourcePluginId(request.getSourcePluginId());
         }

         PathSelectionResult result = selectPath(selection);
         if (result.isSelected()) {
            return result.toMap();
         }
         throw new UiSdkException(
            result.getErrorCode() == null ? UiError.CANCELLED : result.getErrorCode(),
            result.getErrorMessage() == null ? "No path was selected." : result.getErrorMessage(),
            result.toMap());
      });

      bus.subscribe(ACTION_CAPABILITIES, "eaze-ui-sdk", request -> capabilities());
   }

   private UiBrowserTransport pickTransport() {
      for (UiBrowserTransport transport : transports) {
         if (transport.isAvailable()) {
            return transport;
         }
      }
      return null;
   }

   private void expire(String requestId, long timeoutMs) {
      PendingEntry entry = pending.remove(requestId);
      if (entry == null) {
         return;
      }

      entry.cancelTimer();
      entry.future().complete(UiResponse.error(requestId, null, UiError.TIMEOUT,
         "The browser UI did not answer within " + timeoutMs + " ms."));
   }

   private void completeExceptionally(String requestId, String code, String message) {
      PendingEntry entry = pending.remove(requestId);
      if (entry != null) {
         entry.cancelTimer();
         entry.future().completeExceptionally(new UiSdkException(code, message));
      }
   }

   private record PendingEntry(CompletableFuture<UiResponse> future, ScheduledFuture<?> timer, String clientId) {
      void cancelTimer() {
         if (timer != null) {
            timer.cancel(false);
         }
      }
   }

   private static ThreadFactory daemonFactory(String name) {
      return runnable -> {
         Thread thread = new Thread(runnable, name);
         thread.setDaemon(true);
         return thread;
      };
   }
}
