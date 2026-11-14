package com.eazeeditor.core.uisdk.spring;

import com.eazeeditor.core.uisdk.EazeUiSdk;
import com.eazeeditor.core.uisdk.api.NativePathProvider;
import com.eazeeditor.core.uisdk.runtime.DefaultUiRuntime;
import com.eazeeditor.core.uisdk.runtime.UiPluginScope;
import com.eazeeditor.core.uisdk.runtime.UiRuntime;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.SimpMessagingTemplate;

/**
 * Spring Boot wiring for the UI SDK.  Dropping {@code eaze_editor_ui_sdk} on the
 * classpath is all a Spring host has to do:
 *
 * <ol>
 *   <li>a {@link UiRuntime} is created (using any {@link NativePathProvider} bean
 *       the host exposes) and installed into {@link EazeUiSdk};</li>
 *   <li>the STOMP transport + gateway are registered — app-level messaging over
 *       the existing broker, deliberately <em>not</em> a REST API;</li>
 *   <li>an extra SockJS endpoint ({@code /ws/eaze-ui-sdk}) is added without
 *       touching the host's own {@code WebSocketConfig}.</li>
 *   <li>window presence is tracked on the socket: a disconnect releases every request still waiting on that
 *       window, so no plugin thread hangs behind a closed editor.</li>
 * </ol>
 */
@AutoConfiguration
public class EazeUiSdkAutoConfiguration {

   @Bean(destroyMethod = "shutdown")
   @ConditionalOnMissingBean(UiRuntime.class)
   public UiRuntime eazeUiRuntime(ObjectProvider<NativePathProvider> nativePathProviders) {
      DefaultUiRuntime runtime = new DefaultUiRuntime(nativePathProviders.getIfAvailable());
      EazeUiSdk.install(runtime, true);
      return runtime;
   }

   /** Convenience injection point: {@code @Autowired UiPluginScope hostUi}. */
   @Bean
   @ConditionalOnMissingBean
   @ConditionalOnBean(UiRuntime.class)
   public UiPluginScope eazeUiHostScope() {
      return EazeUiSdk.host();
   }

   @Configuration(proxyBeanMethods = false)
   @ConditionalOnClass(name = "org.springframework.messaging.simp.SimpMessagingTemplate")
   static class StompBridgeConfiguration {

      @Bean
      @ConditionalOnMissingBean
      public StompUiBrowserTransport stompUiBrowserTransport(UiRuntime runtime, SimpMessagingTemplate messaging) {
         StompUiBrowserTransport transport = new StompUiBrowserTransport(messaging);
         runtime.registerTransport(transport);
         return transport;
      }

      @Bean
      @ConditionalOnMissingBean
      public UiSdkStompGateway uiSdkStompGateway(UiRuntime runtime, SimpMessagingTemplate messaging) {
         return new UiSdkStompGateway(runtime, messaging);
      }
   }

   /**
    * Window presence over the STOMP socket — bind each editor window to its session and release the requests
    * still addressed to it when that socket disconnects.  Needs spring-websocket for the session events, hence
    * a guard of its own: a messaging-only host still gets transport + gateway.
    */
   @Configuration(proxyBeanMethods = false)
   @ConditionalOnClass(name = {
      "org.springframework.messaging.simp.SimpMessagingTemplate",
      "org.springframework.web.socket.messaging.SessionDisconnectEvent" })
   static class StompSessionLifecycleConfiguration {

      @Bean
      @ConditionalOnMissingBean
      public UiSdkSessionListener uiSdkSessionListener(UiRuntime runtime) {
         return new UiSdkSessionListener(runtime);
      }
   }

   @Configuration(proxyBeanMethods = false)
   @ConditionalOnClass(name = "org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer")
   static class WebSocketEndpointConfiguration {

      @Bean
      @ConditionalOnMissingBean
      public UiSdkWebSocketConfigurer uiSdkWebSocketConfigurer() {
         return new UiSdkWebSocketConfigurer();
      }
   }
}
