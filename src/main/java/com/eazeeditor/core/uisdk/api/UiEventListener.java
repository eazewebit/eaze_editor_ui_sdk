package com.eazeeditor.core.uisdk.api;

/**
 * Fire-and-forget observer for SDK events ({@code eaze-ui-event} envelopes).
 * Events never carry a reply — use {@link UiActionHandler} when a result is
 * required.
 */
@FunctionalInterface
public interface UiEventListener {

   /**
    * @param event          event name, e.g. {@code ui.showToast} or {@code myPlugin.synced}
    * @param payload        event body (never null, may be empty)
    * @param sourcePluginId plugin that emitted the event ({@code "browser"} for UI-originated ones)
    */
   void onEvent(String event, Object payload, String sourcePluginId);
}
