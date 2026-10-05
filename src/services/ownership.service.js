'use strict';

const Course = require('../models/Course');

/**
 * Multi-admin ownership helpers.
 *
 * - A set `owner` means the course belongs to exactly one admin.
 * - A null `owner` is a legacy/platform-owned course manageable by any admin.
 */
const isOwnedBy = (course, userId) =>
  !course || !course.owner || course.owner.toString() === userId.toString();

/** Mongo filter for “courses this admin may see/manage”. */
const ownedCourseFilter = (userId) => ({ $or: [{ owner: userId }, { owner: null }] });

/** Load a course by id and enforce ownership. Throws a shaped error object. */
const requireOwnedCourse = async (courseId, userId) => {
  const course = await Course.findById(courseId);
  if (!course) {
    const err = new Error('Course not found.');
    err.statusCode = 404;
    err.code = 'COURSE_NOT_FOUND';
    throw err;
  }
  if (!isOwnedBy(course, userId)) {
    const err = new Error('You do not have access to this course.');
    err.statusCode = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
  return course;
};

/** IDs of courses this admin may see/manage (owned + legacy null-owner). */
const ownedCourseIds = async (userId) => {
  const courses = await Course.find(ownedCourseFilter(userId)).select('_id').lean();
  return courses.map((c) => c._id);
};

module.exports = {
  isOwnedBy,
  ownedCourseFilter,
  requireOwnedCourse,
  ownedCourseIds,
};