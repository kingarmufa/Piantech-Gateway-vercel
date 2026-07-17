require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { put, del } = require('@vercel/blob');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ===================== HELPER UPLOAD (Vercel Blob / Local Disk) =====================
// Di Vercel, filesystem read-only saat runtime (kecuali /tmp yang tidak persist),
// jadi file upload (foto profil, gambar chat) disimpan ke Vercel Blob.
// Di lokal (tanpa BLOB_READ_WRITE_TOKEN), fallback ke disk seperti biasa supaya tetap bisa dev tanpa setup Blob.
const USE_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;

async function saveUploadedFile(file, folder, filenamePrefix) {
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = `${filenamePrefix}${crypto.randomBytes(4).toString('hex')}${ext}`;

  if (USE_BLOB) {
    const blob = await put(`${folder}/${filename}`, file.buffer, {
      access: 'public',
      addRandomSuffix: false
    });
    return blob.url; // URL absolut (https://...blob.vercel-storage.com/...)
  }

  // Fallback lokal (dev tanpa Vercel Blob)
  const dir = path.join(__dirname, 'public', folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  return `/${folder}/${filename}`;
}

async function deleteUploadedFile(urlOrPath) {
  if (!urlOrPath) return;
  try {
    if (/^https?:\/\//i.test(urlOrPath)) {
      if (USE_BLOB) await del(urlOrPath);
    } else {
      const fullPath = path.join(__dirname, 'public', urlOrPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  } catch (err) {
    console.error('Gagal menghapus file upload:', err.message);
  }
}

// ===================== CUSTOM ID PREFIX =====================
const startId = {
  apikey: 'INF',
  invoice: 'INV',
  withdraw: 'WD',
  transaction: 'TRX'
};

// ===================== MIDDLEWARE DASAR =====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  // MongoStore dipakai (bukan MemoryStore) karena di Vercel setiap request bisa
  // dilayani instance serverless yang berbeda-beda -> in-memory session akan hilang/logout terus.
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    ttl: 24 * 60 * 60
  }),
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===================== SETUP LIMITER =====================
const Limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  handler: (req, res) => {
    req.session.errorMsg = 'Terlalu banyak percobaan login. Silakan coba lagi setelah 5 menit.';
    res.redirect('/login');
  }
});

// ===================== MONGODB =====================
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB terhubung');
    await seed();
  })
  .catch(err => console.error('❌ MongoDB gagal:', err));

// ===================== CUSTOM ID GENERATOR =====================
function generateCustomId(prefix) {
  const len = 10 - prefix.length;
  const randomHex = crypto.randomBytes(Math.ceil(len / 2)).toString('hex').substring(0, len);
  return prefix + randomHex;
}

function generateApiKey() {
  return startId.apikey + '_' + crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// ===================== MODELS =====================
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    validate: {
      validator: function(v) { return /^[a-zA-Z0-9]+$/.test(v); },
      message: 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)'
    },
    maxlength: [15, 'Username maksimal 15 karakter']
  },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 },
  role: { type: String, default: 'user', enum: ['user', 'admin'] },
  suspended: { type: Boolean, default: false },
  ewallet: { type: String, default: '' },
  accountNumber: { type: String, default: '' },
  accountName: { type: String, default: '' },
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  profileColor: { type: String, default: null },
  profilePicture: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const invoiceSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateCustomId(startId.invoice) },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount: Number,
  fee: Number,
  total: Number,
  trxid: String,
  qris_image: String,
  mutationId: { type: String, default: null },
  expiredAt: Date,
  status: { type: String, default: 'pending', enum: ['pending', 'paid', 'expired'] },
  createdAt: { type: Date, default: Date.now }
});
const Invoice = mongoose.model('Invoice', invoiceSchema);

const transactionSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateCustomId(startId.transaction) },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['deposit', 'withdraw'] },
  amount: Number,
  fee: Number,
  qris_image: String,
  status: String,
  reference: String,
  expiredAt: Date,
  createdAt: { type: Date, default: Date.now },
  adminNote: String,
  completedAt: Date,
  method: String,
  accountNumber: String,
  accountName: String
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const withdrawSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateCustomId(startId.withdraw) },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  amount: Number,
  fee: Number,
  method: String,
  accountNumber: String,
  accountName: String,
  status: { type: String, default: 'pending', enum: ['pending', 'success', 'rejected'] },
  adminNote: String,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawSchema);

const apiKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  key: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now }
});
const ApiKey = mongoose.model('ApiKey', apiKeySchema);

const settingSchema = new mongoose.Schema({
  name: { type: String, default: 'InfernoX Gateway' },
  title: { type: String, default: 'Layanan Payment Gateway' },
  description: { type: String, default: 'Terima pembayaran melalui QRIS Payment untuk Aplikasi atau Platform Bisnis kamu dengan mudah, cepat, dan aman.' },
  channelWhatsApp: { type: String, default: 'https://whatsapp.com/channel/0029VbCTqG7Fsn0fJzxg1B1H' },
  minDeposit: { type: Number, default: 1000 },
  minWithdraw: { type: Number, default: 5000 },
  feeWithdraw: { type: Number, default: 1000 },
  maxFee: { type: Number, default: 500 },
  checkInterval: { type: Number, default: 30 },
  qrisExpiredMinutes: { type: Number, default: 30 },
  smtpUser: { type: String, default: '' },
  smtpPass: { type: String, default: '' },
  logoUrl: { type: String, default: 'https://img2.pixhost.to/images/8187/731158188_skyzo.png' },
  // === GOPAY MERCHANT ===
  gopayDomain: { type: String, default: 'gomerch.vercel.app' },
  gopayToken: { type: String, default: '' },
  gopayStaticQr: { type: String, default: '' },
  gopayRefreshToken: { type: String, default: '' },
  // =====================
  withdrawMethods: {
    type: [
      {
        name: { type: String, required: true },
        fee: { type: Number, required: true, default: 1000 }
      }
    ],
    default: [
      { name: 'Dana', fee: 500 },
      { name: 'GoPay', fee: 900 }
    ]
  }
});
const Setting = mongoose.model('Setting', settingSchema);

const statsSchema = new mongoose.Schema({
  totalDepositAmount: { type: Number, default: 0 },
  totalDepositFee: { type: Number, default: 0 },
  totalWithdrawAmount: { type: Number, default: 0 },
  totalWithdrawFee: { type: Number, default: 0 },
  totalUsers: { type: Number, default: 0 },
  totalTransactions: { type: Number, default: 0 }
});
const Stats = mongoose.model('Stats', statsSchema);

