const mongoose = require('mongoose');
// Transfers between cash accounts (not ledgered) or cash-to-bank (ledgered)
const cashTransferSchema = new mongoose.Schema({
  date:          { type: Date, required: true, default: Date.now },
  fromType:      { type: String, enum: ['cash','bank'], required: true },
  fromAccount:   { type: mongoose.Schema.Types.ObjectId, required: true },
  fromAccountName:{ type: String, default: '' },
  toType:        { type: String, enum: ['cash','bank'], required: true },
  toAccount:     { type: mongoose.Schema.Types.ObjectId, required: true },
  toAccountName: { type: String, default: '' },
  amount:        { type: Number, required: true },
  description:   { type: String, default: '' },
  reference:     { type: String, default: '' },
  // Ledger this only if it crosses between cash<->bank
  ledgered:      { type: Boolean, default: false }
}, { timestamps: true });
module.exports = mongoose.model('CashTransfer', cashTransferSchema);
