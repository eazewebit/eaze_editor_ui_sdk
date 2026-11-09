package com.eazeeditor.core.uisdk.model;

import com.eazeeditor.core.uisdk.api.UiRequest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Request contract for native path selection.
 *
 * <p>{@code mode} accepts {@code file}, {@code directory} or {@code files};
 * anything else normalises to {@code file} so a malformed plugin payload can
 * never open an unintended chooser.
 */
public class PathSelectionRequest {

   public static final String MODE_FILE = "file";
   public static final String MODE_DIRECTORY = "directory";
   public static final String MODE_FILES = "files";

   /** Ceiling enforced by {@link #timeoutOrDefault(long)}: 30 minutes. */
   public static final long MAX_TIMEOUT_MS = 1_800_000L;

   private String title;
   private String mode = MODE_FILE;
   private boolean multiple;
   private List<String> extensions = new ArrayList<>();
   private String initialPath;
   private Long timeoutMs;
   private String sourcePluginId;

   public PathSelectionRequest() {
   }

   public static PathSelectionRequest file(String title) {
      return of(title, MODE_FILE, false);
   }

   public static PathSelectionRequest files(String title) {
      return of(title, MODE_FILES, true);
   }

   public static PathSelectionRequest directory(String title) {
      return of(title, MODE_DIRECTORY, false);
   }

   public static PathSelectionRequest of(String title, String mode, boolean multiple) {
      PathSelectionRequest request = new PathSelectionRequest();
      request.setTitle(title);
      request.setMode(mode);
      request.setMultiple(multiple);
      return request;
   }

   /** Wire decoder used by the bridge. */
   public static PathSelectionRequest fromMap(Map<?, ?> raw) {
      Map<String, Object> map = UiRequest.asObjectMap(raw);
      PathSelectionRequest request = new PathSelectionRequest();
      request.setTitle(UiRequest.asString(map.get("title")));
      request.setMode(UiRequest.asString(map.get("mode")));
      request.setMultiple(Boolean.TRUE.equals(map.get("multiple"))
         || "true".equalsIgnoreCase(String.valueOf(map.get("multiple"))));

      Object extensions = map.get("extensions");
      if (extensions != null) {
         List<String> list = new ArrayList<>();
         for (String candidate : toStringList(extensions)) {
            list.add(candidate);
         }
         request.setExtensions(list);
      }

      request.setInitialPath(UiRequest.asString(map.get("initialPath")));
      long timeout = UiRequest.asLong(map.get("timeoutMs"), 0L);
      if (timeout > 0L) {
         request.setTimeoutMs(timeout);
      }
      request.setSourcePluginId(UiRequest.asString(map.get("sourcePluginId")));

      // "multiple: true" without an explicit mode still means the multi picker.
      if (map.get("mode") == null && request.isMultiple()) {
         request.setMode(MODE_FILES);
      }
      return request;
   }

   /** Normalised, never-null selection mode. */
   public String normalizedMode() {
      if (mode == null) {
         return MODE_FILE;
      }

      switch (mode.trim().toLowerCase(Locale.ROOT)) {
         case MODE_DIRECTORY:
            return MODE_DIRECTORY;
         case MODE_FILES:
            return MODE_FILES;
         default:
            return MODE_FILE;
      }
   }

   public boolean isDirectoryMode() {
      return MODE_DIRECTORY.equals(normalizedMode());
   }

   public boolean allowsMultiple() {
      return multiple || MODE_FILES.equals(normalizedMode());
   }

   /** Extensions stripped of leading dots and lower-cased; never null. */
   public List<String> normalizedExtensions() {
      if (extensions == null || extensions.isEmpty()) {
         return Collections.emptyList();
      }

      List<String> cleaned = new ArrayList<>(extensions.size());
      for (String raw : extensions) {
         if (raw == null) {
            continue;
         }

         String candidate = raw.trim().toLowerCase(Locale.ROOT);
         while (candidate.startsWith(".")) {
            candidate = candidate.substring(1);
         }

         if (!candidate.isEmpty() && candidate.matches("[a-z0-9_.+:-]{1,32}")) {
            cleaned.add(candidate);
         }
      }

      return cleaned;
   }

   public String[] extensionArray() {
      return normalizedExtensions().toArray(new String[0]);
   }

   public String safeTitle(String fallback) {
      return title == null || title.trim().isEmpty() ? fallback : title.trim();
   }

   public long timeoutOrDefault(long fallbackMs) {
      if (timeoutMs == null || timeoutMs <= 0L) {
         return Math.min(fallbackMs, MAX_TIMEOUT_MS);
      }
      return Math.min(timeoutMs, MAX_TIMEOUT_MS);
   }

   public Map<String, Object> toMap() {
      Map<String, Object> map = new LinkedHashMap<>();
      map.put("title", title);
      map.put("mode", normalizedMode());
      map.put("multiple", allowsMultiple());
      map.put("extensions", normalizedExtensions());
      map.put("initialPath", initialPath);
      if (timeoutMs != null) {
         map.put("timeoutMs", timeoutMs);
      }
      map.put("sourcePluginId", sourcePluginId);
      return map;
   }

   static List<String> toStringList(Object value) {
      List<String> out = new ArrayList<>();
      for (Object item : UiRequest.asList(value)) {
         String text = UiRequest.asString(item);
         if (text != null && !text.trim().isEmpty()) {
            out.add(text.trim());
         }
      }
      return out;
   }

   public String getTitle() {
      return title;
   }

   public void setTitle(String title) {
      this.title = title;
   }

   public String getMode() {
      return mode;
   }

   public void setMode(String mode) {
      this.mode = mode;
   }

   public boolean isMultiple() {
      return multiple;
   }

   public void setMultiple(boolean multiple) {
      this.multiple = multiple;
   }

   public List<String> getExtensions() {
      return extensions == null ? Collections.emptyList() : Collections.unmodifiableList(extensions);
   }

   public void setExtensions(List<String> extensions) {
      this.extensions = extensions == null ? new ArrayList<>() : new ArrayList<>(extensions);
   }

   public String getInitialPath() {
      return initialPath;
   }

   public void setInitialPath(String initialPath) {
      this.initialPath = initialPath;
   }

   public Long getTimeoutMs() {
      return timeoutMs;
   }

   public void setTimeoutMs(Long timeoutMs) {
      this.timeoutMs = timeoutMs;
   }

   public String getSourcePluginId() {
      return sourcePluginId;
   }

   public void setSourcePluginId(String sourcePluginId) {
      this.sourcePluginId = sourcePluginId;
   }
}