const notificationSchema = new mongoose.Schema({
  title: { type: String, default: '' },
  message: { type: String, required: true },
  target: { type: String, default: 'all' }
}, { timestamps: true });
const Notification = mongoose.model('Notification', notificationSchema);

const chatMessageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  username: String,
  message: { type: String, default: '' },
  image: { type: String, default: null },
  role: { type: String, enum: ['user', 'admin'] },
  profilePicture: { type: String, default: null },
  profileColor: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  replyTo: { type: Object }
});
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

// ===================== UPLOAD CONFIGURATIONS =====================
// multer pakai memoryStorage (buffer di RAM), karena file lalu di-upload ke Vercel Blob
// (atau ditulis ke disk sebagai fallback dev) lewat saveUploadedFile(), bukan langsung ke disk di sini.
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Hanya file gambar yang diizinkan'));
    }
    cb(null, true);
  }
});

const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Hanya file gambar yang diizinkan'), false);
    }
    cb(null, true);
  }
});

// ===================== ANTI-DUPLICATE HELPER =====================
async function createWithRetry(Model, data, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await Model.create(data);
    } catch (err) {
      if (err.code === 11000 && attempt < maxRetries - 1) {
        if (Model === Invoice) data._id = generateCustomId(startId.invoice);
        else if (Model === Transaction) data._id = generateCustomId(startId.transaction);
        else if (Model === Withdrawal) data._id = generateCustomId(startId.withdraw);
        else if (Model === ApiKey) data.key = generateApiKey();
        continue;
      }
      throw err;
    }
  }
  throw new Error('Gagal membuat dokumen setelah beberapa kali percobaan (duplicate ID)');
}

// ===================== HELPERS =====================
async function getSettings() {
  let s = await Setting.findOne();
  if (!s) s = await Setting.create({});
  return s;
}

async function getStats() {
  const [depositAgg, withdrawAgg, totalUsers, totalTrx] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'deposit', status: 'paid' } },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }
    ]),
    Transaction.aggregate([
      { $match: { type: 'withdraw', status: 'success' } },
      { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }
    ]),
    User.countDocuments({ role: 'user' }),
    Transaction.countDocuments()
  ]);

  const dAmount = depositAgg[0]?.totalAmount || 0;
  const dFee = depositAgg[0]?.totalFee || 0;
  const wAmount = withdrawAgg[0]?.totalAmount || 0;
  const wFee = withdrawAgg[0]?.totalFee || 0;

  await Stats.findOneAndUpdate({}, {
    totalDepositAmount: dAmount,
    totalDepositFee: dFee,
    totalWithdrawAmount: wAmount,
    totalWithdrawFee: wFee,
    totalUsers,
    totalTransactions: totalTrx
  }, { upsert: true });

  return {
    totalDepositAmount: dAmount,
    totalDepositFee: dFee,
    totalWithdrawAmount: wAmount,
    totalWithdrawFee: wFee,
    totalUsers,
    totalTransactions: totalTrx
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex') === hash;
}

// ===================== GOPAY TOKEN REFRESH & RETRY =====================
let refreshingPromise = null;

async function refreshGopayToken() {
  const settings = await getSettings();
  if (!settings.gopayRefreshToken) {
    throw new Error('Refresh token tidak tersedia. Harap isi di pengaturan admin.');
  }

  const gopayBase = settings.gopayDomain || 'gomerch.vercel.app';
  const refreshUrl = `https://${gopayBase}/auth/refresh/token?refresh_token=${encodeURIComponent(settings.gopayRefreshToken)}`;

  try {
    const resp = await axios.get(refreshUrl);
    let data = resp.data?.data || null

    if (!data) {
      throw new Error(data.error || 'Gagal refresh token');
    }

    const newToken = data.access_token;
    const newRefreshToken = data.refresh_token;

    const updateFields = { gopayToken: newToken };
    if (newRefreshToken) {
      updateFields.gopayRefreshToken = newRefreshToken;
    }

    await Setting.updateOne({}, updateFields);
    console.log('✅ Gopay token berhasil diperbarui');
    return newToken;
  } catch (err) {
    console.error('❌ Gagal refresh Gopay token:', err.response?.data || err.message);
    throw new Error('Gagal memperbarui token Gopay. Refresh token mungkin sudah kadaluarsa.');
  }
}

async function callGopayApiWithRetry(url, options = {}, maxRetries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios({ url, ...options });
      return response.data;
    } catch (err) {
      const isTokenError =
        (err.response && err.response.status === 401) ||
        (err.response?.data?.error);

      if (isTokenError && attempt < maxRetries) {
        console.log('🔄 Token expired, mencoba refresh...');
        if (!refreshingPromise) {
          refreshingPromise = refreshGopayToken().finally(() => {
            refreshingPromise = null;
          });
        }
        await refreshingPromise;

        const settings = await getSettings();
        if (url.includes('token=')) {
          url = url.replace(/token=[^&]*/, `token=${settings.gopayToken}`);
        }
        continue;
      }

      lastError = err;
      break;
    }
  }
  throw lastError;
}

// ===================== GLOBAL MIDDLEWARE =====================
const PROFILE_COLORS = ['#3b82f6','#10b981','#f43f5e','#8b5cf6','#f59e0b','#06b6d4','#6366f1','#ec4899'];

app.use(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    try {
      let user = await User.findById(req.session.userId);
      if (user) {
        if (!user.profileColor) {
          user.profileColor = PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)];
          await user.save();
        }
        res.locals.user = user.toObject();
      }
    } catch {}
  }
  res.locals.settings = await getSettings();
  res.locals.error = req.session.errorMsg || null;
  res.locals.success = req.session.successMsg || null;
  delete req.session.errorMsg;
  delete req.session.successMsg;

  if (req.session.userId) {
    try {
      const notifications = await Notification.find({
        $or: [
          { target: 'all' },
          { target: req.session.userId }
        ]
      }).sort({ createdAt: -1 }).lean();
      res.locals.notifications = notifications;
    } catch (err) {
      res.locals.notifications = [];
    }
  }

  next();
});

function isAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

function isAdmin(req, res, next) {
  if (req.session.userRole === 'admin') return next();
  res.redirect('/login');
}

