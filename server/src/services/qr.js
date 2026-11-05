'use strict';
const QRCode = require('qrcode');

function baseUrl(req) {
  const env = process.env.BASE_URL;
  if (env) return env.replace(/\/+$/, '');
  // بدون BASE_URL نعتمد هيدر Host (قابل للتزوير) — يُنصح بضبط BASE_URL في .env للإنتاج
  if (req && req.get) return `${req.protocol}://${req.get('host')}`;
  throw new Error('BASE_URL is not configured');
}

function ticketUrl(base, token) { return `${base}/patient/?t=${encodeURIComponent(token)}`; }
function portalUrl(base, clinicSlug) {
  return `${base}/patient/${clinicSlug ? `?clinic=${encodeURIComponent(clinicSlug)}` : ''}`;
}

// صيغة Wi-Fi القياسية: يُهرَّب \ ; , : " في SSID وكلمة المرور
function escWifi(s) { return String(s).replace(/([\\;,:"])/g, '\\$1'); }
function wifiString({ ssid, password, type = 'WPA', hidden = false }) {
  if (!ssid) throw new Error('ssid is required');
  const t = ['WPA', 'WEP', 'nopass'].includes(type) ? type : 'WPA';
  const p = t === 'nopass' || !password ? '' : `P:${escWifi(password)};`;
  return `WIFI:T:${t};S:${escWifi(ssid)};${p}${hidden ? 'H:true;' : ''};`;
}

async function toSvg(text, opts) {
  return QRCode.toString(String(text), Object.assign({ type: 'svg', errorCorrectionLevel: 'M', margin: 2 }, opts));
}

module.exports = { baseUrl, ticketUrl, portalUrl, wifiString, toSvg, escWifi };
