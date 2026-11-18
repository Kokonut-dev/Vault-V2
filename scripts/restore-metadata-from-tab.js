/*
 * One-time recovery: put typed-in song metadata back on the server.
 *
 * Before 3.0.0's fix, a rescan could replace the title / artist / album /
 * cover you typed into the upload form with the file's own (empty) tags, but
 * a browser tab that was already open kept showing the old, correct values.
 * If you still have such a tab (don't reload it!), open its developer console
 * (Safari: Develop → Show JavaScript Console; Chrome/Edge/Helium: ⌥⌘J / Ctrl+Shift+J),
 * paste everything below and press Enter. It only fills fields the server
 * currently has as blank / "Unknown …" / the filename, and downloads a JSON
 * copy of what it restored.
 */
(async () => {
  const urls = performance.getEntriesByType('resource').map(e => e.name);
  const find = name => urls.find(u => new URL(u).pathname.endsWith(`/js/${name}`))
    || new URL(`js/${name}`, document.querySelector('base')?.href || `${location.origin}/`).href;
  const { store } = await import(find('store.js'));
  const { api } = await import(find('api.js'));

  const stem = item => String(item.filename || '').replace(/\.[^.]+$/, '');
  const blank = (v, item) => v === undefined || v === null || v === ''
    || /^unknown( artist| album)?$/i.test(String(v).trim()) || v === stem(item);

  const inTab = (store.get('library') || []).filter(i => i.type === 'music' || i.type === 'audiobook');
  const onServer = new Map(((await api.getLibrary({ limit: 1000 })).items || []).map(i => [i.id, i]));
  const restored = [];
  for (const mine of inTab) {
    const theirs = onServer.get(mine.id);
    if (!theirs) continue;
    const updates = {};
    for (const key of ['title', 'artist', 'album', 'year', 'genre']) {
      if (!blank(mine[key], mine) && blank(theirs[key], theirs)) updates[key] = mine[key];
    }
    if (mine.coverArtPath && !theirs.coverArtPath) updates.coverArtPath = mine.coverArtPath;
    if (!Object.keys(updates).length) continue;
    try {
      await api.updateItem(mine.id, updates);
      restored.push({ id: mine.id, file: mine.filename, ...updates });
    } catch (err) {
      console.warn(`Could not restore ${mine.filename}: ${err.message}`);
    }
  }
  if (restored.length) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(restored, null, 2)], { type: 'application/json' }));
    a.download = 'vault-restored-metadata.json';
    a.click();
  }
  console.log(`Vault: restored metadata for ${restored.length} song(s).`, restored);
  return restored.length;
})();
