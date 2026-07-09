const router = require('express').Router();
const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const Purchase = require('../models/Purchase');

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let q = { active: true };
    if (search) q.name = { $regex: search, $options: 'i' };
    res.json(await Supplier.find(q).sort({ name: 1 }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    const purchases = await Purchase.find({ supplier: req.params.id }).sort({ date: -1 });
    const stats = purchases.reduce((a, p) => { a.totalOrders++; a.totalValue += p.total; a.totalPaid += p.paid; a.totalDue += p.balance; return a; }, { totalOrders:0, totalValue:0, totalPaid:0, totalDue:0 });
    res.json({ supplier, purchases, stats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try { const s = new Supplier(req.body); await s.save(); res.status(201).json(s); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  try { res.json(await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await Supplier.findByIdAndUpdate(req.params.id, { active: false }); res.json({ message: 'Deactivated' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
