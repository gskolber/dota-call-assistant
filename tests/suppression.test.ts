import assert from 'node:assert/strict';
import test from 'node:test';

import { CallEngine, paletteByCode } from '../src/renderer/engine';
import { at, flags, ids, state } from './helpers.ts';

/** Log state of the single BOUNTY call due at clock 170. */
function reasonAt170(over: Parameters<typeof flags>[0]): string {
  const engine = new CallEngine();
  engine.tick(170, flags(over), state());
  return at(engine.getLog(), 0).state;
}

test('suppression precedence is muted > paused > dead > fight', () => {
  assert.equal(
    reasonAt170({ muted: true, paused: true, dead: true, fight: true }),
    'MUTED',
  );
  assert.equal(reasonAt170({ paused: true, dead: true, fight: true }), 'PAUSED');
  assert.equal(reasonAt170({ dead: true, fight: true }), 'DEAD');
  assert.equal(reasonAt170({ fight: true }), 'FIGHT');
  assert.equal(reasonAt170({}), 'SPOKEN');
});

test('the budget comes after the four flags and before the collision rule', () => {
  // budget 0 with nothing spoken yet: the flag-free call still drops on budget
  assert.equal(reasonAt170({ budget: 0 }), 'BUDGET');
  // but FIGHT wins over BUDGET when both apply
  assert.equal(reasonAt170({ budget: 0, fight: true }), 'FIGHT');
});

test('a suppressed call is logged but never spoken', () => {
  const engine = new CallEngine();
  const spoken = engine.tick(170, flags({ muted: true }), state());

  assert.deepEqual(ids(spoken), []);
  assert.deepEqual(
    [...engine.getLog()].map((e) => [e.label, e.state]),
    [['BOUNTY RUNE', 'MUTED']],
  );
  // and it does not eat into the budget
  assert.equal(engine.spokenInWindow(170), 0);
});

test('FIGHT only lets priority 5 through', () => {
  const engine = new CallEngine();
  engine.markRoshan(100); // p4 at 390, p4 at 570, p5 at 750
  const f = flags({ fight: true });

  assert.deepEqual(ids(engine.tick(390, f, state())), []); // AEGIS EXPIRES, p4
  assert.equal(at(engine.getLog(), 0).state, 'FIGHT');

  assert.deepEqual(ids(engine.tick(570, f, state())), []); // ROSH POSSIBLE, p4
  assert.equal(at(engine.getLog(), 0).state, 'FIGHT');

  assert.deepEqual(ids(engine.tick(750, f, state())), ['rosh_garantido']); // p5
  assert.equal(at(engine.getLog(), 0).state, 'SPOKEN');
});

test('death silences everything except the Roshan chain', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);
  const f = flags({ dead: true });

  // a normal scheduled call is dropped while dead
  assert.deepEqual(ids(engine.tick(170, f, state())), []);
  assert.equal(at(engine.getLog(), 0).state, 'DEAD');

  // the chain speaks anyway - ignoresDeath
  assert.deepEqual(ids(engine.tick(390, f, state())), ['aegis_expira']);
  assert.equal(at(engine.getLog(), 0).state, 'SPOKEN');
  assert.deepEqual(ids(engine.tick(570, f, state())), ['rosh_possivel']);
  assert.deepEqual(ids(engine.tick(750, f, state())), ['rosh_garantido']);
});

test('mute and pause silence the Roshan chain too', () => {
  assert.equal(reasonForChainAt390({ muted: true }), 'MUTED');
  assert.equal(reasonForChainAt390({ paused: true }), 'PAUSED');
  assert.equal(reasonForChainAt390({}), 'SPOKEN');
});

function reasonForChainAt390(over: Parameters<typeof flags>[0]): string {
  const engine = new CallEngine();
  engine.markRoshan(100);
  engine.tick(390, flags(over), state());
  return at(engine.getLog(), 0).state;
}

test('a palette timer is manual, not part of the chain, so death silences it', () => {
  const engine = new CallEngine();
  const smoke = paletteByCode('sm'); // SMOKE SPOTTED: 40s, lead 5, priority 4
  assert.ok(smoke);
  engine.addPaletteTimer(smoke, 300, 'en');

  assert.deepEqual(ids(engine.tick(335, flags({ dead: true }), state())), []);
  assert.equal(at(engine.getLog(), 0).state, 'DEAD');
});
