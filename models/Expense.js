const mongoose = require('mongoose');
const expenseSchema = new mongoose.Schema({
  date: { type: Date, required: true, default: Date.now },
  ledgerAccount:     { type: mongoose.Schema.Types.ObjectId, ref: 'LedgerAccount' },
  ledgerAccountName: { type: String, required: true, trim: true },
  description:   { type: String, required: true, trim: true },
  amount:        { type: Number, required: true },
  paymentMethod: { type: String, enum: ['cash','bank','cheque','credit'], default: 'cash' },
  cashAccount:   { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount' },
  cashAccountName:{ type: String, default: '' },
  bankAccount:   { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
  bankAccountName:{ type: String, default: '' },
  chequeNo:      { type: String, default: '' },
  reference:     { type: String, default: '' },
  vendor:        { type: String, default: '' },
  notes:         { type: String, default: '' },
  ledgered:      { type: Boolean, default: true }
}, { timestamps: true });
module.exports = mongoose.model('Expense', expenseSchema);
