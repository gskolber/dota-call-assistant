import { CLIPS, PALETTE, mmss } from '../shared/catalog';
import { translator, type MessageKey, type Translate, type Vars } from '../shared/i18n';
import type {
  ClipIndex, GsiPayload, GsiStatus, HotkeyName, ScreenId, Settings,
} from '../shared/types';
import { AudioBank, listAudioDevices } from './audio';
import { h, mount } from './dom';
import { CallEngine, paletteByCode, type EngineFlags } from './engine';
import { EMPTY_MATCH, MatchTracker, type MatchState } from './match';
import { RecordDialog } from './record-ui';
import { renderScreen, renderSidebar, type Actions, type Ctx } from './screens';

const SPEAKING_MS = 2200;
const PALETTE_MS = 2600;
/** seconds of clock the engine will replay before giving up and resyncing */
const CATCH_UP = 5;
/** silence after which Dota is considered gone, menu or match alike */
const GSI_TIMEOUT_MS = 12_000;
/** the audio screen owns <select>s that a blind re-render would fight with */
const STATIC_SCREENS = new Set<ScreenId>(['audio']);

const dom = {
  titlebar: document.getElementById('titlebar') as HTMLElement,
  sidebar: document.getElementById('sidebar') as HTMLElement,
  main: document.getElementById('main') as HTMLElement,
  record: document.getElementById('record') as HTMLElement,
  palette: document.getElementById('palette') as HTMLElement,
  toast: document.getElementById('toast') as HTMLElement,
};

const engine = new CallEngine();
const tracker = new MatchTracker();
const audio = new AudioBank();

const state = {
  settings: null as Settings | null,
  gsi: null as GsiStatus | null,
  match: EMPTY_MATCH as MatchState,
  clips: {} as ClipIndex,
  devices: { inputs: [] as MediaDeviceInfo[], outputs: [] as MediaDeviceInfo[] },
  lastPayload: null as GsiPayload | null,
  speaking: null as { text: string; source: string } | null,
  deadOverride: false,
  fight: false,
  maximized: false,
  clock: 0,
  sim: { active: false, playing: false, clock: 0 },
  paletteBuffer: '',
  paletteOpen: false,
  lastMatchId: '',
  capturing: null as HotkeyName | null,
  dirty: true,
};

/** Rebuilt whenever the interface language changes. */
let t: Translate = translator('en');

let speakingTimer = 0;
let paletteTimer = 0;
let toastTimer = 0;
let lastTickedClock: number | null = null;
let simAnchor = 0;

function settings(): Settings {
  if (!state.settings) throw new Error('settings not loaded yet');
  return state.settings;
}

// ── ui plumbing ───────────────────────────────────────────────────────────

function toast(key: MessageKey, vars?: Vars): void {
  mount(dom.toast, h('div.toast', { text: t(key, vars) }));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => mount(dom.toast), 2400);
}

async function patchSettings(partial: Partial<Settings>): Promise<void> {
  state.settings = await window.api.settings.set(partial);
  t = translator(state.settings.uiLanguage);
  applyAudioSettings();
  if (partial.voiceLocale) await loadClips();
  state.dirty = true;
}

function applyAudioSettings(): void {
  const s = settings();
  audio.volume = s.volume;
  audio.verbose = s.verbose;
  audio.locale = s.voiceLocale;
  audio.ttsFallback = s.ttsFallback;
  audio.outputDeviceId = s.outputDeviceId;
}

async function loadClips(): Promise<void> {
  const locale = settings().voiceLocale;
  state.clips = await window.api.clips.list(locale);
  await audio.load(locale, state.clips);
  state.dirty = true;
}

async function refreshDevices(): Promise<void> {
  state.devices = await listAudioDevices();
  state.dirty = true;
}

// ── clock ─────────────────────────────────────────────────────────────────

function flags(): EngineFlags {
  const s = settings();
  return {
    role: s.role,
    team: state.match.team,
    stackSecond: s.stackSecond,
    budget: s.budget,
    muted: s.muted,
    dead: state.deadOverride || (state.match.inMatch && !state.match.alive),
    fight: state.fight,
    paused: state.match.inMatch && state.match.paused,
    mutedEvents: s.mutedEvents,
  };
}

