const router = require('express').Router();
const Ledger       = require('../models/Ledger');
const CashAccount  = require('../models/CashAccount');
const BankAccount  = require('../models/BankAccount');
const Invoice      = require('../models/Invoice');
const Purchase     = require('../models/Purchase');
const Expense      = require('../models/Expense');
const Cheque       = require('../models/Cheque');
const CashTransfer = require('../models/CashTransfer');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET daily ledger
router.get('/daily', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let mf = {};
    if (from || to) { mf.date = {}; if (from) mf.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); mf.date.$lte = d; } }
    const entries = await Ledger.find(mf).sort({ date: 1, createdAt: 1 });
    const grouped = {};
    for (const e of entries) {
      const dk = new Date(e.date).toISOString().slice(0,10);
      if (!grouped[dk]) grouped[dk] = { date: dk, entries: [], totalDebit: 0, totalCredit: 0 };
      grouped[dk].entries.push(e);
      grouped[dk].totalDebit  += e.debit;
      grouped[dk].totalCredit += e.credit;
    }
    res.json(Object.values(grouped));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET trial balance
router.get('/trial-balance', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { from, to } = req.query;
    let mf = {};
    if (from || to) { mf.date = {}; if (from) mf.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); mf.date.$lte = d; } }
    const tb = await Ledger.aggregate([
      { $match: mf },
      { $group: { _id: { account: '$account', accountType: '$accountType' }, totalDebit: { $sum: '$debit' }, totalCredit: { $sum: '$credit' } } },
      { $project: { account: '$_id.account', accountType: '$_id.accountType', totalDebit: 1, totalCredit: 1, balance: { $subtract: ['$totalDebit','$totalCredit'] } } },
      { $sort: { accountType: 1, account: 1 } }
    ]);
    const grandDebit  = tb.reduce((s,r) => s + r.totalDebit, 0);
    const grandCredit = tb.reduce((s,r) => s + r.totalCredit, 0);
    res.json({ rows: tb, grandDebit, grandCredit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET account ledger
router.get('/account', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { account, from, to } = req.query;
    if (!account) return res.status(400).json({ error: 'account required' });
    let q = { account };
    if (from || to) { q.date = {}; if (from) q.date.$gte = new Date(from); if (to) { const d = new Date(to); d.setHours(23,59,59); q.date.$lte = d; } }
    const entries = await Ledger.find(q).sort({ date: 1, createdAt: 1 });
    let running = 0;
    const rows = entries.map(e => { running += e.debit - e.credit; return { ...e.toObject(), runningBalance: running }; });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET accounts list
router.get('/accounts-list', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const accounts = await Ledger.aggregate([
      { $group: { _id: { account: '$account', accountType: '$accountType' } } },
      { $project: { account: '$_id.account', accountType: '$_id.accountType', _id: 0 } },
      { $sort: { accountType: 1, account: 1 } }
    ]);
    res.json(accounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST manual journal entry
router.post('/', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const entry = new Ledger({ ...req.body, sourceType: 'manual' });
    await entry.save();
    res.status(201).json(entry);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── DAILY CASH BALANCE REPORT ────────────────────────────────────────────────
router.get('/daily-cash-report', requireAuth, requireRole('admin','manager'), async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const // Use UTC dates to avoid timezone shifts between client and server
    dayStart = new Date(date + 'T00:00:00.000Z');
    const dayEnd = new Date(date + 'T23:59:59.999Z');
    const df = { $gte: dayStart, $lte: dayEnd };

    const cashAccounts = await CashAccount.find({ active: true });

    // ── Compute TRUE opening balance for each account ────────────────────────
    // Opening = currentBalance - net of today's transactions on each account
    // Today's credits to each account (invoices paid cash into it)
    const todayCashCredits = {};
    const todayCashDebits  = {};

    // Invoice payments received into cash accounts today
    const invPaid = await Invoice.find({ date: df, paymentMode: 'cash', paid: { $gt: 0 }, cashAccount: { $exists: true, $ne: null } }).select('cashAccount cashAccountName paid');
    for (const inv of invPaid) {
      const id = inv.cashAccount?.toString();
      if (id) todayCashCredits[id] = (todayCashCredits[id] || 0) + inv.paid;
    }

    // Expenses debited from cash accounts today
    const todayExps = await Expense.find({ date: df, paymentMethod: 'cash', cashAccount: { $exists: true, $ne: null } }).select('cashAccount amount');
    for (const exp of todayExps) {
      const id = exp.cashAccount?.toString();
      if (id) todayCashDebits[id] = (todayCashDebits[id] || 0) + exp.amount;
    }

    // Cash transfers today
    const transfersToday = await CashTransfer.find({ date: df });
    for (const t of transfersToday) {
      if (t.fromType === 'cash') {
        const id = t.fromAccount?.toString();
        if (id) todayCashDebits[id] = (todayCashDebits[id] || 0) + t.amount;
      }
      if (t.toType === 'cash') {
        const id = t.toAccount?.toString();
        if (id) todayCashCredits[id] = (todayCashCredits[id] || 0) + t.amount;
      }
    }

    // Opening balance = currentBalance - today's CASH movements
    // Only deduct invoice receipts and expense payments (NOT journal entries)
    // Journal entries are shown separately as expense rows, so don't double-count them
    let totalOpeningBalance = 0;
    const accountOpenings = [];
    for (const acc of cashAccounts) {
      const id = acc._id.toString();
      // todayNet = cash actually received (invoices) - cash actually paid (expense model only)
      const todayNet = (todayCashCredits[id]||0) - (todayCashDebits[id]||0);
      const openingBalance = acc.currentBalance - todayNet;
      totalOpeningBalance += openingBalance;
      accountOpenings.push({ ...acc.toObject(), openingBalance });
    }

    // ── Build report rows ─────────────────────────────────────────────────────
    const rows = [];
    let totalDebit = 0, totalCredit = 0;

    // Opening balance (Credit)
    rows.push({ type: 'opening', label: 'Opening Cash Balance', credit: totalOpeningBalance, debit: null });
    totalCredit += totalOpeningBalance;

    // Sales: TOTAL sales → Credit (all money earned)
    //         Credit sales portion (unpaid) → Debit (A/R — not yet in hand)
    // Net effect: only cash actually received remains in Credit balance
    const todayInvoices = await Invoice.find({ date: df, status: { $ne: 'draft' } })
      .populate('customer','name').select('invoiceNo customerName total paid balance status invoiceTypeName');
    
    const totalSales = todayInvoices.reduce((s,i)=>s+i.total,0);
    const totalPaid  = todayInvoices.reduce((s,i)=>s+i.paid,0);
    const totalCredit_sales = todayInvoices.reduce((s,i)=>s+(i.balance||0),0);

    if (totalSales > 0) {
      rows.push({
        type: 'sales', label: `Total Sales (${todayInvoices.length} invoices)`,
        credit: totalSales, debit: null,
        items: todayInvoices.map(i=>({ ref:i.invoiceNo, name:i.customerName||'Walk-in', amount:i.total, paid:i.paid, balance:i.balance||0, status:i.status }))
      });
      totalCredit += totalSales;
    }
    if (totalCredit_sales > 0) {
      const creditInvoices = todayInvoices.filter(i=>(i.balance||0)>0);
      rows.push({
        type: 'receivable', label: `Credit Sales — Not Yet Received (${creditInvoices.length})`,
        debit: totalCredit_sales, credit: null,
        items: creditInvoices.map(i=>({ ref:i.invoiceNo, name:i.customerName||'Walk-in', amount:i.total, paid:i.paid, balance:i.balance||0, status:i.status }))
      });
      totalDebit += totalCredit_sales;
    }

    // Bank inwards (Credit)
    const bankInwards = await Invoice.aggregate([
      { $match: { date: df, paymentMode: 'bank', paid: { $gt: 0 } } },
      { $group: { _id: '$bankAccount', name: { $first: '$bankAccountName' }, total: { $sum: '$paid' } } }
    ]);
    for (const bi of bankInwards) {
      if (bi.total > 0) {
        rows.push({ type: 'bank_inward', label: `Bank Inwards — ${bi.name || 'Bank'}`, credit: bi.total, debit: null });
        totalCredit += bi.total;
      }
    }

    // Cash transfers IN today (Credit)
    for (const t of transfersToday) {
      if (t.toType === 'cash') {
        rows.push({ type: 'transfer_in', label: `Transfer In — ${t.fromAccountName} → ${t.toAccountName}`, credit: t.amount, debit: null });
        totalCredit += t.amount;
      }
    }

    // Expenses — group by ledger account with full details
    const todayExpFull = await Expense.find({ date: df }).sort({ amount: -1 });
    const expByAccount = {};
    for (const exp of todayExpFull) {
      const accName = exp.ledgerAccountName || exp.category || 'General Expenses';
      if (!expByAccount[accName]) expByAccount[accName] = { total: 0, items: [] };
      expByAccount[accName].total += exp.amount;
      expByAccount[accName].items.push({
        ref: exp.reference || '—',
        description: exp.description,
        amount: exp.amount,
        vendor: exp.vendor || '',
        paymentMethod: exp.paymentMethod
      });
    }
    for (const [accName, data] of Object.entries(expByAccount)) {
      rows.push({ type:'expense', label:accName, debit:data.total, credit:null, count:data.items.length, items:data.items });
      totalDebit += data.total;
    }

    // Purchase payments with details
    const purchasesFull = await Purchase.find({ date: df, paid: { $gt: 0 } }).select('poNumber supplierName paid');
    if (purchasesFull.length > 0) {
      const purTotal = purchasesFull.reduce((s,p)=>s+p.paid,0);
      rows.push({
        type:'purchase', label:`Purchase Payments (${purchasesFull.length})`,
        debit:purTotal, credit:null,
        items: purchasesFull.map(p=>({ ref:p.poNumber||'—', name:p.supplierName||'Supplier', amount:p.paid }))
      });
      totalDebit += purTotal;
    }

    // (purchase payments now included in expense block above)

    // Journal entries posted directly (via +Entry in Chart of Accounts or +Journal Entry in Daily Report)
    // Query both 'journal' and 'manual' sourceTypes, exclude Cash/Bank side entries
    const journalEntries = await Ledger.find({
      sourceType: { $in: ['journal', 'manual'] },
      date: df,
      account: { $not: /^(Cash -|Bank -)/ }  // exclude the cash/bank side entries
    }).sort({ createdAt: 1 });

    // Group by account name
    const journalByAccount = {};
    for (const je of journalEntries) {
      if (je.debit > 0) {
        if (!journalByAccount[je.account]) journalByAccount[je.account] = { total:0, items:[], type:je.accountType };
        journalByAccount[je.account].total += je.debit;
        journalByAccount[je.account].items.push({
          ref: je.reference||'—', description: je.description, amount: je.debit, name: je.description
        });
      }
      if (je.credit > 0 && ['income','revenue'].includes(je.accountType)) {
        rows.push({ type:'income', label:je.account+' (Journal)', credit:je.credit, debit:null,
          items:[{ ref:je.reference||'—', name:je.description, amount:je.credit }] });
        totalCredit += je.credit;
      }
    }
    for (const [accName, data] of Object.entries(journalByAccount)) {
      // Merge with existing expense row if same account, or add new row
      const existingIdx = rows.findIndex(r=>
        (r.type==='expense') && (r.label===accName || r.label===accName+' (Journal)')
      );
      if (existingIdx >= 0) {
        rows[existingIdx].debit = (rows[existingIdx].debit||0) + data.total;
        rows[existingIdx].items = [...(rows[existingIdx].items||[]), ...data.items];
        rows[existingIdx].count = (rows[existingIdx].items||[]).length;
        totalDebit += data.total;  // MUST update totalDebit even when merging
      } else {
        rows.push({ type:'expense', label:accName, debit:data.total, credit:null, count:data.items.length, items:data.items });
        totalDebit += data.total;
      }
    }

    // Cash transfers OUT today (Debit)
    for (const t of transfersToday) {
      if (t.fromType === 'cash') {
        rows.push({ type: 'transfer_out', label: `Transfer Out — ${t.fromAccountName} → ${t.toAccountName}`, debit: t.amount, credit: null });
        totalDebit += t.amount;
      }
    }

    const undepositedCheques = await Cheque.find({ direction: 'received', status: { $in: ['pending'] } });
    const undepositedTotal = undepositedCheques.reduce((s,c) => s + c.amount, 0);
    const bankAccounts = await BankAccount.find({ active: true }).select('name currentBalance');

    // Cash in Hand = sum of actual account balances (ground truth from DB)
    const cashInHand = cashAccounts.reduce((s,a) => s + a.currentBalance, 0);

    res.json({
      date,
      rows,
      totalDebit,
      totalCredit,
      cashInHand,
      cashInHandWithCheques: cashInHand + undepositedTotal,
      undepositedCheques: { count: undepositedCheques.length, total: undepositedTotal, items: undepositedCheques },
      cashAccounts: cashAccounts.map(a => ({ name: a.name, balance: a.currentBalance })),
      bankAccounts: bankAccounts.map(a => ({ name: a.name, balance: a.currentBalance }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// POST a direct journal entry pair (debit + credit) to Ledger collection
// Used for cash/bank side of journal entries where no LedgerAccount doc exists
router.post('/journal-entry', requireAuth, async (req, res) => {
  try {
    const { date, account, accountType, debit, credit, description, reference, sourceType } = req.body;
    if (!description) return res.status(400).json({ error: 'Description required' });
    if (!debit && !credit) return res.status(400).json({ error: 'Debit or credit required' });
    const entry = new Ledger({
      date: date || new Date(),
      account: account || 'General',
      accountType: accountType || 'asset',
      debit:  Number(debit)  || 0,
      credit: Number(credit) || 0,
      description,
      reference: reference || '',
      sourceType: sourceType || 'journal',
    });
    await entry.save();
    res.status(201).json(entry);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
