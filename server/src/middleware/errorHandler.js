'use strict';
const { AppError } = require('../utils/errors');
const { fail } = require('../utils/respond');
const config = require('../config');

function notFoundApi(req, res) {
  return fail(res, 404, 'NOT_FOUND', 'Route not found');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) return fail(res, err.status, err.code, err.message, err.details);
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'VALIDATION', 'Malformed JSON');
  if (err && err.type === 'entity.too.large') return fail(res, 400, 'VALIDATION', 'Payload too large');
  if (err && err.code === 'EBADCSRFTOKEN') return fail(res, 403, 'FORBIDDEN', 'Invalid CSRF token');
  if (config.env !== 'test') console.error('[error]', err);
  return fail(res, 500, 'INTERNAL', 'Internal server error');
}
module.exports = { errorHandler, notFoundApi };
