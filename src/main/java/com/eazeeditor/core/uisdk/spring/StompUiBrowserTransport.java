package com.eazeeditor.core.uisdk.spring;

import com.eazeeditor.core.uisdk.api.UiBrowserTransport;
import java.util.Map;
import org.springframework.messaging.simp.SimpMessagingTemplate;

/**
 * Application-level transport: pushes SDK envelopes into browser windows over
 * the host's STOMP broker (a long-lived WebSocket/SockJS channel).  No REST
 * endpoint is involved in either direction.
 */
public class StompUiBrowserTransport implements UiBrowserTransport {

   public static final String ID = "stomp";

   private final SimpMessagingTemplate messaging;
   private volatile boolean enabled = true;

   public StompUiBrowserTransport(SimpMessagingTemplate messaging) {
      this.messaging = messaging;
   }

   @Override
   public String id() {
      return ID;
   }

   @Override
   public boolean isAvailable() {
      return enabled && messaging != null;
   }

   /** Flip to false (e.g. broker disabled hosts) to make the runtime fail fast. */
   public void setEnabled(boolean value) {
      this.enabled = value;
   }

   @Override
   public boolean send(String clientId, Map<String, Object> envelope) {
      if (!isAvailable() || envelope == null) {
         return false;
      }

      String destination = (clientId == null || clientId.trim().isEmpty())
         ? UiSdkChannels.EVENTS_TOPIC
         : UiSdkChannels.clientTopic(clientId);

      try {
         messaging.convertAndSend(destination, envelope);
         return true;
      } catch (RuntimeException e) {
         return false;
      }
   }
}
