const mongoose = require('mongoose');

const chequeSchema = new mongoose.Schema({
  chequeNo:    { type: String, required: true, trim: true },
  date:        { type: Date, required: true },           // cheque date
  dueDate:     { type: Date, required: true },           // post-dated / maturity date
  direction:   { type: String, enum: ['received','issued'], required: true },
  amount:      { type: Number, required: true },
  party:       { type: String, required: true, trim: true },  // customer or supplier name
  partyId:     { type: mongoose.Schema.Types.ObjectId },
  bank:        { type: String, default: '', trim: true },
  branch:      { type: String, default: '' },
  account:     { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },  // deposited to / drawn from
  accountName: { type: String, default: '' },
  reference:   { type: String, default: '' },   // invoice / purchase no
  status:      { type: String, enum: ['pending','deposited','cleared','bounced','cancelled','returned'], default: 'pending' },
  depositedDate:{ type: Date },
  clearedDate: { type: Date },
  notes:       { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Cheque', chequeSchema);
