'use strict';

const Quiz = require('../../models/Quiz');
const QuizAttempt = require('../../models/QuizAttempt');
const Progress = require('../../models/Progress');
const Unit = require('../../models/Unit');
const Enrollment = require('../../models/Enrollment');
const Course = require('../../models/Course');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { isEnrolled } = require('../../services/enrollment.service');
const { getUnlockMap } = require('../../services/unlock.service');
const { checkAndHandleCourseCompletion } = require('../../services/completion.service');

/** GET /student/quizzes/:quizId */
const getQuiz = asyncHandler(async (req, res) => {
  const { quizId } = req.params;
  const userId = req.user.id;

  const quiz = await Quiz.findById(quizId).lean();
  if (!quiz) {
    return sendError(res, 'Quiz not found.', 404, 'NOT_FOUND');
  }

  // Admin preview: read-only — enrollment not required, locks relaxed (display only).
  const isAdminPreview = req.user.role === 'admin';
  const enrolled = await isEnrolled(userId, quiz.courseId);
  if (!enrolled && !isAdminPreview) {
    return sendError(res, 'You are not enrolled in this course.', 403, 'NOT_ENROLLED');
  }

  // Unlock check
  const unlockMap = await getUnlockMap(userId, quiz.courseId);
  let isLocked = false;
  let lockedReason = null;

  if (quiz.scope === 'unit') {
    const entry = unlockMap.unitStatuses[quiz.scopeId.toString()];
    isLocked = !entry || entry.status === 'locked';
    lockedReason = entry?.lockedReason || 'Complete previous lessons to unlock this quiz.';
  } else if (quiz.scope === 'module') {
    const entry = unlockMap.moduleQuizStatuses[quiz._id.toString()];
    isLocked = !entry || entry.status === 'locked';
    lockedReason = entry?.lockedReason || 'Complete all lessons in this module to unlock the quiz.';
  } else if (quiz.scope === 'course') {
    isLocked = unlockMap.finalAssessmentStatus?.status === 'locked';
    lockedReason = unlockMap.finalAssessmentStatus?.lockedReason || 'Complete all lessons to unlock the final assessment.';
  }

  if (isLocked && !isAdminPreview) {
    return sendError(res, lockedReason || 'This quiz is currently locked.', 403, 'QUIZ_LOCKED');
  }

  // Attempt statistics
  const attempts = await QuizAttempt.find({ userId, quizId }).lean();
  const attemptCount = attempts.length;
  const passed = attempts.some((a) => a.passed === true);
  const bestScore = attempts.length > 0 ? Math.max(...attempts.map((a) => a.score || 0)) : 0;

  const maxAttempts = quiz.maxAttempts || 0;
  const attemptsRemaining = maxAttempts === 0 ? null : Math.max(maxAttempts - attemptCount, 0);

  // SANITIZE: Never leak isCorrect to student
  const sanitizedQuestions = (quiz.questions || []).map((q) => ({
    id: q._id,
    text: q.text,
    type: q.type,
    options: (q.options || []).map((opt) => ({
      id: opt._id,
      text: opt.text,
    })),
  }));

  sendSuccess(res, {
    id: quiz._id,
    title: quiz.title,
    passMark: quiz.passMark,
    required: quiz.required,
    timeLimitMinutes: null,
    maxAttempts,
    attemptsRemaining,
    passed,
    bestScore,
    preview: isAdminPreview,
    questions: sanitizedQuestions,
  });
});

