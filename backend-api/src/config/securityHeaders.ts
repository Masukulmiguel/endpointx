import helmet from 'helmet';

/**
 * Production security headers. The API also serves the static marketing site
 * (inline scripts/styles and Google Fonts are in active use), so the CSP
 * allows 'unsafe-inline' for scripts/styles and fonts.googleapis.com — while
 * keeping frame-ancestors/object-src locked down. The dashboard SPA gets its
 * own (stricter, connect-src aware) CSP from nginx; see admin-dashboard/nginx.conf.
 */
export const helmetOptions = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
};

export const securityHeadersMiddleware = helmet(helmetOptions);
