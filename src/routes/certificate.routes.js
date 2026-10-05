'use strict';

const express = require('express');
const router = express.Router();
const Certificate = require('../models/Certificate');
const Course = require('../models/Course');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess } = require('../utils/response');

/**
 * GET /certificates/verify/:code
 * Public endpoint to verify a certificate by unique code.
 */
router.get(
  '/verify/:code',
  asyncHandler(async (req, res) => {
    const { code } = req.params;

    const cert = await Certificate.findOne({ code: code.toUpperCase().trim() }).lean();
    if (!cert) {
      return sendSuccess(res, { valid: false });
    }

    const [user, course] = await Promise.all([
      User.findById(cert.userId).select('name').lean(),
      Course.findById(cert.courseId).select('title instructorName').lean(),
    ]);

    return sendSuccess(res, {
      valid: true,
      certificate: {
        code: cert.code,
        studentName: user ? user.name : 'W3Skool Student',
        courseTitle: course ? course.title : 'W3Skool Technical Course',
        instructorName: course?.instructorName || 'W3Skool Academy',
        issuedAt: cert.issuedAt,
      },
    });
  })
);

module.exports = router;
