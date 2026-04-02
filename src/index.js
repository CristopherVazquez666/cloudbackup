require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

// Static files
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/user', express.static(path.join(__dirname, 'public/user')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));

// API Routes
app.use('/api/auth', require('./api/routes/auth'));
app.use('/api/accounts', require('./api/routes/accounts'));
app.use('/api/backups', require('./api/routes/backups'));
app.use('/api/jobs', require('./api/routes/jobs'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// Root redirect
app.get('/', (req, res) => res.redirect('/admin'));

app.listen(PORT, () => {
  console.log(`Bovedix running on port ${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`User:  http://localhost:${PORT}/user`);
});
