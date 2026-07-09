const mongoose = require('mongoose');
// Multiple cash accounts: Petty Cash, Cash in Locker, Drawer Cash, etc.
const cashAccountSchema = new mongoose.Schema({
  name:           { type: String, required: true, trim: true, unique: true },
  description:    { type: String, default: '' },
  openingBalance: { type: Number, default: 0 },
  currentBalance: { type: Number, default: 0 },
  color:          { type: String, default: '#f0a500' },
  active:         { type: Boolean, default: true },
  sortOrder:      { type: Number, default: 0 }
}, { timestamps: true });
module.exports = mongoose.model('CashAccount', cashAccountSchema);
