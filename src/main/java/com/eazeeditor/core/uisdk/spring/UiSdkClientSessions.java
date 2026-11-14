package com.eazeeditor.core.uisdk.spring;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Which STOMP socket currently serves which SDK window ({@code clientId}).
 *
 * <p>Every editor window subscribes to its own topic
 * ({@code /topic/eaze-ui-sdk/client/{clientId}}), so a SUBSCRIBE frame is the authoritative statement
 * "this socket <em>is</em> that window".  A {@code clientId} outlives reconnects (the browser keeps it in
 * {@code sessionStorage}) while sessions do not, hence <b>latest wins</b>: when a tab reconnects its new
 * session takes over and the stale one must release nothing — an open dialogue can still be answered over
 * the fresh socket.  Only the loss of the last known session means the window is really gone.
 *
 * <p>Deliberately Spring-free: these routing rules are unit-testable without a broker, and any future
 * transport (Electron IPC, WebView2) can reuse them verbatim.
 */
public final class UiSdkClientSessions {

   private final ConcurrentMap<String, String> sessionToClient = new ConcurrentHashMap<>();
   private final ConcurrentMap<String, String> clientToSession = new ConcurrentHashMap<>();

   /**
    * Remember that {@code sessionId} is the socket of window {@code clientId}.  Null/blank input is ignored;
    * re-binding replaces the previous session for that client and drops its now-meaningless reverse entry.
    */
   public void bind(String clientId, String sessionId) {
      String client = trimToNull(clientId);
      String session = trimToNull(sessionId);
      if (client == null || session == null) {
         return;
      }

      String stale = clientToSession.put(client, session);
      if (stale != null && !stale.equals(session)) {
         sessionToClient.remove(stale);
      }
      sessionToClient.put(session, client);
   }

   /**
    * A socket closed.  Returns the window that lost its <em>last</em> known session — and can therefore never
    * answer an outstanding request again — or {@code null} when the socket was unknown to the SDK (the host's
    * own WebSocket sessions) or already replaced by a reconnect.
    */
   public String onSessionClosed(String sessionId) {
      String session = trimToNull(sessionId);
      if (session == null) {
         return null;
      }

      String client = sessionToClient.remove(session);
      if (client == null) {
         return null;
      }

      // A newer session owns this window now: keep its pending requests alive across the reconnect.
      return clientToSession.remove(client, session) ? client : null;
   }

   /** Window served by {@code sessionId}, or {@code null}. */
   public String clientIdOf(String sessionId) {
      String session = trimToNull(sessionId);
      return session == null ? null : sessionToClient.get(session);
   }

   /** Number of tracked sockets (diagnostics/tests). */
   public int trackedSessions() {
      return sessionToClient.size();
   }

   private static String trimToNull(String value) {
      if (value == null) {
         return null;
      }

      String trimmed = value.trim();
      return trimmed.isEmpty() ? null : trimmed;
   }
}
