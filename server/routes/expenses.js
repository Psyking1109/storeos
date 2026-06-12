const router = require('express').Router();
const mongoose = require('mongoose');
const Expense     = require('../models/Expense');
const CashAccount = require('../models/CashAccount');
const BankAccount = require('../models/BankAccount');
const Ledger      = require('../models/Ledger');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { from, to, category } = req.query;
    let q = {};
    if (category) q.category = category;
    if (from || to) { q.date = {}; if (from) q.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; } }
    res.json(await Expense.find(q).sort({ date: -1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/categories', requireAuth, async (req, res) => {
  try { res.json(await Expense.distinct('category')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/summary', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = {};
    if (from || to) { q.date = {}; if (from) q.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; } }
    const summary = await Expense.aggregate([
      { $match: q },
      { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } }
    ]);
    res.json({ categories: summary, total: summary.reduce((s, r) => s + r.total, 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    // Keep account IDs only if they are valid non-empty strings
    if (!data.cashAccount || data.cashAccount === '') delete data.cashAccount;
    if (!data.bankAccount  || data.bankAccount  === '') delete data.bankAccount;

    // Resolve account names BEFORE saving
    let sourceAccountName = '';
    if (data.paymentMethod === 'cash' && data.cashAccount) {
      const acc = await CashAccount.findByIdAndUpdate(
        data.cashAccount,
        { $inc: { currentBalance: -Number(data.amount) } },
        { new: true }
      );
      if (!acc) return res.status(404).json({ error: 'Cash account not found' });
      sourceAccountName = acc.name;
      data.cashAccountName = acc.name;
    } else if (data.paymentMethod === 'bank' && data.bankAccount) {
      const acc = await BankAccount.findByIdAndUpdate(
        data.bankAccount,
        { $inc: { currentBalance: -Number(data.amount) } },
        { new: true }
      );
      if (!acc) return res.status(404).json({ error: 'Bank account not found' });
      sourceAccountName = acc.name;
      data.bankAccountName = acc.name;
    } else {
      sourceAccountName = data.paymentMethod === 'cheque' ? 'Cheques Payable' : 'Accounts Payable';
    }

    const expense = new Expense(data);
    await expense.save();

    // Ledger entries
    await Ledger.insertMany([
      { date: data.date, account: data.ledgerAccountName||data.category||'Expenses', accountType: 'expense', debit: Number(data.amount), credit: 0,
        description: data.description, reference: data.reference || '', sourceType: 'expense', sourceId: expense._id,
        narration: data.vendor || '' },
      { date: data.date, account: sourceAccountName, accountType: data.paymentMethod === 'bank' ? 'bank' : 'cash',
        debit: 0, credit: Number(data.amount), description: data.description, reference: data.reference || '',
        sourceType: 'expense', sourceId: expense._id }
    ]);

    res.status(201).json(expense);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const exp = await Expense.findById(req.params.id);
    if (!exp) return res.status(404).json({ error: 'Not found' });
    // Reverse the balance deduction
    if (exp.cashAccount) await CashAccount.findByIdAndUpdate(exp.cashAccount, { $inc: { currentBalance: exp.amount } });
    if (exp.bankAccount)  await BankAccount.findByIdAndUpdate(exp.bankAccount,  { $inc: { currentBalance: exp.amount } });
    await Ledger.deleteMany({ sourceId: exp._id, sourceType: 'expense' });
    await Expense.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
