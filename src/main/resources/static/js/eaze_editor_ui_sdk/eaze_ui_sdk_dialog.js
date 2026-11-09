/**
 * @file eaze_ui_sdk_dialog.js
 * @description Modal dialogs / confirmations for the Eaze Editor UI SDK.
 *
 * Built-in actions:
 *   ui.showDialog { title, message|html|content, buttons[], size, closable } -> { button, value }
 *   ui.closeDialog {}                                                         -> { closed: number }
 *
 * Behaviour:
 *   - Promise resolves with {button:<id>, value:<optional>} on a button click.
 *   - Promise REJECTS with an EazeUiError(code:'CANCELLED') when the user
 *     dismisses via Cancel / Esc / backdrop, unless cancelBehavior:'resolve'
 *     is passed (then it resolves with {button:<cancelId>, cancelled:true}).
 *   - Accessible: role="dialog", aria-modal, labelled title, focus trapped and
 *     restored, Tab cycling contained inside the dialog.  Only the topmost
 *     dialog reacts to Esc/Tab so stacked dialogs behave predictably.
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    var openDialogs = [];      // LIFO stack of live dialog records
    var zTop = 2100;           // above editor chrome (toaster 1100, legacy modals 1000)

    function sanitizeHtml(html) {
        var raw = String(html == null ? '' : html);
        if (root.DOMPurify && typeof root.DOMPurify.sanitize === 'function') return root.DOMPurify.sanitize(raw);
        return raw.replace(/<[^>]*>/g, '');   // no sanitizer => text only
    }

    function queryFocusables(scope) {
        var selector = 'a[href],button:not([disabled]),textarea:not([disabled]),' +
            'input:not([disabled]):not([type=hidden]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
        return Array.prototype.filter.call(scope.querySelectorAll(selector), function (el) {
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el === root.document.activeElement;
        });
    }

    function buildButton(spec, index) {
        var btn = root.document.createElement('button');
        btn.type = 'button';
        btn.className = 'eaze-ui-btn eaze-ui-btn--' + (spec.variant || (spec.isPrimary ? 'primary' : 'ghost'));
        if (spec.id === 'cancel') btn.classList.add('eaze-ui-btn--cancel');
        btn.textContent = String(spec.label == null ? (spec.isPrimary ? 'OK' : 'Button ' + (index + 1)) : spec.label);
        btn.dataset.eazeUiDialogButton = String(spec.id == null ? 'button-' + index : spec.id);
        if (spec.value !== undefined) btn.dataset.eazeUiDialogValue = JSON.stringify(spec.value);
        return btn;
    }

    /**
     * Opens a modal dialog.  Returns a Promise resolved with the clicked
     * button descriptor, rejected on cancellation (see cancelBehavior).
     */
    function open(options) {
        var o = Object.assign({
            title: '',
            message: '',
            html: null,
            content: null,                 // Node | (hostEl) => void
            size: 'md',
            icon: null,
            buttons: null,
            closable: true,
            closeOnBackdrop: true,
            escCancels: true,
            cancelId: 'cancel',
            cancelBehavior: 'reject',      // 'reject' | 'resolve'
            className: '',
            pluginId: 'host'
        }, options || {});

        return new Promise(function (resolve, reject) {
            var previouslyFocused = root.document.activeElement;
            var overlay = root.document.createElement('div');
            overlay.className = 'eaze-ui-overlay';
            overlay.style.zIndex = String(zTop++);

            var dialog = root.document.createElement('div');
            dialog.className = 'eaze-ui-dialog eaze-ui-dialog--' + o.size + (o.className ? ' ' + o.className : '');
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');

            var heading = root.document.createElement('h2');
            heading.className = 'eaze-ui-dialog__title';
            heading.id = core.nextId('dlg-title');
            if (o.icon) {
                var iconEl = root.document.createElement('span');
                iconEl.className = 'eaze-ui-dialog__icon';
                iconEl.textContent = String(o.icon);        // glyph only, never HTML
                heading.appendChild(iconEl);
            }
            var titleText = root.document.createElement('span');
            titleText.textContent = String(o.title == null ? '' : o.title);
            heading.appendChild(titleText);
            dialog.setAttribute('aria-labelledby', heading.id);

            var header = root.document.createElement('div');
            header.className = 'eaze-ui-dialog__header';
            header.appendChild(heading);

            var record = { overlay: overlay, settleExternal: null };

            function requestClose() { settle({ button: o.cancelId, cancelled: true }); }

            if (o.closable) {
                var x = root.document.createElement('button');
                x.type = 'button';
                x.className = 'eaze-ui-dialog__close';
                x.setAttribute('aria-label', 'Close dialog');
                x.textContent = '\u00d7';
                x.addEventListener('click', requestClose);
                header.appendChild(x);
            }

            var body = root.document.createElement('div');
            body.className = 'eaze-ui-dialog__body';
            if (typeof o.content === 'function') { o.content(body); }
            else if (o.content && typeof o.content === 'object' && o.content.nodeType) { body.appendChild(o.content); }
            else if (o.html != null) {
                var htmlHost = root.document.createElement('div');
                htmlHost.className = 'eaze-ui-dialog__html';
                htmlHost.innerHTML = sanitizeHtml(o.html);
                body.appendChild(htmlHost);
            } else if (o.message) {
                var para = root.document.createElement('p');
                para.className = 'eaze-ui-dialog__message';
                para.textContent = String(o.message);
                body.appendChild(para);
            }

            var footer = root.document.createElement('div');
            footer.className = 'eaze-ui-dialog__footer';
            var buttonSpecs = (o.buttons && o.buttons.length) ? o.buttons : [{ id: 'ok', label: 'OK', isPrimary: true }];
            buttonSpecs.forEach(function (spec, i) { footer.appendChild(buildButton(spec, i)); });

            dialog.appendChild(header);
            dialog.appendChild(body);
            dialog.appendChild(footer);
            overlay.appendChild(dialog);
            (root.document.body || root.document.documentElement).appendChild(overlay);

            var settled = false;

            function teardown(outcome) {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKeydown, true);
                var idx = openDialogs.indexOf(record);
                if (idx >= 0) openDialogs.splice(idx, 1);
                overlay.classList.add('eaze-ui-overlay--leaving');
                setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 140);
                if (previouslyFocused && previouslyFocused.focus) { try { previouslyFocused.focus(); } catch (e) { /* ignore */ } }

                if (outcome.cancelled && o.cancelBehavior === 'reject') {
                    reject(new EazeUiError('Dialog dismissed by user.', CODE.CANCELLED, { button: outcome.button }));
                } else {
                    resolve(outcome);
                }
            }

            function settle(outcome) {
                teardown(Object.assign({ button: o.cancelId, value: undefined }, outcome || {}));
            }

            record.settleExternal = function (outcome) { settle(outcome || { cancelled: true }); };

            footer.addEventListener('click', function (ev) {
                var btn = ev.target && ev.target.closest ? ev.target.closest('[data-eaze-ui-dialog-button]') : null;
                if (!btn || !footer.contains(btn)) return;
                var id = btn.dataset.eazeUiDialogButton;
                var value = undefined;
                try { value = btn.dataset.eazeUiDialogValue ? JSON.parse(btn.dataset.eazeUiDialogValue) : undefined; } catch (e) { /* ignore */ }
                settle({ button: id, value: value, cancelled: id === o.cancelId });
            });

            overlay.addEventListener('mousedown', function (ev) {
                if (o.closeOnBackdrop && ev.target === overlay) requestClose();
            });

            function onKeydown(ev) {
                if (openDialogs[openDialogs.length - 1] !== record) return;      // topmost only
                if (ev.key === 'Escape') {
                    if (!o.escCancels || !o.closable) return;
                    ev.preventDefault();
                    requestClose();
                    return;
                }
                if (ev.key !== 'Tab') return;
                var focusables = queryFocusables(dialog);
                if (!focusables.length) return;
                var first = focusables[0];
                var last = focusables[focusables.length - 1];
                if (ev.shiftKey && root.document.activeElement === first) { ev.preventDefault(); last.focus(); }
                else if (!ev.shiftKey && root.document.activeElement === last) { ev.preventDefault(); first.focus(); }
            }

            document.addEventListener('keydown', onKeydown, true);
            openDialogs.push(record);

            var primary = footer.querySelector('.eaze-ui-btn--primary') || queryFocusables(dialog)[0] || dialog;
            setTimeout(function () { try { primary.focus(); } catch (e) { /* ignore */ } }, 30);
        });
    }

    function closeAll() {
        var count = openDialogs.length;
        openDialogs.slice().forEach(function (rec) { rec.settleExternal({ button: 'closed', cancelled: true }); });
        return { closed: count };
    }

    function showDialogHandler(payload, ctx) {
        var p = payload || {};
        if (!p.title && !p.message && !p.html && !p.content) {
            throw new EazeUiError('ui.showDialog requires at least one of title / message / html / content.', CODE.INVALID_PAYLOAD);
        }
        return open(Object.assign({ pluginId: (ctx && ctx.sourcePluginId) || 'host' }, p));
    }

    core.registerHandler('ui.showDialog', showDialogHandler);
    core.registerHandler('ui.closeDialog', function () { return closeAll(); });

    /** Shared primitive reused by the form + conversation features. */
    core.dialog = {
        open: open,
        closeAll: closeAll,
        count: function () { return openDialogs.length; },
        sanitizeHtml: sanitizeHtml,
        queryFocusables: queryFocusables
    };

    core.defineUiMethod('showDialog', function (api) {
        return function (options) {
            var payload = Object.assign({}, options || {});
            payload.pluginId = payload.pluginId || api.pluginId;
            return api.request('ui.showDialog', payload);
        };
    });

    core.defineUiMethod('alert', function (api) {
        return function (message, title) {
            var opts = (typeof message === 'object' && message !== null) ? message : { message: message, title: title };
            return api.showDialog(Object.assign({ buttons: [{ id: 'ok', label: 'OK', isPrimary: true }] }, opts));
        };
    });

    core.defineUiMethod('confirm', function (api) {
        return function (message, title) {
            var opts = (typeof message === 'object' && message !== null) ? message : { message: message, title: title };
            return api.showDialog(Object.assign({
                buttons: [
                    { id: 'cancel', label: 'Cancel', variant: 'ghost' },
                    { id: 'confirm', label: 'Confirm', isPrimary: true }
                ]
            }, opts)).then(function (res) { return res.button === 'confirm'; });
        };
    });

    core.defineUiMethod('prompt', function (api) {
        return function (message, defaultValue, title) {
            var opts = (typeof message === 'object' && message !== null) ? message : { message: message, title: title };
            var initial = defaultValue == null ? '' : String(defaultValue);
            var inputEl = null;      // captured reference — the node is detached once closed
            return api.showDialog(Object.assign({
                content: function (host) {
                    var label = root.document.createElement('label');
                    label.className = 'eaze-ui-field';
                    inputEl = root.document.createElement('input');
                    inputEl.type = 'text';
                    inputEl.className = 'eaze-ui-input';
                    inputEl.value = initial;
                    var span = root.document.createElement('span');
                    span.className = 'eaze-ui-field__label';
                    span.textContent = String(opts.message || '');
                    label.appendChild(span);
                    label.appendChild(inputEl);
                    host.appendChild(label);
                    setTimeout(function () { if (inputEl) { inputEl.focus(); inputEl.select(); } }, 40);
                },
                buttons: [
                    { id: 'cancel', label: 'Cancel', variant: 'ghost' },
                    { id: 'ok', label: 'OK', isPrimary: true }
                ]
            }, opts)).then(function () { return inputEl ? inputEl.value : null; });
        };
    });

    core.defineUiMethod('closeDialog', function (api) {
        return function () { return api.request('ui.closeDialog', {}); };
    });
})(window || globalThis);
