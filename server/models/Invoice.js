const mongoose = require('mongoose');
const invoiceItemSchema = new mongoose.Schema({
  product:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName:  { type: String, required: true },
  sku:          { type: String, default: '' },
  qty:          { type: Number, required: true },
  unit:         { type: String, default: 'pcs' },
  unitPrice:    { type: Number, required: true },
  taxLines:     [{ taxCode: String, taxName: String, rate: Number, amount: Number }],
  taxAmount:    { type: Number, default: 0 },
  lineSubtotal: { type: Number, default: 0 },
  lineTotal:    { type: Number, default: 0 },
  location:     { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  locationName: { type: String, default: '' }
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  invoiceNo:    { type: String, required: true, unique: true },
  invoiceType:  { type: mongoose.Schema.Types.ObjectId, ref: 'InvoiceType' },
  invoiceTypeName:{ type: String, default: '' },
  customer:     { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName: { type: String, default: 'Walk-in Customer' },
  date:         { type: Date, default: Date.now },
  dueDate:      { type: Date },
  items:        [invoiceItemSchema],
  subtotal:     { type: Number, default: 0 },
  discount:     { type: Number, default: 0 },
  vatAmount:    { type: Number, default: 0 },
  ssclAmount:   { type: Number, default: 0 },
  taxAmount:    { type: Number, default: 0 },
  total:        { type: Number, default: 0 },
  paid:         { type: Number, default: 0 },
  balance:      { type: Number, default: 0 },
  status:       { type: String, enum: ['draft','pending','paid','partial','overdue'], default: 'pending' },
  notes:        { type: String, default: '' },
  taxInclusive: { type: Boolean, default: false },
  paymentMode:  { type: String, default: 'cash' },
  cashAccount:  { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount' },
  cashAccountName:{ type: String, default: '' },
  bankAccount:  { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
  chequeNo:     { type: String, default: '' }
}, { timestamps: true });

invoiceSchema.pre('save', function(next) {
  this.balance = this.total - this.paid;
  if (this.balance <= 0.001) this.status = 'paid';
  else if (this.paid > 0) this.status = 'partial';
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
