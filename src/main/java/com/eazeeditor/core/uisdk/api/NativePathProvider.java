package com.eazeeditor.core.uisdk.api;

import com.eazeeditor.core.uisdk.model.PathSelectionRequest;
import com.eazeeditor.core.uisdk.model.PathSelectionResult;

/**
 * Host capability that opens a <strong>native</strong> file/folder chooser and
 * returns real absolute filesystem paths.
 *
 * <p>Browsers (and therefore WebView2) never expose the true path of a file
 * picked through {@code <input type="file">}, so the SDK delegates this to the
 * desktop host.  Eaze Editor implements it with its existing Swing chooser
 * ({@code com.nurujjamanpollob.textenginejava.filesystem.PathSelector}); any
 * other host can supply its own implementation as a plain bean.
 *
 * <p>Implementations must be safe to call from a pooled thread and must never
 * throw — report failures through {@link PathSelectionResult#error(String, String)}.
 */
public interface NativePathProvider {

   /** Open the picker for {@code request} and wait until the user decides. */
   PathSelectionResult select(PathSelectionRequest request);

   /** False on headless runtimes; the SDK then answers {@code NATIVE_UNAVAILABLE}. */
   default boolean isAvailable() {
      return true;
   }
}
