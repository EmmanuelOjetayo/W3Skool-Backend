'use strict';

const Course = require('../../models/Course');
const Module = require('../../models/Module');
const Unit = require('../../models/Unit');
const Quiz = require('../../models/Quiz');
const Progress = require('../../models/Progress');
const Certificate = require('../../models/Certificate');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { isEnrolled } = require('../../services/enrollment.service');
const { getUnlockMap } = require('../../services/unlock.service');

/** GET /student/courses/:courseId/outline */
const getCourseOutline = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const userId = req.user.id;

  // Admin preview: read-only observation is allowed WITHOUT enrollment.
  // The admin sees a "fresh student" view; nothing is ever persisted for them.
  const isAdminPreview = req.user.role === 'admin';
  const enrolled = await isEnrolled(userId, courseId);
  if (!enrolled && !isAdminPreview) {
    return sendError(
      res,
      'You are not enrolled in this course.',
      403,
      'NOT_ENROLLED'
    );
  }

  const course = await Course.findById(courseId).lean();
  if (!course) {
    return sendError(res, 'Course not found.', 404, 'NOT_FOUND');
  }

  // Get unlock map for this user & course
  const {
    unitStatuses,
    moduleQuizStatuses,
    finalAssessmentStatus,
    resumeItem,
  } = await getUnlockMap(userId, courseId);

  // Preview: show the whole curriculum open (display-only — never writes).
  if (isAdminPreview) {
    const openUp = (map) => Object.values(map).forEach((entry) => {
      if (entry && entry.status === 'locked') {
        entry.status = 'unlocked';
        entry.lockedReason = null;
      }
    });
    openUp(unitStatuses);
    openUp(moduleQuizStatuses);
    if (finalAssessmentStatus && finalAssessmentStatus.status === 'locked') {
      finalAssessmentStatus.status = 'unlocked';
      finalAssessmentStatus.lockedReason = null;
    }
  }

  // Compute progress percent
  const totalUnits = course.unitCount || 0;
  const completedCount = await Progress.countDocuments({
    userId,
    courseId,
    completed: true,
  });

  const progressPercent = totalUnits > 0
    ? Math.min(Math.round((completedCount / totalUnits) * 100), 100)
    : 0;

  // Check certificate
  const cert = await Certificate.findOne({ userId, courseId }).select('_id').lean();

  // Fetch modules and units
  const modules = await Module.find({ courseId }).sort('order').lean();

  const formattedModules = await Promise.all(
    modules.map(async (mod) => {
      const units = await Unit.find({ moduleId: mod._id }).sort('order').lean();

      const formattedUnits = units.map((u) => {
        const entry = unitStatuses[u._id.toString()] || { status: 'locked', lockedReason: null };
        return {
          id: u._id,
          title: u.title,
          status: entry.status,
          lockedReason: entry.lockedReason,
        };
      });

      let moduleQuiz = null;
      if (mod.quizId) {
        const quiz = await Quiz.findById(mod.quizId).select('title').lean();
        const mqEntry = moduleQuizStatuses[mod.quizId.toString()] || { status: 'locked', lockedReason: null };
        if (quiz) {
          moduleQuiz = {
            id: mod.quizId,
            title: quiz.title,
            status: mqEntry.status,
            lockedReason: mqEntry.lockedReason,
          };
        }
      }

      return {
        id: mod._id,
        title: mod.title,
        units: formattedUnits,
        moduleQuiz,
      };
    })
  );

  // Final assessment
  let finalAssessment = null;
  if (course.hasFinalAssessment && course.finalAssessmentQuizId) {
    const quiz = await Quiz.findById(course.finalAssessmentQuizId).select('title').lean();
    if (quiz) {
      finalAssessment = {
        id: course.finalAssessmentQuizId,
        title: quiz.title,
        status: finalAssessmentStatus?.status || 'locked',
        lockedReason: finalAssessmentStatus?.lockedReason || null,
      };
    }
  }

  sendSuccess(res, {
    course: {
      id: course._id,
      title: course.title,
      progressPercent,
    },
    resumeItem,
    preview: isAdminPreview,
    certificateAvailable: !!cert,
    support: {
      whatsappUrl: course.liveClasses?.whatsappGroupUrl || null,
    },
    modules: formattedModules,
    finalAssessment,
  });
});

module.exports = {
  getCourseOutline,
};
