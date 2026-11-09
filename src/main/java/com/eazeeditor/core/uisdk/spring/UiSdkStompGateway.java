package com.eazeeditor.core.uisdk.spring;

import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import com.eazeeditor.core.uisdk.runtime.UiRuntime;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;

/**
 * The browser-facing door of the app-level bridge.
 *
 * <p>Browsers publish envelopes to {@code /app/eaze-ui-sdk/request}; this
 * controller routes them:
 *
 * <ul>
 *   <li>{@code eaze-ui-request} → dispatched on the JVM bus, reply published back
 *       on the caller's own topic ({@code /topic/eaze-ui-sdk/client/{clientId}}),</li>
 *   <li>{@code eaze-ui-response} → correlated with a pending JVM request by id,</li>
 *   <li>{@code eaze-ui-event} → handed to JVM observers.</li>
 * </ul>
 *
 * Everything is request-id correlated over one persistent channel — no HTTP API,
 * no polling.
 */
@Controller
public class UiSdkStompGateway {

   private static final Logger log = LoggerFactory.getLogger(UiSdkStompGateway.class);

   private static final String TYPE_REQUEST = "eaze-ui-request";
   private static final String TYPE_RESPONSE = "eaze-ui-response";
   private static final String TYPE_EVENT = "eaze-ui-event";

   private final UiRuntime runtime;
   private final SimpMessagingTemplate messaging;

   public UiSdkStompGateway(UiRuntime runtime, SimpMessagingTemplate messaging) {
      this.runtime = runtime;
      this.messaging = messaging;
   }

   /** Single entry point for every envelope coming from an editor window. */
   @MessageMapping(UiSdkChannels.REQUEST_DESTINATION)
   public void onEnvelope(Map<String, Object> envelope) {
      if (envelope == null || envelope.isEmpty()) {
         return;
      }

      String clientId = trimToNull(envelope.get("clientId"));
      runtime.touchClient(clientId);

      String type = normalizeType(envelope.get("type"));
      if (TYPE_RESPONSE.equals(type)) {
         runtime.completePending(UiResponse.fromMap(envelope));
         return;
      }

      if (TYPE_EVENT.equals(type)) {
         runtime.ingestBrowserEvent(
            asString(envelope.get("action")),
            envelope.get("payload"),
            asString(envelope.get("sourcePluginId")));
         return;
      }

      if (!TYPE_REQUEST.equals(type)) {
         log.debug("Ignoring UI SDK envelope with unknown type '{}'", type);
         return;
      }

      UiRequest request = UiRequest.fromMap(envelope).withClientId(clientId);
      runtime.handleBrowserRequest(request).thenAccept(response -> replyTo(clientId, response));
   }

   private void replyTo(String clientId, UiResponse response) {
      if (response == null || response.getId() == null) {
         return;
      }

      String destination = trimToNull(clientId) == null ? null : UiSdkChannels.clientTopic(clientId);
      if (destination == null) {
         log.warn("Dropping UI SDK reply '{}' — the request carried no clientId.", response.getId());
         return;
      }

      try {
         messaging.convertAndSend(destination, response.toMap());
      } catch (RuntimeException e) {
         log.warn("Failed to deliver UI SDK reply {} to {}: {}", response.getId(), destination, e.getMessage());
      }
   }

   private static String normalizeType(Object value) {
      String raw = asString(value);
      return raw == null ? TYPE_REQUEST : raw.trim().toLowerCase(java.util.Locale.ROOT);
   }

   private static String asString(Object value) {
      return value == null ? null : String.valueOf(value);
   }

   private static String trimToNull(Object value) {
      String raw = asString(value);
      if (raw == null) {
         return null;
      }

      String trimmed = raw.trim();
      return trimmed.isEmpty() ? null : trimmed;
   }
}
