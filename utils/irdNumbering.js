const MONTH_ABBR = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// Builds YYMMM_QQQQ_XXXXX per IRD Gazette Extraordinary No. 2463/05 (17 Nov 2025)
// - date determines YY/MMM and MUST be the invoice's issue date, not the creation timestamp (backdating support)
// - branchCode is the free-text QQQQ segment set by the user in Invoice Settings
// - serial is the already-formatted, zero-padded running number (caller decides padding)
function buildIrdNumber(date, branchCode, serial) {
  const d = date ? new Date(date) : new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mmm = MONTH_ABBR[d.getMonth()];
  const qqqq = (branchCode || '').toUpperCase().replace(/\s+/g, '');
  return `${yy}${mmm}_${qqqq}_${serial}`;
}

module.exports = { buildIrdNumber, MONTH_ABBR };
