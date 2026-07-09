const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  phone:   { type: String, default: '', trim: true },
  email:   { type: String, default: '', trim: true },
  address: { type: String, default: '' },
  balance: { type: Number, default: 0 },  // positive = we owe them
  notes:   { type: String, default: '' },
  active:  { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Supplier', supplierSchema);
