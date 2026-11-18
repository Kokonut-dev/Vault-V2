/**
 * Server-Sent Events bus.
 *
 * `/api/events` existed before but only ever sent `ping` — the client had no
 * reason to consume it (audit F-22). Now every long-running operation reports
 * through here: scan progress, uploads, library changes, transcode notices,
 * sync-play rooms, notifications.
 */
const clients = new Set();

/**
 * Register an SSE response. `filter(event)` (optional) limits which events the
 * client receives — the unauthenticated stream uses it to see job progress
 * only, never library contents.
 */
function addClient(res, { filter } = {}) {
  const client = { res, filter: typeof filter === 'function' ? filter : null, id: Math.random().toString(36).slice(2) };
  clients.add(client);
  return client;
}

function removeClient(client) {
  clients.delete(client);
}

function broadcast(event, data = {}) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    if (client.filter && !client.filter(event)) continue;
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

const PROGRESS_INTERVAL_MS = 1000;

function jobProgress(id, done, total) {
  const job = jobs.get(id);
  if (!job) return null;
  job.done = done;
  if (typeof total === 'number') job.total = total;
  // Progress used to be tracked but never sent, so the Jobs tab only moved
  // on refresh. Throttled: a download can report hundreds of times a second.
  const now = Date.now();
  if (now - (job._sentAt || 0) >= PROGRESS_INTERVAL_MS) {
    job._sentAt = now;
    broadcast('job:progress', publicJob(job));
  }
  return job;
}

function publicJob(job) {
  const { _sentAt, ...rest } = job;
  return rest;
}

function jobFinish(id, status = 'done', meta = {}) {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = status;
  job.finishedAt = new Date().toISOString();
  Object.assign(job.meta, meta);
  jobs.delete(id);
  // The client listens for `job:finished` (it used to be sent as
  // `job:finish`, so finished jobs never updated the UI). `name`/`error`
  // feed its toast; jobs without a name (scans) finish quietly.
  broadcast('job:finished', {
    ...publicJob(job),
    name: job.meta?.name,
    error: job.meta?.error,
    ...(job.meta?.imported != null ? { imported: job.meta.imported, failed: job.meta.failed || 0 } : {}),
  });
  return job;
}

function jobList() {
  return Array.from(jobs.values(), publicJob);
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
