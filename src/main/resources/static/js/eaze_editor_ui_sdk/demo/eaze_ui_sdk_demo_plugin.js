/**
 * @file eaze_ui_sdk_demo_plugin.js
 * @description Third-party plugin simulation for the Eaze Editor UI SDK.
 *
 * It behaves exactly like an external plugin: it never edits core files, it
 * registers listeners on the SDK bus, injects its own CSS through ui.applyCss(),
 * loads an extra script through ui.loadScript(), and drives every promise-based
 * API (toast / dialog / confirm / prompt / form / conversation / native path).
 *
 * Visibility: the floating demo panel only renders when the page URL contains
 * ?sdkDemo=1 or localStorage.eaze_ui_sdk_demo === '1'.  Listener registration
 * always happens, so `eazeUiSdk.request('demo.echo', {...})` works regardless.
 * Console API: eazeUiSdkDemo.show() / .hide() / .runSelfTest() / .logs()
 */
(function (root) {
    'use strict';

    var sdk = root.eazeUiSdk;
    if (!sdk || !sdk.core) {
        console.error('[eazeUiSdkDemo] eazeUiSdk core is missing — load eaze_ui_sdk.js first.');
        return;
    }

    var PLUGIN_ID = 'ui-sdk-demo';
    var BASE_URL = '/js/eaze_editor_ui_sdk/demo/';
    var api = sdk.createPluginApi(PLUGIN_ID);
    var logs = [];
    var panelEl = null;
    var logHost = null;

    var DEMO_CSS = [
        '.eaze-ui-sdk-demo{position:fixed;left:16px;bottom:16px;z-index:1500;width:min(340px,calc(100vw - 32px));',
        'background:#111827;border:1px solid #374151;border-radius:10px;box-shadow:0 18px 45px rgba(0,0,0,.55);',
        'color:#f3f4f6;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12.5px}',
        '.eaze-ui-sdk-demo__header{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;',
        'border-bottom:1px solid #374151;font-weight:600;font-size:12px;letter-spacing:.04em;text-transform:uppercase}',
        '.eaze-ui-sdk-demo__body{padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
        '.eaze-ui-sdk-demo__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}',
        '.eaze-ui-sdk-demo__btn{padding:6px 8px;border:1px solid #374151;border-radius:6px;background:#1f2937;',
        'color:#e5e7eb;cursor:pointer;font-size:11.5px;text-align:left}',
        '.eaze-ui-sdk-demo__btn:hover{background:#374151}',
        '.eaze-ui-sdk-demo__log{max-height:150px;overflow:auto;background:#0b1220;border:1px solid #1f2937;',
        'border-radius:6px;padding:6px 8px;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:pre-wrap}',
        '.eaze-ui-sdk-demo__log[data-kind="error"]{color:#fca5a5}',
        '.eaze-ui-sdk-demo__close{background:none;border:0;color:#9ca3af;font-size:18px;cursor:pointer;line-height:1}'
    ].join('');

    function log(message, kind) {
        var line = new Date().toLocaleTimeString() + '  ' + message;
        logs.push({ at: Date.now(), kind: kind || 'info', text: line });
        if (logs.length > 200) logs.shift();
        console.log('[eazeUiSdkDemo] ' + message);
        if (!logHost) return;
        var entry = root.document.createElement('div');
        entry.setAttribute('data-kind', kind || 'info');
        entry.textContent = line;
        logHost.appendChild(entry);
        logHost.scrollTop = logHost.scrollHeight;
    }

    /* ------------------------------------------------------------------ *
     * 1. CSS injection — the plugin styles itself through the SDK only.
     * ------------------------------------------------------------------ */
    api.applyCss({ id: 'demo-panel', css: DEMO_CSS }).catch(function (e) { log('applyCss failed: ' + e.message, 'error'); });

    /* ------------------------------------------------------------------ *
     * 2. Listener registration — custom actions + a non-consuming
     *    interceptor on a built-in action (core untouched).
     * ------------------------------------------------------------------ */
    sdk.registerListener('demo.echo', function (payload) {
        return { echo: payload, handledBy: PLUGIN_ID, at: new Date().toISOString() };
    });

    sdk.registerListener('demo.notifyChain', function (payload) {
        return api.showToast({
            type: 'success',
            title: 'Listener invoked',
            message: (payload && payload.message) || 'demo.notifyChain handled'
        }).then(function (toast) { return { notified: true, toastId: toast.id }; });
    });

    // Interceptor: observes every toast raised by this plugin without consuming it.
    sdk.registerListener('ui.showToast', function (payload) {
        if (payload && payload.source === 'demo-audit') log('observed toast: ' + (payload.message || ''), 'info');
        return undefined;   // must stay undefined so the built-in handler still runs
    });

    /* ------------------------------------------------------------------ *
     * 3. Demo panel.
     * ------------------------------------------------------------------ */
    function button(label, handler) {
        var btn = root.document.createElement('button');
        btn.type = 'button';
        btn.className = 'eaze-ui-sdk-demo__btn';
        btn.textContent = label;
        btn.addEventListener('click', function () {
            Promise.resolve(handler()).catch(function (err) {
                log((err && err.code ? err.code + ': ' : '') + (err && err.message ? err.message : err), 'error');
            });
        });
        return btn;
    }

    function buildPanel() {
        if (panelEl) return panelEl;
        var panel = root.document.createElement('div');
        panel.className = 'eaze-ui-sdk-demo';
        panel.id = 'eaze-ui-sdk-demo-panel';
        panel.setAttribute('data-eaze-ui-scope', 'demo-panel');

        var header = root.document.createElement('div');
        header.className = 'eaze-ui-sdk-demo__header';
        var title = root.document.createElement('span');
        title.textContent = 'UI SDK demo plugin';
        var close = root.document.createElement('button');
        close.type = 'button';
        close.className = 'eaze-ui-sdk-demo__close';
        close.setAttribute('aria-label', 'Hide UI SDK demo panel');
        close.textContent = '\u00d7';
        close.addEventListener('click', function () { hidePanel(); });
        header.appendChild(title);
        header.appendChild(close);

        var body = root.document.createElement('div');
        body.className = 'eaze-ui-sdk-demo__body';
        var grid = root.document.createElement('div');
        grid.className = 'eaze-ui-sdk-demo__grid';

        [
            ['Toast', function () { return api.showToast({ type: 'info', title: 'Demo', message: 'Toast from the SDK demo plugin' }); }],
            ['Dialog', openDemoDialog],
            ['Confirm', function () { return api.confirm('Delete the generated report?', 'Confirm').then(function (v) { log('confirm -> ' + v); }); }],
            ['Prompt', function () { return api.prompt('New branch name', 'feature/sdk').then(function (v) { log('prompt -> ' + v); }); }],
            ['Form', openDemoForm],
            ['Conversation', openDemoConversation],
            ['Native folder', pickFolder],
            ['Native files', pickFiles],
            ['Listener call', function () { return sdk.request('demo.echo', { hello: 'world' }).then(function (r) { log('echo -> ' + JSON.stringify(r)); }); }],
            ['Load script', loadExtraScript],
            ['Self test', function () { return runSelfTest().then(function (report) { log('self test: ' + report.summary, report.failed ? 'error' : 'info'); }); }],
            ['Clear log', function () { logs.length = 0; if (logHost) logHost.innerHTML = ''; }]
        ].forEach(function (pair) { grid.appendChild(button(pair[0], pair[1])); });

        logHost = root.document.createElement('div');
        logHost.className = 'eaze-ui-sdk-demo__log';

        body.appendChild(grid);
        body.appendChild(logHost);
        panel.appendChild(header);
        panel.appendChild(body);
        root.document.body.appendChild(panel);
        panelEl = panel;
        return panel;
    }

    function showPanel() { buildPanel(); if (panelEl) panelEl.style.display = ''; }
    function hidePanel() { if (panelEl) panelEl.style.display = 'none'; }

    /* ---------------------------- individual demos --------------------------- */
    function openDemoDialog() {
        return api.showDialog({
            title: 'SDK dialog',
            message: 'Built with ui.showDialog — focus is trapped and Esc cancels.',
            buttons: [
                { id: 'cancel', label: 'Cancel', variant: 'ghost' },
                { id: 'details', label: 'More info', variant: 'secondary' },
                { id: 'ok', label: 'Got it', isPrimary: true }
            ]
        }).then(function (res) { log('dialog button -> ' + res.button); return res; });
    }

    function demoFormFields() {
        return [
            { name: 'projectName', label: 'Project name', type: 'text', required: true, placeholder: 'my-app' },
            { name: 'port', label: 'Port', type: 'number', value: 8080, min: 1, max: 65535 },
            { name: 'mode', label: 'Mode', type: 'select', options: ['dev', 'staging', 'prod'], value: 'dev' },
            { name: 'license', label: 'License', type: 'radio', options: ['MIT', 'Apache-2.0'], value: 'MIT' },
            { name: 'watch', label: 'Watch source files', type: 'checkbox', value: true },
            { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, helper: 'Stored only in this session.' }
        ];
    }

    function openDemoForm() {
        return api.showForm({ title: 'SDK form (native inputs)', fields: demoFormFields(), submitLabel: 'Save' })
            .then(function (values) { log('form -> ' + JSON.stringify(values)); return values; });
    }

    function openDemoConversation() {
        return api.askConversation({
            title: 'SDK conversation',
            intro: 'Answer these and the plugin receives one structured object.',
            questions: [
                { name: 'goal', label: 'What should the generated module do?', type: 'textarea', rows: 2, required: true },
                { name: 'language', label: 'Target language', type: 'select', options: ['java', 'javascript', 'php'], value: 'java' },
                { name: 'tests', label: 'Include unit tests?', type: 'radio', options: ['yes', 'no'], value: 'yes' }
            ]
        }).then(function (answers) { log('conversation -> ' + JSON.stringify(answers)); return answers; });
    }

    function pickFolder() {
        return api.selectNativePath({ title: 'Select project folder', mode: 'directory' })
            .then(function (res) { log('native folder -> ' + res.path); return res; });
    }

    function pickFiles() {
        return api.selectNativePath({ title: 'Select source files', mode: 'files', extensions: ['js', 'json', 'md', 'txt'] })
            .then(function (res) { log('native files -> ' + res.paths.join(', ')); return res; });
    }

    function loadExtraScript() {
        return api.loadScript(BASE_URL + 'eaze_ui_sdk_demo_feature.js')
            .then(function () { return api.getModule('sdkDemoFeature'); })
            .then(function (mod) { log('loaded module ping -> ' + mod.ping()); return mod; });
    }

    /* ------------------------------------------------------------------ *
     * 4. Automated self test — exercises the whole surface without a human,
     *    including a listener override of ui.selectNativePath so no real OS
     *    dialog is raised during automated runs.
     * ------------------------------------------------------------------ */
    function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function clickDialogButton(id) {
        var dialogs = root.document.querySelectorAll('.eaze-ui-dialog');
        var dialog = dialogs[dialogs.length - 1];
        if (!dialog) throw new Error('No open dialog to control.');
        var btn = dialog.querySelector('[data-eaze-ui-dialog-button="' + id + '"]');
        if (!btn) throw new Error('Dialog button "' + id + '" not found.');
        btn.click();
    }

    function setField(id, value) {
        var input = root.document.getElementById(id);
        if (!input) throw new Error('Field #' + id + ' not rendered.');
        if (input.type === 'checkbox') input.checked = !!value;
        else input.value = String(value);
    }

    function runSelfTest() {
        var results = [];

        function step(name, fn) {
            return Promise.resolve().then(fn).then(function (detail) {
                results.push({ name: name, ok: true, detail: detail == null ? '' : String(detail) });
                log('PASS ' + name, 'info');
            }).catch(function (err) {
                results.push({ name: name, ok: false, detail: (err && err.code ? err.code + ': ' : '') + (err && err.message ? err.message : err) });
                log('FAIL ' + name + ' — ' + (err && err.message ? err.message : err), 'error');
            });
        }

        return step('applyCss', function () {
            return api.applyCss({ id: 'selftest-scoped', css: '.demo-scope{color:#fff}', scope: true }).then(function (r) { return r.styleTagId; });
        })
            .then(function () { return step('toast', function () { return api.showToast({ type: 'success', message: 'self test toast' }); }); })
            .then(function () {
                return step('dialog', function () {
                    var p = api.showDialog({ title: 'Self test dialog', message: 'auto', cancelBehavior: 'resolve' });
                    return tick(60).then(function () { clickDialogButton('ok'); return p; }).then(function (r) { return r.button; });
                });
            })
            .then(function () {
                return step('confirm', function () {
                    var p = api.confirm('self test confirm?');
                    return tick(60).then(function () { clickDialogButton('confirm'); return p; }).then(function (v) { return 'confirmed=' + v; });
                });
            })
            .then(function () {
                return step('prompt', function () {
                    var p = api.prompt('self test prompt', 'seed');
                    return tick(60).then(function () { clickDialogButton('ok'); return p; }).then(function (v) { return 'value=' + v; });
                });
            })
            .then(function () {
                return step('form', function () {
                    var fields = demoFormFields().map(function (f) { return Object.assign({}, f, { id: 'selftest-' + f.name }); });
                    var p = api.showForm({ title: 'Self test form', fields: fields });
                    return tick(60).then(function () {
                        setField('selftest-projectName', 'sdk-self-test');
                        setField('selftest-port', 9090);
                        clickDialogButton('submit');
                        return p;
                    }).then(function (values) { if (!values.projectName) throw new Error('projectName missing'); return JSON.stringify(values); });
                });
            })
            .then(function () {
                return step('conversation', function () {
                    var questions = [
                        { name: 'goal', label: 'goal?', type: 'textarea', required: true, id: 'selftest-goal' },
                        { name: 'language', label: 'language?', type: 'select', options: ['java', 'js'], value: 'java' }
                    ];
                    var p = api.askConversation({ title: 'Self test conversation', questions: questions });
                    return tick(60).then(function () {
                        setField('selftest-goal', 'verify sdk');
                        clickDialogButton('submit');
                        return p;
                    }).then(function (answers) { if (!answers.goal) throw new Error('goal missing'); return JSON.stringify(answers); });
                });
            })
            .then(function () {
                return step('listener-roundtrip', function () { return sdk.request('demo.echo', { probe: 1 }).then(function (r) { return JSON.stringify(r.echo); }); });
            })
            .then(function () {
                return step('native-path-override', function () {
                    var unsubscribe = sdk.registerListener('ui.selectNativePath', function () {
                        return { path: 'C:/tmp/sdk-mock', paths: ['C:/tmp/sdk-mock'], mode: 'directory', mocked: true };
                    });
                    return api.selectNativePath({ title: 'mocked', notifyWhileWaiting: false })
                        .then(function (res) { unsubscribe(); if (!res.path) throw new Error('no path'); return res.path; })
                        .catch(function (err) { unsubscribe(); throw err; });
                });
            })
            .then(function () { return step('loadScript', loadExtraScript); })
            .then(function () {
                var failed = results.filter(function (r) { return !r.ok; }).length;
                var report = { total: results.length, failed: failed, summary: (results.length - failed) + '/' + results.length + ' passed', results: results };
                log('self test finished: ' + report.summary, failed ? 'error' : 'info');
                return report;
            });
    }

    /* ------------------------------------------------------------------ *
     * 5. Public surface + gated auto-show.
     * ------------------------------------------------------------------ */
    root.eazeUiSdkDemo = {
        pluginId: PLUGIN_ID,
        api: api,
        show: showPanel,
        hide: hidePanel,
        runSelfTest: runSelfTest,
        logs: function () { return logs.slice(); },
        registeredActions: ['demo.echo', 'demo.notifyChain', 'ui.showToast(interceptor)']
    };

    var wantsPanel = /[?&]sdkDemo=1(&|\$)/.test(root.location.search) || root.localStorage.getItem('eaze_ui_sdk_demo') === '1';
    // Panel creation waits for DOM readiness so the plugin is safe to load from <head> too.
    if (wantsPanel) { sdk.ready.then(showPanel); }

    sdk.ready.then(function () {
        log('ready — SDK v' + sdk.version + ' as plugin "' + PLUGIN_ID + '"', 'info');
    });
})(window || globalThis);
