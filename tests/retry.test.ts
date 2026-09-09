// Regression tests for the rate limiters. A call that was raised but never
// heard used to serve its full cooldown in silence, and a manual timer that
// lost its single fire second was lost for good.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CallEngine } from '../src/renderer/engine';
import { flags, ids, state } from './helpers';

/**
 * Runs the clock from `from` to `to` and reports the seconds at which `id` was
 * spoken. The scheduled calls of the role are speaking the whole time, so a
 * test that does not filter ends up asserting about PULL and STACK instead.
 */
function secondsSpoken(
  engine: CallEngine,
  id: string,
  from: number,
  to: number,
  at: (clock: number) => { flags: ReturnType<typeof flags>; state: ReturnType<typeof state> },
): number[] {
  const seconds: number[] = [];
  for (let clock = from; clock <= to; clock += 1) {
    const step = at(clock);
    if (ids(engine.tick(clock, step.flags, step.state)).includes(id)) seconds.push(clock);
  }
  return seconds;
}

describe('a state call that was dropped comes back quickly', () => {
  const noTp = state({ hasTp: false });

  it('retries about eight seconds after a drop, not a full cooldown later', () => {
    const engine = new CallEngine();
    // NO TP is due from 2:01; a teamfight at that exact second drops it
    const spoken = secondsSpoken(engine, 'sem_tp', 121, 200, (clock) => ({
      flags: flags({ fight: clock === 121 }),
      state: noTp,
    }));

    assert.deepEqual(
      spoken,
      [129],
      'the dropped call should return ~8s later, not after the 120s cooldown',
    );
  });

  it('still serves the full cooldown once it has actually been heard', () => {
    const engine = new CallEngine();
    const spoken = secondsSpoken(engine, 'sem_tp', 121, 260, () => ({
      flags: flags(),
      state: noTp,
    }));

    assert.deepEqual(
      spoken,
      [121, 241],
      'a call that was heard must not repeat before its cooldown is up',
    );
  });

  it('logs the drop, so the silence stays explainable', () => {
    const engine = new CallEngine();
    engine.tick(121, flags({ fight: true }), noTp);

    const entry = engine.getLog()[0];
    assert.ok(entry, 'the dropped call should still be logged');
    assert.equal(entry.state, 'FIGHT');
  });
});

describe('a manual timer survives losing its fire second', () => {
  it('speaks a Roshan step that a one-second pause swallowed', () => {
    const engine = new CallEngine();
    engine.markRoshan(600);

    // AEGIS EXPIRES is due at 600 + 300 - 10 = 890; the game is paused there
    const spoken = secondsSpoken(engine, 'aegis_expira', 601, 910, (clock) => ({
      flags: flags({ paused: clock === 890 }),
      state: state(),
    }));

    assert.equal(spoken.length, 1, 'it should be spoken exactly once');
    assert.ok(
      spoken[0] !== undefined && spoken[0] > 890 && spoken[0] <= 898,
      `expected the call inside the grace window, got ${String(spoken[0])}`,
    );
  });

  it('does not repeat a timer that was heard the first time', () => {
    const engine = new CallEngine();
    engine.markRoshan(600);
    const spoken = secondsSpoken(engine, 'aegis_expira', 601, 910, () => ({
      flags: flags(),
      state: state(),
    }));

    assert.deepEqual(spoken, [890]);
  });

  it('gives up once the grace window closes, rather than calling it late', () => {
    const engine = new CallEngine();
    engine.markRoshan(600);

    const spoken = secondsSpoken(engine, 'aegis_expira', 601, 910, (clock) => ({
      flags: flags({ muted: clock <= 899 }),
      state: state(),
    }));

    assert.deepEqual(spoken, [], 'a call this stale is worse than no call');
  });
});

describe('a silenced manual timer stays silent', () => {
  it('honours mutedEvents for the Roshan chain', () => {
    const engine = new CallEngine();
    engine.markRoshan(600);
    const muted = flags({ mutedEvents: ['aegis_expira'] });

    const spoken = secondsSpoken(engine, 'aegis_expira', 601, 910, () => ({
      flags: muted,
      state: state(),
    }));
    assert.deepEqual(spoken, []);
    assert.ok(
      !engine.queue(880, muted, 5).some((item) => item.id === 'aegis_expira'),
      'a muted timer should not sit in the queue either',
    );
  });
});

describe('no buyback is about more than gold', () => {
  it('calls it while the buyback cooldown runs, however rich you are', () => {
    const engine = new CallEngine();
    const rich = state({ gold: 99999, buybackCost: 1200, buybackCooldown: 180 });

    const spoken = secondsSpoken(engine, 'sem_buyback', 1201, 1210, () => ({
      flags: flags(),
      state: rich,
    }));

    assert.deepEqual(spoken, [1201], 'gold you cannot spend is not a buyback');
  });

  it('stays quiet once the cooldown is over and the gold is there', () => {
    const engine = new CallEngine();
    const ready = state({ gold: 99999, buybackCost: 1200, buybackCooldown: 0 });

    const spoken = secondsSpoken(engine, 'sem_buyback', 1201, 1400, () => ({
      flags: flags(),
      state: ready,
    }));

    assert.deepEqual(spoken, []);
  });
});
