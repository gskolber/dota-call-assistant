import assert from 'node:assert/strict';
import test from 'node:test';

import { CallEngine } from '../src/renderer/engine';
import { at, flags, ids, state } from './helpers.ts';

test('only one call is spoken per tick, the loser is logged as DROPPED', () => {
  const engine = new CallEngine();
  // BOUNTY (p3) and NIGHT (p2) both fire at clock 890
  const spoken = engine.tick(890, flags(), state());

  assert.deepEqual(ids(spoken), ['bounty']);

  const log = [...engine.getLog()];
  assert.deepEqual(
    log.map((e) => [e.label, e.state]),
    [['NIGHT', 'DROPPED'], ['BOUNTY RUNE', 'SPOKEN']],
  );
  assert.equal(at(log, 0).clock, 890);
  assert.equal(at(log, 0).at, '14:50');
});

test('the collision is decided by priority, not by catalog order', () => {
  const engine = new CallEngine();
  engine.markRoshan(600); // AEGIS EXPIRES (p4) also lands on 890
  const spoken = engine.tick(890, flags(), state());

  assert.deepEqual(ids(spoken), ['aegis_expira']);
  assert.deepEqual(
    [...engine.getLog()].map((e) => e.state),
    ['DROPPED', 'DROPPED', 'SPOKEN'],
  );
});

test('spokenInWindow counts only the last 60 seconds', () => {
  const engine = new CallEngine();
  engine.tick(103, flags(), state()); // STACK
  engine.tick(129, flags(), state()); // PULL

  assert.equal(engine.spokenInWindow(129), 2);
  assert.equal(engine.spokenInWindow(162), 2);
  assert.equal(engine.spokenInWindow(163), 1); // the 103 call is exactly 60s old
  assert.equal(engine.spokenInWindow(189), 0);
});

test('the per-minute budget drops low-priority calls once it is exceeded', () => {
  const engine = new CallEngine();
  const f = flags({ budget: 1 });

  assert.deepEqual(ids(engine.tick(129, f, state())), ['pull']); // p2, budget free
  assert.deepEqual(ids(engine.tick(163, f, state())), []); // STACK p2, over budget
  assert.deepEqual(ids(engine.tick(170, f, state())), []); // BOUNTY p3, over budget

  assert.deepEqual(
    [...engine.getLog()].map((e) => [e.label, e.state]),
    [['BOUNTY RUNE', 'BUDGET'], ['STACK', 'BUDGET'], ['PULL', 'SPOKEN']],
  );

  // once the window has rolled past the spoken call the budget frees up again
  assert.deepEqual(ids(engine.tick(189, f, state())), ['pull']);
});

test('priority 4 and up ignore the budget', () => {
  const engine = new CallEngine();
  const f = flags({ budget: 1 });

  assert.deepEqual(ids(engine.tick(1123, f, state())), ['stack']); // fills the budget
  assert.equal(engine.spokenInWindow(1170), 1);
  // TORMENTOR is p4 and speaks anyway, 42s later, with budget 1 already used
  assert.deepEqual(ids(engine.tick(1170, f, state())), ['tormentor']);

  assert.deepEqual([...engine.getLog()].map((e) => e.state), ['SPOKEN', 'SPOKEN']);
});

test('a call dropped by the budget does not consume budget itself', () => {
  const engine = new CallEngine();
  const f = flags({ budget: 1 });

  engine.tick(129, f, state()); // PULL spoken
  assert.equal(engine.spokenInWindow(129), 1);

  engine.tick(168, f, state()); // STACK dropped by the budget
  assert.equal(engine.spokenInWindow(168), 1);
});

test('reset clears the log, the budget window and the timers', () => {
  const engine = new CallEngine();
  engine.markRoshan(600);
  engine.tick(890, flags(), state());
  assert.ok(engine.getLog().length > 0);

  engine.reset();

  assert.deepEqual([...engine.getLog()], []);
  assert.deepEqual([...engine.getTimers()], []);
  assert.equal(engine.getRoshanMark(), null);
  assert.equal(engine.spokenInWindow(890), 0);
});

test('the log keeps at most 40 entries, newest first', () => {
  const engine = new CallEngine();
  for (let clock = 0; clock <= 1800; clock += 1) engine.tick(clock, flags(), state());

  const log = [...engine.getLog()];
  assert.equal(log.length, 40);
  for (let i = 1; i < log.length; i += 1) {
    assert.ok(at(log, i - 1).clock >= at(log, i).clock, 'log is newest first');
  }
});
