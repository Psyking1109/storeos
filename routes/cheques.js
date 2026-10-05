const router = require('express').Router();
const mongoose = require('mongoose');
const Cheque = require('../models/Cheque');
const BankAccount = require('../models/BankAccount');
const BankTx = require('../models/BankTx');
const Ledger = require('../models/Ledger');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Invoice = require('../models/Invoice');
const Purchase = require('../models/Purchase');
const LedgerAccount = require('../models/LedgerAccount');

// ── Cheque lifecycle and the books ─────────────────────────────────────────
// Received:  in hand   Dr Cheques Receivable / Cr AR (or chosen account)
//            deposited Dr Bank / Cr Cheques Receivable
//            endorsed  Dr AP (supplier) or expense / Cr Cheques Receivable   (third-party: passed on, never banked)
//            bounced   Dr AR / Cr Bank (after deposit)  or  Dr AR / Cr AP (endorsed cheque dishonoured)
//            cancelled Dr AR / Cr Cheques Receivable (returned to the customer before banking)
// Issued:    written   Dr AP (or chosen account) / Cr Cheques Payable
//            cleared   Dr Cheques Payable / Cr Bank
//            bounced / cancelled before clearing: Dr Cheques Payable / Cr AP

const RECV = 'Cheques Receivable', PAYB = 'Cheques Payable';

function rows(chq, date, description, lines) {
  const base = { date: date || new Date(), description, reference: chq.chequeNo, sourceType: 'cheque', sourceId: chq._id };
  return Ledger.insertMany(lines.map(l => ({ ...base, ...l })));
}

// The account on the other side of the cheque's opening entry
async function contraOf(chq) {
  if (chq.contraAccount) return { account: chq.contraAccount, accountType: chq.contraType || (chq.direction === 'received' ? 'receivable' : 'payable') };
  if (!chq.postedBy) {
    // Cheques entered before this change opened against Sales / Purchases
    const first = await Ledger.findOne({ sourceType: 'cheque', sourceId: chq._id, accountType: { $nin: ['cheque', 'bank'] } }).sort({ createdAt: 1 });
    if (first) return { account: first.account, accountType: first.accountType };
  }
  return chq.direction === 'received'
    ? { account: 'Accounts Receivable', accountType: 'receivable' }
    : { account: 'Accounts Payable', accountType: 'payable' };
}

// Money owed by/to the party changes when a cheque is honoured or not
async function adjustParty(chq, delta) {
  if (!chq.partyId || !delta) return;
  if (chq.direction === 'received') await Customer.findByIdAndUpdate(chq.partyId, { $inc: { balance: delta } });
  else await Supplier.findByIdAndUpdate(chq.partyId, { $inc: { balance: delta } });
}
async function adjustInvoice(chq, paidDelta) {
  if (!chq.invoice || !paidDelta) return;
  const inv = await Invoice.findById(chq.invoice);
  if (!inv) return;
  inv.paid = Math.max(0, (inv.paid || 0) + paidDelta);
  await inv.save();
}
async function dropPurchaseStage(poId, chequeId) {
  if (!poId) return false;
  const po = await Purchase.findById(poId);
  if (!po) return false;
  const st = po.paymentStages.find(s => String(s.cheque) === String(chequeId));
  if (!st) return false;
  po.paymentStages.pull(st._id);
  if (!po.paymentStages.length) po.paid = 0;
  await po.save();
  return true;
}
function log(chq, action, note) { chq.history.push({ date: new Date(), action, note: note || '' }); }

