'use strict';

const Quiz = require('../../models/Quiz');
const Unit = require('../../models/Unit');
const Module = require('../../models/Module');
const Course = require('../../models/Course');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { requireOwnedCourse } = require('../../services/ownership.service');

/**
 * Format quiz for admin response (includes isCorrect on options).
 */
const formatAdminQuiz = (quiz) => {
  if (!quiz) return null;
  return {
    id: quiz._id,
    title: quiz.title,
    passMark: quiz.passMark,
    maxAttempts: quiz.maxAttempts,
    required: quiz.required,
    questions: (quiz.questions || []).map((q) => ({
      id: q._id,
      text: q.text,
      type: q.type,
      explanation: q.explanation || null,
      options: (q.options || []).map((opt) => ({
        id: opt._id,
        text: opt.text,
        isCorrect: opt.isCorrect,
      })),
    })),
  };
};

/**
 * Determine scope, scopeId, and courseId from request.
 */
const resolveScopeContext = async (req) => {
  const scope = req.quizScope;
  const scopeId = req.quizScopeId || req.params.id;

  let courseId = null;

  if (scope === 'unit') {
    const unit = await Unit.findById(scopeId).select('courseId').lean();
    if (!unit) return null;
    courseId = unit.courseId;
  } else if (scope === 'module') {
    const mod = await Module.findById(scopeId).select('courseId').lean();
    if (!mod) return null;
    courseId = mod.courseId;
  } else if (scope === 'course') {
    const course = await Course.findById(scopeId).select('_id').lean();
    if (!course) return null;
    courseId = course._id;
  }

  return { scope, scopeId, courseId };
};

/** GET /admin/(units|modules|courses)/:id/quiz */
const getQuiz = asyncHandler(async (req, res) => {
  const ctx = await resolveScopeContext(req);
  if (!ctx) return sendError(res, 'Target resource not found.', 404, 'NOT_FOUND');
  try {
    await requireOwnedCourse(ctx.courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  const quiz = await Quiz.findOne({ scope: ctx.scope, scopeId: ctx.scopeId }).lean();
  sendSuccess(res, formatAdminQuiz(quiz));
});

/** PUT /admin/(units|modules|courses)/:id/quiz */
const upsertQuiz = asyncHandler(async (req, res) => {
  const ctx = await resolveScopeContext(req);
  if (!ctx) return sendError(res, 'Target resource not found.', 404, 'NOT_FOUND');
  try {
    await requireOwnedCourse(ctx.courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  const { title, passMark = 70, maxAttempts = 3, required = true, questions } = req.body;

  if (!title) {
    return sendError(res, 'Quiz title is required.', 422, 'VALIDATION_ERROR');
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    return sendError(res, 'At least one question is required.', 422, 'VALIDATION_ERROR');
  }

  // Validate questions & options
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (!q.text) {
      return sendError(res, `Question ${i + 1} must have text.`, 422, 'VALIDATION_ERROR');
    }
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return sendError(res, `Question "${q.text}" must have at least 2 options.`, 422, 'VALIDATION_ERROR');
    }

    const correctOptions = q.options.filter((o) => o.isCorrect === true);
    if (correctOptions.length === 0) {
      return sendError(res, `Question "${q.text}" must have at least one correct option.`, 422, 'VALIDATION_ERROR');
    }

    if ((q.type === 'single' || q.type === 'true_false') && correctOptions.length > 1) {
      return sendError(res, `Question "${q.text}" of type ${q.type} must have exactly one correct option.`, 422, 'VALIDATION_ERROR');
    }
  }

  // Structure questions for persistence
  const formattedQuestions = questions.map((q, idx) => ({
    ...(q.id ? { _id: q.id } : {}),
    text: q.text,
    type: q.type || 'single',
    explanation: q.explanation || null,
    order: idx + 1,
    options: q.options.map((opt) => ({
      ...(opt.id ? { _id: opt.id } : {}),
      text: opt.text,
      isCorrect: !!opt.isCorrect,
    })),
  }));

  let quiz = await Quiz.findOne({ scope: ctx.scope, scopeId: ctx.scopeId });

  if (quiz) {
    quiz.title = title;
    quiz.passMark = passMark;
    quiz.maxAttempts = maxAttempts;
    quiz.required = required;
    quiz.questions = formattedQuestions;
    await quiz.save();
  } else {
    quiz = await Quiz.create({
      scope: ctx.scope,
      scopeId: ctx.scopeId,
      courseId: ctx.courseId,
      title,
      passMark,
      maxAttempts,
      required,
      questions: formattedQuestions,
    });
  }

  // Synchronize reference on owner model
  if (ctx.scope === 'unit') {
    await Unit.findByIdAndUpdate(ctx.scopeId, { quizId: quiz._id });
  } else if (ctx.scope === 'module') {
    await Module.findByIdAndUpdate(ctx.scopeId, { quizId: quiz._id });
  } else if (ctx.scope === 'course') {
    await Course.findByIdAndUpdate(ctx.scopeId, {
      hasFinalAssessment: true,
      finalAssessmentQuizId: quiz._id,
    });
  }

  sendSuccess(res, formatAdminQuiz(quiz.toObject ? quiz.toObject() : quiz));
});

/** DELETE /admin/(units|modules|courses)/:id/quiz */
const deleteQuiz = asyncHandler(async (req, res) => {
  const ctx = await resolveScopeContext(req);
  if (!ctx) return sendError(res, 'Target resource not found.', 404, 'NOT_FOUND');
  try {
    await requireOwnedCourse(ctx.courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }

  await Quiz.deleteOne({ scope: ctx.scope, scopeId: ctx.scopeId });

  if (ctx.scope === 'unit') {
    await Unit.findByIdAndUpdate(ctx.scopeId, { quizId: null });
  } else if (ctx.scope === 'module') {
    await Module.findByIdAndUpdate(ctx.scopeId, { quizId: null });
  } else if (ctx.scope === 'course') {
    await Course.findByIdAndUpdate(ctx.scopeId, {
      hasFinalAssessment: false,
      finalAssessmentQuizId: null,
    });
  }

  sendSuccess(res, { message: 'Quiz deleted.' });
});

module.exports = {
  getQuiz,
  upsertQuiz,
  deleteQuiz,
};
