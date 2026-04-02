const express = require('express');
const router = express.Router();
const { generateToken } = require('../../middleware/auth');

// Admin login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USER &&
    password === process.env.ADMIN_PASS
  ) {
    const token = generateToken({ username, role: 'admin' });
    return res.json({ token, role: 'admin' });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

// SSO endpoint — cPanel calls this with cpanel_user to get a user token
router.post('/sso', (req, res) => {
  const { cpanel_user, domain } = req.body;
  if (!cpanel_user) return res.status(400).json({ error: 'cpanel_user required' });
  const token = generateToken({ cpanel_user, domain, role: 'user' });
  const url = `/user?token=${token}`;
  return res.json({ token, redirect: url });
});

module.exports = router;
