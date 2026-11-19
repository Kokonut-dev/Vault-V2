/**
 * Upload a cover image for one or more tracks (an album, or a single song).
 * Falls back to the older endpoint names so a UI that is newer than the
 * self-hosted server still works.
 */
import { api } from '../api.js';

function isMissingCoverEndpoint(err) {
  return err?.status === 404 && (
    err.endpointNotFound === true
    || /^not found$/i.test(err.message || '')
    || /^request failed:\s*404$/i.test(err.message || '')
  );
}

export async function uploadAlbumCover(ids, cover) {
  if (typeof api.uploadAlbumCover === 'function') return api.uploadAlbumCover(ids, cover);
  let lastError;
  for (const path of ['/api/library/albums/cover', '/api/library/cover']) {
    const form = new FormData();
    form.append('cover', cover);
    form.append('ids', JSON.stringify(ids));
    try {
      return await api.request(path, { method: 'POST', body: form });
    } catch (err) {
      lastError = err;
      if (!isMissingCoverEndpoint(err)) throw err;
    }
  }
  const base = api.baseUrl || '';
  const err = new Error(`Cover upload endpoints were not found (${base}/api/library/albums/cover, ${base}/api/library/cover). Check that the Server URL points to your Vault backend; if it does, update and restart the server, then try again.`);
  err.code = 'COVER_UPLOAD_UNAVAILABLE';
  err.path = lastError?.path || '/api/library/cover';
  err.cause = lastError;
  throw err;
}
