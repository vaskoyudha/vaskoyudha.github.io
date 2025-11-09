/*
  SitSense — firebase-config.js
  ------------------------------
  Tugas:
    • Inisialisasi Firebase (compat SDK)
    • Ekspor helper global: window.SitSenseFirebase
    • (Opsional) Auth anonim & presence tracking di Realtime Database

  Cara override konfigurasi tanpa mengubah file ini:
    // sebelum memuat firebase-config.js
    <script>
      window.__FIREBASE_CONFIG = {
        apiKey: "<API_KEY>",
        authDomain: "<PROJECT_ID>.firebaseapp.com",
        databaseURL: "https://<PROJECT_ID>-default-rtdb.firebaseio.com",
        projectId: "<PROJECT_ID>",
        storageBucket: "<PROJECT_ID>.appspot.com",
        messagingSenderId: "<SENDER_ID>",
        appId: "<APP_ID>"
      };
    </script>

  Catatan: API key client-side memang publik. Tetap hindari commit kredensial sensitif lain.
*/
(function(){
  const DEFAULT_CONFIG = {
    apiKey: "AIzaSyCHpITmPUoKIb2niuh0G4vhJJJ0vBM2ijE",
    authDomain: "esp32kursi-pintar.firebaseapp.com",
    databaseURL: "https://esp32kursi-pintar-default-rtdb.firebaseio.com",
    projectId: "esp32kursi-pintar",
    storageBucket: "esp32kursi-pintar.appspot.com",
    messagingSenderId: "265798521874",
    appId: "1:265798521874:web:6097e5ae6ccf8ad683b4cb"
  };

  function ensureFirebase(){
    if (!window.firebase){
      console.warn('[SitSense] Firebase SDK belum dimuat. Pastikan script compat ada di <head>.');
      return null;
    }
    return window.firebase;
  }

  function initApp(config){
    const fb = ensureFirebase(); if (!fb) return null;
    try {
      const cfg = Object.assign({}, DEFAULT_CONFIG, (window.__FIREBASE_CONFIG||{}));
      if (!fb.apps.length) fb.initializeApp(cfg);
      return fb.app();
    } catch(e){ console.warn('[SitSense] initializeApp error:', e); return null; }
  }

  async function ensureAnonAuth(auth){
    try {
      if (auth.currentUser) return auth.currentUser;
      const cred = await auth.signInAnonymously();
      return cred.user;
    } catch(e){ console.warn('[SitSense] signInAnonymously gagal:', e); return null; }
  }

  function setupPresence(db, clientPath){
    // Presence sederhana: set flag online & lastSeen di path client
    try {
      const infoRef = db.ref('.info/connected');
      infoRef.on('value', (snap)=>{
        if (!snap.val()) return; // belum terhubung
        const ref = db.ref(clientPath);
        ref.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP }).catch(()=>{});
        ref.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP }).catch(()=>{});
      });
    } catch(_) {}
  }

  function onConnected(cb){
    try {
      const db = firebase.database();
      db.ref('.info/connected').on('value', s=> cb(!!s.val()));
    } catch(_) {}
  }

  // Public API object
  const API = {
    app: null,
    auth: null,
    db: null,
    ref: (path) => API.db ? API.db.ref(path) : null,
    onConnected,
    ready: null,
  };

  // Boot
  (async function boot(){
    const app = initApp();
    if (!app) return;
    API.app = app;
    API.auth = firebase.auth();
    API.db   = firebase.database();

    // Optional anon auth (aman dipanggil meski app.js juga melakukannya)
    await ensureAnonAuth(API.auth);

    // Presence per-client (unik per tab)
    const cid = `web_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    setupPresence(API.db, `/presence/clients/${cid}`);

    // Expose promise ready
    API.ready = Promise.resolve(true);

    // Signal global
    document.dispatchEvent(new CustomEvent('sitsense:firebase:ready'));
  })();

  // Expose
  window.SitSenseFirebase = API;
})();
