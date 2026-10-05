'use strict';

const mongoose = require('mongoose');
const Course = require('../models/Course');
const Module = require('../models/Module');
const Unit = require('../models/Unit');
const Enrollment = require('../models/Enrollment');
const Progress = require('../models/Progress');
const asyncHandler = require('../utils/asyncHandler');
const { sendSuccess, sendError } = require('../utils/response');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Given a list of courseIds and a userId, build a map of:
 *   courseId → { isEnrolled, progressPercent }
 */
async function buildEnrollmentProgressMap(userId, courseIds) {
  const map = {};
  if (!userId || !courseIds.length) {
    courseIds.forEach((id) => { map[id.toString()] = { isEnrolled: false, progressPercent: 0 }; });
    return map;
  }

  const enrollments = await Enrollment.find({ userId, courseId: { $in: courseIds } }).lean();
  const enrolledCourseIds = enrollments.map((e) => e.courseId.toString());

  // Fetch unit counts and completion counts for enrolled courses only
  const [unitCounts, completedCounts] = await Promise.all([
    Unit.aggregate([
      { $match: { courseId: { $in: enrollments.map((e) => e.courseId) } } },
      { $group: { _id: '$courseId', count: { $sum: 1 } } },
    ]),
    Progress.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId), courseId: { $in: enrollments.map((e) => e.courseId) }, completed: true } },
      { $group: { _id: '$courseId', count: { $sum: 1 } } },
    ]),
  ]);

  const unitCountMap = {};
  unitCounts.forEach((r) => { unitCountMap[r._id.toString()] = r.count; });

  const completedCountMap = {};
  completedCounts.forEach((r) => { completedCountMap[r._id.toString()] = r.count; });

  courseIds.forEach((id) => {
    const sid = id.toString();
    const enrolled = enrolledCourseIds.includes(sid);
    let progressPercent = 0;
    if (enrolled) {
      const total = unitCountMap[sid] || 0;
      const done = completedCountMap[sid] || 0;
      progressPercent = total > 0 ? Math.round((done / total) * 100) : 0;
    }
    map[sid] = { isEnrolled: enrolled, progressPercent };
  });

  return map;
}

// ─── Controllers ─────────────────────────────────────────────────────────────

/**
 * GET /courses
 * Query: search, level, featured, limit
 */
const getCourses = asyncHandler(async (req, res) => {
  const { search, level, featured, limit: limitRaw } = req.query;

  const filter = { status: 'published' };

  if (search) {
    filter.title = { $regex: search, $options: 'i' };
  }
  if (level) {
    filter.level = level;
  }
  if (featured !== undefined) {
    filter.featured = featured === 'true';
  }

  const limit = Math.min(parseInt(limitRaw, 10) || 50, 100);

  const courses = await Course.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const courseIds = courses.map((c) => c._id);

  const epMap = await buildEnrollmentProgressMap(req.user?.id, courseIds);

  const data = courses.map((c) => {
    const sid = c._id.toString();
    const ep = epMap[sid] || { isEnrolled: false, progressPercent: 0 };
    return {
      id: c._id,
      slug: c.slug,
      title: c.title,
      subtitle: c.subtitle,
      thumbnailUrl: c.thumbnailUrl,
      level: c.level,
      durationSeconds: c.totalDurationSeconds,
      moduleCount: c.moduleCount,
      unitCount: c.unitCount,
      price: c.price,
      discountPrice: c.discountPrice,
      currency: c.currency,
      isEnrolled: ep.isEnrolled,
      progressPercent: ep.progressPercent,
    };
  });

  return sendSuccess(res, data);
});

/**
 * GET /courses/:idOrSlug
 */
const getCourse = asyncHandler(async (req, res) => {
  const { idOrSlug } = req.params;

  const orConditions = [{ slug: idOrSlug }];
  if (isValidObjectId(idOrSlug)) {
    orConditions.unshift({ _id: idOrSlug });
  }

  const course = await Course.findOne({ $or: orConditions, status: 'published' }).lean();

  if (!course) {
    return sendError(res, 'Course not found.', 404, 'NOT_FOUND');
  }

  // Build curriculum (titles only, no full video URLs for non-enrolled)
  const modules = await Module.find({ courseId: course._id }).sort({ order: 1 }).lean();

  const moduleIds = modules.map((m) => m._id);
  const units = await Unit.find({ moduleId: { $in: moduleIds } }).sort({ order: 1 }).lean();

  const unitsByModule = {};
  units.forEach((u) => {
    const mid = u.moduleId.toString();
    if (!unitsByModule[mid]) unitsByModule[mid] = [];
    unitsByModule[mid].push(u);
  });

  const curriculum = modules.map((m) => ({
    id: m._id,
    title: m.title,
    units: (unitsByModule[m._id.toString()] || []).map((u) => ({
      id: u._id,
      title: u.title,
      durationSeconds: u.video?.durationSeconds || 0,
      isPreview: u.isPreview,
    })),
  }));

  // Enrollment status
  let enrollmentInfo = { isEnrolled: false, progressPercent: 0 };
  if (req.user) {
    const epMap = await buildEnrollmentProgressMap(req.user.id, [course._id]);
    enrollmentInfo = epMap[course._id.toString()] || enrollmentInfo;
  }

  return sendSuccess(res, {
    id: course._id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    description: course.description,
    thumbnailUrl: course.thumbnailUrl,
    status: course.status,
    instructor: {
      name: course.instructorName,
      bio: course.instructorBio,
      avatarUrl: course.instructorAvatarUrl,
    },
    level: course.level,
    durationSeconds: course.totalDurationSeconds,
    moduleCount: course.moduleCount,
    unitCount: course.unitCount,
    price: course.price,
    discountPrice: course.discountPrice,
    currency: course.currency,
    whatYouWillLearn: course.whatYouWillLearn,
    requirements: course.requirements,
    certificate: {
      enabled: course.certificate?.enabled,
      description: course.certificate?.description,
    },
    liveClasses: {
      enabled: course.liveClasses?.enabled,
      platform: course.liveClasses?.platform,
      description: course.liveClasses?.description,
      whatsappAvailable: !!course.liveClasses?.whatsappGroupUrl,
    },
    hasFinalAssessment: course.hasFinalAssessment,
    curriculum,
    enrollment: enrollmentInfo,
  });
});

/**
 * GET /courses/:courseId/units/:unitId/preview
 */
const getPreviewUnit = asyncHandler(async (req, res) => {
  const { courseId, unitId } = req.params;

  const [course, unit] = await Promise.all([
    Course.findOne({ _id: courseId, status: 'published' }).lean(),
    Unit.findOne({ _id: unitId, courseId }).lean(),
  ]);

  if (!course || !unit || !unit.isPreview) {
    return sendError(res, 'This lesson is not available for preview.', 403, 'FORBIDDEN');
  }

  return sendSuccess(res, {
    id: unit._id,
    title: unit.title,
    video: unit.video ? { url: unit.video.url } : null,
  });
});

module.exports = { getCourses, getCourse, getPreviewUnit };
