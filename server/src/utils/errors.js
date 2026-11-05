'use strict';
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const E = {
  validation: (msg = 'Invalid input', details) => new AppError(400, 'VALIDATION', msg, details),
  unauthenticated: (msg = 'Authentication required') => new AppError(401, 'UNAUTHENTICATED', msg),
  forbidden: (msg = 'Forbidden') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg),
  conflict: (msg = 'Conflict') => new AppError(409, 'CONFLICT', msg),
  rateLimited: (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg),
};
module.exports = { AppError, E };
