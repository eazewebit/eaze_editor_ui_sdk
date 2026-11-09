/**
 * @file eaze_ui_sdk_fields.js
 * @description Shared form-field renderer used by the SDK `ui.showForm` and
 * `ui.askConversation` features.  Every control is a real native HTML element
 * (<input>/<select>/<textarea>) so browser validation, autofill, IME and
 * accessibility behaviour are inherited for free.
 *
 * Contract highlights (each one fixes a reported defect):
 *   - spec reconciliation lives in eaze_ui_sdk_spec.js: unknown keys are reported
 *     instead of silently dropped, invalid defaults are dropped/clamped WITH a
 *     diagnostic, never coerced into silence.
 *   - answers are written with core.safeSet(), so a field named `__proto__` is a
 *     plain own property and cannot pollute the prototype chain.
 *   - one empty-answer policy for every control type ('null' by default).
 *   - multi-selects never produce phantom "" entries and are never pre-selected.
 *   - file fields honour `multiple` in BOTH modes (native picker + browser input).
 *   - a label is always rendered (visually hidden when the caller hides it) and
 *     every message uses the human-readable label, not the internal key.
 *
 * Exposes the primitive on <code>eazeUiSdk.core.fields</code>.
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var spec = core.spec;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    var SUPPORTED = spec.supportedTypes;

    function el(tag, className, textValue) {
        var node = root.document.createElement(tag);
        if (className) node.className = className;
        if (textValue != null) node.textContent = String(textValue);
        return node;
    }

    function applyCommonAttributes(input, field) {
        input.name = field.name;
        if (field.placeholder && !field._isListbox) input.placeholder = String(field.placeholder);
        if (field.required) input.required = true;
        if (field.disabled) input.disabled = true;
        if (field.readonly && input.type !== 'checkbox' && input.type !== 'file') input.readOnly = true;
        if (field.pattern) input.pattern = String(field.pattern);
        if (typeof field.min === 'number' || typeof field.min === 'string') input.min = field.min;
        if (typeof field.max === 'number' || typeof field.max === 'string') input.max = field.max;
        if (typeof field.step === 'number' || typeof field.step === 'string') input.step = field.step;
        if (field.autocomplete) input.setAttribute('autocomplete', String(field.autocomplete));
        input.id = field.id ? String(field.id) : core.nextId('fld');
        var maxLength = field.maxLength != null ? field.maxLength : field.maxlength;
        if (maxLength) input.maxLength = Number(maxLength);
    }

    function fillOptions(select, options) {
        (options || []).forEach(function (opt) {
            var o = (opt && typeof opt === 'object') ? opt : { value: opt, label: opt };
            var optionEl = root.document.createElement('option');
            optionEl.value = String(o.value == null ? '' : o.value);
            optionEl.textContent = String(o.label == null ? o.value : o.label);
            if (o.disabled) optionEl.disabled = true;
            select.appendChild(optionEl);
        });
    }

    /** ".java, *.txt" -> ['java','txt']; MIME entries ("text/plain") are ignored. */
    function extensionsFromAccept(accept) {
        if (!accept) return [];
        return String(accept).split(',').map(function (token) {
            return token.trim().replace(/^\*?\./, '').toLowerCase();
        }).filter(function (token) {
            return token.length > 0 && token.indexOf('/') < 0;
        });
    }

    /**
     * Renders one field.  Returns a control descriptor:
     *   { element, primary, read(), validate(), focus(), field }
     * `ctx` is optional and provides { sdk, pluginId, strict }.
     */
    function renderField(raw, ctx) {
        var context = ctx || {};
        var f;
        try {
            f = spec.normalizeField(raw, context.index || 0, { strict: context.strict === true });
        } catch (error) {
            throw error instanceof EazeUiError ? error
                : new EazeUiError('Invalid field definition: ' + error.message, CODE.INVALID_PAYLOAD);
        }

        var wrap = el('div', 'eaze-ui-field');
        // Some controls (color, range) always report a value. Only an explicit valid default or real user
        // interaction counts as an answer — otherwise the implicit #000000 / midpoint would be invented data.
        var hasDeclaredDefault = f.value !== undefined && f.value !== null && f.value !== '';
        var fieldTouched = false;
        ['input', 'change'].forEach(function (evt) {
            wrap.addEventListener(evt, function () { fieldTouched = true; }, true);
        });
        var displayText = f._displayLabel || spec.displayLabel(f);
        var helperId = core.nextId('help');
        var errorId = core.nextId('err');
        var errorEl = el('div', 'eaze-ui-field__error');
        errorEl.setAttribute('aria-live', 'polite');
        errorEl.id = errorId;

        var primary = null;         // main control element (focus target / value source)
        var group = null;           // radio group container when applicable
        var describedBy = [];
        var nativeReveal = null;    // browser-file hint, revealed on first selection

        /* Spec warnings are visible to the human too — a dropped default must never be silent. */
        if (f._warnings && f._warnings.length) {
            var warnEl = el('div', 'eaze-ui-field__warning');
            warnEl.setAttribute('role', 'note');
            warnEl.textContent = f._warnings.join(' ');
            wrap.appendChild(warnEl);
        }

        /** Visible label, or an accessible-only label when the caller hides it (D10). */
        function labelNode(forId) {
            var lab = el('label', 'eaze-ui-field__label' + (f.hideLabel ? ' eaze-ui-visually-hidden' : ''));
            if (forId) lab.setAttribute('for', forId);
            lab.appendChild(el('span', 'eaze-ui-label-text', displayText));
            if (f.required) lab.appendChild(el('span', 'eaze-ui-field__required', ' *'));
            return lab;
        }

        function makeInput(extraClass) {
            var input = root.document.createElement('input');
            input.type = f.type;
            input.className = 'eaze-ui-input' + (extraClass ? ' ' + extraClass : '');
            applyCommonAttributes(input, f);
            if (f.value != null && f.type !== 'file') input.value = String(f.value);
            return input;
        }

        function nameControl(node) {
            if (!node) return;
            node.setAttribute('aria-label', displayText);
            if (describedBy.length) node.setAttribute('aria-describedby', describedBy.join(' '));
        }

        var isMultipleSelect = false;

        if (f.type === 'textarea') {
            primary = root.document.createElement('textarea');
            primary.className = 'eaze-ui-input eaze-ui-textarea';
            primary.rows = typeof f.rows === 'number' ? f.rows : 4;
            applyCommonAttributes(primary, f);
            if (f.value != null) primary.value = String(f.value);
            wrap.appendChild(labelNode(primary.id));
            wrap.appendChild(primary);

        } else if (f.type === 'checkbox') {
            var row = el('label', 'eaze-ui-field__inline');   // the inline caption is the control's only affordance: always visible
            primary = root.document.createElement('input');
            primary.type = 'checkbox';
            primary.className = 'eaze-ui-checkbox';
            applyCommonAttributes(primary, f);
            if (f.value === true || f.value === 'true') primary.checked = true;
            row.appendChild(primary);
            row.appendChild(el('span', 'eaze-ui-field__inline-label', displayText));
            wrap.appendChild(row);

        } else if (f.type === 'radio') {
            group = el('div', 'eaze-ui-radio-group');
            group.setAttribute('role', 'radiogroup');
            var groupName = 'rg-' + f.name.replace(/[^A-Za-z0-9_-]/g, '') + '-' + core.nextId('r');
            (f.options || []).forEach(function (opt) {
                var o = (opt && typeof opt === 'object') ? opt : { value: opt, label: opt };
                var item = el('label', 'eaze-ui-field__inline');
                var radio = root.document.createElement('input');
                radio.type = 'radio';
                radio.className = 'eaze-ui-radio';
                radio.name = groupName;
                radio.value = String(o.value == null ? '' : o.value);
                if (f.required) radio.required = true;
                if (f.disabled) radio.disabled = true;
                radio.id = core.nextId('radio');
                if (f.value != null && String(f.value) === radio.value) radio.checked = true;
                item.appendChild(radio);
                item.appendChild(el('span', 'eaze-ui-field__inline-label', o.label == null ? o.value : o.label));
                group.appendChild(item);
            });
            var groupLabel = labelNode(null);   // visually hidden when hideLabel — still an accessible name
            wrap.appendChild(groupLabel);
            group.setAttribute('aria-label', displayText);
            wrap.appendChild(group);
            primary = group.querySelector('input') || group;

        } else if (f.type === 'select') {
            isMultipleSelect = f.multiple === true;
            primary = root.document.createElement('select');
            primary.className = 'eaze-ui-input eaze-ui-select';
            applyCommonAttributes(primary, Object.assign({}, f, { _isListbox: isMultipleSelect }));
            if (isMultipleSelect) {
                primary.multiple = true;
                primary.size = Math.min(Math.max((f.options || []).length, 3), 8);
            } else if (f.placeholder !== false) {
                var placeholderOption = root.document.createElement('option');
                placeholderOption.value = '';
                placeholderOption.textContent = String(f.placeholder || 'Select…');
                placeholderOption.disabled = !!f.required;
                placeholderOption.setAttribute('data-eaze-ui-placeholder', '1');
                primary.appendChild(placeholderOption);
            }
            fillOptions(primary, f.options);

            var wanted = f.value == null ? [] : (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]);
            if (isMultipleSelect) {
                // A listbox pre-selects its first row unless told otherwise; that phantom
                // entry used to be reported as a real answer ("").  Nothing is selected here.
                Array.prototype.forEach.call(primary.options, function (optEl) { optEl.selected = false; });
                primary.selectedIndex = -1;
            }
            if (wanted.length) {
                Array.prototype.forEach.call(primary.options, function (optEl) {
                    optEl.selected = wanted.indexOf(optEl.value) >= 0;
                });
            }
            wrap.appendChild(labelNode(primary.id));
            if (isMultipleSelect && !f.hideLabel) {
                wrap.appendChild(el('div', 'eaze-ui-field__hint', 'Hold Ctrl / Cmd to pick several.'));
            }
            wrap.appendChild(primary);

        } else if (f.type === 'file') {
            var multiple = f.multiple === true;
            var useNative = f.native !== false;
            var state = { mode: null, paths: [], files: [] };
            var fileRow = el('div', 'eaze-ui-file-row');

            primary = root.document.createElement('input');
            primary.className = 'eaze-ui-input eaze-ui-path';
            applyCommonAttributes(primary, Object.assign({}, f, { type: 'text' }));
            primary.type = 'text';          // the visible value is always a path list
            primary.readOnly = true;
            primary.placeholder = String(f.placeholder || (useNative ? 'No path selected' : 'No file chosen'));
            if (f.required) primary.required = true;

            function paintPaths() {
                var shown = state.paths.length ? state.paths : state.files.map(function (item) { return item.name; });
                primary.value = shown.join(', ');
            }

            fileRow.appendChild(primary);

            if (useNative && sdk) {
                var browse = el('button', 'eaze-ui-btn eaze-ui-btn--secondary eaze-ui-file-row__btn',
                    multiple ? 'Browse…' : 'Browse…');
                browse.type = 'button';
                browse.setAttribute('aria-label', displayText + (multiple ? ' — pick one or more paths' : ' — pick a path'));
                browse.addEventListener('click', function () {
                    browse.disabled = true;
                    var nativePayload = Object.assign({
                        title: f.browseTitle || displayText,
                        mode: multiple ? 'files' : 'file',
                        multiple: multiple,
                        extensions: (f.extensions && f.extensions.length) ? f.extensions : extensionsFromAccept(f.accept),
                        initialPath: f.initialPath == null ? null : String(f.initialPath)
                    }, f.nativeOptions || {});

                    sdk.request('ui.selectNativePath', nativePayload, { pluginId: context.pluginId || 'host' })
                        .then(function (res) {
                            var data = res || {};
                            var picked = Array.isArray(data.paths) && data.paths.length ? data.paths.slice()
                                : (data.path ? [data.path] : []);
                            if (!picked.length) return;                       // nothing chosen — keep previous value
                            state.mode = 'native';
                            state.files = [];
                            state.paths = multiple ? picked : picked.slice(0, 1);
                            paintPaths();
                            clear.hidden = false;      // offer a reset once something is selected
                            showError(null);
                        })
                        .catch(function (err) {
                            if (!err || err.code !== 'CANCELLED') showError('Native picker unavailable: ' + err.message);
                        })
                        .then(function () { browse.disabled = false; });
                });

                var clear = el('button', 'eaze-ui-btn eaze-ui-btn--ghost eaze-ui-file-row__btn', '\u00d7');
                clear.type = 'button';
                clear.hidden = true;
                clear.setAttribute('aria-label', 'Clear selection for ' + displayText);
                clear.addEventListener('click', function () {
                    state.mode = null; state.paths = []; state.files = [];
                    primary.value = '';
                    clear.hidden = true;
                    showError(null);
                });
                fileRow.appendChild(browse);
                fileRow.appendChild(clear);
            } else {
                var nativeInput = root.document.createElement('input');
                nativeInput.type = 'file';
                nativeInput.className = 'eaze-ui-file-native';
                if (f.accept) nativeInput.accept = String(f.accept);
                nativeInput.multiple = multiple;              // honoured, not ignored (D4)
                nativeInput.addEventListener('change', function () {
                    var list = Array.prototype.map.call(nativeInput.files || [], function (file) {
                        return { name: file.name, size: file.size, type: file.type };
                    });
                    state.mode = 'browser';
                    state.paths = [];                          // browsers never expose real paths
                    state.files = list;
                    paintPaths();
                    if (list.length) showError(null);
                });
                fileRow.appendChild(nativeInput);
            }

            wrap.appendChild(labelNode(primary.id));
            wrap.appendChild(fileRow);
            if (!useNative) {
                var note = el('div', 'eaze-ui-field__hint',
                    multiple ? 'Browser upload: names only — real paths need the native picker.' : 'Browser upload exposes no real path.');
                note.hidden = true;    // informational; revealed once a browser selection happens
                nativeReveal = note;
                wrap.appendChild(note);
            }

        } else if (f.type === 'hidden') {
            primary = makeInput('eaze-ui-hidden');
            wrap.classList.add('eaze-ui-field--hidden');
            wrap.appendChild(primary);

        } else {
            primary = makeInput();
            wrap.appendChild(labelNode(primary.id));
            wrap.appendChild(primary);
        }

        if (f.helper) {
            var helperEl = el('div', 'eaze-ui-field__helper', f.helper);
            helperEl.id = helperId;
            describedBy.push(helperId);
            wrap.appendChild(helperEl);
        }
        describedBy.push(errorId);
        nameControl(primary);
        if (group) group.setAttribute('aria-describedby', describedBy.join(' '));

        wrap.appendChild(errorEl);

        /** Renders the error state AND returns it — validate() propagates this value, so a field that
         *  looks invalid can never let a submit slip through (a cosmetic-only error was the old bug). */
        function showError(message) {
            var text = message ? String(message) : '';
            errorEl.textContent = text;
            errorEl.hidden = !text;
            if (primary) primary.setAttribute('aria-invalid', text ? 'true' : 'false');
            if (group) group.setAttribute('aria-invalid', text ? 'true' : 'false');
            return text || null;
        }


        function read() {
            if (!primary) return null;
            if (f.type === 'checkbox') return !!primary.checked;
            if (f.type === 'radio') {
                var checked = group ? group.querySelector('input:checked') : null;
                return checked ? checked.value : null;
            }
            if (isMultipleSelect) {
                // No phantom entries: disabled rows, placeholder rows and empty values never count.
                return Array.prototype.filter.call(primary.options, function (o) {
                    return o.selected && !o.disabled && o.getAttribute('data-eaze-ui-placeholder') !== '1';
                }).map(function (o) { return o.value; }).filter(function (v) { return v !== ''; });
            }
            if (f.type === 'file') {
                var hasPaths = state.paths.length > 0;
                var hasFiles = state.files.length > 0;
                if (!hasPaths && !hasFiles) return null;
                var modeName = state.mode || (hasPaths ? 'native' : 'browser');
                if (modeName === 'browser') {
                    return { mode: 'browser', multiple: multiple, path: null, paths: [], files: state.files.slice() };
                }
                // Native selections are paths only — no empty files:[] noise sitting next to a real path.
                return { mode: 'native', multiple: multiple, path: state.paths[0], paths: state.paths.slice() };
            }
            if (f.type === 'number') {
                if (primary.value === '' || primary.value == null) return null;
                var num = Number(primary.value);
                return isNaN(num) ? null : num;
            }
            if (f.type === 'color' || f.type === 'range') {
                // Both controls ALWAYS report a value (#000000 / the midpoint). Without an explicit valid
                // default and without user interaction that implicit value is not an answer.
                if (!fieldTouched && !hasDeclaredDefault) return null;
                if (primary.value === '') return null;
                return f.type === 'range' ? Number(primary.value) : primary.value;
            }
            var text = primary.value;
            return (typeof text === 'string' && text.length === 0) ? null : text;
        }

        function validate() {
            if (!primary) return null;
            var value = read();

            if (f.required) {
                var missing = f.type === 'checkbox' ? value !== true : spec.isEmptyValue(value);
                if (missing) return showError(displayText + ' is required.');
            }

            if (primary.checkValidity && primary.value !== '' && !primary.checkValidity()) {
                return showError(primary.validationMessage || (displayText + ' is not valid.'));
            }

            showError(null);
            return null;
        }

        function focus() { try { primary && primary.focus(); } catch (e) { /* ignore */ } }

        if (nativeReveal) {
            wrap.addEventListener('change', function () { nativeReveal.hidden = false; });
        }

        return { element: wrap, field: f, primary: primary, read: read, validate: validate, focus: focus };
    }

    /** Renders a list of fields into `host`; returns the control descriptors. */
    function renderFields(fields, host, ctx) {
        var options = ctx || {};
        var normalized = spec.normalizeFields(fields, options);
        var controls = normalized.map(function (field, i) {
            return renderField(field, Object.assign({}, options, { index: i }));
        });
        controls.forEach(function (c) { host.appendChild(c.element); });
        return controls;
    }

    /**
     * Collects answers into a plain object.
     * `options.emptyValue` selects the encoding of an unanswered control
     * ('null' | 'string' | 'omit'; defaults to core.config.emptyValue).
     * Keys are written with core.safeSet(), so nothing can touch Object.prototype.
     */
    function collectValues(controls, options) {
        var opts = options || {};
        var policy = spec.emptyPolicies.indexOf(opts.emptyValue) >= 0 ? opts.emptyValue : (core.config.emptyValue || 'null');
        var values = {};

        (controls || []).forEach(function (c) {
            if (!c || !c.field) return;
            var value = spec.applyEmptyPolicy(c.read(), policy);
            if (value === spec.OMIT) return;
            core.safeSet(values, c.field.name, value);
        });

        if (opts.includeMeta === true) {
            Object.defineProperty(values, '_meta', {
                value: {
                    pluginId: opts.pluginId || 'host',
                    emptyValue: policy,
                    warnings: spec.collectWarnings(controls),
                    answeredAt: Date.now()
                },
                enumerable: false, configurable: true
            });
        }
        return values;
    }

    /** Raw collection used by custom validators — never re-encoded. */
    function collect(controls) {
        return collectValues(controls, { emptyValue: 'raw' });
    }

    /** Returns the first validation error (and focuses its control) or null. */
    function validateAll(controls) {
        var firstError = null;
        (controls || []).forEach(function (c) {
            var message = c.validate();
            if (message && !firstError) { c.element.setAttribute('data-invalid', 'true'); firstError = { control: c, message: message }; }
            else c.element.removeAttribute('data-invalid');
        });
        if (firstError) {
            firstError.control.element.setAttribute('data-invalid', 'true');
            firstError.control.focus();
            return firstError.message;
        }
        return null;
    }

    core.fields = {
        supportedTypes: SUPPORTED,
        normalizeField: function (raw, index) { return spec.normalizeField(raw, index || 0, {}); },
        renderField: renderField,
        renderFields: renderFields,
        collect: collect,
        collectValues: collectValues,
        validateAll: validateAll
    };

    /** Plugin-facing: what did the last renders complain about? */
    core.defineUiMethod('diagnostics', function () {
        return function () { return core.diagnostics(); };
    });
})(window || globalThis);
