// Listens on a second GSI endpoint and records everything Dota sends, so the
// catalogue can be checked against what the game actually exposes rather than
// against what the wiki says it does.
//
//   probe:    node tools/gsi-probe.mjs
//   analyse:  node tools/gsi-probe.mjs --analyse <file.jsonl>
//
// Dota reads every gamestate_integration_*.cfg in its config folder and posts
// to each, so this runs alongside the app instead of replacing it. Like any
// GSI config, Dota only picks it up at startup.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PROBE_PORT ?? 3099);
const OUT = process.env.PROBE_OUT ?? 'gsi-probe.jsonl';

/** Everything the app reads today, so the analysis can flag the rest. */
const CONSUMED = new Set([
  'map.clock_time', 'map.game_time', 'map.daytime', 'map.game_state', 'map.paused',
  'map.matchid', 'map.name',
  'player.gold', 'player.buyback_cost',
  'hero.name', 'hero.alive', 'hero.respawn_seconds', 'hero.buyback_cost',
  'abilities.*.ultimate', 'abilities.*.cooldown', 'abilities.*.can_cast',
  'abilities.*.level', 'abilities.*.passive',
  'items.*.name', 'items.*.charges', 'items.*.item_charges', 'items.*.cooldown',
  'provider.name', 'provider.appid', 'provider.version', 'provider.timestamp',
  'auth.token',
]);

/** Collapses slot0/slot1/ability3 into one path so the report stays readable. */
function generalise(key) {
  return key
    .replace(/\b(slot|stash|teleport|neutral)\d+\b/g, '*')
    .replace(/\bability\d+\b/g, '*')
    .replace(/\bitem\d+\b/g, '*');
}

function walk(value, prefix, out) {
  if (value === null || typeof value !== 'object') {
    const key = generalise(prefix);
    const seen = out.get(key) ?? { count: 0, samples: new Set(), type: typeof value };
    seen.count += 1;
    if (seen.samples.size < 4) seen.samples.add(JSON.stringify(value));
    out.set(key, seen);
    return;
  }
  if (Array.isArray(value)) {
    // a spectator client sends arrays where a player client sends objects
    walk(value[0], `${prefix}[]`, out);
    return;
  }
  for (const [k, v] of Object.entries(value)) walk(v, prefix ? `${prefix}.${k}` : k, out);
}

function analyse(file) {
  const paths = new Map();
  const states = new Set();
  let payloads = 0;
  let clockMin = Infinity;
  let clockMax = -Infinity;

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    payloads += 1;
    // `previously` and `added` are deltas of the same shape; they would double
    // every path without saying anything new
    delete payload.previously;
    delete payload.added;
    if (payload.map?.game_state) states.add(payload.map.game_state);
    const clock = payload.map?.clock_time;
    if (typeof clock === 'number') {
      clockMin = Math.min(clockMin, clock);
      clockMax = Math.max(clockMax, clock);
    }
    walk(payload, '', paths);
  }

  const sorted = [...paths.entries()].sort(([a], [b]) => a.localeCompare(b));
  const unused = sorted.filter(([key]) => !CONSUMED.has(key));

  console.log(`payloads: ${payloads}`);
  console.log(`game states: ${[...states].join(', ') || '(none)'}`);
  if (clockMin !== Infinity) console.log(`clock seen: ${clockMin} … ${clockMax}`);
  console.log(`distinct paths: ${sorted.length}, of which unused by the app: ${unused.length}\n`);

  console.log('UNUSED — everything the game sends that the app ignores:');
  for (const [key, info] of unused) {
    console.log(`  ${key.padEnd(46)} ${String(info.count).padStart(6)}x  ${[...info.samples].join(' ')}`);
  }

  console.log('\nCONSUMED — paths the app already reads:');
  for (const [key, info] of sorted.filter(([k]) => CONSUMED.has(k))) {
    console.log(`  ${key.padEnd(46)} ${String(info.count).padStart(6)}x  ${[...info.samples].join(' ')}`);
  }
}

function probe() {
  const stream = fs.createWriteStream(OUT, { flags: 'a' });
  let count = 0;
  let lastState = '';

  http
    .createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200).end();
        const body = Buffer.concat(chunks).toString('utf8');
        stream.write(`${body}\n`);
        count += 1;

        let state = '';
        try {
          state = JSON.parse(body).map?.game_state ?? '';
        } catch { /* keep going: a malformed payload is itself worth recording */ }
        if (state !== lastState) {
          lastState = state;
          console.log(`[${count}] ${state || '(no map block)'}`);
        } else if (count % 50 === 0) {
          console.log(`[${count}] recording…`);
        }
      });
    })
    .listen(PORT, '127.0.0.1', () => {
      console.log(`probe listening on 127.0.0.1:${PORT}`);
      console.log(`writing to ${path.resolve(OUT)}`);
      console.log('restart Dota, then play or watch anything. Ctrl+C to stop.');
    });
}

if (process.argv.includes('--analyse')) {
  const file = process.argv[process.argv.indexOf('--analyse') + 1];
  if (!file) {
    console.error('usage: node tools/gsi-probe.mjs --analyse <file.jsonl>');
    process.exit(1);
  }
  analyse(file);
} else {
  probe();
}
