const mongoose = require('mongoose');

// Singleton document — only one Settings row ever exists (fixed _id string 'global')
const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'global' },
  // ── IRD Gazette Extraordinary No. 2463/05 invoice numbering (optional, off by default) ──
  irdNumberingEnabled: { type: Boolean, default: false },
  irdBranchCode:       { type: String, default: '', trim: true, uppercase: true },
  // ── Company / Supplier details ──
  companyName: { type: String, default: '' },
  tin:         { type: String, default: '' },
  vrn:         { type: String, default: '' },
  phone:       { type: String, default: '' },
  fax:         { type: String, default: '' },
  email:       { type: String, default: '' },
  address:     { type: String, default: '' },
  website:     { type: String, default: '' },
  footer:      { type: String, default: '' },
  logoData:    { type: String, default: '' } // base64 data-URI, small logos only
}, { timestamps: true });

settingsSchema.statics.getSingleton = async function() {
  let doc = await this.findById('global');
  if (!doc) doc = await this.create({ _id: 'global' });
  return doc;
};

module.exports = mongoose.model('Settings', settingsSchema);
