import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import { detectLanguage } from '../shared/i18n';
import type { Settings } from '../shared/types';

const DEFAULTS: Omit<Settings, 'gsiToken'> & { gsiToken: string } = {
  screen: 'live',
  role: 'POS 5',
  verbose: false,
  muted: false,
  budget: 4,
  volume: 0.7,
  voiceLocale: 'pt-BR',
  uiLanguage: 'pt-BR',
  ttsFallback: true,
  outputDeviceId: 'default',
  inputDeviceId: 'default',
  gsiToken: '',
  dotaCfgDir: null,
  hotkeys: { mute: 'F9', roshan: 'num1', palette: 'num0' },
  mutedEvents: [],
  overlayEnabled: false,
  startWithWindows: false,
};

let settingsPath: string | null = null;
let cache: Settings | null = null;

function file(): string {
  if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'settings.json');
  return settingsPath;
}

export function load(): Settings {
  if (cache) return cache;

  // `locale` used to mean both the voice and the interface; it was split in
  // two, so carry the old value into both halves on first read.
  let disk: Partial<Settings> & { locale?: Settings['voiceLocale'] } = {};
  try {
    disk = JSON.parse(fs.readFileSync(file(), 'utf8')) as typeof disk;
  } catch {
    disk = {};
  }

  cache = {
    ...DEFAULTS,
    ...disk,
    voiceLocale: disk.voiceLocale ?? disk.locale ?? DEFAULTS.voiceLocale,
    uiLanguage: disk.uiLanguage ?? disk.locale ?? detectLanguage(app.getLocale()),
    hotkeys: { ...DEFAULTS.hotkeys, ...(disk.hotkeys ?? {}) },
  };
  delete (cache as { locale?: unknown }).locale;

  if (!cache.gsiToken) {
    cache.gsiToken = randomBytes(16).toString('hex');
    save(cache);
  }
  return cache;
}

export function save(next: Settings): Settings {
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] cannot persist settings:', (err as Error).message);
  }
  return cache;
}

export function patch(partial: Partial<Settings>): Settings {
  const current = load();
  return save({
    ...current,
    ...partial,
    hotkeys: { ...current.hotkeys, ...(partial.hotkeys ?? {}) },
  });
}
