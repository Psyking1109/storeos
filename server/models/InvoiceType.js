const mongoose = require('mongoose');

const taxConfigSchema = new mongoose.Schema({
  taxCode:    { type: String, required: true },
  taxName:    { type: String, default: '' },
  rate:       { type: Number, required: true },
  creditable: { type: Boolean, default: false },
  // 'always' = auto-applied, hidden from toggling, just adds to tax total
  // 'toggle' = shown as a toggle button on the invoice form
  mode:       { type: String, enum: ['always', 'toggle'], default: 'always' }
}, { _id: false });

const invoiceTypeSchema = new mongoose.Schema({
  name:          { type: String, required: true, trim: true },
  prefix:        { type: String, required: true, trim: true },
  resetCycle:    { type: String, enum: ['never','daily','monthly','yearly'], default: 'daily' },
  lastCounter:   { type: Number, default: 0 },
  lastResetDate: { type: String, default: '' },
  padLength:     { type: Number, default: 4 },
  taxConfig:     [taxConfigSchema],   // taxes attached to this invoice type
  active:        { type: Boolean, default: true },
  notes:         { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('InvoiceType', invoiceTypeSchema);