// ===================== SEED =====================
async function seed() {
  const ex = await User.findOne({ role: "admin" });
  if (!ex) {
    await User.create({
      username: 'admin',
      email: 'admin@gmail.com',
      password: hashPassword('admin123'),
      role: 'admin',
      profileColor: PROFILE_COLORS[0]
    });
    console.log(`🔑 Admin Account Default\nUsername: admin\nPassword: admin123`);
  }

  const notifCount = await Notification.countDocuments();
  if (notifCount === 0) {
    await Notification.create({
      title: 'Selamat Datang!',
      message: 'Selamat datang di platform kami. Jangan lupa lengkapi profil dan verifikasi akun Anda agar dapat melakukan transaksi.',
      target: 'all'
    });
    console.log('📢 Notifikasi default dibuat.');
  }

  const settings = await getSettings();
  if (!settings.withdrawMethods || settings.withdrawMethods.length === 0) {
    settings.withdrawMethods = [
      { name: 'Dana', fee: 500 },
      { name: 'GoPay', fee: 900 }
    ];
    await settings.save();
  }
}

// ===================== ROUTES DASHBOARD / AUTH =====================
app.get('/', async (req, res) => {
  const stats = await getStats();
  res.render('home', { stats });
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('login');
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('register');
});

app.post('/login', Limiter, async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) {
    req.session.errorMsg = 'Harap isi semua field';
    return res.redirect('/login');
  }
  const isEmail = login.includes('@');
  let user;
  if (isEmail) {
    user = await User.findOne({ email: login.toLowerCase() });
    if (user && user.role === 'admin') {
      req.session.errorMsg = 'Admin hanya dapat login menggunakan username';
      return res.redirect('/login');
    }
  } else {
    user = await User.findOne({ username: login.toLowerCase() });
  }
  if (!user || !verifyPassword(password, user.password)) {
    req.session.errorMsg = 'Username/email atau kata sandi salah';
    return res.redirect('/login');
  }
  if (user.suspended) {
    req.session.errorMsg = 'Akun Anda dinonaktifkan';
    return res.redirect('/login');
  }
  req.session.userId = user._id;
  req.session.userRole = user.role;
  if (user.role === 'admin') return res.redirect('/admin/dashboard');
  res.redirect('/dashboard');
});

app.post('/register', Limiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || username.trim().length === 0) {
    req.session.errorMsg = 'Username tidak boleh kosong';
    return res.redirect('/register');
  }
  if (!/^[a-zA-Z0-9]+$/.test(username)) {
    req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
    return res.redirect('/register');
  }
  if (username.length > 15) {
    req.session.errorMsg = 'Username maksimal 15 karakter';
    return res.redirect('/register');
  }
  try {
    const randomColor = PROFILE_COLORS[Math.floor(Math.random() * PROFILE_COLORS.length)];
    const user = await User.create({
      username,
      email,
      password: hashPassword(password),
      profileColor: randomColor
    });
    await createWithRetry(ApiKey, { userId: user._id, key: generateApiKey() });
    req.session.userId = user._id;
    req.session.userRole = 'user';
    res.redirect('/dashboard');
  } catch (err) {
    if (err.code === 11000) {
      req.session.errorMsg = 'Username atau email sudah terdaftar';
    } else if (err.name === 'ValidationError') {
      req.session.errorMsg = Object.values(err.errors).map(e => e.message).join(', ');
    } else {
      req.session.errorMsg = 'Gagal mendaftar, periksa kembali data Anda';
    }
    res.redirect('/register');
  }
});

app.post('/check-availability', async (req, res) => {
  const { type, value } = req.body;
  if (!type || !value || !['username', 'email'].includes(type)) {
    return res.json({ available: false, message: 'Parameter tidak valid' });
  }
  if (type === 'username') {
    if (!/^[a-zA-Z0-9]{1,15}$/.test(value)) {
      return res.json({ available: false, message: 'Format username tidak valid (huruf/angka, maks 15 karakter)' });
    }
    const exists = await User.findOne({ username: value.toLowerCase() });
    return res.json({ available: !exists, message: exists ? 'Username sudah digunakan' : 'Username tersedia' });
  }
  if (type === 'email') {
    if (!/^\S+@\S+\.\S+$/.test(value)) {
      return res.json({ available: false, message: 'Format email tidak valid' });
    }
    const exists = await User.findOne({ email: value.toLowerCase() });
    return res.json({ available: !exists, message: exists ? 'Email sudah terdaftar' : 'Email tersedia' });
  }
});

app.get('/forgot-password', (req, res) => {
  if (req.session.userId) return res.redirect(req.session.userRole === 'admin' ? '/admin/dashboard' : '/dashboard');
  res.render('forgot_password');
});

app.post('/forgot-password', Limiter, async (req, res) => {
  const { login } = req.body;
  if (!login) {
    req.session.errorMsg = 'Harap masukkan email atau username Anda.';
    return res.redirect('/forgot-password');
  }
  try {
    const settings = await getSettings();
    if (!settings.smtpUser || !settings.smtpPass) {
      req.session.errorMsg = 'Fitur pengiriman email belum dikonfigurasi oleh Administrator.';
      return res.redirect('/forgot-password');
    }
    const isEmail = login.includes('@');
    let user;
    if (isEmail) {
      user = await User.findOne({ email: login.toLowerCase() });
    } else {
      user = await User.findOne({ username: login.toLowerCase() });
    }
    if (!user) {
      req.session.errorMsg = 'Akun tidak ditemukan di sistem kami.';
      return res.redirect('/forgot-password');
    }
    if (!user.email) {
      req.session.errorMsg = 'Akun ini tidak memiliki alamat email yang valid.';
      return res.redirect('/forgot-password');
    }
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 30 * 60 * 1000;
    await user.save();

    const resetLink = `http://${req.headers.host}/reset-password/${token}`;
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: settings.smtpUser,
        pass: settings.smtpPass
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });

    await transporter.sendMail({
      to: user.email,
      from: `"${settings.name}" <${settings.smtpUser}>`,
      subject: `Permintaan Reset Password - ${settings.name}`,
      text: `Halo ${user.username},\n\nKami menerima permintaan untuk mengatur ulang kata sandi akun Anda. Silakan salin tautan berikut ke browser Anda:\n${resetLink}\n\nTautan ini hanya berlaku 30 menit.\n\nJika Anda tidak meminta ini, abaikan email ini.`,
      html: `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f9fafb; padding: 40px 20px; margin: 0;">
          <div style="max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; border: 1px solid #f3f4f6; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
            <div style="height: 6px; background-color: #111827; width: 100%;"></div>
            <div style="padding: 40px;">
              <h2 style="color: #111827; font-size: 18px; font-weight: 600; margin-top: 0; margin-bottom: 16px; text-align: center;">
                Reset Password - ${settings.name}
              </h2>
              <p style="color: #4b5563; font-size: 15px; line-height: 1.6; margin-bottom: 24px;">
                Halo <strong style="color: #111827;">${user.username}</strong>,<br><br>
                Kami menerima permintaan untuk mengatur ulang kata sandi akun Anda di <strong>${settings.name}</strong>. Jika ini memang Anda, silakan klik tombol di bawah ini:
              </p>
              <div style="text-align: center; margin-bottom: 30px;">
                <a href="${resetLink}" style="display: inline-block; background-color: #111827; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                  Ganti Password Saya
                </a>
              </div>
              <p style="color: #dc2626; font-size: 13px; font-weight: 600; text-align: center; margin-bottom: 30px; background-color: #fef2f2; padding: 10px; border-radius: 8px;">
                Tautan ini hanya berlaku selama 30 menit.
              </p>
              <div style="border-top: 1px solid #e5e7eb; padding-top: 24px;">
                <p style="color: #6b7280; font-size: 13px; line-height: 1.5; margin: 0;">
                  Jika tombol di atas tidak berfungsi, salin dan tempel URL berikut ke browser Anda:<br>
                  <a href="${resetLink}" style="color: #2563eb; word-break: break-all;">${resetLink}</a>
                </p>
              </div>
            </div>
          </div>
          <div style="text-align: center; max-width: 500px; margin: 24px auto 0;">
            <p style="color: #9ca3af; font-size: 12px; line-height: 1.5; margin-bottom: 10px;">
              Jika Anda tidak merasa membuat permintaan ini, abaikan email ini dengan aman. Kata sandi Anda tidak akan berubah.
            </p>
            <p style="color: #d1d5db; font-size: 12px;">
              &copy; ${new Date().getFullYear()} ${settings.name}. All rights reserved.
            </p>
          </div>
        </div>
      `
    });

    req.session.successMsg = `Link reset password telah dikirim ke email Anda yang terdaftar.`;
    res.redirect('/forgot-password');
  } catch (error) {
    console.error('Error Forgot Password:', error);
    req.session.errorMsg = 'Gagal memproses email. Pastikan konfigurasi SMTP di Admin valid.';
    res.redirect('/forgot-password');
  }
});

