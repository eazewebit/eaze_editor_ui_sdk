/**
 * @file eaze_ui_sdk_css.js
 * @description CSS + script registration features for the Eaze Editor UI SDK.
 *
 * Built-in actions:
 *   ui.applyCss      { id?, css?|url?, scope?, pluginId }  -> { id, styleTagId }
 *   ui.removeCss     { id? | allForPlugin? }               -> { removed: string[] }
 *   ui.listCss       {}                                    -> { ids: string[] }
 *   ui.loadScript    { url, moduleId?, type?, async? }      -> { url, loaded:true }
 *   ui.registerModule{ name, value }                        -> { name }
 *   ui.getModule     { name }                               -> value
 *
 * Security posture (no core changes needed per plugin):
 *   - remote (cross-origin) scripts are rejected unless config.allowRemoteScripts
 *   - inline script execution (eval / new Function) is never used; it stays off
 *     behind config.allowInlineScript and no SDK code path consumes it
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;
    var ATTR_ID = 'data-eaze-ui-sdk-css';
    var ATTR_PLUGIN = 'data-eaze-ui-sdk-plugin';
    var loadedScripts = {};

    function assertString(value, label) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new EazeUiError(label + ' must be a non-empty string.', CODE.INVALID_PAYLOAD);
        }
        return value;
    }

    /**
     * Best-effort namespacing: prefixes every top-level selector with the SDK
     * scope attribute so plugin CSS cannot leak into the editor shell.
     * At-rules (@media/@supports) are traversed one level; :root/html/body and
     * keyframe percentage selectors are left untouched.
     */
    function scopeCss(css, scopeSelector) {
        var open = 0, buffer = '', out = '';

        function emit(selector) {
            var sel = selector.trim();
            if (!sel) return;
            if (/^@/.test(sel)) { out += sel + ' '; return; }
            var parts = sel.split(',').map(function (part) {
                var p = part.trim();
                if (!p || /^from$|^to$|^[\d.]+%$/.test(p)) return p;
                if (/^(?:html|body|:root)(?![\w-])/.test(p)) return scopeSelector + ' ' + p.replace(/^(?:html|body|:root)/, '');
                return scopeSelector + ' ' + p;
            });
            out += parts.join(', ') + ' ';
        }

        for (var i = 0; i < css.length; i++) {
            var ch = css.charAt(i);
            if (ch === '{') {
                if (open === 0) {
                    var head = buffer.trim();
                    buffer = '';
                    if (/^@/.test(head)) { out += head + ' {'; open += 1; }
                    else { emit(head); out += '{'; open += 1; }
                } else { buffer += ch; open += 1; }
            } else if (ch === '}') {
                open -= 1;
                if (buffer.trim()) emit(buffer);
                buffer = '';
                out += '}';
                if (open < 0) open = 0;
            } else if (open === 0 && ch === ';') {
                buffer = '';                       // top-level declaration: drop it
            } else if (open <= 1) {
                buffer += ch;
            }
        }
        if (buffer.trim()) emit(buffer);
        return out;
    }

    function styleRoot() {
        var el = root.document.getElementById('eaze-ui-sdk-css-root');
        if (!el) {
            el = root.document.createElement('div');
            el.id = 'eaze-ui-sdk-css-root';
            el.hidden = true;
            root.document.head.appendChild(el);
        }
        return el;
    }

    function applyCss(payload, ctx) {
        var p = payload || {};
        var pluginId = p.pluginId || (ctx && ctx.sourcePluginId) || 'anonymous';
        var id = assertString(p.id || nextCssId(pluginId), 'CSS id');
        var existing = root.document.getElementById('eaze-ui-sdk-css-' + id);

        if (existing) existing.remove();

        var tag;
        if (typeof p.css === 'string' && p.css.trim()) {
            tag = root.document.createElement('style');
            tag.type = 'text/css';
            tag.id = 'eaze-ui-sdk-css-' + id;
            var cssText = p.scope ? scopeCss(p.css, '[data-eaze-ui-scope="' + id + '"]') : p.css;
            tag.textContent = cssText;
        } else if (p.url) {
            tag = root.document.createElement('link');
            tag.rel = 'stylesheet';
            tag.id = 'eaze-ui-sdk-css-' + id;
            tag.href = assertString(p.url, 'CSS url');
        } else {
            throw new EazeUiError('ui.applyCss requires either "css" (string) or "url".', CODE.INVALID_PAYLOAD);
        }

        // setAttribute (not bracket access): dashed names are not writable expando props.
        tag.setAttribute(ATTR_ID, id);
        tag.setAttribute(ATTR_PLUGIN, pluginId);
        if (p.media) tag.setAttribute('media', String(p.media));
        styleRoot().appendChild(tag);
        return { id: id, styleTagId: tag.id, scoped: !!p.scope };
    }

    var cssSeq = 0;
    function nextCssId(pluginId) { return 'plugin-' + String(pluginId).replace(/[^A-Za-z0-9_-]/g, '') + '-' + (++cssSeq); }

    function removeCss(payload) {
        var p = payload || {};
        var removed = [];
        if (p.id) {
            var nodes = root.document.querySelectorAll('[' + ATTR_ID + '="' + String(p.id).replace(/"/g, '') + '"]');
            Array.prototype.forEach.call(nodes, function (n) { removed.push(n.getAttribute(ATTR_ID)); n.remove(); });
        } else if (p.allForPlugin) {
            var scoped = root.document.querySelectorAll('[' + ATTR_PLUGIN + '=' + JSON.stringify(String(p.allForPlugin)) + ']');
            Array.prototype.forEach.call(scoped, function (n) { removed.push(n.getAttribute(ATTR_ID)); n.remove(); });
        } else {
            throw new EazeUiError('ui.removeCss requires "id" or "allForPlugin".', CODE.INVALID_PAYLOAD);
        }
        return { removed: removed };
    }

    function listCss() {
        var ids = [];
        Array.prototype.forEach.call(root.document.querySelectorAll('[' + ATTR_ID + ']'), function (n) {
            ids.push(n.getAttribute(ATTR_ID));
        });
        return { ids: ids };
    }

    function isSameOrigin(url) {
        try {
            var resolved = new URL(url, root.location.href);
            if (!/^(https?:|blob:)$/.test(resolved.protocol)) return false;
            return resolved.origin === root.location.origin;
        } catch (e) { return false; }
    }

    function loadScript(payload) {
        var p = payload || {};
        var url = assertString(p.url, 'Script url');
        if (!isSameOrigin(url) && !core.config.allowRemoteScripts) {
            throw new EazeUiError(
                'Refusing to load cross-origin script "' + url + '". Host must enable config.allowRemoteScripts explicitly.',
                CODE.UNSAFE_REQUEST
            );
        }
        var key = url;
        if (loadedScripts[key] && loadedScripts[key].parentNode) return loadedScripts[key].loadedPromise;

        var tag = root.document.createElement('script');
        tag.src = url;
        tag.async = p.async !== false;
        tag.setAttribute(ATTR_PLUGIN, String(p.pluginId || 'anonymous'));
        if (p.integrity) { tag.integrity = p.integrity; tag.crossOrigin = p.crossorigin || 'anonymous'; }

        var promise = new Promise(function (resolve, reject) {
            tag.addEventListener('load', function () { resolve({ url: url, loaded: true }); });
            tag.addEventListener('error', function () {
                delete loadedScripts[key];
                reject(new EazeUiError('Failed to load script "' + url + '".', CODE.BRIDGE_UNAVAILABLE, { url: url }));
            });
        });

        loadedScripts[key] = { parentNode: null, loadedPromise: promise };
        root.document.body.appendChild(tag);
        loadedScripts[key].parentNode = tag;
        return promise;
    }

    function registerModule(payload) {
        var p = payload || {};
        var name = assertString(p.name, 'Module name');
        if (arguments.length === 0) throw new EazeUiError('ui.registerModule requires a payload.', CODE.INVALID_PAYLOAD);
        sdk.modules[name] = p.value;
        if (root.eazeIde && typeof root.eazeIde.register === 'function' && !root.eazeIde.module(name)) {
            root.eazeIde.register(name, p.value);
        }
        return { name: name };
    }

    function getModule(payload) {
        var name = assertString((payload || {}).name, 'Module name');
        if (!(name in sdk.modules)) throw new EazeUiError('No SDK module registered as "' + name + '".', CODE.NO_HANDLER);
        return sdk.modules[name];
    }

    core.registerHandler('ui.applyCss', applyCss);
    core.registerHandler('ui.removeCss', removeCss);
    core.registerHandler('ui.listCss', listCss);
    core.registerHandler('ui.loadScript', loadScript);
    core.registerHandler('ui.registerModule', registerModule);
    core.registerHandler('ui.getModule', getModule);

    core.defineUiMethod('applyCss', function (api) {
        return function (optionsOrId, maybeCss) {
            var payload = (typeof optionsOrId === 'string') ? { css: String(maybeCss || '') } : Object.assign({}, optionsOrId);
            payload.pluginId = payload.pluginId || api.pluginId;
            return api.request('ui.applyCss', payload);
        };
    });

    core.defineUiMethod('removeCss', function (api) {
        return function (id) {
            var payload = (typeof id === 'string') ? { id: id } : Object.assign({}, id);
            if (!payload.id && !payload.allForPlugin) payload.allForPlugin = api.pluginId;
            return api.request('ui.removeCss', payload);
        };
    });

    core.defineUiMethod('listCss', function (api) { return function () { return api.request('ui.listCss', {}); }; });

    core.defineUiMethod('loadScript', function (api) {
        return function (urlOrOptions, moduleId) {
            var payload = (typeof urlOrOptions === 'string') ? { url: urlOrOptions, moduleId: moduleId } : Object.assign({}, urlOrOptions);
            payload.pluginId = payload.pluginId || api.pluginId;
            return api.request('ui.loadScript', payload);
        };
    });

    core.defineUiMethod('registerModule', function (api) {
        return function (name, value) {
            var payload = (typeof name === 'string') ? { name: name, value: value } : Object.assign({}, name);
            payload.pluginId = api.pluginId;
            return api.request('ui.registerModule', payload);
        };
    });

    core.defineUiMethod('getModule', function (api) {
        return function (name) { return api.request('ui.getModule', { name: name }); };
    });
})(window || globalThis);
