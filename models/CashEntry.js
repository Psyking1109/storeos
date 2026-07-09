const mongoose = require('mongoose');
const cashEntrySchema = new mongoose.Schema({
  date:        { type: Date, required: true, default: Date.now },
  type:        { type: String, enum: ['in','out'], required: true },
  category:    { type: String, required: true },
  description: { type: String, required: true },
  reference:   { type: String, default: '' },
  amount:      { type: Number, required: true },
  paymentMode: { type: String, enum: ['cash','card','bank','other'], default: 'cash' },
  cashAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount' },
  cashAccountName: { type: String, default: '' },
  notes:       { type: String, default: '' }
}, { timestamps: true });
module.exports = mongoose.model('CashEntry', cashEntrySchema);
