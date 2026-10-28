const router     = require('express').Router();
const mongoose = require('mongoose');
const jwt        = require('jsonwebtoken');
const User       = require('../models/User');
const { requireAuth, requireRole, requirePermission, effectivePermissions, JWT_SECRET, ROLE_PRESETS } = require('../middleware/auth');
// The signed-in user plus what they can actually use (the screen hides everything else)
const withAccess = u => ({ ...(u.toJSON ? u.toJSON() : u), effectivePermissions: effectivePermissions(u) });

// Seed default admin on first run
async function seedAdmin() {
  const count = await User.countDocuments();
  if (count > 0) return;
  await User.create({ name: 'Administrator', username: 'admin', password: 'admin123', role: 'admin' });
  console.log('✅ Default admin created — username: admin  password: admin123');
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    await seedAdmin();
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = await User.findOne({ username: username.toLowerCase().trim() });
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    user.lastLogin = new Date();
    await user.save();
    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, user: withAccess(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/me  — verify token and return current user
router.get('/me', requireAuth, (req, res) => res.json(withAccess(req.user)));

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
    user.password = newPassword;
    await user.save();
    res.json({ message: 'Password changed successfully' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── User management (admin only) ─────────────────────────────────────────────

// GET all users
router.get('/users', requireAuth, requirePermission('userManagement'), async (req, res) => {
  try { res.json((await User.find().sort({ createdAt: 1 })).map(withAccess)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create user
router.post('/users', requireAuth, requirePermission('userManagement'), async (req, res) => {
  try {
    if (!req.body.password || req.body.password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    // Set permissions from role preset if not provided
    if (!req.body.permissions) {
      req.body.permissions = ROLE_PRESETS[req.body.role] || ROLE_PRESETS.cashier;
    }
    req.body.username = cleanUsername(req.body.username);
    const ue = usernameError(req.body.username);
    if (ue) return res.status(400).json({ error: ue });
    if (await User.exists({ username: req.body.username })) return res.status(400).json({ error: `Username "${req.body.username}" is already taken` });
    if (req.body.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can create an admin' });
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user.toJSON());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

const cleanUsername = u => String(u || '').toLowerCase().trim();
const usernameError = u => (!u ? 'Username is required' : /\s/.test(u) ? 'Username cannot contain spaces' : null);
const otherActiveAdmins = id => User.countDocuments({ role: 'admin', active: true, _id: { $ne: id } });

// PUT update user (userManagement can change username/role/active/permissions; users can change their own name)
router.put('/users/:id', requireAuth, async (req, res) => {
  try {
    const isOwnAccount = req.user._id.toString() === req.params.id;
    const isAdmin = req.user.role === 'admin';
    const canManage = effectivePermissions(req.user).userManagement === true;
    if (!canManage && !isOwnAccount) return res.status(403).json({ error: 'Access denied' });
    // Non-managers cannot change username/roles/active/permissions
    if (!canManage) { delete req.body.username; delete req.body.role; delete req.body.active; delete req.body.permissions; }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    // Only an admin can edit an admin or make someone an admin
    if (!isAdmin && (user.role === 'admin' || req.body.role === 'admin')) return res.status(403).json({ error: 'Only an admin can change admin users' });
    if (isOwnAccount && (req.body.active === false || (req.body.role && req.body.role !== user.role)))
      return res.status(400).json({ error: 'You can\'t disable your own account or change your own role' });
    const losesAdmin = user.role === 'admin' && user.active && (req.body.active === false || (req.body.role && req.body.role !== 'admin'));
    if (losesAdmin && !(await otherActiveAdmins(user._id))) return res.status(400).json({ error: 'There must be at least one active admin' });

    if (req.body.name)     user.name     = req.body.name;
    if (req.body.username !== undefined && canManage) {
      const u = cleanUsername(req.body.username);
      const ue = usernameError(u);
      if (ue) return res.status(400).json({ error: ue });
      if (u !== user.username && await User.exists({ username: u, _id: { $ne: user._id } }))
        return res.status(400).json({ error: `Username "${u}" is already taken` });
      user.username = u;
    }
    if (req.body.role  && canManage)    user.role     = req.body.role;
    if (req.body.active !== undefined && canManage) user.active = req.body.active;
    if (req.body.permissions !== undefined && canManage) {
      user.permissions = req.body.permissions;
      user.markModified('permissions');
    }
    if (req.body.newPassword) {
      if (req.body.newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
      user.password = req.body.newPassword;
    }
    await user.save();
    res.json(user.toJSON());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE user permanently (to keep their history but block sign-in, disable instead)
router.delete('/users/:id', requireAuth, requirePermission('userManagement'), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
    if (req.user._id.toString() === req.params.id)
      return res.status(400).json({ error: 'You can\'t delete your own account' });
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can delete an admin' });
    if (user.role === 'admin' && user.active && !(await otherActiveAdmins(user._id)))
      return res.status(400).json({ error: 'There must be at least one active admin' });
    await user.deleteOne();
    res.json({ message: 'User deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
