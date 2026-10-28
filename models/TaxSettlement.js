const mongoose = require('mongoose');

// A payment of tax to the government (paid) or a refund received from it (refund),
// against one tax account. Its ledger rows are tagged sourceType 'taxsettlement'.
const taxSettlementSchema = new mongoose.Schema({
  account:     { type: String, required: true },   // the tax ledger account
  date:        { type: Date, required: true, default: Date.now },
  amount:      { type: Number, required: true },
  direction:   { type: String, enum: ['paid', 'refund'], required: true },
  paymentMode: { type: String, enum: ['cash', 'bank'], required: true },
  cashAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount' },
  bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
  moneyAccountName: { type: String, default: '' },
  cashEntry:   { type: mongoose.Schema.Types.ObjectId, ref: 'CashEntry' },
  reference:   { type: String, default: '' },
  note:        { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('TaxSettlement', taxSettlementSchema);
