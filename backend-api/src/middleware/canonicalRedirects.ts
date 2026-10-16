import { RequestHandler } from 'express';

// The redesigned site links pages without the .html extension (/, /login,
// /docs/<slug>, /en/docs/<slug>). Any request that still carries .html (old
// bookmarks, crawlers) is permanently redirected to the canonical
// extension-less URL with its query string intact (/index.html -> /, the
// other pages keep their path: /login.html -> /login). Mounted in index.ts
// BEFORE express.static, which would otherwise serve the .html file directly
// and split the site's SEO signals across two URLs.
export const canonicalHtmlRedirect: RequestHandler = (req, res, next) => {
  if (!req.path.toLowerCase().endsWith('.html')) return next();
  const target = req.path.replace(/\.html$/i, '');
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  // Stripping .html from /index.html leaves "/index", but the page's canonical
  // URL is the site root (target vazio -> "/"): /index.html -> /.
  res.redirect(301, (target === '/index' ? '/' : target || '/') + qs);
};
