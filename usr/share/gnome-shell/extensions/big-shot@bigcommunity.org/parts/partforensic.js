/**
 * Big Shot — Forensic web page capture
 *
 * Spawns the standalone Python helper (usr/lib/big-shot/forensic_capture.py)
 * to produce an evidence bundle for legal/forensic use. The helper does the
 * heavy lifting (Playwright, HAR, TLS chain, hashes, optional RFC 3161); this
 * part just provides the entry point: a global keybinding that opens a URL
 * prompt, then runs the helper and notifies the user.
 *
 * Wired in extension.js. Helper docs: docs/forensic-capture.md.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PartBase } from './partbase.js';

const HELPER_PATHS = [
    '/usr/lib/big-shot/forensic_capture.py',
    '/usr/local/lib/big-shot/forensic_capture.py',
];
const KEYBINDING_NAME = 'forensic-capture';
const KEYBINDING_ACCEL = '<Super><Shift>w';

export class PartForensic extends PartBase {
    constructor(extension) {
        super();
        this._ext = extension;
        this._activeCapture = null;
        this._source = null;

        this._registerKeybinding();
    }

    _registerKeybinding() {
        // Hardcoded accelerator until a gsettings schema is introduced.
        // GNOME Shell requires a GSettings-backed key — we use the extension's
        // own settings if available, else a temporary in-memory schema fallback.
        try {
            const settings = this._ext.getSettings?.();
            if (settings && settings.list_keys().includes(KEYBINDING_NAME)) {
                Main.wm.addKeybinding(
                    KEYBINDING_NAME,
                    settings,
                    Meta.KeyBindingFlags.NONE,
                    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                    () => this.promptAndCapture(),
                );
                this._keybindingRegistered = true;
                return;
            }
        } catch (e) {
            console.log(`[Big Shot Forensic] settings-backed keybinding unavailable: ${e.message}`);
        }
        console.log(
            `[Big Shot Forensic] no settings schema for '${KEYBINDING_NAME}'; ` +
            `trigger via D-Bus or PartForensic.promptAndCapture() (suggested accel: ${KEYBINDING_ACCEL})`,
        );
        this._keybindingRegistered = false;
    }

    /**
     * Show a modal asking for the URL to capture. Triggered by keybinding,
     * future toolbar entry, or external caller.
     */
    promptAndCapture(prefillUrl = '') {
        if (this._activeCapture) {
            this._notify(
                _('Captura em andamento'),
                _('Aguarde a captura atual terminar antes de iniciar outra.'),
            );
            return;
        }
        const dialog = new ForensicUrlDialog(prefillUrl, (url, opts) => {
            if (url) this.captureUrl(url, opts);
        });
        dialog.open();
    }

    /**
     * Spawn the helper asynchronously. Shows progress and result notifications.
     * @param {string} url       URL to capture (must include scheme).
     * @param {object} options   { tsa: boolean, viewport: "WxH" }
     */
    captureUrl(url, options = {}) {
        const helper = this._resolveHelperPath();
        if (!helper) {
            this._notify(
                _('Helper forense não encontrado'),
                _('Instale o pacote big-shot completo ou veja docs/forensic-capture.md.'),
            );
            return;
        }

        const argv = ['python3', helper, '--url', url, '--quiet'];
        if (options.tsa) argv.push('--tsa');
        if (options.viewport) argv.push('--viewport', options.viewport);

        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (e) {
            this._notify(_('Erro ao iniciar captura'), e.message);
            return;
        }

        this._activeCapture = proc;
        const startNotif = this._notify(
            _('Captura forense iniciada'),
            _('Capturando %s … isto pode levar 10–60 s.').format(url),
            { transient: false },
        );

        proc.communicate_utf8_async(null, null, (p, res) => {
            this._activeCapture = null;
            startNotif?.destroy();
            let ok, stdout, stderr;
            try {
                [ok, stdout, stderr] = p.communicate_utf8_finish(res);
            } catch (e) {
                this._notify(_('Falha na captura'), e.message);
                return;
            }
            if (!ok || p.get_exit_status() !== 0) {
                const tail = (stderr || '').trim().split('\n').slice(-3).join('\n');
                this._notify(
                    _('Captura falhou (código %d)').format(p.get_exit_status()),
                    tail || _('Sem detalhes. Veja journalctl --user -e.'),
                );
                return;
            }
            let result;
            try {
                result = JSON.parse(stdout);
            } catch {
                this._notify(_('Captura concluída'), stdout.slice(0, 200));
                return;
            }
            this._notifyResult(result);
        });
    }

    _resolveHelperPath() {
        for (const p of HELPER_PATHS) {
            try {
                if (Gio.File.new_for_path(p).query_exists(null)) return p;
            } catch {}
        }
        return null;
    }

    _ensureSource() {
        if (this._source && !this._source._destroyed) return this._source;
        this._source = new MessageTray.Source({
            title: 'Big Shot',
            iconName: 'camera-photo-symbolic',
        });
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _notify(title, body, { transient = true } = {}) {
        const source = this._ensureSource();
        const notif = new MessageTray.Notification({
            source,
            title,
            body,
            isTransient: transient,
        });
        source.addNotification(notif);
        return notif;
    }

    _notifyResult(result) {
        const dir = result.bundle_dir;
        const zip = result.zip_path;
        const status = result.http_status;
        const body = _('HTTP %s · %s').format(status ?? '?', result.url_final || '');
        const source = this._ensureSource();
        const notif = new MessageTray.Notification({
            source,
            title: _('Pacote forense pronto'),
            body,
            isTransient: false,
        });
        notif.addAction(_('Abrir pasta'), () => {
            this._openInFileManager(dir);
        });
        if (zip) {
            notif.addAction(_('Copiar caminho do .zip'), () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, zip);
            });
        }
        source.addNotification(notif);
    }

    _openInFileManager(path) {
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(path).get_uri(),
                null,
            );
        } catch (e) {
            console.log(`[Big Shot Forensic] open folder failed: ${e.message}`);
        }
    }

    destroy() {
        if (this._keybindingRegistered) {
            try {
                Main.wm.removeKeybinding(KEYBINDING_NAME);
            } catch {}
            this._keybindingRegistered = false;
        }
        if (this._source) {
            try { this._source.destroy(); } catch {}
            this._source = null;
        }
        super.destroy();
    }
}

