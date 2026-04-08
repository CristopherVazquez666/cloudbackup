require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const { DB_PATH, getDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

getDb();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/user', express.static(path.join(__dirname, 'public/user')));

app.use('/api/auth', require('./api/routes/auth'));
app.use('/api/accounts', require('./api/routes/accounts'));
app.use('/api/backups', require('./api/routes/backups'));
app.use('/api/jobs', require('./api/routes/jobs'));
app.use('/api/agent', require('./api/routes/agent'));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '2.0.0',
  dbPath: DB_PATH
}));

app.get('/', (req, res) => res.redirect('/admin'));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Bovedix running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`User:  http://localhost:${PORT}/user`);
});
