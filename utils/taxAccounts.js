// Which ledger accounts each tax posts to. Account names come from Setup → Tax Rates
// (TaxRate.account / costAccount); nothing here is decided from the tax code, except the
// legacy fallback below for taxes whose accounts are not set yet.
const TaxRate = require('../models/TaxRate');
const LedgerAccount = require('../models/LedgerAccount');

// LedgerAccount.type -> the Ledger.accountType string existing rows use for that kind of account
const ROW_TYPE = { liability: 'payable', asset: 'asset', expense: 'expense', income: 'income', equity: 'equity' };

async function loadTaxMap() {
  const [rates, accs] = await Promise.all([TaxRate.find({ active: true }).lean(), LedgerAccount.find().lean()]);
  const typeOf = Object.fromEntries(accs.map(a => [a.name, ROW_TYPE[a.type] || 'expense']));
  const map = {};
  for (const r of rates) {
    const account = r.account || '', costAccount = r.costAccount || r.account || '';
    map[r.code] = { name: r.name, rate: r.rate || 0, account, costAccount, creditable: !!r.creditable, businessTax: !!r.businessTax,
      accountType: typeOf[account] || 'payable', costAccountType: typeOf[costAccount] || 'expense' };
  }
  return map;
}

// Only allowed fallback: a tax with no account set yet keeps posting to the names used before
// tax accounts existed, so nothing breaks until the owner sets them (Tax Rates shows a badge).
const warned = new Set();
function warnLegacy(code) {
  if (warned.has(code)) return;
  warned.add(code);
  console.warn(`[tax] ${code || '(no code)'} has no tax account set in Tax Rates — using the old account name`);
}
const LEGACY_PURCHASE = { VAT: ['Input VAT', 'asset'], PAL: ['PAL Expense', 'expense'], CUST_DUTY: ['Customs Duty', 'expense'] };
function legacyPurchase(code) {
  const [account, accountType] = LEGACY_PURCHASE[code] || ['Other Purchase Taxes', 'expense'];
  return { account, accountType };
}

function taxOf(map, code) {
  const t = map[code];
  if (t && t.account) return t;
  warnLegacy(code);
  return null;
}

// Sales. tl = { taxCode, amount }. Customer-paid tax: Cr tax account. Business tax (yours, not on
// the invoice total): Dr cost account, Cr tax account. reverse=true gives the exact opposite (returns).
function saleTaxRows(map, tl, base, reverse = false) {
  const t = taxOf(map, tl.taxCode), amt = tl.amount || 0;
  const acc  = t ? { account: t.account, accountType: t.accountType } : { account: tl.taxCode + ' Payable', accountType: 'payable' };
  const cost = t ? { account: t.costAccount, accountType: t.costAccountType } : { account: tl.taxCode + ' Expense', accountType: 'expense' };
  const dr = x => ({ ...base, ...x, debit: amt, credit: 0 }), cr = x => ({ ...base, ...x, debit: 0, credit: amt });
  if (!tl.businessTax) return [reverse ? dr(acc) : cr(acc)];
  return reverse ? [dr(acc), cr(cost)] : [dr(cost), cr(acc)];
}

// Purchases. Claimable: Dr tax account. Not claimable: Dr cost account.
function purchaseTaxRow(map, code, amount, claimable, base) {
  const t = taxOf(map, code);
  const a = !t ? legacyPurchase(code)
          : claimable ? { account: t.account, accountType: t.accountType }
          : { account: t.costAccount, accountType: t.costAccountType };
  return { ...base, ...a, debit: amount, credit: 0 };
}

module.exports = { loadTaxMap, saleTaxRows, purchaseTaxRow, ROW_TYPE };
