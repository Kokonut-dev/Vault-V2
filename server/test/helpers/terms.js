/**
 * For tests that are not about the Terms of Use: every profile (including
 * ones a test creates or resets later) accepts the current terms the first
 * time the gate checks it.
 *
 * This records a real acceptance through profiles.setTerms, and the real
 * services/terms.isAccepted then reads it back, so the gate's own code path
 * still runs. There is deliberately no switch in the server to turn the gate
 * off: test/terms.test.js covers what happens without acceptance.
 */
function autoAcceptTerms() {
  const terms = require('../../services/terms');
  if (terms.isAccepted.autoAccepting) return;
  const real = terms.isAccepted;
  const autoAccept = (profileId) => {
    if (!real(profileId)) {
      // Lazy, like the server: a test may mock the JSON stores first.
      const profiles = require('../../services/profiles');
      const current = terms.current();
      const profile = profiles.get(profileId || 'default');
      if (current && profile && typeof profiles.setTerms === 'function') {
        profiles.setTerms(profile.id, {
          version: current.version,
          sha256: current.sha256,
          acceptedAt: new Date().toISOString(),
          guardian: !!profile.kids,
        });
      }
    }
    if (real(profileId)) return true;
    // A test that stubs profiles.get (fresh objects per call) can't read the
    // stored acceptance back: the profile exists and has just accepted.
    const profiles = require('../../services/profiles');
    return !!(terms.current() && profiles.get(profileId || 'default'));
  };
  autoAccept.autoAccepting = true;
  terms.isAccepted = autoAccept;
}

module.exports = { autoAcceptTerms };
