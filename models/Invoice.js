const mongoose = require('mongoose');
const invoiceItemSchema = new mongoose.Schema({
  product:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  productName:  { type: String, required: true },
  sku:          { type: String, default: '' },
  qty:          { type: Number, required: true },
  unit:         { type: String, default: 'pcs' },
  unitPrice:    { type: Number, required: true },
  // Whether this line was sold in loose units (e.g. kg) rather than whole base units (e.g. bags)
  looseMode:    { type: Boolean, default: false },
  taxLines:     [{ taxCode: String, taxName: String, rate: Number, amount: Number }],
  taxAmount:    { type: Number, default: 0 },
  lineSubtotal: { type: Number, default: 0 },
  lineTotal:    { type: Number, default: 0 },
  location:     { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation' },
  locationName: { type: String, default: '' },
  // ── Partial delivery tracking (Order/Proforma/Invoice flow) ──
  deliveredQty: { type: Number, default: 0 },
  deliveries:   [{ qty: { type: Number, required: true }, date: { type: Date, default: Date.now } }],
  // ── Returns tracking — how much of this line has already been returned via a credit note ──
  returnedQty:  { type: Number, default: 0 }
}); // _id enabled (default) so each line item can be targeted individually for delivery

const invoiceSchema = new mongoose.Schema({
  invoiceNo:    { type: String, required: true, unique: true },
  // ── Document flow: booking (soft order) → proforma (quote) → invoice (final); credit_note = return against an invoice ──
  type:         { type: String, enum: ['booking','proforma','invoice','credit_note'], default: 'invoice' },
  // ── Credit note linkage (only set when type === 'credit_note') ──
  creditNoteFor:   { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  creditNoteForNo: { type: String, default: '' },
  returnReason:    { type: String, default: '' },
  restocked:       { type: Boolean, default: false },
  converted:    { type: Boolean, default: false },        // true once this booking/proforma has been turned into an invoice
  convertedFromId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  convertedFromNo: { type: String, default: '' },
  convertedToId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  convertedToNo:   { type: String, default: '' },
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

invoiceSchema.index({ type: 1, date: -1 });          // Invoices/Bookings/Proformas list filter + sort
invoiceSchema.index({ customer: 1 });                 // customer statement / balance lookups
invoiceSchema.index({ 'items.product': 1, type: 1 }); // commitments-summary aggregation (Inventory page)

invoiceSchema.pre('save', function(next) {
  this.balance = this.total - this.paid;
  if (this.balance <= 0.001) this.status = 'paid';
  else if (this.paid > 0) this.status = 'partial';
  next();
});

// Per-line delivery status: 'not_delivered' | 'partial' | 'fully_delivered'
invoiceSchema.methods.lineDeliveryStatus = function(item) {
  const delivered = item.deliveredQty || 0;
  if (delivered <= 0) return 'not_delivered';
  if (delivered >= item.qty) return 'fully_delivered';
  return 'partial';
};

// Overall document delivery status, derived from all line items (booking/proforma have no delivery concept)
invoiceSchema.methods.overallDeliveryStatus = function() {
  if (this.type !== 'invoice') return null;
  if (!this.items || !this.items.length) return 'not_delivered';
  const statuses = this.items.map(i => this.lineDeliveryStatus(i));
  if (statuses.every(s => s === 'fully_delivered')) return 'fully_delivered';
  if (statuses.every(s => s === 'not_delivered')) return 'not_delivered';
  return 'partial';
};

// Include computed fields (pendingQty, lineStatus, docDeliveryStatus) whenever this doc is sent as JSON
invoiceSchema.methods.toJSON = function() {
  const obj = this.toObject();
  if (obj.items) {
    obj.items = obj.items.map(item => ({
      ...item,
      pendingQty: (item.qty || 0) - (item.deliveredQty || 0),
      returnableQty: (item.qty || 0) - (item.returnedQty || 0),
      lineDeliveryStatus: this.lineDeliveryStatus(item)
    }));
  }
  obj.overallDeliveryStatus = this.overallDeliveryStatus();
  return obj;
};

module.exports = mongoose.model('Invoice', invoiceSchema);
