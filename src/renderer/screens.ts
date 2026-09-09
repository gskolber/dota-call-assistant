import {
  CLIPS, EVENTS, PALETTE, PHASES, PHASE_FOCUS, ROLES, STATE_CALLS,
  eventAppliesToRole, mmss, phaseFor,
} from '../shared/catalog';
import { UI_LANGUAGES, type MessageKey, type Translate } from '../shared/i18n';
import type {
  ClipId, ClipIndex, GsiPayload, GsiStatus, HotkeyName, Locale, ScreenId, Settings,
} from '../shared/types';
import type { CallEngine, EngineFlags } from './engine';
import type { MatchState } from './match';
import { h, mount } from './dom';

export interface Actions {
  setScreen(screen: ScreenId): void;
  patch(partial: Partial<Settings>): void;
  toggleDead(): void;
  toggleFight(): void;
  toggleMute(): void;
  toggleSim(): void;
  simSkip(seconds: number): void;
  markRoshan(): void;
  openPalette(): void;
  removeTimer(key: string): void;
  previewClip(id: ClipId): void;
  recordClip(id: ClipId): void;
  recordMissing(): void;
  deleteClip(id: ClipId): void;
  revealClips(): void;
  installGsi(): void;
  chooseFolder(): void;
  copy(text: string, label: string): void;
  captureHotkey(name: HotkeyName): void;
  clearHotkey(name: HotkeyName): void;
  exportVoicePack(): void;
  importVoicePack(): void;
}

export interface Ctx {
  settings: Settings;
  clock: number;
  match: MatchState;
  gsi: GsiStatus | null;
  engine: CallEngine;
  flags: EngineFlags;
  clips: ClipIndex;
  speaking: { text: string; source: string } | null;
  sim: { active: boolean; playing: boolean };
  devices: { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] };
  lastPayload: GsiPayload | null;
  /** the hotkey slot currently waiting for a key press, if any */
  capturing: HotkeyName | null;
  t: Translate;
  actions: Actions;
}

const HOTKEY_LABELS: Record<HotkeyName, MessageKey> = {
  mute: 'audio.hotkeyMute',
  roshan: 'audio.hotkeyRoshan',
  palette: 'audio.hotkeyPalette',
};

const NAV: { id: ScreenId; key: MessageKey }[] = [
  { id: 'live', key: 'nav.live' },
  { id: 'panel', key: 'nav.panel' },
  { id: 'timers', key: 'nav.timers' },
  { id: 'role', key: 'nav.role' },
  { id: 'audio', key: 'nav.audio' },
  { id: 'gsi', key: 'nav.gsi' },
  { id: 'idle', key: 'nav.idle' },
];

const label = (text: string): HTMLElement => h('div.label', { text });
const panelHead = (text: string, ...extra: HTMLElement[]): HTMLElement =>
  h('div.panel__head', {}, text, ...extra);

function isNight(ctx: Ctx): boolean {
  if (ctx.match.inMatch) return !ctx.match.daytime;
  return Math.floor(Math.max(0, ctx.clock) / 300) % 2 === 1;
}

function flipIn(clock: number): number {
  const next = (Math.floor(Math.max(0, clock) / 300) + 1) * 300;
  return next - clock;
}

function suppressionReason(ctx: Ctx): string | null {
  if (ctx.flags.muted) return ctx.t('live.silentMute');
  if (ctx.flags.paused) return ctx.t('live.silentPaused');
  if (ctx.flags.dead) return ctx.t('live.silentDead');
  if (ctx.flags.fight) return ctx.t('live.silentFight');
  return null;
}

// ── sidebar ───────────────────────────────────────────────────────────────

