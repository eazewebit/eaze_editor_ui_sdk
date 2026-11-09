package com.eazeeditor.core.uisdk.api;

/**
 * A unit of UI work addressable by action name (e.g. {@code ui.showToast},
 * {@code myPlugin.pickTemplate}).
 *
 * <p>The returned value becomes the {@code result} field of the response
 * envelope; return {@code null} for "done, nothing to send back".  Throw a
 * {@link UiSdkException} to fail with an explicit SDK error code.
 */
@FunctionalInterface
public interface UiActionHandler {

   /**
    * @param request the inbound request (never null, payload never null)
    * @return any JSON-serialisable value handed back to the caller
    * @throws Exception anything is mapped onto a {@link UiResponse} error
    */
   Object handle(UiRequest request) throws Exception;
}
