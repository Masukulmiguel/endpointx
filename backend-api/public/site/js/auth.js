(function () {
  const site = window.EndpointXSite;
  if (!site) return;

  function showAlert(el, message, type) {
    if (!el) return;
    el.className = 'alert alert-' + (type || 'error');
    el.textContent = message;
    el.hidden = false;
  }

  function hideAlert(el) {
    if (!el) return;
    el.hidden = true;
    el.textContent = '';
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn.dataset.label = btn.textContent;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + site.t('common.loading');
    } else if (btn.dataset.label) {
      btn.textContent = btn.dataset.label;
    }
  }

  function passwordOk(password) {
    return (
      typeof password === 'string' &&
      password.length >= 12 &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password)
    );
  }

  function emailOk(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }

  function redirectToDashboard(accessToken, refreshToken) {
    // Drop any previous session before handoff so admin tokens cannot stick
    try {
      window.localStorage.removeItem('access_token');
      window.localStorage.removeItem('refresh_token');
    } catch (e) { /* ignore */ }
    const url =
      site.DASHBOARD_URL +
      '/?access_token=' +
      encodeURIComponent(accessToken) +
      '&refresh_token=' +
      encodeURIComponent(refreshToken);
    window.location.replace(url);
  }

  async function postJson(path, body) {
    const res = await fetch(site.API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(function () {
      return null;
    });
    if (!res.ok) {
      var msg =
        (data && data.error && (data.error.message || data.error)) ||
        (data && data.message) ||
        site.t('common.error');
      if (data && data.error && data.error.details && data.error.details.length) {
        msg = data.error.details.map(function (d) {
          return d.message;
        }).join(' ');
      }
      throw new Error(msg);
    }
    return data;
  }

  // Login form
  var loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var alertBox = document.getElementById('auth-alert');
      var btn = document.getElementById('login-submit');
      hideAlert(alertBox);

      var email = document.getElementById('email').value;
      var password = document.getElementById('password').value;

      if (!emailOk(email)) {
        showAlert(alertBox, site.t('login.emailRequired'));
        return;
      }
      if (!password) {
        showAlert(alertBox, site.t('login.passwordRequired'));
        return;
      }

      setLoading(btn, true);
      try {
        var result = await postJson('/auth/login', { email: email.trim(), password: password });
        var payload = result && result.data;
        if (payload && payload.requiresMfa) {
          // MFA temp token: store and hand off to dashboard login flow
          sessionStorage.setItem('endpointx_mfa_temp', payload.tempToken);
          window.location.replace(site.DASHBOARD_URL + '/login');
          return;
        }
        if (!payload || !payload.accessToken) {
          throw new Error(site.t('common.error'));
        }
        redirectToDashboard(payload.accessToken, payload.refreshToken);
      } catch (err) {
        showAlert(alertBox, err.message || site.t('common.error'));
        setLoading(btn, false);
      }
    });
  }

  // Register form
  var registerForm = document.getElementById('register-form');
  if (registerForm) {
    registerForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var alertBox = document.getElementById('auth-alert');
      var btn = document.getElementById('register-submit');
      hideAlert(alertBox);

      var full_name = document.getElementById('full_name').value;
      var email = document.getElementById('email').value;
      var password = document.getElementById('password').value;

      if (!full_name.trim()) {
        showAlert(alertBox, site.t('register.nameRequired'));
        return;
      }
      if (!emailOk(email)) {
        showAlert(alertBox, site.t('register.emailInvalid'));
        return;
      }
      if (!passwordOk(password)) {
        showAlert(alertBox, site.t('register.passwordWeak'));
        return;
      }

      setLoading(btn, true);
      try {
        var result = await postJson('/auth/register', {
          full_name: full_name.trim(),
          email: email.trim(),
          password: password,
        });
        var payload = result && result.data;
        showAlert(alertBox, site.t('register.success'), 'success');
        if (payload && payload.accessToken) {
          redirectToDashboard(payload.accessToken, payload.refreshToken);
        } else {
          window.location.replace('/login.html');
        }
      } catch (err) {
        showAlert(alertBox, err.message || site.t('common.error'));
        setLoading(btn, false);
      }
    });
  }

  // Forgot password form
  var forgotForm = document.getElementById('forgot-form');
  if (forgotForm) {
    forgotForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var alertBox = document.getElementById('auth-alert');
      var btn = document.getElementById('forgot-submit');
      hideAlert(alertBox);

      var email = document.getElementById('email').value;
      if (!emailOk(email)) {
        showAlert(alertBox, site.t('login.emailRequired'));
        return;
      }

      setLoading(btn, true);
      try {
        await postJson('/auth/forgot-password', { email: email.trim() });
        showAlert(alertBox, site.t('forgot.sent'), 'success');
        forgotForm.reset();
      } catch (err) {
        showAlert(alertBox, err.message || site.t('common.error'));
      } finally {
        setLoading(btn, false);
      }
    });
  }

  document.querySelectorAll('[data-i18n-text]').forEach(function (el) {
    el.textContent = site.t(el.getAttribute('data-i18n-text'));
  });
})();
