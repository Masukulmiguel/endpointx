/* EndpointX mobile enrollment service worker */
var CACHE = 'endpointx-mobile-v1';
var AGENT_KEY_URL = '/api/devices/public/__agent-id';
var HB_URL = '/api/devices/mobile/heartbeat';
var PAGE_URLS = ['/api/devices/public/mobile', '/api/devices/public/install-mobile.html'];

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    self.clients.claim().then(function () {
      // drop stale caches (older builds used 'endpointx-mobile' without the -v1 suffix),
      // carrying the stored agent id over so presence keeps working without a page reload
      return caches.keys().then(function (keys) {
        var stale = keys.filter(function (key) {
          return key.indexOf('endpointx-mobile') === 0 && key !== CACHE;
        });
        if (stale.length === 0) return null;
        return caches.open(CACHE).then(function (target) {
          return Promise.all(
            stale.map(function (key) {
              return caches
                .open(key)
                .then(function (oldCache) {
                  return oldCache.match(AGENT_KEY_URL).then(function (res) {
                    if (res) return target.put(AGENT_KEY_URL, res);
                    return null;
                  });
                })
                .then(function () {
                  return caches.delete(key);
                });
            })
          );
        });
      });
    })
  );
});

function readAgentId() {
  return caches
    .open(CACHE)
    .then(function (cache) {
      return cache.match(AGENT_KEY_URL);
    })
    .then(function (res) {
      return res ? res.text() : null;
    })
    .catch(function () {
      return null;
    });
}

function sendHeartbeat() {
  return readAgentId().then(function (id) {
    if (!id || id.indexOf('mobile-') !== 0) return;
    // network errors must reject so Background Sync retries once connectivity returns
    return fetch(HB_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: id }),
      keepalive: true,
      credentials: 'omit',
    });
  });
}

self.addEventListener('sync', function (event) {
  if (event.tag === 'endpointx-hb') event.waitUntil(sendHeartbeat());
});

self.addEventListener('periodicSync', function (event) {
  if (event.tag === 'endpointx-hb') event.waitUntil(sendHeartbeat());
});

self.addEventListener('fetch', function (event) {
  var url;
  try {
    url = new URL(event.request.url);
  } catch (e) {
    return;
  }
  if (
    url.origin === self.location.origin &&
    event.request.mode === 'navigate' &&
    PAGE_URLS.indexOf(url.pathname) !== -1
  ) {
    event.respondWith(
      fetch(event.request)
        .then(function (resp) {
          var copy = resp.clone();
          caches
            .open(CACHE)
            .then(function (cache) {
              return cache.put(event.request, copy);
            })
            .catch(function () {});
          return resp;
        })
        .catch(function () {
          return caches
            .match(event.request)
            .then(function (cached) {
              return (
                cached ||
                new Response(
                  '<!DOCTYPE html><html lang="pt"><meta charset="utf-8"><title>EndpointX</title>' +
                    '<body style="font-family:system-ui;background:#0b1220;color:#e8eef8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
                    '<p>Sem ligação. A página de registo fica disponível quando houver rede.</p></body></html>',
                  { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
                )
              );
            });
        })
    );
  }
});
