const router  = require('express').Router();
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Ledger  = require('../models/Ledger');
const CashAccount = require('../models/CashAccount');
const BankAccount = require('../models/BankAccount');
const Customer    = require('../models/Customer');
const InvoiceType = require('../models/InvoiceType');

async function generateInvoiceNumber(typeId, date) {
  if (!typeId) {
    const last = await Invoice.findOne({ invoiceType: null }).sort({ createdAt: -1 });
    const n = last ? parseInt(last.invoiceNo.split('-')[1] || 0) + 1 : 1;
    return `INV-${String(n).padStart(4,'0')}`;
  }
  const type = await InvoiceType.findById(typeId);
  if (!type) return `INV-0001`;
  const d = date ? new Date(date) : new Date();
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yy = d.getFullYear();
  const dateStr = `${dd}/${mm}/${yy}`;
  // Determine if counter should reset
  let reset = false;
  const lastDate = type.lastResetDate ? new Date(type.lastResetDate) : null;
  if (type.resetCycle === 'daily'   && (!lastDate || lastDate.toDateString() !== d.toDateString())) reset = true;
  if (type.resetCycle === 'monthly' && (!lastDate || lastDate.getMonth() !== d.getMonth() || lastDate.getFullYear() !== d.getFullYear())) reset = true;
  if (type.resetCycle === 'yearly'  && (!lastDate || lastDate.getFullYear() !== d.getFullYear())) reset = true;
  const counter = reset ? 1 : (type.lastCounter || 0) + 1;
  type.lastCounter = counter;
  type.lastResetDate = d;
  await type.save();
  return `${type.prefix}-${dateStr}-${String(counter).padStart(type.padLength || 4, '0')}`;
}

function calcTaxes(items, taxInclusive) {
  // businessTax=true: calculated for IRD records only, NOT added to invoice total, NOT shown to customer
  // businessTax=false: customer's tax, included in price (inclusive) or added on top (exclusive)
  let subtotal = 0, totalTax = 0, businessTaxTotal = 0;
  const breakdown = {};
  for (const item of items) {
    item.lineSubtotal = (item.qty || 0) * (item.unitPrice || 0);
    const custTaxes = (item.taxLines||[]).filter(tl => !tl.businessTax);
    const bizTaxes  = (item.taxLines||[]).filter(tl =>  tl.businessTax);
    const normal    = custTaxes.filter(tl => !(tl.reducedBy && tl.reducedBy.length));
    const reduced   = custTaxes.filter(tl =>   tl.reducedBy && tl.reducedBy.length);
    let cTax = 0, bTax = 0;
    if (taxInclusive) {
      const embRate = custTaxes.reduce((s,tl) => s+tl.rate, 0);
      const net = embRate ? item.lineSubtotal / (1 + embRate/100) : item.lineSubtotal;
      for (const tl of custTaxes) {
        tl.amount = net*(tl.rate/100); cTax += tl.amount;
        breakdown[tl.taxCode] = { taxCode:tl.taxCode, taxName:tl.taxName, rate:tl.rate, businessTax:false, amount:(breakdown[tl.taxCode]?.amount||0)+tl.amount };
      }
      for (const tl of bizTaxes) {
        const p1  = custTaxes.reduce((s,t)=>s+t.amount, 0);
        const sub = (tl.reducedBy||[]).reduce((s,c)=>{ const f=custTaxes.find(t=>t.taxCode===c); return s+(f?f.amount:0); }, 0);
        tl.amount = Math.max(0,(net+p1)-sub)*(tl.rate/100); bTax += tl.amount;
        breakdown[tl.taxCode] = { taxCode:tl.taxCode, taxName:tl.taxName, rate:tl.rate, businessTax:true, amount:(breakdown[tl.taxCode]?.amount||0)+tl.amount };
      }
      item.lineTotal = item.lineSubtotal;
    } else {
      for (const tl of normal) {
        tl.amount = item.lineSubtotal*(tl.rate/100); cTax += tl.amount;
        breakdown[tl.taxCode] = { taxCode:tl.taxCode, taxName:tl.taxName, rate:tl.rate, businessTax:false, amount:(breakdown[tl.taxCode]?.amount||0)+tl.amount };
      }
      for (const tl of reduced) {
        const p1  = normal.reduce((s,t)=>s+t.amount, 0);
        const sub = (tl.reducedBy||[]).reduce((s,c)=>{ const f=normal.find(t=>t.taxCode===c); return s+(f?f.amount:0); }, 0);
        tl.amount = Math.max(0,(item.lineSubtotal+p1)-sub)*(tl.rate/100); cTax += tl.amount;
        breakdown[tl.taxCode] = { taxCode:tl.taxCode, taxName:tl.taxName, rate:tl.rate, businessTax:false, amount:(breakdown[tl.taxCode]?.amount||0)+tl.amount };
      }
      for (const tl of bizTaxes) {
        const p1  = [...normal,...reduced].reduce((s,t)=>s+t.amount, 0);
        const sub = (tl.reducedBy||[]).reduce((s,c)=>{ const f=[...normal,...reduced].find(t=>t.taxCode===c); return s+(f?f.amount:0); }, 0);
        tl.amount = Math.max(0,(item.lineSubtotal+p1)-sub)*(tl.rate/100); bTax += tl.amount;
        breakdown[tl.taxCode] = { taxCode:tl.taxCode, taxName:tl.taxName, rate:tl.rate, businessTax:true, amount:(breakdown[tl.taxCode]?.amount||0)+tl.amount };
      }
      item.lineTotal = item.lineSubtotal + cTax;
    }
    item.taxAmount = cTax + bTax;
    item.customerTaxAmount = cTax;
    item.businessTaxAmount = bTax;
    subtotal += item.lineSubtotal; totalTax += cTax; businessTaxTotal += bTax;
  }
  return { subtotal, totalTax, businessTaxTotal, breakdown: Object.values(breakdown) };
}