export function renderSidebar(root: HTMLElement, ctx: Ctx): void {
  const { settings, actions, t } = ctx;
  const connected = ctx.gsi?.listening && ctx.match.connected;

  mount(
    root,
    h('div.sidebar__head', { text: t('nav.screens') }),
    h(
      'div.nav',
      {},
      NAV.map((item) =>
        h('div.nav__item', {
          text: t(item.key),
          class: settings.screen === item.id ? 'nav__item--active' : '',
          onClick: () => actions.setScreen(item.id),
        }),
      ),
    ),
    h(
      'div.sim',
      {},
      label(t('sidebar.simulation')),
      h(
        'div.sim__row',
        {},
        h('button.btn', {
          text: t(ctx.sim.active && ctx.sim.playing ? 'sidebar.pause' : 'sidebar.play'),
          class: ctx.sim.active ? 'btn--on' : '',
          onClick: () => actions.toggleSim(),
        }),
        h('button.btn', { text: t('sidebar.skip'), onClick: () => actions.simSkip(30) }),
      ),
      h('button.btn', {
        text: settings.muted
          ? t('sidebar.muted', { key: settings.hotkeys.mute ?? '—' })
          : t('sidebar.audioOn', { key: settings.hotkeys.mute ?? '—' }),
        class: settings.muted ? 'btn--alert' : '',
        onClick: () => actions.toggleMute(),
      }),
      h('div.hint', {
        html: [
          t('sidebar.globalToggle', { key: settings.hotkeys.mute ?? '—' }),
          t('sidebar.roshan', { key: settings.hotkeys.roshan ?? '—' }),
          t('sidebar.palette', { key: settings.hotkeys.palette ?? '—' }),
        ].join('<br />'),
      }),
    ),
    h(
      'div.sidebar__foot',
      {},
      `GSI ${ctx.gsi?.host ?? '127.0.0.1'}:${ctx.gsi?.port ?? 3000}`,
      h('br'),
      h('span', {
        class: connected ? 'dot' : 'dot--off',
        text: t(connected ? 'sidebar.connected' : ctx.gsi?.listening ? 'sidebar.waiting' : 'sidebar.offline'),
      }),
    ),
  );
}

// ── 01 live ───────────────────────────────────────────────────────────────

function liveScreen(ctx: Ctx): HTMLElement {
  const { actions, engine, flags, clock, t } = ctx;
  const queue = engine.queue(clock, flags, 5);
  const next = queue[0];
  const suppressed = suppressionReason(ctx);
  const spoken = engine.spokenInWindow(clock);

  return h(
    'div',
    {},
    h(
      'div.topbar',
      {},
      h('div.topbar__cell.topbar__cell--strong', { text: t('live.role', { role: ctx.settings.role }) }),
      h('div.topbar__cell', {
        text: t('live.mode', { mode: t(ctx.settings.verbose ? 'live.verbose' : 'live.dry') }),
      }),
      h('div.topbar__cell.topbar__spacer', {}),
      h('button.toggle', {
        text: t('live.dead'),
        class: flags.dead ? 'toggle--on' : '',
        onClick: () => actions.toggleDead(),
      }),
      h('button.toggle', {
        text: t('live.fight'),
        class: flags.fight ? 'toggle--on' : '',
        onClick: () => actions.toggleFight(),
      }),
      h('div.toggle', { text: t('live.paused'), class: flags.paused ? 'toggle--on' : '' }),
    ),

    h(
      'div.grid2.grid2--rule.split',
      {},
      h(
        'div.pad',
        {},
        label(t('live.clock')),
        h('div.clock', { text: mmss(clock) }),
        h(
          'div.daynight',
          {},
          h('div.tag', { text: t(isNight(ctx) ? 'live.night' : 'live.day') }),
          h('div.muted-note', { text: t('live.flipIn', { time: mmss(flipIn(clock)) }) }),
          ctx.match.inMatch && !ctx.match.alive
            ? h('div.muted-note', { text: t('live.respawn', { time: mmss(ctx.match.respawnSeconds) }) })
            : null,
        ),
      ),
      h(
        'div.pad.next',
        {},
        h(
          'div',
          {},
          label(t('live.nextCall')),
          h('div.next__label', { text: next ? next.label : '—' }),
          h('div.next__meta', {
            text: next
              ? t('live.speaksIn', {
                  in: mmss(next.inSeconds),
                  at: mmss(next.fireAt),
                  priority: next.priority,
                })
              : t('live.nothingScheduled'),
          }),
        ),
        ctx.speaking && !suppressed
          ? h('div.speaking', { text: `▶ ${ctx.speaking.text}` })
          : null,
        suppressed ? h('div.silent', { text: t('live.silent', { reason: suppressed }) }) : null,
      ),
    ),

    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        panelHead(t('live.queue')),
        queue.length
          ? queue.map((item) =>
              h(
                'div.row',
                {},
                h('div.row__p', { text: `P${item.priority}` }),
                h('div.row__label', { text: item.label }),
                h('div.row__meta', { text: item.roles }),
                h('div.row__time', { text: mmss(item.inSeconds) }),
              ),
            )
          : h('div.empty', { text: t('live.nothingInRange') }),
        h(
          'div.budget',
          {},
          h('div', { class: 'label', text: t('live.budget') }),
          h(
            'div.budget__bar',
            {},
            Array.from({ length: Math.max(1, ctx.settings.budget) }, (_, i) =>
              h('div.budget__cell', { class: i < spoken ? 'budget__cell--on' : '' }),
            ),
          ),
          h('div', { style: 'font-size:11px;font-weight:700', text: `${spoken}/${ctx.settings.budget}` }),
        ),
      ),
      h(
        'div',
        {},
        panelHead(t('live.log')),
        engine.getLog().length
          ? engine.getLog().slice(0, 8).map((entry) =>
              h(
                'div.row',
                {},
                h('div.row__meta', { style: 'width:44px;font-variant-numeric:tabular-nums', text: entry.at }),
                h('div.row__label', { style: 'font-size:13px', text: entry.label }),
                h('div.state', {
                  class: entry.state === 'SPOKEN' ? 'state--spoken' : '',
                  text: t(`log.${entry.state}`),
                }),
              ),
            )
          : h('div.empty', { text: t('live.noCalls') }),
      ),
    ),
  );
}

