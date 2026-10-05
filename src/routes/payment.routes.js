'use strict';

const express = require('express');
const router = express.Router();
const { initiatePayment, verifyPayment, checkoutPayment } = require('../controllers/payment.controller');
const { authenticate } = require('../middleware/authenticate');

// Preferred window-checkout flow
router.post('/checkout', authenticate, checkoutPayment);
// Legacy hosted-link flow (kept for backward compatibility)
router.post('/initiate', authenticate, initiatePayment);
router.get('/verify', authenticate, verifyPayment);

module.exports = router;
