package com.eazeeditor.core.uisdk.api;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Immutable request envelope travelling across the UI SDK bus.
 *
 * <p>The exact same shape is used on the wire (JSON over the host bridge) and
 * inside the JVM, so a plugin never has to care whether its peer is the browser
 * or another jar:
 *
 * <pre>{@code
 * { id, type:'eaze-ui-request', action, sourcePluginId, origin, clientId?, timeoutMs?, payload }
 * }</pre>
 *
 * <p>Every request carries a unique {@code id}; the matching {@link UiResponse}
 * reuses it, which is what makes two-way communication possible without any
 * HTTP endpoint.
 */
public final class UiRequest {

   public static final String TYPE = "eaze-ui-request";

   public static final String ORIGIN_BROWSER = "browser";
   public static final String ORIGIN_JVM = "jvm";
   public static final String ORIGIN_HOST = "host";

   private final String id;
   private final String action;
   private final String sourcePluginId;
   private final String origin;
   private final String clientId;
   private final long timeoutMs;
   private final Map<String, Object> payload;
   private final long timestamp;

   private UiRequest(String id, String action, String sourcePluginId, String origin,
                     String clientId, long timeoutMs, Map<String, Object> payload) {
      this.id = (id == null || id.trim().isEmpty()) ? newId() : id.trim();
      this.action = action == null ? null : action.trim();
      this.sourcePluginId = (sourcePluginId == null || sourcePluginId.trim().isEmpty()) ? "unknown" : sourcePluginId.trim();
      this.origin = (origin == null || origin.trim().isEmpty()) ? ORIGIN_JVM : origin.trim().toLowerCase();
      this.clientId = (clientId == null || clientId.trim().isEmpty()) ? null : clientId.trim();
      this.timeoutMs = Math.max(0L, timeoutMs);
      this.payload = payload == null
         ? Collections.emptyMap()
         : Collections.unmodifiableMap(new LinkedHashMap<>(payload));
      this.timestamp = System.currentTimeMillis();
   }

   /** Wire-friendly id generator (also used by the browser SDK). */
   public static String newId() {
      return "req-" + Long.toString(System.currentTimeMillis(), 36) + "-"
         + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
   }

   public static UiRequest of(String action, Map<String, Object> payload, String sourcePluginId, String origin) {
      return new UiRequest(null, action, sourcePluginId, origin, null, 0L, payload);
   }

   /** Request raised by a JVM plugin; routed to the browser when no local handler exists. */
   public static UiRequest jvm(String action, Map<String, Object> payload, String sourcePluginId) {
      return new UiRequest(null, action, sourcePluginId, ORIGIN_JVM, null, 0L, payload);
   }

   /** Lenient wire decoder: unknown keys are ignored, missing ids are generated. */
   public static UiRequest fromMap(Map<?, ?> raw) {
      if (raw == null) {
         return of(null, Collections.emptyMap(), "unknown", ORIGIN_HOST);
      }

      Map<String, Object> payload = asObjectMap(raw.get("payload"));

      return new UiRequest(
         asString(raw.get("id")),
         asString(raw.get("action")),
         asString(raw.get("sourcePluginId")),
         asString(raw.get("origin")),
         asString(raw.get("clientId")),
         asLong(raw.get("timeoutMs"), 0L),
         payload);
   }

   public Map<String, Object> toMap() {
      Map<String, Object> map = new LinkedHashMap<>();
      map.put("id", id);
      map.put("type", TYPE);
      map.put("action", action);
      map.put("sourcePluginId", sourcePluginId);
      map.put("origin", origin);
      if (clientId != null) {
         map.put("clientId", clientId);
      }
      if (timeoutMs > 0L) {
         map.put("timeoutMs", timeoutMs);
      }
      map.put("payload", payload);
      map.put("timestamp", timestamp);
      return map;
   }

