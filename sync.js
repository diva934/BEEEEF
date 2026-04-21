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
  let authMode = 'signup';
  let authInitError = '';
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
      openAuthModal('signup');
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
      const client = requireSupabaseClient();
      if (emailChanged) {
        const { error } = await client.auth.updateUser({ email: nextEmail });
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
      const client = requireSupabaseClient();
      const { error } = await client.auth.updateUser({ password: nextPassword });
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

    if (!amount || amount < 100) {
      showToast('err', 'Pack invalide', 'Minimum 100 pts');
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
      document.getElementById('fundsSuccessSub').textContent = 'Nouveau total : ' + fmtBalance(balance);
      document.getElementById('fundsSuccess').style.display = 'block';
      showToast('coins', 'Points credites', '+' + fmtBalance(payload.depositAmount || amount));
    } catch (error) {
      showToast('err', 'Achat impossible', error.message);
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
      showToast('err', 'Minimum 50 pts', '');
      return;
    }
    if (amount > balance) {
      showToast('err', 'Points insuffisants', '');
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
    authInitError = error.message || 'Configuration Supabase manquante';
    setAuthFormEnabled(false, 'Reessayer');
    setAuthStatus('err', authInitError);
    setAuthInlineHelp('Vérifie Railway puis redéploie le backend avant de reessayer.');
    openAuthModal(getDefaultAuthMode());
  });

  async function init() {
    syncProfileDom();

    const logoutButton = getLogoutButton();
    if (logoutButton) {
      logoutButton.addEventListener('click', handleLogout);
    }

    const authForm = document.getElementById('authForm');
    authForm.addEventListener('submit', handleAuthSubmit);
    document.getElementById('authModeLogin').addEventListener('click', () => setAuthMode('login'));
    document.getElementById('authModeSignup').addEventListener('click', () => setAuthMode('signup'));
    setAuthFormEnabled(false, 'Chargement...');

    const lastEmail = localStorage.getItem(LAST_EMAIL_KEY);
    if (lastEmail) {
      document.getElementById('authEmail').value = lastEmail;
    }
    setAuthMode(lastEmail ? 'login' : 'signup');

    const config = await fetchPublicConfig();
    const supabaseModule = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    supabase = supabaseModule.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
    authInitError = '';
    setAuthFormEnabled(true);

    supabase.auth.onAuthStateChange((event, session) => {
      currentSession = session || null;

      if (!session) {
        clearLocalSession();
        if (hasCompletedSetup()) {
          openAuthModal(getDefaultAuthMode());
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
        openAuthModal(getDefaultAuthMode());
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
      .auth-view {
        display: block;
      }
      .auth-view.hidden {
        display: none;
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
      .auth-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        margin-bottom: 16px;
      }
      .auth-tab {
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.65);
        color: var(--txt2);
        border-radius: 10px;
        padding: 10px 12px;
        font-family: var(--fn-disp);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.4px;
        cursor: pointer;
        transition: all 0.18s ease;
      }
      .auth-tab:hover {
        color: var(--txt);
        border-color: rgba(255,107,53,0.24);
      }
      .auth-tab.active {
        background: linear-gradient(135deg,var(--fire),var(--fire2));
        color: #fff;
        border-color: transparent;
        box-shadow: 0 8px 24px rgba(255,107,53,0.24);
      }
      .auth-status {
        display: none;
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 12px;
        line-height: 1.5;
      }
      .auth-status.show {
        display: block;
      }
      .auth-status.info {
        border: 1px solid rgba(61, 158, 255, 0.22);
        background: rgba(61, 158, 255, 0.08);
        color: var(--ice);
      }
      .auth-status.err {
        border: 1px solid rgba(255, 69, 58, 0.22);
        background: rgba(255, 69, 58, 0.08);
        color: var(--blood);
      }
      .auth-status.ok {
        border: 1px solid rgba(48, 209, 88, 0.24);
        background: rgba(48, 209, 88, 0.08);
        color: var(--elec2);
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
      .auth-mail-hero {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 68px;
        height: 68px;
        margin: 2px auto 14px;
        border-radius: 18px;
        background:
          radial-gradient(circle at top, rgba(255,255,255,0.9), rgba(255,255,255,0.6)),
          linear-gradient(135deg, rgba(255,107,53,0.16), rgba(61,158,255,0.16));
        border: 1px solid rgba(255,107,53,0.18);
        color: var(--fire);
        box-shadow: 0 16px 36px rgba(255,107,53,0.14);
      }
      .auth-mail-title {
        margin-bottom: 10px;
        text-align: center;
      }
      .auth-mail-copy {
        color: var(--txt2);
        font-size: 13px;
        line-height: 1.7;
        text-align: center;
      }
      .auth-mail-copy strong {
        color: var(--txt);
      }
      .auth-mail-steps {
        margin-top: 16px;
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid rgba(61, 158, 255, 0.16);
        background: rgba(61, 158, 255, 0.06);
        color: var(--txt2);
        font-size: 12px;
        line-height: 1.6;
      }
      .auth-mail-actions {
        display: grid;
        gap: 10px;
        margin-top: 18px;
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
        <div class="auth-view" id="authFormView">
          <div class="auth-kicker">Compte synchronise</div>
          <div class="modal-title" style="margin-bottom:10px">Retrouve tes points partout</div>
          <div class="auth-sub" id="authSub">
            Cree ton compte puis retrouve tes points, tes paris et tes preferences sur tous tes appareils.
          </div>
          <div class="auth-tabs">
            <button class="auth-tab" id="authModeSignup" type="button">Creer un compte</button>
            <button class="auth-tab" id="authModeLogin" type="button">Connexion</button>
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
            <div class="form-group" id="authUsernameGroup">
              <label class="form-label">Pseudo (uniquement pour creer un compte)</label>
              <input class="form-input" id="authUsername" type="text" placeholder="Pierrick">
            </div>
            <button class="btn-primary" id="authSubmitBtn" type="submit">Creer mon compte</button>
          </form>
          <div class="auth-inline-help" id="authInlineHelp"></div>
          <div class="auth-status" id="authStatus"></div>
          <div class="auth-note" id="authNote">
            Tes paris, tes points, ton profil et tes preferences seront recharges automatiquement au prochain appareil.
          </div>
        </div>
        <div class="auth-view hidden" id="authMailView">
          <div class="auth-kicker">Verification email</div>
          <div class="auth-mail-hero">
            <svg class="ic" width="28" height="28" viewBox="0 0 24 24"><use href="#ic-speech"/></svg>
          </div>
          <div class="modal-title auth-mail-title" id="authMailTitle">Vérifie ton email</div>
          <div class="auth-mail-copy" id="authMailCopy">
            Tu vas recevoir un email d'authentification. Ouvre-le puis reviens te connecter.
          </div>
          <div class="auth-mail-steps" id="authMailSteps">
            1. Ouvre ta boite mail.
            <br>2. Clique sur le lien d'authentification.
            <br>3. Reviens ici pour te connecter avec le meme compte.
          </div>
          <div class="auth-mail-actions">
            <button class="btn-primary" id="authMailPrimaryBtn" type="button">Aller a la connexion</button>
            <button class="btn-secondary" id="authMailSecondaryBtn" type="button">Modifier mon email</button>
          </div>
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

  function getDetectedRegion() {
    try {
      return typeof window.detectBeeefRegion === 'function'
        ? window.detectBeeefRegion()
        : null;
    } catch (_) {
      return null;
    }
  }

  function hydrateSessionState(payload) {
    currentUser = payload.user;
    window.currentUser = currentUser;

    if (currentUser?.email) {
      localStorage.setItem(LAST_EMAIL_KEY, currentUser.email);
    }

    const detectedRegion = getDetectedRegion();
    if (detectedRegion) {
      userRegion = detectedRegion;
    } else if (currentUser.region || !userRegion) {
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

  function getLogoutButton() {
    const directMatch = document.getElementById('logoutBtn');
    if (directMatch) return directMatch;

    const buttons = document.querySelectorAll('#profileModal .btn-secondary');
    return Array.from(buttons).find(button => {
      const label = String(button.textContent || '').toLowerCase();
      return label.includes('deconnexion');
    });
  }

  function getDefaultAuthMode() {
    return localStorage.getItem(LAST_EMAIL_KEY) ? 'login' : 'signup';
  }

  function setAuthInlineHelp(message) {
    const help = document.getElementById('authInlineHelp');
    if (help) {
      help.textContent = message || '';
    }
  }

  function setAuthFormEnabled(enabled, label) {
    const submitButton = document.getElementById('authSubmitBtn');
    const username = document.getElementById('authUsername');

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = label || (authMode === 'signup' ? 'Creer mon compte' : 'Se connecter');
      submitButton.dataset.ready = enabled ? 'true' : 'false';
    }
    if (username) username.disabled = authMode !== 'signup';
  }

  function requireSupabaseClient() {
    if (supabase && supabase.auth) {
      return supabase;
    }

    throw new Error(
      authInitError ||
      'Supabase n est pas pret. Redéploie Railway avec SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY.'
    );
  }

  function setAuthStatus(kind, message) {
    const status = document.getElementById('authStatus');
    if (!status) return;

    if (!message) {
      status.className = 'auth-status';
      status.textContent = '';
      return;
    }

    status.className = `auth-status show ${kind || 'info'}`;
    status.textContent = message;
  }

  function setAuthView(view) {
    const formView = document.getElementById('authFormView');
    const mailView = document.getElementById('authMailView');

    if (formView) formView.classList.toggle('hidden', view === 'mail');
    if (mailView) mailView.classList.toggle('hidden', view !== 'mail');
  }

  function focusAuthField(field) {
    const targetId = field === 'password' ? 'authPassword' : 'authEmail';
    const input = document.getElementById(targetId);
    if (input) input.focus();
  }

  function showAuthForm(mode, focusField = 'email') {
    setAuthView('form');
    if (mode) {
      setAuthMode(mode);
    }
    focusAuthField(focusField);
  }

  function showAuthMailNotice({
    email = '',
    title = 'Vérifie ton email',
    body = '',
    primaryLabel = 'Aller a la connexion',
    primaryMode = 'login',
    primaryFocus = 'email',
    secondaryLabel = 'Modifier mon email',
    secondaryMode = 'signup',
    secondaryFocus = 'email',
  } = {}) {
    const copy = document.getElementById('authMailCopy');
    const heading = document.getElementById('authMailTitle');
    const primaryBtn = document.getElementById('authMailPrimaryBtn');
    const secondaryBtn = document.getElementById('authMailSecondaryBtn');

    if (heading) heading.textContent = title;
    if (copy) {
      copy.innerHTML = body || (
        email
          ? `Un email d'authentification va etre envoye sur <strong>${email}</strong>.`
          : `Un email d'authentification va etre envoye sur ton adresse email.`
      );
    }
    if (primaryBtn) {
      primaryBtn.textContent = primaryLabel;
      primaryBtn.onclick = () => showAuthForm(primaryMode, primaryFocus);
    }
    if (secondaryBtn) {
      secondaryBtn.textContent = secondaryLabel;
      secondaryBtn.onclick = () => showAuthForm(secondaryMode, secondaryFocus);
    }

    setAuthView('mail');
  }

  function setAuthMode(mode) {
    authMode = mode === 'login' ? 'login' : 'signup';

    const isSignup = authMode === 'signup';
    const signupTab = document.getElementById('authModeSignup');
    const loginTab = document.getElementById('authModeLogin');
    const usernameGroup = document.getElementById('authUsernameGroup');
    const usernameInput = document.getElementById('authUsername');
    const submitButton = document.getElementById('authSubmitBtn');
    const sub = document.getElementById('authSub');
    const note = document.getElementById('authNote');

    if (signupTab) signupTab.classList.toggle('active', isSignup);
    if (loginTab) loginTab.classList.toggle('active', !isSignup);
    if (usernameGroup) usernameGroup.style.display = isSignup ? 'block' : 'none';
    if (usernameInput) {
      usernameInput.required = isSignup;
      if (!isSignup) usernameInput.value = '';
      usernameInput.disabled = !supabase || !isSignup;
    }
    if (submitButton) {
      submitButton.textContent = isSignup ? 'Creer mon compte' : 'Se connecter';
    }
    if (sub) {
      sub.textContent = isSignup
        ? 'Cree ton compte puis retrouve tes points, tes paris et tes preferences sur tous tes appareils.'
        : 'Connecte-toi avec ton email et ton mot de passe pour recuperer instantanement ton compte.';
    }
    if (note) {
      note.textContent = isSignup
        ? 'Si la confirmation email est activee dans Supabase, un message de verification pourra etre demande.'
        : 'Utilise le meme compte sur chaque appareil pour retrouver exactement les memes points et les memes paris.';
    }

    setAuthStatus('', '');
    setAuthInlineHelp(
      isSignup
        ? 'Mode creation: renseigne email, mot de passe et pseudo.'
        : 'Mode connexion: email + mot de passe suffisent.'
    );
    setAuthFormEnabled(Boolean(supabase), authMode === 'signup' ? 'Creer mon compte' : 'Se connecter');
  }

  function ensureLoggedIn() {
    if (currentUser) return true;
    openAuthModal(getDefaultAuthMode());
    return false;
  }

  function openAuthModal(mode) {
    showAuthForm(mode || authMode, 'email');
    const overlay = document.getElementById('authModal');
    if (!overlay) return;
    overlay.classList.add('open');
  }

  function closeAuthModal() {
    const overlay = document.getElementById('authModal');
    if (overlay) {
      overlay.classList.remove('open');
    }
    setAuthView('form');
    setAuthInlineHelp('');
    setAuthStatus('', '');
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
      const client = requireSupabaseClient();
      await client.auth.signOut();
    } catch (_) {
      // Ignore logout API failures.
    }

    clearLocalSession();
    openAuthModal('login');
    closeModal('profileModal');
    showToast('ok', 'Session fermee', 'Reconnectez-vous pour retrouver vos points');
  }

  async function handleLogout(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    try {
      const client = requireSupabaseClient();
      await client.auth.signOut();
    } catch (_) {
      // Ignore logout API failures.
    }

    closeModal('profileModal');
    if (typeof closeSettings === 'function') closeSettings();
    clearLocalSession();

    const authPassword = document.getElementById('authPassword');
    if (authPassword) authPassword.value = '';

    openAuthModal('login');
    showToast('ok', 'Session fermee', 'Reconnectez-vous pour retrouver vos points');
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();

    const submitButton = document.getElementById('authSubmitBtn');
    const help = document.getElementById('authInlineHelp');
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const username = document.getElementById('authUsername').value.trim();

    help.textContent = '';
    setAuthStatus('', '');
    submitButton.disabled = true;
    submitButton.textContent = authMode === 'signup' ? 'Creation...' : 'Connexion...';

    try {
      const client = requireSupabaseClient();
      let authResult;

      if (authMode === 'signup') {
        if (!username) {
          throw new Error('Le pseudo est requis pour creer un compte.');
        }
        authResult = await client.auth.signUp({
          email,
          password,
          options: {
            data: { username },
          },
        });
      } else {
        authResult = await client.auth.signInWithPassword({ email, password });
      }

      if (authResult.error) {
        const rawMessage = String(authResult.error.message || '').toLowerCase();
        if (authMode === 'login' && rawMessage.includes('invalid login credentials')) {
          throw new Error('Compte introuvable ou mot de passe incorrect. Passe sur "Creer un compte" si besoin.');
        }
        if (authMode === 'login' && (
          rawMessage.includes('email not confirmed') ||
          rawMessage.includes('email_not_confirmed')
        )) {
          document.getElementById('authPassword').value = '';
          showAuthMailNotice({
            email,
            title: 'Confirme ton email',
            body: `Ton compte existe deja, mais tu dois d'abord confirmer l'adresse <strong>${email}</strong> via le mail d'authentification.`,
            primaryLabel: 'Retour a la connexion',
            primaryMode: 'login',
            primaryFocus: 'password',
            secondaryLabel: 'Modifier mon email',
            secondaryMode: 'signup',
            secondaryFocus: 'email',
          });
          showToast('warn', 'Email a confirmer', 'Ouvre le mail d auth puis reconnecte-toi');
          return;
        }
        throw authResult.error;
      }

      localStorage.setItem(LAST_EMAIL_KEY, email);

      if (!authResult.data?.session) {
        document.getElementById('authPassword').value = '';
        showAuthMailNotice({
          email,
          title: 'Email d auth envoyé',
          body: `Ton compte vient d'etre cree. Tu vas recevoir un mail d'authentification sur <strong>${email}</strong> pour valider ton compte.`,
          primaryLabel: 'J ai compris',
          primaryMode: 'login',
          primaryFocus: 'email',
          secondaryLabel: 'Changer d email',
          secondaryMode: 'signup',
          secondaryFocus: 'email',
        });
        showToast('ok', 'Compte cree', 'Verifie ton email puis reconnecte-toi');
        return;
      }

      await bootstrapFromSession(authResult.data.session);
      closeAuthModal();
      document.getElementById('authPassword').value = '';
      document.getElementById('authUsername').value = '';
      await syncPrefsIfMissing();
      showToast(
        'ok',
        authMode === 'signup' ? 'Compte cree' : 'Compte connecte',
        authReady ? 'Points et paris synchronises' : 'Connexion en cours'
      );
    } catch (error) {
      setAuthStatus('err', error.message || 'Action impossible');
      help.textContent = authMode === 'signup'
        ? 'Si tu as deja un compte, passe sur l onglet Connexion.'
        : 'Si tu n as pas encore de compte, passe sur l onglet Creer un compte.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = authMode === 'signup' ? 'Creer mon compte' : 'Se connecter';
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

    const shouldSyncRegion = Boolean(userRegion) && currentUser.region !== userRegion;
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
        openAuthModal('login');
      }
      const error = new Error(payload.error || 'Requete impossible');
      error.status = response.status;
      throw error;
    }

    return payload;
  }
})();
