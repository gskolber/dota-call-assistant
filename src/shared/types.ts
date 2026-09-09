// Contracts shared by the main process, the preload bridge and the renderer.

import type { UiLanguage } from './i18n';

/** Language of the recorded clips and of what gets spoken. */
export type Locale = 'pt-BR' | 'en';

export type RoleId = 'POS 1' | 'POS 2' | 'POS 3' | 'POS 4' | 'POS 5';

/** The map is mirrored, so a few timings differ by which side you are on. */
export type Team = 'radiant' | 'dire';

export type ScreenId = 'live' | 'panel' | 'timers' | 'role' | 'audio' | 'gsi' | 'idle';

/** 1 = chatter, 5 = never drop this one. */
export type Priority = 1 | 2 | 3 | 4 | 5;

export type ClipId =
  | 'stack' | 'pull' | 'bounty' | 'power_rune' | 'wisdom'
  | 'night' | 'day' | 'tier_two' | 'tier_three' | 'tormentor'
  | 'aegis_expira' | 'rosh_possivel' | 'rosh_garantido'
  | 'sem_buyback' | 'sem_tp' | 'glyph_pronto'
  | 'smoke_visto' | 'aegis_inimigo' | 'buyback_inimigo'
  | 'ult_pronta' | 'item_pronto';

export type HotkeyName = 'mute' | 'roshan' | 'palette';

export interface Settings {
  screen: ScreenId;
  role: RoleId;
  verbose: boolean;
  muted: boolean;
  /** max spoken calls per rolling minute */
  budget: number;
  /**
   * Second of the minute the stack call aims at. There is no single right
   * answer: it runs from about 52 to 56 depending on camp size and on whether
   * the camp is already stacked, so this is a knob rather than a constant.
   */
  stackSecond: number;
  volume: number;
  /** which clip folder is used and which wording is spoken */
  voiceLocale: Locale;
  /** interface language — deliberately independent of the voice */
  uiLanguage: UiLanguage;
  /** speak with the OS voice when a clip has not been recorded */
  ttsFallback: boolean;
  outputDeviceId: string;
  inputDeviceId: string;
  gsiToken: string;
  dotaCfgDir: string | null;
  hotkeys: Record<HotkeyName, string | null>;
  /** event ids silenced by hand, on top of whatever the role set mutes */
  mutedEvents: string[];
  /** the thin in-game strip; off until asked for, it is not the point of the app */
  overlayEnabled: boolean;
  overlayCorner: OverlayCorner;
  startWithWindows: boolean;
}

/**
 * What the overlay strip shows. The renderer owns the engine, so it formats
 * everything and the main process only forwards it.
 */
export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface OverlayItem {
  label: string;
  in: string;              // already formatted, e.g. "1:09"
  priority: number;
}

export interface OverlayState {
  /** upcoming calls, soonest first — several are often due at once */
  items: OverlayItem[];
  speaking: string | null; // call text while it is being spoken
  muted: boolean;
}

/** Reply of a voice pack export or import. `count` is only set on import. */
export interface VoicePackResult {
  ok: boolean;
  /** the user closed the file dialog — not an error, show no toast */
  canceled?: boolean;
  count?: number;
  file?: string;
  detail?: string;
}

export interface ClipMeta {
  id: ClipId;
  bytes: number;
  recordedAt: number;
  durationMs: number | null;
}

export type ClipIndex = Partial<Record<ClipId, ClipMeta>>;

export interface GsiStatus {
  listening: boolean;
  port: number;
  host: string;
  payloads: number;
  rejected: number;
  lastPayloadAt: number | null;
  avgMs: number;
  reconnects: number;
  error: string | null;
  token: string | null;
  /** only present on the ipc `gsi:status` reply, not on pushed updates */
  dotaDirs?: string[];
  cfgDir?: string | null;
  cfgInstalled?: boolean;
  /** the file exists but an older build wrote it, so blocks may be missing */
  cfgOutdated?: boolean;
}

// ── Dota 2 Game State Integration payload ────────────────────────────────
// Everything is optional: Valve omits blocks depending on game state, and a
// spectator client sends arrays where a player client sends objects.

export interface GsiMap {
  name?: string;
  matchid?: string;
  game_time?: number;
  clock_time?: number;
  daytime?: boolean;
  nightstalker_night?: boolean;
  /** seconds until observer wards can be bought again */
  ward_purchase_cooldown?: number;
  game_state?: string;
  paused?: boolean;
  win_team?: string;
  radiant_score?: number;
  dire_score?: number;
}

