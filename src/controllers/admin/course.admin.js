'use strict';

const slugify = require('slugify');
const Course = require('../../models/Course');
const Module = require('../../models/Module');
const Unit = require('../../models/Unit');
const Resource = require('../../models/Resource');
const Quiz = require('../../models/Quiz');
const Enrollment = require('../../models/Enrollment');
const Progress = require('../../models/Progress');
const Subaccount = require('../../models/Subaccount');
const User = require('../../models/User');

const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { isOwnedBy, ownedCourseFilter } = require('../../services/ownership.service');

/** Load a course and enforce ownership. Returns { course } or { error }. */
const loadOwnedCourse = async (id, userId) => {
  const course = await Course.findById(id);
  if (!course) return { error: { message: 'Course not found.', status: 404, code: 'COURSE_NOT_FOUND' } };
  if (!isOwnedBy(course, userId)) {
    return { error: { message: 'You do not have access to this course.', status: 403, code: 'FORBIDDEN' } };
  }
  return { course };
};

/** Does this admin have an active Flutterwave subaccount? */
const hasActiveSubaccount = async (adminId) => {
  if (!adminId) return false;
  const sub = await Subaccount.findOne({ adminId, status: 'active' }).select('_id flwSubaccountId').lean();
  return !!(sub && sub.flwSubaccountId);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the admin-facing shape for a single course (without modules).
 */
const formatCourse = (course) => ({
  id: course._id,
  title: course.title,
  slug: course.slug,
  subtitle: course.subtitle,
  description: course.description,
  level: course.level,
  thumbnailUrl: course.thumbnailUrl,
  status: course.status,
  owner: course.owner || null,
  instructor: {
    name: course.instructorName,
    bio: course.instructorBio,
    avatarUrl: course.instructorAvatarUrl,
  },
  whatYouWillLearn: course.whatYouWillLearn,
  requirements: course.requirements,
  price: course.price,
  discountPrice: course.discountPrice,
  currency: course.currency,
  certificate: course.certificate,
  liveClasses: course.liveClasses,
  hasFinalAssessment: course.hasFinalAssessment,
  finalAssessmentQuizId: course.finalAssessmentQuizId,
  totalDurationSeconds: course.totalDurationSeconds,
  moduleCount: course.moduleCount,
  unitCount: course.unitCount,
});

/**
 * Run publish validation checks on a course document.
 * Returns { canPublish, issues }.
 */
const runPublishChecks = async (course) => {
  const issues = [];

  if (!course.title || !course.description) {
    issues.push({ code: 'NO_DESCRIPTION', message: 'Add a course description.' });
  }

  if (!course.thumbnailUrl) {
    issues.push({ code: 'NO_THUMBNAIL', message: 'Add a course thumbnail.' });
  }

  // At least 1 module with at least 1 unit
  const modules = await Module.find({ courseId: course._id }).lean();
  let hasUnit = false;
  for (const mod of modules) {
    const unitCount = await Unit.countDocuments({ moduleId: mod._id });
    if (unitCount > 0) { hasUnit = true; break; }
  }
  if (!hasUnit) {
    issues.push({ code: 'NO_UNITS', message: 'Add at least one lesson.' });
  }

  if (course.price === undefined || course.price === null) {
    issues.push({ code: 'NO_PRICE', message: 'Set a price (or 0 for free).' });
  }

  if (!course.instructorName) {
    issues.push({ code: 'NO_INSTRUCTOR', message: 'Add an instructor name.' });
  }

  // Paid courses need the owner to have a connected Flutterwave payout account.
  if (course.price > 0 && course.owner) {
    const hasPayout = await hasActiveSubaccount(course.owner);
    if (!hasPayout) {
      issues.push({
        code: 'PAYOUT_NOT_SETUP',
        message: 'Connect your payout account before publishing a paid course.',
      });
    }
  }

  return { canPublish: issues.length === 0, issues };
};

/**
 * Generate a unique slug for the given title.
 */
const generateUniqueSlug = async (title, excludeId = null) => {
  const base = slugify(title, { lower: true, strict: true });
  let slug = base;
  let counter = 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };
    const existing = await Course.findOne(query).lean();
    if (!existing) break;
    slug = `${base}-${counter}`;
    counter += 1;
  }

  return slug;
};

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** GET /admin/courses  — scoped to the authenticated admin's own courses */
const getCourses = asyncHandler(async (req, res) => {
  // Owned courses only (null-owner legacy courses are shown to whoever manages them).
  const courses = await Course.find(ownedCourseFilter(req.user.id)).lean();

  const payoutReady = await hasActiveSubaccount(req.user.id);

  // Resolve owner names once
  const ownerIds = [...new Set(courses.filter((c) => c.owner).map((c) => c.owner.toString()))];
  const owners = await User.find({ _id: { $in: ownerIds } }).select('name').lean();
  const ownerMap = new Map(owners.map((o) => [o._id.toString(), o.name]));

  const withCounts = await Promise.all(
    courses.map(async (course) => {
      const studentCount = await Enrollment.countDocuments({ courseId: course._id });
      const owned = isOwnedBy(course, req.user.id);
      return {
        id: course._id,
        title: course.title,
        status: course.status,
        price: course.price,
        discountPrice: course.discountPrice,
        currency: course.currency,
        moduleCount: course.moduleCount,
        unitCount: course.unitCount,
        studentCount,
        owner: course.owner ? { id: course.owner, name: ownerMap.get(course.owner.toString()) || 'Admin' } : null,
        // A paid course can be published only when its owner has an active payout account.
        payoutReady: course.price === 0 ? true : (owned ? payoutReady : false),
      };
    })
  );

  sendSuccess(res, withCounts);
});

