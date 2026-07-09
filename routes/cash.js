const router = require('express').Router();
const mongoose = require('mongoose');
const CashEntry   = require('../models/CashEntry');
const CashAccount = require('../models/CashAccount');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { from, to, type, category, cashAccount } = req.query;
    let query = {};
    if (type) query.type = type;
    if (category) query.category = category;
    if (cashAccount) query.cashAccount = cashAccount;
    if (from || to) { query.date = {}; if (from) query.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); query.date.$lte = d; } }
    const entries = await CashEntry.find(query).sort({ date: 1, createdAt: 1 });
    let runningBalance = 0;
    const withBalance = entries.map(e => {
      if (e.type === 'in') runningBalance += e.amount;
      else runningBalance -= e.amount;
      return { ...e.toObject(), runningBalance };
    });
    res.json(withBalance);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const data = { ...req.body };
    if (!data.cashAccount) delete data.cashAccount;
    const entry = new CashEntry(data);
    // Update CashAccount balance if specified
    if (data.cashAccount) {
      const acc = await CashAccount.findById(data.cashAccount);
      if (acc) {
        entry.cashAccountName = acc.name;
        const delta = data.type === 'in' ? data.amount : -data.amount;
        await CashAccount.findByIdAndUpdate(data.cashAccount, { $inc: { currentBalance: delta } });
      }
    }
    await entry.save();
    res.status(201).json(entry);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try { res.json(await CashEntry.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const entry = await CashEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    // Reverse CashAccount balance
    if (entry.cashAccount) {
      const delta = entry.type === 'in' ? -entry.amount : entry.amount;
      await CashAccount.findByIdAndUpdate(entry.cashAccount, { $inc: { currentBalance: delta } });
    }
    await CashEntry.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daily summary
router.get('/summary/daily', requireAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    let matchStage = {};
    if (from || to) { matchStage.date = {}; if (from) matchStage.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); matchStage.date.$lte = d; } }
    const summary = await CashEntry.aggregate([
      { $match: matchStage },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, totalIn: { $sum: { $cond: [{ $eq: ['$type','in'] }, '$amount', 0] } }, totalOut: { $sum: { $cond: [{ $eq: ['$type','out'] }, '$amount', 0] } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);
    let cum = 0;
    res.json(summary.map(d => { cum += d.totalIn - d.totalOut; return { ...d, net: d.totalIn - d.totalOut, cumulative: cum }; }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
