'use strict';

(function bootBeeefAuthSync() {
  const AUTH_MODAL_ID = 'authModal';
  const SESSION_STORAGE_KEY = 'beeef_auth_session';
  const DIRECT_TOKEN_KEY = 'beeef_auth_token';
  const REFRESH_SKEW_MS = 60 * 1000;

  let authConfigPromise = null;
  let authSession = null;
  let authModalMode = 'login';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function getBackendBaseUrl() {
    return typeof BACKEND_URL !== 'undefined' ? BACKEND_URL : '';
  }

  function safeJsonParse(raw, fallback = null) {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function getLegacySupabaseSession() {
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !/^sb-.*-auth-token$/i.test(key)) continue;
        const value = safeJsonParse(localStorage.getItem(key));
        if (Array.isArray(value) && value[0] && value[0].access_token) {
          return value[0];
        }
        if (value && value.access_token) {
          return value;
        }
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const accessToken = normalizeText(raw.access_token || raw.accessToken);
    if (!accessToken) return null;

    const expiresAt = Number(raw.expires_at || raw.expiresAt || 0);
    const expiresIn = Number(raw.expires_in || raw.expiresIn || 0);
    const normalized = {
      access_token: accessToken,
      refresh_token: normalizeText(raw.refresh_token || raw.refreshToken),
      token_type: normalizeText(raw.token_type || raw.tokenType || 'bearer') || 'bearer',
      expires_at: Number.isFinite(expiresAt) && expiresAt > 0
        ? expiresAt
        : (Number.isFinite(expiresIn) && expiresIn > 0 ? nowSeconds() + expiresIn : 0),
      expires_in: expiresIn > 0 ? expiresIn : 0,
      user: raw.user && typeof raw.user === 'object' ? raw.user : null,
    };
    return normalized;
  }

  function getSupabaseProjectRef(url) {
    try {
      return new URL(url).hostname.split('.')[0] || '';
    } catch (_) {
      return '';
    }
  }

  function persistSession(session) {
    authSession = normalizeSession(session);
    try {
      if (!authSession) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        localStorage.removeItem(DIRECT_TOKEN_KEY);
        return;
      }
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(authSession));
      localStorage.setItem(DIRECT_TOKEN_KEY, authSession.access_token);
    } catch (_) {
      // Ignore storage errors.
    }
  }

  function clearSessionStorage() {
    authSession = null;
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
      localStorage.removeItem(DIRECT_TOKEN_KEY);
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key && /^sb-.*-auth-token$/i.test(key)) {
          localStorage.removeItem(key);
        }
      }
    } catch (_) {
      // Ignore storage errors.
    }
  }

  function restoreSessionFromStorage() {
    if (authSession) return authSession;

    const stored = safeJsonParse(localStorage.getItem(SESSION_STORAGE_KEY));
    const normalizedStored = normalizeSession(stored);
    if (normalizedStored) {
      authSession = normalizedStored;
      return authSession;
    }

    const legacy = normalizeSession(getLegacySupabaseSession());
    if (legacy) {
      authSession = legacy;
      return authSession;
    }

    const directToken = normalizeText(localStorage.getItem(DIRECT_TOKEN_KEY));
    if (directToken) {
      authSession = {
        access_token: directToken,
        refresh_token: '',
        token_type: 'bearer',
        expires_at: 0,
        expires_in: 0,
        user: null,
      };
      return authSession;
    }

    return null;
  }

  async function getPublicConfig() {
    if (!authConfigPromise) {
      authConfigPromise = fetch(`${getBackendBaseUrl()}/public/config`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      })
        .then(async response => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload?.error || `Config auth indisponible (${response.status})`);
          }
          if (!payload?.supabaseUrl || !payload?.supabasePublishableKey) {
            throw new Error('Configuration Supabase incomplète');
          }
          return payload;
        })
        .catch(error => {
          authConfigPromise = null;
          throw error;
        });
    }

    return authConfigPromise;
  }

  async function supabaseAuthFetch(path, { method = 'GET', token = '', body } = {}) {
    const { supabaseUrl, supabasePublishableKey } = await getPublicConfig();
    const headers = {
      apikey: supabasePublishableKey,
      'Content-Type': 'application/json',
    };

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(`${supabaseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        payload?.msg ||
        payload?.message ||
        payload?.error_description ||
        payload?.error ||
        `Erreur Supabase (${response.status})`
      );
    }

    return payload;
  }

  function writeLegacySupabaseSession(session) {
    const normalized = normalizeSession(session);
    if (!normalized) return;
    getPublicConfig()
      .then(({ supabaseUrl }) => {
        const projectRef = getSupabaseProjectRef(supabaseUrl);
        if (!projectRef) return;
        try {
          localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(normalized));
        } catch (_) {
          // Ignore storage errors.
        }
      })
      .catch(() => {
        // Ignore config failures here.
      });
  }

  function getAuthToken() {
    const session = restoreSessionFromStorage();
    return normalizeText(session?.access_token);
  }

  window.getAuthToken = getAuthToken;

  function setAccountButtonState(user) {
    const headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) {
      const fallbackLetter = user?.username ? String(user.username).trim().charAt(0).toUpperCase() : 'P';
      headerAvatar.textContent = fallbackLetter || 'P';
    }

    const accountLabel = document.querySelector('.account-label');
    if (accountLabel) {
      accountLabel.textContent = user?.username ? user.username : 'Compte';
    }

    const accountSub = document.querySelector('.account-sub');
    if (accountSub) {
      accountSub.textContent = user ? 'Profil & paramètres' : 'Connexion requise';
    }

    const adminBtn = document.getElementById('adminHeaderBtn');
    if (adminBtn) {
      adminBtn.style.display = user?.isAdmin ? 'inline-flex' : 'none';
    }
  }

  function setProfileModalState(user) {
    const profileName = document.querySelector('.profile-name');
    if (profileName) {
      profileName.textContent = user?.username || 'Compte invité';
    }

    const profileSince = document.querySelector('.profile-since');
    if (profileSince) {
      profileSince.textContent = user?.createdAt
        ? `Membre depuis ${new Date(user.createdAt).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}`
        : 'Connecte-toi pour synchroniser tes points';
    }

    const profileAvatar = document.querySelector('.profile-avatar-big');
    if (profileAvatar) {
      profileAvatar.textContent = (user?.username || 'P').trim().charAt(0).toUpperCase() || 'P';
    }

    const emailInput = document.getElementById('profileEmail');
    if (emailInput) {
      emailInput.value = user?.email || '';
      emailInput.readOnly = true;
    }

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.style.display = user ? 'block' : 'none';
    }
  }

  function applyLoggedOutState() {
    window.currentUser = null;
    balance = 0;
    if (typeof updateBalanceUI === 'function') {
      updateBalanceUI();
    }
    setAccountButtonState(null);
    setProfileModalState(null);
  }

  function applyBootstrapPayload(payload) {
    const user = payload?.user || null;
    window.currentUser = user;
    balance = Number(user?.balance || 0);
    if (typeof updateBalanceUI === 'function') {
      updateBalanceUI();
    }

    if (user?.region) {
      userRegion = user.region;
      localStorage.setItem('beeef_region', userRegion);
    }
    if (Array.isArray(user?.langs) && user.langs.length) {
      userLangs = user.langs.slice();
      localStorage.setItem('beeef_langs', JSON.stringify(userLangs));
    }

    if (typeof applyUserPrefs === 'function') {
      applyUserPrefs();
    }

    setAccountButtonState(user);
    setProfileModalState(user);
  }

  async function authorizedFetch(path, { method = 'GET', body } = {}) {
    const token = await ensureValidSession();
    if (!token) {
      throw new Error('Connexion requise');
    }

    const response = await fetch(`${getBackendBaseUrl()}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        clearSessionStorage();
        applyLoggedOutState();
      }
      throw new Error(payload?.error || `Erreur API (${response.status})`);
    }
    return payload;
  }

  async function refreshSessionWithToken(refreshToken) {
    const payload = await supabaseAuthFetch('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });
    persistSession(payload);
    writeLegacySupabaseSession(payload);
    return normalizeText(payload?.access_token);
  }

  async function hydrateUser(accessToken) {
    const user = await supabaseAuthFetch('/auth/v1/user', {
      method: 'GET',
      token: accessToken,
    });
    if (authSession) {
      authSession.user = user;
      persistSession(authSession);
    }
    return user;
  }

  async function ensureValidSession() {
    const session = restoreSessionFromStorage();
    if (!session?.access_token) return '';

    if (session.expires_at && (session.expires_at * 1000) <= (Date.now() + REFRESH_SKEW_MS)) {
      if (session.refresh_token) {
        return refreshSessionWithToken(session.refresh_token);
      }
      clearSessionStorage();
      applyLoggedOutState();
      return '';
    }

    if (!session.user) {
      try {
        await hydrateUser(session.access_token);
      } catch (error) {
        if (session.refresh_token) {
          return refreshSessionWithToken(session.refresh_token);
        }
        clearSessionStorage();
        applyLoggedOutState();
        return '';
      }
    }

    return session.access_token;
  }

  async function loadBootstrap({ silent = false } = {}) {
    const token = await ensureValidSession();
    if (!token) {
      applyLoggedOutState();
      return null;
    }

    try {
      const payload = await authorizedFetch('/me/bootstrap');
      applyBootstrapPayload(payload);
      return payload;
    } catch (error) {
      if (!silent && typeof showToast === 'function') {
        showToast('err', 'Session expirée', error.message || 'Reconnecte-toi');
      }
      throw error;
    }
  }

  async function syncPreferencesToProfile() {
    if (!window.currentUser) return null;
    return authorizedFetch('/me/profile', {
      method: 'PUT',
      body: {
        region: userRegion || null,
        langs: Array.isArray(userLangs) ? userLangs : [],
        phone: normalizeText(document.getElementById('phoneInput')?.value || ''),
        twoFactorEnabled: Boolean(document.getElementById('twoFaToggle')?.checked),
      },
    });
  }

  function ensureAuthModal() {
    if (document.getElementById(AUTH_MODAL_ID)) return;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = AUTH_MODAL_ID;
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <div class="modal-title" id="authModalTitle">Connexion</div>
          <div class="modal-close" onclick="window.closeAuthModal()">✕</div>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <button class="btn-secondary" id="authModeLoginBtn" type="button" style="margin:0;flex:1">Connexion</button>
          <button class="btn-secondary" id="authModeSignupBtn" type="button" style="margin:0;flex:1">Créer un compte</button>
        </div>
        <div class="form-group" id="authUsernameGroup" style="display:none">
          <label class="form-label">Pseudo</label>
          <input class="form-input" id="authUsernameInput" type="text" autocomplete="nickname" placeholder="Ton pseudo">
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input class="form-input" id="authEmailInput" type="email" autocomplete="email" placeholder="vous@email.com">
        </div>
        <div class="form-group">
          <label class="form-label">Mot de passe</label>
          <input class="form-input" id="authPasswordInput" type="password" autocomplete="current-password" placeholder="Mot de passe">
        </div>
        <div class="form-group" id="authPasswordConfirmGroup" style="display:none">
          <label class="form-label">Confirmer le mot de passe</label>
          <input class="form-input" id="authPasswordConfirmInput" type="password" autocomplete="new-password" placeholder="Confirmer">
        </div>
        <div id="authModalMessage" style="display:none;font-family:var(--fn-mono);font-size:11px;margin-bottom:12px"></div>
        <button class="btn-primary" id="authSubmitBtn" type="button">Se connecter</button>
      </div>
    `;
    overlay.addEventListener('click', event => {
      if (event.target === overlay) {
        closeAuthModal();
      }
    });
    document.body.appendChild(overlay);

    document.getElementById('authModeLoginBtn').addEventListener('click', () => setAuthMode('login'));
    document.getElementById('authModeSignupBtn').addEventListener('click', () => setAuthMode('signup'));
    document.getElementById('authSubmitBtn').addEventListener('click', submitAuthForm);
  }

  function setAuthModalMessage(message, tone = 'neutral') {
    const el = document.getElementById('authModalMessage');
    if (!el) return;
    if (!message) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = 'block';
    el.textContent = message;
    el.style.color = tone === 'error'
      ? 'var(--blood)'
      : tone === 'success'
        ? 'var(--elec)'
        : 'var(--txt3)';
  }

  function setAuthMode(mode) {
    authModalMode = mode === 'signup' ? 'signup' : 'login';
    const isSignup = authModalMode === 'signup';
    const title = document.getElementById('authModalTitle');
    const loginBtn = document.getElementById('authModeLoginBtn');
    const signupBtn = document.getElementById('authModeSignupBtn');
    const usernameGroup = document.getElementById('authUsernameGroup');
    const confirmGroup = document.getElementById('authPasswordConfirmGroup');
    const submitBtn = document.getElementById('authSubmitBtn');
    const passwordInput = document.getElementById('authPasswordInput');

    if (title) title.textContent = isSignup ? 'Créer un compte' : 'Connexion';
    if (loginBtn) loginBtn.style.borderColor = isSignup ? 'var(--line)' : 'var(--fire)';
    if (signupBtn) signupBtn.style.borderColor = isSignup ? 'var(--fire)' : 'var(--line)';
    if (usernameGroup) usernameGroup.style.display = isSignup ? 'block' : 'none';
    if (confirmGroup) confirmGroup.style.display = isSignup ? 'block' : 'none';
    if (submitBtn) submitBtn.textContent = isSignup ? 'Créer mon compte' : 'Se connecter';
    if (passwordInput) {
      passwordInput.autocomplete = isSignup ? 'new-password' : 'current-password';
    }
    setAuthModalMessage('');
  }

  function openAuthModal(mode = 'login', message = '') {
    ensureAuthModal();
    setAuthMode(mode);
    if (message) {
      setAuthModalMessage(message, 'neutral');
    }
    document.getElementById(AUTH_MODAL_ID)?.classList.add('open');
    const emailInput = document.getElementById('authEmailInput');
    if (emailInput) {
      setTimeout(() => emailInput.focus(), 30);
    }
  }

  function closeAuthModal() {
    document.getElementById(AUTH_MODAL_ID)?.classList.remove('open');
  }

  window.openAuthModal = openAuthModal;
  window.closeAuthModal = closeAuthModal;

  async function signInWithPassword(email, password) {
    return supabaseAuthFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: {
        email,
        password,
      },
    });
  }

  async function signUpWithPassword(email, password, username) {
    return supabaseAuthFetch('/auth/v1/signup', {
      method: 'POST',
      body: {
        email,
        password,
        data: {
          username,
        },
      },
    });
  }

  async function submitAuthForm() {
    const submitBtn = document.getElementById('authSubmitBtn');
    const email = normalizeText(document.getElementById('authEmailInput')?.value);
    const password = String(document.getElementById('authPasswordInput')?.value || '');
    const confirmPassword = String(document.getElementById('authPasswordConfirmInput')?.value || '');
    const username = normalizeText(document.getElementById('authUsernameInput')?.value);

    if (!email || !password) {
      setAuthModalMessage('Renseigne ton email et ton mot de passe.', 'error');
      return;
    }

    if (authModalMode === 'signup') {
      if (!username) {
        setAuthModalMessage('Ajoute un pseudo pour créer ton compte.', 'error');
        return;
      }
      if (password.length < 6) {
        setAuthModalMessage('Le mot de passe doit faire au moins 6 caractères.', 'error');
        return;
      }
      if (password !== confirmPassword) {
        setAuthModalMessage('Les mots de passe ne correspondent pas.', 'error');
        return;
      }
    }

    const originalLabel = submitBtn?.textContent || '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = authModalMode === 'signup' ? 'Création...' : 'Connexion...';
    }
    setAuthModalMessage('');

    try {
      let payload;
      if (authModalMode === 'signup') {
        payload = await signUpWithPassword(email, password, username);
        if (!payload?.access_token && payload?.user) {
          setAuthModalMessage('Compte créé. Vérifie ton email puis connecte-toi.', 'success');
          setAuthMode('login');
          document.getElementById('authPasswordInput').value = '';
          document.getElementById('authPasswordConfirmInput').value = '';
          return;
        }
      } else {
        payload = await signInWithPassword(email, password);
      }

      persistSession(payload);
      writeLegacySupabaseSession(payload);
      await hydrateUser(payload.access_token);
      const bootstrap = await loadBootstrap({ silent: true });
      if (bootstrap?.user) {
        await syncPreferencesToProfile().catch(() => null);
      }
      closeAuthModal();
      if (typeof showToast === 'function') {
        showToast('ok', authModalMode === 'signup' ? 'Compte créé' : 'Connexion réussie', 'Ton compte est synchronisé');
      }
    } catch (error) {
      setAuthModalMessage(error.message || 'Connexion impossible', 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel || (authModalMode === 'signup' ? 'Créer mon compte' : 'Se connecter');
      }
    }
  }

  async function logout() {
    const token = getAuthToken();
    try {
      if (token) {
        await supabaseAuthFetch('/auth/v1/logout', {
          method: 'POST',
          token,
          body: {},
        }).catch(() => null);
      }
      if (token) {
        await fetch(`${getBackendBaseUrl()}/auth/session`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }).catch(() => null);
      }
    } finally {
      clearSessionStorage();
      applyLoggedOutState();
      closeModal('profileModal');
      if (typeof showToast === 'function') {
        showToast('ok', 'Déconnexion faite', 'À bientôt');
      }
    }
  }

  async function refreshBalanceFromServer() {
    if (!window.currentUser) {
      applyLoggedOutState();
      return null;
    }
    const payload = await authorizedFetch('/me/balance');
    balance = Number(payload?.balance || 0);
    if (typeof updateBalanceUI === 'function') {
      updateBalanceUI();
    }
    return payload;
  }

  function bindStaticActions() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', event => {
        event.preventDefault();
        logout();
      });
    }
  }

  function overrideInteractionHooks() {
    const originalOpenProfile = window.openProfile;
    window.openProfile = function openProfileProxy() {
      if (!window.currentUser) {
        openAuthModal('login', 'Connecte-toi pour accéder à ton profil.');
        return;
      }
      if (typeof originalOpenProfile === 'function') {
        originalOpenProfile();
      }
    };

    const originalSetupFinish = window.setupFinish;
    window.setupFinish = function setupFinishProxy() {
      if (typeof originalSetupFinish === 'function') {
        originalSetupFinish();
      }
      if (!window.currentUser) {
        openAuthModal('signup', 'Crée ton compte pour synchroniser tes points et tes préférences.');
      } else {
        syncPreferencesToProfile().catch(() => null);
      }
    };

    window.saveProfile = async function saveProfileProxy() {
      if (!window.currentUser) {
        openAuthModal('login', 'Connecte-toi pour enregistrer ton profil.');
        return;
      }

      try {
        const payload = await syncPreferencesToProfile();
        if (payload?.user) {
          applyBootstrapPayload(payload);
        }
        closeModal('profileModal');
        if (typeof showToast === 'function') {
          showToast('ok', 'Profil enregistré', 'Paramètres synchronisés');
        }
      } catch (error) {
        if (typeof showToast === 'function') {
          showToast('err', 'Sauvegarde impossible', error.message || 'Réessaie');
        }
      }
    };

    window.savePwd = async function savePwdProxy() {
      const p1 = String(document.getElementById('newPwd1')?.value || '');
      const p2 = String(document.getElementById('newPwd2')?.value || '');
      if (!p1 || p1.length < 6) {
        showToast('err', 'Trop court', '6 caractères minimum');
        return;
      }
      if (p1 !== p2) {
        showToast('err', 'Ne correspond pas', '');
        return;
      }
      const token = await ensureValidSession();
      if (!token) {
        openAuthModal('login', 'Reconnecte-toi pour changer ton mot de passe.');
        return;
      }

      try {
        await supabaseAuthFetch('/auth/v1/user', {
          method: 'PUT',
          token,
          body: { password: p1 },
        });
        document.getElementById('newPwd1').value = '';
        document.getElementById('newPwd2').value = '';
        const pwdFields = document.getElementById('pwdChangeFields');
        if (pwdFields) {
          pwdFields.style.display = 'none';
        }
        if (typeof showToast === 'function') {
          showToast('ok', 'Mot de passe mis à jour', '');
        }
      } catch (error) {
        if (typeof showToast === 'function') {
          showToast('err', 'Changement impossible', error.message || 'Réessaie');
        }
      }
    };

    window.confirmDeposit = async function confirmDepositProxy() {
      if (!window.currentUser) {
        openAuthModal('login', 'Connecte-toi pour acheter des points.');
        return;
      }

      const token = await ensureValidSession();
      if (!token) {
        openAuthModal('login', 'Reconnecte-toi pour acheter des points.');
        return;
      }

      const button = document.getElementById('fundsPayBtn');
      const originalHtml = button?.innerHTML || '';
      if (button) {
        button.disabled = true;
        button.innerHTML = '<span>Redirection vers Stripe…</span>';
      }

      try {
        const response = await fetch(`${getBackendBaseUrl()}/payment/checkout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            packId: (typeof selectedPackId !== 'undefined' ? selectedPackId : null) || 'pack_popular',
            successUrl: `${window.location.origin}${window.location.pathname}?paid=ok`,
            cancelUrl: `${window.location.origin}${window.location.pathname}?paid=cancel`,
          }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload?.url) {
          throw new Error(payload?.error || payload?.message || 'Paiement indisponible');
        }
        window.location.href = payload.url;
      } catch (error) {
        if (typeof showToast === 'function') {
          showToast('err', 'Paiement indisponible', error.message || 'Réessaie');
        }
        if (button) {
          button.disabled = false;
          button.innerHTML = originalHtml;
        }
      }
    };
  }

  async function handleStripeReturn() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('paid') === 'ok') {
        if (typeof showToast === 'function') {
          showToast('coins', 'Paiement reçu', 'Tes points arrivent…');
        }
        await loadBootstrap({ silent: true }).catch(() => null);
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('paid');
        history.replaceState({}, '', cleanUrl.toString());
      } else if (params.get('paid') === 'cancel') {
        if (typeof showToast === 'function') {
          showToast('warn', 'Paiement annulé', 'Aucun point crédité');
        }
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('paid');
        history.replaceState({}, '', cleanUrl.toString());
      }
    } catch (_) {
      // Ignore URL cleanup errors.
    }
  }

  window.refreshBalanceFromServer = refreshBalanceFromServer;
  window.logout = logout;

  document.addEventListener('DOMContentLoaded', async () => {
    ensureAuthModal();
    bindStaticActions();
    overrideInteractionHooks();
    handleStripeReturn();

    try {
      await loadBootstrap({ silent: true });
      await syncPreferencesToProfile().catch(() => null);
    } catch (_) {
      applyLoggedOutState();
    }
  });
})();
