#!/usr/bin/env node
/*
 * One-off clean-up of ledger rows written by older versions of StoreOS.
 *
 *   node scripts/cleanup-bank-entries.js                 preview only (default, writes nothing)
 *   node scripts/cleanup-bank-entries.js --apply         make the changes (saves a backup first)
 *   node scripts/cleanup-bank-entries.js --restore <file> undo an --apply using its backup file
 *
 * Options for payments whose account was never recorded (see section 1b of the preview):
 *   --default-bank "<bank account name>"   treat them as paid into this bank account
 *   --default-cash "<cash account name>"   treat them as paid into this cash account
 *   These also add the money to that account's balance, because the old code never did.
 *
 * What it fixes
 *   1. Invoice payments posted to a generic "Bank" / "Cash" ledger account instead of the real
 *      bank/cash account. Moved to the account saved on the invoice (its balance already
 *      included the money, so only the ledger row changes).
 *   2. Bank opening balances posted one-sided (Dr Bank only). Adds the matching
 *      Cr Opening Balance Equity row; an overdraft entered as a negative debit is turned
 *      into a proper credit.
 *   3. Expense rows posted with the wrong account type (e.g. "Accounts Payable" typed as cash).
 * Then it reports anything still generic and any document whose entries don't balance.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Invoice = require('../models/Invoice');
const BankAccount = require('../models/BankAccount');
const CashAccount = require('../models/CashAccount');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : null; };
const APPLY = args.includes('--apply');
const RESTORE = opt('--restore');
const DEFAULT_BANK = opt('--default-bank');
const DEFAULT_CASH = opt('--default-cash');
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = d => d ? new Date(d).toISOString().slice(0, 10) : '';

async function restore(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Restoring from ${file} (made ${b.createdAt})`);
  for (const r of b.updated) await Ledger.updateOne({ _id: r._id }, { $set: { account: r.account, accountType: r.accountType, debit: r.debit, credit: r.credit } });
  if (b.inserted.length) await Ledger.deleteMany({ _id: { $in: b.inserted } });
  for (const x of b.balances) {
    const M = x.kind === 'bank' ? BankAccount : CashAccount;
    await M.updateOne({ _id: x._id }, { $inc: { currentBalance: -x.added } });
  }
  console.log(`Restored ${b.updated.length} rows, removed ${b.inserted.length} added rows, reversed ${b.balances.length} balance changes.`);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (.env)');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}\n`);
  if (RESTORE) { await restore(RESTORE); return; }

  const banks = await BankAccount.find().lean();
  const cashes = await CashAccount.find().lean();
  const bankById = Object.fromEntries(banks.map(a => [String(a._id), a]));
  const cashById = Object.fromEntries(cashes.map(a => [String(a._id), a]));
  let defBank = null, defCash = null;
  if (DEFAULT_BANK !== null) { defBank = banks.find(a => a.name === DEFAULT_BANK); if (!defBank) throw new Error(`No bank account named "${DEFAULT_BANK}". Have: ${banks.map(a => a.name).join(', ')}`); }
  if (DEFAULT_CASH !== null) { defCash = cashes.find(a => a.name === DEFAULT_CASH); if (!defCash) throw new Error(`No cash account named "${DEFAULT_CASH}". Have: ${cashes.map(a => a.name).join(', ')}`); }

  const updates = [];   // { row, set: {...}, why }
  const inserts = [];   // new ledger docs
  const balances = [];  // { kind, _id, name, added }

  // ── 1. Generic Bank / Cash rows on invoice payments ─────────────────────────
  const generic = await Ledger.find({ sourceType: 'invoice', account: { $in: ['Bank', 'Cash'] }, debit: { $gt: 0 } }).lean();
  const invs = await Invoice.find({ _id: { $in: [...new Set(generic.map(r => String(r.sourceId)))] } })
    .select('invoiceNo bankAccount cashAccount').lean();
  const invById = Object.fromEntries(invs.map(i => [String(i._id), i]));
  const unresolved = [];
  const perInvoice = {};
  for (const r of generic) perInvoice[`${r.sourceId}:${r.account}`] = (perInvoice[`${r.sourceId}:${r.account}`] || 0) + 1;

  for (const r of generic) {
    const inv = invById[String(r.sourceId)];
    const isBank = r.account === 'Bank';
    const known = inv && (isBank ? bankById[String(inv.bankAccount)] : cashById[String(inv.cashAccount)]);
    if (known) {
      const multi = perInvoice[`${r.sourceId}:${r.account}`] > 1 ? ' (several payments on this invoice; assumed same account)' : '';
      updates.push({ row: r, set: { account: known.name, accountType: isBank ? 'bank' : 'cash' }, why: `1a  ${day(r.date)} ${r.reference || ''} ${money(r.debit)}: ${r.account} → ${known.name}${multi}` });
    } else {
      const def = isBank ? defBank : defCash;
      if (def) {
        updates.push({ row: r, set: { account: def.name, accountType: isBank ? 'bank' : 'cash' }, why: `1b  ${day(r.date)} ${r.reference || ''} ${money(r.debit)}: ${r.account} → ${def.name} (default; balance +${money(r.debit)})` });
        balances.push({ kind: isBank ? 'bank' : 'cash', _id: def._id, name: def.name, added: r.debit });
      } else unresolved.push(r);
    }
  }

  // ── 2. One-sided bank opening balances ──────────────────────────────────────
  const openings = await Ledger.find({ sourceType: 'bank', description: /^Opening balance/, accountType: 'bank' }).lean();
  for (const r of openings) {
    const pair = await Ledger.exists({ sourceType: 'bank', sourceId: r.sourceId, account: 'Opening Balance Equity' });
    if (pair) continue;
    const ob = (r.debit || 0) - (r.credit || 0); // a negative opening was stored as a negative debit
    if (!ob) continue;
    if (r.debit < 0) updates.push({ row: r, set: { debit: 0, credit: -ob }, why: `2   ${r.account}: negative debit ${money(r.debit)} → credit ${money(-ob)}` });
    inserts.push({ date: r.date, account: 'Opening Balance Equity', accountType: 'equity', debit: ob < 0 ? -ob : 0, credit: ob > 0 ? ob : 0,
      description: r.description, reference: '', sourceType: 'bank', sourceId: r.sourceId, narration: 'opening' });
  }

  // ── 3. Expense rows with the wrong account type ─────────────────────────────
  const typeFix = { 'Accounts Payable': 'payable', 'Cheques Payable': 'cheque' };
  const badTypes = await Ledger.find({ sourceType: 'expense', account: { $in: Object.keys(typeFix) }, accountType: 'cash' }).lean();
  for (const r of badTypes) updates.push({ row: r, set: { accountType: typeFix[r.account] }, why: `3   ${day(r.date)} ${r.account}: type cash → ${typeFix[r.account]}` });

  // ── Preview ────────────────────────────────────────────────────────────────
  const sum = (list, k) => list.reduce((s, x) => s + (x[k] || 0), 0);
  console.log(`1a. Invoice payments moved to their real account:    ${updates.filter(u => u.why.startsWith('1a')).length}`);
  console.log(`1b. Moved to a default account you chose:            ${updates.filter(u => u.why.startsWith('1b')).length}`);
  console.log(`    Still unknown (left as Bank/Cash):               ${unresolved.length}  (${money(sum(unresolved, 'debit'))})`);
  console.log(`2.  Opening balances given their equity side:        ${inserts.length}`);
  console.log(`3.  Expense rows with corrected account type:        ${badTypes.length}\n`);
  for (const u of updates) console.log('   ' + u.why);
  for (const i of inserts) console.log(`   2   add ${i.account} ${i.debit ? 'Dr ' + money(i.debit) : 'Cr ' + money(i.credit)} for "${i.description}"`);
  if (unresolved.length) {
    console.log('\n   Unknown account (the invoice never recorded which one; balances were not changed back then):');
    for (const r of unresolved) console.log(`     ${day(r.date)}  ${(r.reference || '').padEnd(14)} ${r.account.padEnd(5)} ${money(r.debit)}`);
    console.log('   If they all went to one account, rerun with --default-bank "<name>" / --default-cash "<name>".');
    console.log(`   Bank accounts: ${banks.map(a => `"${a.name}"`).join(', ') || '(none)'}   Cash accounts: ${cashes.map(a => `"${a.name}"`).join(', ') || '(none)'}`);
  }

  // Other generic rows this script does not touch (purchases/expenses never recorded an account)
  const otherGeneric = await Ledger.aggregate([
    { $match: { account: { $in: ['Bank', 'Cash'] }, sourceType: { $ne: 'invoice' } } },
    { $group: { _id: { account: '$account', sourceType: '$sourceType' }, n: { $sum: 1 }, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } },
  ]);
  if (otherGeneric.length) {
    console.log('\n   Generic rows from other sources (not changed; no account was ever recorded for them):');
    for (const g of otherGeneric) console.log(`     ${g._id.account} from ${g._id.sourceType || '?'}: ${g.n} rows, Dr ${money(g.dr)} Cr ${money(g.cr)}`);
  }

  // Books-wide check: documents whose own entries don't balance
  const unbalanced = await Ledger.aggregate([
    { $group: { _id: { t: '$sourceType', id: '$sourceId' }, ref: { $first: '$reference' }, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } },
    { $project: { ref: 1, diff: { $subtract: ['$dr', '$cr'] } } },
    { $match: { $or: [{ diff: { $gt: 0.01 } }, { diff: { $lt: -0.01 } }] } },
    { $sort: { diff: -1 } },
  ]);
  const total = await Ledger.aggregate([{ $group: { _id: null, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } }]);
  const t = total[0] || { dr: 0, cr: 0 };
  const fixDiff = sum(inserts, 'debit') - sum(inserts, 'credit') + updates.reduce((s, u) => s + ((u.set.debit ?? u.row.debit) - u.row.debit) - ((u.set.credit ?? u.row.credit) - u.row.credit), 0);
  console.log(`\nWhole ledger now: Dr ${money(t.dr)}  Cr ${money(t.cr)}  difference ${money(t.dr - t.cr)}`);
  console.log(`After this clean-up the difference would be ${money(t.dr - t.cr + fixDiff)}`);
  const left = unbalanced.filter(u => !(u._id.t === 'bank' && inserts.some(i => String(i.sourceId) === String(u._id.id))));
  if (left.length) {
    console.log(`\n${left.length} document(s) still have one-sided entries (mostly invoices from before the tax/discount fix):`);
    const byType = {};
    for (const u of left) (byType[u._id.t || '(none)'] = byType[u._id.t || '(none)'] || []).push(u);
    for (const [k, list] of Object.entries(byType))
      console.log(`   ${k.padEnd(14)} ${String(list.length).padStart(4)} docs, net ${money(sum(list, 'diff'))}   e.g. ${list.slice(0, 3).map(u => `${u.ref || u._id.id} (${money(u.diff)})`).join(', ')}`);
  }

  if (!APPLY) { console.log('\nPreview only: nothing was changed. Run again with --apply to make these changes.'); return; }
  if (!updates.length && !inserts.length && !balances.length) { console.log('\nNothing to change.'); return; }

  // ── Apply (backup first) ───────────────────────────────────────────────────
  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const backup = { createdAt: new Date().toISOString(), db: mongoose.connection.name,
    updated: updates.map(u => ({ _id: u.row._id, account: u.row.account, accountType: u.row.accountType, debit: u.row.debit, credit: u.row.credit })),
    inserted: [], balances: [] };
  fs.writeFileSync(file, JSON.stringify(backup, null, 1));

  for (const u of updates) await Ledger.updateOne({ _id: u.row._id }, { $set: u.set });
  if (inserts.length) backup.inserted = (await Ledger.insertMany(inserts)).map(d => d._id);
  for (const b of balances) {
    const M = b.kind === 'bank' ? BankAccount : CashAccount;
    await M.updateOne({ _id: b._id }, { $inc: { currentBalance: b.added } });
    backup.balances.push({ kind: b.kind, _id: b._id, added: b.added });
  }
  fs.writeFileSync(file, JSON.stringify(backup, null, 1));
  console.log(`\nApplied. Backup saved to ${path.relative(process.cwd(), file)}`);
  console.log(`To undo: node scripts/cleanup-bank-entries.js --restore ${path.relative(process.cwd(), file)}`);
}

main()
  .catch(e => { console.error('\nError:', e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