function currentClock(): number {
  if (state.match.inMatch) return state.match.clock;
  if (state.sim.active) return state.sim.clock;
  return state.clock;
}

function speak(text: string, source: string): void {
  state.speaking = { text, source };
  state.dirty = true;
  window.clearTimeout(speakingTimer);
  speakingTimer = window.setTimeout(() => {
    state.speaking = null;
    state.dirty = true;
  }, SPEAKING_MS);
}

function runEngineTick(clock: number): void {
  const calls = engine.tick(clock, flags(), {
    gold: state.match.gold,
    buybackCost: state.match.buybackCost,
    buybackCooldown: state.match.buybackCooldown,
    hasTp: state.match.hasTp,
    alive: !flags().dead,
    ultimateReadyAt: state.match.ultimateReadyAt,
    itemsReadyAt: state.match.itemsReadyAt,
  });

  for (const call of calls) {
    const result = audio.speak(call.clip);
    if (result.source !== 'silent') speak(result.text, result.source);
  }
  state.dirty = true;
}

/**
 * Runs faster than the clock so a sampling hiccup cannot swallow a second.
 * Every whole second between the last tick and now is replayed; a jump larger
 * than CATCH_UP (a skip, a new match, a reconnect) resyncs instead.
 */
function pump(): void {
  if (!state.settings) return;

  const now = performance.now();
  if (state.sim.active && state.sim.playing && !state.match.inMatch) {
    while (now - simAnchor >= 1000) {
      state.sim.clock += 1;
      simAnchor += 1000;
      state.dirty = true;
    }
  } else {
    simAnchor = now;
  }

  const clock = currentClock();
  state.clock = clock;

  if (lastTickedClock === null || clock < lastTickedClock || clock - lastTickedClock > CATCH_UP) {
    lastTickedClock = clock;
    return;
  }
  while (lastTickedClock < clock) {
    lastTickedClock += 1;
    runEngineTick(lastTickedClock);
  }
}

// ── render ────────────────────────────────────────────────────────────────

function context(): Ctx {
  return {
    settings: settings(),
    clock: state.clock,
    match: state.match,
    gsi: state.gsi,
    engine,
    flags: flags(),
    clips: state.clips,
    speaking: state.speaking,
    sim: { active: state.sim.active, playing: state.sim.playing },
    devices: state.devices,
    lastPayload: state.lastPayload,
    capturing: state.capturing,
    t,
    actions,
  };
}

function renderTitlebar(ctx: Ctx): void {
  const connected = !!ctx.gsi?.lastPayloadAt && Date.now() - ctx.gsi.lastPayloadAt < 10_000;
  mount(
    dom.titlebar,
    h('div.titlebar__brand', { text: 'CALL ASSISTANT' }),
    h('div.titlebar__spacer'),
    h('div.titlebar__meta', {
      text: ctx.match.inMatch
        ? `${ctx.match.heroName.toUpperCase() || t('title.inMatch')} · ${mmss(ctx.clock)}`
        : ctx.sim.active
          ? t('title.simulation', { clock: mmss(ctx.clock) })
          : t('title.timings'),
      style: 'margin-right:12px',
    }),
    h('div', {
      class: ctx.settings.muted ? 'chip chip--alert' : connected ? 'chip' : 'chip chip--off',
      text: t(ctx.settings.muted ? 'chip.muted' : connected ? 'chip.live' : 'chip.local'),
      style: 'margin-right:8px',
    }),
    h(
      'div.winbtns',
      {},
      h('button.winbtn', { text: '—', onClick: () => void window.api.window.minimize() }),
      h('button.winbtn', {
        text: state.maximized ? '❐' : '▢',
        onClick: () => void window.api.window.maximize(),
      }),
      h('button.winbtn.winbtn--close', { text: '✕', onClick: () => void window.api.window.close() }),
    ),
  );
}

/**
 * True between pointerdown and the click it produces. Rebuilding the tree in
 * that gap detaches the element the press started on, and the browser then
 * fires no click at all — which is why a button sometimes needed pressing
 * twice.
 */
let holdRenders = false;
let renderedClock = Number.NaN;

function releaseRenders(): void {
  holdRenders = false;
}

