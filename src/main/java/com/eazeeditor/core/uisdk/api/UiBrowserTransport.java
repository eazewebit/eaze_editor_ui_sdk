package com.eazeeditor.core.uisdk.api;

import java.util.Map;

/**
 * Application-level relay between the JVM bus and a browser window running the
 * JS half of the SDK.
 *
 * <p>This is deliberately <em>not</em> an HTTP API: implementations push
 * envelopes over a long-lived channel (the host's STOMP/WebSocket broker today,
 * an embedded webview message handler tomorrow).  Adding a new transport never
 * touches plugin code.
 */
public interface UiBrowserTransport {

   /** Stable identifier, useful for diagnostics ({@code "stomp"}, {@code "webview"}). */
   String id();

   /** False while the channel is down; the runtime then fails fast instead of queueing forever. */
   boolean isAvailable();

   /**
    * Deliver one envelope to the browser.
    *
    * @param clientId target browser session, or {@code null} to broadcast to every window
    * @param envelope a request / response / event map produced by the SDK core
    * @return true when the envelope was accepted by the channel
    */
   boolean send(String clientId, Map<String, Object> envelope);

   /** Lower priority wins when several transports are registered. */
   default int priority() {
      return 100;
   }
}
