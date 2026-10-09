(function () {
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var SELECTORS = [
    '.section-head',
    '.step',
    '.card',
    '.shot-card',
    '.principle',
    '.doc-link',
    '.arch-diagram',
    '.cta-band',
    '.footer-grid > div'
  ];

  var nodes = [];
  SELECTORS.forEach(function (sel) {
    Array.prototype.push.apply(nodes, document.querySelectorAll(sel));
  });
  if (!nodes.length) return;

  var counts = new Map();
  nodes.forEach(function (el) {
    var parent = el.parentElement;
    var i = counts.get(parent) || 0;
    counts.set(parent, i + 1);
    el.style.setProperty('--rd', Math.min(i * 70, 420) + 'ms');
    el.classList.add('will-reveal');
  });
  document.documentElement.classList.add('has-anim');

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          io.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -6% 0px' }
  );

  nodes.forEach(function (el) {
    io.observe(el);
  });
})();
