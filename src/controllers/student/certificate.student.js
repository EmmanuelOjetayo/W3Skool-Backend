'use strict';

const Certificate = require('../../models/Certificate');
const Course = require('../../models/Course');
const User = require('../../models/User');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { isEnrolled } = require('../../services/enrollment.service');
const { checkEligibility } = require('../../services/certificate.service');
const { checkAndHandleCourseCompletion } = require('../../services/completion.service');

/** GET /student/courses/:courseId/certificate */
const getCourseCertificate = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const userId = req.user.id;

  const enrolled = await isEnrolled(userId, courseId);
  if (!enrolled) {
    return sendError(res, 'You are not enrolled in this course.', 403, 'NOT_ENROLLED');
  }

  const [course, user] = await Promise.all([
    Course.findById(courseId).select('title instructorName certificate').lean(),
    User.findById(userId).select('name').lean(),
  ]);

  if (!course) {
    return sendError(res, 'Course not found.', 404, 'NOT_FOUND');
  }

  // Check if certificate was already issued
  let cert = await Certificate.findOne({ userId, courseId });

  if (!cert) {
    // Check eligibility
    const eligibility = await checkEligibility(userId, courseId);
    if (!eligibility.eligible) {
      return sendSuccess(res, {
        available: false,
        reason: eligibility.reason || 'Complete all course requirements to earn your certificate.',
      });
    }

    // Issue certificate (+ PDF + email) idempotently via the central handler
    await checkAndHandleCourseCompletion(userId, courseId);
    cert = await Certificate.findOne({ userId, courseId });
    if (!cert) {
      return sendSuccess(res, {
        available: false,
        reason: 'Certificate could not be issued yet. Please try again shortly.',
      });
    }
  }

  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
  const verifyUrl = `${clientUrl}/verify/${cert.code}`;

  sendSuccess(res, {
    available: true,
    certificate: {
      id: cert._id,
      code: cert.code,
      studentName: user ? user.name : 'Student',
      courseTitle: course.title,
      instructorName: course.instructorName || 'W3Skool Academy',
      issuedAt: cert.issuedAt,
      pdfUrl: cert.pdfUrl || null,
      verifyUrl,
    },
  });
});

module.exports = {
  getCourseCertificate,
};
