const mongoose = require('mongoose');

// Chart of Accounts: named buckets users create to track money by purpose.
// Example: "Stationery" (expense) → every pen/notebook purchase posts here.
// Then user can see exactly how much was spent on Stationery this month.
const ledgerAccountSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, trim: true },
  code:        { type: String, trim: true, default: '' },
  type:        { type: String, required: true,
                 enum: ['asset','liability','equity','income','expense'],
                 default: 'expense' },
  description: { type: String, default: '' },
  openingBalance: { type: Number, default: 0 },
  active:      { type: Boolean, default: true },
  isSystem:    { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('LedgerAccount', ledgerAccountSchema);