// ── 02 role panel ─────────────────────────────────────────────────────────

function panelScreen(ctx: Ctx): HTMLElement {
  const { match, settings, clock, t } = ctx;
  const phase = phaseFor(Math.max(0, clock));
  const locale = settings.voiceLocale;
  const next = ctx.engine.queue(clock, ctx.flags, 1)[0];

  const discipline: { text: string; bad: boolean }[] = [];
  if (match.inMatch) {
    discipline.push({
      text: match.lastSentryPlacedAt === null
        ? t('panel.noSentryYet')
        : t('panel.lastSentry', { time: mmss(match.lastSentryPlacedAt) }),
      bad: match.lastSentryPlacedAt === null || clock - match.lastSentryPlacedAt > 180,
    });
    discipline.push({
      text: match.smokes ? t('panel.smoke', { count: match.smokes }) : t('panel.noSmoke'),
      bad: !match.smokes,
    });
    discipline.push({
      text: t(match.observers === 1 ? 'panel.observerOne' : 'panel.observerMany', {
        count: match.observers,
      }),
      bad: match.observers === 0,
    });
    discipline.push({
      text: t(match.hasTp ? 'panel.tpOk' : 'panel.noTp'),
      bad: !match.hasTp,
    });
    discipline.push({
      text: match.buybackCost > 0 && match.gold < match.buybackCost
        ? t('panel.noBuyback', { gold: match.gold, cost: match.buybackCost })
        : t('panel.buybackOk', { gold: match.gold, cost: match.buybackCost || '—' }),
      bad: match.buybackCost > 0 && match.gold < match.buybackCost,
    });
  }

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: t('panel.title') }),
      h('div.screen__sub', { text: t('panel.sub') }),
    ),
    h(
      'div.topbar',
      {},
      PHASES.map((p) =>
        h('div.topbar__cell', {
          text: t(p.labelKey),
          style: 'flex:1',
          class: p.id === phase ? 'topbar__cell--strong' : '',
          ...(p.id === phase ? { } : {}),
        }),
      ),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        panelHead(t('panel.discipline')),
        discipline.length
          ? discipline.map((item) =>
              h('div.row', {}, h('div.row__label', {
                text: item.text,
                style: item.bad ? 'color:var(--alert)' : '',
              })),
            )
          : h('div.empty', { text: t('panel.waitingMatch') }),
      ),
      h(
        'div',
        {},
        panelHead(t('panel.phaseFocus', { role: settings.role })),
        h('div', {
          style: 'padding:18px;font-size:16px;line-height:1.5;text-wrap:pretty',
          text: PHASE_FOCUS[settings.role][phase][locale],
        }),
        h(
          'div',
          { style: 'border-top:2px solid var(--ink);padding:18px;display:flex;flex-direction:column;gap:10px' },
          label(t('panel.nextWindow')),
          h('div', {
            style: "font-family:var(--display);font-size:38px;line-height:1",
            text: next ? `${next.label} · ${mmss(next.fireAt + 0)}` : '—',
          }),
        ),
      ),
    ),
  );
}

