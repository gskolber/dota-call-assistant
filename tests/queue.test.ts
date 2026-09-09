import assert from 'node:assert/strict';
import test from 'node:test';

import { CallEngine } from '../src/renderer/engine';
import { at, flags } from './helpers.ts';

test('queue returns upcoming calls in fire-time order', () => {
  const engine = new CallEngine();
  const items = engine.queue(0, flags({ role: 'POS 5' }), 5);

  assert.deepEqual(
    items.map((i) => [i.id, i.fireAt]),
    [
      ['stack', 43],
      ['pull', 69],
      ['bounty', 170],
      ['night', 290],
      ['power_rune', 345],
    ],
  );
});

test('queue honours the limit and reports the wait in seconds', () => {
  const engine = new CallEngine();
  const items = engine.queue(60, flags(), 2);

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.id), ['pull', 'stack']);
  assert.equal(at(items, 0).fireAt, 69);
  assert.equal(at(items, 0).inSeconds, 9);
  assert.equal(at(items, 1).fireAt, 103);
  assert.equal(at(items, 1).inSeconds, 43);
});

test('a call leaves the queue the second its fire time arrives', () => {
  const engine = new CallEngine();

  // one second before: PULL is the head of the queue, firing next second
  const before = engine.queue(68, flags(), 5);
  assert.equal(at(before, 0).id, 'pull');
  assert.equal(at(before, 0).fireAt, 69);
  assert.equal(at(before, 0).inSeconds, 1);

  // on the fire second itself the queue already shows the *next* pull
  const atFire = engine.queue(69, flags(), 5);
  assert.equal(at(atFire, 0).id, 'stack');
  assert.equal(at(atFire, 0).fireAt, 103);
  const nextPull = atFire.find((i) => i.id === 'pull');
  assert.equal(nextPull?.fireAt, 129);
});

test('an absolute call leaves the queue once it has fired', () => {
  const engine = new CallEngine();

  const before = engine.queue(1169, flags(), 20);
  assert.equal(before.find((i) => i.id === 'tormentor')?.fireAt, 1170);

  const atFire = engine.queue(1170, flags(), 20);
  assert.equal(atFire.find((i) => i.id === 'tormentor'), undefined);

  const after = engine.queue(2000, flags(), 20);
  assert.equal(after.find((i) => i.id === 'tormentor'), undefined);
});

test('a tie on fire time is broken by priority, highest first', () => {
  const engine = new CallEngine();
  // BOUNTY (p3) and NIGHT (p2) both fire at 890
  const items = engine.queue(800, flags(), 20).filter((i) => i.fireAt === 890);

  assert.deepEqual(items.map((i) => i.id), ['bounty', 'night']);
  assert.deepEqual(items.map((i) => i.priority), [3, 2]);
});

test('queue drops events the role does not own and events muted by hand', () => {
  const engine = new CallEngine();

  const carry = engine.queue(0, flags({ role: 'POS 1' }), 20);
  assert.equal(carry.find((i) => i.id === 'pull'), undefined);
  assert.equal(carry.find((i) => i.id === 'wisdom'), undefined);
  assert.ok(carry.find((i) => i.id === 'stack'));

  const muted = engine.queue(0, flags({ mutedEvents: ['stack', 'pull'] }), 20);
  assert.equal(muted.find((i) => i.id === 'stack'), undefined);
  assert.equal(muted.find((i) => i.id === 'pull'), undefined);
});

test('queue lists manual and roshan timers next to the scheduled events', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);

  const items = engine.queue(300, flags(), 20);
  const aegis = items.find((i) => i.id === 'aegis_expira');

  assert.equal(aegis?.fireAt, 390); // 100 + 300 - 10 lead
  assert.equal(aegis?.roles, 'ROSHAN');
  assert.deepEqual(
    items.map((i) => i.fireAt),
    [...items.map((i) => i.fireAt)].sort((a, b) => a - b),
  );
});

test('queue is empty once every window has closed', () => {
  const engine = new CallEngine();
  assert.deepEqual(engine.queue(5000, flags(), 20), []);
});
