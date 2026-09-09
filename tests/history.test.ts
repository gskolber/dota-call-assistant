// The discipline numbers are the whole promise of the report: they must only
// count things GSI actually reports, and count them once. A number that
// flatters the player is worse than no number.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MatchHistory } from '../src/renderer/history';
import { EMPTY_MATCH, type MatchState } from '../src/renderer/match';
import type { LogEntry } from '../src/renderer/engine';

/** A live match with nothing wrong: alive, rich, carrying a TP and wards. */
function match(over: Partial<MatchState> = {}): MatchState {
  return {
    ...EMPTY_MATCH,
    connected: true,
    inMatch: true,
    alive: true,
    gold: 500,
    buybackCost: 1200,
    buybackCooldown: 0,
    hasTp: true,
    observers: 2,
    sentries: 2,
    smokes: 1,
    team: 'radiant',
    heroName: 'lion',
    ...over,
  };
}

/** Runs a sequence of per-second states through the accumulator. */
function run(states: MatchState[], startClock = 0, log: LogEntry[] = []) {
  const history = new MatchHistory();
  const first = states[0];
  assert.ok(first, 'need at least one state');
  history.begin('123', first, 'POS 5', log);
  states.forEach((state, index) => history.observe(startClock + index, state, 'POS 5', log));
  const record = history.end();
  assert.ok(record, 'the record should exist after end()');
  return record;
}

describe('wards count as placed only when the count falls', () => {
  it('ignores buying more', () => {
    const record = run([match({ sentries: 1 }), match({ sentries: 2 }), match({ sentries: 4 })]);
    assert.equal(record.discipline.sentriesPlaced, 0);
  });

  it('counts two when two leave the bag between samples', () => {
    const record = run([match({ sentries: 3 }), match({ sentries: 1 })]);
    assert.equal(record.discipline.sentriesPlaced, 2, 'a fall of two is two wards');
  });

  it('counts observers and smokes on the same rule', () => {
    const record = run([
      match({ observers: 2, smokes: 1 }),
      match({ observers: 1, smokes: 0 }),
    ]);
    assert.equal(record.discipline.observersPlaced, 1);
    assert.equal(record.discipline.smokesUsed, 1);
  });
});

describe('no TP and no buyback are counted in seconds, and only when they bite', () => {
  it('ignores the first two minutes', () => {
    const record = run(Array.from({ length: 60 }, () => match({ hasTp: false })), 60);
    assert.equal(record.discipline.secondsWithoutTp, 0, 'before 2:00 nobody carries a TP');
  });

  it('counts once past 2:00', () => {
    const record = run(Array.from({ length: 10 }, () => match({ hasTp: false })), 200);
    assert.equal(record.discipline.secondsWithoutTp, 10);
  });

  it('does not count while dead: you cannot buy a TP from the fountain queue', () => {
    const record = run(
      Array.from({ length: 10 }, () => match({ hasTp: false, alive: false })),
      200,
    );
    assert.equal(record.discipline.secondsWithoutTp, 0);
  });

  it('treats a buyback cooldown as having no buyback, however rich you are', () => {
    const record = run(
      Array.from({ length: 5 }, () => match({ gold: 99999, buybackCooldown: 180 })),
      1300,
    );
    assert.equal(record.discipline.secondsWithoutBuyback, 5);
  });

  it('does not count buyback before 20:00, when nobody has one anyway', () => {
    const record = run(Array.from({ length: 5 }, () => match({ gold: 0 })), 600);
    assert.equal(record.discipline.secondsWithoutBuyback, 0);
  });
});

describe('deaths are transitions, not durations', () => {
  it('counts one death however long it lasts', () => {
    const record = run([
      match(),
      match({ alive: false }),
      match({ alive: false }),
      match({ alive: false }),
      match(),
    ]);
    assert.equal(record.discipline.deaths, 1);
  });

  it('splits out the ones where buyback was out of reach', () => {
    const rich = run([match(), match({ alive: false, gold: 99999, buybackCost: 1200 })]);
    assert.equal(rich.discipline.deaths, 1);
    assert.equal(rich.discipline.deathsWithoutBuyback, 0);

    const broke = run([match(), match({ alive: false, gold: 10, buybackCost: 1200 })]);
    assert.equal(broke.discipline.deathsWithoutBuyback, 1);
  });
});

describe('the record survives the engine log being capped', () => {
  it('keeps every call, not the last forty', () => {
    const history = new MatchHistory();
    const log: LogEntry[] = [];
    history.begin('123', match(), 'POS 5', log);

    // the engine unshifts and slices to 40; the record must not lose the rest
    for (let i = 0; i < 60; i += 1) {
      log.unshift({ clock: i, at: '0:00', label: 'STACK', priority: 2, state: 'SPOKEN' });
      log.splice(40);
      history.observe(i, match(), 'POS 5', log);
    }

    const record = history.end();
    assert.equal(record?.calls.length, 60);
  });

  it('takes nothing retroactively from a log that was already full', () => {
    const history = new MatchHistory();
    const log: LogEntry[] = Array.from({ length: 40 }, (_, i) => ({
      clock: i, at: '0:00', label: 'PULL', priority: 2, state: 'SPOKEN' as const,
    }));

    history.begin('123', match(), 'POS 5', log);
    history.observe(0, match(), 'POS 5', log);

    assert.equal(history.end()?.calls.length, 0, 'the previous match is not this match');
  });
});

describe('a clock that jumps backwards starts clean', () => {
  it('does not read a replaced inventory as a pile of wards placed', () => {
    const history = new MatchHistory();
    history.begin('123', match({ sentries: 4 }), 'POS 5', []);
    history.observe(600, match({ sentries: 4 }), 'POS 5', []);
    // a demo restart, or a reconnect onto another game
    history.observe(5, match({ sentries: 0 }), 'POS 5', []);

    assert.equal(history.end()?.discipline.sentriesPlaced, 0);
  });
});
