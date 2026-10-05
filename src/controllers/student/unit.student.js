'use strict';

const Unit = require('../../models/Unit');
const Module = require('../../models/Module');
const Resource = require('../../models/Resource');
const Quiz = require('../../models/Quiz');
const QuizAttempt = require('../../models/QuizAttempt');
const Progress = require('../../models/Progress');
const Enrollment = require('../../models/Enrollment');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { isEnrolled } = require('../../services/enrollment.service');
const { isUnitAccessible, getUnlockMap } = require('../../services/unlock.service');
const { upsertProgress, getUnitCompletion } = require('../../services/progress.service');
const { checkAndHandleCourseCompletion } = require('../../services/completion.service');
const { isAssetAvailable } = require('../../services/cloudinary.service');

/** GET /student/units/:unitId */
const getUnit = asyncHandler(async (req, res) => {
  const { unitId } = req.params;
  const userId = req.user.id;

  const unit = await Unit.findById(unitId).lean();
  if (!unit) {
    return sendError(res, 'Lesson not found.', 404, 'NOT_FOUND');
  }

  // Admin preview: read-only view WITHOUT enrollment or lock checks.
  // No progress/quiz records are ever written for an admin (writes are rejected below).
  const isAdminPreview = req.user.role === 'admin';
  if (!isAdminPreview) {
    const enrolled = await isEnrolled(userId, unit.courseId);
    if (!enrolled) {
      return sendError(res, 'You are not enrolled in this course.', 403, 'NOT_ENROLLED');
    }

    // Access / lock check
    const accessible = await isUnitAccessible(userId, unitId, unit.courseId);
    if (!accessible) {
      const lockMap = await getUnlockMap(userId, unit.courseId);
      const reason = lockMap.unitStatuses[unitId]?.lockedReason || 'Complete previous lessons to unlock this one.';
      return sendError(res, reason, 403, 'UNIT_LOCKED');
    }
  }

  // Fetch module info
  const mod = await Module.findById(unit.moduleId).select('title').lean();

  // Fetch progress
  const progress = await Progress.findOne({ userId, unitId }).lean();

  // Fetch resources
  const resources = await Resource.find({ unitId }).lean();

  // Fetch quiz info & attempts if unit has quiz
  let quizData = null;
  let quizAttempts = [];
  if (unit.quizId) {
    const quizDoc = await Quiz.findById(unit.quizId).select('required passMark').lean();
    quizAttempts = await QuizAttempt.find({ userId, quizId: unit.quizId }).lean();
    const passed = quizAttempts.some((a) => a.passed === true);
    if (quizDoc) {
      quizData = {
        id: unit.quizId,
        required: quizDoc.required,
        passed,
      };
    }
  }

  // Completion calculation
  const completion = getUnitCompletion(unit, progress, quizAttempts);

  // Status for this unit
  const unlockMap = await getUnlockMap(userId, unit.courseId);
  const status = isAdminPreview ? 'unlocked' : (unlockMap.unitStatuses[unitId]?.status || 'current');

  // Video object
  let videoData = null;
  if (unit.video && unit.video.url) {
    const durationSeconds = unit.video.durationSeconds || 0;
    const maxWatchedSeconds = progress?.maxWatchedSeconds || 0;
    const watchedPercent = durationSeconds > 0
      ? Math.min(Math.round((maxWatchedSeconds / durationSeconds) * 100), 100)
      : 0;

    videoData = {
      url: unit.video.url,
      thumbnailUrl: null,
      durationSeconds,
      resumePositionSeconds: progress?.lastPositionSeconds || 0,
      maxWatchedSeconds,
      watchedPercent,
      requiredWatchPercent: unit.video.requiredWatchPercent ?? 90,
      seekPolicy: unit.video.seekPolicy || 'no_forward',
      completed: progress?.videoCompleted === true,
    };
  }

  // Build navigation (previous & next item in sequence)
  const allModules = await Module.find({ courseId: unit.courseId }).sort('order').lean();
  const sequenceItems = [];

  for (const m of allModules) {
    const mUnits = await Unit.find({ moduleId: m._id }).sort('order').lean();
    for (const u of mUnits) {
      sequenceItems.push({ type: 'unit', id: u._id.toString() });
    }
    if (m.quizId) {
      sequenceItems.push({ type: 'quiz', id: m.quizId.toString() });
    }
  }

  const currentIndex = sequenceItems.findIndex((item) => item.type === 'unit' && item.id === unitId);
  const previousItem = currentIndex > 0 ? sequenceItems[currentIndex - 1] : null;

  let nextItem = null;
  if (currentIndex >= 0 && currentIndex < sequenceItems.length - 1) {
    const candidateNext = sequenceItems[currentIndex + 1];
    let isNextLocked = true;
    let nextLockedReason = null;

    if (candidateNext.type === 'unit') {
      const nextEntry = unlockMap.unitStatuses[candidateNext.id];
      isNextLocked = !nextEntry || nextEntry.status === 'locked';
      nextLockedReason = nextEntry?.lockedReason || 'Complete this lesson to unlock the next one.';
    } else if (candidateNext.type === 'quiz') {
      const nextEntry = unlockMap.moduleQuizStatuses[candidateNext.id];
      isNextLocked = !nextEntry || nextEntry.status === 'locked';
      nextLockedReason = nextEntry?.lockedReason || 'Complete all lessons in this module to unlock the quiz.';
    }

    nextItem = {
      type: candidateNext.type,
      id: candidateNext.id,
      locked: isNextLocked,
      lockedReason: isNextLocked ? nextLockedReason : null,
    };
  }

  sendSuccess(res, {
    id: unit._id,
    title: unit.title,
    moduleId: unit.moduleId,
    moduleTitle: mod ? mod.title : '',
    status,
    preview: isAdminPreview,
    video: videoData,
    guide: unit.guideHtml ? { format: 'html', content: unit.guideHtml } : null,
    resources: await Promise.all(
      resources.map(async (r) => ({
        id: r._id,
        title: r.title,
        type: r.type,
        url: r.url,
        sizeBytes: r.sizeBytes,
        // Lets the viewer explain itself instead of opening an empty frame.
        available: r.type === 'link' ? true : await isAssetAvailable(r.url),
      }))
    ),
    quiz: quizData,
    completion,
    navigation: {
      previous: previousItem,
      next: nextItem,
    },
  });
});