function watchPointer(): void {
  document.addEventListener('pointerdown', () => { holdRenders = true; });
  // the capture phase runs before the button's own handler, so the click has
  // certainly been dispatched by the time we let go
  document.addEventListener('click', releaseRenders, true);
  document.addEventListener('pointercancel', releaseRenders);
  // a press that ends outside the element produces no click; let go anyway
  document.addEventListener('pointerup', () => window.setTimeout(releaseRenders, 60));
}

function render(force = false): void {
  if (!state.settings) return;
  if (holdRenders && !force) return;

  const screen = settings().screen;
  const clockMoved = state.clock !== renderedClock;
  if (!force && !state.dirty && (STATIC_SCREENS.has(screen) || !clockMoved)) return;
  renderedClock = state.clock;

  const ctx = context();
  renderTitlebar(ctx);
  renderSidebar(dom.sidebar, ctx);
  renderScreen(dom.main, ctx);
  pushOverlay(ctx);
  state.dirty = false;
}

/** How many upcoming calls the strip shows at once. */
const OVERLAY_ROWS = 4;

/** The overlay is a second window; it only knows what we tell it. */
function pushOverlay(ctx: Ctx): void {
  if (!ctx.settings.overlayEnabled) return;
  void window.api.overlay.update({
    items: engine.queue(state.clock, flags(), OVERLAY_ROWS).map((item) => ({
      label: item.label,
      in: mmss(item.inSeconds),
      priority: item.priority,
    })),
    speaking: state.speaking?.text ?? null,
    muted: ctx.settings.muted,
  });
}

// ── quick palette ─────────────────────────────────────────────────────────

function openPalette(): void {
  state.paletteOpen = true;
  state.paletteBuffer = '';
  renderPalette();
  schedulePaletteClose();
}

function schedulePaletteClose(): void {
  window.clearTimeout(paletteTimer);
  paletteTimer = window.setTimeout(closePalette, PALETTE_MS);
}

function closePalette(): void {
  state.paletteOpen = false;
  state.paletteBuffer = '';
  mount(dom.palette);
}

function renderPalette(): void {
  if (!state.paletteOpen) return;
  const locale = settings().voiceLocale;

  mount(
    dom.palette,
    h(
      'div.overlay',
      { onClick: () => closePalette() },
      h(
        'div.palette.palette--overlay',
        {},
        h('div.palette__hint', {
          text: state.paletteBuffer ? `${state.paletteBuffer}_` : t('timers.paletteTyping'),
        }),
        PALETTE.map((entry) =>
          h(
            'div.palette__row',
            {
              class: entry.code.startsWith(state.paletteBuffer) && state.paletteBuffer
                ? 'palette__row--on'
                : '',
            },
            h('div.palette__code', { text: entry.code }),
            h('div.palette__label', { text: entry.label[locale] }),
          ),
        ),
      ),
    ),
  );
}

function paletteKey(key: string): void {
  if (!/^[a-zA-Z]$/.test(key)) return;
  state.paletteBuffer = (state.paletteBuffer + key.toUpperCase()).slice(-2);
  schedulePaletteClose();

  const entry = state.paletteBuffer.length === 2 ? paletteByCode(state.paletteBuffer) : undefined;
  if (entry) {
    engine.addPaletteTimer(entry, currentClock(), settings().voiceLocale);
    toast('toast.timerAdded', { code: entry.code, label: entry.label[settings().voiceLocale] });
    closePalette();
    state.dirty = true;
    return;
  }
  renderPalette();
}

// ── actions ───────────────────────────────────────────────────────────────

const record = new RecordDialog(dom.record, {
  getSettings: settings,
  t: (key, vars) => t(key, vars),
  onSaved: (id, meta) => {
    state.clips = { ...state.clips, [id]: meta };
    void loadClips();
    void refreshDevices();
    toast('toast.clipSaved', { id });
  },
  toast,
});

