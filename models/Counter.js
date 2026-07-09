const mongoose = require('mongoose');

// Generic atomic counter — used for IRD numbering serials (keyed per branch code)
// and for Booking/Proforma sequential numbers, so concurrent invoice creation
// never produces duplicate or skipped numbers.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. 'ird:HQ01', 'booking', 'proforma'
  seq: { type: Number, default: 0 }
});

counterSchema.statics.next = async function(key) {
  const doc = await this.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

module.exports = mongoose.model('Counter', counterSchema);
