const router     = require('express').Router();
const mongoose = require('mongoose');
const jwt        = require('jsonwebtoken');
const User       = require('../models/User');
const { requireAuth, requireRole, JWT_SECRET } = require('../middleware/auth');

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
    res.json({ token, user: user.toJSON() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/me  — verify token and return current user
router.get('/me', requireAuth, (req, res) => res.json(req.user));

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
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try { res.json(await User.find().sort({ createdAt: 1 })); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create user
router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (!req.body.password || req.body.password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const user = new User(req.body);
    await user.save();
    res.status(201).json(user.toJSON());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT update user (admin can update role/active; users can update own name)
router.put('/users/:id', requireAuth, async (req, res) => {
  try {
    const isOwnAccount = req.user._id.toString() === req.params.id;
    const isAdmin = req.user.role === 'admin';
    if (!isAdmin && !isOwnAccount) return res.status(403).json({ error: 'Access denied' });
    // Non-admins cannot change roles
    if (!isAdmin) { delete req.body.role; delete req.body.active; }
    // Handle password change via this endpoint
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (req.body.name)     user.name     = req.body.name;
    if (req.body.username && isAdmin) user.username = req.body.username;
    if (req.body.role  && isAdmin)    user.role     = req.body.role;
    if (req.body.active !== undefined && isAdmin) user.active = req.body.active;
    if (req.body.newPassword) {
      if (req.body.newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });
      user.password = req.body.newPassword;
    }
    await user.save();
    res.json(user.toJSON());
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE user (admin only, cannot delete self)
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    if (req.user._id.toString() === req.params.id)
      return res.status(400).json({ error: 'Cannot delete your own account' });
    await User.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ message: 'User deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
