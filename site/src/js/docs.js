(function () {
  const site = window.EndpointXSite;

  /* ---------- header: menu móvel ---------- */
  const header = document.querySelector('.site-header');
  const navToggle = document.querySelector('.nav-toggle');
  if (navToggle && header) {
    navToggle.addEventListener('click', () => {
      const open = header.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    header.querySelectorAll('.nav a').forEach((a) => {
      a.addEventListener('click', () => header.classList.remove('open'));
    });
  }

  /* ---------- copiar código ---------- */
  const COPIED = { pt: 'Copiado', en: 'Copied' };
  const copyLabel = document.body.getAttribute('data-copy-label') || 'Copy';
  document.addEventListener('click', (event) => {
    const btn = event.target && event.target.closest && event.target.closest('.copy-btn');
    if (!btn) return;
    const block = btn.closest('.code-block');
    const code = block && block.querySelector('code');
    if (!code || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(code.textContent)
      .then(() => {
        btn.textContent = (site && COPIED[site.getLang()]) || COPIED.en;
        setTimeout(() => {
          btn.textContent = copyLabel;
        }, 1600);
      })
      .catch(() => {});
  });

  /* ---------- pesquisa na documentação ---------- */
  const input = document.querySelector('.docs-search');
  const empty = document.querySelector('.docs-empty');
  const links = Array.from(document.querySelectorAll('.docs-side nav a[data-slug]'));
  if (input && links.length) {
    let index = [];
    fetch('/search-index.json', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        index = Array.isArray(data) ? data : [];
      })
      .catch(() => {
        index = [];
      });

    function applyFilter() {
      const query = input.value.trim().toLowerCase();
      const lang = site ? site.getLang() : 'pt';
      let visible = 0;
      if (!query) {
        links.forEach((a) => {
          a.style.display = '';
        });
        visible = links.length;
      } else {
        const slugs = new Set(
          index
            .filter((entry) => entry.lang === lang)
            .filter((entry) => (entry.title + ' ' + entry.lead).toLowerCase().includes(query))
            .map((entry) => entry.slug)
        );
        links.forEach((a) => {
          const show = slugs.has(a.getAttribute('data-slug'));
          a.style.display = show ? '' : 'none';
          if (show) visible += 1;
        });
      }
      if (empty) empty.style.display = query && visible === 0 ? 'block' : '';
    }

    input.addEventListener('input', applyFilter);
  }
})();
