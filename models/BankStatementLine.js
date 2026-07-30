const mongoose = require('mongoose');
const crypto   = require('crypto');

const bankStatementLineSchema = new mongoose.Schema({
  bankAccount:    { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
  bankAccountName:{ type: String, default: '' },
  date:           { type: Date, required: true },
  description:    { type: String, default: '' },    // raw bank narration
  reference:      { type: String, default: '' },    // parsed invoice/cheque ref (e.g. "148")
  note:           { type: String, default: '' },    // first segment of ComBank narration
  counterparty:   { type: String, default: '' },    // last segment (payer/payee name)
  amount:         { type: Number, required: true }, // signed: + credit (money in), - debit (money out)
  direction:      { type: String, enum: ['credit','debit'], required: true },
  balance:        { type: Number },                 // running balance from CSV
  importBatch:    { type: String, index: true },    // groups one CSV import
  rawRow:         { type: String, default: '' },    // original CSV row
  dedupeKey:      { type: String, index: true },    // hash to prevent double-import
  status:         { type: String, enum: ['unreconciled','reconciled','ignored'], default: 'unreconciled', index: true },
  matches: [{
    kind:   { type: String, enum: ['invoice','expense','cheque','banktx','income','reimbursement'] },
    refId:  { type: mongoose.Schema.Types.ObjectId },
    label:  { type: String, default: '' },
    amount: { type: Number, required: true }
  }],
  reconciledAt: { type: Date },
  notes:        { type: String, default: '' }
}, { timestamps: true });

bankStatementLineSchema.index({ bankAccount: 1, date: 1 });

// Static helper — exposed so the import route can reuse the same logic
bankStatementLineSchema.statics.makeDedupeKey = function(bankAccountId, date, amount, description) {
  const dateStr  = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const normDesc = (description || '').toLowerCase().replace(/[^\w]/g, '').slice(0, 60);
  return crypto.createHash('md5').update(`${bankAccountId}|${dateStr}|${amount}|${normDesc}`).digest('hex');
};

module.exports = mongoose.model('BankStatementLine', bankStatementLineSchema);
