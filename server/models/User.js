const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// Roles and what they can access:
// admin    — everything, user management, settings
// manager  — sales, purchases, inventory, reports, tax, accounts (no user mgmt)
// cashier  — invoices, cash book, inventory, customers only (no purchases, no reports)
// viewer   — dashboard + inventory read-only only

const userSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  role:     { type: String, enum: ['admin','manager','cashier','viewer'], default: 'cashier' },
  active:   { type: Boolean, default: true },
  lastLogin:{ type: Date }
}, { timestamps: true });

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};

// Strip password from JSON output
userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', userSchema);