// ── 03 manual timers ──────────────────────────────────────────────────────

function timersScreen(ctx: Ctx): HTMLElement {
  const { engine, actions, clock, settings, t } = ctx;
  const mark = engine.getRoshanMark();
  const roshan = engine.getTimers().filter((t) => t.source === 'roshan');
  const manual = engine.getTimers().filter((t) => t.source === 'palette');

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: t('timers.title') }),
      h('div.screen__sub', { text: t('timers.sub') }),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      { style: 'grid-template-columns:1.1fr 1fr' },
      h(
        'div',
        {},
        panelHead(t('timers.roshanChain')),
        h(
          'div',
          { style: 'padding:20px 18px' },
          h('button.btn', {
            style: 'width:100%;border-width:4px;padding:16px;font-family:var(--display);font-size:24px',
            class: mark === null ? '' : 'btn--on',
            text: mark === null ? t('timers.start') : t('timers.killed', { time: mmss(mark) }),
            onClick: () => actions.markRoshan(),
          }),
          h('div.hint', {
            style: 'margin-top:8px;text-align:center',
            text: t('timers.remap', { key: settings.hotkeys.roshan ?? '—' }),
          }),
          h(
            'div',
            { style: 'margin-top:20px' },
            roshan.length
              ? roshan.map((timer) =>
                  h(
                    'div.row',
                    { style: 'padding-left:0;padding-right:0' },
                    h('div.row__p', { text: `P${timer.priority}` }),
                    h('div.row__label', { text: timer.label }),
                    h('div.row__time', { text: mmss(timer.endsAt - clock) }),
                  ),
                )
              : h('div.empty', { style: 'padding-left:0', text: t('timers.noRoshan') }),
          ),
        ),
      ),
      h(
        'div',
        {},
        panelHead(t('timers.palette', { key: settings.hotkeys.palette ?? '—' })),
        h(
          'div',
          { style: 'padding:20px 18px' },
          h(
            'div.palette',
            { style: 'width:auto' },
            h('div.palette__hint', { text: t('timers.paletteHint') }),
            PALETTE.map((entry) =>
              h(
                'div.palette__row',
                {},
                h('div.palette__code', { text: entry.code }),
                h('div.palette__label', { text: entry.label[settings.voiceLocale] }),
              ),
            ),
          ),
          h('div.label', { style: 'margin-top:20px;margin-bottom:10px', text: t('timers.active') }),
          manual.length
            ? manual.map((timer) =>
                h(
                  'div.row',
                  { style: 'padding-left:0;padding-right:0' },
                  h('div.row__label', { text: timer.label }),
                  h('div.row__time', { text: mmss(timer.endsAt - clock) }),
                  h('button.icon.icon--ghost', {
                    text: '✕',
                    onClick: () => actions.removeTimer(timer.key),
                  }),
                ),
              )
            : h('div.empty', { style: 'padding-left:0', text: t('timers.noManual') }),
          ctx.match.inMatch && !ctx.match.alive
            ? h(
                'div.row',
                { style: 'padding-left:0;padding-right:0' },
                h('div.row__label', { text: t('timers.myRespawn') }),
                h('div.row__time', { text: mmss(ctx.match.respawnSeconds) }),
              )
            : null,
        ),
      ),
    ),
  );
}

// ── 04 call set ───────────────────────────────────────────────────────────

