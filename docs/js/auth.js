/**
 * Authentication — login + grid challenge
 */
import { api } from './api.js';
import { store } from './store.js';

export class AuthManager {
  constructor() {
    this.challengeToken = null;
  }

  async login(username, password) {
    try {
      const res = await api.login(username, password);
      this.challengeToken = res.challengeToken;
      store.set('challengeToken', res.challengeToken);
      return { success: true, requiresGrid: true, challengeToken: res.challengeToken };
    } catch (err) {
      return { success: false, error: err.message, code: err.code || 'LOGIN_FAILED' };
    }
  }

  async submitGrid(pattern) {
    if (!this.challengeToken && !store.get('challengeToken')) {
      return { success: false, error: 'No challenge token. Please login again.', code: 'NO_CHALLENGE' };
    }
    const token = this.challengeToken || store.get('challengeToken');
    try {
      const res = await api.gridChallenge(token, pattern);
      store.setAuth(res.token, res.user);
      this.challengeToken = null;
      store.set('challengeToken', null);
      return { success: true, token: res.token, user: res.user };
    } catch (err) {
      return { success: false, error: err.message, code: err.code || 'GRID_FAILED' };
    }
  }

  async verify() {
    const token = store.get('token') || localStorage.getItem('vault_token');
    if (!token) return { valid: false };
    try {
      const res = await api.verify();
      store.set('isAuthenticated', res.valid);
      store.set('user', res.user);
      return res;
    } catch (err) {
      // Only clear the session when the server actively rejected the token.
      // A network error / server restart must NOT log the user out — they keep
      // their token and can retry when the server is back.
      if (err && err.status === 401) {
        store.clearAuth();
      }
      return { valid: false };
    }
  }

  async logout() {
    try {
      await api.logout();
    } catch {}
    store.clearAuth();
    window.location.reload();
  }

  isAuthenticated() {
    return !!store.get('token') && store.get('isAuthenticated');
  }
}

export const authManager = new AuthManager();
export default authManager;