app.get('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    if (!user) {
      req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa (berlaku 30 menit).';
      return res.redirect('/forgot-password');
    }
    res.render('reset_password', { token: req.params.token });
  } catch (error) {
    res.redirect('/login');
  }
});

app.post('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({
      resetPasswordToken: req.params.token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    if (!user) {
      req.session.errorMsg = 'Token reset password tidak valid atau sudah kedaluwarsa.';
      return res.redirect('/forgot-password');
    }
    const { password, confirmPassword } = req.body;
    if (password !== confirmPassword) {
      req.session.errorMsg = 'Password dan konfirmasi password tidak cocok.';
      return res.redirect(`/reset-password/${req.params.token}`);
    }
    user.password = hashPassword(password);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    req.session.successMsg = 'Password berhasil diubah. Silakan login dengan password baru.';
    res.redirect('/login');
  } catch (error) {
    req.session.errorMsg = 'Gagal mereset password.';
    res.redirect(`/reset-password/${req.params.token}`);
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// --- Dashboard User ---
app.get('/dashboard', isAuth, async (req, res) => {
  if (req.session.userRole === 'admin') return res.redirect('/admin/dashboard');
  const userId = req.session.userId;
  const user = res.locals.user;
  const totalDeposit = (await Transaction.aggregate([
    { $match: { userId: user._id, type: 'deposit', status: 'paid' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]))[0]?.total || 0;
  const totalWithdraw = (await Transaction.aggregate([
    { $match: { userId: user._id, type: 'withdraw', status: 'success' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]))[0]?.total || 0;
  const recentTrx = await Invoice.find({ userId: user._id }).sort({ createdAt: -1 }).lean();
  const apiKeys = await ApiKey.find({ userId }).lean();
  res.render('dashboard', { user, totalDeposit, totalWithdraw, recentTrx, apiKeys });
});

// --- Profile ---
app.get('/profile', isAuth, async (req, res) => {
  const userId = req.session.userId;
  const apiKeys = await ApiKey.find({ userId }).lean();
  res.render('profile', { apiKeys });
});

app.post('/profile', isAuth, async (req, res) => {
  const { email, newPassword, ewallet, accountNumber, accountName } = req.body;
  try {
    const upd = { email, ewallet, accountNumber, accountName };
    if (newPassword && newPassword.trim()) upd.password = hashPassword(newPassword);
    await User.findByIdAndUpdate(req.session.userId, upd);
    req.session.successMsg = 'Profil berhasil diperbarui';
    res.redirect('/profile');
  } catch (err) {
    if (err.code === 11000) {
      req.session.errorMsg = 'Email sudah digunakan oleh pengguna lain';
    } else {
      req.session.errorMsg = 'Gagal memperbarui profil';
    }
    res.redirect('/profile');
  }
});

app.post('/profile/upload', isAuth, profileUpload.single('profileImage'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File tidak ditemukan' });
  try {
    const imageUrl = await saveUploadedFile(req.file, 'profile', `profile-${req.session.userId}-`);
    const oldUser = await User.findByIdAndUpdate(req.session.userId, { profilePicture: imageUrl });
    if (oldUser && oldUser.profilePicture) {
      deleteUploadedFile(oldUser.profilePicture).catch(() => {});
    }
    res.json({ success: true, profilePicture: imageUrl });
  } catch (err) {
    console.error('Upload foto profil gagal:', err);
    res.status(500).json({ error: 'Gagal mengunggah foto profil' });
  }
});

app.post('/api/user/api-key/regenerate', isAuth, async (req, res) => {
  await ApiKey.deleteMany({ userId: req.session.userId });
  const key = generateApiKey();
  try {
    await createWithRetry(ApiKey, { userId: req.session.userId, key });
    res.json({ apiKey: key });
  } catch (err) {
    res.status(500).json({ error: 'Gagal membuat API key' });
  }
});

// --- Deposit ---
app.get('/deposit', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const deposits = await Transaction.find({
    userId: req.session.userId,
    type: 'deposit'
  }).sort({ createdAt: -1 }).lean();
  const invoices = await Invoice.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
  res.render('deposit', { deposits, invoices, minDeposit: settings.minDeposit });
});

async function createInvoiceForUser(userId, amount, settings) {
  if (!settings) settings = await getSettings();

  if (isNaN(amount) || amount < settings.minDeposit) {
    throw new Error(`Minimal deposit adalah Rp ${settings.minDeposit.toLocaleString('id-ID')}`);
  }

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const lockedInvoices = await Invoice.find({
    $or: [{ status: 'pending' }, { status: 'paid', createdAt: { $gte: oneDayAgo } }]
  }).select('fee');
  const usedFees = lockedInvoices.map(i => Number(i.fee)).filter(f => !isNaN(f));
  const availableFees = [];
  for (let i = 1; i <= settings.maxFee; i++) {
    if (!usedFees.includes(i)) availableFees.push(i);
  }
  if (availableFees.length === 0) {
    throw new Error('Kode unik deposit sedang penuh. Silakan coba lagi beberapa menit.');
  }
  const fee = availableFees[Math.floor(Math.random() * availableFees.length)];
  const total = amount + fee;

  const expiredMinutes = settings.qrisExpiredMinutes || 30;
  const expiredAt = new Date(Date.now() + expiredMinutes * 60 * 1000);

  const invoice = await createWithRetry(Invoice, {
    userId,
    amount,
    fee,
    total,
    trxid: null,
    qris_image: '',
    expiredAt,
    status: 'pending'
  });

  if (!settings.gopayToken || !settings.gopayStaticQr) {
    await Invoice.findByIdAndDelete(invoice._id);
    throw new Error('Konfigurasi Gopay Merchant belum lengkap. Hubungi admin.');
  }
  const gopayBase = settings.gopayDomain || 'gomerch.vercel.app';
  const apiUrl = `https://${gopayBase}/api/qris/create?amount=${total}&static_qr=${encodeURIComponent(settings.gopayStaticQr)}`;
  try {
    const data = await callGopayApiWithRetry(apiUrl);
    if (!data.success) {
      await Invoice.findByIdAndDelete(invoice._id);
      throw new Error('Gagal membuat QRIS via Gopay Merchant');
    }
    const qrisImage = data.image_url;
    const trxid = invoice._id;

    invoice.qris_image = qrisImage;
    invoice.trxid = trxid;
    await invoice.save();

    await createWithRetry(Transaction, {
      userId,
      type: 'deposit',
      amount,
      fee,
      status: 'pending',
      reference: invoice._id.toString(),
      qris_image: qrisImage,
      expiredAt
    });

    return invoice;
  } catch (e) {
    await Invoice.findByIdAndDelete(invoice._id);
    throw e;
  }
}

app.post('/invoice/create', isAuth, async (req, res) => {
  try {
    const amount = parseInt(req.body.amount);
    const settings = res.locals.settings;
    const invoice = await createInvoiceForUser(req.session.userId, amount, settings);
    return res.json({
      reference: invoice._id.toString(),
      amount: invoice.amount,
      fee: invoice.fee,
      total: invoice.total,
      qris_image: invoice.qris_image,
      createdAt: invoice.createdAt,
      expiredAt: invoice.expiredAt,
      status: 'pending'
    });
  } catch (e) {
    console.error('Create invoice error:', e.message);
    return res.status(400).json({ error: e.message });
  }
});

// ===================== WITHDRAW =====================
app.get('/withdraw', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const withdrawals = await Withdrawal.find({ userId: req.session.userId }).sort({ createdAt: -1 }).lean();
  res.render('withdraw', {
    settings,
    withdrawals,
    withdrawMethods: settings.withdrawMethods || []
  });
});

app.post('/withdraw/request', isAuth, async (req, res) => {
  const settings = res.locals.settings;
  const { amount, methodName, accountNumber, accountName } = req.body;

  if (!methodName || !accountNumber || !accountName) {
    req.session.errorMsg = 'Harap lengkapi metode, nomor rekening/akun, dan nama pemilik akun.';
    return res.redirect('/withdraw');
  }

  const amt = parseInt(amount);
  if (isNaN(amt) || amt < settings.minWithdraw) {
    req.session.errorMsg = 'Minimal penarikan Rp ' + settings.minWithdraw.toLocaleString('id-ID');
    return res.redirect('/withdraw');
  }

  const selectedMethod = (settings.withdrawMethods || []).find(m => m.name === methodName);
  if (!selectedMethod) {
    req.session.errorMsg = 'Metode penarikan tidak valid.';
    return res.redirect('/withdraw');
  }

  const fee = selectedMethod.fee || 0;
  const totalDeduct = amt + fee;

  const updatedUser = await User.findOneAndUpdate(
    { _id: req.session.userId, balance: { $gte: totalDeduct } },
    { $inc: { balance: -totalDeduct } },
    { new: true }
  );
  if (!updatedUser) {
    req.session.errorMsg = 'Saldo tidak cukup (termasuk biaya admin Rp ' + fee.toLocaleString() + ')';
    return res.redirect('/withdraw');
  }

  try {
    const ref = 'W' + Date.now().toString(36).toUpperCase();
    const wd = await createWithRetry(Withdrawal, {
      userId: req.session.userId,
      amount: amt,
      fee,
      method: selectedMethod.name,
      accountNumber,
      accountName
    });
    await createWithRetry(Transaction, {
      userId: req.session.userId,
      type: 'withdraw',
      amount: amt,
      fee,
      status: 'pending',
      reference: ref,
      method: selectedMethod.name,
      accountNumber,
      accountName
    });
    req.session.successMsg = 'Penarikan berhasil diajukan dan sedang diproses.';
  } catch (err) {
    await User.findByIdAndUpdate(req.session.userId, { $inc: { balance: totalDeduct } });
    req.session.errorMsg = 'Gagal memproses penarikan. Silakan coba lagi.';
    console.error(err);
  }
  res.redirect('/withdraw');
});

// ===================== ADMIN ROUTES =====================
app.get('/admin/dashboard', isAuth, isAdmin, async (req, res) => {
  const stats = await getStats();
  res.render('admin_dashboard', stats);
});

app.get('/admin/users', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  const filter = { role: 'user' };
  if (search) {
    filter.$or = [
      { email: { $regex: search, $options: 'i' } },
      { username: { $regex: search, $options: 'i' } }
    ];
  }
  const users = await User.find(filter).sort({ createdAt: -1 }).lean();
  res.render('admin_users', { users, search });
});

app.get('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const targetUser = await User.findById(req.params.id).lean();
  if (!targetUser) return res.status(404).send('Tidak ditemukan');
  res.render('admin_user_edit', { users: targetUser });
});

app.post('/admin/users/:id/edit', isAuth, isAdmin, async (req, res) => {
  const { username, email, password, balance, suspended } = req.body;
  if (username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
    if (username.length > 15) {
      req.session.errorMsg = 'Username maksimal 15 karakter';
      return res.redirect(`/admin/users/${req.params.id}/edit`);
    }
  }
  const upd = {
    username: username?.toLowerCase(),
    email,
    balance: parseInt(balance) || 0,
    suspended: suspended === 'on'
  };
  if (!upd.username) delete upd.username;
  if (password && password.trim()) upd.password = hashPassword(password);
  try {
    await User.findByIdAndUpdate(req.params.id, upd, { runValidators: true });
    req.session.successMsg = 'Data pengguna berhasil diperbarui';
    res.redirect('/admin/users');
  } catch (err) {
    if (err.code === 11000) {
      req.session.errorMsg = 'Username atau email sudah digunakan oleh pengguna lain';
    } else if (err.name === 'ValidationError') {
      req.session.errorMsg = Object.values(err.errors).map(e => e.message).join(', ');
    } else {
      req.session.errorMsg = 'Gagal memperbarui data pengguna';
    }
    res.redirect(`/admin/users/${req.params.id}/edit`);
  }
});

app.post('/admin/users/:id/delete', isAuth, isAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const userToDelete = await User.findById(userId);
    if (!userToDelete) {
      req.session.errorMsg = 'User tidak ditemukan.';
      return res.redirect('/admin/users');
    }
    if (userToDelete.role === 'admin') {
      req.session.errorMsg = 'Tidak dapat menghapus akun admin.';
      return res.redirect('/admin/users');
    }

    if (userToDelete.profilePicture) {
      await deleteUploadedFile(userToDelete.profilePicture);
    }

    const userChats = await ChatMessage.find({ userId: userId }, 'image').lean();
    for (const chat of userChats) {
      if (chat.image) {
        await deleteUploadedFile(chat.image);
      }
    }
    await ChatMessage.deleteMany({ userId: userId });

    await Invoice.deleteMany({ userId });
    await Transaction.deleteMany({ userId });
    await Withdrawal.deleteMany({ userId });
    await ApiKey.deleteMany({ userId });
    await User.findByIdAndDelete(userId);

    req.session.successMsg = 'User berhasil dihapus beserta seluruh data terkait.';
    res.redirect('/admin/users');
  } catch (err) {
    console.error(err);
    req.session.errorMsg = 'Gagal menghapus user.';
    res.redirect('/admin/users');
  }
});