/** GET /admin/courses/:id */
const getCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id).lean();
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  const modules = await Module.find({ courseId: course._id }).sort('order').lean();

  const modulesWithUnits = await Promise.all(
    modules.map(async (mod) => {
      const units = await Unit.find({ moduleId: mod._id }).sort('order').lean();

      const unitsFormatted = await Promise.all(
        units.map(async (unit) => {
          const resourceCount = await Resource.countDocuments({ unitId: unit._id });
          return {
            id: unit._id,
            title: unit.title,
            order: unit.order,
            isPreview: unit.isPreview,
            hasVideo: !!(unit.video && unit.video.url),
            hasGuide: !!unit.guideHtml,
            resourceCount,
            hasQuiz: !!unit.quizId,
          };
        })
      );

      return {
        id: mod._id,
        title: mod.title,
        order: mod.order,
        hasQuiz: !!mod.quizId,
        units: unitsFormatted,
      };
    })
  );

  const payload = {
    ...formatCourse(course),
    modules: modulesWithUnits,
  };

  sendSuccess(res, payload);
});

/** POST /admin/courses */
const createCourse = asyncHandler(async (req, res) => {
  const { title } = req.body;
  if (!title) return sendError(res, 'title is required.', 422, 'VALIDATION_ERROR');

  const slug = await generateUniqueSlug(title);

  // Ownership is ALWAYS the authenticated admin — never client-supplied.
  const course = await Course.create({
    title,
    slug,
    status: 'draft',
    owner: req.user.id,
  });

  sendSuccess(res, formatCourse(course.toObject ? course.toObject() : course), 201);
});

/** PATCH /admin/courses/:id */
const updateCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  const allowedFields = [
    'title', 'subtitle', 'description', 'level', 'thumbnailUrl',
    'price', 'discountPrice', 'currency',
    'instructorName', 'instructorBio', 'instructorAvatarUrl',
    'whatYouWillLearn', 'requirements',
    'certificate', 'liveClasses',
    'hasFinalAssessment',
  ];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      course[field] = req.body[field];
    }
  }

  // Regenerate slug if title changed
  if (req.body.title !== undefined && req.body.title !== course.title) {
    course.slug = await generateUniqueSlug(req.body.title, course._id);
  }

  await course.save();

  sendSuccess(res, formatCourse(course.toObject()));
});

