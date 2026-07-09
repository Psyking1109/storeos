const mongoose = require('mongoose');
const taxRateSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, trim: true },
  name:        { type: String, required: true, trim: true },
  rate:        { type: Number, required: true },
  type:        { type: String, enum: ['output','input','both'], default: 'both' },
  creditable:  { type: Boolean, default: false },
  appliesTo:   { type: String, enum: ['sales','purchases','imports','all'], default: 'all' },
  // reducedBy: subtract these tax amounts from the gross before calculating this tax.
  // e.g. SSCL reducedBy:[VAT] → base = gross - VAT = net (254,237 not 300,000)
  reducedBy:   [{ type: String, trim: true }],
  // businessTax: if true, this tax is paid by the BUSINESS to the government.
  // It is NEVER added to the invoice total and NEVER shown to the customer.
  // It is calculated only for internal tax reporting (IRD returns).
  // Example: SSCL — you pay it, customer doesn't. Invoice stays at 300,000.
  businessTax: { type: Boolean, default: false },
  description: { type: String, default: '' },
  active:      { type: Boolean, default: true }
}, { timestamps: true });
module.exports = mongoose.model('TaxRate', taxRateSchema);
