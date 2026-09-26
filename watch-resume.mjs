import { readFileSync } from 'node:fs';
const p = 'data/experiments/exp-2026-09-26T11-21-31-129Z-32e16e34/experiment.json';
const deadline = Date.now() + 50 * 60 * 1000;
let last = '';
while (Date.now() < deadline) {
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    const settled = doc.rows.filter(r => r.phase === 'done' && typeof r.evaluation?.status?.scoring?.total === 'number').length;
    const pending = doc.rows.filter(r => r.phase === 'done' && r.evaluation && r.evaluation.status.scoring.total === null).length;
    const line = doc.state + ' settled=' + settled + ' pending=' + pending + ' phase=' + doc.rows.map(r => r.phase).join('').length;
    if (line !== last) { console.log(new Date().toISOString().slice(11,19), doc.state, 'settled=' + settled, 'pending=' + pending); last = line; }
    if (doc.state !== 'running') { console.log('DONE state=' + doc.state); break; }
  } catch (e) { console.log('read error', e.message.slice(0,60)); }
  await new Promise(r => setTimeout(r, 20000));
}