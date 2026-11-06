
(() => {
  window.__gestured = false;
  if (false) { // محاكاة متصفح يشترط تفاعلاً: التفعيل يصبح true فقط بنقرة/مفتاح/لمس فعلي داخل الصفحة
    ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => addEventListener(ev, () => { window.__gestured = true; }, true));
    Object.defineProperty(navigator, 'userActivation', { get: () => ({ hasBeenActive: window.__gestured, isActive: false }), configurable: true });
  }
  const spoken = []; let activeCount = 0; let maxActive = 0; let queue = []; let busy = false; window.__spoken = spoken; window.__speech = { denyUntilGesture: false, speakMs: 150 };
  class U { constructor(t) { this.text = t; this.lang = ''; this.voice = null; this.rate = 1; this.pitch = 1; this.volume = 1; } }
  const voices = [ { name: 'Fake Arabic', lang: 'ar-SA', localService: true, default: false }, { name: 'Fake English', lang: 'en-US', localService: true, default: true } ];
  const ss = {
    getVoices: () => voices, addEventListener() {}, resume() {}, cancel() { queue = []; },
    speak(u) {
      if (window.__speech.denyUntilGesture && !window.__gestured) { setTimeout(() => u.onerror && u.onerror({ error: 'not-allowed' }), 0); return; }
      if (u.volume === 0) { setTimeout(() => u.onend && u.onend(), 0); return; }
      activeCount++; maxActive = Math.max(maxActive, activeCount); window.__maxActive = maxActive;
      spoken.push({ t: performance.now(), text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate, pitch: u.pitch, volume: u.volume });
      setTimeout(() => { activeCount--; u.onend && u.onend(); }, window.__speech.speakMs);
    },
  };
  Object.defineProperty(window, 'speechSynthesis', { value: ss, configurable: true });
  window.SpeechSynthesisUtterance = U;
})();
