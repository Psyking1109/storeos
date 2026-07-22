require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
//const compression = require('compression');
const path     = require('path');
const fs       = require('fs');
const { requireAuth, requireRole, requirePermission } = require('./middleware/auth');

const app = express();
app.use(cors());
//app.use(compression()); // gzip all responses — index.html/app.js and JSON API payloads were being sent uncompressed
app.use(express.json({ limit: '10mb' }));

// Strip empty string ObjectId fields from all POST/PUT bodies
const { sanitizeBody } = require('./middleware/sanitize');
app.use(sanitizeBody);

// Serve static files from client folder (cache immutable assets, but never cache index.html itself —
// it's the SPA shell and must always be revalidated so users get the latest app.js reference)
app.use(express.static(path.join(__dirname, 'client'), {
  index: false,
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// Serve Vue from node_modules at /vue.min.js
const vuePath = path.join(__dirname, 'node_modules/vue/dist/vue.global.prod.js');
if (fs.existsSync(vuePath)) {
  app.get('/vue.min.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(vuePath);
  });
  console.log('✅ Vue 3 served from node_modules');
} else {
  console.warn('⚠️  Vue not found in node_modules — run: npm install');
}

// MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/storeapp';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB:', err.message));

// Seed default admin on first run
async function seedAdmin() {
  try {
    const User   = require('./models/User');
    const bcrypt = require('bcryptjs');
    if ((await User.countDocuments()) === 0) {
      await User.create({
        name: 'Administrator',
        username: 'admin',
        password: await bcrypt.hash('admin123', 10),
        role: 'admin',
        active: true
      });
      console.log('✅ Default admin created: admin / admin123');
    }
  } catch(e) { console.error('Seed error:', e.message); }
}
seedAdmin();

// API Routes — public
app.use('/api/auth', require('./routes/auth'));

// API Routes — authenticated (products/categories/tax/customers shared internally, no extra gate)
app.use('/api/categories',     requireAuth, require('./routes/categories'));
app.use('/api/products',       requireAuth, require('./routes/products'));
app.use('/api/customers',      requireAuth, require('./routes/customers'));
app.use('/api/tax',            requireAuth, require('./routes/tax'));
app.use('/api/locations',      requireAuth, require('./routes/locations'));
app.use('/api/invoice-types',  requireAuth, require('./routes/invoicetypes'));
app.use('/api/cash-accounts',  requireAuth, require('./routes/cashaccounts'));
app.use('/api/cash',           requireAuth, require('./routes/cash'));
app.use('/api/dashboard',      requireAuth, require('./routes/dashboard'));
app.use('/api/settings',       requireAuth, require('./routes/settings'));

// Permission-gated routes
app.use('/api/invoices',        requireAuth, requirePermission('invoices'),       require('./routes/invoices'));
app.use('/api/expenses',        requireAuth, requirePermission('expenses'),       require('./routes/expenses'));
app.use('/api/purchases',       requireAuth, requirePermission('purchases'),      require('./routes/purchases'));
app.use('/api/suppliers',       requireAuth, requirePermission('suppliers'),      require('./routes/suppliers'));
app.use('/api/banking',         requireAuth, requirePermission('banking'),        require('./routes/banking'));
app.use('/api/cheques',         requireAuth, requirePermission('cheques'),        require('./routes/cheques'));
app.use('/api/ledger',          requireAuth, requirePermission('ledger'),         require('./routes/ledger'));
app.use('/api/ledger-accounts', requireAuth, requirePermission('chartOfAccounts'), require('./routes/ledgeraccounts'));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 StoreOS running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
