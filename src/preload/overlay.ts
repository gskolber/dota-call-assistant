// Bridge for the overlay window. It only ever listens: the strip has no way
// to talk back, which is exactly as much power as it needs.

import { contextBridge, ipcRenderer } from 'electron';

import type { OverlayApi, OverlayState, Unsubscribe } from '../shared/types';

const api: OverlayApi = {
  onUpdate(handler: (state: OverlayState) => void): Unsubscribe {
    const wrapped = (_event: Electron.IpcRendererEvent, state: OverlayState): void => handler(state);
    ipcRenderer.on('overlay:state', wrapped);
    return () => { ipcRenderer.removeListener('overlay:state', wrapped); };
  },
};

contextBridge.exposeInMainWorld('overlay', api);