app.get('/admin/withdraw', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let filter = {};
  if (search) {
    const users = await User.find({
      $or: [{ email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } }]
    }).select('_id');
    const userIds = users.map(u => u._id);
    filter = { userId: { $in: userIds } };
  }
  const withdrawals = await Withdrawal.find(filter)
    .populate('userId', 'username email')
    .sort({ createdAt: -1 })
    .lean();
  res.render('admin_withdraw', { withdrawals, search });
});

app.post('/admin/withdraw/success/:id', isAuth, isAdmin, async (req, res) => {
  const wd = await Withdrawal.findById(req.params.id);
  if (wd && wd.status === 'pending') {
    wd.status = 'success';
    wd.completedAt = new Date();
    await wd.save();
    await Transaction.updateOne(
      { userId: wd.userId, type: 'withdraw', status: 'pending', reference: { $regex: /^W/ } },
      { status: 'success', completedAt: new Date() }
    );
    await Stats.updateOne({}, { $inc: { totalWithdrawAmount: wd.amount, totalWithdrawFee: wd.fee } });
    req.session.successMsg = 'Penarikan berhasil disetujui.';
  }
  res.redirect('/admin/withdraw');
});

app.post('/admin/withdraw/reject/:id', isAuth, isAdmin, async (req, res) => {
  const wd = await Withdrawal.findById(req.params.id);
  if (wd && wd.status === 'pending') {
    wd.status = 'rejected';
    wd.adminNote = req.body.note || '';
    wd.completedAt = new Date();
    await wd.save();
    await User.findByIdAndUpdate(wd.userId, { $inc: { balance: wd.amount + wd.fee } });
    await Transaction.updateOne(
      { userId: wd.userId, type: 'withdraw', status: 'pending', reference: { $regex: /^W/ } },
      { status: 'rejected', adminNote: req.body.note || '', completedAt: new Date() }
    );
    req.session.successMsg = 'Penarikan ditolak dan saldo dikembalikan.';
  }
  res.redirect('/admin/withdraw');
});