// =============================================================================
// ForensicUrlDialog — Modal asking for URL + flags before capture
// =============================================================================

const ForensicUrlDialog = GObject.registerClass(
class ForensicUrlDialog extends ModalDialog.ModalDialog {
    _init(prefillUrl, onConfirm) {
        super._init({ styleClass: 'big-shot-forensic-dialog' });
        this._onConfirm = onConfirm;

        const content = new St.BoxLayout({
            vertical: true,
            style: 'spacing: 12px; padding: 16px; min-width: 480px;',
        });

        content.add_child(new St.Label({
            text: _('Captura forense de página web'),
            style: 'font-weight: bold; font-size: 14px;',
        }));
        content.add_child(new St.Label({
            text: _('Recarrega a URL em Chromium headless e gera pacote de evidências com hashes, certificados TLS e HAR.'),
            style: 'font-size: 11px; opacity: 0.8;',
        }));

        this._urlEntry = new St.Entry({
            text: prefillUrl,
            hint_text: 'https://exemplo.com.br/pagina',
            can_focus: true,
            style: 'min-width: 440px;',
        });
        content.add_child(this._urlEntry);

        const optsRow = new St.BoxLayout({ style: 'spacing: 8px;' });
        this._tsaCheck = this._makeCheckButton(_('Carimbo de tempo (RFC 3161 / FreeTSA)'), false);
        optsRow.add_child(this._tsaCheck);
        content.add_child(optsRow);

        this.contentLayout.add_child(content);

        this.setButtons([
            { label: _('Cancelar'), action: () => this.close(), key: Clutter.KEY_Escape },
            {
                label: _('Capturar'),
                action: () => {
                    const url = this._urlEntry.get_text().trim();
                    this.close();
                    this._onConfirm(url, { tsa: this._tsaCheck._checked });
                },
                default: true,
            },
        ]);

        // Focus the entry once open
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._urlEntry.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _makeCheckButton(label, initial) {
        const btn = new St.Button({
            label: `${initial ? '☑' : '☐'} ${label}`,
            style: 'padding: 4px 8px;',
        });
        btn._checked = initial;
        btn.connect('clicked', () => {
            btn._checked = !btn._checked;
            btn.label = `${btn._checked ? '☑' : '☐'} ${label}`;
        });
        return btn;
    }
});

