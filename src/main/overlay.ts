// The in-game strip. Deliberately the least interesting window in the app:
// no chrome, no buttons, no focus, no mouse. It exists so a glance costs
// nothing; everything it knows is pushed to it by the renderer.
//
// Dota in exclusive fullscreen composites past every other window, so the
// strip simply will not be there. That is the documented cost of not being
// an injected overlay - borderless and windowed both work.

import path from 'node:path';
import { BrowserWindow, screen } from 'electron';

import type { OverlayCorner, OverlayState } from '../shared/types';
import * as store from './store';

const WIDTH = 260;
/** one header-less row per call, plus the padding around them */
const ROW = 26;
const ROWS = 4;
const HEIGHT = ROW * ROWS + 12;
/** gap from the top of the work area, enough to clear a Dota HUD notification */
const MARGIN = 12;

let overlay: BrowserWindow | null = null;

/**
 * The strip lives in a corner so it never sits over the top bar or the shop.
 * Which corner is the user's call: what is free depends on their resolution
 * and on whether they run the HUD scaled.
 */
function cornerPosition(
  corner: OverlayCorner,
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const right = corner === 'top-right' || corner === 'bottom-right';
  const bottom = corner === 'bottom-left' || corner === 'bottom-right';
  return {
    x: right ? area.x + area.width - WIDTH - MARGIN : area.x + MARGIN,
    y: bottom ? area.y + area.height - HEIGHT - MARGIN : area.y + MARGIN,
  };
}

/** Moves an already-open strip when the user picks another corner. */
export function moveOverlay(corner: OverlayCorner): void {
  if (!overlay || overlay.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const { x, y } = cornerPosition(corner, workArea);
  overlay.setBounds({ x, y, width: WIDTH, height: HEIGHT });
}
/** kept so a freshly created strip is not blank until the next renderer tick */
let last: OverlayState | null = null;

function create(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    ...cornerPosition(store.load().overlayCorner, workArea),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // the three that keep it out of the player's way: it can never be focused,
    // never shows in Alt+Tab or the taskbar, and never eats a click
    focusable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the highest level that still sits under the OS UI, so
  // the strip stays above Dota without covering system dialogs.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);

  void win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  win.once('ready-to-show', () => {
    // showInactive, never show: showing must not steal focus from the game
    win.showInactive();
  });
  win.webContents.on('did-finish-load', () => {
    if (last) win.webContents.send('overlay:state', last);
  });
  win.on('closed', () => {
    if (overlay === win) overlay = null;
  });

  return win;
}

export function setEnabled(enabled: boolean): void {
  if (enabled) {
    if (!overlay || overlay.isDestroyed()) overlay = create();
    return;
  }
  // destroyed, not hidden: a hidden always-on-top window is still a window
  // that can come back on top of the game by accident.
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}

export function push(state: OverlayState): void {
  last = state;
  if (!overlay || overlay.isDestroyed()) return;
  if (overlay.webContents.isLoading()) return; // did-finish-load will send `last`
  overlay.webContents.send('overlay:state', state);
}

export function destroy(): void {
  setEnabled(false);
  last = null;
}
