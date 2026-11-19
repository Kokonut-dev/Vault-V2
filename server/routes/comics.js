const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');

/** Run unrar without blocking the event loop; resolves with stdout. */
function unrar(args, options) {
  return new Promise((resolve, reject) => {
    execFile('unrar', args, options, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}
const fs = require('fs-extra');
const path = require('path');
const comics = require('../services/comics');
const libraryService = require('../services/library');
const { itemParam } = require('../middleware/profileAccess');

// Age-limited profiles can't open or stream items above their limit.
router.param('id', itemParam);

function getComic(req, res) {
  const item = libraryService.getById(req.params.id);
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return null;
  }
  if (!fs.existsSync(item.path)) {
    res.status(404).json({ error: 'File not found on disk' });
    return null;
  }
  return item;
}

router.get('/:id/pages', async (req, res) => {
  const item = getComic(req, res);
  if (!item) return;
  try {
    const pages = await comics.listPages(item.path);
    res.json({
      id: item.id,
      title: item.title,
      format: path.extname(item.path).slice(1).toLowerCase(),
      pages: pages.map((p, index) => ({
        index,
        name: p.name,
        url: `/api/comics/${item.id}/page/${index}`,
      })),
      total: pages.length,
    });
  } catch (err) {
    res.status(500).json({ error: `Could not read archive: ${err.message}` });
  }
});

router.get('/:id/page/:index', async (req, res) => {
  const item = getComic(req, res);
  if (!item) return;
  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid page index' });

  try {
    const ext = path.extname(item.path).toLowerCase();
    if (ext === '.cbz') {
      const page = await comics.getPage(item.path, index);
      if (!page) return res.status(404).json({ error: 'Page not found' });
      res.setHeader('Content-Type', page.mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(page.data);
    }
    if (ext === '.cbr') {
      // RAR needs an external extractor; use one if the host has it.
      // Async with a timeout: spawnSync froze the whole server (every other
      // request) for as long as unrar took, on every page turn.
      let list;
      try {
        list = await unrar(['lb', item.path], { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 * 8 });
      } catch (err) {
        if (err.code === 'ENOENT') return res.status(415).json({ error: 'CBR archives need the `unrar` command installed (or convert the file to .cbz)' });
        return res.status(500).json({ error: 'Could not read the archive' });
      }
      const pages = list.split('\n').map(s => s.trim()).filter(f => /\.(jpe?g|png|webp|gif|avif)$/i.test(f));
      const target = pages[index];
      if (!target) return res.status(404).json({ error: 'Page not found' });
      let data;
      try {
        data = await unrar(['p', '-inul', item.path, target], { encoding: 'buffer', timeout: 20000, maxBuffer: 1024 * 1024 * 64 });
      } catch {
        return res.status(500).json({ error: 'Could not extract page' });
      }
      res.setHeader('Content-Type', comics.mimeFor(target));
      return res.send(data);
    }
    // PDF / EPUB — hand the file to the browser's native viewer.
    return res.sendFile(item.path);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  const item = getComic(req, res);
  if (!item) return;
  const ext = path.extname(item.path).toLowerCase();
  let pageCount = 0;
  try {
    pageCount = await comics.getPageCount(item.path);
  } catch {}
  res.json({
    ...item,
    reader: ext === '.cbz' ? 'cbz' : ext === '.pdf' ? 'pdf' : ext === '.epub' ? 'epub' : 'unsupported',
    pageCount,
  });
});

module.exports = router;
