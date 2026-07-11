const router   = require('express').Router();
const Settings = require('../models/Settings');
const Counter  = require('../models/Counter');
const { buildIrdNumber } = require('../utils/irdNumbering');

// GET current settings + a live preview of the next invoice number (does not consume a serial)
// Optional ?branchCode=XXX lets the frontend preview an unsaved edit before clicking Save.
router.get('/', async (req, res) => {
  try {
    const settings = await Settings.getSingleton();
    const previewBranch = req.query.branchCode !== undefined
      ? (req.query.branchCode || '').toUpperCase().replace(/\s+/g, '')
      : settings.irdBranchCode;
    let preview = '';
    if ((req.query.branchCode !== undefined ? true : settings.irdNumberingEnabled) && previewBranch) {
      const counterDoc = await Counter.findById(`ird:${previewBranch}`);
      const nextSerial = (counterDoc?.seq || 0) + 1;
      preview = buildIrdNumber(new Date(), previewBranch, String(nextSerial).padStart(5, '0'));
    }
    res.json({ ...settings.toObject(), preview });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update settings — accepts IRD fields and/or company fields independently
router.put('/', async (req, res) => {
  try {
    const update = {};

    // IRD settings (only touched when explicitly sent)
    if (req.body.irdNumberingEnabled !== undefined || req.body.irdBranchCode !== undefined) {
      const { irdNumberingEnabled, irdBranchCode } = req.body;
      const clean = (irdBranchCode || '').toUpperCase().replace(/\s+/g, '');
      if (/\s/.test(irdBranchCode || '')) {
        return res.status(400).json({ error: 'Branch code cannot contain spaces.' });
      }
      const sample = buildIrdNumber(new Date(), clean, '00000');
      if (sample.length > 40) {
        return res.status(400).json({ error: `Branch code too long — resulting invoice number would exceed 40 characters (got ${sample.length}, max 40).` });
      }
      update.irdNumberingEnabled = !!irdNumberingEnabled;
      update.irdBranchCode = clean;
    }

    // Company fields (only update fields present in body)
    if (req.body.logoData !== undefined && req.body.logoData.length > 1400000) {
      return res.status(400).json({ error: 'Logo image is too large. Maximum size is 1 MB.' });
    }
    for (const f of ['companyName','tin','vrn','phone','fax','email','address','website','footer','logoData']) {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    }
    if (req.body.invoiceLayout !== undefined) update.invoiceLayout = req.body.invoiceLayout;

    const settings = await Settings.findByIdAndUpdate('global', update, { new: true, upsert: true });

    // Include next-invoice-number preview (same as GET handler, for IRD settings page)
    const previewBranch = settings.irdBranchCode;
    let preview = '';
    if (settings.irdNumberingEnabled && previewBranch) {
      const counterDoc = await Counter.findById(`ird:${previewBranch}`);
      const nextSerial = (counterDoc?.seq || 0) + 1;
      preview = buildIrdNumber(new Date(), previewBranch, String(nextSerial).padStart(5, '0'));
    }
    res.json({ ...settings.toObject(), preview });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