async function depositReceived(chq, accountId, date) {
  const acc = await BankAccount.findById(accountId);
  if (!acc) throw new Error('Select the bank account it was deposited to');
  await BankAccount.findByIdAndUpdate(acc._id, { $inc: { currentBalance: chq.amount } });
  await BankTx.create({ date: date || new Date(), type: 'deposit', account: acc._id, accountName: acc.name, amount: chq.amount,
    description: `Cheque deposit #${chq.chequeNo} — ${chq.party}`, reference: chq.chequeNo, chequeNo: chq.chequeNo, cleared: false });
  await rows(chq, date, `Cheque deposited #${chq.chequeNo}`, [
    { account: acc.name, accountType: 'bank', debit: chq.amount, credit: 0 },
    { account: RECV, accountType: 'cheque', debit: 0, credit: chq.amount },
  ]);
  chq.account = acc._id; chq.accountName = acc.name;
  chq.depositedDate = date || new Date();
}

// GET all cheques
router.get('/', async (req, res) => {
  try {
    const direction = req.query.direction || req.query.dir;
    const status = req.query.status || req.query.sts;
    const { from, to } = req.query;
    let query = {};
    if (direction) query.direction = direction;
    if (status === 'inhand') { query.direction = 'received'; query.status = 'pending'; }
    else if (status) query.status = status;
    if (from || to) {
      query.dueDate = {};
      if (from) query.dueDate.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23,59,59); query.dueDate.$lte = d; }
    }
    const cheques = await Cheque.find(query).populate('account','name').sort({ dueDate: 1 });
    res.json(cheques);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET upcoming cheques (next 30 days)
router.get('/upcoming', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const future = new Date(today); future.setDate(future.getDate() + 30);
    const cheques = await Cheque.find({ dueDate: { $gte: today, $lte: future }, status: { $in: ['pending','deposited'] } }).sort({ dueDate: 1 });
    res.json(cheques);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create cheque (always starts pending: in hand / written, not yet banked)
router.post('/', async (req, res) => {
  try {
    const data = { ...req.body };
    for (const k of ['account', 'partyId', 'invoice', 'purchase']) if (!data[k]) delete data[k];
    delete data.endorsement; delete data.history; delete data.postedBy;
    data.status = 'pending';
    data.amount = Number(data.amount);
    if (!(data.amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });

    // Other side of the opening entry
    if (data.contraAccount) {
      const la = await LedgerAccount.findOne({ name: data.contraAccount });
      data.contraType = la ? la.type : (data.direction === 'received' ? 'income' : 'expense');
    } else {
      data.contraAccount = data.direction === 'received' ? 'Accounts Receivable' : 'Accounts Payable';
      data.contraType = data.direction === 'received' ? 'receivable' : 'payable';
    }
    const cheque = new Cheque(data);
    log(cheque, 'created', data.direction === 'received' ? 'In hand' : 'Written');
    await cheque.save();

    const desc = data.direction === 'received'
      ? `Cheque rcvd #${cheque.chequeNo} from ${cheque.party}${cheque.thirdParty ? ` (drawn by ${cheque.drawer})` : ''}`
      : `Cheque issued #${cheque.chequeNo} to ${cheque.party}`;
    if (cheque.direction === 'received') {
      await rows(cheque, cheque.date, desc, [
        { account: RECV, accountType: 'cheque', debit: cheque.amount, credit: 0 },
        { account: cheque.contraAccount, accountType: cheque.contraType, debit: 0, credit: cheque.amount },
      ]);
    } else {
      await rows(cheque, cheque.date, desc, [
        { account: cheque.contraAccount, accountType: cheque.contraType, debit: cheque.amount, credit: 0 },
        { account: PAYB, accountType: 'cheque', debit: 0, credit: cheque.amount },
      ]);
    }
    // Only a cheque against the customer's/supplier's account settles what they owe
    if (['receivable', 'payable'].includes(cheque.contraType)) {
      await adjustParty(cheque, -cheque.amount);
      await adjustInvoice(cheque, cheque.amount);
    }
    res.status(201).json(cheque);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PATCH update cheque status (deposit / clear / bounce / cancel)
router.patch('/:id/status', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const { status, accountId, clearedDate, depositedDate, note } = req.body;
    const chq = await Cheque.findById(req.params.id);
    if (!chq) return res.status(404).json({ error: 'Not found' });
    const prev = chq.status;
    const when = (d) => d ? new Date(d) : new Date();
    const contra = await contraOf(chq);
    const settlesParty = ['receivable', 'payable'].includes(contra.accountType);
    const bad = () => res.status(400).json({ error: `Can't change a ${prev} ${chq.direction} cheque to ${status}` });

    if (chq.direction === 'received') {
      if (status === 'deposited') {
        if (prev !== 'pending') return bad();
        await depositReceived(chq, accountId || chq.account, when(depositedDate));
      } else if (status === 'cleared') {
        if (prev === 'pending') await depositReceived(chq, accountId || chq.account, when(depositedDate || clearedDate));
        else if (prev !== 'deposited') return bad();
        chq.clearedDate = when(clearedDate);
      } else if (status === 'bounced') {
        if (!['deposited', 'cleared'].includes(prev)) return bad();
        const acc = await BankAccount.findById(chq.account);
        const bankName = acc ? acc.name : (chq.accountName || 'Bank');
        if (acc) {
          await BankAccount.findByIdAndUpdate(acc._id, { $inc: { currentBalance: -chq.amount } });
          await BankTx.create({ date: new Date(), type: 'withdrawal', account: acc._id, accountName: acc.name, amount: chq.amount,
            description: `Cheque returned unpaid #${chq.chequeNo} — ${chq.party}`, reference: chq.chequeNo, chequeNo: chq.chequeNo, cleared: true });
        }
        await rows(chq, new Date(), `Cheque bounced #${chq.chequeNo}`, [
          { account: contra.account, accountType: contra.accountType, debit: chq.amount, credit: 0 },
          { account: bankName, accountType: 'bank', debit: 0, credit: chq.amount },
        ]);
        if (settlesParty) { await adjustParty(chq, chq.amount); await adjustInvoice(chq, -chq.amount); }
      } else if (status === 'cancelled' || status === 'returned') {
        if (prev !== 'pending') return bad();
        await rows(chq, new Date(), `Cheque ${status} #${chq.chequeNo}`, [
          { account: contra.account, accountType: contra.accountType, debit: chq.amount, credit: 0 },
          { account: RECV, accountType: 'cheque', debit: 0, credit: chq.amount },
        ]);
        if (settlesParty) { await adjustParty(chq, chq.amount); await adjustInvoice(chq, -chq.amount); }
      } else return bad();
    } else {
      if (status === 'cleared') {
        if (prev !== 'pending') return bad();
        const acc = await BankAccount.findById(accountId || chq.account);
        if (!acc) return res.status(400).json({ error: 'Select the bank account the cheque was drawn on' });
        await BankAccount.findByIdAndUpdate(acc._id, { $inc: { currentBalance: -chq.amount } });
        await BankTx.create({ date: when(clearedDate), type: 'withdrawal', account: acc._id, accountName: acc.name, amount: chq.amount,
          description: `Cheque cleared #${chq.chequeNo} — ${chq.party}`, reference: chq.chequeNo, chequeNo: chq.chequeNo, cleared: true });
        await rows(chq, when(clearedDate), `Cheque cleared #${chq.chequeNo}`, [
          { account: PAYB, accountType: 'cheque', debit: chq.amount, credit: 0 },
          { account: acc.name, accountType: 'bank', debit: 0, credit: chq.amount },
        ]);
        chq.account = acc._id; chq.accountName = acc.name; chq.clearedDate = when(clearedDate);
      } else if (['bounced', 'cancelled', 'returned'].includes(status)) {
        if (prev !== 'pending') return bad();
        await rows(chq, new Date(), `Cheque ${status} #${chq.chequeNo}`, [
          { account: PAYB, accountType: 'cheque', debit: chq.amount, credit: 0 },
          { account: contra.account, accountType: contra.accountType, debit: 0, credit: chq.amount },
        ]);
        if (settlesParty) {
          // Re-open the PO balance; the stage removal and supplier balance must move together
          await dropPurchaseStage(chq.purchase, chq._id);
          await adjustParty(chq, chq.amount);
        }
      } else return bad();
    }

    chq.status = status;
    log(chq, status, note);
    await chq.save();
    res.json(chq);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST endorse a received cheque to someone else (third-party cheque passed on as payment)
// Body: { toType: 'supplier'|'expense', supplierId?, purchaseId?, payee?, expenseAccount?, date?, note? }
router.post('/:id/endorse', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const chq = await Cheque.findById(req.params.id);
    if (!chq) return res.status(404).json({ error: 'Not found' });
    if (chq.direction !== 'received' || chq.status !== 'pending')
      return res.status(400).json({ error: 'Only a received cheque still in hand can be endorsed' });
    const { toType, supplierId, purchaseId, expenseAccount, note } = req.body;
    const date = req.body.date ? new Date(req.body.date) : new Date();
    const end = { toType, date, note: note || '' };
    let drAccount, drType;

    if (toType === 'supplier') {
      const sup = await Supplier.findById(supplierId);
      if (!sup) return res.status(400).json({ error: 'Select the supplier' });
      end.supplier = sup._id; end.payee = sup.name;
      drAccount = 'Accounts Payable'; drType = 'payable';
      if (purchaseId) {
        const po = await Purchase.findById(purchaseId);
        if (!po || String(po.supplier) !== String(sup._id)) return res.status(400).json({ error: 'That PO does not belong to this supplier' });
        if (chq.amount > po.balance + 0.01)
          return res.status(400).json({ error: `Cheque (${chq.amount.toFixed(2)}) is more than the PO balance (${po.balance.toFixed(2)}). Endorse it to the supplier without a PO instead.` });
        if (!po.paymentStages.length && po.paid > 0)
          po.paymentStages.push({ date: po.date, amount: po.paid, paymentMode: po.paymentMode || 'cash', description: 'Paid when PO was created' });
        const st = po.paymentStages.create({ date, amount: chq.amount, paymentMode: 'endorsed', cheque: chq._id, reference: chq.chequeNo,
          description: `Third-party cheque #${chq.chequeNo}${chq.drawer ? ' (' + chq.drawer + ')' : ''} from ${chq.party}` });
        po.paymentStages.push(st);
        await po.save();
        end.purchase = po._id; end.purchaseNo = po.purchaseNo; end.stageId = st._id;
      }
      await Supplier.findByIdAndUpdate(sup._id, { $inc: { balance: -chq.amount } });
    } else if (toType === 'expense') {
      if (!expenseAccount) return res.status(400).json({ error: 'Select the expense account' });
      const la = await LedgerAccount.findOne({ name: expenseAccount });
      drAccount = expenseAccount; drType = la ? la.type : 'expense';
      end.expenseAccount = expenseAccount; end.payee = req.body.payee || '';
    } else return res.status(400).json({ error: 'toType must be supplier or expense' });

    const base = { date, description: `Cheque #${chq.chequeNo} endorsed to ${end.payee || drAccount}`, reference: chq.chequeNo,
      sourceType: 'cheque', sourceId: chq._id, narration: 'endorse' };
    await Ledger.insertMany([
      { ...base, account: drAccount, accountType: drType, debit: chq.amount, credit: 0 },
      { ...base, account: RECV, accountType: 'cheque', debit: 0, credit: chq.amount },
    ]);
    chq.endorsement = end;
    chq.status = 'endorsed';
    log(chq, 'endorsed', `To ${end.payee || drAccount}${end.purchaseNo ? ' for ' + end.purchaseNo : ''}`);
    await chq.save();
    res.json(chq);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// POST reverse an endorsement
//   mode 'undo'    — entered by mistake / payee handed it back unused: back in hand, as if never endorsed
//   mode 'bounced' — dishonoured in the payee's hands: we owe the payee again, the customer owes us again
router.post('/:id/endorsement/reverse', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const chq = await Cheque.findById(req.params.id);
    if (!chq) return res.status(404).json({ error: 'Not found' });
    if (chq.status !== 'endorsed') return res.status(400).json({ error: 'This cheque is not endorsed' });
    const { mode, note } = req.body;
    const end = chq.endorsement || {};

    if (end.purchase) await dropPurchaseStage(end.purchase, chq._id);

    if (mode === 'undo') {
      await Ledger.deleteMany({ sourceType: 'cheque', sourceId: chq._id, narration: 'endorse' });
      if (end.supplier) await Supplier.findByIdAndUpdate(end.supplier, { $inc: { balance: chq.amount } });
      chq.endorsement = undefined;
      chq.status = 'pending';
      log(chq, 'endorsement undone', note);
    } else if (mode === 'bounced') {
      const contra = await contraOf(chq);
      const date = req.body.date ? new Date(req.body.date) : new Date();
      const base = { date, description: `Endorsed cheque #${chq.chequeNo} dishonoured (${end.payee || ''})`, reference: chq.chequeNo,
        sourceType: 'cheque', sourceId: chq._id, narration: 'endorse-bounce' };
      // Customer owes us again; payee is owed again (supplier via AP; expense payee also via AP)
      await Ledger.insertMany([
        { ...base, account: contra.account, accountType: contra.accountType, debit: chq.amount, credit: 0 },
        { ...base, account: 'Accounts Payable', accountType: 'payable', debit: 0, credit: chq.amount },
      ]);
      if (end.supplier) await Supplier.findByIdAndUpdate(end.supplier, { $inc: { balance: chq.amount } });
      if (['receivable', 'payable'].includes(contra.accountType)) { await adjustParty(chq, chq.amount); await adjustInvoice(chq, -chq.amount); }
      chq.status = 'bounced';
      log(chq, 'endorsed cheque bounced', note);
    } else return res.status(400).json({ error: "mode must be 'undo' or 'bounced'" });

    await chq.save();
    res.json(chq);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT edit descriptive details only; money fields change through status actions
router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const chq = await Cheque.findById(req.params.id);
    if (!chq) return res.status(404).json({ error: 'Not found' });
    if (req.body.amount != null && Math.abs(Number(req.body.amount) - chq.amount) > 0.001)
      return res.status(400).json({ error: 'The amount can\'t be edited. Cancel this cheque and enter it again.' });
    if (req.body.direction && req.body.direction !== chq.direction)
      return res.status(400).json({ error: 'Direction can\'t be changed. Cancel this cheque and enter it again.' });
    for (const k of ['chequeNo', 'date', 'dueDate', 'party', 'drawer', 'bank', 'branch', 'reference', 'notes'])
      if (req.body[k] !== undefined) chq[k] = req.body[k];
    await chq.save();
    res.json(chq);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE only a pending cheque entered directly on the Cheques page (anything else: cancel it instead)
router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const chq = await Cheque.findById(req.params.id);
    if (!chq) return res.status(404).json({ error: 'Not found' });
    if (chq.status !== 'pending')
      return res.status(400).json({ error: `This cheque is ${chq.status}; it can't be deleted. Its history stays in the books.` });
    if (chq.postedBy)
      return res.status(400).json({ error: `This cheque was recorded as a payment on ${chq.reference || 'an ' + chq.postedBy}. Use Cancel instead.` });
    const contra = await contraOf(chq);
    if (['receivable', 'payable'].includes(contra.accountType)) { await adjustParty(chq, chq.amount); await adjustInvoice(chq, -chq.amount); }
    await Ledger.deleteMany({ sourceType: 'cheque', sourceId: chq._id });
    await Cheque.findByIdAndDelete(chq._id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
