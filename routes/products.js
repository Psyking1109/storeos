const router = require('express').Router();
const mongoose = require('mongoose');
const Product       = require('../models/Product');
const StoreLocation = require('../models/StoreLocation');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { search, category, active } = req.query;
    let query = {};
    if (active !== 'all' && !search) query.active = true;  // when searching, show all products
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku:  { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } }
      ];
    }
    if (category) query.category = category;
    const limit = search ? 12 : 0; // limit search results for speed
    const q = Product.find(query).sort({ name: 1 });
    if (limit) q.limit(limit);
    res.json(await q);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/meta/categories', requireAuth, async (req, res) => {
  try { res.json(await Product.distinct('category')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json(product);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const product = new Product(req.body);
    await product.save();
    res.status(201).json(product);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    // Resolve location names for locationStock
    if (data.locationStock && data.locationStock.length > 0) {
      for (const ls of data.locationStock) {
        if (ls.location && !ls.locationName) {
          const loc = await StoreLocation.findById(ls.location);
          if (loc) ls.locationName = loc.name;
        }
      }
      // Recompute total stock from locations
      data.stock = data.locationStock.reduce((s, l) => s + (l.stock || 0), 0);
    }
    const product = await Product.findByIdAndUpdate(req.params.id, data, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json(product);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id/stock', requireAuth, async (req, res) => {
  try {
    const { adjustment } = req.body;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    product.stock += Number(adjustment);
    await product.save();
    res.json(product);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await Product.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Product deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET product movement history (from ledger)
router.get('/:id/movements', requireAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });

    const Invoice  = require('../models/Invoice');
    const Purchase = require('../models/Purchase');

    // Get invoice movements (sales)
    const invoices = await Invoice.find({'items.product': req.params.id}).sort({date:-1}).limit(100);
    const sales = [];
    for (const inv of invoices) {
      for (const item of inv.items) {
        if (item.product?.toString() === req.params.id) {
          sales.push({
            type: 'sale', date: inv.date, ref: inv.invoiceNo,
            qty: item.qty, unit: item.unit,
            looseMode: item.looseMode||false,
            unitPrice: item.unitPrice, total: item.lineTotal,
          });
        }
      }
    }

    // Get purchase movements (incoming)
    const purchases = await Purchase.find({'items.product': req.params.id}).sort({date:-1}).limit(100);
    const purchased = [];
    for (const po of purchases) {
      for (const item of po.items) {
        if (item.product?.toString() === req.params.id) {
          purchased.push({
            type: 'purchase', date: po.date, ref: po.poNumber||po._id,
            qty: item.qty, unit: item.unit||product.unit,
            unitCost: item.unitCost, total: item.lineTotal,
          });
        }
      }
    }

    const movements = [...sales, ...purchased].sort((a,b)=>new Date(b.date)-new Date(a.date));
    res.json({ product, movements });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