/** Did this unit completion just finish its whole module? (celebration flag) */
const moduleJustCompleted = async (userId, unit) => {
  const siblings = await Unit.find({ moduleId: unit.moduleId }).select('_id').lean();
  if (siblings.length === 0) return false;
  const done = await Progress.countDocuments({ userId, moduleId: unit.moduleId, completed: true });
  return done >= siblings.length;
};

/** POST /student/units/:unitId/progress */
const updateProgress = asyncHandler(async (req, res) => {
  const { unitId } = req.params;
  const userId = req.user.id;
  const { positionSeconds = 0, durationSeconds = 0, maxWatchedSeconds = 0 } = req.body;

  // Admin preview: never record progress for an admin.
  if (req.user.role === 'admin') {
    return sendError(res, 'Preview mode: progress is not recorded while previewing as an admin.', 403, 'PREVIEW_READ_ONLY');
  }

  const unit = await Unit.findById(unitId).lean();
  if (!unit) {
    return sendError(res, 'Lesson not found.', 404, 'NOT_FOUND');
  }

  const enrolled = await isEnrolled(userId, unit.courseId);
  if (!enrolled) {
    return sendError(res, 'You are not enrolled in this course.', 403, 'NOT_ENROLLED');
  }

  const result = await upsertProgress({
    userId,
    unitId,
    courseId: unit.courseId,
    moduleId: unit.moduleId,
    positionSeconds,
    durationSeconds,
    maxWatchedSeconds,
  });

  // Calculate live completion checklist
  let quizAttempts = [];
  if (unit.quizId) {
    quizAttempts = await QuizAttempt.find({ userId, quizId: unit.quizId }).lean();
  }
  const completion = getUnitCompletion(unit, result.progress, quizAttempts);

  // Authoritative course completion + certificate state (may just have completed)
  let courseCompleted = false;
  let certificate = null;
  let moduleCompleted = false;
  if (result.unitCompleted) {
    const handled = await checkAndHandleCourseCompletion(userId, unit.courseId);
    courseCompleted = handled.courseCompleted;
    certificate = handled.certificate;
    moduleCompleted = await moduleJustCompleted(userId, unit);
  }

  sendSuccess(res, {
    watchedPercent: Math.round(result.watchedPercent),
    videoCompleted: result.videoCompleted,
    unitCompleted: result.unitCompleted,
    moduleCompleted,
    completion,
    courseCompleted,
    certificate,
  });
});

/** POST /student/units/:unitId/complete */
const completeUnit = asyncHandler(async (req, res) => {
  const { unitId } = req.params;
  const userId = req.user.id;

  // Admin preview: completion is disabled (preview ≠ participation).
  if (req.user.role === 'admin') {
    return sendError(res, 'Preview mode: completion is disabled while previewing as an admin.', 403, 'PREVIEW_READ_ONLY');
  }

  const unit = await Unit.findById(unitId).lean();
  if (!unit) {
    return sendError(res, 'Lesson not found.', 404, 'NOT_FOUND');
  }

  const enrolled = await isEnrolled(userId, unit.courseId);
  if (!enrolled) {
    return sendError(res, 'You are not enrolled in this course.', 403, 'NOT_ENROLLED');
  }

  const hasVideo = !!(unit.video && unit.video.url);
  const hasQuiz = !!unit.quizId;

  if (hasVideo || hasQuiz) {
    return sendError(
      res,
      'This lesson has requirements that must be met before it can be completed.',
      422,
      'CANNOT_SELF_COMPLETE'
    );
  }

  await Progress.findOneAndUpdate(
    { userId, unitId },
    {
      $set: {
        userId,
        unitId,
        courseId: unit.courseId,
        moduleId: unit.moduleId,
        videoCompleted: true,
        completed: true,
        completedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  const handled = await checkAndHandleCourseCompletion(userId, unit.courseId);
  const moduleCompleted = await moduleJustCompleted(userId, unit);

  sendSuccess(res, { completed: true, moduleCompleted, courseCompleted: handled.courseCompleted, certificate: handled.certificate });
});

module.exports = {
  getUnit,
  updateProgress,
  completeUnit,
};
