import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, shell } from 'electron';

import type { ClipId, GsiStatus, HotkeyName, Locale, Settings } from '../shared/types';
import * as dota from './dota';
import * as recordings from './recordings';
import * as store from './store';
import { GsiServer, PORT } from './gsi';

const isDev = process.argv.includes('--dev');
const gsi = new GsiServer();
let win: BrowserWindow | null = null;

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ── window ────────────────────────────────────────────────────────────────

function createWindow(): void {
  win = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 1060,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#D9D6CE',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
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
  win.once('ready-to-show', () => win?.show());
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));
  win.on('closed', () => { win = null; });

  // A frameless window has nowhere to show Chromium's mic prompt, and the
  // user already opted in by pressing record, so answer it for our page.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
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
    const next = store.patch(partial);
    if (partial.hotkeys) registerHotkeys();
    return next;
  });

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
    };
  });

  ipcMain.handle('gsi:install', async (_e, explicitDir?: string | null) => {
    const settings = store.load();
    const dotaDirs = await dota.findDotaDirs();
    const target = explicitDir ?? settings.dotaCfgDir ?? dotaDirs[0];
    if (!target) {
      return { ok: false as const, error: 'Não encontrei a pasta do Dota 2. Escolha manualmente.' };
    }
    try {
      const file = dota.install(target, settings.gsiToken, PORT);
      store.patch({ dotaCfgDir: target });
      return { ok: true as const, file };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
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
  }));
}

// ── boot ──────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  void app.whenReady().then(() => {
    const settings = store.load();

    gsi.on('payload', (payload) => send('gsi:payload', payload));
    gsi.on('status', (status) => send('gsi:status', status));
    gsi.start(settings.gsiToken);

    wireIpc();
    createWindow();
    registerHotkeys();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    gsi.stop();
  });
}
