'use strict';
const { E } = require('../utils/errors');

// validate(zodSchema, 'body'|'query'|'params'); replaces req[source] with parsed (typed, stripped) data
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return next(E.validation('Invalid input', details));
    }
    req[source] = result.data;
    return next();
  };
}
module.exports = { validate };