/** POST /student/quizzes/:quizId/submit */
const submitQuiz = asyncHandler(async (req, res) => {
  const { quizId } = req.params;
  const userId = req.user.id;
  const { answers = [] } = req.body;

  const quiz = await Quiz.findById(quizId).lean();
  if (!quiz) {
    return sendError(res, 'Quiz not found.', 404, 'NOT_FOUND');
  }

  // Admin preview must NEVER write quiz attempts (preview ≠ participation).
  if (req.user.role === 'admin') {
    return sendError(res, 'Preview mode: submissions are disabled while previewing as an admin.', 403, 'PREVIEW_READ_ONLY');
  }

  const enrolled = await isEnrolled(userId, quiz.courseId);
  if (!enrolled) {
    return sendError(res, 'You are not enrolled in this course.', 403, 'NOT_ENROLLED');
  }

  // Check attempt limit
  const maxAttempts = quiz.maxAttempts || 0;
  if (maxAttempts > 0) {
    const existingAttempts = await QuizAttempt.countDocuments({ userId, quizId });
    if (existingAttempts >= maxAttempts) {
      return sendError(
        res,
        'You have used all your quiz attempts for this quiz.',
        429,
        'ATTEMPT_LIMIT_REACHED'
      );
    }
  }

  // ── SERVER-SIDE GRADING ───────────────────────────────────────────────────
  const questions = quiz.questions || [];
  const totalQuestions = questions.length;
  let correctCount = 0;
  const review = [];

  // Map incoming answers by questionId string
  const answerMap = new Map();
  for (const ans of answers) {
    if (ans.questionId) {
      answerMap.set(ans.questionId.toString(), ans.selectedOptionIds || []);
    }
  }

  for (const q of questions) {
    const qid = q._id.toString();
    const studentSelected = (answerMap.get(qid) || []).map(String);

    const correctOptionIds = (q.options || [])
      .filter((opt) => opt.isCorrect === true)
      .map((opt) => opt._id.toString());

    let isQuestionCorrect = false;

    if (q.type === 'single' || q.type === 'true_false') {
      isQuestionCorrect =
        studentSelected.length === 1 &&
        correctOptionIds.length === 1 &&
        studentSelected[0] === correctOptionIds[0];
    } else if (q.type === 'multiple') {
      const selectedSet = new Set(studentSelected);
      const correctSet = new Set(correctOptionIds);
      isQuestionCorrect =
        selectedSet.size === correctSet.size &&
        [...selectedSet].every((id) => correctSet.has(id));
    }

    if (isQuestionCorrect) correctCount += 1;

    review.push({
      questionId: q._id,
      correct: isQuestionCorrect,
      explanation: q.explanation || null,
    });
  }

  const scorePercent = totalQuestions > 0 ? Math.round((correctCount / totalQuestions) * 100) : 0;
  const passed = scorePercent >= (quiz.passMark ?? 70);

  // Record attempt
  await QuizAttempt.create({
    userId,
    quizId: quiz._id,
    courseId: quiz.courseId,
    answers,
    score: scorePercent,
    passed,
  });

  const totalAttemptsSoFar = await QuizAttempt.countDocuments({ userId, quizId });
  const attemptsRemaining = maxAttempts === 0 ? null : Math.max(maxAttempts - totalAttemptsSoFar, 0);

  // Check if unit should now be completed
  let unitCompleted = false;
  if (quiz.scope === 'unit' && passed) {
    const unit = await Unit.findById(quiz.scopeId).lean();
    if (unit) {
      const progress = await Progress.findOne({ userId, unitId: unit._id });
      // If video completed (or no video required)
      const hasVideo = !!(unit.video && unit.video.url);
      const videoDone = !hasVideo || progress?.videoCompleted === true;

      if (videoDone) {
        await Progress.findOneAndUpdate(
          { userId, unitId: unit._id },
          {
            $set: {
              completed: true,
              completedAt: new Date(),
            },
          },
          { upsert: true }
        );
        unitCompleted = true;
      }
    }
  }

  // Authoritative course completion + certificate state (covers final assessment / last unit)
  let courseCompleted = false;
  let certificate = null;
  let moduleCompleted = false;
  if (passed) {
    const handled = await checkAndHandleCourseCompletion(userId, quiz.courseId);
    courseCompleted = handled.courseCompleted;
    certificate = handled.certificate;
    // If the unit quiz just completed its unit, did that finish the module too?
    if (unitCompleted && quiz.scope === 'unit') {
      const completedUnit = await Unit.findById(quiz.scopeId).select('moduleId').lean();
      if (completedUnit) {
        const siblings = await Unit.find({ moduleId: completedUnit.moduleId }).select('_id').lean();
        const done = await Progress.countDocuments({ userId, moduleId: completedUnit.moduleId, completed: true });
        moduleCompleted = siblings.length > 0 && done >= siblings.length;
      }
    }
  }

  sendSuccess(res, {
    scorePercent,
    passed,
    correctCount,
    totalQuestions,
    attemptsRemaining,
    message: passed
      ? 'Great job! You passed the quiz.'
      : 'Keep trying. Review the lesson and try again.',
    review,
    unitCompleted,
    moduleCompleted,
    courseCompleted,
    certificate,
  });
});

module.exports = {
  getQuiz,
  submitQuiz,
};
