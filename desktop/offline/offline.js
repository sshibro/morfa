// The "No connection" page (desktop/src-tauri: shell.rs create_window). It may call one command, `retry`
// (capabilities/offline-page.json): the shell checks the server and loads the app in this window when it answers.
(function () {
  'use strict';
  var to = new URLSearchParams(window.location.search).get('to') || 'designs';
  var button = document.getElementById('retry');
  var status = document.getElementById('status');
  var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
  var busy = false;
  var delay = 5000;

  function attempt(byHand) {
    if (busy || !invoke) return;
    busy = true;
    button.disabled = true;
    status.textContent = 'Checking the connection…';
    invoke('retry', {hash: to}).then(function (ok) {
      if (ok) {
        status.textContent = 'Back online, opening…';
        return;
      }
      status.textContent = byHand ? 'The server is still unavailable.' : '';
      busy = false;
      button.disabled = false;
      delay = Math.min(delay * 2, 60000);
      setTimeout(function () { attempt(false); }, delay);
    }, function () {
      status.textContent = 'Couldn\'t check the connection.';
      busy = false;
      button.disabled = false;
    });
  }

  button.addEventListener('click', function () { attempt(true); });
  window.addEventListener('online', function () { attempt(false); });
  setTimeout(function () { attempt(false); }, delay);
})();