app.get('/admin/transactions', isAuth, isAdmin, async (req, res) => {
  const search = req.query.search || '';
  let filter = {};
  if (search) {
    const users = await User.find({
      $or: [{ email: { $regex: search, $options: 'i' } }, { username: { $regex: search, $options: 'i' } }]
    }).select('_id');
    const userIds = users.map(u => u._id);
    filter = { $or: [{ userId: { $in: userIds } }, { reference: { $regex: search, $options: 'i' } }] };
  }
  const transactions = await Transaction.find(filter).populate('userId', 'username email').sort({ createdAt: -1 }).lean();
  res.render('admin_transactions', { transactions, search });
});

app.get('/admin/account', isAuth, isAdmin, async (req, res) => {
  const admin = await User.findById(req.session.userId).lean();
  res.render('admin_account', { admin });
});

app.post('/admin/account', isAuth, isAdmin, async (req, res) => {
  const { username, password, newPassword } = req.body;
  const admin = await User.findById(req.session.userId).lean();
  if (!password || !verifyPassword(password, admin.password)) {
    req.session.errorMsg = 'Password saat ini salah';
    return res.redirect('/admin/account');
  }
  if (username && username !== admin.username) {
    if (!/^[a-zA-Z0-9]+$/.test(username)) {
      req.session.errorMsg = 'Username hanya boleh berisi huruf dan angka (tanpa spasi atau simbol)';
      return res.redirect('/admin/account');
    }
    if (username.length > 15) {
      req.session.errorMsg = 'Username maksimal 15 karakter';
      return res.redirect('/admin/account');
    }
    const exist = await User.findOne({ username: username.toLowerCase(), _id: { $ne: admin._id } });
    if (exist) {
      req.session.errorMsg = 'Username sudah digunakan oleh pengguna lain';
      return res.redirect('/admin/account');
    }
  }
  try {
    const update = {};
    if (username && username !== admin.username) update.username = username.toLowerCase();
    if (newPassword && newPassword.trim()) update.password = hashPassword(newPassword);
    if (Object.keys(update).length > 0) {
      await User.findByIdAndUpdate(req.session.userId, update);
      req.session.successMsg = 'Data akun berhasil diperbarui';
    } else {
      req.session.errorMsg = 'Tidak ada perubahan yang dilakukan';
    }
  } catch (e) {
    req.session.errorMsg = 'Gagal memperbarui akun';
  }
  res.redirect('/admin/account');
});