function roleScreen(ctx: Ctx): HTMLElement {
  const { settings, actions, t } = ctx;
  const inSet = EVENTS.filter((e) => eventAppliesToRole(e.roles, settings.role));
  const outOfSet = EVENTS.filter((e) => !eventAppliesToRole(e.roles, settings.role));

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: t('role.title') }),
      h('div.screen__sub', { text: t('role.sub') }),
    ),
    h(
      'div.topbar',
      {},
      ROLES.map((role) =>
        h(
          'div.topbar__cell',
          {
            style: `flex:1;cursor:pointer;${
              settings.role === role.id ? 'background:var(--ink);color:var(--acid)' : ''
            }`,
            onClick: () => actions.patch({ role: role.id }),
          },
          h('div', { style: 'font-family:var(--display);font-size:26px;line-height:1', text: role.id }),
          h('div', {
            style: 'font-size:10px;letter-spacing:0.14em;margin-top:6px',
            text: role.name[settings.voiceLocale],
          }),
        ),
      ),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        panelHead(t('role.inSet', { role: settings.role })),
        // Scheduled events first, then the ones raised by reading the live
        // state — those have no clock window, but must be silenceable too.
        [
          ...inSet.map((event) => ({
            id: event.id,
            label: event.label,
            when: event.kind === 'absolute'
              ? t('role.at', { time: mmss(event.at) })
              : `${mmss(event.window[0])}–${mmss(event.window[1])}`,
          })),
          ...Object.values(STATE_CALLS).map((call) => ({
            id: call.id,
            label: call.label,
            when: t('role.fromState'),
          })),
        ].map((event) => {
          const muted = settings.mutedEvents.includes(event.id);
          return h(
            'div.row.row--center',
            { class: muted ? 'row--dim' : '' },
            h('div', {
              class: muted ? 'box box--off' : 'box',
              style: 'cursor:pointer',
              onClick: () =>
                actions.patch({
                  mutedEvents: muted
                    ? settings.mutedEvents.filter((id) => id !== event.id)
                    : [...settings.mutedEvents, event.id],
                }),
            }),
            h('div.row__label', { text: event.label }),
            h('div.row__meta', { text: event.when }),
          );
        }),
      ),
      h(
        'div',
        {},
        panelHead(t('role.muted')),
        outOfSet.length
          ? outOfSet.map((event) =>
              h(
                'div.row.row--center.row--dim',
                {},
                h('div.box.box--off'),
                h('div.row__label', { text: event.label }),
              ),
            )
          : h('div.empty', { text: t('role.hearsEverything') }),
        h('div.note', { text: t('role.note') }),
      ),
    ),
  );
}

// ── 05 audio ──────────────────────────────────────────────────────────────

function clipRow(ctx: Ctx, clip: { id: ClipId }, locale: Locale): HTMLElement {
  const meta = ctx.clips[clip.id];
  const text = CLIPS.find((c) => c.id === clip.id)?.text[locale];
  const spoken = ctx.settings.verbose ? text?.verbose : text?.dry;

  return h(
    'div.clip',
    {},
    h('button.icon', { text: '▶', title: ctx.t('audio.listen'), onClick: () => ctx.actions.previewClip(clip.id) }),
    h(
      'div.clip__id',
      {},
      h('div.clip__name', { text: clip.id }),
      h('div.clip__text', { text: spoken ?? '' }),
    ),
    h('div.clip__len', {
      text: meta ? (meta.durationMs ? `${(meta.durationMs / 1000).toFixed(1)}s` : 'ok') : ctx.t('audio.tts'),
      style: meta ? '' : 'color:var(--grey)',
    }),
    h('button.icon.icon--rec', {
      text: '●',
      title: ctx.t(meta ? 'audio.rerecord' : 'audio.record'),
      onClick: () => ctx.actions.recordClip(clip.id),
    }),
    meta
      ? h('button.icon.icon--ghost', {
          text: '✕',
          title: ctx.t('audio.deleteClip'),
          onClick: () => ctx.actions.deleteClip(clip.id),
        })
      : null,
  );
}

