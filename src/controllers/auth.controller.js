'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PasswordReset = require('../models/PasswordReset');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/response');
const { sendWelcome, sendPasswordReset } = require('../services/email.service');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function signToken(user) {
  return jwt.sign(
    { id: user._id.toString(), role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function safeUser(user) {
  return { id: user._id, name: user.name, email: user.email, role: user.role };
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * POST /auth/register
 * Body: { name, email, phone, password }
 */
const register = asyncHandler(async (req, res) => {
  const { name, email, phone, password } = req.body;

  // Validation
  if (!name || !name.trim()) {
    return sendError(res, 'Name is required.', 400, 'VALIDATION_ERROR');
  }
  if (!email || !EMAIL_RE.test(email)) {
    return sendError(res, 'A valid email address is required.', 400, 'VALIDATION_ERROR');
  }
  if (!password || password.length < 8) {
    return sendError(res, 'Password must be at least 8 characters long.', 400, 'VALIDATION_ERROR');
  }

  // Duplicate check
  const existing = await User.findOne({ email: email.toLowerCase().trim() });
  if (existing) {
    return sendError(res, 'An account with this email already exists.', 409, 'ALREADY_EXISTS');
  }

  const hashedPw = await bcrypt.hash(password, 12);

  const user = await User.create({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    phone: phone ? phone.trim() : undefined,
    password: hashedPw,
    role: 'student',
  });

  const token = signToken(user);

  // Welcome email (asynchronous, idempotent)
  sendWelcome({ userId: user._id.toString(), name: user.name, email: user.email });

  return res.status(201).json({ data: { token, user: safeUser(user) } });
});

/**
 * POST /auth/login
 * Body: { email, password }
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return sendError(res, 'Email and password are required.', 400, 'VALIDATION_ERROR');
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');

  if (!user) {
    return sendError(res, 'Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return sendError(res, 'Invalid email or password.', 401, 'INVALID_CREDENTIALS');
  }

  // Update last active timestamp (non-blocking)
  User.findByIdAndUpdate(user._id, { lastActiveAt: new Date() }).exec();

  const token = signToken(user);

  return sendSuccess(res, { token, user: safeUser(user) });
});

/**
 * GET /auth/me
 * Requires: authenticate middleware
 */
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id).lean();

  if (!user) {
    return sendError(res, 'User not found.', 404, 'NOT_FOUND');
  }

  return sendSuccess(res, {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    avatar: user.avatar,
    lastActiveAt: user.lastActiveAt,
    createdAt: user.createdAt,
  });
});

/**
 * POST /auth/forgot-password
 * Body: { email }
 * Always responds 200 (never reveals whether the email exists).
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const email = (req.body.email || '').toLowerCase().trim();
  if (!email) return sendError(res, 'Email is required.', 400, 'VALIDATION_ERROR');

  const user = await User.findOne({ email });
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    await PasswordReset.create({ userId: user._id, tokenHash, expiresAt });

    const resetUrl = `${process.env.CLIENT_URL || 'https://w3-skool.netlify.app'}/reset-password?token=${token}`;
    sendPasswordReset({ userId: user._id.toString(), token, name: user.name, email: user.email, resetUrl });
  }

  return sendSuccess(res, { message: 'If an account exists for that email, a reset link has been sent.' });
});

/**
 * POST /auth/reset-password
 * Body: { token, password }
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token) return sendError(res, 'Reset token is required.', 400, 'VALIDATION_ERROR');
  if (!password || password.length < 8) {
    return sendError(res, 'Password must be at least 8 characters long.', 400, 'VALIDATION_ERROR');
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await PasswordReset.findOne({ tokenHash, usedAt: null });

  if (!record || record.expiresAt.getTime() < Date.now()) {
    return sendError(res, 'This reset link is invalid or has expired. Please request a new one.', 400, 'INVALID_RESET_TOKEN');
  }

  const hashed = await bcrypt.hash(password, 12);
  await User.findByIdAndUpdate(record.userId, { password: hashed });

  // Invalidate the token and any other outstanding tokens for this user
  await PasswordReset.updateMany(
    { userId: record.userId, usedAt: null },
    { $set: { usedAt: new Date() } }
  );

  return sendSuccess(res, { message: 'Your password has been updated. You can now log in.' });
});

module.exports = { register, login, getMe, forgotPassword, resetPassword };
