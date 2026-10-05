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

    // Everything below follows PHYSICAL CASH only:
    //   Credit (In)  = opening cash, today's sales, cash collected on earlier invoices, transfers in
    //   Debit  (Out) = the part of today's sales that did NOT arrive as cash (credit sales, paid into
    //                  the bank, paid by cheque), cash expenses, cash supplier payments, transfers out
    // Credit − Debit = cash in hand at the end of the day.
    const cashNames = cashAccounts.map(a => a.name);

    // Opening = today's balance minus every cash movement from this day onward (works for past dates)
    const fromDay = await Ledger.aggregate([
      { $match: { accountType: 'cash', account: { $in: cashNames }, date: { $gte: dayStart } } },
      { $group: { _id: { account: '$account', later: { $gt: ['$date', dayEnd] } }, net: { $sum: { $subtract: ['$debit', '$credit'] } } } },
    ]);
    const netOf = (name, later) => fromDay.filter(r => r._id.account === name && r._id.later === later).reduce((s, r) => s + r.net, 0);
    let totalOpeningBalance = 0, totalClosing = 0;
    const accountOpenings = [];
    for (const acc of cashAccounts) {
      const closing = acc.currentBalance - netOf(acc.name, true);
      const openingBalance = closing - netOf(acc.name, false);
      totalOpeningBalance += openingBalance; totalClosing += closing;
      accountOpenings.push({ ...acc.toObject(), openingBalance, closingBalance: closing });
    }

    const rows = [];
    let totalDebit = 0, totalCredit = 0;
    const credit = (r) => { rows.push({ ...r, debit: null }); totalCredit += r.credit; };
    const debit  = (r) => { rows.push({ ...r, credit: null }); totalDebit += r.debit; };

    credit({ type: 'opening', label: 'Opening Cash Balance', credit: totalOpeningBalance });

    // Today's sales (invoices only — proformas and credit notes are not sales)
    const todayInvoices = await Invoice.find({ date: df, type: 'invoice' })
      .select('invoiceNo customerName total paid balance status invoiceTypeName');
    const todayIds = todayInvoices.map(i => i._id);
    const invItem = i => ({ ref: i.invoiceNo, name: i.customerName || 'Walk-in', amount: i.total, paid: i.paid, balance: i.balance || 0, status: i.status });
    const totalSales = todayInvoices.reduce((s, i) => s + i.total, 0);
    if (totalSales > 0)
      credit({ type: 'sales', label: `Total Sales (${todayInvoices.length} invoices)`, credit: totalSales, items: todayInvoices.map(invItem) });

    const creditInvoices = todayInvoices.filter(i => (i.balance || 0) > 0.009);
    const creditSales = creditInvoices.reduce((s, i) => s + i.balance, 0);
    if (creditSales > 0)
      debit({ type: 'receivable', label: `Credit Sales — Not Yet Received (${creditInvoices.length})`, debit: creditSales, items: creditInvoices.map(invItem) });

    // Receipts posted today on invoices, by where the money went
    const receipts = await Ledger.find({ sourceType: 'invoice', date: df, debit: { $gt: 0 }, accountType: { $in: ['bank', 'cheque', 'cash'] } }).lean();
    const invNo = Object.fromEntries(todayInvoices.map(i => [String(i._id), i]));
    const isToday = r => !!invNo[String(r.sourceId)];
    const recItem = r => ({ ref: r.reference || '—', name: invNo[String(r.sourceId)]?.customerName || r.description, amount: r.debit });

    // Today's sales paid into the bank: in the books, not in the till
    const bankByAcc = {};
    for (const r of receipts.filter(r => r.accountType === 'bank' && isToday(r)))
      (bankByAcc[r.account] = bankByAcc[r.account] || []).push(r);
    for (const [name, list] of Object.entries(bankByAcc))
      debit({ type: 'bank_inward', label: `Bank Inwards — ${name} (not cash)`, debit: list.reduce((s, r) => s + r.debit, 0), items: list.map(recItem) });

    // Today's sales paid by cheque: in hand as a cheque, not cash (shown again below as undeposited)
    const chqRec = receipts.filter(r => r.accountType === 'cheque' && isToday(r));
    if (chqRec.length)
      debit({ type: 'cheque_inward', label: `Paid by Cheque (${chqRec.length})`, debit: chqRec.reduce((s, r) => s + r.debit, 0), items: chqRec.map(recItem) });

    // Cash collected today against earlier invoices
    const collected = receipts.filter(r => r.accountType === 'cash' && !isToday(r));
    if (collected.length)
      credit({ type: 'collection', label: `Cash Collected on Earlier Invoices (${collected.length})`, credit: collected.reduce((s, r) => s + r.debit, 0), items: collected.map(r => ({ ref: r.reference || '—', name: r.description, amount: r.debit })) });

    // Cash transfers IN today
    for (const t of transfersToday) {
      if (t.toType === 'cash')
        credit({ type: 'transfer_in', label: `Transfer In — ${t.fromAccountName} → ${t.toAccountName}`, credit: t.amount });
    }

    // Expenses paid in cash — grouped by expense account (bank/cheque expenses never touched the till)
    const todayExpFull = await Expense.find({ date: df, paymentMethod: 'cash' }).sort({ amount: -1 });
    const expByAccount = {};
    for (const exp of todayExpFull) {
      const accName = exp.ledgerAccountName || exp.category || 'General Expenses';
      if (!expByAccount[accName]) expByAccount[accName] = { total: 0, items: [] };
      expByAccount[accName].total += exp.amount;
      expByAccount[accName].items.push({ ref: exp.reference || '—', description: exp.description, amount: exp.amount, vendor: exp.vendor || '', paymentMethod: exp.paymentMethod });
    }
    for (const [accName, data] of Object.entries(expByAccount))
      debit({ type: 'expense', label: accName, debit: data.total, count: data.items.length, items: data.items });

    // Supplier payments made in cash today (by payment date, not PO date)
    const purCash = await Ledger.find({ sourceType: 'purchase', date: df, accountType: 'cash', credit: { $gt: 0 } }).lean();
    if (purCash.length)
      debit({ type: 'purchase', label: `Purchase Payments in Cash (${purCash.length})`, debit: purCash.reduce((s, r) => s + r.credit, 0),
        items: purCash.map(r => ({ ref: r.reference || '—', name: r.description, amount: r.credit })) });

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

    // Cash in hand at the end of the chosen day, per the cash accounts
    const cashInHand = totalClosing;

    res.json({
      date,
      rows,
      totalDebit,
      totalCredit,
      cashInHand,
      cashInHandWithCheques: cashInHand + undepositedTotal,
      undepositedCheques: { count: undepositedCheques.length, total: undepositedTotal, items: undepositedCheques },
      cashAccounts: accountOpenings.map(a => ({ name: a.name, opening: a.openingBalance, balance: a.closingBalance })),
      reportDifference: (totalCredit - totalDebit) - totalClosing,
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