export interface GsiPlayer {
  steamid?: string;
  name?: string;
  activity?: string;
  team_name?: string;
  gold?: number;
  gold_reliable?: number;
  gold_unreliable?: number;
  gpm?: number;
  xpm?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  last_hits?: number;
  denies?: number;
  buyback_cost?: number;
  buyback_cooldown?: number;
}

export interface GsiHero {
  id?: number;
  name?: string;
  level?: number;
  alive?: boolean;
  respawn_seconds?: number;
  buyback_cost?: number;
  buyback_cooldown?: number;
  health_percent?: number;
  mana_percent?: number;
  smoked?: boolean;
}

export interface GsiAbility {
  /** full length of this cooldown, so it need not be inferred by sampling */
  max_cooldown?: number;
  name?: string;
  level?: number;
  can_cast?: boolean;
  passive?: boolean;
  ability_active?: boolean;
  /** seconds left; 0 means off cooldown */
  cooldown?: number;
  ultimate?: boolean;
}

/** Keyed `ability0`, `ability1`, ... in the order they sit on the hero bar. */
export type GsiAbilities = Record<string, GsiAbility>;

export interface GsiItem {
  /** full length of this cooldown, so it need not be inferred by sampling */
  max_cooldown?: number;
  name?: string;
  purchaser?: number;
  charges?: number;
  item_charges?: number;
  cooldown?: number;
  can_cast?: boolean;
}

export type GsiItems = Record<string, GsiItem>;

export interface GsiPayload {
  provider?: { name?: string; appid?: number; version?: number; timestamp?: number };
  map?: GsiMap;
  player?: GsiPlayer;
  hero?: GsiHero;
  abilities?: GsiAbilities;
  items?: GsiItems;
  previously?: unknown;
  added?: unknown;
  auth?: { token?: string };
}

// ── window.api, as exposed by the preload bridge ─────────────────────────

export type Unsubscribe = () => void;

/** Errors crossing the IPC boundary travel as codes; the renderer translates. */
export type ErrorCode = 'DOTA_NOT_FOUND' | 'WRITE_FAILED';

export interface InstallResult {
  ok: boolean;
  file?: string;
  code?: ErrorCode;
  detail?: string;
}

export interface Api {
  window: {
    minimize(): Promise<void>;
    maximize(): Promise<boolean>;
    close(): Promise<void>;
    onState(handler: (state: { maximized: boolean }) => void): Unsubscribe;
  };
  settings: {
    get(): Promise<Settings>;
    set(partial: Partial<Settings>): Promise<Settings>;
    /** the tray can change settings behind the renderer's back */
    onChange(handler: (settings: Settings) => void): Unsubscribe;
  };
  overlay: {
    update(state: OverlayState): Promise<void>;
  };
  voicePack: {
    export(locale: Locale): Promise<VoicePackResult>;
    import(locale: Locale): Promise<VoicePackResult>;
  };
  hotkeys: {
    register(): Promise<Record<HotkeyName, string | null>>;
    onPress(handler: (name: HotkeyName) => void): Unsubscribe;
  };
  clips: {
    list(locale: Locale): Promise<ClipIndex>;
    read(locale: Locale, id: ClipId): Promise<Uint8Array | null>;
    save(locale: Locale, id: ClipId, bytes: Uint8Array, durationMs: number): Promise<ClipMeta>;
    remove(locale: Locale, id: ClipId): Promise<boolean>;
    reveal(locale: Locale): Promise<string>;
  };
  gsi: {
    status(): Promise<GsiStatus>;
    install(dir?: string | null): Promise<InstallResult>;
    chooseFolder(): Promise<string | null>;
    onPayload(handler: (payload: GsiPayload) => void): Unsubscribe;
    onStatus(handler: (status: GsiStatus) => void): Unsubscribe;
  };
  app: {
    copy(text: string): Promise<boolean>;
    info(): Promise<{
      version: string;
      userData: string;
      platform: string;
      electron: string;
      systemLocale: string;
    }>;
  };
}

/** The overlay window gets its own tiny bridge — it can only listen. */
export interface OverlayApi {
  onUpdate(handler: (state: OverlayState) => void): Unsubscribe;
}

declare global {
  interface Window {
    api: Api;
    overlay: OverlayApi;
  }
}
