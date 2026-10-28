#!/usr/bin/env node
/*
 * Move ledger rows from the old tax account names to the accounts chosen in Setup → Tax Rates.
 *
 *   node scripts/migrate-tax-accounts.js                  preview only (default, writes nothing)
 *   node scripts/migrate-tax-accounts.js --apply          make the changes (saves a backup first)
 *   node scripts/migrate-tax-accounts.js --restore <file> undo an --apply using its backup file
 *
 * Take a database backup (Atlas snapshot) before --apply, and check the mapping table first.
 *
 * Old names → new account (only for taxes whose Tax account is set):
 *   "<CODE> Payable"        → that tax's Tax account
 *   "<CODE> Expense"        → that tax's Cost account
 *   "Input VAT"             → VAT's Tax account (Cost account if VAT is not claimable)
 *   "PAL Expense"           → PAL's Cost account (Tax account if claimable)
 *   "Customs Duty"          → CUST_DUTY's Cost account (Tax account if claimable)
 *   "Other Purchase Taxes"  → worked out per purchase: if exactly one set-up tax on that purchase
 *                             could have gone there, its account; otherwise listed as ambiguous and skipped.
 * Anything without a set-up tax, or ambiguous, is listed and left alone.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const TaxRate = require('../models/TaxRate');
const LedgerAccount = require('../models/LedgerAccount');
const Purchase = require('../models/Purchase');
const { ROW_TYPE } = require('../utils/taxAccounts');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] || '') : null; };
const APPLY = args.includes('--apply');
const RESTORE = opt('--restore');
const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (s, n) => String(s).padEnd(n);

// Codes the old purchase code posted to their own named accounts; everything else went to
// "Other Purchase Taxes".
const OLD_NAMED = { VAT: 'Input VAT', PAL: 'PAL Expense', CUST_DUTY: 'Customs Duty' };

async function restore(file) {
  const b = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Restoring from ${file} (made ${b.createdAt})`);
  for (const r of b.updated) await Ledger.updateOne({ _id: r._id }, { $set: { account: r.account, accountType: r.accountType } });
  console.log(`Restored ${b.updated.length} rows.`);
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (.env)');
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.host}/${mongoose.connection.name}\n`);
  if (RESTORE) { await restore(RESTORE); return; }

  const taxes = await TaxRate.find().lean();
  const accType = Object.fromEntries((await LedgerAccount.find().lean()).map(a => [a.name, ROW_TYPE[a.type] || 'expense']));
  const set = t => t && t.account;
  const purchaseTarget = t => (t.creditable ? t.account : (t.costAccount || t.account));
  const byCode = Object.fromEntries(taxes.map(t => [t.code, t]));

  // Fixed renames
  const rename = {};   // old name -> { to, why }
  const skipped = [];  // { name, why }
  for (const t of taxes) {
    if (!set(t)) continue;
    rename[`${t.code} Payable`] = { to: t.account, why: `${t.code} tax account` };
    rename[`${t.code} Expense`] = { to: t.costAccount || t.account, why: `${t.code} cost account` };
  }
  for (const [code, oldName] of Object.entries(OLD_NAMED)) {
    const t = byCode[code];
    if (set(t)) rename[oldName] = { to: purchaseTarget(t), why: `${code} ${t.creditable ? 'tax' : 'cost'} account` };
    else rename[oldName] = { why: t ? `${code} has no tax account set` : `no tax with code ${code}` };
  }

  // Every old-style name actually in the ledger, so nothing is missed in the table
  const used = await Ledger.aggregate([
    { $match: { $or: [{ account: { $regex: / (Payable|Expense)$/ } }, { account: { $in: [...Object.values(OLD_NAMED), 'Other Purchase Taxes'] } }] } },
    { $group: { _id: '$account', n: { $sum: 1 }, dr: { $sum: '$debit' }, cr: { $sum: '$credit' } } },
    { $sort: { _id: 1 } },
  ]);
  const plan = [];     // { _id, from, to, accountType }
  console.log('Mapping (old account → new account):\n');
  console.log(pad('Old name', 26) + pad('New account', 26) + pad('Rows', 7) + 'Why');
  for (const u of used) {
    if (u._id === 'Other Purchase Taxes') continue;
    const r = rename[u._id];
    if (r && !r.to) { skipped.push({ name: u._id, why: r.why, n: u.n }); continue; }
    if (!r) {
      // "Accounts Payable", "Cheques Payable" etc. are not tax accounts; only list tax-looking leftovers
      const code = u._id.replace(/ (Payable|Expense)$/, '');
      if (byCode[code]) skipped.push({ name: u._id, why: `${code} has no tax account set`, n: u.n });
      continue;
    }
    if (r.to === u._id) continue;
    console.log(pad(u._id, 26) + pad(r.to, 26) + pad(u.n, 7) + r.why);
    for (const row of await Ledger.find({ account: u._id }, { _id: 1 }).lean())
      plan.push({ _id: row._id, from: u._id, to: r.to, accountType: accType[r.to] || 'expense' });
  }

  // "Other Purchase Taxes": decide per purchase which tax it came from
  const other = await Ledger.find({ account: 'Other Purchase Taxes' }).lean();
  const otherCount = {};
  for (const row of other) {
    const po = row.sourceType === 'purchase' && row.sourceId ? await Purchase.findById(row.sourceId).lean() : null;
    if (!po) { skipped.push({ name: 'Other Purchase Taxes', why: `row ${row._id} has no purchase`, n: 1 }); continue; }
    const codes = new Set();
    if (!po.taxInclusive) for (const it of po.items || []) for (const tl of it.taxLines || []) if (tl.amount && !OLD_NAMED[tl.taxCode]) codes.add(tl.taxCode || '');
    for (const lc of po.landingCosts || []) if (lc.isImportTax && lc.amount && !OLD_NAMED[lc.taxCode]) codes.add(lc.taxCode || '');
    if ((po.items || []).some(it => it.customsDutyAmt || it.cessAmt)) codes.add('(item duty/cess)');
    if (codes.size !== 1) { skipped.push({ name: 'Other Purchase Taxes', why: `${po.purchaseNo}: ${codes.size ? 'more than one tax (' + [...codes].join(', ') + ')' : 'no tax found'}`, n: 1 }); continue; }
    const code = [...codes][0], t = byCode[code];
    if (!set(t)) { skipped.push({ name: 'Other Purchase Taxes', why: `${po.purchaseNo}: ${code || '(no code)'} has no tax account set`, n: 1 }); continue; }
    const to = purchaseTarget(t);
    plan.push({ _id: row._id, from: 'Other Purchase Taxes', to, accountType: accType[to] || 'expense' });
    otherCount[to] = (otherCount[to] || 0) + 1;
  }
  for (const [to, n] of Object.entries(otherCount)) console.log(pad('Other Purchase Taxes', 26) + pad(to, 26) + pad(n, 7) + 'worked out per purchase');
  if (!plan.length) console.log('(nothing to move)');

  if (skipped.length) {
    console.log('\nLeft alone (ambiguous or not set up):');
    for (const s of skipped) console.log(`  ${pad(s.name, 24)} ${s.n ? s.n + ' row(s) — ' : ''}${s.why}`);
  }

  // Item-level duty/cess fields are no longer read; list any purchase that still has them
  const dutyPOs = await Purchase.find({ $or: [{ 'items.customsDutyRate': { $gt: 0 } }, { 'items.cessRate': { $gt: 0 } }] }, { purchaseNo: 1 }).lean();
  if (dutyPOs.length) console.log(`\nNote: these purchases have item duty/cess rates, which are no longer used (editing them drops those amounts): ${dutyPOs.map(p => p.purchaseNo).join(', ')}`);

  console.log(`\n${plan.length} ledger row(s) to move.`);
  if (!APPLY) { console.log('Preview only. Check the table above, take a database backup, then run again with --apply.'); return; }
  if (!plan.length) return;

  const dir = path.join(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backupFile = path.join(dir, `migrate-tax-accounts-${Date.now()}.json`);
  const before = await Ledger.find({ _id: { $in: plan.map(p => p._id) } }, { account: 1, accountType: 1 }).lean();
  fs.writeFileSync(backupFile, JSON.stringify({ createdAt: new Date(), updated: before }, null, 1));
  console.log(`Backup written: ${backupFile}`);
  for (const p of plan) await Ledger.updateOne({ _id: p._id }, { $set: { account: p.to, accountType: p.accountType } });
  console.log(`Moved ${plan.length} row(s). Undo with: node scripts/migrate-tax-accounts.js --restore ${backupFile}`);
}

main().then(() => mongoose.disconnect()).catch(e => { console.error(e.message); mongoose.disconnect(); process.exit(1); });
