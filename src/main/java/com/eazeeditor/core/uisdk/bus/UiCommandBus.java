package com.eazeeditor.core.uisdk.bus;

import com.eazeeditor.core.uisdk.api.UiActionHandler;
import com.eazeeditor.core.uisdk.api.UiError;
import com.eazeeditor.core.uisdk.api.UiEventListener;
import com.eazeeditor.core.uisdk.api.UiRequest;
import com.eazeeditor.core.uisdk.api.UiResponse;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;

/**
 * In-JVM command bus: the single place where UI actions and events are
 * registered and dispatched.  It is transport-agnostic — the browser bridge,
 * other plugins and the host itself all look like peers on this one bus.
 *
 * <p><strong>Dispatch rule (JVM):</strong> the first handler registered for an
 * action owns it; a {@code null} return value means "done, no result" and does
 * <em>not</em> fall through to the next handler.  That keeps side-effecting
 * handlers from running twice.  The browser bus additionally lets listeners
 * intercept built-ins — see the module README.
 */
public final class UiCommandBus {

   /** Matches every action/event name. */
   public static final String WILDCARD = "*";

   private static final Executor DIRECT = Runnable::run;

   /** Handle returned by every registration. */
   public interface Subscription {
      String action();

      String ownerPluginId();

      boolean unsubscribe();
   }

   private record HandlerEntry(String action, String ownerPluginId, UiActionHandler handler) { }

   private final Map<String, CopyOnWriteArrayList<HandlerEntry>> handlers = new ConcurrentHashMap<>();
   private final Map<String, CopyOnWriteArrayList<UiEventListener>> observers = new ConcurrentHashMap<>();

   // ------------------------------------------------------------------ //
   // Action registration
   // ------------------------------------------------------------------ //

   public Subscription subscribe(String action, UiActionHandler handler) {
      return subscribe(action, "host", handler);
   }

   /**
    * Registers {@code handler} for {@code action}.
    *
    * @param ownerPluginId namespace used by {@link #unsubscribeAllOf(String)} when the plugin unloads
    */
   public Subscription subscribe(String action, String ownerPluginId, UiActionHandler handler) {
      String name = requireName(action);
      if (handler == null) {
         throw new IllegalArgumentException("Handler for '" + name + "' must not be null.");
      }

      String owner = (ownerPluginId == null || ownerPluginId.trim().isEmpty()) ? "host" : ownerPluginId.trim();
      HandlerEntry entry = new HandlerEntry(name, owner, handler);
      handlers.computeIfAbsent(name, key -> new CopyOnWriteArrayList<>()).add(entry);

      return new Subscription() {
         @Override
         public String action() {
            return name;
         }

         @Override
         public String ownerPluginId() {
            return owner;
         }

         @Override
         public boolean unsubscribe() {
            return removeHandler(name, handler);
         }
      };
   }

   public boolean unsubscribe(String action, UiActionHandler handler) {
      return removeHandler(requireName(action), handler);
   }

   /** Drop every handler owned by a plugin — called when the host unloads a jar. */
   public int unsubscribeAllOf(String ownerPluginId) {
      if (ownerPluginId == null || ownerPluginId.trim().isEmpty()) {
         return 0;
      }

      String owner = ownerPluginId.trim();
      int removed = 0;
      for (Map.Entry<String, CopyOnWriteArrayList<HandlerEntry>> entry : handlers.entrySet()) {
         List<HandlerEntry> list = entry.getValue();
         List<HandlerEntry> survivors = new ArrayList<>(list.size());
         for (HandlerEntry handlerEntry : list) {
            if (!owner.equals(handlerEntry.ownerPluginId())) {
               survivors.add(handlerEntry);
            }
         }

         removed += list.size() - survivors.size();
         if (survivors.isEmpty()) {
            handlers.remove(entry.getKey());
         } else {
            list.clear();
            list.addAll(survivors);
         }
      }
      return removed;
   }

   private boolean removeHandler(String name, UiActionHandler handler) {
      CopyOnWriteArrayList<HandlerEntry> list = handlers.get(name);
      if (list == null || list.isEmpty()) {
         return false;
      }

      HandlerEntry match = null;
      for (HandlerEntry entry : list) {
         if (entry.handler() == handler) {
            match = entry;
            break;
         }
      }

      if (match == null) {
         return false;
      }

      list.remove(match);
      if (list.isEmpty()) {
         handlers.remove(name);
      }
      return true;
   }

   public boolean hasHandler(String action) {
      CopyOnWriteArrayList<HandlerEntry> list = handlers.get(action);
      return (list != null && !list.isEmpty()) || handlers.containsKey(WILDCARD);
   }

