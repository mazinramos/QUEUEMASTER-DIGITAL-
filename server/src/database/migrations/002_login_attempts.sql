-- قفل الحساب المؤقت بعد محاولات دخول فاشلة، محفوظ في DB فلا يتصفّر مع إعادة تشغيل السيرفر.
-- scope='user': key = 's:<staff_id>' للمستخدم الموجود، أو 'u:<username>' لاسم غير موجود (لا يُكشف وجود الاسم)
-- scope='ip'  : key = عنوان IP (يوقف تجريب أسماء كثيرة من جهاز واحد)
CREATE TABLE login_attempts (
  scope TEXT NOT NULL CHECK (scope IN ('user','ip')),
  key TEXT NOT NULL,
  staff_id INTEGER REFERENCES staff(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idx_login_attempts_staff ON login_attempts (staff_id);
CREATE INDEX idx_login_attempts_updated ON login_attempts (updated_at);
