'use strict';
const router   = require('express').Router();
const mongoose = require('mongoose');

const BankStatementLine = require('../models/BankStatementLine');
const BankAccount       = require('../models/BankAccount');
const Invoice           = require('../models/Invoice');
const Expense           = require('../models/Expense');
const Cheque            = require('../models/Cheque');
const BankTx            = require('../models/BankTx');
const Ledger            = require('../models/Ledger');
const LedgerAccount     = require('../models/LedgerAccount');

// ── CSV PARSER (quote-aware, no external deps) ─────────────────────────────

function parseCSVRow(line) {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      cols.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  cols.push(cur);
  return cols.map(s => s.trim());
}

function parseAmt(s) {
  if (!s || !s.trim()) return 0;
  return parseFloat(s.replace(/,/g, '')) || 0;
}

function parseDDMMYYYY(s) {
  const m = (s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
}

function normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ComBank narration: "note / txn-id / counterparty"
function parseNarration(desc) {
  const parts = desc.split('/').map(p => p.trim());
  const note        = parts[0] || '';
  const counterparty = parts.length >= 3 ? parts[parts.length - 1] : '';
  const refMatch    = note.match(/invoice\s*(\d+)/i);
  const reference   = refMatch ? refMatch[1] : '';
  return { note, counterparty, reference };
}

const DEFAULT_COL_MAP = {
  bank: 'Commercial Bank of Ceylon',
  dateCol: 1, descCol: 3, debitCol: 6, creditCol: 7, balanceCol: 8,
  dateFormat: 'DD/MM/YYYY', amountMode: 'debit_credit', rowFilter: 'dateInCol1'
};

// ── IMPORT ─────────────────────────────────────────────────────────────────

router.post('/import', async (req, res) => {
  try {
    const { bankAccountId, csvText, columnMap, previewOnly } = req.body;
    if (!bankAccountId || !csvText) return res.status(400).json({ error: 'bankAccountId and csvText required' });

    const acc = await BankAccount.findById(bankAccountId).lean();
    if (!acc) return res.status(404).json({ error: 'Bank account not found' });

    const cm   = { ...DEFAULT_COL_MAP, ...(columnMap || {}) };
    const rows = csvText.split(/\r?\n/);
    const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

    const toImport   = [];
    const previewRows = [];

    for (const rawLine of rows) {
      if (!rawLine.trim()) continue;
      const cols    = parseCSVRow(rawLine);
      const dateStr = (cols[cm.dateCol] || '').trim();
      if (!DATE_RE.test(dateStr)) continue; // skip header/footer

      const date   = parseDDMMYYYY(dateStr);
      if (!date) continue;

      const desc   = (cols[cm.descCol]   || '').trim();
      const debit  = parseAmt(cols[cm.debitCol]  || '');
      const credit = parseAmt(cols[cm.creditCol] || '');
      const balance = cm.balanceCol != null ? parseAmt(cols[cm.balanceCol] || '') : undefined;

      const signedAmt = credit - debit;              // + = money in, - = money out
      const absAmt    = Math.abs(signedAmt);
      const direction = signedAmt >= 0 ? 'credit' : 'debit';
      const amount    = direction === 'credit' ? absAmt : -absAmt;

      const { note, counterparty, reference } = parseNarration(desc);
      const dedupeKey = BankStatementLine.makeDedupeKey(bankAccountId, date, absAmt, desc);

      const row = { bankAccount: bankAccountId, bankAccountName: acc.name, date, description: desc,
        note, counterparty, reference, amount, direction, importBatch: '__PENDING__',
        rawRow: rawLine, dedupeKey };
      if (balance !== undefined) row.balance = balance;
      toImport.push(row);

      if (previewRows.length < 5) previewRows.push({ date: dateStr, note, counterparty, amount, direction, balance });
    }

    if (previewOnly) return res.json({ preview: previewRows, total: toImport.length });

    // Dedupe
    const existKeys = new Set(
      (await BankStatementLine.find({ dedupeKey: { $in: toImport.map(r => r.dedupeKey) } })
        .select('dedupeKey').lean()).map(r => r.dedupeKey)
    );
    const newRows = toImport.filter(r => !existKeys.has(r.dedupeKey));
    const skipped = toImport.length - newRows.length;

    let batch = '';
    if (newRows.length) {
      // Use crypto.randomUUID (Node 14.17+) or fallback
      batch = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
      // require crypto at module level for randomUUID
      const cryp = require('crypto');
      batch = cryp.randomUUID ? cryp.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      newRows.forEach(r => { r.importBatch = batch; });
      await BankStatementLine.insertMany(newRows);
    }

    res.json({ imported: newRows.length, skipped, batch, preview: previewRows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LIST LINES ─────────────────────────────────────────────────────────────

router.get('/lines', async (req, res) => {
  try {
    const { account, status, from, to, batch } = req.query;
    const q = {};
    if (account) q.bankAccount = account;
    if (status)  q.status = status;
    if (batch)   q.importBatch = batch;
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to)   { const d = new Date(to); d.setHours(23, 59, 59); q.date.$lte = d; }
    }
    const lines = await BankStatementLine.find(q).sort({ date: -1, createdAt: -1 }).limit(500).lean();
    res.json(lines);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ACCOUNT SUMMARY ────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
  try {
    const { account } = req.query;
    if (!account) return res.status(400).json({ error: 'account required' });
    const acc = await BankAccount.findById(account).lean();
    if (!acc) return res.status(404).json({ error: 'Account not found' });

    const lastLine = await BankStatementLine.findOne({ bankAccount: account })
      .sort({ date: -1, createdAt: -1 }).select('balance').lean();
    const statementBalance = lastLine?.balance ?? null;

    const agg = await BankStatementLine.aggregate([
      { $match: { bankAccount: new mongoose.Types.ObjectId(account) } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    const statusCounts = {};
    agg.forEach(c => { statusCounts[c._id] = c.count; });

    res.json({
      bookBalance: acc.currentBalance,
      statementBalance,
      difference: statementBalance != null ? statementBalance - acc.currentBalance : null,
      statusCounts
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── INVOICE SEARCH (for split modal) ──────────────────────────────────────

router.get('/search-invoices', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const invs = await Invoice.find({
      type: 'invoice',
      status: { $in: ['paid', 'partial'] },
      $or: [{ invoiceNo: re }, { customerName: re }]
    }).select('invoiceNo customerName paid total date status balance').limit(10).lean();
    res.json(invs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── MATCHING ENGINE ────────────────────────────────────────────────────────

function scoreDate(lineDate, candidateDate, windowDays) {
  if (!candidateDate) return 0;
  const diffDays = Math.abs(lineDate - new Date(candidateDate)) / 86400000;
  if (diffDays <= 0.5) return 25;
  if (diffDays > windowDays) return 0;
  return Math.round(25 * (1 - diffDays / windowDays));
}

const NIC_RE  = /^\d{9}[VvXx]$/;
const BREF_RE = /^EF\s/i;

function scoreText(line, candidate) {
  let score = 0;
  const ref     = (line.reference || '').trim();
  const noteN   = normalizeText(line.note || '');
  const cp      = (line.counterparty || '').trim();
  const cpIsJunk = NIC_RE.test(cp) || BREF_RE.test(cp);

  // Invoice number in reference field (very strong)
  if (ref) {
    if (candidate.invoiceNo && ref === String(candidate.invoiceNo).replace(/[^\d]/g, '')) score += 12;
    if (candidate.chequeNo  && ref === String(candidate.chequeNo))                        score += 10;
  }
  // Invoice number in note
  if (candidate.invoiceNo) {
    const invDigits = String(candidate.invoiceNo).replace(/[^\d]/g, '');
    if (invDigits && noteN.includes(invDigits)) score += 8;
  }
  // Counterparty fuzzy match
  if (!cpIsJunk && cp) {
    const cpN = normalizeText(cp);
    for (const t of [candidate.customerName, candidate.vendor, candidate.party, candidate.description]) {
      if (!t) continue;
      const tN = normalizeText(t);
      if (!tN) continue;
      if (cpN.includes(tN) || tN.includes(cpN)) { score += 5; break; }
      const shared = cpN.split(' ').filter(w => w.length > 2 && tN.split(' ').includes(w));
      if (shared.length) { score += 2; break; }
    }
  }
  return Math.min(score, 15);
}

router.get('/:lineId/suggestions', async (req, res) => {
  try {
    const line = await BankStatementLine.findById(req.params.lineId).lean();
    if (!line) return res.status(404).json({ error: 'Line not found' });

    const lineDate = new Date(line.date);
    const absAmt   = Math.abs(line.amount);
    const win      = 15 * 86400000;
    const dateFrom = new Date(lineDate - win);
    const dateTo   = new Date(lineDate.getTime() + win);
    const candidates = [];

    function amtScore(cAmt) { return Math.abs(cAmt - absAmt) <= 0.02 ? 60 : 0; }

    if (line.direction === 'credit') {
      // Paid invoices — first try with bankAccount filter, then without
      const invQ = { type: 'invoice', status: { $in: ['paid','partial'] }, date: { $gte: dateFrom, $lte: dateTo } };
      const allInvs = await Invoice.find(invQ).select('invoiceNo customerName paid date bankAccount').lean();
      const seen = new Set();
      for (const inv of allInvs) {
        if (seen.has(inv._id.toString())) continue;
        const aS = amtScore(inv.paid);
        if (!aS) continue;
        // Prioritise invoices linked to the same bank account
        const bankBonus = inv.bankAccount && inv.bankAccount.toString() === line.bankAccount.toString() ? 5 : 0;
        const s = aS + scoreDate(lineDate, inv.date, 15) + scoreText(line, inv) + bankBonus;
        candidates.push({ kind: 'invoice', refId: inv._id, label: inv.invoiceNo, amount: inv.paid, date: inv.date, score: s, invoiceNo: inv.invoiceNo, customerName: inv.customerName });
        seen.add(inv._id.toString());
      }
      // Received cheques
      const chqs = await Cheque.find({ direction: 'received', status: { $in: ['pending','deposited','cleared'] }, date: { $gte: dateFrom, $lte: dateTo } }).select('chequeNo party amount date').lean();
      for (const c of chqs) {
        const aS = amtScore(c.amount);
        if (!aS) continue;
        candidates.push({ kind: 'cheque', refId: c._id, label: `Cheque #${c.chequeNo}`, amount: c.amount, date: c.date, score: aS + scoreDate(lineDate, c.date, 15) + scoreText(line, c), party: c.party });
      }
      // BankTx deposits
      const deps = await BankTx.find({ account: line.bankAccount, type: 'deposit', date: { $gte: dateFrom, $lte: dateTo } }).select('amount date description').lean();
      for (const d of deps) {
        const aS = amtScore(d.amount);
        if (!aS) continue;
        candidates.push({ kind: 'banktx', refId: d._id, label: d.description, amount: d.amount, date: d.date, score: aS + scoreDate(lineDate, d.date, 15) });
      }
    } else {
      // Expenses (bank payment)
      const exps = await Expense.find({ paymentMethod: 'bank', date: { $gte: dateFrom, $lte: dateTo } }).select('ledgerAccountName description amount date vendor').lean();
      for (const e of exps) {
        const aS = amtScore(e.amount);
        if (!aS) continue;
        candidates.push({ kind: 'expense', refId: e._id, label: e.description || e.ledgerAccountName, amount: e.amount, date: e.date, score: aS + scoreDate(lineDate, e.date, 15) + scoreText(line, e), vendor: e.vendor });
      }
      // Issued cheques
      const chqs = await Cheque.find({ direction: 'issued', date: { $gte: dateFrom, $lte: dateTo } }).select('chequeNo party amount date').lean();
      for (const c of chqs) {
        const aS = amtScore(c.amount);
        if (!aS) continue;
        candidates.push({ kind: 'cheque', refId: c._id, label: `Cheque #${c.chequeNo}`, amount: c.amount, date: c.date, score: aS + scoreDate(lineDate, c.date, 15) + scoreText(line, c), party: c.party });
      }
      // BankTx withdrawals
      const wds = await BankTx.find({ account: line.bankAccount, type: 'withdrawal', date: { $gte: dateFrom, $lte: dateTo } }).select('amount date description').lean();
      for (const d of wds) {
        const aS = amtScore(d.amount);
        if (!aS) continue;
        candidates.push({ kind: 'banktx', refId: d._id, label: d.description, amount: d.amount, date: d.date, score: aS + scoreDate(lineDate, d.date, 15) });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const top5 = candidates.slice(0, 5).map(c => ({
      ...c, band: c.score >= 80 ? 'High' : c.score >= 50 ? 'Medium' : 'Low'
    }));

    // Batched deposit suggestion (only when no high-confidence single match)
    let batchSuggestion = null;
    if (line.direction === 'credit' && !top5.some(c => c.band === 'High')) {
      batchSuggestion = await findBatchedMatch(line.bankAccount, absAmt, dateFrom, dateTo);
    }

    res.json({ suggestions: top5, batchSuggestion });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function findBatchedMatch(bankAccountId, targetAmt, dateFrom, dateTo) {
  const invs = await Invoice.find({
    type: 'invoice', status: { $in: ['paid','partial'] }, date: { $gte: dateFrom, $lte: dateTo }
  }).select('invoiceNo customerName paid').limit(20).lean();

  // 2-way
  for (let i = 0; i < invs.length; i++) {
    for (let j = i + 1; j < invs.length; j++) {
      if (Math.abs(invs[i].paid + invs[j].paid - targetAmt) <= 0.02)
        return { invoices: [invs[i], invs[j]], total: invs[i].paid + invs[j].paid };
    }
  }
  // 3-way (bounded)
  const lim = Math.min(invs.length, 15);
  for (let i = 0; i < lim; i++) {
    for (let j = i + 1; j < lim; j++) {
      for (let k = j + 1; k < lim; k++) {
        const s = invs[i].paid + invs[j].paid + invs[k].paid;
        if (Math.abs(s - targetAmt) <= 0.02)
          return { invoices: [invs[i], invs[j], invs[k]], total: s };
      }
    }
  }
  return null;
}

// ── RECONCILE ──────────────────────────────────────────────────────────────

async function ensureLedgerAccount(name, type) {
  let acc = await LedgerAccount.findOne({ name });
  if (!acc) acc = await LedgerAccount.create({ name, type, description: 'Auto-created by reconciliation', isSystem: false });
  return acc;
}

router.post('/:lineId/reconcile', async (req, res) => {
  try {
    const { matches, note } = req.body;
    if (!matches || !matches.length) return res.status(400).json({ error: 'matches required' });

    const line = await BankStatementLine.findById(req.params.lineId);
    if (!line) return res.status(404).json({ error: 'Line not found' });
    if (line.status === 'reconciled') return res.status(400).json({ error: 'Line already reconciled' });

    const absLineAmt  = Math.abs(line.amount);
    const matchTotal  = matches.reduce((s, m) => s + Math.abs(m.amount), 0);
    if (Math.abs(matchTotal - absLineAmt) > 0.02)
      return res.status(400).json({ error: `Match total (${matchTotal.toFixed(2)}) must equal line amount (${absLineAmt.toFixed(2)})` });

    const acc = await BankAccount.findById(line.bankAccount).lean();
    const bankName    = acc ? acc.name : 'Bank';
    const reconRef    = `RECON-${line._id}`;
    const ledgerEntries = [];
    const savedMatches  = [];

    for (const m of matches) {
      const mAmt = Math.abs(m.amount);

      if (m.refId) {
        // Existing record — just link; clear cheques
        if (m.kind === 'cheque') {
          await Cheque.findByIdAndUpdate(m.refId, { status: 'cleared', clearedDate: line.date });
        }
        savedMatches.push({ kind: m.kind, refId: m.refId, label: m.label || '', amount: mAmt });

      } else if (m.kind === 'reimbursement') {
        // New reimbursable-cost entry (credit line extra: money came IN)
        const lacc = await ensureLedgerAccount('Reimbursable Costs', 'expense');
        const exp = await Expense.create({
          date: line.date, ledgerAccount: lacc._id, ledgerAccountName: lacc.name,
          description: m.label || 'Reimbursement via bank', amount: mAmt,
          paymentMethod: 'bank', bankAccount: line.bankAccount,
          bankAccountName: bankName, vendor: line.counterparty || '',
          reference: reconRef, ledgered: true
        });
        await BankAccount.findByIdAndUpdate(line.bankAccount, { $inc: { currentBalance: mAmt } });
        ledgerEntries.push(
          { date: line.date, account: bankName, accountType: 'bank', debit: mAmt, credit: 0, description: m.label || 'Reimbursement', reference: reconRef, sourceType: 'reconciliation', sourceId: line._id },
          { date: line.date, account: lacc.name, accountType: 'expense', debit: 0, credit: mAmt, description: m.label || 'Reimbursement', reference: reconRef, sourceType: 'reconciliation', sourceId: line._id }
        );
        savedMatches.push({ kind: 'reimbursement', refId: exp._id, label: m.label || 'Reimbursement', amount: mAmt });

      } else if (m.kind === 'income') {
        // New income entry (credit line extra OR interest income)
        const lacc = await ensureLedgerAccount(m.label || 'Other Income', 'income');
        await BankAccount.findByIdAndUpdate(line.bankAccount, { $inc: { currentBalance: mAmt } });
        ledgerEntries.push(
          { date: line.date, account: bankName, accountType: 'bank', debit: mAmt, credit: 0, description: m.label || 'Income', reference: reconRef, sourceType: 'reconciliation', sourceId: line._id },
          { date: line.date, account: lacc.name, accountType: 'income', debit: 0, credit: mAmt, description: m.label || 'Income', reference: reconRef, sourceType: 'reconciliation', sourceId: line._id }
        );
        savedMatches.push({ kind: 'income', refId: undefined, label: m.label || 'Income', amount: mAmt });

      } else if (m.kind === 'expense' && !m.refId) {
        // New bank charge / fee (debit line with no existing record)
        const lacc = await ensureLedgerAccount(m.label || 'Bank Charges', 'expense');
        const exp = await Expense.create({
          date: line.date, ledgerAccount: lacc._id, ledgerAccountName: lacc.name,
          description: m.label || 'Bank charges', amount: mAmt,
          paymentMethod: 'bank', bankAccount: line.bankAccount,
          bankAccountName: bankName, reference: reconRef, ledgered: true
        });
        await BankAccount.findByIdAndUpdate(line.bankAccount, { $inc: { currentBalance: -mAmt } });
        ledgerEntries.push(
          { date: line.date, account: lacc.name, accountType: 'expense', debit: mAmt, credit: 0, description: m.label || 'Bank charges', reference: reconRef, sourceType: 'reconciliation', sourceId: line._id },
          { date: line.date, account: bankName, accountType: 'bank', debit: 0, credit: mAmt, description: m.label || 'Bank charges', reference: reconRef, sourceType: 'reconciliation', sourceId: line._id }
        );
        savedMatches.push({ kind: 'expense', refId: exp._id, label: m.label || 'Bank charges', amount: mAmt });

      } else {
        // Existing invoice / expense / banktx — just link
        savedMatches.push({ kind: m.kind, refId: m.refId || undefined, label: m.label || '', amount: mAmt });
      }
    }

    if (ledgerEntries.length) await Ledger.insertMany(ledgerEntries);

    line.matches     = savedMatches;
    line.status      = 'reconciled';
    line.reconciledAt = new Date();
    if (note) line.notes = note;
    await line.save();

    res.json(line);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── IGNORE ─────────────────────────────────────────────────────────────────

router.post('/:lineId/ignore', async (req, res) => {
  try {
    const line = await BankStatementLine.findByIdAndUpdate(
      req.params.lineId,
      { status: 'ignored', notes: req.body.note || '' },
      { new: true }
    );
    if (!line) return res.status(404).json({ error: 'Not found' });
    res.json(line);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── UNDO ───────────────────────────────────────────────────────────────────

router.post('/:lineId/undo', async (req, res) => {
  try {
    const line = await BankStatementLine.findById(req.params.lineId);
    if (!line) return res.status(404).json({ error: 'Not found' });
    if (line.status === 'unreconciled') return res.status(400).json({ error: 'Line is not reconciled' });

    // Find ledger entries we created and calculate bank balance reversal
    const ledEntries = await Ledger.find({ sourceType: 'reconciliation', sourceId: line._id }).lean();
    let balanceReversal = 0;
    for (const e of ledEntries) {
      if (e.accountType === 'bank') {
        // credit to bank = money went out → reversal = +credit (add back)
        // debit to bank  = money came in  → reversal = -debit (subtract)
        balanceReversal += (e.credit - e.debit);
      }
    }
    if (Math.abs(balanceReversal) > 0.001) {
      await BankAccount.findByIdAndUpdate(line.bankAccount, { $inc: { currentBalance: balanceReversal } });
    }

    // Delete expenses created by this reconciliation
    await Expense.deleteMany({ reference: `RECON-${line._id}` });

    // Delete ledger entries
    await Ledger.deleteMany({ sourceType: 'reconciliation', sourceId: line._id });

    // Restore cheques
    for (const m of (line.matches || [])) {
      if (m.kind === 'cheque' && m.refId) {
        await Cheque.findByIdAndUpdate(m.refId, { status: 'deposited', clearedDate: null });
      }
    }

    line.matches      = [];
    line.status       = 'unreconciled';
    line.reconciledAt = undefined;
    line.notes        = '';
    await line.save();

    res.json(line);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
