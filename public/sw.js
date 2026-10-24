self.addEventListener('push', function(event) {
  const options = {
    body: event.data ? event.data.text() : 'Ada mesej baru dari Anak Hantu!',
    icon: '/logo.png',
    badge: '/logo.png',
    vibrate: [100, 50, 100],
    data: { dateOfArrival: Date.now() }
  };

  event.waitUntil(
    self.registration.showNotification('Anak Hantu Chat', options)
  );
});