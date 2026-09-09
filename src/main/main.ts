import fs from 'node:fs';
import path from 'node:path';
import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray,
} from 'electron';

import { translator } from '../shared/i18n';
import type {
  ClipId, GsiStatus, HotkeyName, InstallResult, Locale, OverlayState, Settings,
} from '../shared/types';
import * as dota from './dota';
import * as overlay from './overlay';
import * as recordings from './recordings';
import * as store from './store';
import { GsiServer, PORT } from './gsi';
import { registerVoicePackIpc } from './voicepack';

const isDev = process.argv.includes('--dev');
/** set by the login item, so starting with Windows does not throw a window at the user */
const isAutostart = process.argv.includes('--autostart');
const gsi = new GsiServer();
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** closing the window hides to tray; only this says the user really means it */
let quitting = false;

function iconPath(): string {
  return path.join(__dirname, '..', 'renderer', 'icon.png');
}

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── window ────────────────────────────────────────────────────────────────

function createWindow(options: { hidden?: boolean } = {}): void {
  win = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 1060,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#D9D6CE',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // this app exists to count seconds while it sits behind Dota - never
      // let Chromium throttle its timers when the window loses focus
      backgroundThrottling: false,
    },
  });

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // hidden means started by the login item: the renderer still boots, calls
  // still fire, the window just waits in the tray until it is asked for
  win.once('ready-to-show', () => { if (!options.hidden) win?.show(); });
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));

  win.on('close', (event) => {
    // with no tray there is no way back to a hidden window, so let it close
    if (quitting || !tray) return;
    event.preventDefault();
    win?.hide();
  });
  win.on('closed', () => {
    win = null;
    if (!tray) app.quit();
  });

  // A frameless window has nowhere to show Chromium's mic prompt, and the
  // user already opted in by pressing record, so answer it for our page.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ── tray ──────────────────────────────────────────────────────────────────
// The app lives here while Dota is in front: closing the window only hides it,
// and quitting is a deliberate act from this menu.

