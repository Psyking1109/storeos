const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },  // e.g. "HNB Current Account"
  accountNumber: { type: String, default: '', trim: true },
  bank:          { type: String, default: '', trim: true },
  branch:        { type: String, default: '' },
  currency:      { type: String, default: 'LKR' },
  openingBalance:{ type: Number, default: 0 },
  currentBalance:{ type: Number, default: 0 },
  type:          { type: String, enum: ['current','savings','fixed'], default: 'current' },
  active:        { type: Boolean, default: true },
  notes:         { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('BankAccount', bankAccountSchema);
