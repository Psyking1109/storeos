const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const mongoose = require('mongoose');
const CashAccount  = require('../models/CashAccount');
const CashTransfer = require('../models/CashTransfer');
const BankAccount  = require('../models/BankAccount');
const Ledger       = require('../models/Ledger');
const Expense      = require('../models/Expense');
const CashEntry    = require('../models/CashEntry');
const Invoice      = require('../models/Invoice');
const Purchase     = require('../models/Purchase');

// GET all cash accounts
router.get('/', requireAuth, async (req, res) => {
  try { res.json(await CashAccount.find({ active: true }).sort({ sortOrder: 1, name: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create cash account
router.post('/', requireAuth, async (req, res) => {
  try {
    const acc = new CashAccount(req.body);
    acc.currentBalance = acc.openingBalance || 0;
    await acc.save();
    res.status(201).json(acc);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT update
router.put('/:id', requireAuth, async (req, res) => {
  try { res.json(await CashAccount.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE (soft)
router.delete('/:id', requireAuth, async (req, res) => {
  try { await CashAccount.findByIdAndUpdate(req.params.id, { active: false }); res.json({ message: 'Deactivated' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST transfer between accounts
// cash->cash: just update balances, no ledger
// cash->bank or bank->cash: update balances + create ledger entries
router.post('/transfer', requireAuth, async (req, res) => {
  try {
    const { date, fromType, fromId, toType, toId, amount, description, reference } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be positive' });

    let fromName = '', toName = '';

    // Deduct from source
    if (fromType === 'cash') {
      const acc = await CashAccount.findByIdAndUpdate(fromId, { $inc: { currentBalance: -amount } }, { new: true });
      if (!acc) return res.status(404).json({ error: 'Source account not found' });
      fromName = acc.name;
    } else {
      const acc = await BankAccount.findByIdAndUpdate(fromId, { $inc: { currentBalance: -amount } }, { new: true });
      if (!acc) return res.status(404).json({ error: 'Source bank account not found' });
      fromName = acc.name;
    }

    // Add to destination
    if (toType === 'cash') {
      const acc = await CashAccount.findByIdAndUpdate(toId, { $inc: { currentBalance: amount } }, { new: true });
      if (!acc) return res.status(404).json({ error: 'Destination account not found' });
      toName = acc.name;
    } else {
      const acc = await BankAccount.findByIdAndUpdate(toId, { $inc: { currentBalance: amount } }, { new: true });
      if (!acc) return res.status(404).json({ error: 'Destination bank account not found' });
      toName = acc.name;
    }

    const isCrossBoundary = fromType !== toType;
    const transfer = await CashTransfer.create({
      date, fromType, fromAccount: fromId, fromAccountName: fromName,
      toType, toAccount: toId, toAccountName: toName,
      amount, description: description || `Transfer: ${fromName} → ${toName}`,
      reference, ledgered: isCrossBoundary
    });

    // Only ledger cross-boundary transfers (cash<->bank)
    if (isCrossBoundary) {
      const desc = description || `Transfer ${fromName} → ${toName}`;
      await Ledger.insertMany([
        { date, account: toName,   accountType: toType,   debit: amount, credit: 0, description: desc, reference, sourceType: 'transfer', sourceId: transfer._id },
        { date, account: fromName, accountType: fromType, debit: 0, credit: amount, description: desc, reference, sourceType: 'transfer', sourceId: transfer._id }
      ]);
    }

    res.status(201).json(transfer);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET transfer history
router.get('/transfers', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let q = {};
    if (from || to) { q.date = {}; if (from) q.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; } }
    res.json(await CashTransfer.find(q).sort({ date: -1 }).limit(100));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id/adjust', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { amount, description } = req.body;
    const acc = await CashAccount.findByIdAndUpdate(
      req.params.id, { $inc: { currentBalance: Number(amount)||0 } }, { new: true }
    );
    if (!acc) return res.status(404).json({ error: 'Account not found' });
    res.json(acc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// DELETE a cash account entry - syncs balance across all accounts
router.delete('/:id/entries/:source/:sourceId', requireAuth, async (req, res) => {
  try {
    const { id, source, sourceId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(sourceId))
      return res.status(400).json({ error: 'Invalid ID' });

    const acc = await CashAccount.findById(id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    if (source === 'expense') {
      const exp = await Expense.findById(sourceId);
      if (!exp) return res.status(404).json({ error: 'Expense not found' });
      // Restore cash balance
      await CashAccount.findByIdAndUpdate(id, { $inc: { currentBalance: exp.amount } });
      // Remove ledger entries
      await Ledger.deleteMany({ sourceId: exp._id, sourceType: 'expense' });
      await Expense.findByIdAndDelete(sourceId);
      res.json({ message: 'Expense deleted, balance restored' });

    } else if (source === 'journal') {
      const entry = await Ledger.findById(sourceId);
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      // Reverse the cash balance change
      // In cash account: credit entry = cash went out → restore by adding back
      //                  debit entry  = cash came in  → restore by subtracting
      const delta = entry.credit > 0 ? entry.credit : -entry.debit;
      await CashAccount.findByIdAndUpdate(id, { $inc: { currentBalance: delta } });
      // Also delete the paired expense/income ledger entry
      await Ledger.deleteMany({
        description: entry.description,
        date: entry.date,
        sourceType: { $in: ['journal','manual'] }
      });
      res.json({ message: 'Journal entry deleted, balance restored' });

    } else {
      res.status(400).json({ error: 'Cannot delete ' + source + ' entries from here. Go to ' + source + 's page.' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update a cash account entry amount/description
router.put('/:id/entries/:source/:sourceId', requireAuth, async (req, res) => {
  try {
    const { id, source, sourceId } = req.params;
    const { amount, description, date } = req.body;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(sourceId))
      return res.status(400).json({ error: 'Invalid ID' });

    const acc = await CashAccount.findById(id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    if (source === 'expense') {
      const exp = await Expense.findById(sourceId);
      if (!exp) return res.status(404).json({ error: 'Expense not found' });
      const oldAmount = exp.amount;
      const newAmount = Number(amount) || oldAmount;
      const diff = newAmount - oldAmount;
      // Update expense
      if (description) exp.description = description;
      if (date) exp.date = new Date(date);
      exp.amount = newAmount;
      await exp.save();
      // Adjust cash balance for difference
      await CashAccount.findByIdAndUpdate(id, { $inc: { currentBalance: -diff } });
      // Update ledger entry
      await Ledger.updateMany({ sourceId: exp._id, sourceType: 'expense' }, { $set: { debit: newAmount, description: description||exp.description } });
      res.json({ message: 'Updated' });

    } else if (source === 'journal') {
      const entry = await Ledger.findById(sourceId);
      if (!entry) return res.status(404).json({ error: 'Entry not found' });
      const oldAmount = entry.credit || entry.debit;
      const newAmount = Number(amount) || oldAmount;
      const diff = newAmount - oldAmount;
      // credit entry = cash went out → more amount = more debit (cash reduced more)
      const balanceDelta = entry.credit > 0 ? -diff : diff;
      await CashAccount.findByIdAndUpdate(id, { $inc: { currentBalance: balanceDelta } });
      // Update both paired ledger entries
      if (entry.credit > 0) {
        await Ledger.updateMany({ description: entry.description, date: entry.date, sourceType: { $in: ['journal','manual'] } },
          { $set: { credit: newAmount } });
        // Also update the expense side
        await Ledger.updateMany({ description: entry.description, date: entry.date, debit: { $gt: 0 }, sourceType: { $in: ['journal','manual'] } },
          { $set: { debit: newAmount, description: description||entry.description } });
      } else {
        await Ledger.updateMany({ description: entry.description, date: entry.date, sourceType: { $in: ['journal','manual'] } },
          { $set: { debit: newAmount } });
      }
      res.json({ message: 'Updated' });
    } else {
      res.status(400).json({ error: 'Cannot edit ' + source + ' entries from here' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// GET ledger/statement for a specific cash account
router.get('/:id/ledger', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const acc = await CashAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    let dateFilter = {};
    if (from || to) {
      dateFilter = {};
      if (from) dateFilter.$gte = new Date(from + 'T00:00:00.000Z');
      if (to) dateFilter.$lte = new Date(to + 'T23:59:59.999Z');
    }

    const Invoice  = require('../models/Invoice');
    // Purchase imported at top
    const Expense  = require('../models/Expense');
    const CashEntry= require('../models/CashEntry');

    const rows = [];

    // Invoice payments received into this account
    const invQ = { cashAccount: req.params.id, paid: { $gt: 0 } };
    if (Object.keys(dateFilter).length) invQ.date = dateFilter;
    const invs = await Invoice.find(invQ).select('invoiceNo customerName paid date');
    for (const inv of invs) {
      rows.push({ date: inv.date, description: 'Invoice ' + inv.invoiceNo + ' — ' + (inv.customerName || ''), reference: inv.invoiceNo, type: 'credit', amount: inv.paid, source: 'invoice', sourceId: inv._id, editable: false });
    }

    // Expenses paid FROM this account
    const expQ = { cashAccount: req.params.id };
    if (Object.keys(dateFilter).length) expQ.date = dateFilter;
    const exps = await Expense.find(expQ).select('description category amount date reference');
    for (const exp of exps) {
      rows.push({ date: exp.date, description: (exp.ledgerAccountName||exp.category||'Expense') + ' — ' + exp.description, reference: exp.reference || '', type: 'debit', amount: exp.amount, source: 'expense', sourceId: exp._id, editable: true, vendor: exp.vendor||'' });
    }

    // Transfers TO this account
    const xferIn = await CashTransfer.find({ toAccount: req.params.id, toType: 'cash', ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) });
    for (const x of xferIn) {
      rows.push({ date: x.date, description: 'Transfer from ' + (x.fromAccountName || 'other'), reference: x.reference || '', type: 'credit', amount: x.amount, source: 'transfer', sourceId: x._id, editable: false });
    }

    // Transfers FROM this account
    const xferOut = await CashTransfer.find({ fromAccount: req.params.id, fromType: 'cash', ...(Object.keys(dateFilter).length ? { date: dateFilter } : {}) });
    for (const x of xferOut) {
      rows.push({ date: x.date, description: 'Transfer to ' + (x.toAccountName || 'other'), reference: x.reference || '', type: 'debit', amount: x.amount, source: 'transfer', sourceId: x._id, editable: false });
    }

    // Manual cash entries for this account
    const ceQ = { cashAccount: req.params.id };
    if (Object.keys(dateFilter).length) ceQ.date = dateFilter;
    const ces = await CashEntry.find(ceQ).select('date type category description amount reference');
    for (const ce of ces) {
      rows.push({ date: ce.date, description: ce.category + (ce.description ? ' — ' + ce.description : ''), reference: ce.reference || '', type: ce.type === 'in' ? 'credit' : 'debit', amount: ce.amount, source: 'manual' });
    }

    // Journal entries paid from/to this cash account
    // Ledger imported at top
    const journalRows = await Ledger.find({
      sourceType: 'journal',
      $or: [
        { description: { $regex: acc.name, $options: 'i' } },
        { account: { $regex: 'Cash - '+acc.name, $options: 'i' } }
      ],
      ...(Object.keys(dateFilter).length ? { date: dateFilter } : {})
    });
    for (const j of journalRows) {
      // Double-entry for CASH account:
      // Credit on cash = cash went OUT (expense paid) → show as DEBIT (OUT) column, red
      // Debit  on cash = cash came IN (income received) → show as CREDIT (IN) column, green
      if (j.credit > 0) {
        rows.push({ date: j.date, description: j.description, reference: j.reference||'', type: 'debit', amount: j.credit, source: 'journal', sourceId: j._id, editable: true });
      } else if (j.debit > 0) {
        rows.push({ date: j.date, description: j.description, reference: j.reference||'', type: 'credit', amount: j.debit, source: 'journal', sourceId: j._id, editable: true });
      }
    }

    // Sort by date
    rows.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Compute TRUE opening balance at start of date range
    // = currentBalance - sum of all transactions within the date range
    // This way: openingBalance + periodCredits - periodDebits = currentBalance ✓
    const periodCredits = rows.filter(r=>r.type==='credit').reduce((s,r)=>s+r.amount,0);
    const periodDebits  = rows.filter(r=>r.type==='debit').reduce((s,r)=>s+r.amount,0);
    let balance = acc.currentBalance - periodCredits + periodDebits;

    const withBalance = rows.map(row => {
      if (row.type === 'credit') balance += row.amount;
      else balance -= row.amount;
      return { ...row, runningBalance: balance };
    });

    const periodTotal = periodCredits - periodDebits;
    res.json({ account: acc, rows: withBalance, periodCredits, periodDebits, periodTotal, closingBalance: acc.currentBalance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
