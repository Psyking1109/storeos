const mongoose = require('mongoose');

const locationStockSchema = new mongoose.Schema({
  location:     { type: mongoose.Schema.Types.ObjectId, ref: 'StoreLocation', required: true },
  locationName: { type: String, default: '' },
  stock:        { type: Number, default: 0 },  // stock in BASE units (bags)
  looseStock:   { type: Number, default: 0 },  // stock in LOOSE units (kg)
}, { _id: false });

const productSchema = new mongoose.Schema({
  name:             { type: String, required: true, trim: true },
  sku:              { type: String, unique: true, sparse: true, trim: true },
  category:         { type: String, default: 'General', trim: true },
  unit:             { type: String, default: 'pcs' },       // base unit e.g. "bag"

  // Loose selling config
  allowLoose:       { type: Boolean, default: false },
  looseUnit:        { type: String, default: '' },          // e.g. "kg"
  looseConversion:  { type: Number, default: 1 },           // loose units per base unit (e.g. 25 kg/bag)

  // Prices
  costPrice:        { type: Number, default: 0 },
  sellingPrice:     { type: Number, default: 0 },           // price per BASE unit
  looseSellingPrice:{ type: Number, default: 0 },           // price per LOOSE unit

  // Stock in BASE units + loose remainder
  stock:            { type: Number, default: 0 },           // e.g. 20 bags
  looseStock:       { type: Number, default: 0 },           // e.g. 5 kg loose (partial bag)
  locationStock:    [locationStockSchema],
  minStock:         { type: Number, default: 0 },
  defaultTaxCodes:  [{ type: String }],
  description:      { type: String, default: '' },
  active:           { type: Boolean, default: true }
}, { timestamps: true });

productSchema.index({ name: 1 });
productSchema.index({ category: 1, active: 1 });

// Calculate looseSellingPrice if not set
productSchema.pre('save', function(next) {
  if (this.allowLoose && this.looseConversion > 0 && !this.looseSellingPrice && this.sellingPrice) {
    this.looseSellingPrice = this.sellingPrice / this.looseConversion;
  }
  next();
});

module.exports = mongoose.model('Product', productSchema);
