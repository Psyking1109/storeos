const mongoose = require('mongoose');

// Singleton document — only one Settings row ever exists (fixed _id string 'global')
const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  // ── IRD Gazette Extraordinary No. 2463/05 invoice numbering (optional, off by default) ──
  irdNumberingEnabled: { type: Boolean, default: false },
  irdBranchCode:       { type: String, default: '', trim: true, uppercase: true } // the QQQQ segment, free text set by the user
}, { timestamps: true });

settingsSchema.statics.getSingleton = async function() {
  let doc = await this.findById('global');
  if (!doc) doc = await this.create({ _id: 'global' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
