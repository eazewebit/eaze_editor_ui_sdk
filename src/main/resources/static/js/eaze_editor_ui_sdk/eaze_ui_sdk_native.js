/**
 * @file eaze_ui_sdk_native.js
 * @description Native-OS capabilities of the Eaze Editor UI SDK.
 *
 * Built-in actions (served by the <b>JVM side</b> of the eaze_editor_ui_sdk
 * module and reached through the app-level bridge — never over HTTP):
 *
 *   ui.selectNativePath   { title, mode, multiple, extensions, initialPath } -> { path, paths, mode }
 *   ui.nativeCapabilities {}                                                 -> { version, nativePathSelection, browserConnected, transports, jvmActions }
 *
 * Why the backend owns this: WebView2 / Chromium never expose a real filesystem
 * path for `<input type="file">`.  The host answers with its Swing chooser
 * (`com.nurujjamanpollob.textenginejava.filesystem.PathSelector`), serialised on
 * one picker thread because stacked modal dialogs deadlock.
 *
 * A plugin-registered listener on `ui.selectNativePath` still wins: local code
 * keeps priority over the bridge (handy for tests and mocks).
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    var MODES = ['file', 'directory', 'files'];
    var DEFAULT_TIMEOUT_MS = 600000;      // a native dialog may legitimately stay open for many minutes

    function normalizeExtensions(value) {
        if (!value) return [];
        var list = Array.isArray(value) ? value : String(value).split(',');
        return list.map(function (ext) { return String(ext).replace(/^[.\s]+|[.\s]+$/g, '').toLowerCase(); })
            .filter(function (ext) { return ext.length > 0 && /^[a-z0-9_.+:-]+$/.test(ext); });
    }

    /** Make sure the JVM channel is up before a request that must be answered remotely. */
    function ensureBridge() {
        if (!sdk.bridge) return Promise.resolve();
        if (sdk.bridge.isConnected()) return Promise.resolve();
        return sdk.bridge.connect().catch(function () { /* the request itself reports the failure */ });
    }

    /** A plugin (or a test harness) may serve an action locally — then no JVM bridge is required at all. */
    function hasLocalHandler(action) {
        try { return !!(core && core.hasHandler && core.hasHandler(action)); } catch (e) { return false; }
    }

    function mapSelection(result) {
        var data = result || {};
        if (data.status === 'CANCELLED') {
            throw new EazeUiError('Path selection cancelled by the user.', CODE.CANCELLED, { mode: data.mode });
        }
        // Demanding `status === 'SELECTED'` turned a perfectly valid local pick into "selection failed"; only an
        // explicit non-SELECTED status (the JVM envelope) counts as a failure.
        // Demanding `status === 'SELECTED'` turned a perfectly valid local pick into "selection failed"; only an
        if (data.status != null && data.status !== 'SELECTED') {
            var error = data.error || {};
            throw new EazeUiError(error.message || 'Native path selection failed.', error.code || CODE.BRIDGE_UNAVAILABLE,
                error.details || null);
        }
        var paths = Array.isArray(data.paths) ? data.paths.filter(function (p) { return typeof p === 'string' && p.length; }) : [];
        var paths = Array.isArray(data.paths) ? data.paths.filter(function (p) { return typeof p === 'string' && p.length; }) : [];
        if (!paths.length && typeof data.path === 'string' && data.path) paths = [data.path];
        if (!paths.length) throw new EazeUiError('Native picker reported success without a path.', CODE.BRIDGE_UNAVAILABLE, data);
        return { path: paths[0], paths: paths, mode: data.mode || null };
    }

    function buildPayload(optionsOrTitle, maybeOptions, ctx) {
        var options = (typeof optionsOrTitle === 'string')
            ? Object.assign({ title: optionsOrTitle }, maybeOptions || {})
            : Object.assign({}, optionsOrTitle);

        var mode = String(options.mode || (options.multiple ? 'files' : 'file')).toLowerCase();
        if (MODES.indexOf(mode) < 0) {
            throw new EazeUiError('Unknown selection mode "' + options.mode + '". Use file, directory or files.',
                CODE.INVALID_PAYLOAD);
        }

        return {
            title: options.title == null ? null : String(options.title),
            mode: mode,
            multiple: mode === 'files' || options.multiple === true,
            extensions: normalizeExtensions(options.extensions),
            initialPath: options.initialPath == null ? null : String(options.initialPath),
            timeoutMs: typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
            sourcePluginId: (ctx && ctx.sourcePluginId) || 'host',
            notifyWhileWaiting: options.notifyWhileWaiting !== false
        };
    }

    /**
     * Ask the host for a real absolute path.  Resolves with
     * `{ path, paths, mode }`, rejects with `CANCELLED` when the user aborts.
     */
    function selectNativePath(api) {
        return function (optionsOrTitle, maybeOptions) {
            var payload;
            try {
                payload = buildPayload(optionsOrTitle, maybeOptions, { sourcePluginId: api.pluginId });
            } catch (error) {
                return Promise.reject(error);
            }

            var notifyWhileWaiting = payload.notifyWhileWaiting;
            delete payload.notifyWhileWaiting;

            // A local handler wins outright: custom pickers and the demo harness must work without a JVM,
            // so requiring the bridge first turned a perfectly good local answer into BRIDGE_UNAVAILABLE.
            var servedLocally = hasLocalHandler('ui.selectNativePath');
            if (!notifyWhileWaiting || servedLocally) {
                return (servedLocally ? Promise.resolve() : ensureBridge())
                    .then(function () { return api.request('ui.selectNativePath', payload, { timeoutMs: payload.timeoutMs }); })
                    .then(mapSelection);
            }

            var waitingToast = null;
            return ensureBridge()
                .then(function () {
                    return api.request('ui.showToast', {
                        type: 'info',
                        title: 'Native picker',
                        message: 'A system folder/file picker opened. Check your taskbar if you do not see it.',
                        durationMs: 6000
                    }, { silent: true }).catch(function () { return null; });
                })
                .then(function (toast) {
                    waitingToast = toast;
                    return api.request('ui.selectNativePath', payload, { timeoutMs: payload.timeoutMs });
                })
                .then(mapSelection)
                .finally(function () {
                    if (waitingToast && waitingToast.id) {
                        api.request('ui.dismissToast', { id: waitingToast.id }, { silent: true }).catch(function () {});
                    }
                });
        };
    }

    /** What can this host do for me?  Answered by the JVM runtime. */
    function nativeCapabilities(api) {
        return function () {
            return ensureBridge().then(function () { return api.request('ui.nativeCapabilities', {}); });
        };
    }

    core.defineUiMethod('selectNativePath', selectNativePath);
    core.defineUiMethod('nativeCapabilities', nativeCapabilities);

    /** Promise-style helper on the host object too: eazeUiSdk.selectNativePath(...) */
    sdk.selectNativePath = function (optionsOrTitle, maybeOptions) {
        return selectNativePath(sdk)(optionsOrTitle, maybeOptions);
    };
    sdk.nativeCapabilities = function () {
        return nativeCapabilities(sdk)();
    };
})(window || globalThis);
