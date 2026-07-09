const router = require('express').Router();
const mongoose = require('mongoose');
const StoreLocation = require('../models/StoreLocation');
const Product       = require('../models/Product');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try { res.json(await StoreLocation.find({ active: true }).sort({ name: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try { const loc = new StoreLocation(req.body); await loc.save(); res.status(201).json(loc); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try { res.json(await StoreLocation.findByIdAndUpdate(req.params.id, req.body, { new: true })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try { await StoreLocation.findByIdAndUpdate(req.params.id, { active: false }); res.json({ message: 'Deactivated' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET stock by location report
router.get('/stock-report', requireAuth, async (req, res) => {
  try {
    const locations = await StoreLocation.find({ active: true });
    const products  = await Product.find({ active: true });
    const report = locations.map(loc => ({
      location: loc,
      items: products
        .filter(p => p.locationStock?.length > 0)
        .map(p => {
          const ls = p.locationStock.find(l => l.location?.toString() === loc._id.toString());
          return ls ? { product: p, stock: ls.stock } : null;
        })
        .filter(Boolean)
    }));
    res.json(report);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH transfer stock between locations
router.patch('/stock-transfer', requireAuth, async (req, res) => {
  try {
    const { productId, fromLocationId, toLocationId, qty } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const from = product.locationStock.find(l => l.location?.toString() === fromLocationId);
    if (!from || from.stock < qty) return res.status(400).json({ error: 'Insufficient stock at source location' });
    from.stock -= qty;
    let to = product.locationStock.find(l => l.location?.toString() === toLocationId);
    if (!to) {
      const loc = await StoreLocation.findById(toLocationId);
      product.locationStock.push({ location: toLocationId, locationName: loc?.name || '', stock: qty });
    } else { to.stock += qty; }
    await product.save();
    res.json(product);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