   /** Every action currently served by this JVM. */
   public Set<String> actions() {
      Set<String> names = new LinkedHashSet<>();
      for (Map.Entry<String, CopyOnWriteArrayList<HandlerEntry>> entry : handlers.entrySet()) {
         if (!entry.getValue().isEmpty()) {
            names.add(entry.getKey());
         }
      }
      return Collections.unmodifiableSet(names);
   }

   // ------------------------------------------------------------------ //
   // Dispatch — always resolves to a response envelope, never throws.
   // ------------------------------------------------------------------ //

   public UiResponse invoke(UiRequest request) {
      if (request == null || request.getAction() == null || request.getAction().isEmpty()) {
         return UiResponse.error(request == null ? "?" : request.getId(), null,
            UiError.INVALID_PAYLOAD, "A request needs an action name.");
      }

      HandlerEntry handler = findHandler(request.getAction());
      if (handler == null) {
         return UiResponse.error(request.getId(), request.getAction(), UiError.NO_HANDLER,
            "No JVM handler is registered for action '" + request.getAction() + "'.");
      }

      try {
         Object result = handler.handler().handle(request);
         return UiResponse.ok(request.getId(), request.getAction(), result);
      } catch (Exception e) {
         return UiResponse.from(e, request.getId(), request.getAction());
      }
   }

   /** Run a dispatch on {@code executor}; pass {@code null} to run inline. */
   public CompletableFuture<UiResponse> invokeAsync(UiRequest request, Executor executor) {
      Executor target = (executor == null) ? DIRECT : executor;
      CompletableFuture<UiResponse> future = new CompletableFuture<>();
      target.execute(() -> {
         try {
            future.complete(invoke(request));
         } catch (RuntimeException e) {
            future.complete(UiResponse.from(e, request == null ? null : request.getId(),
               request == null ? null : request.getAction()));
         }
      });
      return future;
   }

   private HandlerEntry findHandler(String action) {
      CopyOnWriteArrayList<HandlerEntry> exact = handlers.get(action);
      if (exact != null && !exact.isEmpty()) {
         return exact.get(0);
      }

      CopyOnWriteArrayList<HandlerEntry> wildcard = handlers.get(WILDCARD);
      return (wildcard == null || wildcard.isEmpty()) ? null : wildcard.get(0);
   }

   // ------------------------------------------------------------------ //
   // Event channel (fire-and-forget)
   // ------------------------------------------------------------------ //

   public Subscription observe(String event, UiEventListener listener) {
      String name = requireName(event);
      if (listener == null) {
         throw new IllegalArgumentException("Listener for '" + name + "' must not be null.");
      }

      CopyOnWriteArrayList<UiEventListener> list = observers.computeIfAbsent(name, key -> new CopyOnWriteArrayList<>());
      list.add(listener);

      return new Subscription() {
         @Override
         public String action() {
            return name;
         }

         @Override
         public String ownerPluginId() {
            return "observer";
         }

         @Override
         public boolean unsubscribe() {
            return list.remove(listener);
         }
      };
   }

   /** Notify local observers. Returns the number of listeners that were called. */
   public int publishEvent(String event, Object payload, String sourcePluginId) {
      if (event == null || event.trim().isEmpty()) {
         return 0;
      }

      String name = event.trim();
      Object body = payload == null ? Collections.emptyMap() : payload;
      String origin = sourcePluginId == null ? "unknown" : sourcePluginId;
      int called = 0;

      CopyOnWriteArrayList<UiEventListener> exact = observers.get(name);
      if (exact != null) {
         for (UiEventListener listener : exact) {
            if (safeNotify(listener, name, body, origin)) {
               called++;
            }
         }
      }

      CopyOnWriteArrayList<UiEventListener> wildcard = observers.get(WILDCARD);
      if (wildcard != null && !name.equals(WILDCARD)) {
         for (UiEventListener listener : wildcard) {
            if (safeNotify(listener, name, body, origin)) {
               called++;
            }
         }
      }

      return called;
   }

   private boolean safeNotify(UiEventListener listener, String event, Object payload, String sourcePluginId) {
      try {
         listener.onEvent(event, payload, sourcePluginId);
         return true;
      } catch (RuntimeException e) {
         System.err.println("[eaze-ui-sdk] event observer failed for '" + event + "': " + e.getMessage());
         return false;
      }
   }

   private static String requireName(String action) {
      if (action == null || action.trim().isEmpty()) {
         throw new IllegalArgumentException("An action/event name is required.");
      }
      return action.trim();
   }
}
