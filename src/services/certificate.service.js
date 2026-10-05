'use strict';

const crypto = require('crypto');
const Course = require('../models/Course');
const Module = require('../models/Module');
const Unit = require('../models/Unit');
const Progress = require('../models/Progress');
const QuizAttempt = require('../models/QuizAttempt');
const Certificate = require('../models/Certificate');

/**
 * Generate a unique verification code: W3S-XXXX-XXXX
 * Excludes easily confusable chars (0, O, 1, I).
 */
const generateCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `W3S-${pick(4)}-${pick(4)}`;
};

/**
 * Validate whether a user has fulfilled all requirements for course completion & certificate.
 *
 * Requirements:
 * 1. Course certificate must be enabled.
 * 2. Every unit in the course must have progress.completed === true.
 * 3. If course has a final assessment, a passing QuizAttempt must exist.
 *
 * @param {string} userId
 * @param {string} courseId
 * @returns {Promise<{ eligible: boolean, reason?: string }>}
 */
const checkEligibility = async (userId, courseId) => {
  const course = await Course.findById(courseId).select('certificate hasFinalAssessment finalAssessmentQuizId').lean();
  if (!course) {
    return { eligible: false, reason: 'Course not found.' };
  }

  if (course.certificate?.enabled === false) {
    return { eligible: false, reason: 'This course does not offer certificates.' };
  }

  // Fetch all modules & units for the course
  const modules = await Module.find({ courseId }).select('_id').lean();
  const moduleIds = modules.map((m) => m._id);
  const units = await Unit.find({ moduleId: { $in: moduleIds } }).select('_id').lean();

  if (units.length === 0) {
    return { eligible: false, reason: 'Course has no lessons to complete.' };
  }

  // Check progress records for all units
  const progressRecords = await Progress.find({
    userId,
    courseId,
    completed: true,
  }).select('unitId').lean();

  const completedUnitIds = new Set(progressRecords.map((p) => p.unitId.toString()));
  const allUnitsDone = units.every((u) => completedUnitIds.has(u._id.toString()));

  if (!allUnitsDone) {
    return { eligible: false, reason: 'Complete all lessons to earn your certificate.' };
  }

  // Check final assessment if configured
  if (course.hasFinalAssessment && course.finalAssessmentQuizId) {
    const passedFinal = await QuizAttempt.findOne({
      userId,
      quizId: course.finalAssessmentQuizId,
      passed: true,
    }).select('_id').lean();

    if (!passedFinal) {
      return { eligible: false, reason: 'Pass the final assessment to earn your certificate.' };
    }
  }

  return { eligible: true };
};

/**
 * Idempotently issues a certificate. If already issued, returns the existing record.
 *
 * @param {string} userId
 * @param {string} courseId
 * @returns {Promise<Object>} Certificate document
 */
const issueCertificate = async (userId, courseId) => {
  // Check existing first
  const existing = await Certificate.findOne({ userId, courseId });
  if (existing) return existing;

  // Try creating with unique code (with collision retry)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const code = generateCode();
      const certificate = await Certificate.create({
        userId,
        courseId,
        code,
        issuedAt: new Date(),
      });
      return certificate;
    } catch (err) {
      // 11000 duplicate key error on code or (userId, courseId)
      if (err.code === 11000) {
        // If already issued for this user & course, return existing
        const alreadyIssued = await Certificate.findOne({ userId, courseId });
        if (alreadyIssued) return alreadyIssued;
        // Else code collided, loop again
      } else {
        throw err;
      }
    }
  }

  throw new Error('Failed to generate unique certificate code.');
};

module.exports = {
  generateCode,
  checkEligibility,
  issueCertificate,
};
