/**
 * Cover-art upload regressions for every user-facing entry point.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');
const jwt = require('jsonwebtoken');

function imageBlob() {
  return new Blob([Buffer.from('not-a-real-png')], { type: 'image/png' });
}

async function postForm(baseUrl, route, token, form) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

test('authenticated album, playlist, and new-media cover uploads are reachable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-cover-test-'));
  const mediaPaths = {
    movies: path.join(root, 'movies'),
    music: path.join(root, 'music'),
    videos: path.join(root, 'videos'),
  };
  const jwtSecret = 'cover-route-regression-secret';

  // Route modules capture getConfig when they load, so install the isolated
  // test configuration before requiring them.
  const configModule = require('../config');
  const originalGetConfig = configModule.getConfig;
  configModule.getConfig = () => ({
    auth: { jwtSecret },
    media: {
      paths: mediaPaths,
      maxUploadSizeMB: 10,
      supportedExtensions: {
        video: ['.mp4'],
        audio: ['.mp3'],
        subtitle: ['.srt', '.vtt', '.ass'],
      },
    },
  });

  const library = require('../services/library');
  const scanner = require('../services/scanner');
  const events = require('../services/events');
  const original = {
    getById: library.getById,
    updateItem: library.updateItem,
    forProfile: library.forProfile,
    scanFile: scanner.scanFile,
    broadcast: events.broadcast,
  };

  const tracks = new Map([
    ['album-track', { id: 'album-track', type: 'music', title: 'Album track' }],
  ]);
  const playlist = { id: 'playlist-1', name: 'Test playlist', items: [], coverArt: null };
  const scoped = {
    getPlaylistById: id => (id === playlist.id ? playlist : null),
    updatePlaylist: (id, updates) => Object.assign(playlist, updates),
  };
  let uploadedId = 0;
  library.getById = id => tracks.get(String(id));
  library.updateItem = (id, updates) => {
    const item = tracks.get(String(id)) || { id: String(id), type: 'music' };
    Object.assign(item, updates);
    tracks.set(String(id), item);
    return item;
  };
  library.forProfile = () => scoped;
  scanner.scanFile = async filePath => ({
    id: `uploaded-${++uploadedId}`,
    type: 'music',
    title: path.basename(filePath),
    path: filePath,
  });
  events.broadcast = () => {};

  // Require after the stubs so upload.js and auth.js capture the test config.
  const { authMiddleware } = require('../middleware/auth');
  const libraryRoutes = require('../routes/library');
  const playlistRoutes = require('../routes/playlists');
  const uploadRoutes = require('../routes/upload');

  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api/library', libraryRoutes);
  app.use('/api/playlists', playlistRoutes);
  app.use('/api/upload', uploadRoutes);

  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = jwt.sign({ profileId: 'default' }, jwtSecret, { expiresIn: '5m' });
  const generatedCovers = new Set();

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const coverPath of generatedCovers) await fs.remove(coverPath);
    await fs.remove(root);
    library.getById = original.getById;
    library.updateItem = original.updateItem;
    library.forProfile = original.forProfile;
    scanner.scanFile = original.scanFile;
    events.broadcast = original.broadcast;
    configModule.getConfig = originalGetConfig;
  });

  for (const route of ['/api/library/albums/cover', '/api/library/cover']) {
    const form = new FormData();
    form.append('cover', imageBlob(), 'cover.png');
    form.append('ids', JSON.stringify(['album-track']));
    const response = await postForm(baseUrl, route, token, form);
    assert.equal(response.status, 200, `${route} should accept album artwork`);
    const body = await response.json();
    assert.equal(body.items[0].id, 'album-track');
    assert.ok(await fs.pathExists(body.coverArtPath));
    generatedCovers.add(body.coverArtPath);
  }

  for (const route of ['/api/playlists/playlist-1/cover', '/api/playlists/cover/playlist-1']) {
    const form = new FormData();
    form.append('cover', imageBlob(), 'playlist.png');
    const response = await postForm(baseUrl, route, token, form);
    assert.equal(response.status, 200, `${route} should accept playlist artwork`);
    const body = await response.json();
    assert.equal(body.id, 'playlist-1');
    assert.ok(await fs.pathExists(body.coverArt));
    generatedCovers.add(body.coverArt);
  }

  const upload = new FormData();
  upload.append('files', new Blob([Buffer.from('track one')], { type: 'audio/mpeg' }), 'one.mp3');
  upload.append('files', new Blob([Buffer.from('track two')], { type: 'audio/mpeg' }), 'two.mp3');
  upload.append('cover', imageBlob(), 'new-album.png');
  upload.append('metadata', JSON.stringify({ album: 'New album' }));
  const uploadResponse = await postForm(baseUrl, '/api/upload/music', token, upload);
  assert.equal(uploadResponse.status, 200, 'new-media upload should accept optional artwork');
  const uploadBody = await uploadResponse.json();
  assert.equal(uploadBody.items.length, 2);
  assert.equal(uploadBody.items[0].coverArtPath, uploadBody.items[1].coverArtPath,
    'one persisted cover should be shared by a batch');
  assert.ok(await fs.pathExists(uploadBody.items[0].coverArtPath));
  generatedCovers.add(uploadBody.items[0].coverArtPath);
});
