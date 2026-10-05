const mongoose = require('mongoose');

const chequeSchema = new mongoose.Schema({
  chequeNo:    { type: String, required: true, trim: true },
  date:        { type: Date, required: true },           // cheque date
  dueDate:     { type: Date, required: true },           // post-dated / maturity date
  direction:   { type: String, enum: ['received','issued'], required: true },
  amount:      { type: Number, required: true },
  party:       { type: String, required: true, trim: true },  // customer we got it from / supplier we gave it to
  partyId:     { type: mongoose.Schema.Types.ObjectId },       // Customer (received) or Supplier (issued)
  // Received cheques: who actually wrote it. Differs from `party` for a third-party cheque
  // (e.g. a customer hands over a cheque written by their own customer).
  drawer:      { type: String, default: '', trim: true },
  bank:        { type: String, default: '', trim: true },
  branch:      { type: String, default: '' },
  account:     { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },  // deposited to / drawn from
  accountName: { type: String, default: '' },
  reference:   { type: String, default: '' },   // invoice / purchase no
  invoice:     { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },   // payment for this invoice
  purchase:    { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },  // payment for this PO
  // Set when an invoice/PO payment created this cheque and already posted its opening ledger rows
  postedBy:    { type: String, default: '' },
  // The other side of the opening entry: AR (received) / AP (issued) by default, or a chosen ledger account
  contraAccount: { type: String, default: '' },
  contraType:    { type: String, default: '' },
  // endorsed = a received cheque passed on to pay someone else; it never reaches our bank
  status:      { type: String, enum: ['pending','deposited','cleared','bounced','cancelled','returned','endorsed'], default: 'pending' },
  depositedDate:{ type: Date },
  clearedDate: { type: Date },
  endorsement: {
    toType:       { type: String, enum: ['supplier','expense'] },
    supplier:     { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    payee:        { type: String, default: '' },       // supplier name or other payee
    purchase:     { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase' },
    purchaseNo:   { type: String, default: '' },
    stageId:      { type: mongoose.Schema.Types.ObjectId },  // PO payment stage it created
    expenseAccount:{ type: String, default: '' },
    date:         { type: Date },
    note:         { type: String, default: '' },
  },
  history:     [{ date: { type: Date, default: Date.now }, action: String, note: String }],
  notes:       { type: String, default: '' }
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

chequeSchema.virtual('thirdParty').get(function() {
  return this.direction === 'received' && !!this.drawer &&
    this.drawer.trim().toLowerCase() !== (this.party || '').trim().toLowerCase();
});

module.exports = mongoose.model('Cheque', chequeSchema);
