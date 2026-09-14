// Push-only service worker -- no offline caching is attempted here, matching this app's existing
// "installable but not offline-capable" PWA scope (see manifest.json history).
self.addEventListener("push", (event) => {
  let payload = { title: "Kompis Split", body: "" };
  try { payload = event.data ? event.data.json() : payload; } catch { /* keep the default */ }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Kompis Split", {
      body: payload.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