// GET all invoices
router.get('/', async (req, res) => {
  try {
    const { status, customer, from, to } = req.query;
    let q = {};
    if (status)   q.status = status;
    if (customer) q.customer = customer;
    if (from||to) { q.date={}; if(from)q.date.$gte=new Date(from); if(to){const d=new Date(to);d.setHours(23,59,59);q.date.$lte=d;} }
    res.json(await Invoice.find(q).sort({ date:-1, createdAt:-1 }));
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// GET single invoice
router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const inv = await Invoice.findById(req.params.id).populate('customer');
    if (!inv) return res.status(404).json({ error:'Not found' });
    res.json(inv);
  } catch(err) { res.status(500).json({ error:err.message }); }
});

// POST create invoice
router.post('/', async (req, res) => {
  try {
    const data = { ...req.body };
    if (!data.customer    || data.customer===''   ) delete data.customer;
    if (!data.cashAccount || data.cashAccount==='') delete data.cashAccount;
    if (!data.bankAccount || data.bankAccount==='') delete data.bankAccount;
    if (!data.invoiceType || data.invoiceType==='') delete data.invoiceType;

    // Generate invoice number
    data.invoiceNo = await generateInvoiceNumber(data.invoiceType, data.date);

    // Calculate taxes
    const { subtotal, totalTax, businessTaxTotal, breakdown } = calcTaxes(data.items || [], data.taxInclusive);
    data.subtotal         = subtotal;
    data.taxAmount        = totalTax;
    data.businessTaxAmount= businessTaxTotal;
    data.taxBreakdown     = breakdown;
    data.total = (data.taxInclusive
      ? (data.items||[]).reduce((s,i) => s+(i.lineTotal||0), 0)
      : subtotal + totalTax) - (data.discount || 0);
    data.balance = data.total - (data.paid || 0);
    if (data.balance <= 0.001)     data.status = 'paid';
    else if ((data.paid||0) > 0)   data.status = 'partial';
    else                           data.status = 'pending';

    const invoice = new Invoice(data);
    await invoice.save();

    // Deduct stock — handles loose selling properly
    for (const item of data.items||[]) {
      if (!item.product) continue;
      const prod = await Product.findById(item.product);
      if (!prod) continue;

      if (item.looseMode && prod.allowLoose && prod.looseConversion > 0) {
        // LOOSE SALE: qty is in loose units (e.g. kg)
        // Step 1: subtract from existing loose stock first
        let looseNeeded = item.qty;
        let currentLoose = prod.looseStock || 0;
        let currentBags  = prod.stock || 0;

        if (currentLoose >= looseNeeded) {
          // Enough loose stock — just deduct from loose
          await Product.findByIdAndUpdate(item.product, {
            $set: { looseStock: currentLoose - looseNeeded }
          });
        } else {
          // Not enough loose — open bags to cover the remainder
          const stillNeeded = looseNeeded - currentLoose;
          const bagsToOpen  = Math.ceil(stillNeeded / prod.looseConversion);
          const looseAdded  = bagsToOpen * prod.looseConversion;
          const newLoose    = looseAdded - stillNeeded; // leftover in the opened bag

          // Use $set only — no conflict between $inc and $set on same field
          await Product.findByIdAndUpdate(item.product, {
            $set: { stock: currentBags - bagsToOpen, looseStock: newLoose }
          });
        }
      } else {
        // FULL UNIT SALE: qty is in base units (bags, boxes etc.)
        if (item.location) {
          await Product.findByIdAndUpdate(item.product,
            { $inc: { stock: -item.qty, [`locationStock.$[el].stock`]: -item.qty } },
            { arrayFilters: [{ 'el.location': item.location }] }
          );
        } else {
          await Product.findByIdAndUpdate(item.product, { $inc: { stock: -item.qty } });
        }
      }
    }

    // Update customer balance
    if (data.customer && data.balance > 0) {
      await Customer.findByIdAndUpdate(data.customer, { $inc: { balance: data.balance } });
    }

    // Update cash/bank account if paid
    if (data.paid > 0) {
      if (data.paymentMode==='cash' && data.cashAccount) {
        await CashAccount.findByIdAndUpdate(data.cashAccount, { $inc: { currentBalance: data.paid } });
      } else if (data.paymentMode==='bank' && data.bankAccount) {
        await BankAccount.findByIdAndUpdate(data.bankAccount, { $inc: { currentBalance: data.paid } });
      }
    }

    // Ledger entries
    const le = [
      { date:data.date, account:'Sales Revenue', accountType:'revenue', debit:0, credit:subtotal, description:`Invoice ${data.invoiceNo}`, reference:data.invoiceNo, sourceType:'invoice', sourceId:invoice._id },
      { date:data.date, account:'Accounts Receivable', accountType:'receivable', debit:data.total, credit:0, description:`Invoice ${data.invoiceNo}`, reference:data.invoiceNo, sourceType:'invoice', sourceId:invoice._id },
    ];
    // Customer tax payables (on total customer taxes)
    for (const tl of breakdown.filter(t=>!t.businessTax && t.amount)) {
      le.push({ date:data.date, account:tl.taxCode+' Payable', accountType:'payable', debit:0, credit:tl.amount, description:`${tl.taxCode} on ${data.invoiceNo}`, reference:data.invoiceNo, sourceType:'invoice', sourceId:invoice._id });
    }
    // Business tax payables (SSCL etc — your liability)
    for (const tl of breakdown.filter(t=>t.businessTax && t.amount)) {
      le.push({ date:data.date, account:tl.taxCode+' Payable', accountType:'payable', debit:0, credit:tl.amount, description:`${tl.taxCode} liability on ${data.invoiceNo}`, reference:data.invoiceNo, sourceType:'invoice', sourceId:invoice._id });
    }
    if (data.paid > 0) {
      const acc = data.paymentMode==='bank' ? 'Bank' : 'Cash';
      le.push({ date:data.date, account:acc, accountType:data.paymentMode==='bank'?'bank':'cash', debit:data.paid, credit:0, description:`Payment ${data.invoiceNo}`, reference:data.invoiceNo, sourceType:'invoice', sourceId:invoice._id });
      le.push({ date:data.date, account:'Accounts Receivable', accountType:'receivable', debit:0, credit:data.paid, description:`Payment ${data.invoiceNo}`, reference:data.invoiceNo, sourceType:'invoice', sourceId:invoice._id });
    }
    await Ledger.insertMany(le);

    res.status(201).json(invoice);
  } catch(err) { res.status(400).json({ error:err.message }); }
});

