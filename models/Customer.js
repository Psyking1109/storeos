const mongoose = require('mongoose');
const customerSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  phone:   { type: String, default: '', trim: true },
  email:   { type: String, default: '', trim: true },
  address: { type: String, default: '' },
  tin:     { type: String, default: '', trim: true },  // Tax Identification Number
  balance: { type: Number, default: 0 },
  notes:   { type: String, default: '' },
  active:  { type: Boolean, default: true }
}, { timestamps: true });
module.exports = mongoose.model('Customer', customerSchema);
