/* بطاقات المعلومات والتوعية الصحية — المحتوى الاحتياطي عند عدم وجود إعلانات (نصوص محلية بلا إنترنت). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DisplayInfoCards = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const ICONS = {
    plus: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1 11h-4v4h-4v-4H6v-4h4V6h4v4h4v4z',
    place: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z',
    phone: 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z',
    heart: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  };

  /** يعيد قائمة بطاقات وصفية: {kind, icon, kicker?, title?, text?, lines?[]} — نصوص عادية فقط. */
  function buildCards(clinic, lang, S) {
    clinic = clinic || {};
    const name = (lang === 'en' ? (clinic.name_en || clinic.name_ar) : (clinic.name_ar || clinic.name_en)) || '';
    const info = [{ kind: 'info', icon: 'plus', title: name, text: S.welcome }];
    if (clinic.address) info.push({ kind: 'info', icon: 'place', kicker: S.infoAddress, text: clinic.address });
    const lines = [];
    if (clinic.phone) lines.push(clinic.phone);
    if (clinic.email) lines.push(clinic.email);
    if (lines.length) info.push({ kind: 'info', icon: 'phone', kicker: [clinic.phone ? S.infoPhone : null, clinic.email ? S.infoEmail : null].filter(Boolean).join(' / '), lines });
    const tips = (S.tips || []).map((t) => ({ kind: 'tip', icon: 'heart', kicker: S.tip, text: t }));
    const out = [];
    for (let i = 0; i < Math.max(info.length, tips.length); i++) {
      if (info[i]) out.push(info[i]);
      if (tips[i]) out.push(tips[i]);
    }
    return out;
  }

  function renderCard(card, doc) {
    doc = doc || document;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const root = el('div', 'info-card');
    const badge = el('div', 'ic-badge');
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[card.icon] || ICONS.plus); path.setAttribute('fill', 'currentColor');
    svg.appendChild(path); badge.appendChild(svg); root.appendChild(badge);
    if (card.kicker) root.appendChild(el('div', 'ic-kicker', card.kicker));
    if (card.title) root.appendChild(el('div', 'ic-title', card.title));
    if (card.text) root.appendChild(el('div', card.title ? 'ic-kicker' : 'ic-text', card.text));
    (card.lines || []).forEach((l) => root.appendChild(el('div', 'ic-line', l)));
    return root;
  }
  return { buildCards, renderCard, ICONS };
}));
