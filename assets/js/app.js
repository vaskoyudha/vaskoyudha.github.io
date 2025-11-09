/*
  SitSense — app.js
  ------------------
  Glue code: Firebase → Visual (heatmap/score) → Alerts → AI (Gemini) → TTS → Charts
  Aman dipakai meski sebagian modul belum ada (cek window.* sebelum pakai).

  Asumsi struktur Realtime Database (bisa disesuaikan di CONFIG.paths):
    /device/online           : boolean (opsional)
    /device/meta/ip          : string
    /device/meta/firmware    : string
    /sensors/pressureMatrix  : number[][] (mis. 8x8)
    /sensors/isSitting       : boolean

  Query param:
    ?demo=1  → jalankan simulasi data tanpa Firebase
*/
(function(){
  const CONFIG = {
    paths: {
      online: '/device/online',
      ip: '/device/meta/ip',
      firmware: '/device/meta/firmware',
      pressure: '/sensors/pressureMatrix',
      sitting: '/sensors/isSitting',
    },
    thresholds: { soft: 30*60, hard: 60*60 },
    score: { // bobot heuristik sederhana
      lrBias: 50, // pengaruh ketidakseimbangan kiri/kanan
      fbBias: 30, // pengaruh ketidakseimbangan depan/belakang
      intensity: 10, // pengaruh tekanan rata-rata berlebih (opsional)
      longSitPenaltyPerMinAfterSoft: 0.6, // penalti setelah soft threshold
    }
  };

  // -------- Utilities DOM --------
  const $ = (s, r=document) => r.querySelector(s);
  const setText = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };

  // -------- Firebase boot (compat) --------
  function initFirebase(){
    if (!window.firebase) { console.warn('[SitSense] Firebase SDK belum dimuat.'); return null; }
    try {
      // In compat, firebase.apps exists
      if (!firebase.apps.length) {
        // Pastikan firebase-config.js sudah memanggil initializeApp
        console.warn('[SitSense] Pastikan firebase-config.js memanggil firebase.initializeApp(config).');
      }
      return firebase;
    } catch (e) {
      console.warn('[SitSense] Gagal inisialisasi Firebase:', e);
      return null;
    }
  }

  async function ensureAuth(){
    if (!window.firebase) return;
    const auth = firebase.auth();
    try {
      const cred = await auth.signInAnonymously();
      setStatusAuth('Masuk (anonim)');
      return cred;
    } catch (e) {
      setStatusAuth('Gagal auth');
      console.warn('[SitSense] Auth error:', e);
    }
  }

  // -------- Status chips --------
  function setStatusWifi(text, ok){
    const el = $('#wifiStatus');
    if (!el) return;
    el.querySelector('span')?.replaceChildren();
    const t = document.createTextNode(text);
    (el.querySelector('span') || el).appendChild(t);
    el.style.borderColor = ok ? 'rgba(16,185,129,.35)' : 'rgba(239,68,68,.35)';
    el.style.color = ok ? '#10b981' : '#ef4444';
    el.style.background = ok ? 'rgba(16,185,129,.10)' : 'rgba(239,68,68,.10)';
  }
  function setStatusAuth(text){
    const el = $('#authStatus');
    if (!el) return;
    el.querySelector('span')?.replaceChildren();
    const t = document.createTextNode(text);
    (el.querySelector('span') || el).appendChild(t);
  }

  // -------- Device meta --------
  function setDeviceMeta({ ip, firmware, online }){
    setText('#deviceIP', ip || '—');
    setText('#deviceFW', firmware || '—');
    setText('#deviceStatus', online === true ? 'Online' : online === false ? 'Offline' : '—');
  }

  // -------- Visual boot --------
  function bootVisual(){
    if (typeof window.initPostureVisual === 'function') {
      window.initPostureVisual({ canvasId: 'heatmapCanvas' });
    }
  }

  // -------- Scoring heuristics --------
  function avgMatrix(m){
    let sum=0, n=0; for (const r of m){ for (const v of r){ sum+=Math.max(0, v||0); n++; } }
    return n? sum/n : 0;
  }
  function computeScore(matrix){
    const imbalance = window.__imbalance || { lr:0, fb:0 };
    const lr = Math.min(1, Math.abs(imbalance.lr||0));
    const fb = Math.min(1, Math.abs(imbalance.fb||0));
    const intensity = Math.min(1, avgMatrix(matrix) / 100); // asumsi skala 0..100
    const afterSoft = Math.max(0, (window.SitSenseAlerts?.getElapsedSeconds?.() || 0) - CONFIG.thresholds.soft);
    const longSitPenalty = Math.max(0, afterSoft/60) * CONFIG.score.longSitPenaltyPerMinAfterSoft;

    let s = 100
      - (lr * CONFIG.score.lrBias)
      - (fb * CONFIG.score.fbBias)
      - (intensity * CONFIG.score.intensity)
      - longSitPenalty;

    s = Math.max(0, Math.min(100, Math.round(s)));
    const label = s >= 75 ? 'Baik' : s >= 50 ? 'Perlu Koreksi' : 'Buruk';
    return { score: s, label };
  }

  // -------- Advice UI helper (fallback jika ui.js belum ada) --------
  function showAdviceText(text){
    const el = document.getElementById('adviceText');
    if (el) el.textContent = text || '—';
  }
  window.showAdviceText = window.showAdviceText || showAdviceText;

  // -------- Data handlers --------
  function handleMatrix(matrix){
    if (!Array.isArray(matrix) || !Array.isArray(matrix[0])) return;
    if (window.updateHeatmap) window.updateHeatmap(matrix);
    const { score, label } = computeScore(matrix);
    if (window.updateScore) window.updateScore(score, label);

    // Charts hooks (opsional)
    try {
      if (window.SitSenseCharts?.pushPressure){
        const avg = avgMatrix(matrix);
        window.SitSenseCharts.pushPressure(avg);
        window.SitSenseCharts.updateQuality(label);
      }
    } catch (_) {}
  }

  function handleSitting(isSitting){
    const A = window.SitSenseAlerts;
    if (!A) return;
    if (isSitting) A.startSitTimer(); else A.stopSitTimer();
  }

  async function requestAdvice(){
    try{
      const ai = window.getPostureAdvice;
      if (!ai) return;
      const advice = await ai({
        score: window.__postureScore || 60,
        imbalance: window.__imbalance || { lr:0.2, fb:0.1 },
        durationSec: window.SitSenseAlerts?.getElapsedSeconds?.() || 0,
        lastAlerts: '-',
      });
      showAdviceText(advice.text);
      window.__lastAdviceText = advice.text;
    }catch(e){ console.warn('[SitSense] getPostureAdvice error', e); }
  }

  async function speakAdvice(){
    const text = window.__lastAdviceText || ($('#adviceText')?.textContent || '').trim();
    if (!text) return;
    try{ await window.speakText?.(text, { voice: 'id-ID-Standard-A', rate: 1 }); }catch(_){}
  }

  // -------- Wire buttons --------
  function wireUI(){
    $('#btnRefreshAdvice')?.addEventListener('click', requestAdvice);
    $('#btnListenAdvice')?.addEventListener('click', speakAdvice);
  }

  // -------- Firebase listeners --------
  function attachRealtimeListeners(){
    if (!window.firebase) return;
    const db = firebase.database();

    // Connectivity (Firebase special path)
    try {
      db.ref('.info/connected').on('value', snap => {
        const val = !!snap.val();
        setStatusWifi(val ? 'Tersambung' : 'Terputus', val);
      });
    } catch (_) {}

    db.ref(CONFIG.paths.online).on('value', s => setDeviceMeta({ online: !!s.val() }));
    db.ref(CONFIG.paths.ip).on('value', s => setDeviceMeta({ ip: s.val() }));
    db.ref(CONFIG.paths.firmware).on('value', s => setDeviceMeta({ firmware: s.val() }));

    db.ref(CONFIG.paths.pressure).on('value', s => handleMatrix(s.val()));
    db.ref(CONFIG.paths.sitting).on('value', s => handleSitting(!!s.val()));
  }

  // -------- Demo mode (no Firebase) --------
  function startDemo(){
    console.info('[SitSense] DEMO mode aktif');
    // fake wifi/auth
    setStatusWifi('Demo (offline)', true);
    setStatusAuth('Demo');
    setDeviceMeta({ ip: '192.168.1.10', firmware: 'v0.9.3', online: true });

    // alerts
    window.SitSenseAlerts?.setThresholds(CONFIG.thresholds);
    window.SitSenseAlerts?.startSitTimer();

    // loop generate matrix
    let t = 0;
    setInterval(()=>{
      const N = 8; // 8x8
      const m = Array.from({length:N}, (_,i)=>Array.from({length:N}, (_,j)=>{
        const cx = (i-N/2), cy=(j-N/2);
        const rad = Math.sqrt(cx*cx+cy*cy);
        const base = 55 + 25*Math.sin((t/15)+(i/3)) + 15*Math.cos((t/18)+(j/2));
        const bump = Math.max(0, 40 - rad*6);
        return Math.max(0, base + bump + (Math.random()*4-2));
      }));
      handleMatrix(m);
      t++;
    }, 1000);
  }

  // -------- Boot --------
  document.addEventListener('DOMContentLoaded', async () => {
    try { bootVisual(); } catch(_) {}
    try { wireUI(); } catch(_) {}

    // Alerts default
    try { window.SitSenseAlerts?.setThresholds(CONFIG.thresholds); } catch(_) {}

    const isDemo = /[?&]demo=1\b/.test(location.search);
    if (isDemo){ startDemo(); return; }

    const fb = initFirebase();
    if (!fb){ startDemo(); return; }

    await ensureAuth();
    attachRealtimeListeners();

    // Advice otomatis saat threshold hard
    if (window.SitSenseAlerts?.onThresholdHit){
      window.SitSenseAlerts.onThresholdHit(async ({ type, elapsed }) => {
        if (type === 'hard'){
          await requestAdvice();
          await speakAdvice();
        }
      });
    }
  });
})();
