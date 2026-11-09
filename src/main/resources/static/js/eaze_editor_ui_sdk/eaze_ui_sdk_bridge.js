/**
 * @file eaze_ui_sdk_bridge.js
 * @description App-level bridge between the browser SDK and the JVM bus of the
 * <b>eaze_editor_ui_sdk</b> module.
 *
 * Transport is the host's STOMP broker over a single long-lived SockJS socket:
 *
 *   browser -> JVM : publish  /app/eaze-ui-sdk/request
 *   JVM -> window  : subscribe /topic/eaze-ui-sdk/client/{clientId}   (replies + directed events)
 *   JVM -> all     : subscribe /topic/eaze-ui-sdk/events              (broadcast pushes)
 *
 * There is deliberately <strong>no REST endpoint</strong>: requests, replies and
 * events are envelopes correlated by id over the socket.  Java plugins call
 * `ui.showForm(...)`, `ui.confirm(...)` or push a toast and the browser answers
 * through this file; conversely JS calls travel to JVM handlers registered with
 * `EazeUiSdk.forPlugin("...").onAction(...)`.
 *
 * STOMP library compatibility (important — hosts ship different builds):
 *   - stomp-websocket 2.x ("stomp.min.js", the build webui ships): the client has
 *     NO `publish()`; it exposes `send(destination, headers, body)`, and its
 *     `subscribe(dest, cb, headers)` uses `headers.id` as the subscription id.
 *   - @stomp/stompjs 5.x compat layer (`Stomp.over`): exposes `publish({destination,...})`.
 *   Both are handled by the tiny adapter below; passing one shared `headers.id`
 *   to two subscriptions is a bug (the second subscribe replaces the first), so
 *   every subscription gets its own header object and lets the library mint ids.
 *
 * Public surface (all optional — the SDK degrades gracefully without it):
 *   eazeUiSdk.bridge.clientId
 *   eazeUiSdk.bridge.connect(options?)            -> Promise<boolean>
 *   eazeUiSdk.bridge.disconnect(reason?)          -> boolean
 *   eazeUiSdk.bridge.isConnected()                -> boolean
 *   eazeUiSdk.bridge.status()                     -> { connected, clientId, endpoint, attempts, lastError }
 *   eazeUiSdk.subscribeBackendEvents(options?)    -> Promise<boolean>   (alias)
 *   eazeUiSdk.unsubscribeBackendEvents()          -> boolean            (alias)
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    var TYPE_REQUEST = core.types.REQUEST;
    var STORAGE_KEY = 'eazeUiSdk.clientId';

    var DEFAULTS = {
        enabled: true,                       // false => never touch the network (tests / harness)
        autoConnect: true,                   // connect as soon as the page is ready
        endpoint: '/ws/eaze-ui-sdk',         // registered by UiSdkWebSocketConfigurer
        requestDestination: '/app/eaze-ui-sdk/request',
        clientTopicPrefix: '/topic/eaze-ui-sdk/client/',
        eventsTopic: '/topic/eaze-ui-sdk/events',
        connectTimeoutMs: 15000,
        reconnectDelayMs: 3000,
        maxReconnectDelayMs: 20000,
        maxReconnectAttempts: -1,            // -1 = keep retrying (the editor outlives backend restarts), 0 = never
        debug: false
    };

    var config = Object.assign({}, DEFAULTS, core.config.bridge || {});
    core.config.bridge = config;

    var state = {
        client: null,
        adapter: null,
        subscriptions: [],
        connected: false,
        connecting: null,
        attempts: 0,
        manuallyClosed: false,
        lastError: null,
        registeredTransport: null
    };

    /* ------------------------------------------------------------------ *
     * Identity — one id per browser tab, reused across reconnects so the
     * JVM can always find its way back to the window that asked.
     * ------------------------------------------------------------------ */
    function uuid() {
        if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : ((r & 0x3) | 0x8);
            return v.toString(16);
        });
    }

    function resolveClientId() {
        try {
            var stored = root.sessionStorage && root.sessionStorage.getItem(STORAGE_KEY);
            if (stored) return stored;
        } catch (e) { /* private mode / file:// */ }

        var fresh = 'browser-' + uuid();
        try {
            if (root.sessionStorage) root.sessionStorage.setItem(STORAGE_KEY, fresh);
        } catch (e) { /* ignore */ }
        return fresh;
    }

    var clientId = resolveClientId();

    function log() {
        if (config.debug !== true) return;
        try { console.info.apply(console, ['[eazeUiSdk.bridge]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ }
    }

    /* ------------------------------------------------------------------ *
     * STOMP adapter — one small shim so both library generations work.
     *   legacy stomp-websocket 2.x : send(destination, headers, body)
     *   @stomp/stompjs compat      : publish({destination, headers, body})
     * ------------------------------------------------------------------ */
    function createAdapter(client) {
        var hasPublish = typeof client.publish === 'function';

        return {
            label: hasPublish ? 'stompjs/publish' : 'stomp-websocket/send',
            send: function (destination, headers, body) {
                if (hasPublish) {
                    client.publish({ destination: destination, headers: headers || {}, body: body });
                } else {
                    client.send(destination, headers || {}, body);
                }
            },
            subscribe: function (destination, callback) {
                // Fresh header object per subscription: stomp-websocket 2.x keys its
                // subscription map on `headers.id`, so a shared object would make the
                // second subscribe overwrite the first callback.
                return client.subscribe(destination, callback, {});
            },
            connect: function (headers, onConnect, onError) {
                // 2.x `_parseConnect` accepts (headersObject, cb, errCb); builds that
                // only understand positional login/passcode are served by the fallback.
                if (!hasPublish && client.connect.length >= 4) {
                    client.connect('eaze-ui-sdk', '', onConnect, onError);
                } else {
                    client.connect(headers, onConnect, onError);
                }
            },
            disconnect: function (onDone) {
                if (typeof client.disconnect === 'function') client.disconnect(onDone || function () {});
                else if (typeof client.deactivate === 'function') client.deactivate();
            }
        };
    }

    /* ------------------------------------------------------------------ *
     * Outbound: every envelope the SDK wants to show the JVM.
     * ------------------------------------------------------------------ */
    function publish(envelope) {
        if (!state.connected || !state.client || !state.adapter || !envelope) return false;

        var body = Object.assign({}, envelope, { clientId: clientId });
        // Do not leak our own locally-consumed requests twice: core already
        // filters what it hands to transports.
        try {
            state.adapter.send(config.requestDestination, { 'content-type': 'application/json' }, JSON.stringify(body));
            log('published', body.type, body.action || '', body.id);
            return true;
        } catch (e) {
            state.lastError = e && e.message ? e.message : String(e);
            log('publish failed', state.lastError);
            return false;
        }
    }

    /* ------------------------------------------------------------------ *
     * Inbound: responses, events and JVM-initiated requests.
     * ------------------------------------------------------------------ */
    function onRawMessage(frame) {
        var message = null;
        try { message = JSON.parse(frame && frame.body ? frame.body : ''); } catch (e) { return; }
        if (!message || typeof message !== 'object' || !message.type) return;

        if (message.type === TYPE_REQUEST) {
            // A Java plugin is asking this window to do something UI-ish.
            Promise.resolve().then(function () { return sdk.dispatch(message); }).then(function (response) {
                publish(response);
            }).catch(function (error) {
                log('inbound request failed', error && error.message);
            });
            return;
        }

        sdk.receive(message, { remote: true });
    }

    /* ------------------------------------------------------------------ *
     * Connection lifecycle
     * ------------------------------------------------------------------ */
    function isConnected() {
        return state.connected === true && !!(state.client && state.client.connected !== false);
    }

    function dropSubscriptions() {
        state.subscriptions = [];
    }

    function connect(options) {
        var opts = options || {};

        if (isConnected()) return Promise.resolve(true);
        if (state.connecting) return state.connecting;

        if (config.enabled === false) {
            return Promise.reject(new EazeUiError(
                'The UI SDK bridge is disabled (eazeUiSdk.core.config.bridge.enabled = false).',
                CODE.BRIDGE_UNAVAILABLE));
        }
        var stompLib = root.Stomp && typeof root.Stomp.over === 'function' ? root.Stomp : null;
        if (typeof root.SockJS === 'undefined' || !stompLib) {
            return Promise.reject(new EazeUiError(
                'SockJS / StompJS are not loaded on this page — the bridge needs both.',
                CODE.BRIDGE_UNAVAILABLE));
        }

        var endpoint = opts.endpoint || config.endpoint;
        var client = null;
        var adapter = null;

        state.manuallyClosed = false;
        state.connecting = new Promise(function (resolve, reject) {
            try {
                client = stompLib.over(new root.SockJS(endpoint));
                adapter = createAdapter(client);
                client.debug = config.debug === true
                    ? function () { log.apply(null, ['stomp'].concat([].slice.call(arguments))); }
                    : function () { /* silence */ };
            } catch (e) {
                state.connecting = null;
                reject(new EazeUiError('Bridge socket could not be created: ' + (e && e.message), CODE.BRIDGE_UNAVAILABLE));
                return;
            }

            var settled = false;

            var timer = setTimeout(function () {
                if (settled || isConnected()) return;
                settled = true;
                try { adapter.disconnect(); } catch (e) { /* ignore */ }
                state.client = null;
                state.adapter = null;
                state.connected = false;
                state.connecting = null;
                reject(new EazeUiError('Bridge connect timed out after ' + config.connectTimeoutMs + ' ms.', CODE.TIMEOUT));
            }, config.connectTimeoutMs);

            var onConnect = function () {
                clearTimeout(timer);
                if (settled) return;
                settled = true;

                state.client = client;
                state.adapter = adapter;
                state.connected = true;
                state.lastError = null;

                dropSubscriptions();
                try {
                    // Distinct subscriptions, distinct ids: events broadcast + our own reply topic.
                    state.subscriptions.push(adapter.subscribe(config.eventsTopic, onRawMessage));
                    state.subscriptions.push(adapter.subscribe(config.clientTopicPrefix + clientId, onRawMessage));
                } catch (e) {
                    state.lastError = e && e.message ? e.message : String(e);
                    log('subscribe failed', state.lastError);
                }

                if (!state.registeredTransport) {
                    state.registeredTransport = sdk.addTransport(function (envelope) { publish(envelope); });
                }
                // Announce ourselves so the JVM knows this window exists and can push a
                // toast or open a dialog before the page ever sends its first request.
                publish({
                    id: core.nextId('evt'), type: 'eaze-ui-event',
                    action: 'ui.bridge.connected', payload: { clientId: clientId }
                });

                log('connected as', clientId, 'via', adapter.label);
                resolve(true);
            };

            var onError = function (error) {
                clearTimeout(timer);
                if (settled && state.client !== client) return;
                settled = true;

                var message = error && error.message ? error.message : String(error || 'bridge connect failed');
                state.lastError = message;
                state.connected = false;
                state.client = null;
                state.adapter = null;
                dropSubscriptions();

                if (state.connecting) {
                    state.connecting = null;
                    scheduleReconnect();
                    reject(new EazeUiError('Bridge connect failed: ' + message, CODE.BRIDGE_UNAVAILABLE));
                } else {
                    // The socket died after a successful connect: reconnect quietly.
                    scheduleReconnect();
                }
            };

            try {
                adapter.connect({ id: clientId }, onConnect, onError);
            } catch (e) {
                clearTimeout(timer);
                settled = true;
                state.connecting = null;
                reject(new EazeUiError('Bridge connect failed: ' + (e && e.message), CODE.BRIDGE_UNAVAILABLE));
            }
        });

        return state.connecting;
    }

    function reconnectDelay() {
        var base = Math.max(250, config.reconnectDelayMs);
        var cap = Math.max(base, config.maxReconnectDelayMs || base * 5);
        return Math.min(cap, base + (base * state.attempts));
    }

    function scheduleReconnect() {
        if (state.manuallyClosed || config.enabled === false) return;
        if (config.maxReconnectAttempts === 0) return;
        if (config.maxReconnectAttempts > 0 && state.attempts >= config.maxReconnectAttempts) {
            log('giving up after', state.attempts, 'attempts');
            return;
        }

        state.attempts += 1;
        var delay = reconnectDelay();
        setTimeout(function () {
            if (isConnected() || state.manuallyClosed) return;
            connect().catch(function () { /* scheduleReconnect already ran */ });
        }, delay);
    }

    function disconnect(reason) {
        state.manuallyClosed = true;
        if (!state.client) return false;

        try { createAdapter(state.client).disconnect(); } catch (e) { /* ignore */ }
        state.client = null;
        state.adapter = null;
        state.connected = false;
        state.connecting = null;
        dropSubscriptions();
        if (state.registeredTransport) {
            try { state.registeredTransport(); } catch (e) { /* ignore */ }
            state.registeredTransport = null;
        }
        log('disconnected', reason || '');
        return true;
    }

    function status() {
        return {
            connected: isConnected(),
            clientId: clientId,
            endpoint: config.endpoint,
            requestDestination: config.requestDestination,
            eventsTopic: config.eventsTopic,
            clientTopic: config.clientTopicPrefix + clientId,
            stompApi: state.adapter ? state.adapter.label : null,
            subscriptions: state.subscriptions.length,
            attempts: state.attempts,
            lastError: state.lastError
        };
    }

    /* ------------------------------------------------------------------ *
     * Export + auto-connect
     * ------------------------------------------------------------------ */
    sdk.bridge = {
        clientId: clientId,
        connect: connect,
        disconnect: disconnect,
        isConnected: isConnected,
        status: status,
        config: config
    };

    // Back-compatible aliases (the pre-bridge build exposed these names).
    sdk.subscribeBackendEvents = function (options) { return connect(options); };
    sdk.unsubscribeBackendEvents = function () { return disconnect('unsubscribeBackendEvents'); };

    if (root.eazeIde && typeof root.eazeIde.register === 'function') {
        root.eazeIde.register('uiSdkBridge', sdk.bridge);
    }

    if (config.autoConnect === true) {
        var boot = function () { connect().catch(function (e) { log('auto-connect skipped:', e && e.message); }); };
        if (root.document && root.document.readyState !== 'loading') boot();
        else root.addEventListener('DOMContentLoaded', boot);
    }
})(window || globalThis);
