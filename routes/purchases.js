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
const Settings = require('../models/Settings');
const LedgerAccount = require('../models/LedgerAccount');
const { loadTaxMap, purchaseTaxRow, ROW_TYPE } = require('../utils/taxAccounts');

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

// Spread the product-cost part of each extra cost over the lines, by the row's method:
// value (line value), qty (quantity) or equal (same per line). Older rows spread their whole amount.
function distributeLanding(items, landingCosts) {
  const shares = items.map(() => 0);
  for (const lc of landingCosts) {
    const amt = lc.kind ? (lc.landedAmount || 0) : (lc.amount || 0);
    if (!amt || !items.length) continue;
    let w = lc.method === 'qty' ? items.map(i => i.qty || 0) : lc.method === 'equal' ? items.map(() => 1) : items.map(i => i.lineTotal || 0);
    let tw = w.reduce((s, x) => s + x, 0);
    if (!tw) { w = items.map(() => 1); tw = items.length; }
    w.forEach((x, k) => { shares[k] += amt * x / tw; });
  }
  return items.map((item, k) => ({ ...item, landingCostShare: shares[k], finalUnitCost: (item.unitCost || 0) + (item.qty ? shares[k] / item.qty : 0) }));
}

// Everything computePurchase / buildPurchaseLedger look up: tax accounts, the default extra-cost
// account (Settings) and the Chart of Accounts types.
async function purchaseContext() {
  const [taxMap, settings, accs] = await Promise.all([loadTaxMap(), Settings.getSingleton(), LedgerAccount.find({ active: true }).lean()]);
  return { taxMap, landingAccount: settings.defaultLandingCostAccount || 'Landing Costs',
    accType: Object.fromEntries(accs.map(a => [a.name, ROW_TYPE[a.type] || 'expense'])) };
}

const r2 = x => Math.round(x * 100) / 100;
const asBool = v => v === true || v === 'true';
const unset = v => v === undefined || v === null || v === '';

// A tax-aware extra-cost row. The server works out every figure from what was entered:
//   cost, no tax: base = entered | tax included: tax = total × rate / (100 + rate) | tax on top: tax = base × rate / 100
//   tax paid (duty, import VAT…): base = 0, tax = entered
// Product-cost part = addToCost ? base + (claimable ? 0 : tax) : 0 — claimable tax never enters cost.
function extraCostRow(lc, ctx, exRate) {
  const what = lc.description || 'Extra cost';
  if (!['cost', 'tax'].includes(lc.kind)) throw new Error(`${what}: unknown extra cost type`);
  if (lc.currency && lc.currency !== 'LKR' && lc.amountForeign) lc.entered = lc.amountForeign * exRate;
  const entered = r2(Number(lc.entered) || 0);
  if (!(entered > 0)) throw new Error(`${what}: enter an amount more than 0`);
  lc.entered = entered;
  if (lc.kind === 'tax') lc.taxMode = 'none';
  const mode = lc.kind === 'tax' ? 'tax' : (lc.taxMode || 'none');
  if (!['none', 'included', 'added', 'tax'].includes(mode)) throw new Error(`${what}: unknown tax option`);
  let tax = null;
  if (mode !== 'none') {
    tax = ctx.taxMap[lc.taxCode];
    if (!tax) throw new Error(`${what}: choose a tax from Tax Rates${lc.taxCode ? ` ("${lc.taxCode}" is not an active tax)` : ''}`);
  } else lc.taxCode = '';
  let rate = 0;
  if (mode === 'included' || mode === 'added') {
    rate = unset(lc.taxRate) ? tax.rate : Number(lc.taxRate);
    if (!(rate >= 0)) throw new Error(`${what}: the tax rate must be 0 or more`);
  }
  let base, t;
  if (mode === 'none')          { base = entered; t = 0; }
  else if (mode === 'included') { t = r2(entered * rate / (100 + rate)); base = r2(entered - t); }
  else if (mode === 'added')    { base = entered; t = r2(base * rate / 100); }
  else                          { base = 0; t = entered; }
  lc.taxRate = (mode === 'included' || mode === 'added') ? rate : undefined;
  lc.baseAmount = base; lc.taxAmount = t; lc.amount = r2(base + t);
  lc.claimable = t ? (unset(lc.claimable) ? tax.creditable : asBool(lc.claimable)) : false;
  lc.addToCost = unset(lc.addToCost) ? (lc.kind === 'cost' ? true : !lc.claimable) : asBool(lc.addToCost);
  lc.costAccount = lc.kind === 'cost' ? (lc.costAccount || ctx.landingAccount) : '';
  if (lc.costAccount && lc.costAccount !== ctx.landingAccount && !ctx.accType[lc.costAccount])
    throw new Error(`${what}: "${lc.costAccount}" is not an active account in the Chart of Accounts`);
  lc.landedAmount = lc.addToCost ? r2(base + (lc.claimable ? 0 : t)) : 0;
  lc.isImportTax = false;
  if (!['value', 'qty', 'equal'].includes(lc.method)) lc.method = 'value';
  lc.payMode = ['cash', 'bank'].includes(lc.payMode) ? lc.payMode : 'owe';
  if (lc.payMode === 'cash' && !lc.cashAccount) throw new Error(`${what}: select the cash account it was paid from`);
  if (lc.payMode === 'bank' && !lc.bankAccount) throw new Error(`${what}: select the bank account it was paid from`);
  if (lc.payMode !== 'cash') delete lc.cashAccount;
  if (lc.payMode !== 'bank') delete lc.bankAccount;
}

