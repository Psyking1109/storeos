const router = require('express').Router();
const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const CashEntry = require('../models/CashEntry');
const Ledger = require('../models/Ledger');
const CashAccount = require('../models/CashAccount');
const BankAccount = require('../models/BankAccount');
const Cheque = require('../models/Cheque');

// Every supplier payment is a payment stage: Dr Accounts Payable, Cr the actual cash/bank account
// (or Cheques Payable for a cheque we write, which hits the bank when it clears).
function stagePaymentError(p) {
  if (!(Number(p.amount) > 0)) return 'Amount required';
  if (p.paymentMode === 'bank' && !p.bankAccount) return 'Select the bank account the payment was made from';
  if ((p.paymentMode || 'cash') === 'cash' && !p.cashAccount) return 'Select the cash account the payment was made from';
  if (p.paymentMode === 'cheque' && !p.reference) return 'Enter the cheque number in Reference';
  if (!['cash', 'bank', 'cheque'].includes(p.paymentMode || 'cash')) return 'To pay with a cheque you received, endorse it from Cheques';
  return null;
}
async function payPurchase(po, p) {
  const amount = Number(p.amount);
  const date = p.date ? new Date(p.date) : new Date();
  // Older POs kept an up-front payment in `paid` without a stage; keep it once stages take over
  if (!po.paymentStages.length && po.paid > 0)
    po.paymentStages.push({ date: po.date, amount: po.paid, paymentMode: po.paymentMode || 'cash', description: 'Paid when PO was created' });

  const stage = po.paymentStages.create({ date, amount, paymentMode: p.paymentMode || 'cash',
    reference: p.reference || '', description: p.description || '' });
  let account = 'Cash', accountType = 'cash';
  if (p.paymentMode === 'bank') {
    const acc = await BankAccount.findByIdAndUpdate(p.bankAccount, { $inc: { currentBalance: -amount } });
    if (!acc) throw new Error('Bank account not found');
    stage.bankAccount = acc._id; account = acc.name; accountType = 'bank';
  } else if (p.paymentMode === 'cheque') {
    const chq = await Cheque.create({ chequeNo: p.reference, direction: 'issued', amount, date,
      dueDate: p.chequeDate || date, party: po.supplierName || 'Supplier', partyId: po.supplier,
      reference: po.purchaseNo, purchase: po._id, status: 'pending', postedBy: 'purchase' });
    stage.cheque = chq._id; account = 'Cheques Payable'; accountType = 'cheque';
  } else {
    const acc = await CashAccount.findByIdAndUpdate(p.cashAccount, { $inc: { currentBalance: -amount } });
    if (!acc) throw new Error('Cash account not found');
    stage.cashAccount = acc._id; account = acc.name;
    await CashEntry.create({ date, type: 'out', category: 'Purchase Payment', description: `Payment for ${po.purchaseNo} - ${po.supplierName || ''}`,
      reference: po.purchaseNo, amount, paymentMode: 'cash', cashAccount: stage.cashAccount, cashAccountName: stage.cashAccount ? account : '' });
  }
  po.paymentStages.push(stage);
  await po.save();
  if (po.supplier) await Supplier.findByIdAndUpdate(po.supplier, { $inc: { balance: -amount } });
  {
    const base = { date, description: `Payment ${po.purchaseNo}${po.supplierName ? ' — ' + po.supplierName : ''}`, reference: po.purchaseNo,
      sourceType: 'purchase', sourceId: po._id, narration: `stage:${stage._id}` };
    await Ledger.insertMany([
      { ...base, account: 'Accounts Payable', accountType: 'payable', debit: amount, credit: 0 },
      { ...base, account, accountType, debit: 0, credit: amount },
    ]);
  }
  return po;
}

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
    const upFront = Number(data.paid) || 0;
    if (upFront > 0) {
      const pe = stagePaymentError({ amount: upFront, paymentMode: data.paymentMode, cashAccount: data.cashAccount, bankAccount: data.bankAccount, reference: data.chequeNo || data.paymentReference });
      if (pe) return res.status(400).json({ error: pe });
    }
    data.paid = 0; // recorded below as a payment stage
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
    const le = [
      { date: data.date, account: 'Purchases', accountType: 'purchases', debit: subLKR, credit: 0, description: `PO ${data.purchaseNo} — ${data.supplierName}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id },
      { date: data.date, account: 'Accounts Payable', accountType: 'payable', debit: 0, credit: data.total, description: `PO ${data.purchaseNo} — ${data.supplierName}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id },
    ];
    if (vatInput)        le.push({ date: data.date, account: 'Input VAT',      accountType: 'asset', debit: vatInput,        credit: 0, description: `Input VAT on PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (palAmt)          le.push({ date: data.date, account: 'PAL Expense',    accountType: 'expense', debit: palAmt,          credit: 0, description: `PAL on PO ${data.purchaseNo}`,       reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (customsDutyTotal)le.push({ date: data.date, account: 'Customs Duty',   accountType: 'expense', debit: customsDutyTotal,credit: 0, description: `Customs on PO ${data.purchaseNo}`,   reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    if (landingTotal - importTaxTotal > 0) le.push({ date: data.date, account: 'Landing Costs', accountType: 'expense', debit: landingTotal - importTaxTotal, credit: 0, description: `Landing costs PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    // Taxes not split out above (SSCL, CESS, other item or import taxes) so Dr always equals Cr
    const otherTax = data.total - le.filter(e => e.debit).reduce((s, e) => s + e.debit, 0);
    if (otherTax > 0.005) le.push({ date: data.date, account: 'Other Purchase Taxes', accountType: 'expense', debit: otherTax, credit: 0, description: `Other taxes on PO ${data.purchaseNo}`, reference: data.purchaseNo, sourceType: 'purchase', sourceId: purchase._id });
    await Ledger.insertMany(le);
    if (upFront > 0) await payPurchase(purchase, { amount: upFront, paymentMode: data.paymentMode, cashAccount: data.cashAccount,
      bankAccount: data.bankAccount, reference: data.chequeNo || data.paymentReference || '', description: 'Paid when PO was created', date: data.date });
    res.status(201).json(purchase);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch('/:id/payment', async (req, res) => {
  try {
    const { amount, paymentMode, cashAccount, bankAccount, chequeNo, date } = req.body;
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const p = { amount, paymentMode, cashAccount, bankAccount, reference: chequeNo || '', date, description: 'Payment' };
    const pe = stagePaymentError(p);
    if (pe) return res.status(400).json({ error: pe });
    res.json(await payPurchase(po, p));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST add a payment stage to an existing purchase
router.post('/:id/payment-stage', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const pe = stagePaymentError(req.body);
    if (pe) return res.status(400).json({ error: pe });
    res.json(await payPurchase(po, req.body));
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

    if (stage.cheque) {
      const chq = await Cheque.findById(stage.cheque);
      if (chq && stage.paymentMode === 'endorsed')
        return res.status(400).json({ error: `Paid with endorsed cheque #${chq.chequeNo}. Reverse the endorsement from Cheques.` });
      if (chq && chq.status !== 'pending')
        return res.status(400).json({ error: `Cheque #${chq.chequeNo} is already ${chq.status}. It can't be removed here.` });
      if (chq) await Cheque.findByIdAndDelete(chq._id);
    }
    // Reverse cash/bank deduction
    if (stage.paymentMode === 'cash' && stage.cashAccount) {
      await CashAccount.findByIdAndUpdate(stage.cashAccount, { $inc: { currentBalance: stage.amount } });
    } else if (stage.paymentMode === 'bank' && stage.bankAccount) {
      await BankAccount.findByIdAndUpdate(stage.bankAccount, { $inc: { currentBalance: stage.amount } });
    }
    if (po.supplier) await Supplier.findByIdAndUpdate(po.supplier, { $inc: { balance: stage.amount } });
    await Ledger.deleteMany({ sourceType: 'purchase', sourceId: po._id, narration: `stage:${stage._id}` });

    po.paymentStages.pull(req.params.stageId);
    if (!po.paymentStages.length) po.paid = 0;
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
