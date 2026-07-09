const router = require('express').Router();
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');

router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let query = { active: true };
    if (search) query.name = { $regex: search, $options: 'i' };
    const customers = await Customer.find(query).sort({ name: 1 });
    res.json(customers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const invoices = await Invoice.find({ customer: req.params.id, type: 'invoice' }).sort({ date: -1 }).limit(20);
    res.json({ customer, invoices });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const customer = new Customer(req.body);
    await customer.save();
    res.status(201).json(customer);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(customer);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await Customer.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Customer deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
