// Finds the Dota 2 install through Steam and writes the Game State
// Integration config. The launch option still has to be added by hand -
// Steam exposes no supported way to set it for the user.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const CFG_NAME = 'gamestate_integration_callassistant.cfg';
const CFG_SUBPATH = path.join('game', 'dota', 'cfg', 'gamestate_integration');

function readRegistry(key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const match = /REG_SZ\s+(.+)/.exec(stdout);
      resolve(match?.[1]?.trim() ?? null);
    });
  });
}

async function steamRoots(): Promise<string[]> {
  const roots = new Set<string>();

  const fromRegistry =
    (await readRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ??
    (await readRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')) ??
    (await readRegistry('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'));
  if (fromRegistry) roots.add(path.normalize(fromRegistry));

  for (const guess of [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam',
    'D:\\SteamLibrary',
    'E:\\Steam',
    'E:\\SteamLibrary',
  ]) {
    if (fs.existsSync(guess)) roots.add(guess);
  }
  return [...roots];
}

/** libraryfolders.vdf is a small key/value tree; we only need every "path". */
function libraryPaths(steamRoot: string): string[] {
  const out = [steamRoot];
  let text: string;
  try {
    text = fs.readFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), 'utf8');
  } catch {
    return out;
  }
  for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
    const value = match[1];
    if (value) out.push(value.replace(/\\\\/g, '\\'));
  }
  return [...new Set(out)];
}

/** Every directory that looks like a Dota 2 install, best guess first. */
export async function findDotaDirs(): Promise<string[]> {
  const found: string[] = [];
  for (const root of await steamRoots()) {
    for (const lib of libraryPaths(root)) {
      const dir = path.join(lib, 'steamapps', 'common', 'dota 2 beta');
      if (fs.existsSync(dir)) found.push(dir);
    }
  }
  return [...new Set(found)];
}

export function cfgDirFor(dotaDir: string): string {
  return path.join(dotaDir, CFG_SUBPATH);
}

/** `dir` may be the install root or the gamestate_integration folder itself. */
export function normaliseTarget(dir: string | null): string | null {
  if (!dir) return null;
  if (path.basename(dir).toLowerCase() === 'gamestate_integration') return dir;
  if (fs.existsSync(path.join(dir, 'game', 'dota'))) return cfgDirFor(dir);
  return cfgDirFor(dir);
}

export function cfgBody(token: string, port: number): string {
  return [
    '"Call Assistant"',
    '{',
    `    "uri"          "http://127.0.0.1:${port}/"`,
    '    "timeout"      "5.0"',
    '    "buffer"       "0.1"',
    '    "throttle"     "0.1"',
    '    "heartbeat"    "30.0"',
    '    "auth"',
    '    {',
    `        "token"    "${token}"`,
    '    }',
    '    "data"',
    '    {',
    '        "provider"      "1"',
    '        "map"           "1"',
    '        "player"        "1"',
    '        "hero"          "1"',
    '        "abilities"     "0"',
    '        "items"         "1"',
    '        "buildings"     "0"',
    '        "draft"         "0"',
    '        "wearables"     "0"',
    '    }',
    '}',
    '',
  ].join('\r\n');
}

export function install(dir: string, token: string, port: number): string {
  const target = normaliseTarget(dir);
  if (!target) throw new Error('Pasta do Dota 2 não encontrada.');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, CFG_NAME);
  fs.writeFileSync(file, cfgBody(token, port), 'utf8');
  return file;
}

export function isInstalled(dir: string | null): boolean {
  const target = normaliseTarget(dir);
  return !!target && fs.existsSync(path.join(target, CFG_NAME));
}
