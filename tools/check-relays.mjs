// Probes the relay candidate pool and rewrites relays.json when entries rot.
// Run weekly by .github/workflows/relays.yml; safe to run locally (node 22+).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const OUT = new URL('../relays.json', import.meta.url);
const TARGET = 10;     // list size written to relays.json
const MIN_HEALTHY = 6; // below this, flag the run so the workflow goes red

// Order = replacement preference: established operators first, then the
// vendored bundle's default pool. Hosts only; wss:// is added on output.
const CANDIDATES = [
  'nos.lol', 'relay.primal.net', 'relay.mostr.pub', 'nostr-01.yakihonne.com',
  'nostr.mom', 'purplerelay.com', 'nostr.vulpem.com', 'nostr.oxtr.dev',
  'relay.mostro.network', 'nostr.sathoarder.com', 'relay.snort.social',
  'offchain.pub', 'nostr.bitcoiner.social', 'relay.nostr.band',
  'basspistol.org', 'bucket.coracle.social', 'chorus.almostmachines.dev',
  'chorus.pjv.me', 'communities.nos.social', 'ftp.halifax.rwth-aachen.de/nostr',
  'hol.is', 'hornetstorage.net/relay', 'koru.bitcointxoko.org', 'nostr-01.uid.ovh',
  'nostr-relay.corb.net', 'nostr.data.haus', 'nostr.islandarea.net',
  'nostr.self-determined.de', 'nostr.tegila.com.br', 'relay-can.zombi.cloudrodion.com',
  'relay-rpi.edufeed.org', 'relay.agorist.space', 'relay.angor.io',
  'relay.artio.inf.unibe.ch', 'relay.binaryrobot.com', 'relay.damus.io',
  'relay.froth.zone', 'relay.libernet.app', 'relay.nostr.place',
  'relay.nostrdice.com', 'relay.notoshi.win', 'relay.sigit.io',
  'relay02.lnfi.network', 'relay2.angor.io', 'schnorr.me', 'slick.mjex.me',
  'social.amanah.eblessing.co', 'staging.yabu.me', 'strfry.openhoofd.nl',
  'strfry.shock.network', 'testnet-relay.samt.st', 'top.testrelay.top',
  'x.kojira.io', 'yabu.me/v2',
];

// Healthy = answers a REQ with EOSE/EVENT, no AUTH demand, no rejection.
function probe(host) {
  return new Promise(resolve => {
    let ws, sawAuth = false;
    const done = ok => { try { ws?.close(); } catch {} resolve(ok && !sawAuth); };
    const timer = setTimeout(() => done(false), 7000);
    try { ws = new WebSocket(`wss://${host}`); } catch { clearTimeout(timer); return resolve(false); }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'p', { kinds: [29333], limit: 1 }]));
    ws.onmessage = m => {
      let t; try { t = JSON.parse(m.data)[0]; } catch { return; }
      if (t === 'AUTH') sawAuth = true;
      else if (t === 'EOSE' || t === 'EVENT') { clearTimeout(timer); done(true); }
      else if (t === 'CLOSED' || t === 'NOTICE') { clearTimeout(timer); done(false); }
    };
    ws.onerror = () => { clearTimeout(timer); done(false); };
  });
}

// Two rounds to weed out flaky relays (some answer once, then drop).
const round1 = await Promise.all(CANDIDATES.map(probe));
await new Promise(r => setTimeout(r, 8000));
const round2 = await Promise.all(CANDIDATES.map(probe));
const healthy = new Set(CANDIDATES.filter((_, i) => round1[i] && round2[i]).map(h => `wss://${h}`));

let current = [];
try { current = JSON.parse(readFileSync(OUT, 'utf8')); } catch {}

// Continuity-first: keep surviving entries so old and new clients still overlap,
// top up from the pool in preference order.
const kept = current.filter(u => healthy.has(u));
const topUp = CANDIDATES.map(h => `wss://${h}`).filter(u => healthy.has(u) && !kept.includes(u));
const next = [...kept, ...topUp].slice(0, TARGET);

console.log(`healthy: ${healthy.size}/${CANDIDATES.length}, kept: ${kept.length}/${current.length}`);

if (JSON.stringify(next) !== JSON.stringify(current)) {
  writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
  console.log('relays.json updated:\n  ' + next.join('\n  '));
} else {
  console.log('relays.json unchanged');
}

if (healthy.size < MIN_HEALTHY) {
  console.error(`relay pool health low: ${healthy.size} < ${MIN_HEALTHY}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'low=1\n');
}
