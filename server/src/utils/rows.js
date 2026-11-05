'use strict';
const bool = (v) => !!v;
const svc = (r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, prefix: r.prefix, displayOrder: r.display_order,
  estDurationMin: r.est_duration_min, isActive: bool(r.is_active), createdAt: r.created_at, updatedAt: r.updated_at });
const clinic = (r) => ({ id: r.id, nameAr: r.name_ar, nameEn: r.name_en, logoPath: r.logo_path, address: r.address,
  phone: r.phone, email: r.email, timezone: r.timezone, defaultLanguage: r.default_language,
  isActive: bool(r.is_active), updatedAt: r.updated_at });
module.exports = { svc, clinic };
