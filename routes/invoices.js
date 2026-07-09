const router  = require('express').Router();
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Ledger  = require('../models/Ledger');
const CashAccount = require('../models/CashAccount');
const BankAccount = require('../models/BankAccount');
const Customer    = require('../models/Customer');
const InvoiceType = require('../models/InvoiceType');
const Counter     = require('../models/Counter');
const Settings    = require('../models/Settings');
const { buildIrdNumber } = require('../utils/irdNumbering');

const DOC_PREFIX = { booking: 'ORD', proforma: 'PRO', invoice: 'INV' };

// Atomic sequential number for Booking/Proforma docs (never skips/repeats under concurrency)
async function generateBookingOrProformaNumber(type) {
  const seq = await Counter.next(type); // key: 'booking' | 'proforma'
  return `${DOC_PREFIX[type]}-${String(seq).padStart(4, '0')}`;
}

async function generateInvoiceNumber(typeId, date) {
  // ── Optional IRD Gazette numbering (YYMMM_QQQQ_XXXXX) — only applies to final Invoices, only when enabled ──
  const settings = await Settings.getSingleton();
  if (settings.irdNumberingEnabled && settings.irdBranchCode) {
    const seq = await Counter.next(`ird:${settings.irdBranchCode}`); // atomic — safe under concurrent invoice creation
    const serial = String(seq).padStart(5, '0'); // numeric only, zero-padded (matches WINPAC example: 26JUL_HQ01_00001)
    const num = buildIrdNumber(date, settings.irdBranchCode, serial);
    if (num.length > 40) throw new Error(`Generated IRD invoice number exceeds 40 characters: ${num}`);
    return num;
  }

  // ── Existing default numbering (unchanged) ──
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

// GET all invoices (optionally filtered by document type: booking/proforma/invoice)
router.get('/', async (req, res) => {
  try {
    const { status, customer, from, to, type, converted } = req.query;
    let q = {};
    if (status)   q.status = status;
    if (customer) q.customer = customer;
    if (from||to) { q.date={}; if(from)q.date.$gte=new Date(from); if(to){const d=new Date(to);d.setHours(23,59,59);q.date.$lte=d;} }
    // Default to 'invoice' only when no explicit type filter is given — this keeps the existing
    // Invoices list page showing exactly what it always showed, with no visible change unless
    // the frontend explicitly asks for bookings/proformas via ?type=booking / ?type=proforma / ?type=all
    if (type && type !== 'all') q.type = type;
    else if (!type) q.type = 'invoice';
    if (converted !== undefined) q.converted = converted === 'true';
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

    // Document type: defaults to 'invoice' so existing frontend calls (which never send `type`)
    // behave EXACTLY as before — this whole feature is additive/opt-in.
    const docType = ['booking','proforma','invoice'].includes(data.type) ? data.type : 'invoice';
    data.type = docType;

    // Calculate taxes/totals (same for all three document types — a quote still needs a price)
    const { subtotal, totalTax, businessTaxTotal, breakdown } = calcTaxes(data.items || [], data.taxInclusive);
    data.subtotal         = subtotal;
    data.taxAmount        = totalTax;
    data.businessTaxAmount= businessTaxTotal;
    data.taxBreakdown     = breakdown;
    data.total = (data.taxInclusive
      ? (data.items||[]).reduce((s,i) => s+(i.lineTotal||0), 0)
      : subtotal + totalTax) - (data.discount || 0);
    data.balance = data.total - (data.paid || 0);

    // ══════════════════════════════════════════════════════════════
    // BOOKING / PROFORMA — soft commitment only. No stock, ledger, or
    // customer-balance impact. Purely a quote/reservation document.
    // ══════════════════════════════════════════════════════════════
    if (docType !== 'invoice') {
      data.invoiceNo = await generateBookingOrProformaNumber(docType);
      data.status = 'draft';
      data.paid = 0;
      data.balance = data.total;
      // Bookings/proformas never track delivery — force every line to zero
      for (const item of data.items || []) {
        item.deliveredQty = 0;
        item.deliveries = [];
      }
      const doc = new Invoice(data);
      await doc.save();
      return res.status(201).json(doc);
    }

    // ══════════════════════════════════════════════════════════════
    // INVOICE (final financial document) — created directly OR via convert.
    // Stock is only deducted for the DELIVERED portion of each line.
    // If the caller doesn't specify deliveredQty (existing frontend today
    // never does), it defaults to the full qty — i.e. "delivered immediately",
    // which is IDENTICAL to the app's pre-existing behavior.
    // ══════════════════════════════════════════════════════════════
    for (const item of data.items || []) {
      const requested = (item.deliveredQty !== undefined && item.deliveredQty !== null)
        ? Number(item.deliveredQty)
        : item.qty; // default: fully delivered now (preserves old behavior)
      item.deliveredQty = Math.max(0, Math.min(requested, item.qty));
      item.deliveries = item.deliveredQty > 0
        ? [{ qty: item.deliveredQty, date: data.date || new Date() }]
        : [];
    }

    data.invoiceNo = await generateInvoiceNumber(data.invoiceType, data.date);
    if (data.balance <= 0.001)     data.status = 'paid';
    else if ((data.paid||0) > 0)   data.status = 'partial';
    else                           data.status = 'pending';

    const invoice = new Invoice(data);
    await invoice.save();

    // Deduct stock — handles loose selling properly. Only the DELIVERED
    // quantity moves stock; any pending (undelivered) portion is settled
    // later via POST /:id/deliver.
    for (const item of data.items||[]) {
      if (!item.product) continue;
      const deliverNowQty = item.deliveredQty || 0;
      if (deliverNowQty <= 0) continue; // nothing physically left the store yet
      const prod = await Product.findById(item.product);
      if (!prod) continue;

      if (item.looseMode && prod.allowLoose && prod.looseConversion > 0) {
        // LOOSE SALE: qty is in loose units (e.g. kg)
        // Step 1: subtract from existing loose stock first
        let looseNeeded = deliverNowQty;
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
            { $inc: { stock: -deliverNowQty, [`locationStock.$[el].stock`]: -deliverNowQty } },
            { arrayFilters: [{ 'el.location': item.location }] }
          );
        } else {
          await Product.findByIdAndUpdate(item.product, { $inc: { stock: -deliverNowQty } });
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

// ══════════════════════════════════════════════════════════════════
// CONVERT — turn a Booking or Proforma into a real Invoice, one click,
// carrying over customer/items/pricing with zero re-entry.
// ══════════════════════════════════════════════════════════════════
router.post('/:id/convert', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const source = await Invoice.findById(req.params.id);
    if (!source) return res.status(404).json({ error: 'Not found' });
    if (source.type === 'invoice') return res.status(400).json({ error: 'This document is already an invoice.' });
    if (source.converted) return res.status(400).json({ error: `Already converted to ${source.convertedToNo}.` });

    // Rebuild items fresh (deliveredQty/deliveries reset to 0 — nothing has been delivered yet)
    const items = source.items.map(i => ({
      product: i.product, productName: i.productName, sku: i.sku, qty: i.qty, unit: i.unit,
      unitPrice: i.unitPrice, taxLines: i.taxLines, location: i.location, locationName: i.locationName,
      deliveredQty: 0, deliveries: []
    }));

    const { subtotal, totalTax, businessTaxTotal, breakdown } = calcTaxes(items, source.taxInclusive);
    const total = (source.taxInclusive
      ? items.reduce((s,i) => s+(i.lineTotal||0), 0)
      : subtotal + totalTax) - (source.discount || 0);

    const invoiceNo = await generateInvoiceNumber(source.invoiceType, source.date);

    const invoice = new Invoice({
      type: 'invoice',
      invoiceNo,
      invoiceType: source.invoiceType,
      invoiceTypeName: source.invoiceTypeName,
      customer: source.customer,
      customerName: source.customerName,
      date: source.date,
      dueDate: source.dueDate,
      items,
      subtotal, taxAmount: totalTax, businessTaxAmount: businessTaxTotal, taxBreakdown: breakdown,
      discount: source.discount || 0,
      total,
      paid: 0,
      balance: total,
      status: 'pending',
      notes: source.notes,
      taxInclusive: source.taxInclusive,
      paymentMode: source.paymentMode,
      convertedFromId: source._id,
      convertedFromNo: source.invoiceNo
    });
    await invoice.save();

    // No stock movement here — nothing has been delivered yet (deliveredQty is 0 on every line).
    // Customer balance / ledger ARE recognized at this point (invoice raised = accrual recognized),
    // matching how a normal invoice would behave, per Section 2 of the design.
    if (invoice.customer && invoice.balance > 0) {
      await Customer.findByIdAndUpdate(invoice.customer, { $inc: { balance: invoice.balance } });
    }
    const le = [
      { date: invoice.date, account:'Sales Revenue', accountType:'revenue', debit:0, credit:subtotal, description:`Invoice ${invoice.invoiceNo} (from ${source.invoiceNo})`, reference:invoice.invoiceNo, sourceType:'invoice', sourceId:invoice._id },
      { date: invoice.date, account:'Accounts Receivable', accountType:'receivable', debit:invoice.total, credit:0, description:`Invoice ${invoice.invoiceNo} (from ${source.invoiceNo})`, reference:invoice.invoiceNo, sourceType:'invoice', sourceId:invoice._id },
    ];
    for (const tl of breakdown.filter(t=>!t.businessTax && t.amount)) {
      le.push({ date: invoice.date, account:tl.taxCode+' Payable', accountType:'payable', debit:0, credit:tl.amount, description:`${tl.taxCode} on ${invoice.invoiceNo}`, reference:invoice.invoiceNo, sourceType:'invoice', sourceId:invoice._id });
    }
    for (const tl of breakdown.filter(t=>t.businessTax && t.amount)) {
      le.push({ date: invoice.date, account:tl.taxCode+' Payable', accountType:'payable', debit:0, credit:tl.amount, description:`${tl.taxCode} liability on ${invoice.invoiceNo}`, reference:invoice.invoiceNo, sourceType:'invoice', sourceId:invoice._id });
    }
    await Ledger.insertMany(le);

    // Mark source as converted so it stops showing as "open" anywhere
    source.converted = true;
    source.convertedToId = invoice._id;
    source.convertedToNo = invoice.invoiceNo;
    await source.save();

    res.status(201).json(invoice);
  } catch(err) { res.status(400).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
// DELIVER — record a partial or full delivery against an existing
// invoice's line items. This is the ONLY place (besides delivery-at-
// creation) that ever reduces Product.stock for an invoice.
// Body: { deliveries: [{ itemId, qty }], date? }
// ══════════════════════════════════════════════════════════════════
router.post('/:id/deliver', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    if (invoice.type !== 'invoice') return res.status(400).json({ error: 'Only confirmed invoices support delivery tracking.' });

    const { deliveries, date } = req.body;
    if (!Array.isArray(deliveries) || !deliveries.length) {
      return res.status(400).json({ error: 'deliveries array is required, e.g. [{ itemId, qty }]' });
    }
    const deliveryDate = date ? new Date(date) : new Date();

    for (const d of deliveries) {
      const qty = Number(d.qty);
      if (!qty || qty <= 0) continue;
      const item = invoice.items.id(d.itemId);
      if (!item) return res.status(400).json({ error: `Line item ${d.itemId} not found on this invoice.` });
      const pending = item.qty - (item.deliveredQty || 0);
      if (qty > pending + 0.0001) {
        return res.status(400).json({ error: `Cannot deliver ${qty} of "${item.productName}" — only ${pending} pending.` });
      }

      item.deliveredQty = (item.deliveredQty || 0) + qty;
      item.deliveries.push({ qty, date: deliveryDate });

      // Move physical stock now — the moment of truth for inventory.
      if (item.product) {
        const prod = await Product.findById(item.product);
        if (prod) {
          if (item.looseMode && prod.allowLoose && prod.looseConversion > 0) {
            let looseNeeded = qty;
            let currentLoose = prod.looseStock || 0;
            let currentBags  = prod.stock || 0;
            if (currentLoose >= looseNeeded) {
              await Product.findByIdAndUpdate(item.product, { $set: { looseStock: currentLoose - looseNeeded } });
            } else {
              const stillNeeded = looseNeeded - currentLoose;
              const bagsToOpen  = Math.ceil(stillNeeded / prod.looseConversion);
              const looseAdded  = bagsToOpen * prod.looseConversion;
              const newLoose    = looseAdded - stillNeeded;
              await Product.findByIdAndUpdate(item.product, { $set: { stock: currentBags - bagsToOpen, looseStock: newLoose } });
            }
          } else if (item.location) {
            await Product.findByIdAndUpdate(item.product,
              { $inc: { stock: -qty, [`locationStock.$[el].stock`]: -qty } },
              { arrayFilters: [{ 'el.location': item.location }] }
            );
          } else {
            await Product.findByIdAndUpdate(item.product, { $inc: { stock: -qty } });
          }
        }
      }
    }

    await invoice.save();
    res.json(invoice);
  } catch(err) { res.status(400).json({ error: err.message }); }
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
    // Restore stock — only the DELIVERED portion was ever deducted, so only restore that much.
    // Bookings/Proformas never touched stock at all (deliveredQty is always 0 for them).
    for (const item of inv.items||[]) {
      const deliveredAmount = item.deliveredQty || 0;
      if (item.product && deliveredAmount > 0) {
        await Product.findByIdAndUpdate(item.product, { $inc: { stock: deliveredAmount } });
      }
    }
    if (inv.type === 'invoice' && inv.customer && inv.balance > 0) {
      await Customer.findByIdAndUpdate(inv.customer, { $inc: { balance: -inv.balance } });
    }
    await Ledger.deleteMany({ sourceId:inv._id, sourceType:'invoice' });
    await Invoice.findByIdAndDelete(req.params.id);
    res.json({ message:'Deleted' });
  } catch(err) { res.status(500).json({ error:err.message }); }
});

module.exports = router;
