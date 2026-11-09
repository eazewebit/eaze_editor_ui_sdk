package com.eazeeditor.core.uisdk.api;

/**
 * Unchecked exception plugins throw from a {@link UiActionHandler} to report a
 * failure with a specific SDK error code (e.g. {@link UiError#CANCELLED}).
 */
public class UiSdkException extends RuntimeException {

   private final String code;
   private final transient Object details;

   public UiSdkException(String code, String message) {
      this(code, message, null);
   }

   public UiSdkException(String code, String message, Object details) {
      super(message);
      this.code = code;
      this.details = details;
   }

   public static UiSdkException cancelled() {
      return new UiSdkException(UiError.CANCELLED, "The user cancelled the operation.");
   }

   public static UiSdkException invalidPayload(String message) {
      return new UiSdkException(UiError.INVALID_PAYLOAD, message);
   }

   public String getCode() {
      return code;
   }

   public Object getDetails() {
      return details;
   }
}
