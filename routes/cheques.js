const router = require('express').Router();
const mongoose = require('mongoose');
const Cheque = require('../models/Cheque');
const BankAccount = require('../models/BankAccount');
const BankTx = require('../models/BankTx');
const CashEntry = require('../models/CashEntry');
const Ledger = require('../models/Ledger');

// GET all cheques
router.get('/', async (req, res) => {
  try {
    const { direction, status, from, to } = req.query;
    let query = {};
    if (direction) query.direction = direction;
    if (status) query.status = status;
    if (from || to) {
      query.dueDate = {};
      if (from) query.dueDate.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); query.dueDate.$lte = d; }
    }
    const cheques = await Cheque.find(query).populate('account','name').sort({ dueDate: 1 });
    res.json(cheques);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET upcoming cheques (next 30 days)
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const future = new Date(today); future.setDate(future.getDate() + 30);
    const cheques = await Cheque.find({ dueDate: { $gte: today, $lte: future }, status: { $in: ['pending','deposited'] } }).sort({ dueDate: 1 });
    res.json(cheques);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create cheque
router.post('/', async (req, res) => {
  try {
    const cheque = new Cheque(req.body);
    await cheque.save();

    // Ledger entry
    if (cheque.direction === 'received') {
      await Ledger.insertMany([
        { date: cheque.date, account: 'Cheques Receivable', accountType: 'cheque', debit: cheque.amount, credit: 0, description: `Cheque rcvd #${cheque.chequeNo} from ${cheque.party}`, reference: cheque.chequeNo, sourceType: 'cheque', sourceId: cheque._id },
        { date: cheque.date, account: 'Sales', accountType: 'sales', debit: 0, credit: cheque.amount, description: `Cheque rcvd #${cheque.chequeNo} from ${cheque.party}`, reference: cheque.reference, sourceType: 'cheque', sourceId: cheque._id }
      ]);
    } else {
      await Ledger.insertMany([
        { date: cheque.date, account: 'Purchases', accountType: 'purchases', debit: cheque.amount, credit: 0, description: `Cheque issued #${cheque.chequeNo} to ${cheque.party}`, reference: cheque.reference, sourceType: 'cheque', sourceId: cheque._id },
        { date: cheque.date, account: 'Cheques Payable', accountType: 'cheque', debit: 0, credit: cheque.amount, description: `Cheque issued #${cheque.chequeNo} to ${cheque.party}`, reference: cheque.chequeNo, sourceType: 'cheque', sourceId: cheque._id }
      ]);
    }

    res.status(201).json(cheque);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH update cheque status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status, accountId, clearedDate, depositedDate } = req.body;
    const cheque = await Cheque.findById(req.params.id);
    if (!cheque) return res.status(404).json({ error: 'Not found' });

    const prevStatus = cheque.status;
    cheque.status = status;
    if (clearedDate)   cheque.clearedDate   = new Date(clearedDate);
    if (depositedDate) cheque.depositedDate = new Date(depositedDate);
    if (accountId)     cheque.account = accountId;
    await cheque.save();

    // When a received cheque is deposited → create bank deposit tx
    if (cheque.direction === 'received' && status === 'deposited' && accountId && prevStatus === 'pending') {
      const acc = await BankAccount.findById(accountId);
      if (acc) {
        await BankAccount.findByIdAndUpdate(accountId, { $inc: { currentBalance: cheque.amount } });
        await BankTx.create({
          date: depositedDate || new Date(),
          type: 'deposit',
          account: accountId,
          accountName: acc.name,
          amount: cheque.amount,
          description: `Cheque deposit #${cheque.chequeNo} — ${cheque.party}`,
          reference: cheque.chequeNo,
          chequeNo: cheque.chequeNo,
          cleared: false
        });
        await Ledger.insertMany([
          { date: depositedDate || new Date(), account: acc.name, accountType: 'bank', debit: cheque.amount, credit: 0, description: `Cheque deposited #${cheque.chequeNo}`, reference: cheque.chequeNo, sourceType: 'cheque', sourceId: cheque._id },
          { date: depositedDate || new Date(), account: 'Cheques Receivable', accountType: 'cheque', debit: 0, credit: cheque.amount, description: `Cheque deposited #${cheque.chequeNo}`, reference: cheque.chequeNo, sourceType: 'cheque', sourceId: cheque._id }
        ]);
      }
    }

    // When an issued cheque clears → debit bank
    if (cheque.direction === 'issued' && status === 'cleared' && accountId && prevStatus !== 'cleared') {
      const acc = await BankAccount.findById(accountId);
      if (acc) {
        await BankAccount.findByIdAndUpdate(accountId, { $inc: { currentBalance: -cheque.amount } });
        await BankTx.create({
          date: clearedDate || new Date(),
          type: 'withdrawal',
          account: accountId,
          accountName: acc.name,
          amount: cheque.amount,
          description: `Cheque cleared #${cheque.chequeNo} — ${cheque.party}`,
          reference: cheque.chequeNo,
          chequeNo: cheque.chequeNo,
          cleared: true
        });
        await Ledger.insertMany([
          { date: clearedDate || new Date(), account: 'Cheques Payable', accountType: 'cheque', debit: cheque.amount, credit: 0, description: `Cheque cleared #${cheque.chequeNo}`, reference: cheque.chequeNo, sourceType: 'cheque', sourceId: cheque._id },
          { date: clearedDate || new Date(), account: acc.name, accountType: 'bank', debit: 0, credit: cheque.amount, description: `Cheque cleared #${cheque.chequeNo}`, reference: cheque.chequeNo, sourceType: 'cheque', sourceId: cheque._id }
        ]);
      }
    }

    // Bounced cheque → reverse bank entry if it was deposited
    if (status === 'bounced' && prevStatus === 'deposited' && cheque.account) {
      await BankAccount.findByIdAndUpdate(cheque.account, { $inc: { currentBalance: -cheque.amount } });
    }

    res.json(cheque);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const cheque = await Cheque.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(cheque);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await Cheque.findByIdAndDelete(req.params.id);
    await Ledger.deleteMany({ sourceId: req.params.id });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
