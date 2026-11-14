package com.eazeeditor.core.uisdk.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.eazeeditor.core.uisdk.api.UiBrowserTransport;
import com.eazeeditor.core.uisdk.api.UiError;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import com.eazeeditor.core.uisdk.api.UiSdkException;
import com.eazeeditor.core.uisdk.runtime.DefaultUiRuntime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.Message;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.support.GenericMessage;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;
import org.springframework.web.socket.messaging.SessionSubscribeEvent;

/**
 * Window presence over the STOMP socket, driven with <em>real</em> Spring event objects: a hand-rolled stub
 * would hide exactly the API mistakes this area makes (e.g. {@code SessionSubscribeEvent} carries no session
 * id — it has to come out of the message headers).
 */
class UiSdkSessionListenerTest {

   private static final class FakeTransport implements UiBrowserTransport {
      private final List<Map<String, Object>> sent = Collections.synchronizedList(new ArrayList<>());

      @Override
      public String id() {
         return "fake";
      }

      @Override
      public boolean isAvailable() {
         return true;
      }

      @Override
      public boolean send(String clientId, Map<String, Object> envelope) {
         sent.add(envelope);
         return true;
      }
   }

   private static Message<byte[]> subscribeFrame(String sessionId, String destination) {
      return new GenericMessage<>(new byte[0], Map.of(
         SimpMessageHeaderAccessor.SESSION_ID_HEADER, sessionId,
         SimpMessageHeaderAccessor.DESTINATION_HEADER, destination));
   }

   private static void subscribe(UiSdkSessionListener listener, String sessionId, String destination) {
      listener.onSubscribe(new SessionSubscribeEvent(new Object(), subscribeFrame(sessionId, destination)));
   }

   private static SessionDisconnectEvent disconnect(String sessionId) {
      return new SessionDisconnectEvent(new Object(), new GenericMessage<>(new byte[0]), sessionId, CloseStatus.NORMAL);
   }