   /** Copy with an explicit reply channel (set by the bridge for browser traffic). */
   public UiRequest withClientId(String value) {
      return new UiRequest(id, action, sourcePluginId, origin, value, timeoutMs, payload);
   }

   public UiRequest withTimeout(long millis) {
      return new UiRequest(id, action, sourcePluginId, origin, clientId, millis, payload);
   }

   public String getId() {
      return id;
   }

   public String getAction() {
      return action;
   }

   public String getSourcePluginId() {
      return sourcePluginId;
   }

   public String getOrigin() {
      return origin;
   }

   /** Browser session this request belongs to (null for pure JVM traffic). */
   public String getClientId() {
      return clientId;
   }

   /** 0 = use the runtime default. */
   public long getTimeoutMs() {
      return timeoutMs;
   }

   public long getTimestamp() {
      return timestamp;
   }

   public Map<String, Object> getPayload() {
      return payload;
   }

   // ------------------------------------------------------------------ //
   // Payload accessors — plugins should never cast by hand.
   // ------------------------------------------------------------------ //

   public String getString(String key, String fallback) {
      String value = asString(payload.get(key));
      return (value == null || value.trim().isEmpty()) ? fallback : value;
   }

   public boolean getBoolean(String key, boolean fallback) {
      Object value = payload.get(key);
      if (value instanceof Boolean bool) {
         return bool;
      }
      if (value instanceof String text) {
         return Boolean.parseBoolean(text.trim());
      }
      return fallback;
   }

   public int getInt(String key, int fallback) {
      Object value = payload.get(key);
      if (value instanceof Number number) {
         return number.intValue();
      }
      try {
         return value == null ? fallback : Integer.parseInt(String.valueOf(value).trim());
      } catch (NumberFormatException e) {
         return fallback;
      }
   }

   @SuppressWarnings("unchecked")
   public <T> T getValue(String key, T fallback) {
      Object value = payload.get(key);
      return value == null ? fallback : (T) value;
   }

   public List<String> getStringList(String key) {
      Object value = payload.get(key);
      if (value instanceof List<?> list) {
         List<String> out = new ArrayList<>(list.size());
         for (Object item : list) {
            String text = asString(item);
            if (text != null && !text.isEmpty()) {
               out.add(text);
            }
         }
         return out;
      }
      if (value instanceof String text && !text.trim().isEmpty()) {
         List<String> out = new ArrayList<>();
         for (String part : text.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
               out.add(trimmed);
            }
         }
         return out;
      }
      return Collections.emptyList();
   }

   @Override
   public String toString() {
      return "UiRequest{" + id + ", action=" + action + ", plugin=" + sourcePluginId + ", origin=" + origin + "}";
   }

   // ------------------------------------------------------------------ //
   // Shared coercion helpers (also used by UiResponse / PathSelection*).
   // ------------------------------------------------------------------ //

   public static String asString(Object value) {
      return value == null ? null : String.valueOf(value);
   }

   public static long asLong(Object value, long fallback) {
      if (value instanceof Number number) {
         return number.longValue();
      }
      try {
         return value == null ? fallback : Long.parseLong(String.valueOf(value).trim());
      } catch (NumberFormatException e) {
         return fallback;
      }
   }

   @SuppressWarnings("unchecked")
   public static Map<String, Object> asObjectMap(Object value) {
      if (value instanceof Map<?, ?> map) {
         Map<String, Object> out = new LinkedHashMap<>(map.size());
         for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (entry.getKey() != null) {
               out.put(String.valueOf(entry.getKey()), entry.getValue());
            }
         }
         return out;
      }
      return new LinkedHashMap<>();
   }

   public static List<Object> asList(Object value) {
      if (value instanceof List<?> list) {
         return new ArrayList<>(list);
      }
      if (value instanceof Object[] array) {
         return new ArrayList<>(java.util.Arrays.asList(array));
      }
      return new ArrayList<>();
   }
}
