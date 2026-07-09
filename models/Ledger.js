const mongoose = require('mongoose');

// A simplified single-entry ledger — every financial event creates one or two ledger rows
const ledgerSchema = new mongoose.Schema({
  date:        { type: Date, required: true, default: Date.now },
  account:     { type: String, required: true },   // e.g. "Cash", "Bank - HNB", "Sales", "Purchases"
  accountType: { type: String, enum: ['cash','bank','sales','purchases','receivable','payable','expense','income','revenue','equity','cheque','asset','liability','tax'], required: true },
  debit:       { type: Number, default: 0 },
  credit:      { type: Number, default: 0 },
  description: { type: String, required: true },
  reference:   { type: String, default: '' },
  sourceType:  { type: String, default: '' },   // 'invoice','purchase','cash','bank','cheque'
  sourceId:    { type: mongoose.Schema.Types.ObjectId },
  narration:   { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Ledger', ledgerSchema);
