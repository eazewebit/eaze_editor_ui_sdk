package com.eazeeditor.core.uisdk.api;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Reply envelope for a {@link UiRequest}.  Reuses the request id verbatim — that
 * correlation is the whole two-way protocol, no HTTP endpoint involved.
 */
public final class UiResponse {

   public static final String TYPE = "eaze-ui-response";

   private final String id;
   private final String action;
   private final boolean ok;
   private final Object result;
   private final UiError error;

   private UiResponse(String id, String action, boolean ok, Object result, UiError error) {
      this.id = id;
      this.action = action;
      this.ok = ok;
      this.result = result;
      this.error = error;
   }

   public static UiResponse ok(String id, String action, Object result) {
      return new UiResponse(id, action, true, result, null);
   }

   public static UiResponse error(String id, String action, String code, String message) {
      return new UiResponse(id, action, false, null, UiError.of(code, message));
   }

   public static UiResponse error(String id, String action, UiError uiError) {
      return new UiResponse(id, action, false, null, uiError);
   }

   public static UiResponse from(Throwable throwable, String responseId, String action) {
      return error(responseId, action, UiError.from(throwable));
   }

   /** Lenient wire decoder. */
   public static UiResponse fromMap(Map<?, ?> raw) {
      if (raw == null) {
         return error(null, null, UiError.HANDLER_ERROR, "Empty response envelope.");
      }

      Map<String, Object> body = UiRequest.asObjectMap(raw);
      boolean accepted = Boolean.TRUE.equals(body.get("ok")) || "true".equals(String.valueOf(body.get("ok")));
      String responseId = UiRequest.asString(body.get("id"));
      String action = UiRequest.asString(body.get("action"));
      UiError failure = body.get("error") == null ? null : UiError.fromMap(body.get("error"));

      if (accepted) {
         return ok(responseId, action, body.get("result"));
      }
      return new UiResponse(responseId, action, false, body.get("result"),
         failure == null ? UiError.of(UiError.HANDLER_ERROR, "Request failed.") : failure);
   }

   public Map<String, Object> toMap() {
      Map<String, Object> map = new LinkedHashMap<>();
      map.put("id", id);
      map.put("type", TYPE);
      map.put("action", action);
      map.put("ok", ok);
      map.put("result", result);
      map.put("error", error == null ? null : error.toMap());
      return map;
   }

   public String getId() {
      return id;
   }

   public String getAction() {
      return action;
   }

   public boolean isOk() {
      return ok;
   }

   public Object getResult() {
      return result;
   }

   public UiError getError() {
      return error;
   }

   /** Convenience: the result as a map (empty when absent). */
   public Map<String, Object> resultMap() {
      return UiRequest.asObjectMap(result);
   }

   /** Unwrap or throw {@link UiSdkException} — used by blocking plugin APIs. */
   public Object unwrap() {
      if (!ok) {
         UiError failure = error == null ? UiError.of(UiError.HANDLER_ERROR, "Request failed.") : error;
         throw new UiSdkException(failure.getCode(), failure.getMessage(), failure.getDetails());
      }
      return result;
   }

   @Override
   public String toString() {
      return "UiResponse{" + id + ", action=" + action + ", ok=" + ok + (ok ? "" : ", error=" + error) + "}";
   }
}
