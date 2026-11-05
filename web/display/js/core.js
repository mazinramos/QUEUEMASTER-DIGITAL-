/* منطق الشاشة الصافي (بدون DOM) — يعمل في المتصفح (window.DisplayCore) وفي Node للاختبارات. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DisplayCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RECENT_MAX = 6;
  const FRESH_MS = 30000;

  const first = (o, keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

  function normalizeService(s) {
    if (s == null) return { prefix: '', name_ar: '', name_en: '' };
    if (typeof s === 'string') return { prefix: '', name_ar: s, name_en: s };
    return {
      prefix: first(s, ['prefix']) || '',
      name_ar: first(s, ['name_ar', 'nameAr', 'ar', 'name']) || '',
      name_en: first(s, ['name_en', 'nameEn', 'en', 'name']) || '',
    };
  }
  function normalizeCounter(c) {
    if (c == null) return null;
    if (typeof c === 'number' || typeof c === 'string') return { number: Number(c), name_ar: '', name_en: '', name: '' };
    const number = Number(first(c, ['number', 'no']));
    const name = first(c, ['name', 'name_ar', 'nameAr']) || '';
    return { number: Number.isFinite(number) ? number : null, name_ar: first(c, ['name_ar', 'nameAr']) || name, name_en: first(c, ['name_en', 'nameEn']) || '', name };
  }
  function normalizeTicket(t, counter) {
    if (!t) return null;
    const number = first(t, ['number', 'display_number', 'displayNumber']);
    if (!number) return null;
    return {
      number: String(number),
      status: t.status || 'waiting',
      service: normalizeService(t.service),
      counter: normalizeCounter(counter !== undefined ? counter : t.counter),
      calledAt: first(t, ['calledAt', 'called_at']) || null,
    };
  }
  function normalizeSettings(s) {
    s = s || {};
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '' ? Number(v) : d);
    const lang = first(s, ['announce_lang', 'announceLang']);
    const en = first(s, ['audio_enabled', 'audioEnabled']);
    return {
      announce_lang: ['ar', 'en', 'both'].includes(lang) ? lang : 'both',
      audio_enabled: en === undefined ? true : !!en,
      volume: Math.min(1, Math.max(0, num(s.volume, 1))),
      speech_rate: Math.min(2, Math.max(0.5, num(first(s, ['speech_rate', 'speechRate']), 0.9))),
      speech_pitch: Math.min(2, Math.max(0, num(first(s, ['speech_pitch', 'speechPitch']), 1))),
      repeat_count: Math.min(5, Math.max(1, Math.round(num(first(s, ['repeat_count', 'repeatCount']), 2)))),
      repeat_delay_ms: Math.min(30000, Math.max(0, Math.round(num(first(s, ['repeat_delay_ms', 'repeatDelayMs']), 2500)))),
    };
  }
  function normalizeAd(a) {
    if (!a) return null;
    const type = first(a, ['mediaType', 'media_type']);
    let url = first(a, ['url']);
    if (!url) { const fp = first(a, ['file_path', 'filePath']); if (fp) url = '/media/' + String(fp).replace(/\\/g, '/').split('/').pop(); }
    const ids = first(a, ['displayIds', 'display_ids']);
    let idList = null;
    if (Array.isArray(ids)) idList = ids.map(Number);
    else if (typeof ids === 'string' && ids) { try { const v = JSON.parse(ids); if (Array.isArray(v)) idList = v.map(Number); } catch (e) { /* تجاهل */ } }
    if (idList && !idList.length) idList = null;
    const dur = Number(first(a, ['durationSec', 'duration_sec']));
    const act = first(a, ['isActive', 'is_active']);
    return {
      id: a.id, title: a.title || '', mediaType: type, url: url || null,
      bodyText: first(a, ['bodyText', 'body_text']) || null,
      durationSec: Number.isFinite(dur) ? Math.min(300, Math.max(3, dur)) : 15,
      priority: Number(a.priority) || 0,
      startsAt: first(a, ['startsAt', 'starts_at']) || null,
      endsAt: first(a, ['endsAt', 'ends_at']) || null,
      displayIds: idList,
      isActive: act === undefined ? true : !!act,
    };
  }

  /* ---------- الإعلانات: الأهلية والترتيب ---------- */
  function isAdEligible(ad, nowMs, displayId) {
    if (!ad || !ad.isActive) return false;
    if (!['image', 'video', 'text'].includes(ad.mediaType)) return false;
    if (ad.mediaType === 'text' ? !ad.bodyText : !ad.url) return false;
    if (ad.startsAt && Date.parse(ad.startsAt) > nowMs) return false;
    if (ad.endsAt && Date.parse(ad.endsAt) <= nowMs) return false;
    if (ad.displayIds && displayId != null && !ad.displayIds.includes(Number(displayId))) return false;
    return true;
  }
  /** الأعلى أولوية أولاً في الدورة، ثم الأقدم id. */
  function eligibleAds(ads, nowMs, displayId) {
    return (ads || []).map(normalizeAd).filter((a) => isAdEligible(a, nowMs, displayId))
      .sort((a, b) => (b.priority - a.priority) || ((a.id || 0) - (b.id || 0)));
  }

  /* ---------- الأحداث ---------- */
  function createEventDeduper(max = 200) {
    const set = new Set(); const order = [];
    return {
      /** true إذا شوهد من قبل (ويتجاهله العميل). الأحداث بلا eventId لا تُعتبر مكررة. */
      seen(id) {
        if (!id) return false;
        if (set.has(id)) return true;
        set.add(id); order.push(id);
        if (order.length > max) set.delete(order.shift());
        return false;
      },
      size: () => set.size,
    };
  }
  /** عمر الحدث حسب الخادم: ts صالح وأقل من 30 ثانية. offsetMs = وقت الخادم - وقت الجهاز. */
  function isFresh(ts, nowMs, offsetMs = 0, maxAgeMs = FRESH_MS) {
    const t = Date.parse(ts);
    if (!Number.isFinite(t)) return false;
    const age = nowMs + offsetMs - t;
    return age <= maxAgeMs && age >= -maxAgeMs;
  }
  /**
   * بوابة النداء: السيرفر قد يرسل ticket:called ثم display:announcement لنفس النداء.
   * ندمج الحدثين المختلفين المصدر لنفس (تذكرة+شباك) خلال windowMs، أما تكرار نفس المصدر
   * (إعادة نداء متعمدة) فيُقبل.
   */
  function createAnnounceGate({ windowMs = 1500 } = {}) {
    let last = null;
    return {
      accept(key, source, nowMs) {
        if (last && last.key === key && last.source !== source && nowMs - last.at <= windowMs) return false;
        last = { key, source, at: nowMs };
        return true;
      },
    };
  }

  /* ---------- حالة الطابور (دوال صافية) ---------- */
  function emptyState() { return { current: [], next: [], recent: [], waitingCount: 0, focus: null, focusSeq: 0 }; }
  const sameNo = (a, b) => a && b && a.number === b.number;
  const byCalledDesc = (a, b) => String(b.calledAt || '').localeCompare(String(a.calledAt || ''));

  function applyBootstrap(prev, data) {
    const current = (data.current || []).map((t) => normalizeTicket(t)).filter(Boolean).sort(byCalledDesc);
    const next = (data.next || []).map((t) => normalizeTicket(t)).filter(Boolean);
    const recent = (data.recent || []).map((t) => normalizeTicket(t)).filter(Boolean).sort(byCalledDesc).slice(0, RECENT_MAX);
    const waiting = Number.isFinite(Number(data.waitingCount)) ? Number(data.waitingCount) : next.length;
    const keep = prev && prev.focus && current.find((t) => sameNo(t, prev.focus));
    return { current, next, recent, waitingCount: waiting, focus: keep || current[0] || null, focusSeq: prev ? prev.focusSeq : 0 };
  }

  function applyQueueUpdated(prev, p) {
    const s = Object.assign({}, prev);
    if (Array.isArray(p.current)) s.current = p.current.map((t) => normalizeTicket(t)).filter(Boolean).sort(byCalledDesc);
    if (Array.isArray(p.next)) s.next = p.next.map((t) => normalizeTicket(t)).filter(Boolean).slice(0, 3);
    if (Array.isArray(p.services)) s.waitingCount = p.services.reduce((n, x) => n + (Number(x.waiting) || 0), 0);
    if (!s.focus || !s.current.find((t) => sameNo(t, s.focus))) s.focus = s.current[0] || null;
    return s;
  }

  /** يطبّق حدث ticket:* ويعيد حالة جديدة. */
  function applyTicketEvent(prev, name, p) {
    const s = Object.assign({}, prev);
    const t = normalizeTicket(p && p.ticket, p && p.counter);
    if (!t) return s;
    const without = (list) => list.filter((x) => !sameNo(x, t));
    switch (name) {
      case 'ticket:called':
      case 'ticket:recalled': {
        const tk = Object.assign({}, t, { status: 'called', calledAt: t.calledAt || (p && p.ts) || null });
        s.current = [tk].concat(without(s.current));
        s.next = without(s.next);
        s.recent = [tk].concat(without(s.recent)).slice(0, RECENT_MAX);
        s.focus = tk; s.focusSeq = (prev.focusSeq || 0) + 1;
        break;
      }
      case 'ticket:serving': {
        const ex = s.current.find((x) => sameNo(x, t));
        const tk = Object.assign({}, ex || t, { status: 'serving', counter: t.counter || (ex && ex.counter) || null });
        s.current = s.current.map((x) => (sameNo(x, t) ? tk : x));
        if (!ex) s.current = [tk].concat(s.current);
        if (s.focus && sameNo(s.focus, t)) s.focus = tk;
        break;
      }
      case 'ticket:completed':
      case 'ticket:skipped':
      case 'ticket:cancelled':
        s.current = without(s.current); s.next = without(s.next);
        if (name === 'ticket:cancelled') s.recent = without(s.recent);
        if (s.focus && sameNo(s.focus, t)) s.focus = s.current[0] || null;
        break;
      default: break;
    }
    return s;
  }

  return {
    RECENT_MAX, FRESH_MS,
    normalizeService, normalizeCounter, normalizeTicket, normalizeSettings, normalizeAd,
    isAdEligible, eligibleAds, createEventDeduper, isFresh, createAnnounceGate,
    emptyState, applyBootstrap, applyQueueUpdated, applyTicketEvent,
  };
}));
