import { contextBridge, ipcRenderer } from 'electron';

import type {
  Api, ClipId, HotkeyName, Locale, OverlayState, Settings, Unsubscribe,
} from '../shared/types';

function on<T>(channel: string): (handler: (payload: T) => void) => Unsubscribe {
  return (handler) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => { ipcRenderer.removeListener(channel, wrapped); };
  };
}

const api: Api = {
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    onState: on<{ maximized: boolean }>('win:state'),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (partial: Partial<Settings>) => ipcRenderer.invoke('settings:set', partial),
    onChange: on<Settings>('settings:changed'),
  },

  overlay: {
    update: (state: OverlayState) => ipcRenderer.invoke('overlay:update', state),
  },

  voicePack: {
    export: (locale: Locale) => ipcRenderer.invoke('voicepack:export', locale),
    import: (locale: Locale) => ipcRenderer.invoke('voicepack:import', locale),
  },

  hotkeys: {
    register: () => ipcRenderer.invoke('hotkeys:register'),
    onPress: on<HotkeyName>('hotkey'),
  },

  clips: {
    list: (locale: Locale) => ipcRenderer.invoke('clips:list', locale),
    read: (locale: Locale, id: ClipId) => ipcRenderer.invoke('clips:read', locale, id),
    save: (locale: Locale, id: ClipId, bytes: Uint8Array, durationMs: number) =>
      ipcRenderer.invoke('clips:save', locale, id, bytes, durationMs),
    remove: (locale: Locale, id: ClipId) => ipcRenderer.invoke('clips:delete', locale, id),
    reveal: (locale: Locale) => ipcRenderer.invoke('clips:reveal', locale),
  },

  gsi: {
    status: () => ipcRenderer.invoke('gsi:status'),
    install: (dir?: string | null) => ipcRenderer.invoke('gsi:install', dir),
    chooseFolder: () => ipcRenderer.invoke('gsi:chooseFolder'),
    onPayload: on('gsi:payload'),
    onStatus: on('gsi:status'),
  },

  app: {
    copy: (text: string) => ipcRenderer.invoke('app:copy', text),
    info: () => ipcRenderer.invoke('app:info'),
  },
};

contextBridge.exposeInMainWorld('api', api);
