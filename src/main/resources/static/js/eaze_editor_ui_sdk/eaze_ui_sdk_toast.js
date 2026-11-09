/**
 * @file eaze_ui_sdk_toast.js
 * @description Toast notifications for the Eaze Editor UI SDK.
 *
 * Built-in action:
 *   ui.showToast  { type, title?, message, durationMs?, position?, sticky? } -> { id }
 *   ui.dismissToast { id | all:true }                                        -> { dismissed: string[] }
 *
 * Toasts are stacked per position, capped by MAX_STACK (oldest is evicted), so
 * a chatty plugin can never bury the editor UI.  Styling lives entirely in
 * /css/eaze_editor_ui_sdk.css — no Tailwind dependency, no inline CSS.
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    var MAX_STACK = 5;
    var DEFAULT_DURATION = { success: 3200, info: 3600, warning: 4200, error: 6000 };
    var TYPES = ['success', 'info', 'warning', 'error'];
    var ICONS = {
        success: 'M20 6 9 17l-5-5',
        info: 'M12 16v-4M12 8h.01',
        warning: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
        error: 'M15 9l-6 6M9 9l6 6'
    };
    var containers = {};
    var registry = {};
    var seq = 0;

    function containerFor(position) {
        var key = TYPES_POSITIONS.indexOf(position) >= 0 ? position : 'top-right';
        if (containers[key] && containers[key].parentNode) return containers[key];
        var el = root.document.createElement('div');
        el.className = 'eaze-ui-toast-stack';
        el.dataset.eazeUiToastPosition = key;
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Notifications');
        (root.document.body || root.document.documentElement).appendChild(el);
        containers[key] = el;
        return el;
    }

    var TYPES_POSITIONS = [
        'top-left', 'top-center', 'top-right',
        'bottom-left', 'bottom-center', 'bottom-right'
    ];

    function normalizeType(value) {
        var t = String(value || 'info').toLowerCase();
        return TYPES.indexOf(t) >= 0 ? t : 'info';
    }

    function showToast(payload, ctx) {
        var p = payload || {};
        if (typeof p.message !== 'string' && !p.title) {
            throw new EazeUiError('ui.showToast requires a "message" (or at least a "title").', CODE.INVALID_PAYLOAD);
        }
        var type = normalizeType(p.type);
        var id = 'toast-' + (++seq);
        var host = containerFor(p.position);

        // Eviction must be synchronous: the animated destroy() detaches the node on a
        // timer, so looping over it would never reduce children.length (infinite loop).
        while (host.children.length >= MAX_STACK) {
            var oldest = host.firstElementChild;
            if (!oldest) break;
            forceRemove(oldest);
        }

        var el = root.document.createElement('div');
        el.className = 'eaze-ui-toast eaze-ui-toast--' + type;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');
        el.dataset.eazeUiToastId = id;

        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('class', 'eaze-ui-toast__icon');
        icon.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICONS[type]);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        icon.appendChild(path);

        var body = root.document.createElement('div');
        body.className = 'eaze-ui-toast__body';
        if (p.title) {
            var title = root.document.createElement('div');
            title.className = 'eaze-ui-toast__title';
            title.textContent = String(p.title);
            body.appendChild(title);
        }
        var msg = root.document.createElement('div');
        msg.className = 'eaze-ui-toast__message';
        msg.textContent = p.message == null ? '' : String(p.message);   // textContent => no HTML injection
        body.appendChild(msg);

        var close = root.document.createElement('button');
        close.type = 'button';
        close.className = 'eaze-ui-toast__close';
        close.setAttribute('aria-label', 'Dismiss notification');
        close.textContent = '\u00d7';
        close.addEventListener('click', function () { destroy(id); });

        el.appendChild(icon);
        el.appendChild(body);
        el.appendChild(close);
        host.appendChild(el);

        var record = { id: id, element: el, timer: null };
        registry[id] = record;

        var duration = typeof p.durationMs === 'number' ? p.durationMs : DEFAULT_DURATION[type];
        if (!p.sticky && duration > 0) {
            record.timer = setTimeout(function () { destroy(id); }, duration);
        }
        el.addEventListener('mouseenter', function () { if (record.timer) { clearTimeout(record.timer); record.timer = null; } });

        return { id: id, type: type };
    }

    function forceRemove(node) {
        if (!node || !node.parentNode) return false;
        var id = node.dataset.eazeUiToastId;
        var record = registry[id];
        if (record) {
            if (record.timer) clearTimeout(record.timer);
            delete registry[id];
        }
        node.remove();
        return true;
    }

    function destroy(id) {
        var record = registry[id];
        if (!record) return false;
        if (record.timer) clearTimeout(record.timer);
        delete registry[id];
        var el = record.element;
        el.classList.add('eaze-ui-toast--leaving');
        setTimeout(function () { if (el.parentNode) el.remove(); }, 180);
        return true;
    }

    function dismissToast(payload) {
        var p = payload || {};
        var dismissed = [];
        if (p.all === true) {
            Object.keys(registry).forEach(function (id) { dismissed.push(id); destroy(id); });
            return { dismissed: dismissed };
        }
        if (!p.id) throw new EazeUiError('ui.dismissToast requires "id" or {all:true}.', CODE.INVALID_PAYLOAD);
        if (destroy(String(p.id))) dismissed.push(String(p.id));
        return { dismissed: dismissed };
    }

    core.registerHandler('ui.showToast', showToast);
    core.registerHandler('ui.dismissToast', dismissToast);

    function shorthand(api, type) {
        return function (message, options) {
            var payload = Object.assign({ type: type, message: String(message == null ? '' : message) }, options || {});
            payload.pluginId = api.pluginId;
            return api.request('ui.showToast', payload);
        };
    }

    core.defineUiMethod('showToast', function (api) {
        return function (optionsOrMessage, maybeOptions) {
            var payload = (typeof optionsOrMessage === 'string')
                ? Object.assign({ message: optionsOrMessage }, maybeOptions || {})
                : Object.assign({}, optionsOrMessage);
            payload.pluginId = payload.pluginId || api.pluginId;
            return api.request('ui.showToast', payload);
        };
    });

    core.defineUiMethod('dismissToast', function (api) {
        return function (id) {
            var payload = (typeof id === 'string') ? { id: id } : Object.assign({}, id);
            return api.request('ui.dismissToast', payload);
        };
    });

    TYPES.forEach(function (type) {
        core.defineUiMethod(type + 'Toast', function (api) { return shorthand(api, type); });
    });
})(window || globalThis);