function audioScreen(ctx: Ctx): HTMLElement {
  const { settings, actions, t } = ctx;
  const volumeCells = 16;
  const filled = Math.round(settings.volume * volumeCells);
  const recorded = CLIPS.filter((c) => ctx.clips[c.id]).length;

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: t('audio.title') }),
      h('div.screen__sub', { text: t('audio.recorded', { done: recorded, total: CLIPS.length }) }),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div.stack',
        {},
        h(
          'div',
          {},
          label(t('audio.volume')),
          h(
            'div.meter',
            {},
            Array.from({ length: volumeCells }, (_, i) =>
              h('div.meter__cell', {
                class: i < filled ? 'meter__cell--on' : '',
                style: `height:${12 + i * 2}px`,
                onClick: () => actions.patch({ volume: (i + 1) / volumeCells }),
              }),
            ),
          ),
          h('div', {
            style: 'font-size:12px;font-weight:700;margin-top:8px',
            text: `${Math.round(settings.volume * 100)}%`,
          }),
        ),
        h(
          'div',
          {},
          label(t('audio.verbosity')),
          h(
            'div.choices',
            {},
            h('button.choice', {
              style: 'flex:1',
              text: t('audio.dry'),
              class: settings.verbose ? '' : 'choice--on',
              onClick: () => actions.patch({ verbose: false }),
            }),
            h('button.choice', {
              style: 'flex:1',
              text: t('audio.verbose'),
              class: settings.verbose ? 'choice--on' : '',
              onClick: () => actions.patch({ verbose: true }),
            }),
          ),
        ),
        h(
          'div',
          {},
          label(t('audio.budget')),
          h(
            'div.choices',
            {},
            [2, 3, 4, 6, 8].map((n) =>
              h('button.choice.choice--num', {
                text: String(n),
                class: settings.budget === n ? 'choice--on' : '',
                onClick: () => actions.patch({ budget: n }),
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label(t('audio.voiceLocale')),
          h(
            'div.choices',
            {},
            (['pt-BR', 'en'] as Locale[]).map((locale) =>
              h('button.choice', {
                text: locale.toUpperCase(),
                class: settings.voiceLocale === locale ? 'choice--on' : '',
                onClick: () => actions.patch({ voiceLocale: locale }),
              }),
            ),
            h('button.choice', {
              text: t(settings.ttsFallback ? 'audio.ttsOn' : 'audio.ttsOff'),
              class: settings.ttsFallback ? 'choice--on' : '',
              onClick: () => actions.patch({ ttsFallback: !settings.ttsFallback }),
            }),
          ),
        ),
        h(
          'div',
          {},
          label(t('audio.uiLanguage')),
          h(
            'div.choices',
            {},
            UI_LANGUAGES.map((language) =>
              h('button.choice', {
                text: language.toUpperCase(),
                class: settings.uiLanguage === language ? 'choice--on' : '',
                onClick: () => actions.patch({ uiLanguage: language }),
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label(t('overlay.title')),
          h('div.hint', { style: 'margin-bottom:8px', text: t('overlay.hint') }),
          h(
            'div.choices',
            {},
            h('button.choice', {
              text: t(settings.overlayEnabled ? 'overlay.on' : 'overlay.off'),
              class: settings.overlayEnabled ? 'choice--on' : '',
              onClick: () => actions.patch({ overlayEnabled: !settings.overlayEnabled }),
            }),
            h('button.choice', {
              text: t(settings.startWithWindows ? 'startup.on' : 'startup.off'),
              class: settings.startWithWindows ? 'choice--on' : '',
              onClick: () => actions.patch({ startWithWindows: !settings.startWithWindows }),
            }),
          ),
        ),
        h(
          'div',
          {},
          label(t('voicepack.title')),
          h('div.hint', { style: 'margin-bottom:8px', text: t('voicepack.hint') }),
          h(
            'div.choices',
            {},
            h('button.choice', { text: t('voicepack.export'), onClick: () => actions.exportVoicePack() }),
            h('button.choice', { text: t('voicepack.import'), onClick: () => actions.importVoicePack() }),
          ),
        ),
        h(
          'div',
          {},
          label(t('audio.output')),
          h(
            'select.select',
            {
              onChange: (event) =>
                actions.patch({ outputDeviceId: (event.target as HTMLSelectElement).value }),
            },
            h('option', { attrs: { value: 'default' }, text: t('audio.systemDefault') }),
            ctx.devices.outputs.map((device) =>
              h('option', {
                attrs: { value: device.deviceId, selected: settings.outputDeviceId === device.deviceId },
                text: device.label || device.deviceId,
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label(t('audio.hotkeys')),
          h('div.hint', { style: 'margin-bottom:8px', text: t('audio.hotkeysHint') }),
          (Object.keys(HOTKEY_LABELS) as HotkeyName[]).map((name) =>
            h(
              'div.row.row--center',
              { style: 'padding-left:0;padding-right:0' },
              h('div.row__label', { text: t(HOTKEY_LABELS[name]) }),
              h('button.choice', {
                text: ctx.capturing === name
                  ? t('audio.pressKey')
                  : (settings.hotkeys[name] ?? t('audio.noHotkey')),
                class: ctx.capturing === name ? 'choice--on' : '',
                onClick: () => actions.captureHotkey(name),
              }),
              h('button.icon.icon--ghost', {
                text: '✕',
                title: t('audio.removeHotkey'),
                onClick: () => actions.clearHotkey(name),
              }),
            ),
          ),
        ),
        h(
          'div',
          {},
          label(t('audio.microphone')),
          h(
            'select.select',
            {
              onChange: (event) =>
                actions.patch({ inputDeviceId: (event.target as HTMLSelectElement).value }),
            },
            h('option', { attrs: { value: 'default' }, text: t('audio.systemDefault') }),
            ctx.devices.inputs.map((device) =>
              h('option', {
                attrs: { value: device.deviceId, selected: settings.inputDeviceId === device.deviceId },
                text: device.label || device.deviceId,
              }),
            ),
          ),
        ),
      ),
      h(
        'div',
        {},
        panelHead(
          t('audio.library', { locale: settings.voiceLocale }),
          h('button.btn.btn--tight', {
            text: t('audio.recordMissing'),
            onClick: () => actions.recordMissing(),
          }),
          h('button.btn.btn--tight', { text: t('audio.folder'), onClick: () => actions.revealClips() }),
        ),
        CLIPS.map((clip) => clipRow(ctx, clip, settings.voiceLocale)),
      ),
    ),
  );
}

// ── 06 gsi ────────────────────────────────────────────────────────────────

function gsiScreen(ctx: Ctx): HTMLElement {
  const { gsi, actions, t } = ctx;
  const connected = !!gsi?.lastPayloadAt && Date.now() - gsi.lastPayloadAt < 10_000;
  const since = gsi?.lastPayloadAt ? ((Date.now() - gsi.lastPayloadAt) / 1000).toFixed(1) : '—';

  const diagnostics: [string, string][] = [
    [t('gsi.listenAddress'), `${gsi?.host ?? '127.0.0.1'}:${gsi?.port ?? 3000}`],
    [t('gsi.authToken'), gsi?.token ? `${gsi.token.slice(0, 4)}…${gsi.token.slice(-4)}` : '—'],
    [t('gsi.payloads'), String(gsi?.payloads ?? 0)],
    [t('gsi.rejected'), String(gsi?.rejected ?? 0)],
    [t('gsi.avgResponse'), gsi?.avgMs ? `${gsi.avgMs.toFixed(1)} ms` : '—'],
    [t('gsi.reconnects'), String(gsi?.reconnects ?? 0)],
  ];

  return h(
    'div',
    {},
    h(
      'div.screen__head',
      {},
      h('div.screen__title', { text: t('gsi.title') }),
      h('div.screen__sub', { text: t('gsi.sub') }),
    ),
    h(
      'div.grid2.grid2--rule.fill',
      {},
      h(
        'div',
        {},
        h(
          'div.status',
          {},
          h('div', { class: connected ? 'status__lamp' : 'status__lamp status__lamp--off' }),
          h('div.status__title', {
            text: t(connected ? 'gsi.connected' : gsi?.listening ? 'gsi.waiting' : 'gsi.offline'),
          }),
          h('div', { style: 'flex:1' }),
          h('div.row__meta', {
            text: connected
              ? t('gsi.lastPayloadAgo', { seconds: since })
              : (gsi?.error ?? t('gsi.noPayloadYet')),
          }),
        ),
        h(
          'div',
          { style: 'padding:18px;display:flex;flex-direction:column;gap:18px' },
          h(
            'div',
            {},
            h('div.label', {
              style: 'margin-bottom:8px',
              text: t(gsi?.cfgInstalled ? 'gsi.step1Written' : 'gsi.step1Missing'),
            }),
            h('div.path', {
              text: gsi?.cfgDir
                ? `${gsi.cfgDir}\\gamestate_integration_callassistant.cfg`
                : t('gsi.notFound'),
            }),
            h(
              'div.choices',
              { style: 'margin-top:8px' },
              h('button.btn.btn--tight', {
                text: t(gsi?.cfgInstalled ? 'gsi.rewrite' : 'gsi.writeConfig'),
                onClick: () => actions.installGsi(),
              }),
              h('button.btn.btn--tight', { text: t('gsi.chooseFolder'), onClick: () => actions.chooseFolder() }),
            ),
          ),
          h(
            'div',
            {},
            h('div.label', { style: 'margin-bottom:8px', text: t('gsi.step2') }),
            h('div', {
              style: 'font-size:13px;line-height:1.5;margin-bottom:8px;text-wrap:pretty',
              text: t('gsi.step2Body'),
            }),
            h(
              'div.launch',
              {},
              h('div.launch__value', { text: '-gamestateintegration' }),
              h('button.launch__copy', {
                text: t('gsi.copy'),
                onClick: () => actions.copy('-gamestateintegration', t('toast.launchOption')),
              }),
            ),
          ),
          h(
            'div',
            {},
            h('div.label', { style: 'margin-bottom:8px', text: t('gsi.step3') }),
            h('div.hint', { text: t('gsi.step3Body') }),
          ),
        ),
      ),
      h(
        'div',
        {},
        panelHead(t('gsi.diagnostics')),
        diagnostics.map(([key, value]) =>
          h(
            'div.row',
            {},
            h('div', { style: 'flex:1;font-size:12px;letter-spacing:0.08em;color:var(--dark)', text: key }),
            h('div', { style: 'font-size:13px;font-weight:700', text: value }),
          ),
        ),
        h(
          'div',
          { style: 'padding:18px' },
          h('div.label', { style: 'margin-bottom:8px', text: t('gsi.lastPayload') }),
          h('div.payload', {
            text: ctx.lastPayload
              ? JSON.stringify(
                  { map: ctx.lastPayload.map, player: ctx.lastPayload.player, hero: ctx.lastPayload.hero },
                  null,
                  2,
                )
              : t('gsi.nothingYet'),
          }),
        ),
      ),
    ),
  );
}

// ── 07 idle ───────────────────────────────────────────────────────────────

function idleScreen(ctx: Ctx): HTMLElement {
  const { gsi, settings, t } = ctx;
  return h(
    'div.idle',
    {},
    h(
      'div.idle__body',
      {},
      h('div.idle__title', { html: t('idle.noMatch') }),
      h('div', {
        style: 'font-size:14px;letter-spacing:0.1em;color:var(--dark)',
        text: t('idle.listening', {
          address: `${gsi?.host ?? '127.0.0.1'}:${gsi?.port ?? 3000}`,
          state: t(gsi?.listening ? 'idle.idle' : 'gsi.offline'),
        }),
      }),
      h(
        'div.choices',
        { style: 'margin-top:6px' },
        h('div.tag', { text: t('live.role', { role: settings.role }) }),
        h('div.tag.tag--outline', { text: t(settings.verbose ? 'live.verbose' : 'live.dry') }),
        h('div.tag.tag--outline', { text: t('idle.budget', { n: settings.budget }) }),
      ),
    ),
    h(
      'div.idle__foot',
      {},
      h('div.hint', { html: t('idle.hotkeys') }),
      h('div.hint', { html: t('idle.privacy') }),
      h('div', { style: 'flex:1' }),
      h('div.hint', { html: t('idle.patch') }),
    ),
  );
}

// ── router ────────────────────────────────────────────────────────────────

export function renderScreen(root: HTMLElement, ctx: Ctx): void {
  const screens: Record<ScreenId, (c: Ctx) => HTMLElement> = {
    live: liveScreen,
    panel: panelScreen,
    timers: timersScreen,
    role: roleScreen,
    audio: audioScreen,
    gsi: gsiScreen,
    idle: idleScreen,
  };
  mount(root, screens[ctx.settings.screen](ctx));
}
