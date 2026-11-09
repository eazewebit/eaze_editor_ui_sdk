package com.eazeeditor.core.uisdk.spring;

/**
 * Wire names of the app-level bridge.  They are shared verbatim with
 * {@code eaze_ui_sdk_bridge.js}; changing one without the other breaks the SDK.
 */
public final class UiSdkChannels {

   /** SockJS endpoint added by this module (host keeps its own {@code /ws}). */
   public static final String WEBSOCKET_ENDPOINT = "/ws/eaze-ui-sdk";

   /** App destination browsers publish to (Spring prefixes it with {@code /app}). */
   public static final String REQUEST_DESTINATION = "/eaze-ui-sdk/request";

   /** Per-window reply/event topic. */
   public static final String CLIENT_TOPIC_PREFIX = "/topic/eaze-ui-sdk/client/";

   /** Broadcast topic every editor window subscribes to. */
   public static final String EVENTS_TOPIC = "/topic/eaze-ui-sdk/events";

   private UiSdkChannels() {
   }

   public static String clientTopic(String clientId) {
      return CLIENT_TOPIC_PREFIX + (clientId == null ? "" : clientId.trim());
   }
}