/** PATCH /admin/courses/:id/status */
const updateCourseStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['draft', 'published', 'archived'];
  if (!status || !validStatuses.includes(status)) {
    return sendError(res, `status must be one of: ${validStatuses.join(', ')}.`, 422, 'VALIDATION_ERROR');
  }

  const course = await Course.findById(req.params.id);
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  if (status === 'published') {
    const { canPublish, issues } = await runPublishChecks(course);
    if (!canPublish) {
      return sendError(res, issues[0].message, 422, issues[0].code, issues);
    }
  }

  course.status = status;
  await course.save();

  sendSuccess(res, { status: course.status });
});

/** DELETE /admin/courses/:id */
const deleteCourse = asyncHandler(async (req, res) => {
  const courseId = req.params.id;

  const owned = await loadOwnedCourse(courseId, req.user.id);
  if (owned.error) return sendError(res, owned.error.message, owned.error.status, owned.error.code);

  const enrollmentCount = await Enrollment.countDocuments({ courseId });

  if (enrollmentCount > 0) {
    return sendError(
      res,
      'This course has enrolled students. Unpublish it instead of deleting.',
      409,
      'COURSE_HAS_STUDENTS'
    );
  }

  // Cascade
  const units = await Unit.find({ courseId }).lean();
  const unitIds = units.map((u) => u._id);

  await Resource.deleteMany({ courseId });
  await Progress.deleteMany({ courseId });
  await Quiz.deleteMany({ courseId });
  await Unit.deleteMany({ courseId });
  await Module.deleteMany({ courseId });
  await Course.findByIdAndDelete(courseId);

  sendSuccess(res, { message: 'Course deleted.' });
});

/** GET /admin/courses/:id/publish-check */
const publishCheck = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  const result = await runPublishChecks(course);
  sendSuccess(res, result);
});

/** POST /admin/courses/:id/publish */
const publishCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  const { canPublish, issues } = await runPublishChecks(course);
  if (!canPublish) {
    return sendError(res, issues[0].message, 422, issues[0].code, issues);
  }

  course.status = 'published';
  await course.save();

  sendSuccess(res, { status: 'published' });
});

/** POST /admin/courses/:id/unpublish */
const unpublishCourse = asyncHandler(async (req, res) => {
  const course = await Course.findById(req.params.id);
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  course.status = 'draft';
  await course.save();

  sendSuccess(res, { status: 'draft' });
});

/** GET /admin/courses/:id/preview */
const getCoursePreview = asyncHandler(async (req, res) => {
  // Same as getCourse but works regardless of status — reuse getCourse shape
  const course = await Course.findById(req.params.id).lean();
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!isOwnedBy(course, req.user.id)) return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');

  const modules = await Module.find({ courseId: course._id }).sort('order').lean();

  const modulesWithUnits = await Promise.all(
    modules.map(async (mod) => {
      const units = await Unit.find({ moduleId: mod._id }).sort('order').lean();

      const unitsFormatted = await Promise.all(
        units.map(async (unit) => {
          const resourceCount = await Resource.countDocuments({ unitId: unit._id });
          return {
            id: unit._id,
            title: unit.title,
            order: unit.order,
            isPreview: unit.isPreview,
            hasVideo: !!(unit.video && unit.video.url),
            hasGuide: !!unit.guideHtml,
            resourceCount,
            hasQuiz: !!unit.quizId,
          };
        })
      );

      return {
        id: mod._id,
        title: mod.title,
        order: mod.order,
        hasQuiz: !!mod.quizId,
        units: unitsFormatted,
      };
    })
  );

  sendSuccess(res, { ...formatCourse(course), modules: modulesWithUnits });
});

module.exports = {
  getCourses,
  getCourse,
  createCourse,
  updateCourse,
  updateCourseStatus,
  deleteCourse,
  publishCheck,
  publishCourse,
  unpublishCourse,
  getCoursePreview,
};
