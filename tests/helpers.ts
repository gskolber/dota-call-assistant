import assert from 'node:assert/strict';

import type { EngineFlags, StateInputs } from '../src/renderer/engine';
import type { RoleId } from '../src/shared/types';

/**
 * Flags with every suppression off and a budget high enough that it never
 * interferes; each test overrides only what it is actually about.
 */
export function flags(over: Partial<EngineFlags> = {}): EngineFlags {
  return {
    role: 'POS 5',
    budget: 99,
    muted: false,
    dead: false,
    fight: false,
    paused: false,
    mutedEvents: [],
    ...over,
  };
}

/** State that raises no state call: alive, rich, carrying a TP. */
export function state(over: Partial<StateInputs> = {}): StateInputs {
  return { gold: 99999, buybackCost: 1200, hasTp: true, alive: true, ...over };
}

export const ROLES: RoleId[] = ['POS 1', 'POS 2', 'POS 3', 'POS 4', 'POS 5'];

/** Ids of whatever `tick` decided to speak. */
export function ids(calls: { id: string }[]): string[] {
  return calls.map((c) => c.id);
}

/** Indexed access that fails the test instead of handing back `undefined`. */
export function at<T>(xs: readonly T[], index: number): T {
  const item = xs[index];
  assert.ok(item, `expected an entry at index ${index}, got none`);
  return item;
}
