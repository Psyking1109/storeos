const router = require('express').Router();
const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const CashEntry = require('../models/CashEntry');
const Ledger = require('../models/Ledger');

async function nextPurchaseNo() {
  const last = await Purchase.findOne().sort({ createdAt: -1 });
  if (!last) return 'PO-0001';
  const num = parseInt((last.purchaseNo.split('-')[1]) || 0) + 1;
  return `PO-${String(num).padStart(4, '0')}`;
}

function distributeLanding(items, landingCosts) {
  const total = landingCosts.reduce((s, lc) => s + (lc.amount || 0), 0);
  if (!total || !items.length) return items.map(i => ({ ...i, landingCostShare: 0, finalUnitCost: i.unitCost }));
  const totalVal = items.reduce((s, i) => s + (i.lineTotal || 0), 0);
  return items.map(item => {
    const share = totalVal ? (item.lineTotal / totalVal) * total : total / items.length;
    return { ...item, landingCostShare: share, finalUnitCost: (item.unitCost || 0) + (item.qty ? share / item.qty : 0) };
  });
}

router.get('/', async (req, res) => {
  try {
    const { status, supplier, purchaseType, from, to } = req.query;
    let q = {};
    if (status)       q.status = status;
    if (supplier)     q.supplier = supplier;
    if (purchaseType) q.purchaseType = purchaseType;
    if (from || to) { q.date = {}; if (from) q.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; } }
    const purchases = await Purchase.find(q).populate('supplier', 'name').sort({ date: -1 });
    res.json(purchases);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const p = await Purchase.findById(req.params.id).populate('supplier');
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const data = { ...req.body };
    if (!data.supplier) delete data.supplier;
    if (!data.purchaseNo) data.purchaseNo = await nextPurchaseNo();
    const isImport = data.purchaseType === 'import';
    const exRate = isImport ? (data.exchangeRate || 1) : 1;
    let subForeign = 0, subLKR = 0, totalTax = 0;
    let vatInput = 0, ssclAmt = 0, customsDutyTotal = 0, cessTotal = 0;

    for (const item of data.items) {
      if (isImport) { item.unitCostForeign = item.unitCostForeign || 0; item.unitCost = item.unitCostForeign * exRate; }
      item.lineSubtotal = (item.qty || 0) * (item.unitCost || 0);
      subForeign += (item.qty || 0) * (item.unitCostForeign || 0);
      let itemTax = 0;
      if (!data.taxInclusive && item.taxLines && item.taxLines.length) {
        item.taxLines = item.taxLines.map(tl => {
          const amt = item.lineSubtotal * (tl.rate / 100);
          if (tl.taxCode === 'VAT')  vatInput += amt;
          if (tl.taxCode === 'SSCL') ssclAmt  += amt;
          itemTax += amt; return { ...tl, amount: amt };
        });
      }
      if (isImport) {
        if (item.customsDutyRate) { item.customsDutyAmt = item.lineSubtotal * (item.customsDutyRate / 100); customsDutyTotal += item.customsDutyAmt; itemTax += item.customsDutyAmt; }
        if (item.cessRate) { item.cessAmt = item.lineSubtotal * (item.cessRate / 100); cessTotal += item.cessAmt; itemTax += item.cessAmt; }
      }
      item.taxAmount = itemTax; item.lineTotal = item.lineSubtotal + itemTax;
      totalTax += itemTax; subLKR += item.lineSubtotal;
    }

    let landingTotal = 0, importTaxTotal = 0, palAmt = 0;
    for (const lc of (data.landingCosts || [])) {
      if (lc.currency && lc.currency !== 'LKR' && lc.amountForeign) lc.amount = lc.amountForeign * exRate;
      landingTotal += lc.amount || 0;
      if (lc.isImportTax) {
        importTaxTotal += lc.amount || 0;
        if (lc.taxCode === 'PAL')       palAmt          += lc.amount || 0;
        if (lc.taxCode === 'VAT')       vatInput        += lc.amount || 0;
        if (lc.taxCode === 'CUST_DUTY') customsDutyTotal += lc.amount || 0;
        if (lc.taxCode === 'CESS')      cessTotal        += lc.amount || 0;
      }
    }

    const itemsWithLanding = distributeLanding(data.items, data.landingCosts || []);
    data.items = itemsWithLanding;
    data.subtotalForeign = subForeign; data.subtotal = subLKR;
    data.taxAmount = totalTax; data.landingCostTotal = landingTotal;
    data.importTaxTotal = importTaxTotal; data.vatInputAmount = vatInput;
    data.palAmount = palAmt; data.customsDutyTotal = customsDutyTotal;
    data.cessTotal = cessTotal; data.ssclAmount = ssclAmt;
    data.total = subLKR + totalTax + landingTotal;
    data.balance = data.total - (data.paid || 0);

    const purchase = new Purchase(data);
    await purchase.save();

    if (data.updateStock !== false) {
      for (const item of itemsWithLanding) {
        if (item.product) await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty }, $set: { costPrice: item.finalUnitCost || item.unitCost } });
      }
    }
    if (data.supplier && data.balance > 0) await Supplier.findByIdAndUpdate(data.supplier, { $inc: { balance: data.balance } });
    if (data.paid > 0) {
      await CashEntry.create({ date: data.date, type: 'out', category: 'Purchase Payment', description: `Payment for ${data.purchaseNo} - ${data.supplierName}`, reference: data.purchaseNo, amount: data.paid, paymentMode: data.paymentMode || 'cash' });
    }
    const le = [
      { date: data.date, account: 'Purchases', accountType: 'purchases', debit: subLKR, credit: 0, description: `PO ${data.purchaseNo} — ${data.supplierName}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id },
      { date: data.date, account: 'Accounts Payable', accountType: 'payable', debit: 0, credit: data.total, description: `PO ${data.purchaseNo} — ${data.supplierName}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id },
    ];
    if (vatInput)        le.push({ date: data.date, account: 'Input VAT',      accountType: 'expense', debit: vatInput,        credit: 0, description: `Input VAT on PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (palAmt)          le.push({ date: data.date, account: 'PAL Expense',    accountType: 'expense', debit: palAmt,          credit: 0, description: `PAL on PO ${data.purchaseNo}`,       reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (customsDutyTotal)le.push({ date: data.date, account: 'Customs Duty',   accountType: 'expense', debit: customsDutyTotal,credit: 0, description: `Customs on PO ${data.purchaseNo}`,   reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (landingTotal - importTaxTotal > 0) le.push({ date: data.date, account: 'Landing Costs', accountType: 'expense', debit: landingTotal - importTaxTotal, credit: 0, description: `Landing costs PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (data.paid > 0) {
      le.push({ date: data.date, account: 'Accounts Payable', accountType: 'payable', debit: data.paid, credit: 0, description: `Payment PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
      le.push({ date: data.date, account: 'Cash', accountType: 'cash', debit: 0, credit: data.paid, description: `Payment PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    }
    await Ledger.insertMany(le);
    res.status(201).json(purchase);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id/payment', async (req, res) => {
  try {
    const { amount, paymentMode, date } = req.body;
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return res.status(404).json({ error: 'Not found' });
    purchase.paid += Number(amount); purchase.balance = purchase.total - purchase.paid;
    await purchase.save();
    if (purchase.supplier) await Supplier.findByIdAndUpdate(purchase.supplier, { $inc: { balance: -Number(amount) } });
    await CashEntry.create({ date: date || new Date(), type: 'out', category: 'Purchase Payment', description: `Payment for ${purchase.purchaseNo}`, reference: purchase.purchaseNo, amount: Number(amount), paymentMode: paymentMode || 'cash' });
    res.json(purchase);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST add a payment stage to an existing purchase
router.post('/:id/payment-stage', async (req, res) => {
  try {
    const { date, amount, paymentMode, reference, description, cashAccount, bankAccount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount required' });

    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });

    const stage = { date, amount: Number(amount), paymentMode, reference, description };
    if (cashAccount) stage.cashAccount = cashAccount;
    if (bankAccount)  stage.bankAccount  = bankAccount;

    po.paymentStages.push(stage);

    // Deduct from cash/bank account
    if (paymentMode === 'cash' && cashAccount) {
      const CashAccount = require('../models/CashAccount');
      await CashAccount.findByIdAndUpdate(cashAccount, { $inc: { currentBalance: -Number(amount) } });
    } else if (paymentMode === 'bank' && bankAccount) {
      const BankAccount = require('../models/BankAccount');
      await BankAccount.findByIdAndUpdate(bankAccount, { $inc: { currentBalance: -Number(amount) } });
    }

    // Also update supplier balance
    const Supplier = require('../models/Supplier');
    if (po.supplier) await Supplier.findByIdAndUpdate(po.supplier, { $inc: { balance: -Number(amount) } });

    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE a payment stage
router.delete('/:id/payment-stage/:stageId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const stage = po.paymentStages.id(req.params.stageId);
    if (!stage) return res.status(404).json({ error: 'Stage not found' });

    // Reverse cash/bank deduction
    if (stage.paymentMode === 'cash' && stage.cashAccount) {
      const CashAccount = require('../models/CashAccount');
      await CashAccount.findByIdAndUpdate(stage.cashAccount, { $inc: { currentBalance: stage.amount } });
    } else if (stage.paymentMode === 'bank' && stage.bankAccount) {
      const BankAccount = require('../models/BankAccount');
      await BankAccount.findByIdAndUpdate(stage.bankAccount, { $inc: { currentBalance: stage.amount } });
    }
    // Reverse supplier balance
    const Supplier = require('../models/Supplier');
    if (po.supplier) await Supplier.findByIdAndUpdate(po.supplier, { $inc: { balance: stage.amount } });

    po.paymentStages.pull(req.params.stageId);
    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH mark goods as received / not received
router.patch('/:id/goods-received', async (req, res) => {
  try {
    const { received, date } = req.body;
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });

    po.goodsReceived = !!received;
    po.goodsReceivedDate = received ? (date ? new Date(date) : new Date()) : null;

    // If receiving now and updateStock was set, update stock
    if (received && po.updateStock && !po.goodsReceived) {
      const Product = require('../models/Product');
      for (const item of po.items) {
        if (item.product) {
          await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
        }
      }
    }

    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
