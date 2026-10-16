(function () {
  const site = window.EndpointXSite;
  const form = document.getElementById('contact-form');
  if (!form) return;

  const alertBox = document.getElementById('contact-alert');
  const btn = document.getElementById('contact-submit');

  function show(type, message) {
    if (!alertBox) return;
    alertBox.className = 'alert alert-' + type;
    alertBox.textContent = message;
    alertBox.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (alertBox) alertBox.hidden = true;

    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const message = document.getElementById('message').value.trim();
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

    if (!name || !emailOk || !message) {
      show('error', site.t('contact.required'));
      return;
    }

    btn.disabled = true;
    const original = btn.dataset.label || btn.textContent;
    btn.dataset.label = original;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> ' + site.t('common.loading');

    try {
      const res = await fetch('/api/public/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          (data && data.error && data.error.message) ||
          (data && data.message) ||
          site.t('common.error');
        throw new Error(msg);
      }
      form.reset();
      show('success', site.t('contact.success'));
    } catch (err) {
      show('error', err.message || site.t('common.error'));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
})();
