'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const events = require('../services/events');

function sink() {
  const frames = [];
  return { frames, write(chunk) { frames.push(chunk); } };
}

test('broadcast reaches registered SSE clients and stops after removal', () => {
  const res = sink();
  const client = events.addClient(res);
  events.broadcast('library:changed', { reason: 'add', id: 'x' });
  assert.match(res.frames.join(''), /event: library:changed\ndata: \{"reason":"add","id":"x"\}\n\n/);
  events.removeClient(client);
  events.broadcast('library:changed', { reason: 'add', id: 'y' });
  assert.doesNotMatch(res.frames.join(''), /"y"/);
});

test('client filter limits which events are delivered', () => {
  const res = sink();
  const client = events.addClient(res, { filter: (e) => /^(job|scan):/.test(e) });
  events.broadcast('library:changed', { title: 'secret' });
  events.jobStart('t1', 'scan', 'Scanning', 0);
  events.jobFinish('t1', 'done');
  events.removeClient(client);
  const out = res.frames.join('');
  assert.doesNotMatch(out, /secret/);
  assert.match(out, /event: job:start/);
  assert.match(out, /event: job:finished/);
});

test('both /api/events streams register with the bus (regression: they only sent pings)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  for (const route of ["app.get('/api/events'", "app.get('/api/events/public'"]) {
    const start = src.indexOf(route);
    assert.ok(start > -1, `${route} exists`);
    const body = src.slice(start, src.indexOf('\n});', start));
    assert.match(body, /events\.addClient\(res/, `${route} calls events.addClient`);
    assert.match(body, /events\.removeClient\(client\)/, `${route} unregisters on close`);
  }
});
