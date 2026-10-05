const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const mongoose = require('mongoose');
const BankAccount = require('../models/BankAccount');
const BankTx = require('../models/BankTx');
const CashEntry = require('../models/CashEntry');
const Ledger = require('../models/Ledger');
const CashAccount = require('../models/CashAccount');
const LedgerAccount = require('../models/LedgerAccount');

// ── BANK ACCOUNTS ──────────────────────────────────────────────

// Opening balance: Dr Bank / Cr Opening Balance Equity (reversed for an overdraft)
async function postOpening(acc) {
  const ob = Number(acc.openingBalance) || 0;
  if (!ob) return;
  const base = { date: acc.createdAt || new Date(), description: `Opening balance — ${acc.name}`, reference: '',
    sourceType: 'bank', sourceId: acc._id, narration: 'opening' };
  await Ledger.insertMany([
    { ...base, account: acc.name, accountType: 'bank', debit: ob > 0 ? ob : 0, credit: ob < 0 ? -ob : 0 },
    { ...base, account: 'Opening Balance Equity', accountType: 'equity', debit: ob < 0 ? -ob : 0, credit: ob > 0 ? ob : 0 },
  ]);
}

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await BankAccount.find({ active: true }).sort({ name: 1 });
    res.json(accounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/accounts', async (req, res) => {
  try {
    const acc = new BankAccount(req.body);
    acc.currentBalance = acc.openingBalance;
    await acc.save();
    await postOpening(acc);
    res.status(201).json(acc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/accounts/:id', async (req, res) => {
  try {
    const acc = await BankAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const body = { ...req.body };
    delete body.currentBalance; // moves only through transactions
    const oldName = acc.name, oldOpening = acc.openingBalance || 0;
    Object.assign(acc, body);
    const newOpening = Number(acc.openingBalance) || 0;
    acc.currentBalance += newOpening - oldOpening;
    await acc.save();
    // The ledger identifies bank accounts by name: keep their history attached
    if (acc.name !== oldName)
      await Ledger.updateMany({ account: oldName, accountType: 'bank' }, { $set: { account: acc.name } });
    if (newOpening !== oldOpening) {
      await Ledger.deleteMany({ sourceType: 'bank', sourceId: acc._id, narration: { $in: ['opening', ''] }, description: /^Opening balance/ });
      await postOpening(acc);
    }
    res.json(acc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    await BankAccount.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Account deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TRANSACTIONS ────────────────────────────────────────────────

router.get('/transactions', async (req, res) => {
  try {
    const { account, from, to, type, cleared } = req.query;
    let query = {};
    if (account) query.account = account;
    if (type) query.type = type;
    if (cleared !== undefined && cleared !== '') query.cleared = cleared === 'true';
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); query.date.$lte = d; }
    }
    const txs = await BankTx.find(query)
      .populate('account', 'name')
      .populate('toAccount', 'name')
      .sort({ date: -1, createdAt: -1 });
    res.json(txs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/transactions', async (req, res) => {
  try {
    const data = { ...req.body };
    const amount = Number(data.amount);
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });
    if (!['deposit', 'withdrawal', 'transfer'].includes(data.type)) return res.status(400).json({ error: 'Choose deposit, withdrawal or transfer' });
    if (!data.description) return res.status(400).json({ error: 'Description required' });
    // Check every account BEFORE anything is written
    const acc = mongoose.isValidObjectId(data.account) ? await BankAccount.findById(data.account) : null;
    if (!acc) return res.status(400).json({ error: 'Select the bank account' });

    let toAcc = null, cashAcc = null, contra = null;
    if (data.type === 'transfer') {
      toAcc = mongoose.isValidObjectId(data.toAccount) ? await BankAccount.findById(data.toAccount) : null;
      if (!toAcc) return res.status(400).json({ error: 'Select the destination bank account' });
      if (String(toAcc._id) === String(acc._id)) return res.status(400).json({ error: 'Choose two different accounts' });
    } else if (data.cashAccount) {
      cashAcc = mongoose.isValidObjectId(data.cashAccount) ? await CashAccount.findById(data.cashAccount) : null;
      if (!cashAcc) return res.status(400).json({ error: 'Cash account not found' });
    } else if (data.contraAccount) {
      const la = await LedgerAccount.findOne({ name: data.contraAccount });
      contra = { account: data.contraAccount, accountType: la ? la.type : (data.type === 'deposit' ? 'income' : 'expense') };
    } else {
      return res.status(400).json({ error: data.type === 'deposit'
        ? 'Choose where the money came from (a cash account or a ledger account)'
        : 'Choose where the money went (a cash account or a ledger account)' });
    }

    const tx = new BankTx({ ...data, amount, accountName: acc.name, toAccountName: toAcc ? toAcc.name : '',
      cashAccount: cashAcc ? cashAcc._id : undefined, cashAccountName: cashAcc ? cashAcc.name : '',
      contraAccount: contra ? contra.account : '' });
    await tx.save();
    const base = { date: data.date || new Date(), description: data.description, reference: data.reference || '', sourceType: 'bank', sourceId: tx._id };
    const other = cashAcc ? { account: cashAcc.name, accountType: 'cash' } : contra;

    if (data.type === 'deposit') {
      await BankAccount.findByIdAndUpdate(acc._id, { $inc: { currentBalance: amount } });
      if (cashAcc) {
        await CashAccount.findByIdAndUpdate(cashAcc._id, { $inc: { currentBalance: -amount } });
        await CashEntry.create({ date: base.date, type: 'out', category: 'Bank Deposit', description: `Cash deposited to ${acc.name}`,
          reference: data.reference || tx._id.toString(), amount, paymentMode: 'cash', cashAccount: cashAcc._id, cashAccountName: cashAcc.name });
      }
      await Ledger.insertMany([
        { ...base, account: acc.name, accountType: 'bank', debit: amount, credit: 0 },
        { ...base, ...other, debit: 0, credit: amount },
      ]);
    } else if (data.type === 'withdrawal') {
      await BankAccount.findByIdAndUpdate(acc._id, { $inc: { currentBalance: -amount } });
      if (cashAcc) {
        await CashAccount.findByIdAndUpdate(cashAcc._id, { $inc: { currentBalance: amount } });
        await CashEntry.create({ date: base.date, type: 'in', category: 'Bank Withdrawal', description: `Cash withdrawn from ${acc.name}`,
          reference: data.reference || tx._id.toString(), amount, paymentMode: 'bank', cashAccount: cashAcc._id, cashAccountName: cashAcc.name });
      }
      await Ledger.insertMany([
        { ...base, ...other, debit: amount, credit: 0 },
        { ...base, account: acc.name, accountType: 'bank', debit: 0, credit: amount },
      ]);
    } else {
      await BankAccount.findByIdAndUpdate(acc._id,   { $inc: { currentBalance: -amount } });
      await BankAccount.findByIdAndUpdate(toAcc._id, { $inc: { currentBalance:  amount } });
      await Ledger.insertMany([
        { ...base, account: toAcc.name, accountType: 'bank', debit: amount, credit: 0, description: `Transfer from ${acc.name}: ${data.description}` },
        { ...base, account: acc.name,   accountType: 'bank', debit: 0, credit: amount, description: `Transfer to ${toAcc.name}: ${data.description}` },
      ]);
    }

    res.status(201).json(tx);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/transactions/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const tx = await BankTx.findById(req.params.id);
    if (!tx) return res.status(404).json({ error: 'Not found' });
    if (tx.source === 'cheque' || (tx.chequeNo && !(await Ledger.exists({ sourceId: tx._id }))))
      return res.status(400).json({ error: 'This was posted by a cheque. Reverse it from the Cheques page (bounce/cancel) instead.' });
    if (tx.cashAccount) {
      if (tx.type === 'deposit')    await CashAccount.findByIdAndUpdate(tx.cashAccount, { $inc: { currentBalance:  tx.amount } });
      if (tx.type === 'withdrawal') await CashAccount.findByIdAndUpdate(tx.cashAccount, { $inc: { currentBalance: -tx.amount } });
    }
    // Reverse balance
    if (tx.type === 'deposit')    await BankAccount.findByIdAndUpdate(tx.account, { $inc: { currentBalance: -tx.amount } });
    if (tx.type === 'withdrawal') await BankAccount.findByIdAndUpdate(tx.account, { $inc: { currentBalance:  tx.amount } });
    if (tx.type === 'transfer') {
      await BankAccount.findByIdAndUpdate(tx.account,   { $inc: { currentBalance:  tx.amount } });
      await BankAccount.findByIdAndUpdate(tx.toAccount, { $inc: { currentBalance: -tx.amount } });
    }
    await Ledger.deleteMany({ sourceId: tx._id });
    await BankTx.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STATEMENT per account ────────────────────────────────────────

// Statement as the books see it: every ledger row on this bank account.
// Debit = money in, Credit = money out (the bank's own statement uses the opposite words).
router.get('/accounts/:id/statement', async (req, res) => {
  try {
    const { from, to } = req.query;
    const acc = await BankAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const q = { account: acc.name, accountType: 'bank' };
    let opening = 0;
    if (from) {
      const before = await Ledger.aggregate([
        { $match: { ...q, date: { $lt: new Date(from) } } },
        { $group: { _id: null, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } },
      ]);
      opening = before.length ? before[0].dr - before[0].cr : 0;
    }
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; }
    }
    const entries = await Ledger.find(q).sort({ date: 1, createdAt: 1 }).lean();
    let bal = opening;
    const rows = entries.map(e => {
      bal += (e.debit || 0) - (e.credit || 0);
      return { _id: e._id, date: e.date, description: e.description, reference: e.reference, sourceType: e.sourceType,
               debit: e.debit || 0, credit: e.credit || 0, runningBalance: bal };
    });
    res.json({ account: acc, opening, rows, closing: bal, bookBalance: acc.currentBalance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/accounts/:id/adjust', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const amt = Number(req.body.amount) || 0;
    if (!amt) return res.status(400).json({ error: 'Adjustment amount required' });
    const acc = await BankAccount.findByIdAndUpdate(req.params.id, { $inc: { currentBalance: amt } }, { new: true });
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    // Keep the books in step with the balance: the difference goes to Bank Adjustments
    const base = { date: new Date(), description: req.body.description || `Balance adjustment — ${acc.name}`, reference: '', sourceType: 'adjustment', sourceId: acc._id };
    await Ledger.insertMany([
      { ...base, account: acc.name, accountType: 'bank', debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0 },
      { ...base, account: 'Bank Adjustments', accountType: 'expense', debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0 },
    ]);
    res.json(acc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
