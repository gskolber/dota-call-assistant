import assert from 'node:assert/strict';
import test from 'node:test';

import { CallEngine, paletteByCode } from '../src/renderer/engine';
import { EVENTS } from '../src/shared/catalog';
import { at, flags, ids, state } from './helpers.ts';

/** Every scheduled event silenced, so only timers can speak. */
const ALL_EVENTS: string[] = EVENTS.map((e) => e.id);

test('markRoshan schedules the three chain steps at +300, +480 and +660', () => {
  const engine = new CallEngine();
  engine.markRoshan(600);

  assert.equal(engine.getRoshanMark(), 600);
  assert.deepEqual(
    [...engine.getTimers()].map((t) => [t.key, t.endsAt, t.lead, t.priority]),
    [
      ['roshan:aegis_expira', 900, 10, 4],
      ['roshan:rosh_possivel', 1080, 10, 4],
      ['roshan:rosh_garantido', 1260, 10, 5],
    ],
  );
  assert.ok([...engine.getTimers()].every((t) => t.source === 'roshan' && !t.spoken));
});

test('the chain speaks 10s before each step', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);
  const spoken: [number, string][] = [];

  for (let clock = 100; clock <= 800; clock += 1) {
    for (const call of engine.tick(clock, flags({ mutedEvents: ALL_EVENTS }), state())) {
      spoken.push([clock, call.id]);
    }
  }

  assert.deepEqual(spoken, [
    [390, 'aegis_expira'],
    [570, 'rosh_possivel'],
    [750, 'rosh_garantido'],
  ]);
});

test('each chain step speaks exactly once and then leaves the timer panel', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);
  const f = flags({ mutedEvents: ALL_EVENTS });

  assert.deepEqual(ids(engine.tick(390, f, state())), ['aegis_expira']);
  assert.deepEqual(ids(engine.tick(391, f, state())), []);
  // it stays on the panel until the aegis actually expires at 400
  assert.ok(engine.getTimers().some((t) => t.key === 'roshan:aegis_expira'));
  engine.tick(400, f, state());
  assert.equal(engine.getTimers().some((t) => t.key === 'roshan:aegis_expira'), false);
  assert.equal(engine.getTimers().length, 2);
});

test('marking Roshan again replaces the previous chain', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);
  engine.markRoshan(500);

  assert.equal(engine.getRoshanMark(), 500);
  assert.deepEqual([...engine.getTimers()].map((t) => t.endsAt), [800, 980, 1160]);
});

test('clearRoshan drops the mark and every chain timer, keeping manual ones', () => {
  const engine = new CallEngine();
  const smoke = paletteByCode('SM');
  assert.ok(smoke);

  engine.markRoshan(100);
  engine.addPaletteTimer(smoke, 100, 'en');
  assert.equal(engine.getTimers().length, 4);

  engine.clearRoshan();

  assert.equal(engine.getRoshanMark(), null);
  assert.deepEqual([...engine.getTimers()].map((t) => t.key), ['palette:smoke_visto']);
});

test('a cleared chain never speaks', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);
  engine.clearRoshan();

  const f = flags({ mutedEvents: ALL_EVENTS });
  for (let clock = 100; clock <= 800; clock += 1) {
    assert.deepEqual(ids(engine.tick(clock, f, state())), []);
  }
});

test('palette timers count down from the moment they are added', () => {
  const engine = new CallEngine();
  const aegis = paletteByCode('ae'); // ENEMY TOOK AEGIS: 300s, lead 10, p4
  assert.ok(aegis);
  engine.addPaletteTimer(aegis, 200, 'en');

  const timer = at(engine.getTimers(), 0);
  assert.equal(timer.key, 'palette:aegis_inimigo');
  assert.equal(timer.endsAt, 500);
  assert.equal(timer.label, 'ENEMY TOOK AEGIS'); // localised at add time

  const f = flags({ mutedEvents: ALL_EVENTS });
  assert.deepEqual(ids(engine.tick(489, f, state())), []);
  assert.deepEqual(ids(engine.tick(490, f, state())), ['aegis_inimigo']);
});

test('adding the same palette entry twice restarts it instead of stacking', () => {
  const engine = new CallEngine();
  const aegis = paletteByCode('AE');
  assert.ok(aegis);

  engine.addPaletteTimer(aegis, 200, 'en');
  engine.addPaletteTimer(aegis, 260, 'pt-BR');

  assert.equal(engine.getTimers().length, 1);
  assert.equal(at(engine.getTimers(), 0).endsAt, 560);
  assert.equal(at(engine.getTimers(), 0).label, 'INIMIGO PEGOU AEGIS');
});

test('removeTimer takes a timer off by key', () => {
  const engine = new CallEngine();
  engine.markRoshan(100);
  engine.removeTimer('roshan:rosh_possivel');

  assert.deepEqual(
    [...engine.getTimers()].map((t) => t.key),
    ['roshan:aegis_expira', 'roshan:rosh_garantido'],
  );
});

test('paletteByCode is case-insensitive and unknown codes return undefined', () => {
  assert.equal(paletteByCode('gl')?.id, 'glyph_pronto');
  assert.equal(paletteByCode('GL')?.id, 'glyph_pronto');
  assert.equal(paletteByCode('ZZ'), undefined);
});
