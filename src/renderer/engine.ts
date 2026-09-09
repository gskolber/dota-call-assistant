import {
  EVENTS, PALETTE, ROSHAN_CHAIN, STATE_CALLS,
  eventAppliesToRole, mmss,
  type CallText, type PaletteEntry, type ScheduledEvent,
} from '../shared/catalog';
import type { ClipId, Locale, Priority, RoleId } from '../shared/types';

export type DropReason = 'MUTED' | 'DEAD' | 'FIGHT' | 'BUDGET' | 'DROPPED' | 'PAUSED';
export type LogState = 'SPOKEN' | DropReason;

export interface Call {
  id: string;
  label: string;
  priority: Priority;
  clip: ClipId;
  text: Record<Locale, CallText>;
  /** Roshan calls survive death - you need them most while you are dead. */
  ignoresDeath?: boolean;
}

export interface LogEntry {
  clock: number;
  at: string;
  label: string;
  priority: Priority;
  state: LogState;
}

export interface QueueItem {
  id: string;
  label: string;
  priority: Priority;
  roles: string;
  /** clock second the call is spoken at */
  fireAt: number;
  /** seconds from now until it is spoken */
  inSeconds: number;
}

export interface ActiveTimer {
  key: string;
  id: string;
  label: string;
  /** clock second the thing itself happens */
  endsAt: number;
  lead: number;
  priority: Priority;
  clip: ClipId;
  text: Record<Locale, CallText>;
  source: 'roshan' | 'palette';
  spoken: boolean;
}

export interface EngineFlags {
  role: RoleId;
  budget: number;
  muted: boolean;
  /** player is dead - either read from GSI or forced from the UI */
  dead: boolean;
  /** manual "we are fighting, shut up unless it is critical" toggle */
  fight: boolean;
  paused: boolean;
  mutedEvents: string[];
}

export interface StateInputs {
  gold: number;
  buybackCost: number;
  hasTp: boolean;
  alive: boolean;
}

/** How far back the per-minute call budget looks. */
const BUDGET_WINDOW = 60;

/** Only one call is ever spoken per second; the rest of the tick is dropped. */
export class CallEngine {
  private log: LogEntry[] = [];
  private timers: ActiveTimer[] = [];
  private roshanMark: number | null = null;
  private lastStateCall = new Map<string, number>();
  private spokenAt: number[] = [];

  reset(): void {
    this.log = [];
    this.timers = [];
    this.roshanMark = null;
    this.lastStateCall.clear();
    this.spokenAt = [];
  }

  getLog(): readonly LogEntry[] {
    return this.log;
  }

  getTimers(): readonly ActiveTimer[] {
    return this.timers;
  }

  getRoshanMark(): number | null {
    return this.roshanMark;
  }

  spokenInWindow(now: number): number {
    return this.spokenAt.filter((t) => now - t < BUDGET_WINDOW).length;
  }

  // ── manual marks ────────────────────────────────────────────────────────

  markRoshan(clock: number): void {
    this.roshanMark = clock;
    this.timers = this.timers.filter((t) => t.source !== 'roshan');
    for (const step of ROSHAN_CHAIN) {
      this.timers.push({
        key: `roshan:${step.id}`,
        id: step.id,
        label: step.label,
        endsAt: clock + step.offset,
        lead: step.lead,
        priority: step.priority,
        clip: step.clip,
        text: step.text,
        source: 'roshan',
        spoken: false,
      });
    }
  }

  clearRoshan(): void {
    this.roshanMark = null;
    this.timers = this.timers.filter((t) => t.source !== 'roshan');
  }

  addPaletteTimer(entry: PaletteEntry, clock: number, locale: Locale): void {
    this.timers = this.timers.filter((t) => t.key !== `palette:${entry.id}`);
    this.timers.push({
      key: `palette:${entry.id}`,
      id: entry.id,
      label: entry.label[locale],
      endsAt: clock + entry.seconds,
      lead: entry.lead,
      priority: entry.priority,
      clip: entry.clip,
      text: entry.text,
      source: 'palette',
      spoken: false,
    });
  }

  removeTimer(key: string): void {
    this.timers = this.timers.filter((t) => t.key !== key);
  }

  // ── scheduling ──────────────────────────────────────────────────────────

  private occursAt(event: ScheduledEvent, clock: number): boolean {
    if (event.kind === 'absolute') return clock === event.at;
    const [from, to] = event.window;
    if (clock < from || clock > to || clock < event.at) return false;
    return (clock - event.at) % event.every === 0;
  }

  private enabled(event: ScheduledEvent, flags: EngineFlags): boolean {
    return eventAppliesToRole(event.roles, flags.role) && !flags.mutedEvents.includes(event.id);
  }

  /**
   * Next occurrence of `event` whose call has not been spoken yet, i.e. one
   * whose fire time is still ahead. Without the lead check a call would linger
   * in the queue for the second after it fired.
   */
  private nextOccurrence(event: ScheduledEvent, clock: number): number | null {
    if (event.kind === 'absolute') {
      return event.at - event.lead > clock ? event.at : null;
    }
    const [from, to] = event.window;
    const start = Math.max(clock + 1, from);
    for (let t = start; t <= Math.min(to, clock + 1800); t += 1) {
      if (this.occursAt(event, t) && t - event.lead > clock) return t;
    }
    return null;
  }

