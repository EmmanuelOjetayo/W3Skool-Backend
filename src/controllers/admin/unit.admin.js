'use strict';

const Course = require('../../models/Course');
const Module = require('../../models/Module');
const Unit = require('../../models/Unit');
const Resource = require('../../models/Resource');
const Quiz = require('../../models/Quiz');
const Progress = require('../../models/Progress');

const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { sanitizeGuideHtml } = require('../../utils/sanitize');
const { requireOwnedCourse } = require('../../services/ownership.service');
const { verifyUploadedAsset, isAssetAvailable } = require('../../services/cloudinary.service');

const ownedError = (res, e) => sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recalculate and persist totalDurationSeconds on a course from all its units.
 */
const recalcCourseDuration = async (courseId) => {
  const units = await Unit.find({ courseId, 'video.durationSeconds': { $gt: 0 } }).lean();
  const totalDurationSeconds = units.reduce(
    (sum, u) => sum + (u.video && u.video.durationSeconds ? u.video.durationSeconds : 0),
    0
  );
  await Course.findByIdAndUpdate(courseId, { totalDurationSeconds });
};

/**
 * Build the admin-facing shape for a unit + its resources.
 * `available` is probed against the CDN so a broken upload is visible in the
 * editor instead of only surfacing to students as an empty viewer.
 */