const actions: Actions = {
  setScreen: (screen) => void patchSettings({ screen }).then(() => render(true)),
  patch: (partial) => void patchSettings(partial).then(() => render(true)),

  toggleDead: () => {
    state.deadOverride = !state.deadOverride;
    state.dirty = true;
  },
  toggleFight: () => {
    state.fight = !state.fight;
    state.dirty = true;
  },
  toggleMute: () => {
    const muted = !settings().muted;
    if (muted) audio.stop();
    void patchSettings({ muted }).then(() => render(true));
    toast(muted ? 'toast.muted' : 'toast.audioOn');
  },

  toggleSim: () => {
    if (state.match.inMatch) {
      toast('toast.liveMatch');
      return;
    }
    if (!state.sim.active) {
      state.sim = { active: true, playing: true, clock: Math.max(0, state.clock) };
      engine.reset();
    } else {
      state.sim.playing = !state.sim.playing;
    }
    state.dirty = true;
  },
  simSkip: (seconds) => {
    if (state.match.inMatch) return;
    if (!state.sim.active) state.sim = { active: true, playing: false, clock: Math.max(0, state.clock) };
    state.sim.clock += seconds;
    state.dirty = true;
  },

  markRoshan: () => {
    if (engine.getRoshanMark() === null) {
      engine.markRoshan(currentClock());
      toast('toast.roshanMarked', { time: mmss(currentClock()) });
    } else {
      engine.clearRoshan();
      toast('toast.roshanCleared');
    }
    state.dirty = true;
  },
  openPalette,
  removeTimer: (key) => {
    engine.removeTimer(key);
    state.dirty = true;
  },

  previewClip: (id) => {
    void audio.preview(id).then((result) => {
      if (result.source === 'silent') toast('toast.noClipNoTts');
    });
  },
  recordClip: (id) => record.open([id]),
  recordMissing: () => record.open(CLIPS.filter((c) => !state.clips[c.id]).map((c) => c.id)),
  deleteClip: (id) => {
    void window.api.clips.remove(settings().voiceLocale, id).then(async () => {
      await loadClips();
      toast('toast.clipDeleted', { id });
      render(true);
    });
  },
  revealClips: () => void window.api.clips.reveal(settings().voiceLocale),

  installGsi: () => {
    void window.api.gsi.install(null).then(reportInstall);
  },
  chooseFolder: () => {
    void window.api.gsi.chooseFolder().then(async (dir) => {
      if (dir) await reportInstall(await window.api.gsi.install(dir));
    });
  },
  captureHotkey: (name) => {
    state.capturing = state.capturing === name ? null : name;
    state.dirty = true;
    render(true);
  },
  clearHotkey: (name) => {
    state.capturing = null;
    void applyHotkey(name, null);
  },

  exportVoicePack: () => {
    void window.api.voicePack.export(settings().voiceLocale).then(reportVoicePack);
  },
  importVoicePack: () => {
    void window.api.voicePack.import(settings().voiceLocale).then(async (result) => {
      if (result.ok) await loadClips();
      reportVoicePack(result);
    });
  },

  copy: (value, what) => {
    void window.api.app.copy(value);
    toast('toast.copied', { what: what.toUpperCase() });
  },
};

/** Export and import share one shape; only the success message differs. */
function reportVoicePack(result: Awaited<ReturnType<typeof window.api.voicePack.export>>): void {
  if (result.canceled) return;
  if (result.ok && result.count !== undefined) toast('toast.packImported', { count: result.count });
  else if (result.ok) toast('toast.packExported');
  else if (result.detail === 'EMPTY') toast('toast.packEmpty');
  else toast('toast.packFailed');
  render(true);
}

/** Surfaces the outcome of writing the GSI config, translating the error code. */
async function reportInstall(result: Awaited<ReturnType<typeof window.api.gsi.install>>): Promise<void> {
  if (result.ok) toast('toast.configWritten');
  else if (result.code) toast(`error.${result.code}` as MessageKey, { detail: result.detail ?? '' });
  state.gsi = await window.api.gsi.status();
  render(true);
}

/** Translates a key press into an Electron accelerator, or null if unusable. */
function acceleratorFor(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');

  const code = event.code;
  let key: string | null = null;

  if (/^Numpad[0-9]$/.test(code)) key = `num${code.slice(6)}`;
  else if (code === 'NumpadDecimal') key = 'numdec';
  else if (code === 'NumpadAdd') key = 'numadd';
  else if (code === 'NumpadSubtract') key = 'numsub';
  else if (code === 'NumpadMultiply') key = 'nummult';
  else if (code === 'NumpadDivide') key = 'numdiv';
  else if (/^F[0-9]{1,2}$/.test(code)) key = code;
  else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (code === 'Space') key = 'Space';
  else if (code === 'Insert' || code === 'Home' || code === 'End') key = code;

  return key ? [...modifiers, key].join('+') : null;
}

