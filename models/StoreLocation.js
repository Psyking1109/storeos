const mongoose = require('mongoose');
// Warehouse / store locations for inventory
const storeLocationSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true, unique: true },
  code:        { type: String, default: '', trim: true },
  description: { type: String, default: '' },
  active:      { type: Boolean, default: true }
}, { timestamps: true });
module.exports = mongoose.model('StoreLocation', storeLocationSchema);
