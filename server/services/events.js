/**
 * Server-Sent Events bus.
 *
 * `/api/events` existed before but only ever sent `ping` — the client had no
 * reason to consume it (audit F-22). Now every long-running operation reports
 * through here: scan progress, uploads, library changes, transcode notices,
 * sync-play rooms, notifications.
 */
const clients = new Set();

function addClient(res) {
  const client = { res, id: Math.random().toString(36).slice(2) };
  clients.add(client);
  return client;
}

function removeClient(client) {
  clients.delete(client);
}

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function clientCount() {
  return clients.size;
}

// ---------------------------------------------------------------------------
// Live job tracking — scan/upload progress the UI can subscribe to.
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> { id, kind, label, total, done, status, startedAt, meta }

function jobStart(id, kind, label, total = 0, meta = {}) {
  const job = {
    id,
    kind,
    label,
    total,
    done: 0,
    status: 'running',
    startedAt: new Date().toISOString(),
    meta,
  };
  jobs.set(id, job);
  broadcast('job:start', job);
  return job;
}

function jobProgress(id, done, total) {
  const job = jobs.get(id);
  if (!job) return null;
  job.done = done;
  if (typeof total === 'number') job.total = total;
  return job;
}

function jobFinish(id, status = 'done', meta = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  Object.assign(job.meta, meta);
  jobs.delete(id);
  broadcast('job:finish', job);
  return job;
}

function jobList() {
  return Array.from(jobs.values());
}

module.exports = {
  addClient,
  removeClient,
  broadcast,
  clientCount,
  jobStart,
  jobProgress,
  jobFinish,
  jobList,
};
