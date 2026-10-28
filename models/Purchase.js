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
  receivedQty:  { type: Number, default: 0 },   // staged purchases: how much has arrived so far
  customsDutyRate: { type: Number, default: 0 },
  customsDutyAmt:  { type: Number, default: 0 },
  cessRate:        { type: Number, default: 0 },
  cessAmt:         { type: Number, default: 0 },
}, { _id: false });

const landingCostSchema = new mongoose.Schema({
  description: { type: String, required: true },
  currency:    { type: String, default: 'LKR' },
  amountForeign: { type: Number, default: 0 },
  amount:      { type: Number, required: true },
  taxCode:     { type: String, default: '' },
  isImportTax: { type: Boolean, default: false },
  method:      { type: String, enum: ['value','qty','equal'], default: 'value' },
  date:        { type: Date, default: Date.now },
  // Tax-aware rows (rows without `kind` are older rows: whole amount spread into cost, no tax split).
  // The server works out baseAmount / taxAmount / amount from what was entered.
  kind:        { type: String, enum: ['cost','tax'] },        // a cost (freight…) or a tax paid (duty, import VAT…)
  taxMode:     { type: String, enum: ['none','included','added'], default: 'none' },  // cost rows only
  entered:     { type: Number },                              // what the user typed (LKR)
  taxRate:     { type: Number },
  taxAmount:   { type: Number, default: 0 },
  baseAmount:  { type: Number, default: 0 },
  claimable:   { type: Boolean },
  addToCost:   { type: Boolean },
  costAccount: { type: String, default: '' },                 // where the cost part (base) is posted
  landedAmount:{ type: Number, default: 0 },                  // the part that goes into product cost
  // owe = added to what you owe the supplier (default, as before). cash / bank = paid straight from
  // that account: not in the purchase total; own ledger rows tagged narration 'extra:<rowId>'.
  payMode:     { type: String, enum: ['owe','cash','bank'], default: 'owe' },
  cashAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'CashAccount' },
  bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
  moneyAccountName: { type: String, default: '' },
  cashEntry:   { type: mongoose.Schema.Types.ObjectId, ref: 'CashEntry' },
  rowId:       { type: String },                              // stable id, assigned by the server
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
  cheque:      { type: mongoose.Schema.Types.ObjectId, ref: 'Cheque' },   // cheque written, or third-party cheque endorsed
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
  // legacy = stock was added when the purchase was created (never receive again);
  // staged = stock moves only through receipts
  receiptMode:   { type: String, enum: ['legacy','staged'], default: 'legacy' },
  receipts: [{
    date:  { type: Date, default: Date.now },
    note:  { type: String, default: '' },
    lines: [{ lineIndex: { type: Number, required: true }, qty: { type: Number, required: true }, _id: false }],
  }],
  isFinalized:     { type: Boolean, default: false },  // locks items and extra costs (payments/receipts still allowed)
  landingTaxTotal: { type: Number, default: 0 },
  subtotalForeign: { type: Number, default: 0 },
  subtotal:      { type: Number, default: 0 },
  taxAmount:     { type: Number, default: 0 },
  landingCostTotal: { type: Number, default: 0 },   // extra costs added to what you owe (in the total); paid-directly rows excluded
  landedCostTotal:  { type: Number, default: 0 },   // the part of extra costs that goes into product cost
  importTaxTotal:{ type: Number, default: 0 },
  vatInputAmount:{ type: Number, default: 0 },   // no longer written; older purchases keep their value
  // Tax per code on this purchase (item taxes and import-tax extra costs). claimable = the tax's
  // creditable setting when saved: claimable goes to the tax account, otherwise it is a cost.
  taxTotals:     [{ taxCode: String, taxName: String, amount: Number, claimable: Boolean, _id: false }],
  // 0 = older purchase (item tax never added to unit cost); 1 = non-claimable item tax is part of unit cost
  taxVersion:    { type: Number, default: 0 },
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
  if (this.receiptMode === 'staged') {
    this.goodsReceived = (this.items || []).length > 0 && this.items.every(i => (i.receivedQty || 0) >= i.qty);
    const last = (this.receipts || []).reduce((d, r) => (!d || r.date > d ? r.date : d), null);
    this.goodsReceivedDate = last || undefined;
  }
  next();
});

module.exports = mongoose.model('Purchase', purchaseSchema);
