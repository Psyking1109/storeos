const mongoose = require('mongoose');

const bankTxSchema = new mongoose.Schema({
  date:        { type: Date, required: true, default: Date.now },
  type:        { type: String, enum: ['deposit','withdrawal','transfer'], required: true },
  account:     { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
  accountName: { type: String, default: '' },
  toAccount:   { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },  // for transfers
  toAccountName:{ type: String, default: '' },
  amount:      { type: Number, required: true },
  description: { type: String, required: true },
  reference:   { type: String, default: '' },       // cheque no, invoice no, etc.
  chequeNo:    { type: String, default: '' },
  category:    { type: String, default: '' },
  clearedDate: { type: Date },
  cleared:     { type: Boolean, default: true },    // false = pending/uncleared
  notes:       { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('BankTx', bankTxSchema);
