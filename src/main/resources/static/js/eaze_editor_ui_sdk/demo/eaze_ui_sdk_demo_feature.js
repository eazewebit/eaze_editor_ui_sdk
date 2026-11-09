/**
 * @file eaze_ui_sdk_demo_feature.js
 * @description Tiny module that the demo plugin loads through
 * <code>ui.loadScript()</code> and registers with <code>ui.registerModule()</code>.
 * Exists purely to prove dynamic script loading + module registration.
 */
(function (root) {
    'use strict';

    var feature = {
        name: 'sdkDemoFeature',
        loadedAt: new Date().toISOString(),
        ping: function () { return 'pong from ' + this.name; }
    };

    if (root.eazeUiSdk && typeof root.eazeUiSdk.registerModule === 'function') {
        root.eazeUiSdk.registerModule('sdkDemoFeature', feature);
    }
    root.eazeUiSdkDemoFeature = feature;
})(window || globalThis);