// PATCH record payment
router.patch('/:id/payment', async (req, res) => {
  try {
    const { amount, paymentMode, cashAccount, bankAccount, chequeNo, date } = req.body;
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).json({ error:'Not found' });
    const pay = Math.min(Number(amount), inv.balance);
    inv.paid    += pay;
    inv.balance  = inv.total - inv.paid;
    if (inv.balance <= 0.001)     inv.status = 'paid';
    else if (inv.paid > 0)        inv.status = 'partial';
    if (cashAccount) inv.cashAccount = cashAccount;
    if (bankAccount) inv.bankAccount = bankAccount;
    if (chequeNo)    inv.chequeNo    = chequeNo;
    await inv.save();
    if (inv.customer) await Customer.findByIdAndUpdate(inv.customer, { $inc: { balance: -pay } });
    if (paymentMode==='cash' && cashAccount)  await CashAccount.findByIdAndUpdate(cashAccount, { $inc: { currentBalance: pay } });
    if (paymentMode==='bank' && bankAccount)  await BankAccount.findByIdAndUpdate(bankAccount, { $inc: { currentBalance: pay } });
    const acc = paymentMode==='bank' ? 'Bank' : 'Cash';
    await Ledger.insertMany([
      { date:date||new Date(), account:acc, accountType:paymentMode==='bank'?'bank':'cash', debit:pay, credit:0, description:`Payment ${inv.invoiceNo}`, reference:inv.invoiceNo, sourceType:'invoice', sourceId:inv._id },
      { date:date||new Date(), account:'Accounts Receivable', accountType:'receivable', debit:0, credit:pay, description:`Payment ${inv.invoiceNo}`, reference:inv.invoiceNo, sourceType:'invoice', sourceId:inv._id },
    ]);
    res.json(inv);
  } catch(err) { res.status(400).json({ error:err.message }); }
});

// DELETE invoice
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return res.status(404).json({ error:'Not found' });
    // Restore stock
    for (const item of inv.items||[]) {
      if (item.product) await Product.findByIdAndUpdate(item.product, { $inc: { stock: item.qty } });
    }
    if (inv.customer && inv.balance > 0) await Customer.findByIdAndUpdate(inv.customer, { $inc: { balance: -inv.balance } });
    await Ledger.deleteMany({ sourceId:inv._id, sourceType:'invoice' });
    await Invoice.findByIdAndDelete(req.params.id);
    res.json({ message:'Deleted' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;