const formatUnit = async (unit, resources) => ({
  id: unit._id,
  title: unit.title,
  order: unit.order,
  isPreview: unit.isPreview,
  hasQuiz: !!unit.quizId,
  video: unit.video && unit.video.url
    ? {
        url: unit.video.url,
        publicId: unit.video.publicId,
        durationSeconds: unit.video.durationSeconds,
        requiredWatchPercent: unit.video.requiredWatchPercent,
        seekPolicy: unit.video.seekPolicy,
      }
    : null,
  guide: unit.guideHtml
    ? { format: 'html', content: unit.guideHtml }
    : null,
  resources: await Promise.all(
    (resources || []).map(async (r) => ({
      id: r._id,
      title: r.title,
      type: r.type,
      url: r.url,
      publicId: r.publicId,
      sizeBytes: r.sizeBytes,
      available: r.type === 'link' ? true : await isAssetAvailable(r.url),
    }))
  ),
});

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/** POST /admin/modules/:moduleId/units */
const createUnit = asyncHandler(async (req, res) => {
  const { moduleId } = req.params;
  const { title } = req.body;

  if (!title) return sendError(res, 'title is required.', 422, 'VALIDATION_ERROR');

  const mod = await Module.findById(moduleId).lean();
  if (!mod) return sendError(res, 'Module not found.', 404, 'MODULE_NOT_FOUND');

  const courseId = mod.courseId;
  try {
    await requireOwnedCourse(courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }

  const last = await Unit.findOne({ moduleId }).sort('-order').lean();
  const order = last ? last.order + 1 : 1;

  const unit = await Unit.create({ moduleId, courseId, title, order });

  await Course.findByIdAndUpdate(courseId, { $inc: { unitCount: 1 } });

  sendSuccess(
    res,
    {
      id: unit._id,
      moduleId: unit.moduleId,
      courseId: unit.courseId,
      title: unit.title,
      order: unit.order,
      isPreview: unit.isPreview,
    },
    201
  );
});

/** GET /admin/units/:id */
const getUnit = asyncHandler(async (req, res) => {
  const unit = await Unit.findById(req.params.id).lean();
  if (!unit) return sendError(res, 'Unit not found.', 404, 'UNIT_NOT_FOUND');
  try {
    await requireOwnedCourse(unit.courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }

  const resources = await Resource.find({ unitId: unit._id }).lean();

  sendSuccess(res, await formatUnit(unit, resources));
});

/** PATCH /admin/units/:id */
const updateUnit = asyncHandler(async (req, res) => {
  const unit = await Unit.findById(req.params.id);
  if (!unit) return sendError(res, 'Unit not found.', 404, 'UNIT_NOT_FOUND');
  try {
    await requireOwnedCourse(unit.courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }

  const { title, isPreview, video, guide } = req.body;

  if (title !== undefined) unit.title = title;
  if (isPreview !== undefined) unit.isPreview = isPreview;

  // Video handling
  if (req.body.hasOwnProperty('video')) {
    if (video === null) {
      unit.video = null;
    } else if (video && typeof video === 'object') {
      unit.video = unit.video || {};
      if (video.url !== undefined) unit.video.url = video.url;
      if (video.publicId !== undefined) unit.video.publicId = video.publicId;
      if (video.durationSeconds !== undefined) unit.video.durationSeconds = video.durationSeconds;
      if (video.requiredWatchPercent !== undefined) unit.video.requiredWatchPercent = video.requiredWatchPercent;
      if (video.seekPolicy !== undefined) unit.video.seekPolicy = video.seekPolicy;
    }
  }

  // Guide handling
  if (req.body.hasOwnProperty('guide')) {
    if (guide === null) {
      unit.guideHtml = null;
    } else if (guide && guide.content !== undefined) {
      unit.guideHtml = sanitizeGuideHtml(guide.content);
    }
  }

  await unit.save();

  // Recalculate course total duration when video changes
  if (req.body.hasOwnProperty('video')) {
    await recalcCourseDuration(unit.courseId);
  }

  const resources = await Resource.find({ unitId: unit._id }).lean();
  sendSuccess(res, await formatUnit(unit.toObject(), resources));
});

/** DELETE /admin/units/:id */
const deleteUnit = asyncHandler(async (req, res) => {
  const unit = await Unit.findById(req.params.id);
  if (!unit) return sendError(res, 'Unit not found.', 404, 'UNIT_NOT_FOUND');
  try {
    await requireOwnedCourse(unit.courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }

  const { moduleId, courseId } = unit;

  await Resource.deleteMany({ unitId: unit._id });
  await Progress.deleteMany({ unitId: unit._id });
  await Quiz.deleteOne({ scope: 'unit', scopeId: unit._id });
  await Unit.findByIdAndDelete(unit._id);

  await Course.findByIdAndUpdate(courseId, { $inc: { unitCount: -1 } });
  await recalcCourseDuration(courseId);

  sendSuccess(res, { message: 'Unit deleted.' });
});

/** PUT /admin/modules/:moduleId/units/order */
const reorderUnits = asyncHandler(async (req, res) => {
  const { unitIds } = req.body;

  if (!Array.isArray(unitIds) || unitIds.length === 0) {
    return sendError(res, 'unitIds must be a non-empty array.', 422, 'VALIDATION_ERROR');
  }

  const mod = await Module.findById(req.params.moduleId).select('courseId').lean();
  if (!mod) return sendError(res, 'Module not found.', 404, 'MODULE_NOT_FOUND');
  try {
    await requireOwnedCourse(mod.courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }

  await Promise.all(
    unitIds.map((id, index) =>
      Unit.findByIdAndUpdate(id, { order: index + 1 })
    )
  );

  sendSuccess(res, { message: 'Units reordered.' });
});

/** POST /admin/units/:unitId/resources */
const createResource = asyncHandler(async (req, res) => {
  const { unitId } = req.params;
  const { title, type, url, publicId, sizeBytes } = req.body;

  if (!title || !type || !url) {
    return sendError(res, 'title, type, and url are required.', 422, 'VALIDATION_ERROR');
  }

  const unit = await Unit.findById(unitId).lean();
  if (!unit) return sendError(res, 'Unit not found.', 404, 'UNIT_NOT_FOUND');
  try {
    await requireOwnedCourse(unit.courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }

  // A Cloudinary upload that the CDN can't deliver (404 = never stored,
  // 401 = delivery blocked) must never be attached to course content —
  // otherwise it sits in the syllabus and silently fails for every student.
  if (type !== 'link' && typeof url === 'string' && url.includes('res.cloudinary.com')) {
    const check = await verifyUploadedAsset({ publicId, url });
    if (!check.ok) {
      return sendError(
        res,
        check.reason === 'NOT_IN_ACCOUNT'
          ? 'Cloudinary never finished storing this file. Nothing was saved - please upload it again.'
          : `Cloudinary can\'t deliver this file (HTTP ${check.status || 'no response'}). Nothing was saved - please upload it again.`,
        422,
        'RESOURCE_UNAVAILABLE'
      );
    }
  }

  const resource = await Resource.create({
    unitId,
    moduleId: unit.moduleId,
    courseId: unit.courseId,
    title,
    type,
    url,
    publicId,
    sizeBytes,
  });

  sendSuccess(
    res,
    {
      id: resource._id,
      unitId: resource.unitId,
      title: resource.title,
      type: resource.type,
      url: resource.url,
      publicId: resource.publicId,
      sizeBytes: resource.sizeBytes,
    },
    201
  );
});

/** DELETE /admin/resources/:id */
const deleteResource = asyncHandler(async (req, res) => {
  const resource = await Resource.findById(req.params.id).lean();
  if (!resource) return sendError(res, 'Resource not found.', 404, 'RESOURCE_NOT_FOUND');
  try {
    await requireOwnedCourse(resource.courseId, req.user.id);
  } catch (e) {
    return ownedError(res, e);
  }
  await Resource.findByIdAndDelete(req.params.id);
  sendSuccess(res, { message: 'Resource deleted.' });
});

module.exports = {
  createUnit,
  getUnit,
  updateUnit,
  deleteUnit,
  reorderUnits,
  createResource,
  deleteResource,
};
