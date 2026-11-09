/**
 * @file eaze_ui_sdk.js
 * @description Eaze Editor UI SDK — core command bus, listener registry and
 * plugin-facing promise API.  This file is the single entry point of the
 * <code>eaze_editor_ui_sdk</code> module; feature files
 * (<code>eaze_ui_sdk_*.js</code>) attach their built-in handlers to it and
 * must be loaded AFTER this file.
 *
 * Protocol (envelopes):
 *   request : { id, sourcePluginId, type:'eaze-ui-request', action, payload }
 *   response: { id, type:'eaze-ui-response', ok, result, error, action }
 *   event   : { id, type:'eaze-ui-event', action, payload }
 *
 * Routing rules (the reason the SDK can talk to Java without any REST API):
 *   1. If a local handler or listener exists for the action, it owns the call.
 *   2. Otherwise the request is relayed to every registered transport — the
 *      STOMP bridge of eaze_editor_ui_sdk (see eaze_ui_sdk_bridge.js) answers
 *      with a response envelope carrying the same id.
 *   3. Pass { forwardToBridge: true } to relay even when something local exists.
 *   4. Replies from transports are only accepted for requests that were
 *      actually relayed, so a stale JVM reply can never resolve a local call.
 *
 * Nothing in this file touches editor internals — the SDK is purely additive.
 */
