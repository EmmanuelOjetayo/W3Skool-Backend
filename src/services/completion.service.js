'use strict';

const fs = require('fs');
const path = require('path');
const Course = require('../models/Course');
const User = require('../models/User');
const Enrollment = require('../models/Enrollment');
const Certificate = require('../models/Certificate');
const Module = require('../models/Module');
const Progress = require('../models/Progress');
const { checkEligibility, issueCertificate } = require('./certificate.service');
const { buildCertificatePdf } = require('./certificatePdf.service');
const { uploadPdfBuffer } = require('./cloudinary.service');
const { sendCertificate } = require('./email.service');
const { platform } = require('../config/platform');

const verifyUrlFor = (code) => `${process.env.CLIENT_URL || 'http://localhost:5173'}/verify/${code}`;

/**
 * Generate + store the certificate PDF and persist pdfUrl. Best-effort:
 * failures never break certificate issuance (the code remains valid).
 */
const attachPdf = async (cert, { studentName, courseTitle, instructorName }) => {
  if (cert.pdfUrl) return cert;

  let buffer;
  try {
    buffer = await buildCertificatePdf({
      studentName,
      courseTitle,
      instructorName,
      issuedAt: cert.issuedAt,
      code: cert.code,
      verifyUrl: verifyUrlFor(cert.code),
    });
  } catch (e) {
    console.error('[Cert] PDF build failed:', e.message);
    return cert;
  }

  try {
    if (platform.certStorage === 'local') {
      const dir = path.join(__dirname, '..', '..', 'uploads', 'certificates');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${cert.code}.pdf`);
      fs.writeFileSync(file, buffer);
      const url = `${process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 5000}`}/uploads/certificates/${cert.code}.pdf`;
      return Certificate.findByIdAndUpdate(cert._id, { pdfUrl: url }, { new: true });
    }
    const { url } = await uploadPdfBuffer(buffer, 'w3skool/certificates', cert.code);
    return Certificate.findByIdAndUpdate(cert._id, { pdfUrl: url }, { new: true });
  } catch (e) {
    console.error('[Cert] PDF storage failed:', e.message);
    return cert;
  }
};

/**
 * Central completion handler. Call from EVERY legitimate completion path
 * (unit progress/complete, quiz submit). Idempotent.
 *
 * @returns {Promise<{ courseCompleted:boolean, certificate:Object|null }>}
 */
const checkAndHandleCourseCompletion = async (userId, courseId) => {
  const eligibility = await checkEligibility(userId, courseId);
  if (!eligibility.eligible) return { courseCompleted: false, certificate: null };

  // Mark enrollment completed (idempotent)
  await Enrollment.findOneAndUpdate(
    { userId, courseId },
    { $set: { completedAt: new Date() } }
  );

  // Issue certificate idempotently
  let cert = await issueCertificate(userId, courseId);

  const [user, course] = await Promise.all([
    User.findById(userId).select('name email').lean(),
    Course.findById(courseId).select('title instructorName').lean(),
  ]);

  cert = await attachPdf(cert, {
    studentName: user?.name || 'Student',
    courseTitle: course?.title || 'W3Skool Course',
    instructorName: course?.instructorName || 'W3Skool Academy',
  });

  const out = {
    courseCompleted: true,
    certificate: {
      available: true,
      code: cert.code,
      verifyUrl: verifyUrlFor(cert.code),
      pdfUrl: cert.pdfUrl || null,
    },
  };

  // Certificate email (once)
  if (user?.email) {
    sendCertificate({
      certId: cert._id.toString(),
      name: user.name,
      email: user.email,
      courseTitle: course?.title || 'W3Skool Course',
      code: cert.code,
      verifyUrl: out.certificate.verifyUrl,
      pdfUrl: cert.pdfUrl || null,
    });
  }

  return out;
};

/**
 * Whether a course counts as reached-completion for the dashboard (all units done).
 */
const isCourseFullyCompleted = async (userId, courseId) => {
  const modules = await Module.find({ courseId }).select('_id').lean();
  const modIds = modules.map((m) => m._id);
  const units = await Progress.db.model('Unit').find({ moduleId: { $in: modIds } }).select('_id').lean();
  if (units.length === 0) return false;
  const done = await Progress.countDocuments({ userId, courseId, completed: true });
  return done >= units.length;
};

module.exports = {
  checkAndHandleCourseCompletion,
  isCourseFullyCompleted,
  verifyUrlFor,
  attachPdf,
};