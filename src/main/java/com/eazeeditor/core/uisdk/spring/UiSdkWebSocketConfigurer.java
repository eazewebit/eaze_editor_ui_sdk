package com.eazeeditor.core.uisdk.spring;

import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

/**
 * Registers the SDK's own SockJS endpoint so hosts do not have to touch their
 * existing {@code WebSocketConfig}.  Spring applies <em>every</em>
 * {@link WebSocketMessageBrokerConfigurer} bean, so this simply adds
 * {@value UiSdkChannels#WEBSOCKET_ENDPOINT} next to the host's endpoints.
 */
public class UiSdkWebSocketConfigurer implements WebSocketMessageBrokerConfigurer {

   private final String endpoint;

   public UiSdkWebSocketConfigurer() {
      this(UiSdkChannels.WEBSOCKET_ENDPOINT);
   }

   public UiSdkWebSocketConfigurer(String endpoint) {
      this.endpoint = (endpoint == null || endpoint.trim().isEmpty())
         ? UiSdkChannels.WEBSOCKET_ENDPOINT
         : endpoint.trim();
   }

   @Override
   public void registerStompEndpoints(StompEndpointRegistry registry) {
      registry.addEndpoint(endpoint).withSockJS();
   }

   public String endpoint() {
      return endpoint;
   }
}
