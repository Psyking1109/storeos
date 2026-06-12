const router = require('express').Router();
const mongoose = require('mongoose');
const TaxRate = require('../models/TaxRate');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET active tax rates
router.get('/', requireAuth, async (req, res) => {
  try { res.json(await TaxRate.find({ active: true }).sort({ code: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET all including inactive
router.get('/all', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try { res.json(await TaxRate.find().sort({ code: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create
router.post('/', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    if (!req.body.code) return res.status(400).json({ error: 'Code required' });
    req.body.code = req.body.code.toUpperCase().trim().replace(/\s+/g, '_');
    const tax = new TaxRate(req.body);
    await tax.save();
    res.status(201).json(tax);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT update
router.put('/:id', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const tax = await TaxRate.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!tax) return res.status(404).json({ error: 'Not found' });
    res.json(tax);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE soft-delete
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await TaxRate.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'Deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DYNAMIC TAX REPORT ──────────────────────────────────────────────────────
// Returns per-tax breakdown for ALL user-defined taxes (no hardcoded VAT/SSCL/PAL)
router.get('/report', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let df = {};
    if (from || to) {
      df.date = {};
      if (from) df.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); df.date.$lte = d; }
    }

    const taxRates = await TaxRate.find({ active: true }).sort({ code: 1 });

    // Get all invoice tax lines grouped by taxCode
    const invByTax = await Invoice.aggregate([
      { $match: { ...df, status: { $ne: 'draft' } } },
      { $unwind: '$items' },
      { $unwind: { path: '$items.taxLines', preserveNullAndEmptyArrays: false } },
      { $group: {
        _id: '$items.taxLines.taxCode',
        totalAmount: { $sum: '$items.taxLines.amount' },
        taxName:     { $first: '$items.taxLines.taxName' },
        invoiceCount: { $addToSet: '$_id' }
      }},
      { $project: { totalAmount: 1, taxName: 1, invoiceCount: { $size: '$invoiceCount' } } }
    ]);

    // Get all purchase tax lines grouped by taxCode
    const purByTax = await Purchase.aggregate([
      { $match: { ...df, status: { $ne: 'draft' } } },
      { $unwind: '$items' },
      { $unwind: { path: '$items.taxLines', preserveNullAndEmptyArrays: false } },
      { $group: {
        _id: '$items.taxLines.taxCode',
        totalAmount: { $sum: '$items.taxLines.amount' },
        taxName:     { $first: '$items.taxLines.taxName' }
      }}
    ]);

    // Build per-tax summary
    const outputTaxes = [];
    const inputTaxes  = [];
    const irdPositions = [];

    const invMap = Object.fromEntries(invByTax.map(t => [t._id, t]));
    const purMap = Object.fromEntries(purByTax.map(t => [t._id, t]));

    for (const tax of taxRates) {
      const invAmt = invMap[tax.code]?.totalAmount || 0;
      const purAmt = purMap[tax.code]?.totalAmount || 0;
      const invCnt = invMap[tax.code]?.invoiceCount || 0;

      // Show ALL taxes regardless of whether they have amounts yet
      if (tax.type === 'output' || tax.type === 'both') {
        outputTaxes.push({ code: tax.code, name: tax.name, rate: tax.rate, amount: invAmt, invoiceCount: invCnt, creditable: tax.creditable });
      }
      if (tax.type === 'input' || tax.type === 'both') {
        inputTaxes.push({ code: tax.code, name: tax.name, rate: tax.rate, amount: purAmt, creditable: tax.creditable });
      }
      // IRD position for each creditable tax
      if (tax.creditable) {
        const outputAmt = invAmt;
        const inputAmt  = purAmt;
        irdPositions.push({
          code: tax.code, name: tax.name, rate: tax.rate,
          outputAmount: outputAmt,
          inputAmount: inputAmt,
          netPayable: outputAmt - inputAmt,
          status: (outputAmt - inputAmt) > 0 ? 'payable' : 'refundable'
        });
      }
    }

    // Totals
    const totalSales = (await Invoice.aggregate([{ $match: { ...df, status: { $ne: 'draft' } } }, { $group: { _id: null, v: { $sum: '$total' }, s: { $sum: '$subtotal' } } }]))[0] || { v:0, s:0 };
    const totalPurch = (await Purchase.aggregate([{ $match: { ...df, status: { $ne: 'draft' } } }, { $group: { _id: null, v: { $sum: '$total' } } }]))[0] || { v:0 };

    res.json({
      outputTaxes,
      inputTaxes,
      irdPositions,
      totalSalesGross:   totalSales.v,
      totalSalesNet:     totalSales.s,
      totalPurchasesGross: totalPurch.v,
      from: from || null,
      to:   to   || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TAX DETAIL DRILL-DOWN ──────────────────────────────────────────────────
// Returns all invoices/purchases that contributed to a specific tax code
router.get('/detail/:code', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { code } = req.params;
    const { from, to } = req.query;
    let df = {};
    if (from || to) {
      df.date = {};
      if (from) df.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); df.date.$lte = d; }
    }

    const invoices = await Invoice.aggregate([
      { $match: { ...df, status: { $ne: 'draft' }, 'items.taxLines.taxCode': code } },
      { $project: {
        invoiceNo: 1, customerName: 1, date: 1, total: 1,
        taxAmount: {
          $reduce: {
            input: { $reduce: { input: '$items', initialValue: [], in: { $concatArrays: ['$$value', '$$this.taxLines'] } } },
            initialValue: 0,
            in: { $cond: [{ $eq: ['$$this.taxCode', code] }, { $add: ['$$value', '$$this.amount'] }, '$$value'] }
          }
        }
      }},
      { $sort: { date: -1 } }
    ]);

    const purchases = await Purchase.aggregate([
      { $match: { ...df, status: { $ne: 'draft' }, 'items.taxLines.taxCode': code } },
      { $project: {
        purchaseNo: 1, supplierName: 1, date: 1, total: 1,
        taxAmount: {
          $reduce: {
            input: { $reduce: { input: '$items', initialValue: [], in: { $concatArrays: ['$$value', '$$this.taxLines'] } } },
            initialValue: 0,
            in: { $cond: [{ $eq: ['$$this.taxCode', code] }, { $add: ['$$value', '$$this.amount'] }, '$$value'] }
          }
        }
      }},
      { $sort: { date: -1 } }
    ]);

    res.json({
      code,
      invoices,
      purchases,
      totalInvoiceTax:  invoices.reduce((s,i)  => s + i.taxAmount, 0),
      totalPurchaseTax: purchases.reduce((s,p) => s + p.taxAmount, 0)
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET monthly tax summary - dynamic per-tax
router.get('/monthly', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const taxRates = await TaxRate.find({ active: true });

    const invMonthly = await Invoice.aggregate([
      { $match: { status: { $ne: 'draft' }, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $unwind: '$items' }, { $unwind: '$items.taxLines' },
      { $group: {
        _id: { month: { $month: '$date' }, code: '$items.taxLines.taxCode' },
        amount: { $sum: '$items.taxLines.amount' }
      }}
    ]);

    const purMonthly = await Purchase.aggregate([
      { $match: { status: { $ne: 'draft' }, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $unwind: '$items' }, { $unwind: '$items.taxLines' },
      { $group: {
        _id: { month: { $month: '$date' }, code: '$items.taxLines.taxCode' },
        amount: { $sum: '$items.taxLines.amount' }
      }}
    ]);

    const invSales = await Invoice.aggregate([
      { $match: { status: { $ne: 'draft' }, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $group: { _id: { $month: '$date' }, totalSales: { $sum: '$subtotal' }, totalGross: { $sum: '$total' } } }
    ]);
    const purTotals = await Purchase.aggregate([
      { $match: { status: { $ne: 'draft' }, date: { $gte: new Date(y,0,1), $lte: new Date(y,11,31,23,59,59) } } },
      { $group: { _id: { $month: '$date' }, totalPurch: { $sum: '$subtotal' } } }
    ]);

    // Build monthly data
    const invMap  = {};
    for (const r of invMonthly) invMap[`${r._id.month}_${r._id.code}`] = r.amount;
    const purMap  = {};
    for (const r of purMonthly) purMap[`${r._id.month}_${r._id.code}`] = r.amount;
    const salesMap = Object.fromEntries(invSales.map(r => [r._id, r]));
    const purchMap = Object.fromEntries(purTotals.map(r => [r._id, r]));

    const creditableCodes = taxRates.filter(t => t.creditable).map(t => t.code);

    const months = Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      let outputVAT = 0, inputVAT = 0;
      const taxBreakdown = {};
      for (const tax of taxRates) {
        const out = invMap[`${m}_${tax.code}`] || 0;
        const inp = purMap[`${m}_${tax.code}`] || 0;
        taxBreakdown[tax.code] = { out, inp };
        if (tax.creditable) { outputVAT += out; inputVAT += inp; }
      }
      return {
        month: m,
        monthName: new Date(y, i, 1).toLocaleString('default', { month: 'long' }),
        totalSales: salesMap[m]?.totalSales || 0,
        totalPurch: purchMap[m]?.totalPurch || 0,
        outputVAT, inputVAT,
        netVAT: outputVAT - inputVAT,
        taxBreakdown
      };
    });

    const totals = months.reduce((acc, m) => ({
      totalSales: acc.totalSales + m.totalSales,
      totalPurch: acc.totalPurch + m.totalPurch,
      outputVAT:  acc.outputVAT  + m.outputVAT,
      inputVAT:   acc.inputVAT   + m.inputVAT,
      netVAT:     acc.netVAT     + m.netVAT
    }), { totalSales:0, totalPurch:0, outputVAT:0, inputVAT:0, netVAT:0 });

    res.json({ year: y, months, totals, taxRates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
