const router = require('express').Router();
const mongoose = require('mongoose');
const TaxRate = require('../models/TaxRate');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const Ledger = require('../models/Ledger');
const LedgerAccount = require('../models/LedgerAccount');
const TaxSettlement = require('../models/TaxSettlement');
const CashAccount = require('../models/CashAccount');
const BankAccount = require('../models/BankAccount');
const CashEntry = require('../models/CashEntry');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { ROW_TYPE } = require('../utils/taxAccounts');

// Tax account rules: account always required; costAccount required for claimable and business
// taxes, otherwise it is the same as account (a duty whose account is itself an expense account).
async function taxAccountError(t) {
  t.account = (t.account || '').trim(); t.costAccount = (t.costAccount || '').trim();
  if (!t.account) return 'Choose the tax account (where this tax is collected and paid)';
  if ((t.creditable === true || t.businessTax === true) && !t.costAccount)
    return 'Choose the cost account (where this tax goes when you can\'t claim it back)';
  if (!t.costAccount) t.costAccount = t.account;
  for (const name of new Set([t.account, t.costAccount]))
    if (!(await LedgerAccount.exists({ name, active: true }))) return `"${name}" is not an active account in the Chart of Accounts`;
  return null;
}
const asBool = v => v === true || v === 'true';

// GET active tax rates
// Sales documents that count for tax: invoices (+) and credit notes / returns (-). Proformas never count.
const SALES_DOCS = { type: { $in: ['invoice', 'credit_note'] } };
const SIGN = { $cond: [{ $eq: ['$type', 'credit_note'] }, -1, 1] };
// Net sales = what the customer owes less customer tax (handles discount and tax-inclusive pricing)
const NET_SALES = { $multiply: [{ $subtract: ['$total', { $ifNull: ['$taxAmount', 0] }] }, SIGN] };