// ── Extra costs paid directly from cash / bank (not added to what you owe the supplier) ──
const paidDirect = lc => !!lc.kind && ['cash', 'bank'].includes(lc.payMode);
const newRowId = () => new mongoose.Types.ObjectId().toString();
// The fields a person enters; if none changed, a saved row keeps its saved figures
const ROW_INPUT = ['kind', 'taxMode', 'entered', 'taxCode', 'taxRate', 'claimable', 'addToCost', 'costAccount', 'method', 'payMode', 'currency', 'amountForeign', 'description'];
const sameInput = (a, b) => ROW_INPUT.every(k => String(a[k] ?? '') === String(b[k] ?? ''));

// Check the cash / bank account exists before anything is saved; returns its name
async function directAccountName(lc) {
  const acc = lc.payMode === 'bank' ? await BankAccount.findById(lc.bankAccount) : await CashAccount.findById(lc.cashAccount);
  if (!acc) throw new Error(`${lc.description}: ${lc.payMode} account not found`);
  return acc.name;
}
// Dr the cost / tax accounts, Cr the cash / bank account, on the row's own date
function directLedgerRows(po, lc, ctx) {
  const base = { date: lc.date || po.date, reference: po.purchaseNo, sourceType: 'purchase', sourceId: po._id, narration: `extra:${lc.rowId}`,
    description: `${lc.description} — PO ${po.purchaseNo} (paid directly)` };
  const le = [];
  if (lc.baseAmount) le.push({ ...base, account: lc.costAccount, accountType: ctx.accType[lc.costAccount] || 'expense', debit: lc.baseAmount, credit: 0 });
  if (lc.taxAmount) le.push(purchaseTaxRow(ctx.taxMap, lc.taxCode, lc.taxAmount, lc.claimable, base));
  le.push({ ...base, account: lc.moneyAccountName, accountType: lc.payMode, debit: 0, credit: lc.amount });
  return le;
}
// Same money movement as payPurchase
async function payExtraDirect(po, lc) {
  if (lc.payMode === 'bank') await BankAccount.findByIdAndUpdate(lc.bankAccount, { $inc: { currentBalance: -lc.amount } });
  else {
    await CashAccount.findByIdAndUpdate(lc.cashAccount, { $inc: { currentBalance: -lc.amount } });
    const ce = await CashEntry.create({ date: lc.date || po.date, type: 'out', category: 'Purchase Extra Cost', description: `${lc.description} for ${po.purchaseNo}${po.supplierName ? ' - ' + po.supplierName : ''}`,
      reference: po.purchaseNo, amount: lc.amount, paymentMode: 'cash', cashAccount: lc.cashAccount, cashAccountName: lc.moneyAccountName });
    lc.cashEntry = ce._id;
  }
}
async function undoExtraDirect(po, lc) {
  if (lc.payMode === 'bank' && lc.bankAccount) await BankAccount.findByIdAndUpdate(lc.bankAccount, { $inc: { currentBalance: lc.amount } });
  if (lc.payMode === 'cash' && lc.cashAccount) await CashAccount.findByIdAndUpdate(lc.cashAccount, { $inc: { currentBalance: lc.amount } });
  if (lc.cashEntry) await CashEntry.findByIdAndDelete(lc.cashEntry);
  await Ledger.deleteMany({ sourceType: 'purchase', sourceId: po._id, narration: `extra:${lc.rowId}` });
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

// Item loop, item taxes, extra (landing) costs and totals. Mutates `data` exactly as POST / always
// has; returns the figures buildPurchaseLedger needs. Taxes are gathered per code into
// data.taxTotals; whether each is claimable comes from Setup → Tax Rates (taxMap).
function computePurchase(data, ctx) {
  const taxMap = ctx.taxMap;
  const isImport = data.purchaseType === 'import';
  const exRate = isImport ? (data.exchangeRate || 1) : 1;
  let subForeign = 0, subLKR = 0, totalTax = 0;
  const taxTotals = {};
  const creditable = code => !!(taxMap[code] && taxMap[code].creditable);
  const owedTax = {};   // posted with the purchase (Cr Accounts Payable); taxTotals also shows paid-directly taxes
  const addTax = (code, name, amt, claimable, owed = true) => {
    if (!amt) return;
    const c = code || '', k = c + '|' + (claimable ? 1 : 0);
    for (const m of owed ? [taxTotals, owedTax] : [taxTotals]) {
      if (!m[k]) m[k] = { taxCode: c, taxName: name || (taxMap[c] && taxMap[c].name) || c, amount: 0, claimable };
      m[k].amount += amt;
    }
  };

  for (const item of data.items) {
    if (isImport) { item.unitCostForeign = item.unitCostForeign || 0; item.unitCost = item.unitCostForeign * exRate; }
    item.lineSubtotal = (item.qty || 0) * (item.unitCost || 0);
    subForeign += (item.qty || 0) * (item.unitCostForeign || 0);
    let itemTax = 0, costTax = 0;
    if (!data.taxInclusive && item.taxLines && item.taxLines.length) {
      item.taxLines = item.taxLines.map(tl => {
        const amt = item.lineSubtotal * (tl.rate / 100);
        addTax(tl.taxCode, tl.taxName, amt, creditable(tl.taxCode));
        if (!creditable(tl.taxCode)) costTax += amt;
        itemTax += amt; return { ...tl, amount: amt };
      });
    }
    item.taxAmount = itemTax; item.lineTotal = item.lineSubtotal + itemTax;
    item._costTax = costTax;
    totalTax += itemTax; subLKR += item.lineSubtotal;
  }

  let landingTotal = 0, landedTotal = 0;
  const costByAccount = {};   // cost part (base) of extra costs, per account
  const addCost = (acc, amt) => { if (amt) costByAccount[acc] = (costByAccount[acc] || 0) + amt; };
  for (const lc of (data.landingCosts || [])) {
    if (!lc.kind) {   // older row: unchanged behaviour (whole amount into cost, import taxes by code)
      if (lc.currency && lc.currency !== 'LKR' && lc.amountForeign) lc.amount = lc.amountForeign * exRate;
      if (lc.isImportTax) addTax(lc.taxCode, '', lc.amount || 0, creditable(lc.taxCode));
      else addCost(ctx.landingAccount, lc.amount || 0);
      lc.landedAmount = lc.amount || 0;
    } else {
      if (!lc._frozen) extraCostRow(lc, ctx, exRate);
      delete lc._frozen;
      if (paidDirect(lc)) {   // its own rows (directLedgerRows); not part of the purchase total
        addTax(lc.taxCode, '', lc.taxAmount, lc.claimable, false);
        landedTotal += lc.landedAmount || 0;
        continue;
      }
      addCost(lc.costAccount, lc.baseAmount);
      addTax(lc.taxCode, '', lc.taxAmount, lc.claimable);
    }
    landingTotal += lc.amount || 0;
    landedTotal += lc.landedAmount || 0;
  }

  data.items = distributeLanding(data.items, data.landingCosts || []);
  // Non-claimable item tax is part of what the goods cost (older purchases: unchanged)
  for (const item of data.items) {
    if (data.taxVersion >= 1 && item.qty) item.finalUnitCost += item._costTax / item.qty;
    delete item._costTax;
  }
  data.subtotalForeign = subForeign; data.subtotal = subLKR;
  data.taxAmount = totalTax; data.landingCostTotal = landingTotal;
  data.landedCostTotal = landedTotal;
  data.importTaxTotal = (data.landingCosts || []).filter(lc => !lc.kind && lc.isImportTax).reduce((s, lc) => s + (lc.amount || 0), 0);
  data.taxTotals = Object.values(taxTotals);
  data.total = subLKR + totalTax + landingTotal;
  data.balance = data.total - (data.paid || 0);
  return { subLKR, costByAccount, taxTotals: Object.values(owedTax), total: data.total };
}

// The purchase's own ledger rows (payments are separate rows tagged narration 'stage:<id>').
// Built before anything is saved so a one-sided entry can never be written.
function buildPurchaseLedger(po, t, ctx) {
  const base = { date: po.date, reference: po.purchaseNo, sourceType: 'purchase', sourceId: po._id };
  const le = [
    { ...base, account: 'Purchases', accountType: 'purchases', debit: t.subLKR, credit: 0, description: `PO ${po.purchaseNo} — ${po.supplierName}` },
    { ...base, account: 'Accounts Payable', accountType: 'payable', debit: 0, credit: t.total, description: `PO ${po.purchaseNo} — ${po.supplierName}` },
  ];
  for (const tt of t.taxTotals)
    le.push(purchaseTaxRow(ctx.taxMap, tt.taxCode, tt.amount, tt.claimable, { ...base, description: `${tt.taxCode || 'Tax'} on PO ${po.purchaseNo}` }));
  for (const [account, amt] of Object.entries(t.costByAccount))
    le.push({ ...base, account, accountType: ctx.accType[account] || 'expense', debit: amt, credit: 0, description: `Extra costs PO ${po.purchaseNo}` });
  const dr = le.reduce((s, e) => s + e.debit, 0), cr = le.reduce((s, e) => s + e.credit, 0);
  if (Math.abs(dr - cr) > 0.005) throw new Error(`PO ${po.purchaseNo}: entries don't balance (Dr ${dr.toFixed(2)}, Cr ${cr.toFixed(2)}). Nothing was saved.`);
  return le.filter(e => e.debit || e.credit);
}

router.post('/', async (req, res) => {
  try {
    const data = { ...req.body };
    if (!data.supplier) delete data.supplier;
    if (!Array.isArray(data.items) || !data.items.length) return res.status(400).json({ error: 'Add at least one item' });
    const upFront = Number(data.paid) || 0;
    if (upFront > 0) {
      const pe = stagePaymentError({ amount: upFront, paymentMode: data.paymentMode, cashAccount: data.cashAccount, bankAccount: data.bankAccount, reference: data.chequeNo || data.paymentReference });
      if (pe) return res.status(400).json({ error: pe });
    }
    data.paid = 0; // recorded below as a payment stage
    if (!data.purchaseNo) data.purchaseNo = await nextPurchaseNo();
    for (const item of data.items) item.receivedQty = 0;
    data.taxVersion = 1;
    for (const lc of (data.landingCosts || [])) lc.rowId = newRowId();
    const ctx = await purchaseContext();
    const totals = computePurchase(data, ctx);
    const direct = (data.landingCosts || []).filter(paidDirect);
    for (const lc of direct) lc.moneyAccountName = await directAccountName(lc);
    // Stock no longer moves here: it moves when goods are received (POST /:id/receipts)
    data.receiptMode = 'staged';

    const purchase = new Purchase(data);
    const rows = buildPurchaseLedger(purchase, totals, ctx);
    for (const lc of direct) rows.push(...directLedgerRows(purchase, lc, ctx));
    await purchase.save();
    if (direct.length) {
      for (const lc of purchase.landingCosts.filter(paidDirect)) await payExtraDirect(purchase, lc);
      purchase.markModified('landingCosts');
      await purchase.save();
    }

    if (data.supplier && data.balance > 0) await Supplier.findByIdAndUpdate(data.supplier, { $inc: { balance: data.balance } });
    await Ledger.insertMany(rows);
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

const plain = d => (d && d.toObject ? d.toObject() : { ...d });
const lineName = (po, i) => (po.items[i] && po.items[i].productName) || `line ${i + 1}`;

// POST record goods received (partial deliveries allowed). Body: { date, note, lines: [{ lineIndex, qty }] }
router.post('/:id/receipts', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    // (Purchases have no cancelled state in this app, so only the mode is checked.)
    if (po.receiptMode !== 'staged')
      return res.status(400).json({ error: 'This older purchase added its stock when it was created, so goods can\'t be received again.' });
    const lines = (req.body.lines || []).map(l => ({ lineIndex: Number(l.lineIndex), qty: Number(l.qty) })).filter(l => l.qty);
    if (!lines.length) return res.status(400).json({ error: 'Enter a quantity for at least one item' });

    const want = {};
    for (const l of lines) {
      if (!Number.isInteger(l.lineIndex) || !po.items[l.lineIndex]) return res.status(400).json({ error: 'Unknown item line' });
      if (!(l.qty > 0)) return res.status(400).json({ error: `Quantity for ${lineName(po, l.lineIndex)} must be more than 0` });
      want[l.lineIndex] = (want[l.lineIndex] || 0) + l.qty;
    }
    for (const [i, q] of Object.entries(want)) {
      const it = po.items[i];
      const left = it.qty - (it.receivedQty || 0);
      if (q > left + 1e-9) return res.status(400).json({ error: `${it.productName}: only ${+left.toFixed(4)} still to receive, you entered ${q}` });
    }

    for (const l of lines) {
      const it = po.items[l.lineIndex];
      it.receivedQty = (it.receivedQty || 0) + l.qty;
      if (po.updateStock !== false && it.product)
        await Product.findByIdAndUpdate(it.product, { $inc: { stock: l.qty }, $set: { costPrice: it.finalUnitCost || it.unitCost } });
    }
    po.receipts.push({ date: req.body.date ? new Date(req.body.date) : new Date(), note: req.body.note || '', lines });
    po.markModified('items');
    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE undo a receipt
router.delete('/:id/receipts/:receiptId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    const rc = po.receipts.id(req.params.receiptId);
    if (!rc) return res.status(404).json({ error: 'Receipt not found' });

    // Stock check first, per product (a product can appear on more than one line)
    if (po.updateStock !== false) {
      const take = {};
      for (const l of rc.lines) { const it = po.items[l.lineIndex]; if (it && it.product) take[it.product] = (take[it.product] || 0) + l.qty; }
      for (const [pid, q] of Object.entries(take)) {
        const prod = await Product.findById(pid);
        if (prod && (prod.stock || 0) < q - 1e-9)
          return res.status(400).json({ error: `Can't undo: ${prod.name} has only ${prod.stock} in stock but this receipt added ${q}. Some may already be sold.` });
      }
      for (const [pid, q] of Object.entries(take)) await Product.findByIdAndUpdate(pid, { $inc: { stock: -q } });
    }
    for (const l of rc.lines) { const it = po.items[l.lineIndex]; if (it) it.receivedQty = Math.max(0, (it.receivedQty || 0) - l.qty); }
    po.receipts.pull(rc._id);
    po.markModified('items');
    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT edit notes, items and extra costs. Items/extra costs are locked once finalized.
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (req.body.notes !== undefined) po.notes = req.body.notes;

    const touchItems = Array.isArray(req.body.items), touchCosts = Array.isArray(req.body.landingCosts);
    if (!touchItems && !touchCosts) { await po.save(); return res.json(po); }
    if (po.isFinalized) return res.status(400).json({ error: 'This purchase is finalized: items and extra costs can no longer be changed.' });

    const oldItems = po.items.map(plain);
    let items = oldItems;
    if (touchItems) {
      items = req.body.items.map(plain);
      if (!items.length) return res.status(400).json({ error: 'A purchase needs at least one item' });
      const sameLine = (a, b) => String(a.product || '') === String(b.product || '') && (a.product || a.productName === b.productName);
      for (let i = 0; i < oldItems.length; i++) {
        const o = oldItems[i], n = items[i];
        const rec = o.receivedQty || 0;
        if ((po.receipts.length || rec > 0) && (!n || !sameLine(o, n)))
          return res.status(400).json({ error: `Goods have been received on this purchase, so lines can't be removed or reordered (${o.productName}). Add new lines instead.` });
        if (n && sameLine(o, n)) {
          n.receivedQty = rec;  // the server's count wins
          if (Number(n.qty) < rec - 1e-9) return res.status(400).json({ error: `${o.productName}: ${rec} already received, so the quantity can't go below ${rec}` });
        }
      }
      for (let i = oldItems.length; i < items.length; i++) items[i].receivedQty = 0;
      for (const it of items) { it.qty = Number(it.qty) || 0; if (!it.product) delete it.product; }
    }
    const oldCosts = po.landingCosts.map(plain);
    const oldById = Object.fromEntries(oldCosts.filter(c => c.rowId).map(c => [c.rowId, c]));
    const seen = new Set();
    const costs = [];
    for (const c0 of (touchCosts ? req.body.landingCosts : po.landingCosts).map(plain)) {
      let c = { ...c0, amount: Number(c0.amount) || 0, date: c0.date || new Date() };
      const old = c.rowId && oldById[c.rowId];
      if (c.rowId && (!old || seen.has(c.rowId))) delete c.rowId;    // ids come from the server only
      // Paid-directly rows are never edited in place (remove and re-add): the saved row wins.
      // Other saved rows keep their saved figures unless what was entered changed.
      if (old && c.rowId) {
        if (paidDirect(old)) c = { ...old, _frozen: true };
        else if (old.kind && sameInput(old, c)) c = { ...old, _frozen: true };
      }
      if (!c.rowId) c.rowId = newRowId();    // also backfills older rows
      seen.add(c.rowId);
      costs.push(c);
    }
    const removedDirect = oldCosts.filter(o => paidDirect(o) && !seen.has(o.rowId));
    const addedDirect = costs.filter(c => paidDirect(c) && !c._frozen);
    for (const lc of addedDirect) lc.moneyAccountName = await directAccountName(lc);

    // Older purchases added stock at creation: keep stock in step when their quantities change
    if (po.receiptMode !== 'staged' && po.updateStock !== false && touchItems) {
      const delta = {};
      for (const it of oldItems) if (it.product) delta[it.product] = (delta[it.product] || 0) - (it.qty || 0);
      for (const it of items) if (it.product) delta[it.product] = (delta[it.product] || 0) + (it.qty || 0);
      for (const [pid, d] of Object.entries(delta)) {
        if (d >= 0) continue;
        const prod = await Product.findById(pid);
        if (prod && (prod.stock || 0) + d < -1e-9) return res.status(400).json({ error: `Can't reduce ${prod.name}: only ${prod.stock} left in stock` });
      }
      for (const [pid, d] of Object.entries(delta)) if (d) await Product.findByIdAndUpdate(pid, { $inc: { stock: d } });
    }

    const data = { purchaseType: po.purchaseType, exchangeRate: po.exchangeRate, taxInclusive: po.taxInclusive, taxVersion: po.taxVersion || 0, paid: po.paid, items, landingCosts: costs };
    const ctx = await purchaseContext();
    const totals = computePurchase(data, ctx);
    const rows = buildPurchaseLedger(po, totals, ctx);
    for (const lc of addedDirect) rows.push(...directLedgerRows(po, lc, ctx));
    const oldTotal = po.total || 0;
    for (const k of ['items', 'landingCosts', 'subtotal', 'subtotalForeign', 'taxAmount', 'landingCostTotal', 'landedCostTotal', 'importTaxTotal', 'taxTotals', 'total']) po[k] = data[k];
    po.landingTaxTotal = 0; // extra-cost taxes are not supported on the server
    await po.save();

    // Re-post the purchase's own rows; payment rows stay: tagged 'stage:<id>' since Oct 5,
    // and older ones untagged but described "Payment PO …"
    // Paid-directly extra costs ('extra:<rowId>') are removed only with their row (below)
    await Ledger.deleteMany({ sourceType: 'purchase', sourceId: po._id, narration: { $not: /^(stage|extra):/ }, description: { $not: /^Payment/ } });
    for (const lc of removedDirect) await undoExtraDirect(po, lc);
    await Ledger.insertMany(rows);
    if (addedDirect.length) {
      const ids = new Set(addedDirect.map(lc => lc.rowId));
      for (const lc of po.landingCosts.filter(x => ids.has(x.rowId))) await payExtraDirect(po, lc);
      po.markModified('landingCosts');
      await po.save();
    }
    if (po.supplier && po.total !== oldTotal) await Supplier.findByIdAndUpdate(po.supplier, { $inc: { balance: po.total - oldTotal } });

    // Extra costs change the real unit cost of goods already on the shelf
    for (const it of po.items) {
      const onShelf = po.receiptMode === 'staged' ? (it.receivedQty || 0) > 0 : po.updateStock !== false;
      if (onShelf && it.product) await Product.findByIdAndUpdate(it.product, { $set: { costPrice: it.finalUnitCost || it.unitCost } });
    }
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH finalize: locks items and extra costs; payments and receipts stay allowed
router.patch('/:id/finalize', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    po.isFinalized = true;
    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH mark goods as received / not received (older purchases only; a label, stock already moved)
router.patch('/:id/goods-received', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const { received, date } = req.body;
    const po = await Purchase.findById(req.params.id);
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.receiptMode === 'staged') return res.status(400).json({ error: 'Use "Goods received" to record what arrived.' });
    po.goodsReceived = !!received;
    po.goodsReceivedDate = received ? (date ? new Date(date) : new Date()) : null;
    await po.save();
    res.json(po);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