app.post('/admin/settings/reset', isAuth, isAdmin, async (req, res) => {
  try {
    const chatMessages = await ChatMessage.find({ image: { $ne: null } }, 'image').lean();
    const chatFiles = chatMessages.map(m => m.image).filter(Boolean);
    const uniqueChatFiles = [...new Set(chatFiles)];
    for (const filePath of uniqueChatFiles) {
      await deleteUploadedFile(filePath);
    }
    await ChatMessage.deleteMany({});

    const usersToDelete = await User.find({ role: 'user' }, 'profilePicture').lean();
    const profileFiles = usersToDelete.map(u => u.profilePicture).filter(Boolean);
    const uniqueProfileFiles = [...new Set(profileFiles)];
    for (const filePath of uniqueProfileFiles) {
      await deleteUploadedFile(filePath);
    }
    await User.deleteMany({ role: 'user' });

    await Invoice.deleteMany({});
    await Transaction.deleteMany({});
    await Withdrawal.deleteMany({});
    await ApiKey.deleteMany({});
    await Stats.deleteMany({});
    await Stats.create({
      totalDepositAmount: 0,
      totalDepositFee: 0,
      totalWithdrawAmount: 0,
      totalWithdrawFee: 0,
      totalUsers: 0,
      totalTransactions: 0
    });

    req.session.successMsg = 'Database berhasil direset. Semua data pengguna, invoice, transaksi, dan withdrawal telah dihapus.';
  } catch (error) {
    console.error('Reset database error:', error);
    req.session.errorMsg = 'Gagal mereset database. Silakan coba lagi.';
  }
  res.redirect('/admin/settings');
});

// ===================== ADMIN SETTINGS =====================
app.get('/admin/settings', isAuth, isAdmin, async (req, res) => {
  const settings = await getSettings();
  res.render('admin_settings', { settings });
});

app.post('/admin/settings', isAuth, isAdmin, async (req, res) => {
  let withdrawMethods = [];
  const raw = req.body.withdrawMethodsJson;
  if (raw) {
    try {
      withdrawMethods = JSON.parse(raw);
      if (!Array.isArray(withdrawMethods)) withdrawMethods = [];
    } catch (e) {
      withdrawMethods = [];
    }
  }
  withdrawMethods = withdrawMethods.filter(m => m.name && typeof m.name === 'string' && m.name.trim() !== '' && typeof m.fee === 'number' && !isNaN(m.fee) && m.fee >= 0);
  if (withdrawMethods.length === 0) {
    withdrawMethods = [
      { name: 'Dana', fee: 500 },
      { name: 'GoPay', fee: 900 }
    ];
  }

  const parseNumber = (val, def) => {
    const n = parseInt(val);
    return isNaN(n) ? def : n;
  };

  const {
    name, title, description, channelWhatsApp,
    minDeposit, minWithdraw, feeWithdraw, maxFee,
    checkInterval, smtpUser, smtpPass, logoUrl,
    qrisExpiredMinutes,
    gopayDomain, gopayToken, gopayStaticQr,
    gopayRefreshToken
  } = req.body;

  await Setting.updateOne({}, {
    name, title, description, channelWhatsApp,
    minDeposit: parseNumber(minDeposit, 1000),
    minWithdraw: parseNumber(minWithdraw, 5000),
    feeWithdraw: parseNumber(feeWithdraw, 1000),
    maxFee: parseNumber(maxFee, 500),
    checkInterval: parseNumber(checkInterval, 30),
    smtpUser, smtpPass,
    logoUrl,
    qrisExpiredMinutes: parseNumber(qrisExpiredMinutes, 30),
    withdrawMethods,
    gopayDomain: gopayDomain || 'gomerch.vercel.app',
    gopayToken: gopayToken || '',
    gopayStaticQr: gopayStaticQr || '',
    gopayRefreshToken: gopayRefreshToken || ''
  });

  startChecker();
  req.session.successMsg = 'Pengaturan berhasil diperbarui.';
  res.redirect('/admin/settings');
});

// ===================== ADMIN NOTIFIKASI CRUD =====================
app.get('/admin/notifications', isAuth, isAdmin, async (req, res) => {
  const notifications = await Notification.find().sort({ createdAt: -1 }).lean();
  res.render('admin_notifikasi', { notifications });
});

app.post('/admin/notifications', isAuth, isAdmin, async (req, res) => {
  const { title, message } = req.body;
  if (!message) {
    req.session.errorMsg = 'Pesan notifikasi wajib diisi.';
    return res.redirect('/admin/notifications');
  }
  await Notification.create({ title: title || '', message, target: 'all' });
  req.session.successMsg = 'Notifikasi berhasil ditambahkan.';
  res.redirect('/admin/notifications');
});

app.post('/admin/notifications/edit/:id', isAuth, isAdmin, async (req, res) => {
  const { title, message } = req.body;
  if (!message) {
    req.session.errorMsg = 'Pesan notifikasi wajib diisi.';
    return res.redirect('/admin/notifications');
  }
  await Notification.findByIdAndUpdate(req.params.id, { title: title || '', message });
  req.session.successMsg = 'Notifikasi berhasil diperbarui.';
  res.redirect('/admin/notifications');
});

app.post('/admin/notifications/delete/:id', isAuth, isAdmin, async (req, res) => {
  await Notification.findByIdAndDelete(req.params.id);
  req.session.successMsg = 'Notifikasi berhasil dihapus.';
  res.redirect('/admin/notifications');
});

// ===================== LIVE CHAT ROUTES =====================
app.get('/chat', isAuth, async (req, res) => {
  res.render('chat', { user: res.locals.user });
});

app.post('/api/chat/upload', isAuth, chatUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Gambar tidak ditemukan' });
  try {
    const imageUrl = await saveUploadedFile(req.file, 'uploads', 'chat-');
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error('Upload gambar chat gagal:', err);
    res.status(500).json({ error: 'Gagal mengunggah gambar' });
  }
});

app.post('/api/chat/send', isAuth, async (req, res) => {
  const { message, image, replyTo } = req.body;
  const text = (message || '').trim();
  if (!text && !image) {
    return res.status(400).json({ error: 'Pesan atau gambar harus diisi' });
  }
  const user = await User.findById(req.session.userId).lean();
  const chatMsg = await ChatMessage.create({
    userId: user._id,
    username: user.username,
    message: text,
    image: image || null,
    role: user.role,
    profilePicture: user.profilePicture || null,
    profileColor: user.profileColor || null,
    replyTo: replyTo || null
  });
  res.json({ success: true, message: chatMsg });
});

app.get('/api/chat/messages', isAuth, async (req, res) => {
  const since = req.query.since;
  let filter = {};
  if (since) {
    filter.createdAt = { $gt: new Date(since) };
  }
  const messages = await ChatMessage.find(filter).sort({ createdAt: 1 }).lean();
  res.json(messages);
});

