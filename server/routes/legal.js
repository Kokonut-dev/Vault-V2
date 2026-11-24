/**
 * /api/legal — Terms of Use (services/terms.js).
 *
 *   GET  /terms         public: the current text, version and fingerprint
 *   GET  /status        signed in: has this profile accepted the current version?
 *   POST /terms/accept  signed in: { version, sha256, readToEnd, guardian }
 *   GET  /acceptances   admin: the evidence records kept on this server
 *
 * /status and /terms/accept are the only signed-in routes (besides switching
 * profile) that work before the terms are accepted: see terms.gateAllows.
 */
const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/requireAdmin');
const terms = require('../services/terms');
const sessions = require('../services/sessions');
const logger = require('../utils/logger');

router.get('/terms', (req, res) => {
  const current = terms.current();
  res.setHeader('Cache-Control', 'no-cache');
  if (!current) {
    return res.status(503).json({ error: 'The Terms of Use could not be loaded on this server.', code: 'TERMS_UNAVAILABLE' });
  }
  res.json({ version: current.version, effective: current.effective, sha256: current.sha256, html: current.html });
});

router.get('/status', authMiddleware, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(terms.status(req.profileId));
});

router.post('/terms/accept', authMiddleware, (req, res) => {
  const body = req.body || {};
  try {
    const session = req.user?.sid ? sessions.get(req.user.sid) : null;
    const accepted = terms.accept({
      profileId: req.profileId,
      version: typeof body.version === 'string' ? body.version : null,
      sha256: typeof body.sha256 === 'string' ? body.sha256 : null,
      readToEnd: body.readToEnd === true,
      guardian: body.guardian === true,
      user: req.user?.username || null,
      session,
      ip: req.ip || null,
    });
    logger.info(`[Terms] profile ${accepted.profileId} accepted version ${accepted.version}`);
    res.json({ accepted: true, ...accepted });
  } catch (err) {
    if (err instanceof terms.TermsError) return res.status(err.status).json({ error: err.message, code: err.code });
    logger.error('[Terms] accept failed:', err.message);
    res.status(500).json({ error: 'Could not record your acceptance. Please try again.', code: 'TERMS_SAVE_FAILED' });
  }
});

router.get('/acceptances', authMiddleware, requireAdmin, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ records: terms.records() });
});

module.exports = router;
