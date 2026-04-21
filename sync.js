var currentUser = window.currentUser || null;
window.currentUser = currentUser;

(function syncBeeef() {
  const LAST_EMAIL_KEY = 'beeef_last_email';

  const baseFns = {
    applyVerdictUI: typeof _origApplyVerdict !== 'undefined' ? _origApplyVerdict : applyVerdict,
    cancelWaiting,
    openFunds,
    openJoinParticipantModal,
    openProfile,
    placeBet: typeof _origPlaceBet !== 'undefined' ? _origPlaceBet : placeBet,
    setupFinish,
  };

  let authReady = false;
  let supabase = null;
  let currentSession = null;
  let lastBootstrappedToken = '';

  injectStyles();
  injectAuthModal();
  wireButtons();

  placeBet = function syncedPlaceBet(side) {
    if (!ensureLoggedIn()) return;
    return baseFns.placeBet(side);
  };

  openProfile = function syncedOpenProfile() {
    if (!ensureLoggedIn()) return;
    syncProfileDom();
    return baseFns.openProfile();
  };

  openFunds = function syncedOpenFunds() {
    if (!ensureLoggedIn()) return;
    return baseFns.openFunds();
  };

  openJoinParticipantModal = function syncedOpenJoinModal() {
    if (!ensureLoggedIn()) return;
    return baseFns.openJoinParticipantModal();
  };

  setupFinish = async function syncedSetupFinish() {
    baseFns.setupFinish();
    if (document.getElementById('setupOverlay').classList.contains('open')) return;
    if (!currentUser) {
      setAuthInlineHelp('Ajoute un pseudo pour creer ton compte, ou laisse vide pour te connecter.');
      openAuthModal();
      return;
    }

    try {
      const payload = await api('/me/profile', {
        method: 'PUT',
        body: {
          region: userRegion,
          langs: userLangs,
        },
      });
      hydrateSessionState(payload);
    } catch (error) {
      showToast('warn', 'Prefs locales uniquement', error.message);
    }
  };

  saveProfile = async function syncedSaveProfile() {
    if (!ensureLoggedIn()) return;

    const emailInput = document.getElementById('profileEmail');
    const phoneInput = document.getElementById('phoneInput');
    const twoFaToggle = document.getElementById('twoFaToggle');
    const nextEmail = emailInput ? emailInput.value.trim() : currentUser.email;
    const emailChanged = nextEmail && nextEmail !== currentUser.email;

    try {
      if (emailChanged) {
        const { error } = await supabase.auth.updateUser({ email: nextEmail });
        if (error) throw error;
      }

      const payload = await api('/me/profile', {
        method: 'PUT',
        body: {
          username: currentUser.username,
          region: userRegion,
          langs: userLangs,
          phone: phoneInput ? phoneInput.value.trim() : currentUser.phone,
          twoFactorEnabled: twoFaToggle ? Boolean(twoFaToggle.checked) : currentUser.twoFactorEnabled,
        },
      });
      hydrateSessionState(payload);
      closeModal('profileModal');
      showToast(
        'ok',
        'Profil synchronise',
        emailChanged
          ? 'Profil mis a jour. Verifie ton email si Supabase demande une confirmation.'
          : 'Compte mis a jour sur tous vos appareils'
      );
    } catch (error) {
      showToast('err', 'Profil non enregistre', error.message);
    }
  };

  savePwd = async function syncedSavePwd() {
    if (!ensureLoggedIn()) return;

    const nextPassword = document.getElementById('newPwd1').value;
    const confirmPassword = document.getElementById('newPwd2').value;

    if (!nextPassword || nextPassword.length < 6) {
      showToast('err', 'Trop court', '6 caracteres minimum');
      return;
    }
    if (nextPassword !== confirmPassword) {
      showToast('err', 'Ne correspond pas', '');
      return;
    }

    try {
      const { error } = await supabase.auth.updateUser({ password: nextPassword });
      if (error) throw error;

      document.getElementById('newPwd1').value = '';
      document.getElementById('newPwd2').value = '';
      document.getElementById('pwdChangeFields').style.display = 'none';
      if (typeof pwdOpen !== 'undefined') pwdOpen = false;
      showToast('ok', 'Mot de passe mis a jour', 'Session conservee');
    } catch (error) {
      showToast('err', 'Mot de passe non modifie', error.message);
    }
  };

  confirmDeposit = async function syncedConfirmDeposit() {
    if (!ensureLoggedIn()) return;

    const customValue = parseFloat(document.getElementById('customAmount').value);
    const amount = selectedPresetVal2 === 'custom' ? customValue : parseFloat(selectedPresetVal2);

    if (!amount || amount < 10) {
      showToast('err', 'Montant invalide', 'Minimum $10');
      return;
    }

    try {
      const payload = await api('/me/deposit', {
        method: 'POST',
        body: { amount },
      });
      hydrateSessionState(payload);
      document.getElementById('fundsForm').style.display = 'none';
      document.getElementById('fundsSuccessMsg').textContent = '+' + fmtBalance(payload.depositAmount || amount) + ' ajoutes !';
      document.getElementById('fundsSuccessSub').textContent = 'Nouveau solde : ' + fmtBalance(balance);
      document.getElementById('fundsSuccess').style.display = 'block';
      showToast('coins', 'Rechargement synchronise', '+' + fmtBalance(payload.depositAmount || amount));
    } catch (error) {
      showToast('err', 'Rechargement impossible', error.message);
    }
  };

  submitJoinParticipant = async function syncedJoinParticipant() {
    if (!ensureLoggedIn()) return;
    if (!joinedSide) {
      showToast('warn', 'Choisissez votre camp', '');
      return;
    }

    const amount = parseFloat(document.getElementById('joinBetAmount').value) || 50;
    if (amount < 50) {
      showToast('err', 'Minimum $50', '');
      return;
    }
    if (amount > balance) {
      showToast('err', 'Fonds insuffisants', '');
      return;
    }

    try {
      const payload = await api('/me/bets', {
        method: 'POST',
        body: {
          debateId: String(currentDebate?.id || 'demo'),
          title: currentDebate?.title || 'Debat live',
          category: currentDebate?.category || currentDebate?.cat || 'live',
          side: joinedSide,
          yesLabel: currentDebate?.yesLabel || 'OUI',
          noLabel: currentDebate?.noLabel || 'NON',
          amount,
          kind: 'participant',
        },
      });
      hydrateSessionState(payload);
    } catch (error) {
      showToast('err', 'Participation impossible', error.message);
      return;
    }

    closeModal('joinParticipantModal');
    myBetAsParticipant = amount;
    userBetSideInRoom = joinedSide;
    if (currentDebate) {
      currentDebate._participantBet = amount;
      currentDebate._participantSide = joinedSide;
    }
    showWaitingRoom();
  };

  cancelWaiting = async function syncedCancelWaiting() {
    if (currentDebate && currentDebate._participantBet) {
      try {
        const payload = await api('/me/bets/participant/cancel', {
          method: 'POST',
          body: { debateId: String(currentDebate.id) },
        });
        hydrateSessionState(payload);
      } catch (error) {
        showToast('err', 'Remboursement impossible', error.message);
        return;
      }
    }

    document.getElementById('waitingRoom').classList.remove('open');
    rtcClose();
    if (currentDebate) {
      currentDebate._participantBet = 0;
      currentDebate._participantSide = null;
    }
    myBetAsParticipant = 0;
    syncDebateBetState();
    showToast('ok', 'Annule', 'Mise remboursee');
  };

  leaveParticipantRoom = async function syncedLeaveParticipantRoom() {
    const natural = totalDebateDuration >= MIN_DEBATE_DURATION;

    if (!natural && debateRoomActive) {
      const minutes = Math.floor(totalDebateDuration / 60);
      const confirmed = confirm(
        `Duree actuelle : ${minutes}min. Minimum requis : 15min.\n\nQuitter maintenant = perte de votre mise. Confirmer ?`
      );
      if (!confirmed) return;

      if (currentDebate) {
        try {
          const payload = await api('/me/bets/participant/forfeit', {
            method: 'POST',
            body: { debateId: String(currentDebate.id) },
          });
          hydrateSessionState(payload);
        } catch (error) {
          showToast('err', 'Abandon impossible', error.message);
          return;
        }
        currentDebate._participantBet = 0;
        currentDebate._participantSide = null;
      }

      myBetAsParticipant = 0;
    }

    endParticipantRoom(natural);
  };

  applyVerdict = async function syncedApplyVerdict(verdict, debate) {
    syncDebateBetState();
    baseFns.applyVerdictUI(verdict, debate);

    try {
      const oddsRaw = verdict.winnerSide === 'yes'
        ? parseFloat(calcOdds(debate.yesPct))
        : parseFloat(calcOdds(100 - debate.yesPct));
      const odds = isNaN(oddsRaw) ? 2 : oddsRaw;
      const payload = await api('/me/bets/settle', {
        method: 'POST',
        body: {
          debateId: String(debate.id),
          winnerSide: verdict.winnerSide,
          odds,
        },
      });
      hydrateSessionState(payload);
    } catch (error) {
      showToast('warn', 'Synchro differee', error.message);
    }
  };

  init().catch(error => {
    console.error('[sync] init failed', error);
    const help = document.getElementById('authInlineHelp');
    if (help) {
      help.textContent = error.message || 'Configuration Supabase manquante';
    }
    openAuthModal();
  });

  async function init() {
    syncProfileDom();

    const logoutButton = getLogoutButton();
    if (logoutButton) {
      logoutButton.addEventListener('click', handleLogout);
    }

    const authForm = document.getElementById('authForm');
    authForm.addEventListener('submit', handleAuthSubmit);

    const lastEmail = localStorage.getItem(LAST_EMAIL_KEY);
    if (lastEmail) {
      document.getElementById('authEmail').value = lastEmail;
    }

    const config = await fetchPublicConfig();
    const supabaseModule = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    supabase = supabaseModule.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    supabase.auth.onAuthStateChange((event, session) => {
      currentSession = session || null;

      if (!session) {
        clearLocalSession();
        if (hasCompletedSetup()) {
          setAuthInlineHelp('Ajoute un pseudo pour creer ton compte, ou laisse vide pour te connecter.');
          openAuthModal();
        } else {
          closeAuthModal();
        }
        return;
      }

      bootstrapFromSession(session).catch(error => {
        console.error('[sync] auth state bootstrap failed', error);
      });
    });

    const sessionResult = await supabase.auth.getSession();
    currentSession = sessionResult?.data?.session || null;

    if (currentSession) {
      await bootstrapFromSession(currentSession);
      closeAuthModal();
      await syncPrefsIfMissing();
    } else {
      if (hasCompletedSetup()) {
        setAuthInlineHelp('Ajoute un pseudo pour creer ton compte, ou laisse vide pour te connecter.');
        openAuthModal();
      } else {
        closeAuthModal();
      }
    }

    authReady = true;
  }

  function wireButtons() {
    const oldConfirmBet = document.getElementById('confirmBetBtn');
    const freshConfirmBet = oldConfirmBet.cloneNode(true);
    oldConfirmBet.replaceWith(freshConfirmBet);
    freshConfirmBet.addEventListener('click', confirmBet);
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .auth-modal {
        max-width: 430px;
      }
      .auth-kicker {
        font-family: var(--fn-mono);
        font-size: 10px;
        letter-spacing: 1.8px;
        text-transform: uppercase;
        color: var(--txt3);
        margin-bottom: 10px;
      }
      .auth-sub {
        color: var(--txt2);
        font-size: 13px;
        line-height: 1.65;
        margin-bottom: 18px;
      }
      .auth-note {
        margin-top: 14px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid rgba(61, 158, 255, 0.16);
        background: rgba(61, 158, 255, 0.06);
        color: var(--txt2);
        font-size: 12px;
        line-height: 1.55;
      }
      .auth-inline-help {
        margin-top: 10px;
        color: var(--txt3);
        font-size: 11px;
        line-height: 1.5;
      }
    `;
    document.head.appendChild(style);
  }

  function injectAuthModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'authModal';
    overlay.innerHTML = `
      <div class="modal auth-modal">
        <div class="auth-kicker">Compte synchronise</div>
        <div class="modal-title" style="margin-bottom:10px">Retrouve ton solde partout</div>
        <div class="auth-sub">
          Laisse le pseudo vide pour te connecter.
          Renseigne un pseudo pour creer un nouveau compte Supabase avec cet email.
        </div>
        <form id="authForm">
          <div class="form-group">
            <label class="form-label">Email</label>
            <input class="form-input" id="authEmail" type="email" placeholder="vous@exemple.com" required>
          </div>
          <div class="form-group">
            <label class="form-label">Mot de passe</label>
            <input class="form-input" id="authPassword" type="password" placeholder="6 caracteres minimum" minlength="6" required>
          </div>
          <div class="form-group">
            <label class="form-label">Pseudo (uniquement pour creer un compte)</label>
            <input class="form-input" id="authUsername" type="text" placeholder="Pierrick">
          </div>
          <button class="btn-primary" id="authSubmitBtn" type="submit">Continuer</button>
        </form>
        <div class="auth-inline-help" id="authInlineHelp"></div>
        <div class="auth-note">
          Tes paris, ton solde, ton profil et tes preferences seront recharges automatiquement au prochain appareil.
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function normalizeBet(raw) {
    return {
      ...raw,
      category: raw.category || raw.cat || 'general',
      cat: raw.cat || raw.category || 'general',
      ts: raw.ts ? new Date(raw.ts) : new Date(),
    };
  }

  function hydrateSessionState(payload) {
    currentUser = payload.user;
    window.currentUser = currentUser;

    if (currentUser?.email) {
      localStorage.setItem(LAST_EMAIL_KEY, currentUser.email);
    }

    if (currentUser.region || !userRegion) {
      userRegion = currentUser.region || userRegion || null;
    }
    if ((currentUser.langs && currentUser.langs.length) || !userLangs.length) {
      userLangs = Array.isArray(currentUser.langs) && currentUser.langs.length
        ? currentUser.langs.slice()
        : userLangs;
    }

    localStorage.setItem('beeef_region', userRegion || '');
    localStorage.setItem('beeef_langs', JSON.stringify(userLangs || []));

    balance = Number(currentUser.balance || 0);
    myBets.splice(0, myBets.length, ...(payload.bets || []).map(normalizeBet));
    syncDebateBetState();
    updateBalanceUI();
    applyUserPrefs();
    updateSettingsPanel();
    syncProfileDom();

    const parisView = document.getElementById('mes-paris-view');
    const classementView = document.getElementById('classement-view');
    if (parisView && parisView.style.display !== 'none') renderMyBets();
    if (classementView && classementView.style.display !== 'none') renderClassement();
  }

  function syncDebateBetState() {
    if (!Array.isArray(debates)) return;

    debates.forEach(debate => {
      debate._userBetYes = 0;
      debate._userBetNo = 0;
      debate._participantBet = 0;
      debate._participantSide = null;
    });

    myBets.forEach(bet => {
      if (bet.status !== 'pending') return;
      const debate = debates.find(item => String(item.id) === String(bet.debateId));
      if (!debate) return;

      if (bet.kind === 'participant') {
        debate._participantBet = bet.amt;
        debate._participantSide = bet.side;
        if (currentDebate && String(currentDebate.id) === String(bet.debateId)) {
          myBetAsParticipant = bet.amt;
          userBetSideInRoom = bet.side;
        }
        return;
      }

      if (bet.side === 'yes') debate._userBetYes += bet.amt;
      if (bet.side === 'no') debate._userBetNo += bet.amt;
    });
  }

  function syncProfileDom() {
    const profileModal = document.getElementById('profileModal');
    if (!profileModal) return;

    const displayName = currentUser?.username || 'Compte local';
    const initials = displayName.trim().charAt(0).toUpperCase() || 'P';

    const headerAvatar = document.getElementById('headerAvatar');
    if (headerAvatar) headerAvatar.textContent = initials;

    const avatar = profileModal.querySelector('.profile-avatar-big');
    const name = profileModal.querySelector('.profile-name');
    const since = profileModal.querySelector('.profile-since');
    const email = document.getElementById('profileEmail');
    const phone = document.getElementById('phoneInput');
    const twoFa = document.getElementById('twoFaToggle');

    if (avatar) avatar.textContent = initials;
    if (name) name.textContent = displayName;
    if (since && currentUser?.createdAt) {
      const created = new Date(currentUser.createdAt);
      since.textContent = 'Membre depuis ' + created.toLocaleDateString('fr-FR', {
        month: 'long',
        year: 'numeric',
      });
    }
    if (email) email.value = currentUser?.email || localStorage.getItem(LAST_EMAIL_KEY) || '';
    if (phone) phone.value = currentUser?.phone || '';
    if (twoFa) twoFa.checked = Boolean(currentUser?.twoFactorEnabled);
  }

  function getLogoutButton() {
    const buttons = document.querySelectorAll('#profileModal .btn-secondary');
    return Array.from(buttons).find(button => button.textContent.includes('Deconnexion') || button.textContent.includes('DÃ©connexion'));
  }

  function hasCompletedSetup() {
    return Boolean(userRegion) && Array.isArray(userLangs) && userLangs.length > 0;
  }

  function setAuthInlineHelp(message) {
    const help = document.getElementById('authInlineHelp');
    if (help) {
      help.textContent = message || '';
    }
  }

  function ensureLoggedIn() {
    if (currentUser) return true;
    setAuthInlineHelp('Ajoute un pseudo pour creer ton compte, ou laisse vide pour te connecter.');
    openAuthModal();
    return false;
  }

  function openAuthModal() {
    const overlay = document.getElementById('authModal');
    if (!overlay) return;
    overlay.classList.add('open');
    const emailInput = document.getElementById('authEmail');
    if (emailInput) {
      emailInput.focus();
    }
  }

  function closeAuthModal() {
    const overlay = document.getElementById('authModal');
    if (overlay) {
      overlay.classList.remove('open');
    }
    setAuthInlineHelp('');
  }

  function clearLocalSession() {
    lastBootstrappedToken = '';
    currentSession = null;
    currentUser = null;
    window.currentUser = null;
    balance = 0;
    myBets.splice(0, myBets.length);
    syncDebateBetState();
    updateBalanceUI();
    syncProfileDom();
  }

  async function handleLogout() {
    try {
      if (supabase) {
        await supabase.auth.signOut();
      }
    } catch (_) {
      // Ignore logout API failures.
    }

    clearLocalSession();
    setAuthInlineHelp('Ajoute un pseudo pour creer ton compte, ou laisse vide pour te connecter.');
    openAuthModal();
    closeModal('profileModal');
    showToast('ok', 'Session fermee', 'Reconnectez-vous pour recharger votre compte');
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();

    const submitButton = document.getElementById('authSubmitBtn');
    const help = document.getElementById('authInlineHelp');
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const username = document.getElementById('authUsername').value.trim();

    help.textContent = '';
    submitButton.disabled = true;

    try {
      let authResult;

      if (username) {
        authResult = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username },
          },
        });
      } else {
        authResult = await supabase.auth.signInWithPassword({ email, password });
      }

      if (authResult.error) {
        if (!username && String(authResult.error.message || '').toLowerCase().includes('invalid login credentials')) {
          throw new Error('Compte introuvable ou mot de passe incorrect. Ajoute un pseudo pour creer un compte.');
        }
        throw authResult.error;
      }

      localStorage.setItem(LAST_EMAIL_KEY, email);

      if (!authResult.data?.session) {
        help.textContent = 'Compte cree. Verifie ton email pour confirmer, puis reconnecte-toi.';
        document.getElementById('authPassword').value = '';
        return;
      }

      await bootstrapFromSession(authResult.data.session);
      closeAuthModal();
      document.getElementById('authPassword').value = '';
      document.getElementById('authUsername').value = '';
      await syncPrefsIfMissing();
      showToast(
        'ok',
        username ? 'Compte cree' : 'Compte connecte',
        authReady ? 'Solde et paris synchronises' : 'Connexion en cours'
      );
    } catch (error) {
      help.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  }

  async function bootstrapFromSession(session) {
    const accessToken = session?.access_token || '';
    currentSession = session || null;

    if (!accessToken) {
      clearLocalSession();
      return;
    }

    if (lastBootstrappedToken === accessToken && currentUser) {
      return;
    }

    const payload = await api('/me/bootstrap', { method: 'GET' }, accessToken);
    lastBootstrappedToken = accessToken;
    hydrateSessionState(payload);
  }

  async function syncPrefsIfMissing() {
    if (!currentUser) return;

    const shouldSyncRegion = !currentUser.region && userRegion;
    const shouldSyncLangs = (!currentUser.langs || !currentUser.langs.length) && Array.isArray(userLangs) && userLangs.length;
    if (!shouldSyncRegion && !shouldSyncLangs) return;

    try {
      const payload = await api('/me/profile', {
        method: 'PUT',
        body: {
          region: userRegion,
          langs: userLangs,
        },
      });
      hydrateSessionState(payload);
    } catch (_) {
      // Keep local prefs if server sync fails.
    }
  }

  async function confirmBet() {
    if (!ensureLoggedIn()) return;
    if (!pendingBetSide || !currentDebate) return;

    const side = pendingBetSide;
    pendingBetSide = null;
    closeModal('betConfirmModal');

    const amount = parseFloat(document.getElementById('betAmount').value) || 50;

    try {
      const payload = await api('/me/bets', {
        method: 'POST',
        body: {
          debateId: String(currentDebate.id),
          title: currentDebate.title,
          category: currentDebate.category || currentDebate.cat || 'general',
          side,
          yesLabel: currentDebate.yesLabel || 'OUI',
          noLabel: currentDebate.noLabel || 'NON',
          amount,
          kind: 'market',
        },
      });
      hydrateSessionState(payload);
    } catch (error) {
      showToast('err', 'Pari refuse', error.message);
      return;
    }

    if (side === 'yes') {
      const nextTotal = livePool + amount;
      const nextYes = livePool * (liveYesPct / 100) + amount;
      liveYesPct = Math.min(95, Math.max(5, Math.round((nextYes / nextTotal) * 100)));
    } else {
      const nextTotal = livePool + amount;
      liveYesPct = Math.min(95, Math.max(5, Math.round(((livePool * (liveYesPct / 100)) / nextTotal) * 100)));
    }

    livePool += amount;
    updateBettingUI();
    flashScreen(side);
    addBetEntry(
      currentUser.username || 'Vous',
      amount,
      side === 'yes' ? (currentDebate.yesLabel || 'OUI') : (currentDebate.noLabel || 'NON'),
      side
    );
    showToast(
      side === 'yes' ? 'yes' : 'no',
      'Pari synchronise',
      fmt(amount) + ' sur ' + (side === 'yes' ? (currentDebate.yesLabel || 'OUI') : (currentDebate.noLabel || 'NON'))
    );
  }

  async function fetchPublicConfig() {
    const response = await fetch(BACKEND_URL + '/public/config');
    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_) {
      payload = { error: raw || 'Configuration backend indisponible' };
    }

    if (!response.ok) {
      throw new Error(payload.error || 'Configuration backend indisponible');
    }

    if (!payload.supabaseUrl || !payload.supabasePublishableKey) {
      throw new Error('Configuration Supabase incomplète sur Railway');
    }

    return payload;
  }

  async function api(path, options, overrideToken) {
    const headers = { ...(options?.headers || {}) };
    let body = options?.body;
    const token = overrideToken || currentSession?.access_token || '';

    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    const response = await fetch(BACKEND_URL + path, {
      method: options?.method || 'GET',
      headers,
      body,
    });

    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_) {
      payload = { error: raw || 'Reponse invalide' };
    }

    if (!response.ok) {
      if (response.status === 401) {
        clearLocalSession();
        openAuthModal();
      }
      const error = new Error(payload.error || 'Requete impossible');
      error.status = response.status;
      throw error;
    }

    return payload;
  }
})();