  /** Upcoming calls, soonest first, for the live queue panel. */
  queue(clock: number, flags: EngineFlags, limit = 5): QueueItem[] {
    const items: QueueItem[] = [];

    for (const event of EVENTS) {
      if (!this.enabled(event, flags)) continue;
      const occurrence = this.nextOccurrence(event, clock);
      if (occurrence === null) continue;
      const fireAt = occurrence - event.lead;
      items.push({
        id: event.id,
        label: event.label,
        priority: event.priority,
        roles: event.roles === 'ALL' ? 'ALL' : event.roles.join(' '),
        fireAt,
        inSeconds: Math.max(0, fireAt - clock),
      });
    }

    for (const timer of this.timers) {
      const fireAt = timer.endsAt - timer.lead;
      if (fireAt <= clock) continue;
      items.push({
        id: timer.id,
        label: timer.label,
        priority: timer.priority,
        roles: timer.source === 'roshan' ? 'ROSHAN' : 'MANUAL',
        fireAt,
        inSeconds: Math.max(0, fireAt - clock),
      });
    }

    return items
      .sort((a, b) => a.fireAt - b.fireAt || b.priority - a.priority)
      .slice(0, limit);
  }

  // ── the tick ────────────────────────────────────────────────────────────

  /**
   * Advance to `clock` and return whatever should be spoken right now.
   * Everything considered is written to the log, spoken or not, so the user
   * can see why the app stayed quiet.
   */
  tick(clock: number, flags: EngineFlags, state: StateInputs): Call[] {
    const due: Call[] = [];

    for (const event of EVENTS) {
      if (!this.enabled(event, flags)) continue;
      if (this.occursAt(event, clock + event.lead)) {
        due.push({
          id: event.id,
          label: event.label,
          priority: event.priority,
          clip: event.clip,
          text: event.text,
        });
      }
    }

    for (const timer of this.timers) {
      if (timer.spoken || clock !== timer.endsAt - timer.lead) continue;
      timer.spoken = true;
      due.push({
        id: timer.id,
        label: timer.label,
        priority: timer.priority,
        clip: timer.clip,
        text: timer.text,
        ignoresDeath: timer.source === 'roshan',
      });
    }

    // timers that have run out stop cluttering the panel
    this.timers = this.timers.filter((t) => t.endsAt > clock);

    due.push(...this.stateCalls(clock, flags, state));

    due.sort((a, b) => b.priority - a.priority);
    return this.applyBudget(clock, due, flags);
  }

  /** Calls raised by reading the live state instead of the clock. */
  private stateCalls(clock: number, flags: EngineFlags, state: StateInputs): Call[] {
    const out: Call[] = [];

    const raise = (call: typeof STATE_CALLS[keyof typeof STATE_CALLS], condition: boolean): void => {
      if (!condition || flags.mutedEvents.includes(call.id)) return;
      const last = this.lastStateCall.get(call.id);
      if (last !== undefined && clock - last < call.cooldown) return;
      this.lastStateCall.set(call.id, clock);
      out.push({ id: call.id, label: call.label, priority: call.priority, clip: call.clip, text: call.text });
    };

    raise(
      STATE_CALLS.sem_buyback,
      clock > 1200 && state.alive && state.buybackCost > 0 && state.gold < state.buybackCost,
    );
    raise(
      STATE_CALLS.sem_tp,
      clock > 120 && state.alive && !state.hasTp,
    );

    return out;
  }

  private applyBudget(clock: number, due: Call[], flags: EngineFlags): Call[] {
    const spoken: Call[] = [];
    const alreadySpoken = this.spokenInWindow(clock);

    for (const call of due) {
      const drop = this.dropReason(call, flags, alreadySpoken + spoken.length, spoken.length > 0);
      this.log.unshift({
        clock,
        at: mmss(clock),
        label: call.label,
        priority: call.priority,
        state: drop ?? 'SPOKEN',
      });
      if (!drop) spoken.push(call);
    }

    this.log = this.log.slice(0, 40);
    for (const _ of spoken) this.spokenAt.push(clock);
    this.spokenAt = this.spokenAt.filter((t) => clock - t < BUDGET_WINDOW * 2);

    return spoken;
  }

  private dropReason(
    call: Call,
    flags: EngineFlags,
    spokenThisWindow: number,
    collided: boolean,
  ): DropReason | null {
    if (flags.muted) return 'MUTED';
    if (flags.paused) return 'PAUSED';
    if (flags.dead && !call.ignoresDeath) return 'DEAD';
    if (flags.fight && call.priority < 5) return 'FIGHT';
    if (spokenThisWindow >= flags.budget && call.priority < 4) return 'BUDGET';
    if (collided) return 'DROPPED';
    return null;
  }
}

export function paletteByCode(code: string): PaletteEntry | undefined {
  return PALETTE.find((entry) => entry.code === code.toUpperCase());
}
