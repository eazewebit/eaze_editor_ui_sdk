/**
 * @file eaze_ui_sdk_form.js
 * @description Structured, plugin-driven forms for the Eaze Editor UI SDK.
 *
 * Built-in action:
 *   ui.showForm { title, description, fields[], submitLabel, cancelLabel, size } -> { name: value }
 *
 * Contract:
 *   - Renders native HTML inputs (see eaze_ui_sdk_fields.js).
 *   - Resolves with a plain values object on submit; required/custom validation
 *     failures keep the dialog open and surface an inline error.
 *   - Rejects with EazeUiError(code:'CANCELLED') when dismissed.
 *   - `onValidate(values)` may be supplied (synchronous) and returns an error
 *     message string to block submission, or null/undefined to accept.
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    function showFormHandler(payload, ctx) {
        var p = payload || {};
        if (!Array.isArray(p.fields) || !p.fields.length) {
            throw new EazeUiError('ui.showForm requires a non-empty "fields" array.', CODE.INVALID_PAYLOAD);
        }
        var pluginId = (ctx && ctx.sourcePluginId) || 'host';
        var hostEl = null;
        var errorHost = null;
        var controls = [];

        try {
            // renderFields() normalises the whole list at once: duplicate answer keys and unknown
            // spec keys are reported (and rejected when strictFields / payload.strictFields is on).
            var scratch = root.document.createDocumentFragment();
            controls = core.fields.renderFields(p.fields, scratch, { sdk: sdk, pluginId: pluginId, strict: p.strictFields === true });
        } catch (fieldError) {
            throw fieldError instanceof EazeUiError ? fieldError
                : new EazeUiError('Invalid form field definition: ' + fieldError.message, CODE.INVALID_PAYLOAD);
        }

        var promise = core.dialog.open({
            title: p.title || 'Input required',
            size: p.size || 'md',
            icon: p.icon || null,
            pluginId: pluginId,
            cancelBehavior: p.cancelBehavior || 'reject',
            className: 'eaze-ui-form',
            content: function (host) {
                hostEl = host;
                if (p.description) host.appendChild(textBlock('eaze-ui-form__description', p.description));
                errorHost = textBlock('eaze-ui-form__error', '');
                errorHost.hidden = true;
                host.appendChild(errorHost);
                var form = root.document.createElement('div');
                form.className = 'eaze-ui-form__fields' + (p.layout === 'grid' ? ' eaze-ui-form__fields--grid' : '');
                controls.forEach(function (c) { form.appendChild(c.element); });
                host.appendChild(form);
            },
            buttons: [
                { id: 'cancel', label: p.cancelLabel || 'Cancel', variant: 'ghost' },
                { id: 'submit', label: p.submitLabel || 'Submit', isPrimary: true }
            ]
        });

        // The dialog DOM exists by the time open() returns (its Promise executor
        // runs synchronously), so the submit guard can be attached immediately.
        var dialogEl = hostEl && hostEl.closest ? hostEl.closest('.eaze-ui-dialog') : null;
        var guard = function (ev) {
            var btn = ev.target && ev.target.closest ? ev.target.closest('[data-eaze-ui-dialog-button="submit"]') : null;
            if (!btn || !dialogEl || !dialogEl.contains(btn)) return;
            var message = core.fields.validateAll(controls);
            if (!message && typeof p.onValidate === 'function') {
                try { message = p.onValidate(core.fields.collect(controls)) || null; }
                catch (e) { message = e && e.message ? e.message : String(e); }
            }
            if (message) { ev.preventDefault(); ev.stopPropagation(); paintError(errorHost, message); }
            else if (errorHost) { errorHost.hidden = true; errorHost.textContent = ''; }
        };

        function cleanup() { document.removeEventListener('click', guard, true); }
        if (dialogEl) document.addEventListener('click', guard, true);

        return promise.then(function () {
            cleanup();
            var values = core.fields.collectValues(controls, { emptyValue: p.emptyValue, pluginId: pluginId });
            if (p.includeMeta === true) {
                Object.defineProperty(values, '_meta', {
                    value: {
                        pluginId: pluginId,
                        emptyValue: core.config.emptyValue,
                        warnings: core.spec.collectWarnings(controls),
                        submittedAt: Date.now()
                    },
                    enumerable: false, configurable: true
                });
            }
            return values;
        })['catch'](function (err) {
            cleanup();
            throw err;
        });
    }

    function textBlock(className, text) {
        var node = root.document.createElement('div');
        node.className = className;
        node.textContent = String(text == null ? '' : text);
        return node;
    }

    function paintError(hostNode, message) {
        if (!hostNode) return;
        hostNode.textContent = String(message);
        hostNode.hidden = false;
    }

    core.registerHandler('ui.showForm', showFormHandler);

    core.defineUiMethod('showForm', function (api) {
        return function (fieldsOrOptions, maybeFields) {
            var payload = (Array.isArray(fieldsOrOptions))
                ? { fields: fieldsOrOptions }
                : Object.assign({}, fieldsOrOptions || {});
            if (maybeFields) payload.fields = maybeFields;
            payload.pluginId = payload.pluginId || api.pluginId;
            return api.request('ui.showForm', payload);
        };
    });
})(window || globalThis);
