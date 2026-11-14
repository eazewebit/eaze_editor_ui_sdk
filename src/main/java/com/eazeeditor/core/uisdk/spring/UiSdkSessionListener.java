package com.eazeeditor.core.uisdk.spring;

import com.eazeeditor.core.uisdk.runtime.UiRuntime;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.socket.messaging.SessionSubscribeEvent;

/**
 * Turns STOMP session lifecycle events into UI SDK window presence.
 *
 * <ul>
 *   <li><b>SUBSCRIBE</b> to {@code /topic/eaze-ui-sdk/client/{clientId}} binds that socket to the window —
 *       the frame the bridge sends on every (re)connect, so routing survives reconnects without any extra
 *       protocol traffic.</li>
 *   <li><b>DISCONNECT</b> releases the window: {@link UiRuntime#releaseBrowserClient(String)} answers every
 *       request still addressed to it with {@code BRIDGE_UNAVAILABLE}.  A dialogue carries no deadline by
 *       default, so this is what stops a plugin thread from waiting forever behind an editor window that closed
 *       without answering.  A socket whose window already reconnected releases nothing — the fresh session
 *       inherited the routing and an open dialogue can still be answered.</li>
 * </ul>
 *
 * <p>A listener failure must never travel back into the broker's frame handling, so both handlers swallow
 * {@link RuntimeException} after logging it.
 */
public class UiSdkSessionListener {

   private static final Logger log = LoggerFactory.getLogger(UiSdkSessionListener.class);

   private final UiRuntime runtime;
   private final UiSdkClientSessions sessions = new UiSdkClientSessions();

   public UiSdkSessionListener(UiRuntime runtime) {
      this.runtime = runtime;
   }

   /** The session → window routing table, exposed for diagnostics. */
   public UiSdkClientSessions sessions() {
      return sessions;
   }

   @EventListener
   public void onSubscribe(SessionSubscribeEvent event) {
      try {
         Map<String, Object> headers = event.getMessage() == null ? null : event.getMessage().getHeaders();
         String clientId = clientIdFromDestination(
            headers == null ? null : SimpMessageHeaderAccessor.getDestination(headers));
         if (clientId == null) {
            return;   // the host's own topics / another library's subscriptions
         }

         String sessionId = SimpMessageHeaderAccessor.getSessionId(headers);
         sessions.bind(clientId, sessionId);
         // Presence follows the socket: a SUBSCRIBE is the window's own statement that it exists, so a
         // reconnecting tab becomes reachable for JVM-initiated traffic again without sending a request first.
         runtime.registerBrowserClient(clientId);
         log.debug("Editor window '{}' bound to session '{}'.", clientId, sessionId);
      } catch (RuntimeException e) {
         log.warn("Could not record UI SDK window routing: {}", e.getMessage());
      }
   }

   @EventListener
   public void onDisconnect(SessionDisconnectEvent event) {
      try {
         String clientId = sessions.onSessionClosed(event.getSessionId());
         if (clientId == null) {
            return;   // not an editor window, or a reconnect already took over
         }

         int released = runtime.releaseBrowserClient(clientId);
         log.info("Editor window '{}' disconnected — {} pending UI request(s) answered with BRIDGE_UNAVAILABLE.",
            clientId, released);
      } catch (RuntimeException e) {
         log.warn("Could not release UI SDK window for session '{}': {}", event.getSessionId(), e.getMessage());
      }
   }

   /** The {@code clientId} behind a per-window topic destination, or {@code null} for anything else. */
   static String clientIdFromDestination(String destination) {
      if (destination == null) {
         return null;
      }

      String trimmed = destination.trim();
      if (!trimmed.startsWith(UiSdkChannels.CLIENT_TOPIC_PREFIX)) {
         return null;
      }

      String clientId = trimmed.substring(UiSdkChannels.CLIENT_TOPIC_PREFIX.length()).trim();
      return clientId.isEmpty() ? null : clientId;
   }
}
