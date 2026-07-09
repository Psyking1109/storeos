const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const mongoose = require('mongoose');
const BankAccount = require('../models/BankAccount');
const BankTx = require('../models/BankTx');
const CashEntry = require('../models/CashEntry');
const Ledger = require('../models/Ledger');

// ── BANK ACCOUNTS ──────────────────────────────────────────────

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
    // Ledger entry for opening balance
    if (acc.openingBalance) {
      await Ledger.create({
        date: new Date(), account: acc.name, accountType: 'bank',
        debit: acc.openingBalance, credit: 0,
        description: `Opening balance — ${acc.name}`, reference: '', sourceType: 'bank', sourceId: acc._id
      });
    }
    res.status(201).json(acc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/accounts/:id', async (req, res) => {
  try {
    const acc = await BankAccount.findByIdAndUpdate(req.params.id, req.body, { new: true });
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
    const data = req.body;
    const tx = new BankTx(data);
    await tx.save();

    const acc = await BankAccount.findById(data.account);
    if (!acc) throw new Error('Account not found');

    if (data.type === 'deposit') {
      await BankAccount.findByIdAndUpdate(data.account, { $inc: { currentBalance: data.amount } });
      // Also create cash entry if it's a cash-to-bank deposit
      if (data.fromCash) {
        await CashEntry.create({
          date: data.date, type: 'out', category: 'Bank Deposit',
          description: `Cash deposited to ${acc.name}`,
          reference: data.reference || tx._id.toString(),
          amount: data.amount, paymentMode: 'cash'
        });
      }
      await Ledger.insertMany([
        { date: data.date, account: acc.name, accountType: 'bank', debit: data.amount, credit: 0, description: data.description, reference: data.reference, sourceType: 'bank', sourceId: tx._id },
        { date: data.date, account: data.fromCash ? 'Cash' : 'Income', accountType: data.fromCash ? 'cash' : 'income', debit: 0, credit: data.amount, description: data.description, reference: data.reference, sourceType: 'bank', sourceId: tx._id }
      ]);
    } else if (data.type === 'withdrawal') {
      await BankAccount.findByIdAndUpdate(data.account, { $inc: { currentBalance: -data.amount } });
      if (data.toCash) {
        await CashEntry.create({
          date: data.date, type: 'in', category: 'Bank Withdrawal',
          description: `Cash withdrawn from ${acc.name}`,
          reference: data.reference || tx._id.toString(),
          amount: data.amount, paymentMode: 'bank'
        });
      }
      await Ledger.insertMany([
        { date: data.date, account: data.toCash ? 'Cash' : 'Expense', accountType: data.toCash ? 'cash' : 'expense', debit: data.amount, credit: 0, description: data.description, reference: data.reference, sourceType: 'bank', sourceId: tx._id },
        { date: data.date, account: acc.name, accountType: 'bank', debit: 0, credit: data.amount, description: data.description, reference: data.reference, sourceType: 'bank', sourceId: tx._id }
      ]);
    } else if (data.type === 'transfer') {
      if (!data.toAccount) throw new Error('Destination account required for transfer');
      const toAcc = await BankAccount.findById(data.toAccount);
      if (!toAcc) throw new Error('Destination account not found');
      await BankAccount.findByIdAndUpdate(data.account,   { $inc: { currentBalance: -data.amount } });
      await BankAccount.findByIdAndUpdate(data.toAccount, { $inc: { currentBalance:  data.amount } });
      tx.toAccountName = toAcc.name;
      await tx.save();
      await Ledger.insertMany([
        { date: data.date, account: toAcc.name, accountType: 'bank', debit: data.amount, credit: 0, description: `Transfer from ${acc.name}: ${data.description}`, reference: data.reference, sourceType: 'bank', sourceId: tx._id },
        { date: data.date, account: acc.name,   accountType: 'bank', debit: 0, credit: data.amount, description: `Transfer to ${toAcc.name}: ${data.description}`, reference: data.reference, sourceType: 'bank', sourceId: tx._id }
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

router.get('/accounts/:id/statement', async (req, res) => {
  try {
    const { from, to } = req.query;
    const acc = await BankAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    let query = { account: req.params.id };
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); query.date.$lte = d; }
    }
    const txs = await BankTx.find(query).sort({ date: 1, createdAt: 1 });
    let bal = acc.openingBalance;
    const rows = txs.map(t => {
      if (t.type === 'deposit')    bal += t.amount;
      if (t.type === 'withdrawal') bal -= t.amount;
      if (t.type === 'transfer' && t.account.toString() === req.params.id) bal -= t.amount;
      return { ...t.toObject(), runningBalance: bal };
    });
    res.json({ account: acc, rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/accounts/:id/adjust', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { amount } = req.body;
    const acc = await BankAccount.findByIdAndUpdate(
      req.params.id, { $inc: { currentBalance: Number(amount)||0 } }, { new: true }
    );
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    res.json(acc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
