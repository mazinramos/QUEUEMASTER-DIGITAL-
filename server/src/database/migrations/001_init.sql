CREATE TABLE clinics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL, name_en TEXT,
  logo_path TEXT, address TEXT, phone TEXT, email TEXT,
  timezone TEXT NOT NULL DEFAULT 'Africa/Cairo',
  default_language TEXT NOT NULL DEFAULT 'ar' CHECK (default_language IN ('ar','en')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE clinic_settings (
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (clinic_id, key)
);

CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL, name_en TEXT,
  prefix TEXT NOT NULL CHECK (length(prefix) BETWEEN 1 AND 3),
  display_order INTEGER NOT NULL DEFAULT 0,
  est_duration_min INTEGER NOT NULL DEFAULT 10 CHECK (est_duration_min > 0),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (clinic_id, prefix)
);

CREATE TABLE counters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name_ar TEXT NOT NULL, name_en TEXT,
  number INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (clinic_id, number)
);

CREATE TABLE counter_services (
  counter_id INTEGER NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (counter_id, service_id)
);

CREATE TABLE staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  username TEXT NOT NULL, password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','staff')),
  default_counter_id INTEGER REFERENCES counters(id) ON DELETE SET NULL,
  can_skip_return INTEGER NOT NULL DEFAULT 0,
  can_cancel INTEGER NOT NULL DEFAULT 0,
  can_transfer INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (clinic_id, username)
);

CREATE TABLE staff_services (
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE daily_sequences (
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  business_date TEXT NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (clinic_id, service_id, business_date)
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services(id),
  business_date TEXT NOT NULL,
  seq_number INTEGER NOT NULL,
  display_number TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','called','serving','completed','skipped','cancelled')),
  counter_id INTEGER REFERENCES counters(id),
  called_by INTEGER REFERENCES staff(id),
  priority INTEGER NOT NULL DEFAULT 0,
  issued_at TEXT NOT NULL, called_at TEXT, serving_at TEXT, completed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (clinic_id, service_id, business_date, seq_number)
);
CREATE INDEX idx_tickets_queue ON tickets (clinic_id, service_id, business_date, status, priority DESC, seq_number);
CREATE INDEX idx_tickets_counter ON tickets (counter_id, status);

CREATE TABLE ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uid TEXT NOT NULL UNIQUE,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  staff_id INTEGER REFERENCES staff(id),
  counter_id INTEGER REFERENCES counters(id),
  from_status TEXT, to_status TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_ticket ON ticket_events (ticket_id, id);

CREATE TABLE advertisements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image','video','text')),
  file_path TEXT,
  body_text TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 15 CHECK (duration_sec BETWEEN 3 AND 300),
  priority INTEGER NOT NULL DEFAULT 0,
  starts_at TEXT, ends_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_ids TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE displays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pairing_code_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE display_settings (
  display_id INTEGER PRIMARY KEY REFERENCES displays(id) ON DELETE CASCADE,
  announce_lang TEXT NOT NULL DEFAULT 'both' CHECK (announce_lang IN ('ar','en','both')),
  audio_enabled INTEGER NOT NULL DEFAULT 1,
  volume REAL NOT NULL DEFAULT 1.0 CHECK (volume BETWEEN 0 AND 1),
  speech_rate REAL NOT NULL DEFAULT 0.9 CHECK (speech_rate BETWEEN 0.5 AND 2),
  speech_pitch REAL NOT NULL DEFAULT 1.0 CHECK (speech_pitch BETWEEN 0 AND 2),
  repeat_count INTEGER NOT NULL DEFAULT 2 CHECK (repeat_count BETWEEN 1 AND 5),
  repeat_delay_ms INTEGER NOT NULL DEFAULT 2500,
  updated_at TEXT NOT NULL
);

CREATE TABLE sms_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  phone_encrypted TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','expired')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, last_error TEXT,
  provider TEXT, purge_after TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  entity TEXT NOT NULL, entity_uid TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','synced','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL, synced_at TEXT,
  UNIQUE (entity, entity_uid, created_at)
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clinic_id INTEGER REFERENCES clinics(id) ON DELETE SET NULL,
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  details TEXT, ip TEXT, created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  sid TEXT PRIMARY KEY, staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  data TEXT NOT NULL, expires_at TEXT NOT NULL
);
