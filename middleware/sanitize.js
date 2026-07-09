/**
 * Sanitizes request body fields that are MongoDB ObjectIds.
 * Empty strings cause "Cast to ObjectId failed" errors.
 * Call this at the start of any route handler that saves to DB.
 */
function sanitizeIds(data, ...fields) {
  for (const field of fields) {
    if (data[field] === '' || data[field] === null || data[field] === undefined) {
      delete data[field];
    }
  }
  return data;
}

/**
 * Middleware version — strips common empty ID fields from req.body automatically
 */
function sanitizeBody(req, res, next) {
  const ID_FIELDS = [
    'customer','supplier','cashAccount','bankAccount','invoiceType',
    'location','product','cheque','category'
  ];
  for (const f of ID_FIELDS) {
    if (req.body && (req.body[f] === '' || req.body[f] === null)) {
      delete req.body[f];
    }
  }
  next();
}

module.exports = { sanitizeIds, sanitizeBody };
