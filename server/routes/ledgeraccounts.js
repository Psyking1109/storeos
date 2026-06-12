const router        = require('express').Router();
const LedgerAccount = require('../models/LedgerAccount');
const Ledger        = require('../models/Ledger');
const mongoose      = require('mongoose');

// Seed default system accounts — called after mongoose connects
async function seedLedgerAccounts() {
  try {
    if (await LedgerAccount.countDocuments() === 0) {
      await LedgerAccount.insertMany([
        { name:'Sales Revenue', code:'INC-001', type:'income', isSystem:true, description:'Revenue from sales' },
        { name:'Sales Returns', code:'INC-002', type:'income', isSystem:true, description:'Returned goods credit' },
        { name:'Purchases',     code:'EXP-001', type:'expense', isSystem:true, description:'Cost of goods purchased' },
        { name:'Landing Costs', code:'EXP-002', type:'expense', isSystem:true, description:'Import landing costs' },
        { name:'Accounts Receivable', code:'AST-001', type:'asset', isSystem:true, description:'Money owed by customers' },
        { name:'Accounts Payable',    code:'LIB-001', type:'liability', isSystem:true, description:'Money owed to suppliers' },
        { name:'Input Tax',     code:'AST-002', type:'asset', isSystem:true, description:'VAT on purchases' },
        { name:'Output Tax',    code:'LIB-002', type:'liability', isSystem:true, description:'VAT on sales' },
      ]);
      console.log('✅ Default chart of accounts seeded');
    }
  } catch(e) { console.log('Ledger seed skipped:', e.message); }
}
// Delay seed until mongoose is ready
setTimeout(seedLedgerAccounts, 3000);

router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.type) q.type = req.query.type;
    if (req.query.active !== 'all') q.active = true;
    res.json(await LedgerAccount.find(q).sort({ type:1, name:1 }));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/reports/trial-balance', async (req, res) => {
  try {
    const accounts = await LedgerAccount.find({ active: true }).sort({ type:1, name:1 });
    const result = [];
    let totalDr = 0, totalCr = 0;
    for (const acc of accounts) {
      const entries = await Ledger.find({ account: acc.name });
      const debit  = entries.reduce((s,e) => s + (e.debit||0), 0);
      const credit = entries.reduce((s,e) => s + (e.credit||0), 0);
      const isDebitNormal = ['asset','expense'].includes(acc.type);
      const balance = isDebitNormal
        ? (acc.openingBalance||0) + debit - credit
        : (acc.openingBalance||0) + credit - debit;
      if (balance !== 0 || debit || credit) {
        const balanceDr = (balance > 0 && isDebitNormal) ? balance : 0;
        const balanceCr = (balance > 0 && !isDebitNormal) ? balance : 0;
        result.push({ account: acc.name, code: acc.code, type: acc.type,
                      debit, credit, balance, balanceDr, balanceCr });
        totalDr += balanceDr;
        totalCr += balanceCr;
      }
    }
    res.json({ accounts: result, totalDr, totalCr, balanced: Math.abs(totalDr - totalCr) < 0.01 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const account = await LedgerAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    const { from, to } = req.query;
    const q = { account: account.name };
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to)   { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; }
    }
    const entries = await Ledger.find(q).sort({ date:1, createdAt:1 });
    let balance = account.openingBalance || 0;
    const isDebitNormal = ['asset','expense'].includes(account.type);
    const rows = entries.map(e => {
      balance += isDebitNormal ? ((e.debit||0) - (e.credit||0)) : ((e.credit||0) - (e.debit||0));
      return { ...e.toObject(), runningBalance: balance };
    });
    res.json({ account, entries: rows,
               totalDebit:  entries.reduce((s,e)=>s+(e.debit||0),0),
               totalCredit: entries.reduce((s,e)=>s+(e.credit||0),0),
               openingBalance: account.openingBalance || 0,
               closingBalance: balance });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try { const acc = new LedgerAccount(req.body); await acc.save(); res.status(201).json(acc); }
  catch(e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const acc = await LedgerAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    if (acc.isSystem) delete req.body.name; // protect system account names
    Object.assign(acc, req.body);
    await acc.save();
    res.json(acc);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID' });
    const acc = await LedgerAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    if (acc.isSystem) return res.status(400).json({ error: 'Cannot delete system account' });
    await LedgerAccount.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE a ledger entry
router.delete('/entries/:entryId', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(req.params.entryId))
      return res.status(400).json({ error: 'Invalid ID' });
    const entry = await Ledger.findById(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.sourceType !== 'journal' && entry.sourceType !== 'manual')
      return res.status(400).json({ error: 'Only manual journal entries can be deleted' });
    await Ledger.findByIdAndDelete(req.params.entryId);
    res.json({ message: 'Deleted' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT update a ledger entry (manual only)
router.put('/entries/:entryId', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(req.params.entryId))
      return res.status(400).json({ error: 'Invalid ID' });
    const entry = await Ledger.findById(req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    if (entry.sourceType !== 'journal' && entry.sourceType !== 'manual')
      return res.status(400).json({ error: 'Only manual journal entries can be edited' });
    const { description, reference, debit, credit, date } = req.body;
    if (description !== undefined) entry.description = description;
    if (reference !== undefined)   entry.reference   = reference;
    if (debit     !== undefined)   entry.debit       = Number(debit)||0;
    if (credit    !== undefined)   entry.credit      = Number(credit)||0;
    if (date      !== undefined)   entry.date        = new Date(date);
    await entry.save();
    res.json(entry);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// POST manual journal entry directly to an account
router.post('/:id/entries', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ error: 'Invalid ID' });
    const acc = await LedgerAccount.findById(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const { date, debit, credit, description, reference } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required' });
    if (!debit && !credit) return res.status(400).json({ error: 'Debit or credit amount required' });

    // Use account/accountType from body if provided (for cross-account entries)
    // otherwise default to this account's name/type
    const entryAccount     = req.body.account     || acc.name;
    const entryAccountType = req.body.accountType || acc.type;
    const entrySourceType  = req.body.sourceType  || 'manual';

    const entry = new Ledger({
      date: date || new Date(),
      account:     entryAccount,
      accountType: entryAccountType,
      debit:  Number(debit)  || 0,
      credit: Number(credit) || 0,
      description,
      reference: reference || '',
      sourceType: entrySourceType,
    });
    await entry.save();
    res.status(201).json(entry);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
