const mongoose = require('mongoose');

const purchaseItemSchema = new mongoose.Schema({
  product:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName:  { type: String, required: true },
  sku:          { type: String, default: '' },
  qty:          { type: Number, required: true },
  unit:         { type: String, default: 'pcs' },
  unitCostForeign: { type: Number, default: 0 },
  unitCost:     { type: Number, required: true },
  taxLines:     [{ taxCode: String, taxName: String, rate: Number, amount: Number }],
  taxAmount:    { type: Number, default: 0 },
  lineSubtotal: { type: Number, default: 0 },
  lineTotal:    { type: Number, default: 0 },
  landingCostShare: { type: Number, default: 0 },
  finalUnitCost:{ type: Number, default: 0 },
}, { _id: false });

const landingCostSchema = new mongoose.Schema({
  description: { type: String, required: true },
  currency:    { type: String, default: 'LKR' },
  amountForeign: { type: Number, default: 0 },
  amount:      { type: Number, required: true },
  taxCode:     { type: String, default: '' },
  isImportTax: { type: Boolean, default: false },
  method:      { type: String, enum: ['value','qty','equal'], default: 'value' }
}, { _id: false });

// Payment stage — each payment made at different times
const paymentStageSchema = new mongoose.Schema({
  date:        { type: Date, default: Date.now },
  amount:      { type: Number, required: true },
  paymentMode: { type: String, default: 'bank' },
  reference:   { type: String, default: '' },  // TT ref, cheque no, etc.
  description: { type: String, default: '' },   // e.g. "TT Payment", "Balance Payment"
  cashAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount' },
  bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
}, { _id: true, timestamps: true });

const purchaseSchema = new mongoose.Schema({
  purchaseNo:    { type: String, required: true, unique: true },
  purchaseType:  { type: String, enum: ['local','import'], default: 'local' },
  supplier:      { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
  supplierName:  { type: String, default: '' },
  date:          { type: Date, default: Date.now },
  currency:      { type: String, default: 'LKR' },
  exchangeRate:  { type: Number, default: 1 },
  items:         [purchaseItemSchema],
  landingCosts:  [landingCostSchema],
  paymentStages: [paymentStageSchema],       // NEW: staged payments
  subtotalForeign: { type: Number, default: 0 },
  subtotal:      { type: Number, default: 0 },
  taxAmount:     { type: Number, default: 0 },
  landingCostTotal: { type: Number, default: 0 },
  importTaxTotal:{ type: Number, default: 0 },
  vatInputAmount:{ type: Number, default: 0 },
  total:         { type: Number, default: 0 },
  paid:          { type: Number, default: 0 },
  balance:       { type: Number, default: 0 },
  // NEW: separate financial status from goods receipt status
  status:        { type: String, enum: ['open','partial','paid'], default: 'open' },
  goodsReceived: { type: Boolean, default: false },   // NEW: have goods arrived?
  goodsReceivedDate: { type: Date },                  // NEW: when received
  notes:         { type: String, default: '' },
  updateStock:   { type: Boolean, default: true },
  taxInclusive:  { type: Boolean, default: false },
  paymentMode:   { type: String, default: 'cash' }
}, { timestamps: true });

purchaseSchema.pre('save', function(next) {
  // Recalculate paid from payment stages
  if (this.paymentStages && this.paymentStages.length > 0) {
    this.paid = this.paymentStages.reduce((s, p) => s + (p.amount || 0), 0);
  }
  this.balance = this.total - this.paid;
  if (this.balance <= 0.001) this.status = 'paid';
  else if (this.paid > 0) this.status = 'partial';
  else this.status = 'open';
  next();
});

module.exports = mongoose.model('Purchase', purchaseSchema);
