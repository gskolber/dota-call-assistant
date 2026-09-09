import assert from 'node:assert/strict';
import test from 'node:test';

import { CallEngine } from '../src/renderer/engine';
import { EVENTS } from '../src/shared/catalog';
import { flags, ids, ROLES, state } from './helpers.ts';
import type { RoleId } from '../src/shared/types';

/**
 * Every clock second in [from, to] at which `id` is spoken, with every other
 * event silenced so a timing test measures one schedule and nothing else
 * (two calls landing on the same second is the collision rule, tested apart).
 */
function firesBetween(id: string, from: number, to: number, role: RoleId = 'POS 5'): number[] {
  const engine = new CallEngine();
  const mutedEvents = EVENTS.map((e) => e.id).filter((other) => other !== id);
  const out: number[] = [];
  for (let clock = from; clock <= to; clock += 1) {
    const spoken = engine.tick(clock, flags({ role, mutedEvents }), state());
    if (ids(spoken).includes(id)) out.push(clock);
  }
  return out;
}

test('STACK fires 10s before :53 of every minute, i.e. at 103, 163, 223…', () => {
  assert.deepEqual(firesBetween('stack', 0, 300), [103, 163, 223, 283]);
});

test('STACK respects its 1:00–30:00 window', () => {
  // the camps are empty until 1:00, so the first stack is the 1:53 one,
  // called at 1:43 — there is nothing to pull out of the box at 0:53
  assert.equal(firesBetween('stack', 0, 120)[0], 103);
  // the last one is 29:53 (clock 1793), spoken at 1788; 30:53 is outside
  assert.deepEqual(firesBetween('stack', 1700, 1900), [1723, 1783]);
});

test('PULL fires 6s before :15 of every minute inside 1:00–15:00', () => {
  assert.deepEqual(firesBetween('pull', 0, 200), [69, 129, 189]);
  // window closes at 900: 14:15 (clock 855) is the last one, spoken at 849
  assert.deepEqual(firesBetween('pull', 800, 1000), [849]);
});

test('BOUNTY runs every 3:00 and its first call lands before the horn', () => {
  assert.deepEqual(firesBetween('bounty', -60, 600), [-10, 170, 350, 530]);
});

test('POWER RUNE only starts at 6:00 and then runs every 2:00', () => {
  assert.deepEqual(firesBetween('power_rune', 0, 720), [345, 465, 585, 705]);
});

test('WISDOM runs every 7:00 with a 20s lead', () => {
  assert.deepEqual(firesBetween('wisdom', 0, 1300), [400, 820, 1240]);
});

test('NIGHT and DAY alternate every 5 minutes from 5:00', () => {
  assert.deepEqual(firesBetween('night', 0, 1600), [290, 890, 1490]);
  assert.deepEqual(firesBetween('day', 0, 1600), [590, 1190]);
});

test('TORMENTOR is absolute: it fires once, at 1170, with a 30s lead', () => {
  assert.deepEqual(firesBetween('tormentor', 0, 2400), [1170]);
});

test('the neutral tiers are absolute too', () => {
  assert.deepEqual(firesBetween('tier_two', 0, 1800), [1040]);
  assert.deepEqual(firesBetween('tier_three', 0, 1800), [1640]);
});

test('PULL is supports-only, so POS 1 never gets it', () => {
  for (const role of ROLES) {
    const fires = firesBetween('pull', 0, 200, role);
    if (role === 'POS 4' || role === 'POS 5') {
      assert.deepEqual(fires, [69, 129, 189], `${role} should get PULL`);
    } else {
      assert.deepEqual(fires, [], `${role} must never get PULL`);
    }
  }
});

test('role filtering, event by event, at the roles each one declares', () => {
  // STACK: carry and both supports. WISDOM: mid and both supports.
  assert.deepEqual(firesBetween('stack', 0, 120, 'POS 1'), [103]);
  assert.deepEqual(firesBetween('stack', 0, 120, 'POS 2'), []);
  assert.deepEqual(firesBetween('wisdom', 0, 500, 'POS 2'), [400]);
  assert.deepEqual(firesBetween('wisdom', 0, 500, 'POS 1'), []);
  // TORMENTOR is ALL
  for (const role of ROLES) {
    assert.deepEqual(firesBetween('tormentor', 1100, 1200, role), [1170]);
  }
});

test('a hand-muted event never fires and is not even logged', () => {
  const engine = new CallEngine();
  const spoken = engine.tick(69, flags({ mutedEvents: ['pull'] }), state());
  assert.deepEqual(ids(spoken), []);
  assert.deepEqual([...engine.getLog()], []);
});

test('state calls fire off the live state and then sit on a cooldown', () => {
  const engine = new CallEngine();
  const noEvents = { mutedEvents: EVENTS.map((e) => e.id) };

  // before 2:00 there is no NO TP call
  assert.deepEqual(ids(engine.tick(100, flags(noEvents), state({ hasTp: false }))), []);

  assert.deepEqual(ids(engine.tick(121, flags(noEvents), state({ hasTp: false }))), ['sem_tp']);
  // cooldown is 120s
  assert.deepEqual(ids(engine.tick(200, flags(noEvents), state({ hasTp: false }))), []);
  assert.deepEqual(ids(engine.tick(241, flags(noEvents), state({ hasTp: false }))), ['sem_tp']);

  // NO BUYBACK needs to be alive, past 20:00 and short on gold
  const buyback = new CallEngine();
  assert.deepEqual(ids(buyback.tick(1201, flags(noEvents), state({ gold: 100 }))), ['sem_buyback']);
  assert.deepEqual(
    ids(buyback.tick(1500, flags(noEvents), state({ gold: 100, alive: false }))),
    [],
  );
});
