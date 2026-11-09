/**
 * @file eaze_ui_sdk_spec.js
 * @description Field-spec contract for the Eaze Editor UI SDK: type table, known-key
 * reconciliation (aliases / case typos are reported instead of vanishing), default-value
 * validation, display labels used in messages, the prototype-safe answer writer and the
 * single empty-answer encoding policy.
 *
 * Pure logic — zero DOM access — so it is unit-testable in Node without Chrome/WebView2
 * (see src/test/js/eaze_ui_sdk_spec.test.mjs).
 *
 * Exposes <code>eazeUiSdk.core.spec</code>.  Load AFTER eaze_ui_sdk.js and BEFORE
 * eaze_ui_sdk_fields.js.
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    var INPUT_TYPES = ['text', 'number', 'password', 'email', 'url', 'search', 'tel', 'date', 'time',
        'datetime-local', 'month', 'week', 'color', 'range'];
    var SUPPORTED = INPUT_TYPES.concat(['textarea', 'checkbox', 'radio', 'select', 'hidden', 'file']);

    /** Keys every field accepts, whatever its type. */
    var COMMON_KEYS = ['name', 'type', 'label', 'placeholder', 'helper', 'required', 'disabled',
        'readonly', 'value', 'id', 'errorLabel', 'hideLabel'];

    /** Extra keys accepted per type.  Anything outside COMMON + these is reported (D12). */
    var TYPE_KEYS = {
        text: ['maxLength', 'pattern', 'autocomplete'],
        password: ['maxLength', 'pattern', 'autocomplete'],
        email: ['pattern', 'autocomplete', 'multiple'],
        url: ['pattern', 'autocomplete'],
        search: ['maxLength', 'pattern', 'autocomplete'],
        tel: ['maxLength', 'pattern', 'autocomplete'],
        number: ['min', 'max', 'step'],
        range: ['min', 'max', 'step'],
        date: ['min', 'max', 'step'],
        time: ['min', 'max', 'step'],
        month: ['min', 'max', 'step'],
        week: ['min', 'max', 'step'],
        'datetime-local': ['min', 'max', 'step'],
        color: [],
        textarea: ['rows', 'maxLength', 'pattern', 'autocomplete'],
        select: ['options', 'multiple'],
        radio: ['options'],
        checkbox: [],
        hidden: [],
        file: ['multiple', 'accept', 'extensions', 'native', 'browseTitle', 'nativeOptions', 'initialPath']
    };

    /** Near-miss spellings that still mean something; adopted with a warning (D12). */
    var ALIASES = {
        default: 'value', defaultvalue: 'value', initial: 'value', preset: 'value',
        help: 'helper', helptext: 'helper', hint: 'helper', hinttext: 'helper',
        question: 'label', prompt: 'label', title: 'label', caption: 'label', displayname: 'label',
        choices: 'options', items: 'options', option: 'options', values: 'options',
        mandatory: 'required', isrequired: 'required', requried: 'required', requird: 'required', reqired: 'required',
        lines: 'rows', height: 'rows',
        browsebutton: 'browseTitle', buttontext: 'browseTitle',
        filetypes: 'accept', filetype: 'accept', exts: 'extensions', allowedextensions: 'extensions',
        multiselect: 'multiple', ismulti: 'multiple', multi: 'multiple'
    };

    var PATTERNS = {
        date: /^\d{4}-\d{2}-\d{2}$/,
        time: /^\d{2}:\d{2}(:\d{2})?$/,
        month: /^\d{4}-\d{2}$/,
        week: /^\d{4}-W\d{2}$/i,
        'datetime-local': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/
    };

    /** Sentinel meaning "do not emit this key at all" (emptyValue: 'omit'). */
    var OMIT = { eazeUiOmit: true };

    /* ------------------------------------------------------------------ *
     * Prototype-safe answer keys (D1)
     * ------------------------------------------------------------------ */

    /* The writer itself lives in the core so renderer and spec share one implementation:
       defineProperty-based, therefore no answer key can ever reach the prototype chain. */
    var isUnsafeKey = core.isUnsafeKey;
    var safeSet = core.safeSet;

    /* ------------------------------------------------------------------ *
     * Empty-answer policy (D7) — one rule for every control type.
     *   'null'   : unanswered -> null                (default, matches the legacy path)
     *   'string' : unanswered -> ''                  (legacy text-shaped consumers)
     *   'omit'   : unanswered -> key absent entirely
     *   'raw'    : whatever the control reports      (validation hooks only)
     * ------------------------------------------------------------------ */

    var EMPTY_POLICIES = ['null', 'string', 'omit'];

    function isEmptyValue(value) {
        if (value === null || value === undefined) return true;
        if (typeof value === 'string') return value.length === 0;
        if (Array.isArray(value)) return value.length === 0;
        if (typeof value === 'object' && typeof value.mode !== 'undefined' && ('path' in value || 'files' in value)) {
            var paths = Array.isArray(value.paths) ? value.paths : [];
            var files = Array.isArray(value.files) ? value.files : [];
            return !value.path && !paths.length && !files.length;
        }
        return false;
    }

    /** Policy emptiness is NOT required-check emptiness: an empty multi-select answers "none" with []. */
    function isEmptyForPolicy(value) {
        return Array.isArray(value) ? false : isEmptyValue(value);
    }

    function applyEmptyPolicy(value, policy) {
        if (!isEmptyForPolicy(value)) return value;
        if (policy === 'raw') return value;
        if (policy === 'string') return '';
        if (policy === 'omit') return OMIT;
        return null;
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    function trim(value) {
        return String(value == null ? '' : value).trim();
    }

    /** Human-readable name used in labels and validation messages (D10 / D11). */
    function displayLabel(field) {
        var f = field || {};
        var explicit = trim(f.errorLabel);
        if (explicit) return explicit;
        var label = trim(f.label);
        if (label) return label;
        var name = trim(f.name);
        if (!name) return 'This field';
        // "q1" -> "Question q1"; "max_retries" -> "max retries"; "maxRetries" -> "max Retries"
        if (/^[A-Za-z]\d+$/.test(name)) return 'Question ' + name;
        return trim(name.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
    }

    function normalizeColor(value) {
        var text = trim(value);
        if (/^#[0-9a-fA-F]{6}$/.test(text)) return text.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(text)) {
            var r = text[1], g = text[2], b = text[3];
            return ('#' + r + r + g + g + b + b).toLowerCase();
        }
        return null;
    }

    function toNumberOrNull(value) {
        if (value === '' || value == null) return null;
        var num = Number(value);
        return isNaN(num) ? null : num;
    }

    /** Option list -> array of string values (used for default membership checks). */
    function optionValues(options) {
        return (options || []).map(function (opt) {
            var o = (opt && typeof opt === 'object') ? opt : { value: opt };
            return String(o.value == null ? '' : o.value);
        });
    }

    /* ------------------------------------------------------------------ *
     * Default-value validation (D6): never coerce silently.
     * Unparseable values are dropped, out-of-range numbers are clamped — both
     * always produce a diagnostic that names the field and what happened.
     * ------------------------------------------------------------------ */

    function validateDefault(field) {
        var f = field || {};
        var label = displayLabel(f);
        var value = f.value;
        var out = { value: value, dropped: false, warnings: [] };
        if (value === undefined || value === null) return out;

        function drop(reason) {
            out.warnings.push('"' + label + '": default ' + JSON.stringify(value) + ' ' + reason + ' — ignored.');
            out.value = undefined;
            out.dropped = true;
        }

        switch (f.type) {
            case 'color': {
                var hex = normalizeColor(value);
                if (!hex) drop('is not a valid #RRGGBB colour');
                else out.value = hex;
                break;
            }
            case 'number':
            case 'range': {
                var num = toNumberOrNull(value);
                if (num === null) { drop('is not a number'); break; }
                var min = toNumberOrNull(f.min), max = toNumberOrNull(f.max);
                if (min !== null && num < min) {
                    out.warnings.push('"' + label + '": default ' + num + ' is below min ' + min + ' — clamped to ' + min + '.');
                    out.value = min;
                } else if (max !== null && num > max) {
                    out.warnings.push('"' + label + '": default ' + num + ' is above max ' + max + ' — clamped to ' + max + '.');
                    out.value = max;
                }
                break;
            }
            case 'checkbox': {
                if (typeof value === 'boolean') break;
                var text = trim(value).toLowerCase();
                if (text === 'true' || text === '1') out.value = true;
                else if (text === 'false' || text === '0' || text === '') out.value = false;
                else drop('is not a boolean (use true / false)');
                break;
            }
            case 'select':
            case 'radio': {
                var allowed = optionValues(f.options);
                if (f.type === 'select' && f.multiple === true) {
                    var wanted = Array.isArray(value) ? value : [value];
                    var kept = [], rejected = [];
                    wanted.forEach(function (item) {
                        var asText = String(item == null ? '' : item);
                        if (allowed.indexOf(asText) >= 0 && asText !== '') kept.push(asText);
                        else rejected.push(String(item));
                    });
                    if (rejected.length) {
                        out.warnings.push('"' + label + '": default ' + JSON.stringify(rejected)
                            + ' is not among the available options [' + allowed.join(', ') + '] — dropped.');
                    }
                    if (!kept.length && rejected.length) { out.value = undefined; out.dropped = true; }
                    else out.value = kept;
                    break;
                }
                var single = String(value);
                if (allowed.indexOf(single) < 0) {
                    drop('is not among the available options [' + allowed.join(', ') + ']');
                }
                break;
            }
            default: {
                var pattern = PATTERNS[f.type];
                if (!pattern) break;
                var asText2 = trim(value);
                if (!pattern.test(asText2)) { drop('does not match the ' + f.type + ' format'); break; }
                var minText = trim(f.min), maxText = trim(f.max);
                if (minText && asText2 < minText) { out.warnings.push('"' + label + '": default ' + asText2 + ' is before min ' + minText + ' — ignored.'); out.value = undefined; out.dropped = true; }
                else if (maxText && asText2 > maxText) { out.warnings.push('"' + label + '": default ' + asText2 + ' is after max ' + maxText + ' — ignored.'); out.value = undefined; out.dropped = true; }
                break;
            }
        }

        return out;
    }

    /* ------------------------------------------------------------------ *
     * Key reconciliation (D12): unknown keys are reported, never swallowed.
     * strict mode turns every problem into an INVALID_FIELD error so a typo'd
     * spec can never render a half-configured control.
     * ------------------------------------------------------------------ */

    function allowedKeysFor(type) {
        var set = {};
        COMMON_KEYS.forEach(function (key) { set[key] = true; });
        (TYPE_KEYS[type] || []).forEach(function (key) { set[key] = true; });
        return set;
    }

    function lookupIgnoreCase(allowed, lowerKey) {
        var keys = Object.keys(allowed);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].toLowerCase() === lowerKey) return keys[i];
        }
        return null;
    }

    function normalizeField(raw, index, options) {
        var opts = options || {};
        var strict = opts.strict === true || core.config.strictFields === true;
        var source = (raw && typeof raw === 'object') ? raw : {};
        var problems = [];      // fatal in strict mode
        var notes = [];         // always just warnings

        var type = trim(source.type).toLowerCase() || 'text';
        if (SUPPORTED.indexOf(type) < 0) {
            throw new EazeUiError('Unsupported field type "' + source.type + '" for field "'
                + (trim(source.name) || 'field_' + ((index || 0) + 1)) + '".', CODE.INVALID_PAYLOAD,
                { supported: SUPPORTED });
        }

        var name = trim(source.name) || 'field_' + ((index || 0) + 1);
        if (isUnsafeKey(name)) {
            notes.push('Field name "' + name + '" collides with a JavaScript prototype key; it is stored as a plain own property, so the answer survives but rename it for portability.');
        }

        var allowed = allowedKeysFor(type);
        var clean = {};
        Object.keys(source).forEach(function (key) {
            var value = source[key];
            // SDK-internal annotations (_displayLabel, _warnings) are never user keys — re-normalising a
            // field must not report the renderer's own bookkeeping as an unknown spec key.
            if (key.charAt(0) === '_') return;
            if (allowed[key]) { clean[key] = value; return; }

            var lower = key.toLowerCase();
            var aliasTarget = ALIASES[lower];
            var corrected = aliasTarget || lookupIgnoreCase(allowed, lower);
            if (corrected) {
                if (clean[corrected] === undefined) clean[corrected] = value;
                notes.push('Field "' + name + '": key "' + key + '" is not part of the contract — treated as "' + corrected + '".');
                return;
            }

            var message = 'Field "' + name + '": unknown key "' + key + '" was ignored. Accepted keys for type "'
                + type + '": ' + Object.keys(allowed).join(', ') + '.';
            if (strict) problems.push(message); else notes.push(message);
        });

        clean.name = name;
        clean.type = type;

        if (type === 'select' || type === 'radio') {
            var optionsList = Array.isArray(clean.options) ? clean.options : [];
            if (!optionsList.length) {
                var emptyMessage = 'Field "' + name + '" of type ' + type + ' has no usable "options"; it will render empty.';
                if (strict) problems.push(emptyMessage); else notes.push(emptyMessage);
            }
            clean.options = optionsList;

            var blankOption = optionValues(optionsList).indexOf('') >= 0;
            if (blankOption) {
                notes.push('Field "' + name + '": an option with an empty value was dropped — empty values are indistinguishable from "no answer".');
                clean.options = optionsList.filter(function (opt) {
                    var o = (opt && typeof opt === 'object') ? opt : { value: opt };
                    return String(o.value == null ? '' : o.value) !== '';
                });
            }
        }

        var checked = validateDefault(clean);
        if (checked.warnings.length) notes = notes.concat(checked.warnings);
        if (checked.dropped) delete clean.value;
        else if (checked.value !== undefined) clean.value = checked.value;

        if (strict && problems.length) {
            throw new EazeUiError('Invalid field spec for "' + name + '": ' + problems.join(' '),
                CODE.INVALID_FIELD, { field: name, problems: problems });
        }

        clean._displayLabel = displayLabel(clean);
        clean._warnings = notes;
        notes.forEach(function (message) { core.diagnose('FIELD_SPEC', message, { field: name, type: type }); });
        return clean;
    }

    /** Normalizes a whole list and reports duplicate answer keys (last write wins). */
    function normalizeFields(fields, options) {
        var list = Array.isArray(fields) ? fields : [];
        var seen = {};
        var normalized = list.map(function (raw, i) {
            var field = normalizeField(raw, i, options);
            if (seen[field.name]) {
                var message = 'Duplicate field name "' + field.name + '" — the last definition wins because answers are keyed by name.';
                field._warnings = (field._warnings || []).concat([message]);
                core.diagnose('FIELD_SPEC', message, { field: field.name });
            }
            seen[field.name] = true;
            return field;
        });
        return normalized;
    }

    /** Flattens collected warnings of a control list (used for `_meta.warnings`). */
    function collectWarnings(controls) {
        var out = [];
        (controls || []).forEach(function (control) {
            var field = control && control.field ? control.field : null;
            if (field && Array.isArray(field._warnings)) out = out.concat(field._warnings);
        });
        return out;
    }

    core.spec = {
        inputTypes: INPUT_TYPES,
        supportedTypes: SUPPORTED,
        commonKeys: COMMON_KEYS,
        typeKeys: TYPE_KEYS,
        aliases: ALIASES,
        patterns: PATTERNS,
        emptyPolicies: EMPTY_POLICIES.concat(['raw']),
        OMIT: OMIT,
        isUnsafeKey: isUnsafeKey,
        safeSet: safeSet,
        displayLabel: displayLabel,
        normalizeColor: normalizeColor,
        optionValues: optionValues,
        validateDefault: validateDefault,
        normalizeField: normalizeField,
        normalizeFields: normalizeFields,
        collectWarnings: collectWarnings,
        isEmptyValue: isEmptyValue,
        applyEmptyPolicy: applyEmptyPolicy,
        isEmptyForPolicy: isEmptyForPolicy
    };
})(window || globalThis);
