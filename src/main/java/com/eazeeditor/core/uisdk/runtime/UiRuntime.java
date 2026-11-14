package com.eazeeditor.core.uisdk.runtime;

import com.eazeeditor.core.uisdk.api.NativePathProvider;
import com.eazeeditor.core.uisdk.api.UiBrowserTransport;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import com.eazeeditor.core.uisdk.bus.UiCommandBus;
import com.eazeeditor.core.uisdk.model.PathSelectionRequest;
import com.eazeeditor.core.uisdk.model.PathSelectionResult;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The host-side engine of the UI SDK: bus + browser transports + native
 * capabilities, glued together with request-id correlation.
 *
 * <p>The host installs exactly one instance through
 * {@code EazeUiSdk.install(runtime)} (Spring hosts get that from the module's
 * auto-configuration).  Plugins never implement or hold on to this type — they
 * use {@link UiPluginScope}.
 */
public interface UiRuntime {

   String version();

   /** Capability snapshot exposed as {@code ui.nativeCapabilities}. */
   Map<String, Object> capabilities();

   UiCommandBus bus();

   // ------------------------------------------------------------------ //
   // Browser channel
   // ------------------------------------------------------------------ //

   void registerTransport(UiBrowserTransport transport);

   void unregisterTransport(UiBrowserTransport transport);

   boolean hasBrowserTransport();

   /** Remember a browser session so JVM-initiated requests have somewhere to go. */
   void registerBrowserClient(String clientId);

   /** Most recently seen browser session, or {@code null}. */
   String preferredBrowserClientId();

   /** Keep routing information fresh for an envelope that arrived from the window. */
   void touchClient(String clientId);

   /**
    * A browser window went away: forget it and fail every pending request addressed to it with
    * {@link com.eazeeditor.core.uisdk.api.UiError#BRIDGE_UNAVAILABLE} so threads blocked on an unanswered
    * dialogue resume instead of waiting forever — dialogues carry no deadline by default, therefore the
    * transport has to report a lost window itself.  The STOMP layer calls this when a socket disconnects.
    *
    * <p>Runtimes that do not track windows keep the inherited no-op; such a request then stays pending.
    *
    * @return how many pending requests were released (0 when nothing was outstanding for this client)
    */
   default int releaseBrowserClient(String clientId) {
      return 0;
   }

   /**
    * Send a request to the browser UI and complete when the matching response
    * arrives (correlated by id).  A request carries <em>no</em> deadline unless it was built with
    * {@link com.eazeeditor.core.uisdk.api.UiRequest#withTimeout(long)} — an unanswered dialogue simply
    * stays pending for as long as the human needs it.  Completes exceptionally with
    * {@link com.eazeeditor.core.uisdk.api.UiSdkException} on an expired deadline / no channel.
    */
   CompletableFuture<UiResponse> sendToBrowser(UiRequest request);

   /** Correlate an inbound response for a JVM-initiated request. True when it matched. */
   boolean completePending(UiResponse response);

   /** Fire-and-forget event to every browser window <em>and</em> local observers. */
   boolean publishEvent(String action, Object payload, String sourcePluginId);

   /** Event that came <em>from</em> a browser window: notify JVM observers only (no echo back). */
   void ingestBrowserEvent(String action, Object payload, String sourcePluginId);

   // ------------------------------------------------------------------ //
   // Inbound traffic from the browser
   // ------------------------------------------------------------------ //

   /** Dispatch a browser request on the JVM bus; reply envelope is produced asynchronously. */
   CompletableFuture<UiResponse> handleBrowserRequest(UiRequest request);

   // ------------------------------------------------------------------ //
   // Native capabilities
   // ------------------------------------------------------------------ //

   /** Blocking native picker; never throws (failures arrive as {@code ERROR} results). */
   PathSelectionResult selectPath(PathSelectionRequest request);

   boolean isNativePathSelectionAvailable();

   /** Optional host override for the native chooser. */
   void setNativePathProvider(NativePathProvider provider);

   /** Release threads/pending futures (host shutdown). */
   void shutdown();
}
