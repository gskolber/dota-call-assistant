// The map is mirrored but not symmetric: the gap between the safelane towers
// differs, so the second pull of the minute lands a second later on Dire.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CallEngine } from '../src/renderer/engine';
import { flags, ids, state } from './helpers';

/** Seconds within [from, to] at which `id` was spoken, for the given flags. */
function firesFor(id: string, over: Parameters<typeof flags>[0], from = 0, to = 200): number[] {
  const engine = new CallEngine();
  const seconds: number[] = [];
  for (let clock = from; clock <= to; clock += 1) {
    if (ids(engine.tick(clock, flags(over), state())).includes(id)) seconds.push(clock);
  }
  return seconds;
}

describe('the second pull follows the side you are on', () => {
  it('fires at :44 minus the lead on Radiant', () => {
    assert.deepEqual(firesFor('pull_second', { team: 'radiant' }), [98, 158]);
  });

  it('fires a second later on Dire, because the towers are further apart', () => {
    assert.deepEqual(firesFor('pull_second', { team: 'dire' }), [99, 159]);
  });

  it('falls back to the Radiant timing before a match tells us the side', () => {
    assert.deepEqual(firesFor('pull_second', { team: null }), [98, 158]);
  });

  it('leaves the first pull alone: that one is the same on both sides', () => {
    assert.deepEqual(firesFor('pull', { team: 'radiant' }), firesFor('pull', { team: 'dire' }));
  });
});

describe('the stack second is a setting, not a constant', () => {
  it('follows stackSecond rather than the catalogue value', () => {
    assert.deepEqual(firesFor('stack', { stackSecond: 53 }, 0, 300), [103, 163, 223, 283]);
    assert.deepEqual(firesFor('stack', { stackSecond: 55 }, 0, 300), [105, 165, 225, 285]);
    assert.deepEqual(firesFor('stack', { stackSecond: 50 }, 0, 300), [100, 160, 220, 280]);
  });

  it('shows the same second in the queue as it speaks at', () => {
    const engine = new CallEngine();
    const f = flags({ stackSecond: 56 });
    const item = engine.queue(0, f, 10).find((i) => i.id === 'stack');
    assert.equal(item?.fireAt, 106);
  });
});
