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

// PUT update settings (toggle + branch code)
router.put('/', async (req, res) => {
  try {
    const { irdNumberingEnabled, irdBranchCode } = req.body;
    const clean = (irdBranchCode || '').toUpperCase().replace(/\s+/g, '');
    if (/\s/.test(irdBranchCode || '')) {
      return res.status(400).json({ error: 'Branch code cannot contain spaces.' });
    }
    // Validate total format length (YYMMM_QQQQ_XXXXX) stays under 40 chars even with a 5-digit serial
    const sample = buildIrdNumber(new Date(), clean, '00000');
    if (sample.length > 40) {
      return res.status(400).json({ error: `Branch code too long — resulting invoice number would exceed 40 characters (got ${sample.length}, max 40).` });
    }
    const settings = await Settings.findByIdAndUpdate(
      'global',
      { irdNumberingEnabled: !!irdNumberingEnabled, irdBranchCode: clean },
      { new: true, upsert: true }
    );
    res.json(settings);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