   @Test
   @DisplayName("SUBSCRIBE to the per-window topic binds that socket to the window")
   void subscribeBindsWindowToSocket() {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      UiSdkSessionListener listener = new UiSdkSessionListener(runtime);

      subscribe(listener, "session-a", UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-1");

      assertEquals("browser-1", listener.sessions().clientIdOf("session-a"));
      assertTrue(((List<?>) runtime.capabilities().get("browserClients")).contains("browser-1"),
         "the SUBSCRIBE alone makes the window reachable for JVM-initiated traffic");
   }

   @Test
   @DisplayName("subscriptions to anything else never create a window")
   void foreignSubscriptionsAreIgnored() {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      UiSdkSessionListener listener = new UiSdkSessionListener(runtime);

      subscribe(listener, "session-a", UiSdkChannels.EVENTS_TOPIC);
      subscribe(listener, "session-b", "/topic/some-host-topic");
      subscribe(listener, "session-c", UiSdkChannels.CLIENT_TOPIC_PREFIX);

      assertEquals(0, listener.sessions().trackedSessions());
      assertNull(listener.sessions().clientIdOf("session-a"));
   }

   @Test
   @DisplayName("disconnecting the window's socket releases its pending dialogue with BRIDGE_UNAVAILABLE")
   void disconnectReleasesThePendingDialogue() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      FakeTransport transport = new FakeTransport();
      UiSdkSessionListener listener = new UiSdkSessionListener(runtime);

      subscribe(listener, "session-a", UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-1");
      runtime.registerTransport(transport);

      CompletableFuture<UiResponse> dialogue =
         runtime.sendToBrowser(UiRequest.jvm("ui.showForm", Map.of("title", "Still open?"), "test-plugin"));
      assertEquals(1, ((Number) runtime.capabilities().get("pendingRequests")).intValue());

      listener.onDisconnect(disconnect("session-a"));

      ExecutionException execution = assertThrows(ExecutionException.class, () -> dialogue.get(2, TimeUnit.SECONDS));
      UiSdkException failure = assertInstanceOf(UiSdkException.class, execution.getCause());
      assertEquals(UiError.BRIDGE_UNAVAILABLE, failure.getCode());

      assertEquals(0, ((Number) runtime.capabilities().get("pendingRequests")).intValue());
      assertFalse(((List<?>) runtime.capabilities().get("browserClients")).contains("browser-1"));
      assertEquals(0, listener.sessions().trackedSessions());
   }

   @Test
   @DisplayName("a reconnect makes the old socket harmless — only losing the live one releases")
   void staleSocketAfterReconnectReleasesNothing() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      FakeTransport transport = new FakeTransport();
      UiSdkSessionListener listener = new UiSdkSessionListener(runtime);

      subscribe(listener, "session-a", UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-1");
      runtime.registerTransport(transport);

      CompletableFuture<UiResponse> dialogue =
         runtime.sendToBrowser(UiRequest.jvm("ui.confirm", Map.of("title", "Hold on"), "test-plugin"));

      // Same tab reconnects, then the broker finally reports the dead socket.
      subscribe(listener, "session-b", UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-1");
      listener.onDisconnect(disconnect("session-a"));

      assertFalse(dialogue.isDone(), "the dialogue is still reachable on the new socket");
      assertEquals(1, ((Number) runtime.capabilities().get("pendingRequests")).intValue());

      listener.onDisconnect(disconnect("session-b"));
      ExecutionException execution = assertThrows(ExecutionException.class, () -> dialogue.get(2, TimeUnit.SECONDS));
      UiSdkException failure = assertInstanceOf(UiSdkException.class, execution.getCause());
      assertEquals(UiError.BRIDGE_UNAVAILABLE, failure.getCode());
   }

   @Test
   @DisplayName("only the per-window topic yields a clientId")
   void destinationParsing() {
      assertEquals("browser-9", UiSdkSessionListener.clientIdFromDestination(
         UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-9"));
      assertNull(UiSdkSessionListener.clientIdFromDestination(null));
      assertNull(UiSdkSessionListener.clientIdFromDestination(UiSdkChannels.EVENTS_TOPIC));
      assertNull(UiSdkSessionListener.clientIdFromDestination(UiSdkChannels.CLIENT_TOPIC_PREFIX));
      assertNull(UiSdkSessionListener.clientIdFromDestination(UiSdkChannels.CLIENT_TOPIC_PREFIX + "   "));
   }

   @Test
   @DisplayName("a reconnect re-registers the window, so JVM-initiated requests find it without traffic from it")
   void resubscribeRestoresJvmRouting() throws Exception {
      DefaultUiRuntime runtime = new DefaultUiRuntime();
      FakeTransport transport = new FakeTransport();
      UiSdkSessionListener listener = new UiSdkSessionListener(runtime);

      subscribe(listener, "session-a", UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-1");
      runtime.registerTransport(transport);
      assertEquals("browser-1", runtime.preferredBrowserClientId(), "SUBSCRIBE alone announces the window");

      listener.onDisconnect(disconnect("session-a"));
      assertNull(runtime.preferredBrowserClientId(), "a lost window must stop receiving requests");

      // The tab comes back on a fresh socket and stays silent — the JVM still has to find it.
      subscribe(listener, "session-b", UiSdkChannels.CLIENT_TOPIC_PREFIX + "browser-1");
      assertEquals("browser-1", runtime.preferredBrowserClientId());

      CompletableFuture<UiResponse> dialogue =
         runtime.sendToBrowser(UiRequest.jvm("ui.showForm", Map.of("title", "Back again"), "test-plugin"));
      assertEquals(1, transport.sent.size(), "the request travels over the fresh socket");

      String requestId = String.valueOf(transport.sent.get(0).get("id"));
      runtime.completePending(UiResponse.ok(requestId, "ui.showForm", Map.of("value", "answered")));

      UiResponse answered = dialogue.get(2, TimeUnit.SECONDS);
      assertTrue(answered.isOk(), "the window that never said a word still answers the dialogue");
   }
}
