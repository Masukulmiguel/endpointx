(function () {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isCoarse = window.matchMedia('(max-width: 900px)').matches;

  /* ---------- header: estado ao scroll + menu móvel ---------- */
  const header = document.querySelector('.site-header');
  const navToggle = document.querySelector('.nav-toggle');

  function onScrollHeader() {
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 8);
  }
  onScrollHeader();
  window.addEventListener('scroll', onScrollHeader, { passive: true });

  if (navToggle && header) {
    navToggle.addEventListener('click', () => {
      const open = header.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    header.querySelectorAll('.nav a').forEach((a) => {
      a.addEventListener('click', () => header.classList.remove('open'));
    });
  }

  /* ---------- entradas no scroll ---------- */
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (revealEls.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      revealEls.forEach((el) => el.classList.add('revealed'));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add('revealed');
            io.unobserve(entry.target);
          });
        },
        { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
      );
      revealEls.forEach((el, i) => {
        el.style.setProperty('--d', `${(i % 4) * 70}ms`);
        io.observe(el);
      });
    }
  }

  /* ---------- parallax subtil (camadas data-plx) ---------- */
  const plxEls = Array.from(document.querySelectorAll('[data-plx]'));
  if (plxEls.length && !reduceMotion && !isCoarse) {
    let ticking = false;
    const update = () => {
      const vh = window.innerHeight;
      plxEls.forEach((el) => {
        const speed = parseFloat(el.getAttribute('data-plx')) || 0.06;
        const rect = el.getBoundingClientRect();
        const center = rect.top + rect.height / 2 - vh / 2;
        el.style.transform = `translate3d(0, ${(-center * speed).toFixed(2)}px, 0)`;
      });
      ticking = false;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }

  /* ---------- ano no footer ---------- */
  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });

  /* ---------- estatísticas públicas (dados reais, nunca inventados) ---------- */
  const statsWrap = document.querySelector('[data-stats]');
  if (statsWrap) {
    const fields = {
      version: statsWrap.querySelector('[data-stat="version"]'),
      devices: statsWrap.querySelector('[data-stat="devices"]'),
      online: statsWrap.querySelector('[data-stat="online"]'),
      users: statsWrap.querySelector('[data-stat="users"]'),
      downloads: statsWrap.querySelector('[data-stat="downloads"]'),
      updated: statsWrap.querySelector('[data-stat="updated"]'),
    };
    const EMPTY = statsWrap.getAttribute('data-stats-empty') || 'Data unavailable';
    const updatedLabel = statsWrap.getAttribute('data-stats-updated') || 'Last updated';
    let hasData = false;

    function countUp(el, target) {
      if (!el) return;
      if (reduceMotion) {
        el.textContent = target.toLocaleString();
        return;
      }
      const duration = 900;
      const start = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    function markUnavailable() {
      ['version', 'devices', 'online', 'users', 'downloads'].forEach((key) => {
        const el = fields[key];
        if (!el) return;
        el.classList.add('is-empty');
        el.textContent = EMPTY;
      });
      if (fields.updated) fields.updated.textContent = updatedLabel + ' —';
    }

    async function refresh() {
      try {
        const res = await fetch('/api/public/stats', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error('status ' + res.status);
        const data = await res.json();
        const s = (data && data.data) || data;
        if (!s || typeof s !== 'object') throw new Error('bad payload');
        hasData = true;

        if (fields.version && s.version) fields.version.textContent = 'v' + s.version;
        ['devices', 'online', 'users', 'downloads'].forEach((key) => {
          const el = fields[key];
          const value = Number(s[key]);
          if (!el) return;
          if (!Number.isFinite(value)) {
            el.classList.add('is-empty');
            el.textContent = EMPTY;
            return;
          }
          el.classList.remove('is-empty');
          countUp(el, value);
        });

        if (fields.updated && s.updated_at) {
          const when = new Date(s.updated_at);
          fields.updated.textContent =
            updatedLabel + ': ' + when.toLocaleString();
        }
      } catch (err) {
        if (!hasData) markUnavailable();
        else if (fields.updated) fields.updated.textContent = updatedLabel + ' —';
      }
    }

    refresh();
    setInterval(refresh, 5 * 60 * 1000);
  }
})();
