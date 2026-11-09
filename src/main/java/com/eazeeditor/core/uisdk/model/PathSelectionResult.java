package com.eazeeditor.core.uisdk.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Outcome of a native path selection: {@code SELECTED}, {@code CANCELLED} or
 * {@code ERROR}.  Cancelled is a normal outcome, never an exception — plugins
 * that want the throwing variant call {@link #unwrap()}.
 */
public class PathSelectionResult {

   public static final String STATUS_SELECTED = "SELECTED";
   public static final String STATUS_CANCELLED = "CANCELLED";
   public static final String STATUS_ERROR = "ERROR";

   private final String status;
   private final String mode;
   private final List<String> paths;
   private final String errorCode;
   private final String errorMessage;

   private PathSelectionResult(String status, String mode, List<String> paths, String errorCode, String errorMessage) {
      this.status = status;
      this.mode = mode;
      this.paths = paths == null ? Collections.emptyList() : Collections.unmodifiableList(paths);
      this.errorCode = errorCode;
      this.errorMessage = errorMessage;
   }

   public static PathSelectionResult selected(String mode, List<String> selectedPaths) {
      List<String> cleaned = new ArrayList<>();
      if (selectedPaths != null) {
         for (String candidate : selectedPaths) {
            if (candidate != null && !candidate.trim().isEmpty()) {
               cleaned.add(candidate);
            }
         }
      }

      if (cleaned.isEmpty()) {
         return cancelled(mode);
      }
      return new PathSelectionResult(STATUS_SELECTED, mode, cleaned, null, null);
   }

   public static PathSelectionResult selected(String mode, String singlePath) {
      return selected(mode, singlePath == null ? Collections.emptyList() : Collections.singletonList(singlePath));
   }

   public static PathSelectionResult cancelled(String mode) {
      return new PathSelectionResult(STATUS_CANCELLED, mode, Collections.emptyList(), "CANCELLED", "No path was selected.");
   }

   public static PathSelectionResult error(String code, String message) {
      return new PathSelectionResult(STATUS_ERROR, null, Collections.emptyList(), code, message);
   }

   @SuppressWarnings("unchecked")
   public static PathSelectionResult fromMap(Map<?, ?> raw) {
      Map<String, Object> map = new LinkedHashMap<>();
      if (raw != null) {
         for (Map.Entry<?, ?> entry : raw.entrySet()) {
            if (entry.getKey() != null) {
               map.put(String.valueOf(entry.getKey()), entry.getValue());
            }
         }
      }

      String status = str(map.get("status"));
      String mode = str(map.get("mode"));
      List<String> paths = new ArrayList<>();
      Object rawPaths = map.get("paths");
      if (rawPaths != null) {
         for (Object item : com.eazeeditor.core.uisdk.api.UiRequest.asList(rawPaths)) {
            String text = str(item);
            if (text != null && !text.trim().isEmpty()) {
               paths.add(text);
            }
         }
      }
      String single = str(map.get("path"));
      if (paths.isEmpty() && single != null && !single.trim().isEmpty()) {
         paths.add(single);
      }

      if (STATUS_SELECTED.equalsIgnoreCase(status) && !paths.isEmpty()) {
         return selected(mode, paths);
      }
      if (STATUS_CANCELLED.equalsIgnoreCase(status)) {
         return cancelled(mode);
      }

      Object error = map.get("error");
      if (error instanceof Map<?, ?> errorMap) {
         Map<String, Object> nested = new LinkedHashMap<>();
         for (Map.Entry<?, ?> entry : errorMap.entrySet()) {
            nested.put(String.valueOf(entry.getKey()), entry.getValue());
         }
         return error(str(nested.get("code")), str(nested.get("message")));
      }
      return error(str(map.get("errorCode")) == null ? "PICKER_FAILED" : str(map.get("errorCode")),
         str(map.get("errorMessage")));
   }

   public Map<String, Object> toMap() {
      Map<String, Object> map = new LinkedHashMap<>();
      map.put("status", status);
      map.put("mode", mode);
      map.put("paths", paths);
      map.put("path", paths.isEmpty() ? null : paths.get(0));
      if (!STATUS_SELECTED.equals(status)) {
         Map<String, Object> error = new LinkedHashMap<>();
         error.put("code", errorCode == null ? "PICKER_FAILED" : errorCode);
         error.put("message", errorMessage == null ? "Native path selection failed." : errorMessage);
         map.put("error", error);
      }
      return map;
   }

   /** The chosen absolute path, or {@code null} when nothing was selected. */
   public String getPath() {
      return paths.isEmpty() ? null : paths.get(0);
   }

   public List<String> getPaths() {
      return paths;
   }

   public boolean isSelected() {
      return STATUS_SELECTED.equals(status) && !paths.isEmpty();
   }

   public boolean isCancelled() {
      return STATUS_CANCELLED.equals(status);
   }

   /** Same value as {@link #getPath()} but throws when the user cancelled or failed. */
   public String unwrap() {
      if (isSelected()) {
         return getPath();
      }
      throw new com.eazeeditor.core.uisdk.api.UiSdkException(
         errorCode == null ? "PICKER_FAILED" : errorCode,
         errorMessage == null ? "No path was selected." : errorMessage);
   }

   public String getStatus() {
      return status;
   }

   public String getMode() {
      return mode;
   }

   public String getErrorCode() {
      return errorCode;
   }

   public String getErrorMessage() {
      return errorMessage;
   }

   private static String str(Object value) {
      return value == null ? null : String.valueOf(value);
   }

   @Override
   public String toString() {
      return "PathSelectionResult{" + status + ", mode=" + mode + ", paths=" + paths + "}";
   }
}
