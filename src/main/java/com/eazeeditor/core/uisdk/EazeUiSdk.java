package com.eazeeditor.core.uisdk;

import com.eazeeditor.core.uisdk.bus.UiCommandBus;
import com.eazeeditor.core.uisdk.runtime.DefaultUiRuntime;
import com.eazeeditor.core.uisdk.runtime.UiPluginScope;
import com.eazeeditor.core.uisdk.runtime.UiRuntime;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Static entry point of the <b>eaze_editor_ui_sdk</b> module.
 *
 * <p><b>Hosts</b> (Eaze Editor's {@code webui}, or any app embedding this jar)
 * install one runtime at startup:
 *
 * <pre>{@code
 * EazeUiSdk.install(new DefaultUiRuntime(myNativePathProvider));
 * }</pre>
 *
 * <p><b>Plugins</b> (jars the host loads) only ever touch a scope:
 *
 * <pre>{@code
 * UiPluginScope ui = EazeUiSdk.forPlugin("my-plugin");
 * ui.onAction("myPlugin.reindex", req -> service.reindex(req.getPayload()));
 * ui.toastSuccess("Reindexed", "42 files");
 * String dir = ui.selectDirectory("Pick project folder");
 * Map<String,Object> answers = ui.askConversation("Setup", List.of(
 *      Map.of("name", "projectName", "label", "Project name", "type", "text", "required", true)));
 * }</pre>
 *
 * <p><b>Why this package.</b> Eaze Editor loads plugin jars through a
 * child-first {@code URLClassLoader} that delegates to the host only for
 * {@code java.*}, {@code org.slf4j.*}, {@code com.eazeeditor.core.*} and
 * {@code com.eazeeditor.plugincore.*}.  Living under
 * {@code com.eazeeditor.core.uisdk} guarantees every plugin — even one that
 * accidentally bundles this jar — shares the <em>same</em> bus instance as the
 * host instead of silently building a private one.
 */
public final class EazeUiSdk {

   /** Mirrors {@code eazeUiSdk.version} in the browser module. */
   public static final String VERSION = DefaultUiRuntime.VERSION;

   private static final Map<String, UiPluginScope> SCOPES = new ConcurrentHashMap<>();
   private static volatile UiRuntime runtime;

   private EazeUiSdk() {
   }

   // ------------------------------------------------------------------ //
   // Host wiring
   // ------------------------------------------------------------------ //

   /** Install the runtime. The first install wins so a stray second call is harmless. */
   public static void install(UiRuntime candidate) {
      install(candidate, false);
   }

   /**
    * @param replace true to swap out an already installed runtime (hot reload / tests)
    */
   public static synchronized void install(UiRuntime candidate, boolean replace) {
      if (candidate == null) {
         return;
      }

      if (runtime != null && !replace) {
         return;
      }

      runtime = candidate;
      SCOPES.clear();
   }

   public static boolean isInstalled() {
      return runtime != null;
   }

   /** Block until a runtime appears (plugin jars may load before the host finished booting). */
   public static boolean awaitReady(long timeoutMs) {
      long deadline = System.currentTimeMillis() + Math.max(0L, timeoutMs);
      while (runtime == null && System.currentTimeMillis() < deadline) {
         try {
            Thread.sleep(25L);
         } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return runtime != null;
         }
      }
      return runtime != null;
   }

   /** The installed runtime. */
   public static UiRuntime require() {
      UiRuntime current = runtime;
      if (current == null) {
         throw new IllegalStateException(
            "EazeUiSdk is not installed yet — the host must call EazeUiSdk.install(runtime) at startup"
               + " (Spring Boot hosts get that from eaze_editor_ui_sdk auto-configuration).");
      }
      return current;
   }

   /** The installed runtime, or {@code null} when the host has not wired the SDK. */
   public static UiRuntime peek() {
      return runtime;
   }

   // ------------------------------------------------------------------ //
   // Plugin entry point
   // ------------------------------------------------------------------ //

   /** Namespaced handle for a plugin; the same id always returns the same scope. */
   public static UiPluginScope forPlugin(String pluginId) {
      String key = (pluginId == null || pluginId.trim().isEmpty()) ? "plugin" : pluginId.trim();
      return SCOPES.computeIfAbsent(key, id -> new UiPluginScope(require(), id));
   }

   /** Scope used by the host application itself. */
   public static UiPluginScope host() {
      return forPlugin("host");
   }

   /** Drop a plugin's scope after it was unloaded (its handlers are released too). */
   public static void releasePlugin(String pluginId) {
      if (pluginId == null || pluginId.trim().isEmpty()) {
         return;
      }

      UiPluginScope scope = SCOPES.remove(pluginId.trim());
      if (scope != null) {
         scope.release();
      }
   }

   public static UiCommandBus bus() {
      return require().bus();
   }

   // ------------------------------------------------------------------ //
   // Host convenience (delegates to the "host" scope)
   // ------------------------------------------------------------------ //

   public static void toast(String type, String title, String message) {
      host().toast(type, title, message);
   }

   public static Map<String, Object> capabilities() {
      return require().capabilities();
   }

   /** Release threads and pending requests (host shutdown). */
   public static synchronized void shutdown() {
      UiRuntime current = runtime;
      runtime = null;
      SCOPES.clear();
      if (current != null) {
         current.shutdown();
      }
   }
}
