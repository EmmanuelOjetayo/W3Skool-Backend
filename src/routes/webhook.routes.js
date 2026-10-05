'use strict';

const express = require('express');
const router = express.Router();
const { flutterwaveWebhook } = require('../controllers/webhook.controller');

// No auth middleware — Flutterwave calls this directly with verif-hash header
router.post('/flutterwave', flutterwaveWebhook);

module.exports = router;
