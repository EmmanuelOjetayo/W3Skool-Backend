'use strict';

const Course = require('../../models/Course');
const Module = require('../../models/Module');
const Unit = require('../../models/Unit');
const Resource = require('../../models/Resource');
const Quiz = require('../../models/Quiz');
const QuizAttempt = require('../../models/QuizAttempt');
const Progress = require('../../models/Progress');

const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { requireOwnedCourse } = require('../../services/ownership.service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recalculate and persist moduleCount and unitCount on a course.
 */
const recalcCourseCounts = async (courseId) => {
  const moduleCount = await Module.countDocuments({ courseId });
  const unitCount = await Unit.countDocuments({ courseId });
  await Course.findByIdAndUpdate(courseId, { moduleCount, unitCount });
};

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** POST /admin/courses/:courseId/modules */
const createModule = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const { title } = req.body;

  if (!title) return sendError(res, 'title is required.', 422, 'VALIDATION_ERROR');

  const course = await Course.findById(courseId);
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  try {
    await requireOwnedCourse(courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  const last = await Module.findOne({ courseId }).sort('-order').lean();
  const order = last ? last.order + 1 : 1;

  const mod = await Module.create({ courseId, title, order });

  await Course.findByIdAndUpdate(courseId, { $inc: { moduleCount: 1 } });

  sendSuccess(res, { id: mod._id, courseId: mod.courseId, title: mod.title, order: mod.order }, 201);
});

/** PATCH /admin/modules/:id */
const updateModule = asyncHandler(async (req, res) => {
  const { title } = req.body;
  if (!title) return sendError(res, 'title is required.', 422, 'VALIDATION_ERROR');

  const existing = await Module.findById(req.params.id).select('courseId').lean();
  if (!existing) return sendError(res, 'Module not found.', 404, 'MODULE_NOT_FOUND');
  try {
    await requireOwnedCourse(existing.courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  const mod = await Module.findByIdAndUpdate(
    req.params.id,
    { title },
    { new: true, runValidators: true }
  );

  if (!mod) return sendError(res, 'Module not found.', 404, 'MODULE_NOT_FOUND');

  sendSuccess(res, { id: mod._id, courseId: mod.courseId, title: mod.title, order: mod.order });
});

/** DELETE /admin/modules/:id */
const deleteModule = asyncHandler(async (req, res) => {
  const mod = await Module.findById(req.params.id);
  if (!mod) return sendError(res, 'Module not found.', 404, 'MODULE_NOT_FOUND');

  try {
    await requireOwnedCourse(mod.courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  const moduleId = mod._id;
  const courseId = mod.courseId;

  // Gather all units in this module
  const units = await Unit.find({ moduleId }).lean();
  const unitIds = units.map((u) => u._id);

  // Cascade deletes
  if (unitIds.length > 0) {
    await Resource.deleteMany({ unitId: { $in: unitIds } });
    await QuizAttempt.deleteMany({ quizId: { $in: unitIds } }); // attempts referencing unit quizzes
    await Progress.deleteMany({ unitId: { $in: unitIds } });
    // Delete unit-scoped quizzes
    await Quiz.deleteMany({ scope: 'unit', scopeId: { $in: unitIds } });
  }

  // Delete module-scoped quiz
  await Quiz.deleteOne({ scope: 'module', scopeId: moduleId });

  await Unit.deleteMany({ moduleId });
  await Module.findByIdAndDelete(moduleId);

  // Recalculate course counts
  await recalcCourseCounts(courseId);

  sendSuccess(res, { message: 'Module deleted.' });
});

/** PUT /admin/courses/:courseId/modules/order */
const reorderModules = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const { moduleIds } = req.body;

  if (!Array.isArray(moduleIds) || moduleIds.length === 0) {
    return sendError(res, 'moduleIds must be a non-empty array.', 422, 'VALIDATION_ERROR');
  }

  try {
    await requireOwnedCourse(courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  await Promise.all(
    moduleIds.map((id, index) =>
      Module.findByIdAndUpdate(id, { order: index + 1 })
    )
  );

  sendSuccess(res, { message: 'Modules reordered.' });
});

module.exports = {
  createModule,
  updateModule,
  deleteModule,
  reorderModules,
};
