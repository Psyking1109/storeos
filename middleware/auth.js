const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'storeos-secret-change-in-production';

// Default permissions per role — used as fallback for users with no permissions set
const ROLE_PRESETS = {
  admin: {
    dashboard:true,invoices:true,customers:true,purchases:true,suppliers:true,
    inventory:true,cashAccounts:true,expenses:true,banking:true,cheques:true,
    ledger:true,chartOfAccounts:true,trialBalance:true,dailyReport:true,
    taxReport:true,monthlyTax:true,invoiceSettings:true,locations:true,
    taxRates:true,userManagement:true,canDeleteRecords:true,canEditPastEntries:true
  },
  manager: {
    dashboard:true,invoices:true,customers:true,purchases:true,suppliers:true,
    inventory:true,cashAccounts:true,expenses:true,banking:true,cheques:true,
    ledger:true,chartOfAccounts:true,trialBalance:true,dailyReport:true,
    taxReport:true,monthlyTax:true,invoiceSettings:true,locations:true,
    taxRates:true,userManagement:false,canDeleteRecords:false,canEditPastEntries:false
  },
  cashier: {
    dashboard:true,invoices:true,customers:true,purchases:false,suppliers:false,
    inventory:true,cashAccounts:true,expenses:true,banking:false,cheques:false,
    ledger:false,chartOfAccounts:false,trialBalance:false,dailyReport:false,
    taxReport:false,monthlyTax:false,invoiceSettings:false,locations:false,
    taxRates:false,userManagement:false,canDeleteRecords:false,canEditPastEntries:false
  },
  viewer: {
    dashboard:true,invoices:false,customers:false,purchases:false,suppliers:false,
    inventory:true,cashAccounts:false,expenses:false,banking:false,cheques:false,
    ledger:false,chartOfAccounts:false,trialBalance:false,dailyReport:false,
    taxReport:false,monthlyTax:false,invoiceSettings:false,locations:false,
    taxRates:false,userManagement:false,canDeleteRecords:false,canEditPastEntries:false
  }
};

// Returns true if the user's permissions object has at least one key explicitly set
function hasCustomPermissions(perms) {
  if (!perms) return false;
  const obj = perms.toObject ? perms.toObject() : perms;
  return Object.values(obj).some(v => v !== undefined && v !== null);
}

// Verify token and attach user to request
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid or expired session' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role-based guard factory (kept for backward compatibility)
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: `Access denied. Required role: ${allowed.join(' or ')}` });
    }
    next();
  };
}

// Permission-based guard factory
// Admins always pass; non-admins must have the permission explicitly set (or inherit from role preset)
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.user.role === 'admin') return next();
    const perms = req.user.permissions;
    const effective = hasCustomPermissions(perms)
      ? (perms.toObject ? perms.toObject() : perms)
      : (ROLE_PRESETS[req.user.role] || ROLE_PRESETS.viewer);
    if (effective[key] === true) return next();
    return res.status(403).json({ error: 'Permission denied' });
  };
}

module.exports = { requireAuth, requireRole, requirePermission, JWT_SECRET, ROLE_PRESETS };