(function (root) {
    'use strict';

    var VERSION = '1.0.0';
    var TYPE_REQUEST = 'eaze-ui-request';
    var TYPE_RESPONSE = 'eaze-ui-response';
    var TYPE_EVENT = 'eaze-ui-event';

    var ERROR_CODES = {
        CANCELLED: 'CANCELLED',
        TIMEOUT: 'TIMEOUT',
        UNKNOWN_ACTION: 'UNKNOWN_ACTION',
        NO_HANDLER: 'NO_HANDLER',
        INVALID_PAYLOAD: 'INVALID_PAYLOAD',
        /** A field/question definition violated the contract while strictFields was on. */
        INVALID_FIELD: 'INVALID_FIELD',
        LISTENER_ERROR: 'LISTENER_ERROR',
        BRIDGE_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
        NO_BROWSER_CLIENT: 'NO_BROWSER_CLIENT',
        UNSAFE_REQUEST: 'UNSAFE_REQUEST'
    };

    /** Structured SDK error; carried inside the response envelope as {code,message,details}. */
    function EazeUiError(message, code, details) {
        var err = Error.call(this, message || 'Eaze UI SDK error');
        this.name = 'EazeUiError';
        this.message = err.message;
        this.code = code || ERROR_CODES.EAZE_UI_ERROR || 'EAZE_UI_ERROR';
        this.details = details == null ? null : details;
        if (Error.captureStackTrace) Error.captureStackTrace(this, EazeUiError);
    }
    EazeUiError.prototype = Object.create(Error.prototype);
    EazeUiError.prototype.constructor = EazeUiError;

    var idCounter = 0;
    function nextId(prefix) {
        idCounter += 1;
        return (prefix || 'req') + '-' + Date.now().toString(36) + '-' + idCounter.toString(36);
    }

    /* ------------------------------------------------------------------ *
     * Prototype-safe answer keys.
     * `answers.__proto__ = value` invokes the inherited Object.prototype setter
     * instead of creating a data property, so an answer named __proto__ is lost
     * (and can poison every other object in the page).  defineProperty always
     * creates an own enumerable property that JSON.stringify serialises.
     * ------------------------------------------------------------------ */
    var UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

    function isUnsafeKey(key) {
        return UNSAFE_KEYS.indexOf(String(key)) >= 0;
    }

    /** Writes one answer key without ever touching the prototype chain. */
    function safeSet(target, key, value) {
        if (!target || typeof target !== 'object') return false;
        Object.defineProperty(target, String(key), {
            value: value, enumerable: true, writable: true, configurable: true
        });
        return true;
    }

    function toErrorPayload(err) {
        if (!err) return { code: ERROR_CODES.UNKNOWN_ACTION, message: 'Unknown error', details: null };
        return {
            code: err.code || ERROR_CODES.LISTENER_ERROR,
            message: err.message || String(err),
            details: err.details == null ? null : err.details
        };
    }

    function createSdk(userConfig) {
        var config = Object.assign({
            allowInlineScript: false,   // eval() / inline <script> injection is OFF by default
            allowRemoteScripts: false,  // cross-origin plugin scripts are OFF by default
            requestTimeoutMs: 0,        // 0 = never time out (modal UI may wait indefinitely)
            /** Reject unknown field-spec keys instead of warning about them. */
            strictFields: false,
            /** How an unanswered control is encoded: 'null' | 'string' | 'omit'. */
            emptyValue: 'null'
        }, userConfig || {});

        /* ------------------------------------------------------------------ *
         * Diagnostics — non-fatal spec / coercion problems are collected here so
         * a host (or the JVM, via core.drainDiagnostics()) can surface them instead
         * of letting a silently dropped default disappear.
         * ------------------------------------------------------------------ */
        var warnings = [];
        var MAX_WARNINGS = 200;

        function diagnose(code, message, details) {
            var entry = { code: code || 'WARN', message: String(message == null ? '' : message), details: details == null ? null : details };
            if (warnings.length < MAX_WARNINGS) warnings.push(entry);
            console.warn('[eazeUiSdk][' + entry.code + '] ' + entry.message, details == null ? '' : details);
            return entry;
        }

        function listDiagnostics() { return warnings.slice(); }

        function drainDiagnostics() {
            var copy = warnings;
            warnings = [];
            return copy;
        }

        var listeners = {};             // action -> [{fn, once}]
        var handlers = {};              // action -> built-in handler(payload, ctx)
        var pending = {};               // request id -> {resolve, reject, timer, awaitRemote}
        var eventListeners = {};        // action -> [handler]  (fire-and-forget notifications)
        var transports = [];            // external relays (STOMP bridge, postMessage, webview host)
        var moduleRegistry = {};        // ui.registerModule target
        var apiFactories = {};          // name -> factory(api) — filled by feature files
        var createdApis = [];

        function assertAction(action) {
            if (typeof action !== 'string' || !action.trim()) {
                throw new EazeUiError('An action name is required.', ERROR_CODES.INVALID_PAYLOAD);
            }
            return action.trim();
        }

        /* ------------------------------------------------------------------ *
         * Listener registry — third-party JS hooks in without core edits.
         * A listener that returns anything other than `undefined` consumes
         * the request; otherwise dispatch falls through to the next listener
         * and finally to the built-in handler.
         * ------------------------------------------------------------------ */
        function registerListener(action, handler, options) {
            var name = assertAction(action);
            if (typeof handler !== 'function') {
                throw new EazeUiError('Listener for "' + name + '" must be a function.', ERROR_CODES.INVALID_PAYLOAD);
            }
            var once = !!(options && options.once);
            var entry = { fn: handler, once: once, action: name };
            (listeners[name] || (listeners[name] = [])).push(entry);
            return function unsubscribe() { unregisterListener(name, handler); };
        }

        function unregisterListener(action, handler) {
            var name = assertAction(action);
            if (!handler) { delete listeners[name]; return true; }
            var list = listeners[action];
            if (!list) return false;
            var filtered = list.filter(function (e) { return e.fn !== handler; });
            if (filtered.length) listeners[name] = filtered; else delete listeners[name];
            return filtered.length !== list.length;
        }

        function hasListener(action) {
            return !!(listeners[action] && listeners[action].length);
        }

        /** True when this window can serve `action` itself (listener or built-in). */
        function hasHandler(action) {
            return !!handlers[action] || hasListener(action);
        }

        /** Registers a built-in handler (used by the SDK feature files). */
        function registerHandler(action, handler) {
            var name = assertAction(action);
            if (typeof handler !== 'function') {
                throw new EazeUiError('Handler for "' + name + '" must be a function.', ERROR_CODES.INVALID_PAYLOAD);
            }
            handlers[name] = handler;
            return function unregister() { if (handlers[name] === handler) delete handlers[name]; };
        }

        /* ------------------------------------------------------------------ *
         * Dispatch pipeline: listeners first, built-in handler last.
         * Always resolves to a response envelope — never throws.
         * ------------------------------------------------------------------ */
        function dispatch(envelope) {
            var env = envelope || {};
            var action = env.action;
            var ctx = {
                id: env.id,
                action: action,
                sourcePluginId: env.sourcePluginId || 'unknown',
                sdk: publicApi,
                timestamp: env.timestamp || Date.now()
            };
            var response = {
                id: env.id || nextId('res'),
                type: TYPE_RESPONSE,
                action: action,
                ok: false,
                result: null,
                error: null
            };

            return Promise.resolve().then(function () {
                if (!action) throw new EazeUiError('Missing action.', ERROR_CODES.INVALID_PAYLOAD);
                var list = (listeners[action] || []).slice();
                var i = 0;

                function tryNext() {
                    if (i >= list.length) return Promise.resolve({ consumed: false, value: undefined });
                    var entry = list[i++];
                    return Promise.resolve(entry.fn(env.payload, ctx)).then(function (value) {
                        if (typeof value === 'undefined') return tryNext();
                        if (entry.once) unregisterListener(action, entry.fn);
                        return { consumed: true, value: value };
                    }).catch(function (err) {
                        if (entry.once) unregisterListener(action, entry.fn);
                        throw err;
                    });
                }

                return tryNext().then(function (outcome) {
                    if (outcome.consumed) return outcome.value;
                    var builtin = handlers[action];
                    if (!builtin) {
                        throw new EazeUiError(
                            'No listener or built-in handler registered for action "' + action + '".',
                            ERROR_CODES.NO_HANDLER,
                            { availableActions: Object.keys(handlers).concat(Object.keys(listeners)) }
                        );
                    }
                    return builtin(env.payload, ctx);
                });
            }).then(function (result) {
                response.ok = true;
                response.result = result === undefined ? null : result;
                return response;
            }).catch(function (err) {
                response.error = toErrorPayload(err);
                if (env.silent !== true) {
                    console.warn('[eazeUiSdk] "' + action + '" failed: ' + response.error.message, response.error.details || '');
                }
                return response;
            });
        }

        /* ------------------------------------------------------------------ *
         * Request API — plugin side. Returns a Promise resolved with the
         * handler result or rejected with an EazeUiError.
         * ------------------------------------------------------------------ */
        function request(action, payload, options) {
            var name = assertAction(action);
            var opts = options || {};
            var envelope = {
                id: nextId('req'),
                sourcePluginId: opts.pluginId || 'host',
                type: TYPE_REQUEST,
                action: name,
                payload: payload == null ? {} : payload,
                timestamp: Date.now()
            };

            return new Promise(function (resolve, reject) {
                var record = { resolve: resolve, reject: reject, timer: null, awaitRemote: false };
                var timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : config.requestTimeoutMs;

                if (timeoutMs > 0) {
                    record.timer = setTimeout(function () {
                        delete pending[envelope.id];
                        reject(new EazeUiError('Request "' + name + '" timed out.', ERROR_CODES.TIMEOUT, { id: envelope.id }));
                    }, timeoutMs);
                }

                var localCanServe = hasHandler(name);
                var forceRelay = opts.forwardToBridge === true;
                var willRelay = (forceRelay || !localCanServe) && transports.length > 0;

                // Registered before relaying: a synchronous transport reply must find it,
                // and awaitRemote is decided up-front so no reply can slip through the gap.
                record.awaitRemote = willRelay && !localCanServe;
                pending[envelope.id] = record;

                if (willRelay) {
                    transports.slice().forEach(function (t) {
                        try { t(envelope); } catch (e) { console.warn('[eazeUiSdk] transport failed', e); }
                    });
                }

                // Run locally when this window can serve the action, or when there is
                // nowhere to relay it to (then NO_HANDLER is the useful answer).
                if (localCanServe || !willRelay) {
                    dispatch(envelope).then(function (response) { settle(response, false); });
                }
            });
        }

        function settle(response, fromRemote) {
            if (!response || response.type !== TYPE_RESPONSE) return false;
            var record = pending[response.id];
            if (!record) return false;

            // A transport reply may only resolve a request that was actually relayed;
            // a local result may not shadow a request handed to the bridge.
            if (fromRemote === true && record.awaitRemote !== true) return false;
            if (fromRemote !== true && record.awaitRemote === true) return false;

            delete pending[response.id];
            if (record.timer) clearTimeout(record.timer);
            if (response.ok) record.resolve(response.result);
            else {
                var err = new EazeUiError(
                    response.error ? response.error.message : 'Request failed.',
                    response.error ? response.error.code : ERROR_CODES.LISTENER_ERROR,
                    response.error ? response.error.details : null
                );
                record.reject(err);
            }
            return true;
        }

        /**
         * Accepts an inbound envelope from any transport (response or event).
         * Requests raised by the JVM are answered by eaze_ui_sdk_bridge.js, which
         * dispatches locally and publishes the reply back on the socket.
         */
        function receive(raw, opts) {
            var meta = opts || {};
            var env = raw;
            if (typeof env === 'string') {
                try { env = JSON.parse(env); } catch (e) { return false; }
            }
            if (!env || typeof env !== 'object' || !env.type) return false;
            if (env.type === TYPE_RESPONSE) return settle(env, meta.remote !== false);
            if (env.type === TYPE_EVENT && env.action) return handleInboundEvent(env);
            return false;
        }

        /**
         * Backend push (`runtime.publishEvent(...)` on the JVM).  A listener registered
         * with onEvent() owns the event.  When nobody listens but this window does have a
         * built-in handler for the same action (ui.showToast, ui.showDialog, ...), the push
         * is dispatched as a silent request so Java-initiated notifications render instead
         * of vanishing into an empty listener table.
         */
        function handleInboundEvent(env) {
            if (notifyEvent(env.action, env.payload)) return true;
            if (!hasHandler(env.action)) return false;

            dispatch({
                id: env.id || nextId('evt'),
                type: TYPE_REQUEST,
                action: env.action,
                sourcePluginId: env.sourcePluginId || 'jvm',
                payload: env.payload == null ? {} : env.payload,
                silent: true
            });
            return true;
        }

        function addTransport(fn) {
            if (typeof fn !== 'function') throw new EazeUiError('Transport must be a function.', ERROR_CODES.INVALID_PAYLOAD);
            transports.push(fn);
            return function remove() {
                var i = transports.indexOf(fn);
                if (i >= 0) transports.splice(i, 1);
            };
        }

        /* ------------------------------------------------------------------ *
         * Event channel — fire-and-forget notifications (backend pushes).
         * ------------------------------------------------------------------ */
        function emitEvent(action, payload) {
            var name = assertAction(action);
            notifyEvent(name, payload);
            transports.slice().forEach(function (t) {
                try { t({ id: nextId('evt'), type: TYPE_EVENT, action: name, payload: payload == null ? {} : payload }); } catch (e) { /* ignore */ }
            });
        }

        /** @returns {boolean} true when a listener registered for this exact action ran. */
        function notifyEvent(action, payload) {
            var list = (eventListeners[action] || []).slice();
            list.forEach(function (fn) {
                try { fn(payload, { action: action, sdk: publicApi }); } catch (e) { console.warn('[eazeUiSdk] event handler failed for ' + action, e); }
            });
            var wild = (eventListeners['*'] || []).slice();
            wild.forEach(function (fn) {
                try { fn(payload, { action: action, sdk: publicApi }); } catch (e) { console.warn('[eazeUiSdk] wildcard event handler failed', e); }
            });
            return list.length > 0;
        }

        function onEvent(action, handler) {
            var name = assertAction(action);
            if (typeof handler !== 'function') throw new EazeUiError('Event handler must be a function.', ERROR_CODES.INVALID_PAYLOAD);
            (eventListeners[name] || (eventListeners[name] = [])).push(handler);
            return function off() {
                var list = eventListeners[name];
                if (!list) return;
                var i = list.indexOf(handler);
                if (i >= 0) list.splice(i, 1);
            };
        }

        /* ------------------------------------------------------------------ *
         * Plugin API construction. Feature files call defineUiMethod() to
         * contribute promise-based helpers bound to a pluginId.
         * ------------------------------------------------------------------ */
        function buildApi(pluginId) {
            var api = {
                pluginId: pluginId || 'host',
                version: VERSION,
                errorCodes: ERROR_CODES,
                EazeUiError: EazeUiError,
                request: function (action, payload, options) {
                    var o = Object.assign({ pluginId: api.pluginId }, options || {});
                    return request(action, payload, o);
                },
                dispatch: dispatch,
                receive: receive,
                registerListener: registerListener,
                unregisterListener: unregisterListener,
                hasListener: hasListener,
                onEvent: onEvent,
                emitEvent: emitEvent,
                addTransport: addTransport,
                config: config,
                diagnostics: listDiagnostics,
                drainDiagnostics: drainDiagnostics,
                modules: moduleRegistry
            };
            Object.keys(apiFactories).forEach(function (name) { api[name] = apiFactories[name](api); });
            createdApis.push(api);
            return api;
        }

        /** Feature-file hook: adds a promise-based method to every plugin API. */
        function defineUiMethod(name, factory) {
            if (!/^[a-zA-Z][A-Za-z0-9_]*$/.test(name)) {
                throw new EazeUiError('Illegal UI method name "' + name + '".', ERROR_CODES.INVALID_PAYLOAD);
            }
            apiFactories[name] = factory;
            createdApis.forEach(function (api) { api[name] = factory(api); });
        }

        var publicApi = buildApi('host');

        return Object.assign(publicApi, {
            /** Core plumbing namespace (kept out of the plugin-facing surface). */
            core: {
                version: VERSION,
                types: { REQUEST: TYPE_REQUEST, RESPONSE: TYPE_RESPONSE, EVENT: TYPE_EVENT },
                errorCodes: ERROR_CODES,
                EazeUiError: EazeUiError,
                nextId: nextId,
                safeSet: safeSet,
                isUnsafeKey: isUnsafeKey,
                diagnose: diagnose,
                diagnostics: listDiagnostics,
                drainDiagnostics: drainDiagnostics,
                registerHandler: registerHandler,
                hasHandler: hasHandler,
                defineUiMethod: defineUiMethod,
                buildApi: buildApi,
                createSdk: createSdk,
                config: config
            }
        });
    }

    /* ---------------------------------------------------------------------- *
     * Singleton bootstrap.  Idempotent: re-loading the file never resets an
     * existing SDK instance (protects hot-reload / double script tag).
     * ---------------------------------------------------------------------- */
    if (!root.eazeUiSdk) {
        var sdk = createSdk();
        root.eazeUiSdk = sdk;
        // buildApi lives inside the createSdk() closure — reach it through core.
        sdk.createPluginApi = function (pluginId) { return sdk.core.buildApi(pluginId); };

        if (root.eazeIde && typeof root.eazeIde.register === 'function') {
            root.eazeIde.register('uiSdk', sdk);
        }

        var markReady = function () {
            sdk.isReady = true;
            root.dispatchEvent(new CustomEvent('eaze-ui-sdk-ready', { detail: { sdk: sdk, version: VERSION } }));
        };
        sdk.ready = new Promise(function (resolve) {
            if (root.document && root.document.readyState !== 'loading') { markReady(); resolve(sdk); }
            else root.addEventListener('DOMContentLoaded', function () { markReady(); resolve(sdk); });
        });

        console.info('[eazeUiSdk] v' + VERSION + ' core loaded. window.eazeUiSdk is available for plugins.');
    }
})(window || globalThis);