router.get('/', requireAuth, async (req, res) => {
  try { res.json(await TaxRate.find({ active: true }).sort({ code: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET all including inactive
router.get('/all', requireAuth, requirePermission('taxRates'), async (req, res) => {
  try { res.json(await TaxRate.find().sort({ code: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create
router.post('/', requireAuth, requirePermission('taxRates'), async (req, res) => {
  try {
    if (!req.body.code) return res.status(400).json({ error: 'Code required' });
    req.body.code = req.body.code.toUpperCase().trim().replace(/\s+/g, '_');
    req.body.creditable = asBool(req.body.creditable); req.body.businessTax = asBool(req.body.businessTax);
    const ae = await taxAccountError(req.body);
    if (ae) return res.status(400).json({ error: ae });
    const tax = new TaxRate(req.body);
    await tax.save();
    res.status(201).json(tax);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT update
router.put('/:id', requireAuth, requirePermission('taxRates'), async (req, res) => {
  try {
    const cur = await TaxRate.findById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const t = { ...cur.toObject(), ...req.body };
    t.creditable = asBool(t.creditable); t.businessTax = asBool(t.businessTax);
    const ae = await taxAccountError(t);
    if (ae) return res.status(400).json({ error: ae });
    req.body.creditable = t.creditable; req.body.businessTax = t.businessTax;
    req.body.account = t.account; req.body.costAccount = t.costAccount;
    const tax = await TaxRate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    res.json(tax);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE soft-delete
router.delete('/:id', requireAuth, requirePermission('taxRates'), async (req, res) => {
  try {
    await TaxRate.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DYNAMIC TAX REPORT ──────────────────────────────────────────────────────
// Returns per-tax breakdown for ALL user-defined taxes (no hardcoded VAT/SSCL/PAL)
router.get('/report', requireAuth, requirePermission('taxReport'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let df = {};
    if (from || to) {
      df.date = {};
      if (from) df.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); df.date.$lte = d; }
    }

    const taxRates = await TaxRate.find({ active: true }).sort({ code: 1 });

    // Get all invoice tax lines grouped by taxCode
    const invByTax = await Invoice.aggregate([
      { $match: { ...df, ...SALES_DOCS } },
      { $unwind: '$items' },
      { $unwind: { path: '$items.taxLines', preserveNullAndEmptyArrays: false } },
      { $group: {
        _id: '$items.taxLines.taxCode',
        totalAmount: { $sum: { $multiply: ['$items.taxLines.amount', SIGN] } },
        taxName:     { $first: '$items.taxLines.taxName' },
        invoiceCount: { $addToSet: '$_id' }
      }},
      { $project: { totalAmount: 1, taxName: 1, invoiceCount: { $size: '$invoiceCount' } } }
    ]);

    // Get all purchase tax lines grouped by taxCode
    const purByTax = await Purchase.aggregate([
      { $match: { ...df, status: { $ne: 'draft' } } },
      { $unwind: '$items' },
      { $unwind: { path: '$items.taxLines', preserveNullAndEmptyArrays: false } },
      { $group: {
        _id: '$items.taxLines.taxCode',
        totalAmount: { $sum: '$items.taxLines.amount' },
        taxName:     { $first: '$items.taxLines.taxName' }
      }}
    ]);

    // Build per-tax summary
    const outputTaxes = [];
    const inputTaxes  = [];
    const irdPositions = [];

    const invMap = Object.fromEntries(invByTax.map(t => [t._id, t]));
    const purMap = Object.fromEntries(purByTax.map(t => [t._id, t]));

    for (const tax of taxRates) {
      const invAmt = invMap[tax.code]?.totalAmount || 0;
      const purAmt = purMap[tax.code]?.totalAmount || 0;
      const invCnt = invMap[tax.code]?.invoiceCount || 0;

      // Show ALL taxes regardless of whether they have amounts yet
      if (tax.type === 'output' || tax.type === 'both') {
        outputTaxes.push({ code: tax.code, name: tax.name, rate: tax.rate, amount: invAmt, invoiceCount: invCnt, creditable: tax.creditable });
      }
      if (tax.type === 'input' || tax.type === 'both') {
        inputTaxes.push({ code: tax.code, name: tax.name, rate: tax.rate, amount: purAmt, creditable: tax.creditable });
      }
      // IRD position for each creditable tax
      if (tax.creditable) {
        const outputAmt = invAmt;
        const inputAmt  = purAmt;
        irdPositions.push({
          code: tax.code, name: tax.name, rate: tax.rate,
          outputAmount: outputAmt,
          inputAmount: inputAmt,
          netPayable: outputAmt - inputAmt,
          status: (outputAmt - inputAmt) > 0 ? 'payable' : 'refundable'
        });
      }
    }

    // Totals
    const totalSales = (await Invoice.aggregate([{ $match: { ...df, ...SALES_DOCS } }, { $group: { _id: null, v: { $sum: { $multiply: ['$total', SIGN] } }, s: { $sum: NET_SALES } } }]))[0] || { v:0, s:0 };
    const totalPurch = (await Purchase.aggregate([{ $match: { ...df, status: { $ne: 'draft' } } }, { $group: { _id: null, v: { $sum: '$total' } } }]))[0] || { v:0 };

    res.json({
      outputTaxes,
      inputTaxes,
      irdPositions,
      totalSalesGross:   totalSales.v,
      totalSalesNet:     totalSales.s,
      totalPurchasesGross: totalPurch.v,
      from: from || null,
      to:   to   || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TAX DETAIL DRILL-DOWN ──────────────────────────────────────────────────
// Returns all invoices/purchases that contributed to a specific tax code
router.get('/detail/:code', requireAuth, requirePermission('taxReport', 'monthlyTax'), async (req, res) => {
  try {
    const { code } = req.params;
    const { from, to } = req.query;
    let df = {};
    if (from || to) {
      df.date = {};
      if (from) df.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); df.date.$lte = d; }
    }

    const invoices = await Invoice.aggregate([
      { $match: { ...df, ...SALES_DOCS, 'items.taxLines.taxCode': code } },
      { $project: {
        invoiceNo: 1, customerName: 1, date: 1, type: 1,
        total: { $multiply: ['$total', SIGN] },
        taxAmount: { $multiply: [SIGN, {
          $reduce: {
            input: { $reduce: { input: '$items', initialValue: [], in: { $concatArrays: ['$$value', '$$this.taxLines'] } } },
            initialValue: 0,
            in: { $cond: [{ $eq: ['$$this.taxCode', code] }, { $add: ['$$value', '$$this.amount'] }, '$$value'] }
          }
        }] }
      }},
      { $sort: { date: -1 } }
    ]);

    const purchases = await Purchase.aggregate([
      { $match: { ...df, status: { $ne: 'draft' }, 'items.taxLines.taxCode': code } },
      { $project: {
        purchaseNo: 1, supplierName: 1, date: 1, total: 1,
        taxAmount: {
          $reduce: {
            input: { $reduce: { input: '$items', initialValue: [], in: { $concatArrays: ['$$value', '$$this.taxLines'] } } },
            initialValue: 0,
            in: { $cond: [{ $eq: ['$$this.taxCode', code] }, { $add: ['$$value', '$$this.amount'] }, '$$value'] }
          }
        }
      }},
      { $sort: { date: -1 } }
    ]);

    res.json({
      code,
      invoices,
      purchases,
      totalInvoiceTax:  invoices.reduce((s,i)  => s + i.taxAmount, 0),
      totalPurchaseTax: purchases.reduce((s,p) => s + p.taxAmount, 0)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET monthly tax summary - dynamic per-tax
router.get('/monthly', requireAuth, requirePermission('monthlyTax'), async (req, res) => {
  try {
    const { year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const taxRates = await TaxRate.find({ active: true });

    const invMonthly = await Invoice.aggregate([
      { $match: { ...SALES_DOCS, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $unwind: '$items' }, { $unwind: '$items.taxLines' },
      { $group: {
        _id: { month: { $month: '$date' }, code: '$items.taxLines.taxCode' },
        amount: { $sum: { $multiply: ['$items.taxLines.amount', SIGN] } }
      }}
    ]);

    const purMonthly = await Purchase.aggregate([
      { $match: { status: { $ne: 'draft' }, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $unwind: '$items' }, { $unwind: '$items.taxLines' },
      { $group: {
        _id: { month: { $month: '$date' }, code: '$items.taxLines.taxCode' },
        amount: { $sum: '$items.taxLines.amount' }
      }}
    ]);

    const invSales = await Invoice.aggregate([
      { $match: { ...SALES_DOCS, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $group: { _id: { $month: '$date' }, totalSales: { $sum: NET_SALES }, totalGross: { $sum: { $multiply: ['$total', SIGN] } } } }
    ]);
    const purTotals = await Purchase.aggregate([
      { $match: { status: { $ne: 'draft' }, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $group: { _id: { $month: '$date' }, totalPurch: { $sum: '$subtotal' } } }
    ]);

    // Build monthly data
    const invMap  = {};
    for (const r of invMonthly) invMap[`${r._id.month}_${r._id.code}`] = r.amount;
    const purMap  = {};
    for (const r of purMonthly) purMap[`${r._id.month}_${r._id.code}`] = r.amount;
    const salesMap = Object.fromEntries(invSales.map(r => [r._id, r]));
    const purchMap = Object.fromEntries(purTotals.map(r => [r._id, r]));

    const creditableCodes = taxRates.filter(t => t.creditable).map(t => t.code);

    const months = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      let outputVAT = 0, inputVAT = 0;
      const taxBreakdown = {};
      for (const tax of taxRates) {
        const out = invMap[`${m}_${tax.code}`] || 0;
        const inp = purMap[`${m}_${tax.code}`] || 0;
        taxBreakdown[tax.code] = { out, inp };
        if (tax.creditable) { outputVAT += out; inputVAT += inp; }
      }
      return {
        month: m,
        monthName: new Date(y, i, 1).toLocaleString('default', { month: 'long' }),
        totalSales: salesMap[m]?.totalSales || 0,
        totalPurch: purchMap[m]?.totalPurch || 0,
        outputVAT, inputVAT,
        netVAT: outputVAT - inputVAT,
        taxBreakdown
      };
    });

    const totals = months.reduce((acc, m) => ({
      totalSales: acc.totalSales + m.totalSales,
      totalPurch: acc.totalPurch + m.totalPurch,
      outputVAT:  acc.outputVAT  + m.outputVAT,
      inputVAT:   acc.inputVAT   + m.inputVAT,
      netVAT:     acc.netVAT     + m.netVAT
    }), { totalSales:0, totalPurch:0, outputVAT:0, inputVAT:0, netVAT:0 });

    res.json({ year: y, months, totals, taxRates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TAX ACCOUNTS: what is owed (or due back) per tax account, and paying it ─────
// Balance = opening + credits − debits (credit = you owe, debit = refund due).
async function taxAccountSummary(to) {
  const rates = await TaxRate.find({ active: true, account: { $nin: ['', null] } }).sort({ code: 1 }).lean();
  const byAcc = new Map();
  for (const r of rates) {
    if (!byAcc.has(r.account)) byAcc.set(r.account, []);
    byAcc.get(r.account).push(r.name);
  }
  const names = [...byAcc.keys()];
  const match = { account: { $in: names } };
  if (to) { const d = new Date(to); if (isNaN(d)) throw Object.assign(new Error('Invalid date'), { status: 400 }); d.setHours(23, 59, 59, 999); match.date = { $lte: d }; }
  const [sums, accs] = await Promise.all([
    Ledger.aggregate([{ $match: match }, { $group: {
      _id: { account: '$account', settle: { $eq: ['$sourceType', 'taxsettlement'] } },
      debit: { $sum: { $ifNull: ['$debit', 0] } }, credit: { $sum: { $ifNull: ['$credit', 0] } } } }]),
    LedgerAccount.find({ name: { $in: names } }).lean(),
  ]);
  const accOf = Object.fromEntries(accs.map(a => [a.name, a]));
  // Only control accounts (liability/asset) hold a balance owed to or by the government; a duty
  // whose tax account is an expense account is just a cost.
  return names.filter(n => !['expense', 'income'].includes((accOf[n] || {}).type)).map(account => {
    const a = accOf[account] || {};
    // Opening balance is signed by account type, as the Trial Balance does (asset/expense = debit)
    const opening = ['asset', 'expense'].includes(a.type) ? -(a.openingBalance || 0) : (a.openingBalance || 0);
    const s = k => sums.find(x => x._id.account === account && x._id.settle === k) || { debit: 0, credit: 0 };
    const ord = s(false), set = s(true);
    const balance = opening + ord.credit - ord.debit + set.credit - set.debit;
    return { account, type: a.type || '', taxes: byAcc.get(account), opening,
      collected: ord.credit, claimed: ord.debit, settled: set.debit - set.credit, balance };
  });
}

router.get('/accounts', requireAuth, requirePermission('taxReport'), async (req, res) => {
  try { res.json(await taxAccountSummary(req.query.to)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/settlements', requireAuth, requirePermission('taxReport'), async (req, res) => {
  try { res.json(await TaxSettlement.find().sort({ date: -1, createdAt: -1 }).limit(200)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST pay a tax balance (you owe) or receive a refund (refund due). Partial amounts are fine.
router.post('/settle', requireAuth, requirePermission('taxReport'), async (req, res) => {
  try {
    const { account, paymentMode, cashAccount, bankAccount, reference, note } = req.body;
    const amount = Math.round((Number(req.body.amount) || 0) * 100) / 100;
    const date = req.body.date ? new Date(req.body.date) : new Date();
    if (isNaN(date)) return res.status(400).json({ error: 'Invalid date' });
    const row = (await taxAccountSummary()).find(r => r.account === account);
    if (!row) return res.status(400).json({ error: 'That is not a tax account. Set it on a tax in Tax Rates first.' });
    if (Math.abs(row.balance) < 0.005) return res.status(400).json({ error: 'Nothing to pay or receive: this account is settled' });
    const direction = row.balance > 0 ? 'paid' : 'refund';
    if (!(amount > 0)) return res.status(400).json({ error: 'Enter an amount more than 0' });
    if (amount > Math.abs(row.balance) + 0.005)
      return res.status(400).json({ error: `The most you can ${direction === 'paid' ? 'pay' : 'receive'} is ${Math.abs(row.balance).toFixed(2)}` });
    if (paymentMode === 'bank' && !bankAccount) return res.status(400).json({ error: 'Select the bank account' });
    if (paymentMode === 'cash' && !cashAccount) return res.status(400).json({ error: 'Select the cash account' });
    if (!['cash', 'bank'].includes(paymentMode)) return res.status(400).json({ error: 'Choose cash or bank' });

    const st = new TaxSettlement({ account, date, amount, direction, paymentMode, reference: reference || '', note: note || '' });
    const sign = direction === 'paid' ? -1 : 1;   // money leaves on a payment, arrives on a refund
    let moneyAcc = 'Cash', moneyType = 'cash';
    // Same money movement as payPurchase in routes/purchases.js
    if (paymentMode === 'bank') {
      const acc = await BankAccount.findByIdAndUpdate(bankAccount, { $inc: { currentBalance: sign * amount } });
      if (!acc) return res.status(400).json({ error: 'Bank account not found' });
      st.bankAccount = acc._id; moneyAcc = acc.name; moneyType = 'bank';
    } else {
      const acc = await CashAccount.findByIdAndUpdate(cashAccount, { $inc: { currentBalance: sign * amount } });
      if (!acc) return res.status(400).json({ error: 'Cash account not found' });
      st.cashAccount = acc._id; moneyAcc = acc.name;
      const ce = await CashEntry.create({ date, type: direction === 'paid' ? 'out' : 'in', category: direction === 'paid' ? 'Tax Payment' : 'Tax Refund',
        description: `${direction === 'paid' ? 'Tax paid' : 'Tax refund'} — ${account}`, reference: reference || '', amount,
        paymentMode: 'cash', cashAccount: acc._id, cashAccountName: acc.name, notes: note || '' });
      st.cashEntry = ce._id;
    }
    st.moneyAccountName = moneyAcc;
    await st.save();
    const taxAcc = await LedgerAccount.findOne({ name: account }).lean();
    const base = { date, reference: reference || '', sourceType: 'taxsettlement', sourceId: st._id,
      description: `${direction === 'paid' ? 'Tax paid' : 'Tax refund received'} — ${account}`, narration: note || '' };
    const taxRow = { ...base, account, accountType: ROW_TYPE[taxAcc && taxAcc.type] || 'payable' };
    const moneyRow = { ...base, account: moneyAcc, accountType: moneyType };
    await Ledger.insertMany(direction === 'paid'
      ? [{ ...taxRow, debit: amount, credit: 0 }, { ...moneyRow, debit: 0, credit: amount }]
      : [{ ...moneyRow, debit: amount, credit: 0 }, { ...taxRow, debit: 0, credit: amount }]);
    res.status(201).json(st);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE undo a tax payment / refund: money back, cash entry and ledger rows removed
router.delete('/settle/:id', requireAuth, requirePermission('taxReport'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const st = await TaxSettlement.findById(req.params.id);
    if (!st) return res.status(404).json({ error: 'Not found' });
    const back = (st.direction === 'paid' ? 1 : -1) * st.amount;
    if (st.paymentMode === 'bank' && st.bankAccount) await BankAccount.findByIdAndUpdate(st.bankAccount, { $inc: { currentBalance: back } });
    if (st.paymentMode === 'cash' && st.cashAccount) await CashAccount.findByIdAndUpdate(st.cashAccount, { $inc: { currentBalance: back } });
    if (st.cashEntry) await CashEntry.findByIdAndDelete(st.cashEntry);
    await Ledger.deleteMany({ sourceType: 'taxsettlement', sourceId: st._id });
    await st.deleteOne();
    res.json({ message: 'Undone' });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.taxAccountSummary = taxAccountSummary;
module.exports = router;
