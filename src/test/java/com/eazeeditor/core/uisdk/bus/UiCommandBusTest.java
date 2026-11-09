package com.eazeeditor.core.uisdk.bus;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.eazeeditor.core.uisdk.api.UiError;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class UiCommandBusTest {

   @Test
   @DisplayName("first registered handler owns the action and its result is returned")
   void firstHandlerWins() {
      UiCommandBus bus = new UiCommandBus();
      AtomicInteger calls = new AtomicInteger();

      bus.subscribe("demo.echo", "a", request -> {
         calls.incrementAndGet();
         return Map.of("echo", request.getAction());
      });
      bus.subscribe("demo.echo", "b", request -> "never");

      UiResponse response = bus.invoke(UiRequest.jvm("demo.echo", Map.of(), "caller"));

      assertTrue(response.isOk());
      assertEquals(1, calls.get());
      assertEquals("demo.echo", ((Map<?, ?>) response.getResult()).get("echo"));
   }

   @Test
   @DisplayName("a null result is a success, not a fall-through")
   void nullResultIsSuccess() {
      UiCommandBus bus = new UiCommandBus();
      AtomicInteger second = new AtomicInteger();

      bus.subscribe("demo.void", request -> null);
      bus.subscribe("demo.void", request -> second.incrementAndGet());

      UiResponse response = bus.invoke(UiRequest.jvm("demo.void", Map.of(), "caller"));

      assertTrue(response.isOk());
      assertEquals(0, second.get());
   }

   @Test
   @DisplayName("unknown actions answer NO_HANDLER instead of throwing")
   void unknownAction() {
      UiCommandBus bus = new UiCommandBus();
      UiResponse response = bus.invoke(UiRequest.jvm("demo.missing", Map.of(), "caller"));

      assertFalse(response.isOk());
      assertEquals(UiError.NO_HANDLER, response.getError().getCode());
   }

   @Test
   @DisplayName("handler exceptions become structured error responses")
   void handlerErrors() {
      UiCommandBus bus = new UiCommandBus();
      bus.subscribe("demo.boom", request -> {
         throw new IllegalStateException("kaboom");
      });

      UiResponse response = bus.invoke(UiRequest.jvm("demo.boom", Map.of(), "caller"));

      assertFalse(response.isOk());
      assertEquals(UiError.HANDLER_ERROR, response.getError().getCode());
      assertEquals("kaboom", response.getError().getMessage());
   }

   @Test
   @DisplayName("unsubscribeAllOf drops exactly one plugin's handlers")
   void ownerCleanup() {
      UiCommandBus bus = new UiCommandBus();
      bus.subscribe("demo.a", "plugin-x", request -> "x");
      bus.subscribe("demo.b", "plugin-y", request -> "y");

      assertEquals(1, bus.unsubscribeAllOf("plugin-x"));
      assertFalse(bus.hasHandler("demo.a"));
      assertTrue(bus.hasHandler("demo.b"));
   }

   @Test
   @DisplayName("wildcard observers see every event, exact ones only their own")
   void eventObservation() {
      UiCommandBus bus = new UiCommandBus();
      AtomicInteger seen = new AtomicInteger();
      AtomicInteger all = new AtomicInteger();

      bus.observe("demo.tick", (event, payload, source) -> seen.incrementAndGet());
      bus.observe(UiCommandBus.WILDCARD, (event, payload, source) -> all.incrementAndGet());

      assertEquals(2, bus.publishEvent("demo.tick", Map.of("n", 1), "tester"));
      assertEquals(1, bus.publishEvent("demo.other", null, "tester"));

      assertEquals(1, seen.get());
      assertEquals(2, all.get());
   }
}