async function applyHotkey(name: HotkeyName, accelerator: string | null): Promise<void> {
  await patchSettings({ hotkeys: { ...settings().hotkeys, [name]: accelerator } });
  const registered = await window.api.hotkeys.register();
  if (accelerator && !registered[name]) {
    toast('toast.hotkeyInUse', { key: accelerator.toUpperCase() });
    await patchSettings({ hotkeys: { ...settings().hotkeys, [name]: null } });
  } else if (accelerator) {
    toast('toast.hotkeySet', { name: name.toUpperCase(), key: accelerator.toUpperCase() });
  }
  render(true);
}

// ── wiring ────────────────────────────────────────────────────────────────

function onPayload(payload: GsiPayload): void {
  state.lastPayload = payload;
  const previous = state.match;
  state.match = tracker.apply(payload);

  const matchId = payload.map?.matchid ?? '';
  if (matchId && matchId !== state.lastMatchId) {
    state.lastMatchId = matchId;
    engine.reset();
    lastTickedClock = null;
  }

  if (state.match.inMatch && !previous.inMatch) {
    state.sim.active = false;
    state.deadOverride = false;
    lastTickedClock = null;
    if (settings().screen === 'idle') void patchSettings({ screen: 'live' });
  }
  if (!state.match.inMatch && previous.inMatch && settings().screen === 'live') {
    void patchSettings({ screen: 'idle' });
  }
  state.dirty = true;
}

function onHotkey(name: string): void {
  if (name === 'mute') actions.toggleMute();
  if (name === 'roshan') actions.markRoshan();
  if (name === 'palette') openPalette();
}

function onKeyDown(event: KeyboardEvent): void {
  if (state.capturing) {
    event.preventDefault();
    const name = state.capturing;
    if (event.key === 'Escape') {
      state.capturing = null;
      render(true);
      return;
    }
    const accelerator = acceleratorFor(event);
    if (!accelerator) return;
    state.capturing = null;
    void applyHotkey(name, accelerator);
    return;
  }

  if (record.handleKey(event)) {
    event.preventDefault();
    return;
  }
  if (state.paletteOpen) {
    if (event.key === 'Escape') closePalette();
    else paletteKey(event.key);
    event.preventDefault();
  }
}

async function boot(): Promise<void> {
  state.settings = await window.api.settings.get();
  t = translator(state.settings.uiLanguage);
  applyAudioSettings();

  state.gsi = await window.api.gsi.status();
  await loadClips();
  await refreshDevices();

  window.api.gsi.onPayload(onPayload);
  window.api.gsi.onStatus((status) => {
    state.gsi = { ...status, dotaDirs: state.gsi?.dotaDirs, cfgDir: state.gsi?.cfgDir, cfgInstalled: state.gsi?.cfgInstalled };
    state.dirty = true;
  });
  window.api.hotkeys.onPress(onHotkey);
  // the tray can flip muting and the overlay behind our back
  window.api.settings.onChange((next) => {
    state.settings = next;
    t = translator(next.uiLanguage);
    applyAudioSettings();
    state.dirty = true;
    render(true);
  });
  window.api.window.onState(({ maximized }) => {
    state.maximized = maximized;
    state.dirty = true;
  });

  document.addEventListener('keydown', onKeyDown);
  watchPointer();
  navigator.mediaDevices?.addEventListener('devicechange', () => void refreshDevices());

  // GSI goes quiet when Dota closes and nothing tells us, so watch the clock.
  // This has to cover the menu too, not just a live match - Dota posts
  // payloads from the main menu, and those stop the same way.
  window.setInterval(() => {
    const last = state.gsi?.lastPayloadAt;
    if (!last || !state.match.connected) return;
    if (Date.now() - last > GSI_TIMEOUT_MS) {
      state.match = tracker.markDisconnected();
      state.dirty = true;
    }
  }, 4000);

  simAnchor = performance.now();
  window.setInterval(pump, 200);
  window.setInterval(() => render(), 250);
  render(true);
}

void boot();