function buildTrayMenu(): void {
  if (!tray) return;
  const settings = store.load();
  const t = translator(settings.uiLanguage);

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('tray.show'), click: () => showWindow() },
    { type: 'separator' },
    // routed as a hotkey press so the renderer stays the one place that owns
    // muting - it persists the setting and shows its own toast
    { label: t(settings.muted ? 'tray.unmute' : 'tray.mute'), click: () => send('hotkey', 'mute') },
    {
      label: t('tray.overlay'),
      type: 'checkbox',
      checked: settings.overlayEnabled,
      click: (item) => {
        const next = store.patch({ overlayEnabled: item.checked });
        overlay.setEnabled(next.overlayEnabled);
        send('settings:changed', next);
        buildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray(): void {
  try {
    const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip('Call Assistant');
    tray.on('click', () => showWindow());
    tray.on('double-click', () => showWindow());
    buildTrayMenu();
  } catch (err) {
    // a desktop with no tray (or none yet) must not cost the user the app
    tray = null;
    console.error('[tray] unavailable:', (err as Error).message);
  }
}

// ── start with windows ────────────────────────────────────────────────────

function applyLoginItem(enabled: boolean): void {
  // --autostart tells the next boot it was the login item that started it
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--autostart'] });
}

/**
 * Windows lets the user kill a startup entry from Task Manager without telling
 * the app. The OS is the truth: adopt it instead of quietly switching the entry
 * back on at every launch.
 */
function syncLoginItem(): void {
  const actual = app.getLoginItemSettings().openAtLogin;
  if (actual !== store.load().startWithWindows) store.patch({ startWithWindows: actual });
}

// ── hotkeys ───────────────────────────────────────────────────────────────
// These only listen. Nothing is ever injected back into Dota.

function registerHotkeys(): Record<HotkeyName, string | null> {
  globalShortcut.unregisterAll();
  const { hotkeys } = store.load();
  const result: Record<HotkeyName, string | null> = { mute: null, roshan: null, palette: null };

  for (const name of Object.keys(result) as HotkeyName[]) {
    const accelerator = hotkeys[name];
    if (!accelerator) continue;
    try {
      result[name] = globalShortcut.register(accelerator, () => send('hotkey', name))
        ? accelerator
        : null;
    } catch {
      result[name] = null;
    }
  }
  return result;
}

// ── ipc ───────────────────────────────────────────────────────────────────

function wireIpc(): void {
  ipcMain.handle('win:minimize', () => { win?.minimize(); });
  ipcMain.handle('win:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => { win?.close(); });

  ipcMain.handle('settings:get', () => store.load());
  ipcMain.handle('settings:set', (_e, partial: Partial<Settings>) => {
    if (partial.overlayCorner) overlay.moveOverlay(partial.overlayCorner);
    const next = store.patch(partial);
    if (partial.hotkeys) registerHotkeys();
    if (partial.overlayEnabled !== undefined) overlay.setEnabled(next.overlayEnabled);
    if (partial.startWithWindows !== undefined) applyLoginItem(next.startWithWindows);
    // the tray shows the mute state, the overlay check and the interface language
    if (partial.muted !== undefined || partial.overlayEnabled !== undefined
      || partial.uiLanguage !== undefined) buildTrayMenu();
    return next;
  });

  ipcMain.handle('overlay:update', (_e, state: OverlayState) => { overlay.push(state); });

  ipcMain.handle('hotkeys:register', () => registerHotkeys());

  ipcMain.handle('clips:list', (_e, locale: Locale) => recordings.list(locale));
  ipcMain.handle('clips:read', (_e, locale: Locale, id: ClipId) => {
    try {
      return recordings.read(locale, id);
    } catch {
      return null;
    }
  });
  ipcMain.handle('clips:save', (_e, locale: Locale, id: ClipId, bytes: Uint8Array, durationMs: number) =>
    recordings.save(locale, id, Buffer.from(bytes), durationMs));
  ipcMain.handle('clips:delete', (_e, locale: Locale, id: ClipId) => {
    recordings.remove(locale, id);
    return true;
  });
  ipcMain.handle('clips:reveal', async (_e, locale: Locale) => {
    const dir = recordings.localeDir(locale);
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('gsi:status', async (): Promise<GsiStatus> => {
    const settings = store.load();
    const dotaDirs = await dota.findDotaDirs();
    const target = settings.dotaCfgDir ?? dotaDirs[0] ?? null;
    return {
      ...gsi.status(),
      dotaDirs,
      cfgDir: dota.normaliseTarget(target),
      cfgInstalled: dota.isInstalled(target),
      cfgOutdated: dota.isInstalled(target)
        && !dota.isCurrent(target, settings.gsiToken, PORT),
    };
  });

  ipcMain.handle('gsi:install', async (_e, explicitDir?: string | null): Promise<InstallResult> => {
    const settings = store.load();
    const dotaDirs = await dota.findDotaDirs();
    const target = explicitDir ?? settings.dotaCfgDir ?? dotaDirs[0];
    if (!target) return { ok: false, code: 'DOTA_NOT_FOUND' };

    try {
      const file = dota.install(target, settings.gsiToken, PORT);
      store.patch({ dotaCfgDir: target });
      return { ok: true, file };
    } catch (err) {
      return { ok: false, code: 'WRITE_FAILED', detail: (err as Error).message };
    }
  });

  ipcMain.handle('gsi:chooseFolder', async () => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Selecione a pasta "dota 2 beta"',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  ipcMain.handle('app:copy', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    platform: process.platform,
    electron: process.versions.electron,
    systemLocale: app.getLocale(),
  }));
}

// ── boot ──────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  void app.whenReady().then(() => {
    const settings = store.load();

    gsi.on('payload', (payload) => send('gsi:payload', payload));
    gsi.on('status', (status) => send('gsi:status', status));
    gsi.start(settings.gsiToken);

    wireIpc();
    registerVoicePackIpc(() => win);
    createWindow({ hidden: isAutostart });
    createTray();
    registerHotkeys();
    syncLoginItem();
    if (settings.overlayEnabled) overlay.setEnabled(true);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // No quit here while there is a tray: the tray is the app, the window is
  // just a view of it, and quitting goes through the tray menu.
  app.on('window-all-closed', () => { if (!tray) app.quit(); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    overlay.destroy();
    tray?.destroy();
    tray = null;
    gsi.stop();
  });
}