app.post('/api/chat/reset', isAuth, isAdmin, async (req, res) => {
  try {
    const messages = await ChatMessage.find({ image: { $ne: null } }, 'image').lean();
    const filesToDelete = messages.map(m => m.image).filter(Boolean);
    const uniqueFiles = [...new Set(filesToDelete)];
    for (const filePath of uniqueFiles) {
      await deleteUploadedFile(filePath);
    }
    await ChatMessage.deleteMany({});
    res.json({ success: true, message: 'Chat berhasil direset beserta file gambar.' });
  } catch (error) {
    console.error('Reset chat error:', error);
    res.status(500).json({ success: false, error: 'Gagal mereset chat.' });
  }
});

// ===================== PUBLIC API / DOCS =====================
app.get('/docs', async (req, res) => {
  let userApiKey = '';
  if (req.session.userId) {
    const key = await ApiKey.findOne({ userId: req.session.userId });
    if (key) userApiKey = key.key;
  }
  res.render('docs', { userApiKey });
});

async function apiAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key || req.query.apikey;
  if (!apiKey) return res.status(401).json({ error: 'API key diperlukan' });
  const keyDoc = await ApiKey.findOne({ key: apiKey });
  if (!keyDoc) return res.status(401).json({ error: 'API key tidak valid' });
  req.apiUser = keyDoc.userId;
  next();
}

app.get('/api/v1/balance', apiAuth, async (req, res) => {
  const user = await User.findById(req.apiUser);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ balance: user.balance });
});

app.get('/api/v1/invoice', apiAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    const amount = parseInt(req.query.amount);
    const invoice = await createInvoiceForUser(req.apiUser, amount, settings);
    return res.json({
      success: true,
      invoice_id: invoice._id,
      amount: invoice.amount,
      fee: invoice.fee,
      total: invoice.total,
      qris_image: invoice.qris_image,
      expired_at: invoice.expiredAt
    });
  } catch (e) {
    console.error('API create invoice error:', e.message);
    return res.status(400).json({ error: e.message });
  }
});

app.get('/api/v1/invoice/status', apiAuth, async (req, res) => {
  const invoiceId = req.query.id || req.query.invoice_id;
  if (!invoiceId) return res.status(400).json({ error: 'Invoice ID diperlukan' });
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice || invoice.userId.toString() !== req.apiUser.toString()) {
    return res.status(404).json({ error: 'Invoice tidak ditemukan' });
  }
  res.json({
    invoice_id: invoice._id,
    amount: invoice.amount,
    fee: invoice.fee,
    total: invoice.total,
    status: invoice.status,
    qris_image: invoice.qris_image,
    expired_at: invoice.expiredAt,
    created_at: invoice.createdAt
  });
});

// ===================== CHECKER MUTASI (GOPAY MERCHANT ONLY) =====================
let checkerInterval;

async function checkMutasi() {
  try {
    const settings = await getSettings();
    const expiredMinutes = settings.qrisExpiredMinutes || 30;
    const now = new Date();

    const expiredInvoices = await Invoice.find({ status: 'pending', expiredAt: { $lt: now } });
    for (const inv of expiredInvoices) {
      inv.status = 'expired';
      await inv.save();
      await Transaction.updateOne(
        { reference: inv._id.toString(), type: 'deposit', status: 'pending' },
        { status: 'expired' }
      );
    }

    const pendingInvoices = await Invoice.find({ status: 'pending' }).lean();

    if (!settings.gopayToken) return;
    const gopayBase = settings.gopayDomain || 'gomerch.vercel.app';
    const apiUrl = `https://${gopayBase}/api/history?token=${encodeURIComponent(settings.gopayToken)}`;
    try {
      const data = await callGopayApiWithRetry(apiUrl);
      if (!data.success || !Array.isArray(data.data)) return;

      const mutations = data.data.filter(tx => tx.status === 'success');
      const usedMutationIds = await Invoice.find({ mutationId: { $ne: null } }).distinct('mutationId');
      const availableMutations = mutations.filter(tx => !usedMutationIds.includes(String(tx.id)));

      for (const inv of pendingInvoices) {
        const match = availableMutations.find(tx => {
          if (tx.amount !== inv.total) return false;
          const txTime = new Date(tx.time);
          if (isNaN(txTime.getTime())) return false;
          const diffMinutes = Math.abs(txTime.getTime() - inv.createdAt.getTime()) / 1000 / 60;
          return diffMinutes <= expiredMinutes;
        });
        if (!match) continue;

        await Invoice.findByIdAndUpdate(inv._id, {
          status: 'paid',
          mutationId: String(match.id)
        });
        await User.findByIdAndUpdate(inv.userId, { $inc: { balance: inv.amount } });
        await Transaction.updateOne(
          { reference: inv._id.toString(), type: 'deposit', status: 'pending' },
          { status: 'paid' }
        );
        await Stats.updateOne({}, { $inc: { totalDepositAmount: inv.amount, totalDepositFee: inv.fee, totalTransactions: 1 } });

        const idx = availableMutations.findIndex(tx => String(tx.id) === String(match.id));
        if (idx !== -1) availableMutations.splice(idx, 1);
      }
    } catch (err) {
      console.error('Mutasi error:', err.response?.data || err.message);
    }

  } catch (err) {
    console.error('Mutasi error:', err.response?.data || err.message);
  }
}

async function updateStatsOnStartup() {
  const [depositAgg, withdrawAgg, totalUsers, totalTrx] = await Promise.all([
    Transaction.aggregate([{ $match: { type: 'deposit', status: 'paid' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    Transaction.aggregate([{ $match: { type: 'withdraw', status: 'success' } }, { $group: { _id: null, totalAmount: { $sum: '$amount' }, totalFee: { $sum: '$fee' } } }]),
    User.countDocuments({ role: 'user' }),
    Transaction.countDocuments()
  ]);
  await Stats.deleteMany({});
  await Stats.create({
    totalDepositAmount: depositAgg[0]?.totalAmount || 0,
    totalDepositFee: depositAgg[0]?.totalFee || 0,
    totalWithdrawAmount: withdrawAgg[0]?.totalAmount || 0,
    totalWithdrawFee: withdrawAgg[0]?.totalFee || 0,
    totalUsers,
    totalTransactions: totalTrx
  });
}

function startChecker() {
  if (checkerInterval) clearInterval(checkerInterval);
  getSettings().then(s => {
    checkerInterval = setInterval(checkMutasi, s.checkInterval * 1000);
    checkMutasi();
  });
}

setTimeout(async () => {
  await updateStatsOnStartup();
  startChecker();
}, 2000);

// Di Vercel, app di-import sebagai serverless function (tidak boleh app.listen).
// require.main === module hanya true saat dijalankan langsung via `node server.js`.
if (require.main === module) {
  app.listen(PORT, () => console.log(`🚀 Server berjalan di http://localhost:${PORT}`));
}

module.exports = app;