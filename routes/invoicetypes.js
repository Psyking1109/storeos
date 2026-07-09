const router = require('express').Router();
const mongoose = require('mongoose');
const InvoiceType = require('../models/InvoiceType');
const { requireAuth, requireRole } = require('../middleware/auth');

// Generate next invoice number for a given type + date
async function generateInvoiceNumber(typeId, date) {
  const type = await InvoiceType.findById(typeId);
  if (!type) throw new Error('Invoice type not found');

  const d = new Date(date || Date.now());
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());

  // Build reset key based on cycle
  let resetKey = '';
  if (type.resetCycle === 'daily')   resetKey = `${yyyy}${mm}${dd}`;
  if (type.resetCycle === 'monthly') resetKey = `${yyyy}${mm}`;
  if (type.resetCycle === 'yearly')  resetKey = `${yyyy}`;
  if (type.resetCycle === 'never')   resetKey = 'never';

  // Reset counter if cycle rolled over
  if (type.lastResetDate !== resetKey) {
    type.lastCounter = 0;
    type.lastResetDate = resetKey;
  }
  type.lastCounter += 1;
  await type.save();

  const counter = String(type.lastCounter).padStart(type.padLength || 4, '0');
  return `${type.prefix}-${dd}/${mm}/${yyyy}-${counter}`;
}

router.get('/', requireAuth, async (req, res) => {
  try { res.json(await InvoiceType.find({ active: true }).sort({ name: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const t = new InvoiceType(req.body);
    await t.save();
    res.status(201).json(t);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try { res.json(await InvoiceType.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try { await InvoiceType.findByIdAndUpdate(req.params.id, { active: false }); res.json({ message: 'Deactivated' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST preview next number without saving
router.post('/:id/preview', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const type = await InvoiceType.findById(req.params.id);
    if (!type) return res.status(404).json({ error: 'Not found' });
    const d = new Date(req.body.date || Date.now());
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    const nextCounter = (type.lastCounter || 0) + 1;
    const counter = String(nextCounter).padStart(type.padLength || 4, '0');
    res.json({ preview: `${type.prefix}-${dd}/${mm}/${yyyy}-${counter}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.generateInvoiceNumber = generateInvoiceNumber;
