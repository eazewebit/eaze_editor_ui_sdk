package com.eazeeditor.core.uisdk.api;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Machine-readable failure carried inside {@link UiResponse}.  Codes are shared
 * verbatim with the browser SDK ({@code eazeUiSdk.errorCodes}) so a plugin can
 * branch on the same constant regardless of which side failed.
 */
public final class UiError {

   public static final String CANCELLED = "CANCELLED";
   public static final String TIMEOUT = "TIMEOUT";
   public static final String NO_HANDLER = "NO_HANDLER";
   public static final String INVALID_PAYLOAD = "INVALID_PAYLOAD";
   public static final String HANDLER_ERROR = "HANDLER_ERROR";
   public static final String BRIDGE_UNAVAILABLE = "BRIDGE_UNAVAILABLE";
   public static final String NO_BROWSER_CLIENT = "NO_BROWSER_CLIENT";
   public static final String NATIVE_UNAVAILABLE = "NATIVE_UNAVAILABLE";

   private final String code;
   private final String message;
   private final Object details;

   public UiError(String code, String message, Object details) {
      this.code = (code == null || code.trim().isEmpty()) ? HANDLER_ERROR : code.trim();
      this.message = message == null ? "Unknown error" : message;
      this.details = details;
   }

   public static UiError of(String code, String message) {
      return new UiError(code, message, null);
   }

   public static UiError of(String code, String message, Object details) {
      return new UiError(code, message, details);
   }

   public static UiError from(Throwable throwable) {
      String code = (throwable instanceof UiSdkException sdkException && sdkException.getCode() != null)
         ? sdkException.getCode()
         : HANDLER_ERROR;
      String message = throwable.getMessage() == null ? throwable.getClass().getSimpleName() : throwable.getMessage();
      return new UiError(code, message, null);
   }

   @SuppressWarnings("unchecked")
   public static UiError fromMap(Object raw) {
      if (raw instanceof UiError error) {
         return error;
      }
      Map<String, Object> map = UiRequest.asObjectMap(raw);
      return new UiError(UiRequest.asString(map.get("code")), UiRequest.asString(map.get("message")), map.get("details"));
   }

   public Map<String, Object> toMap() {
      Map<String, Object> map = new LinkedHashMap<>();
      map.put("code", code);
      map.put("message", message);
      if (details != null) {
         map.put("details", details);
      }
      return map;
   }

   public String getCode() {
      return code;
   }

   public String getMessage() {
      return message;
   }

   public Object getDetails() {
      return details;
   }

   @Override
   public String toString() {
      return code + ": " + message;
   }
}
