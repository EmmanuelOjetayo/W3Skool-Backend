'use strict';

const Enrollment = require('../models/Enrollment');

/**
 * Create or return an existing enrollment.
 * Fully idempotent — a second call with the same userId+courseId returns the
 * existing record and sets isNew=false.
 *
 * @param {Object} params
 * @param {string|import('mongoose').Types.ObjectId} params.userId
 * @param {string|import('mongoose').Types.ObjectId} params.courseId
 * @param {string|import('mongoose').Types.ObjectId|null} [params.paymentId]
 * @returns {Promise<{ enrollment: Object, isNew: boolean }>}
 */
const createEnrollment = async ({ userId, courseId, paymentId = null }) => {
  const result = await Enrollment.findOneAndUpdate(
    { userId, courseId },
    {
      $setOnInsert: {
        userId,
        courseId,
        paymentId: paymentId || null,
        enrolledAt: new Date(),
      },
    },
    { upsert: true, new: true, rawResult: true }
  );

  // rawResult: true returns a { value, lastErrorObject, ok } object.
  // lastErrorObject.updatedExisting is true when the doc already existed.
  const enrollment = result.value || result;
  const isNew = result.lastErrorObject?.updatedExisting === false;

  return { enrollment, isNew };
};

/**
 * Retrieve a single enrollment record.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string|import('mongoose').Types.ObjectId} courseId
 * @returns {Promise<Object|null>}
 */
const getEnrollment = (userId, courseId) =>
  Enrollment.findOne({ userId, courseId });

/**
 * Check whether a user is enrolled in a course.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {string|import('mongoose').Types.ObjectId} courseId
 * @returns {Promise<boolean>}
 */
const isEnrolled = async (userId, courseId) => {
  const doc = await Enrollment.findOne({ userId, courseId })
    .select('_id')
    .lean();
  return !!doc;
};

module.exports = {
  createEnrollment,
  getEnrollment,
  isEnrolled,
};
