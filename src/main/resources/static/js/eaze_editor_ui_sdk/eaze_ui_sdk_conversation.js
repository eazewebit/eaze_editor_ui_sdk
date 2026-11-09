/**
 * @file eaze_ui_sdk_conversation.js
 * @description Conversation-style multi-question UI for the Eaze Editor UI SDK.
 *
 * Built-in action:
 *   ui.askConversation { title, intro?, questions[], stepByStep? } -> { name: value }
 *
 * Two layouts, same data model (native inputs via eaze_ui_sdk_fields.js):
 *   - default      : every question rendered as a chat bubble in one scrollable
 *                    dialog ("answer set"), single submit.
 *   - stepByStep   : one question per screen with Back / Next and a progress
 *                    counter; the final step submits.
 * Cancelling rejects with EazeUiError(code:'CANCELLED').
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) return;

    var core = sdk.core;
    var EazeUiError = core.EazeUiError;
    var CODE = core.errorCodes;

    function bubble(question, index) {
        var wrap = root.document.createElement('div');
        wrap.className = 'eaze-ui-conversation__turn';

        var row = root.document.createElement('div');
        row.className = 'eaze-ui-conversation__bubble-row';
        var bubbleEl = root.document.createElement('div');
        bubbleEl.className = 'eaze-ui-conversation__bubble';
        var avatar = root.document.createElement('span');
        avatar.className = 'eaze-ui-conversation__avatar';
        avatar.textContent = '\uD83E\uDD16';   // robot glyph, text only (no HTML injection)
        var text = root.document.createElement('div');
        text.className = 'eaze-ui-conversation__text';
        text.textContent = String(question.label || question.name || ('Question ' + (index + 1)));
        bubbleEl.appendChild(avatar);
        bubbleEl.appendChild(text);
        row.appendChild(bubbleEl);
        wrap.appendChild(row);

        if (question.helper) {
            var hint = root.document.createElement('div');
            hint.className = 'eaze-ui-conversation__hint';
            hint.textContent = String(question.helper);
            wrap.appendChild(hint);
        }
        return wrap;
    }

    function askConversationHandler(payload, ctx) {
        var p = payload || {};
        if (!Array.isArray(p.questions) || !p.questions.length) {
            throw new EazeUiError('ui.askConversation requires a non-empty "questions" array.', CODE.INVALID_PAYLOAD);
        }
        var pluginId = (ctx && ctx.sourcePluginId) || 'host';
        var stepByStep = p.stepByStep === true;

        var controls = [];
        try {
            controls = p.questions.map(function (raw, i) {
                // The bubble carries the visible question. hideLabel keeps an accessible (visually hidden)
                // label on the control; errorLabel makes validation quote the question instead of "q1".
                var questionText = String((raw && (raw.label || raw.question || raw.prompt)) || ('Question ' + (i + 1)));
                var field = Object.assign({}, raw, { hideLabel: true, errorLabel: questionText });
                return {
                    control: core.fields.renderField(field, { sdk: sdk, pluginId: pluginId, strict: p.strictFields === true }),
                    question: raw, index: i
                };
            });
        } catch (fieldError) {
            throw new EazeUiError('Invalid conversation question: ' + fieldError.message, CODE.INVALID_PAYLOAD);
        }

        var hostEl = null;
        var errorHost = null;
        var progressEl = null;
        var current = 0;

        var buttons = stepByStep
            ? [
                { id: 'cancel', label: p.cancelLabel || 'Cancel', variant: 'ghost' },
                { id: 'back', label: p.backLabel || 'Back', variant: 'secondary' },
                { id: 'next', label: p.nextLabel || 'Next', isPrimary: true }
            ]
            : [
                { id: 'cancel', label: p.cancelLabel || 'Cancel', variant: 'ghost' },
                { id: 'submit', label: p.submitLabel || 'Send answers', isPrimary: true }
            ];

        var promise = core.dialog.open({
            title: p.title || 'Eaze Editor needs a few answers',
            size: p.size || 'lg',
            pluginId: pluginId,
            cancelBehavior: p.cancelBehavior || 'reject',
            className: 'eaze-ui-conversation' + (stepByStep ? ' eaze-ui-conversation--stepped' : ''),
            content: function (host) {
                hostEl = host;
                if (p.intro) {
                    var intro = root.document.createElement('div');
                    intro.className = 'eaze-ui-conversation__intro';
                    intro.textContent = String(p.intro);
                    host.appendChild(intro);
                }
                errorHost = root.document.createElement('div');
                errorHost.className = 'eaze-ui-conversation__error';
                errorHost.hidden = true;
                host.appendChild(errorHost);

                if (stepByStep) {
                    progressEl = root.document.createElement('div');
                    progressEl.className = 'eaze-ui-conversation__progress';
                    host.appendChild(progressEl);
                }

                var list = root.document.createElement('div');
                list.className = 'eaze-ui-conversation__turns';
                controls.forEach(function (entry) {
                    var turn = bubble(entry.question, entry.index);
                    turn.appendChild(entry.control.element);
                    entry.turnElement = turn;
                    list.appendChild(turn);
                });
                host.appendChild(list);
                if (stepByStep) paintStep();
            },
            buttons: buttons
        });

        var dialogEl = hostEl && hostEl.closest ? hostEl.closest('.eaze-ui-dialog') : null;

        function paintStep() {
            controls.forEach(function (entry, i) {
                entry.turnElement.hidden = i !== current;
            });
            if (progressEl) progressEl.textContent = 'Question ' + (current + 1) + ' of ' + controls.length;
            var nextBtn = dialogEl && dialogEl.querySelector('[data-eaze-ui-dialog-button="next"]');
            if (nextBtn) {
                var isLast = current === controls.length - 1;
                nextBtn.textContent = isLast ? (p.submitLabel || 'Send answers') : (p.nextLabel || 'Next');
            }
            var backBtn = dialogEl && dialogEl.querySelector('[data-eaze-ui-dialog-button="back"]');
            if (backBtn) backBtn.hidden = current === 0;
        }

        function paintError(message) {
            if (!errorHost) return;
            errorHost.textContent = String(message);
            errorHost.hidden = false;
        }

        var guard = function (ev) {
            if (!dialogEl) return;
            var btn = ev.target && ev.target.closest ? ev.target.closest('[data-eaze-ui-dialog-button]') : null;
            if (!btn || !dialogEl.contains(btn)) return;
            var id = btn.dataset.eazeUiDialogButton;

            if (id === 'back') {
                ev.preventDefault();
                ev.stopPropagation();
                current = Math.max(0, current - 1);
                paintStep();
                return;
            }
            if (id !== 'next' && id !== 'submit') return;

            var message = null;
            if (stepByStep) {
                message = controls[current].control.validate();
                if (!message && current < controls.length - 1) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    current += 1;
                    paintStep();
                    return;
                }
            } else {
                message = core.fields.validateAll(controls.map(function (e) { return e.control; }));
            }

            if (!message && typeof p.onValidate === 'function') {
                try { message = p.onValidate(core.fields.collect(controls.map(function (e) { return e.control; }))) || null; }
                catch (e) { message = e && e.message ? e.message : String(e); }
            }

            if (message) { ev.preventDefault(); ev.stopPropagation(); paintError(message); }
        };

        function cleanup() { document.removeEventListener('click', guard, true); }
        if (dialogEl) document.addEventListener('click', guard, true);

        return promise.then(function (outcome) {
            cleanup();
            var list = controls.map(function (entry) { return entry.control; });
            var values = core.fields.collectValues(list, { emptyValue: p.emptyValue, pluginId: pluginId });
            if (p.includeMeta === true) {
                Object.defineProperty(values, '_meta', {
                    value: {
                        pluginId: pluginId,
                        button: outcome && outcome.button,
                        emptyValue: core.config.emptyValue,
                        warnings: core.spec.collectWarnings(list),
                        answeredAt: Date.now()
                    },
                    enumerable: false, configurable: true
                });
            }
            return values;
        })['catch'](function (err) { cleanup(); throw err; });
    }

    core.registerHandler('ui.askConversation', askConversationHandler);

    core.defineUiMethod('askConversation', function (api) {
        return function (questionsOrOptions, maybeQuestions) {
            var payload = (Array.isArray(questionsOrOptions)) ? { questions: questionsOrOptions } : Object.assign({}, questionsOrOptions || {});
            if (maybeQuestions) payload.questions = maybeQuestions;
            payload.pluginId = payload.pluginId || api.pluginId;
            return api.request('ui.askConversation', payload);
        };
    });

    core.defineUiMethod('askQuestion', function (api) {
        return function (question) {
            var q = (typeof question === 'string') ? { name: 'answer', label: question, type: 'text' } : Object.assign({}, question);
            return api.askConversation({ title: q.title || 'Eaze Editor asks', questions: [q] });
        };
    });
})(window || globalThis);
