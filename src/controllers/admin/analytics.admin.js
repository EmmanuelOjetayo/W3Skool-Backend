'use strict';

const User = require('../../models/User');
const Course = require('../../models/Course');
const Payment = require('../../models/Payment');
const Enrollment = require('../../models/Enrollment');
const Progress = require('../../models/Progress');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { ownedCourseFilter, requireOwnedCourse } = require('../../services/ownership.service');

/** GET /admin/stats — scoped to courses this admin owns (incl. legacy null-owner). */
const getOverview = asyncHandler(async (req, res) => {
  const ownCourses = await Course.find(ownedCourseFilter(req.user.id)).lean();
  const ownCourseIds = ownCourses.map((c) => c._id);
  const courseScope = { $in: ownCourseIds };

  const [
    enrolledStudentIds,
    paymentsVerified,
    revenueAgg,
    recentPaymentsRaw,
  ] = await Promise.all([
    Enrollment.distinct('userId', { courseId: courseScope }),
    Payment.countDocuments({ status: 'verified', courseId: courseScope }),
    Payment.aggregate([
      { $match: { status: 'verified', courseId: courseScope } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Payment.find({ status: 'verified', courseId: courseScope })
      .sort('-paidAt -createdAt')
      .limit(8)
      .lean(),
  ]);

  const totalStudents = enrolledStudentIds.length;
  const totalCourses = ownCourses.length;
  const publishedCourses = ownCourses.filter((c) => c.status === 'published').length;
  const revenueTotal = revenueAgg[0]?.total || 0;

  const recentPayments = await Promise.all(
    recentPaymentsRaw.map(async (p) => {
      const [user, course] = await Promise.all([
        User.findById(p.userId).select('name email').lean(),
        Course.findById(p.courseId).select('title').lean(),
      ]);
      return {
        id: p._id,
        txRef: p.txRef,
        flwTransactionId: p.flwTransactionId || null,
        studentName: user ? user.name : 'Unknown Student',
        email: user ? user.email : 'Unknown Email',
        courseTitle: course ? course.title : 'Deleted Course',
        amount: p.amount,
        currency: p.currency || 'NGN',
        status: p.status,
        createdAt: p.createdAt,
        paidAt: p.paidAt || null,
      };
    })
  );

  sendSuccess(res, {
    totalStudents,
    totalCourses,
    publishedCourses,
    paymentsVerified,
    revenueTotal,
    currency: 'NGN',
    recentPayments,
  });
});

/** GET /admin/courses/:courseId/stats */
const getCourseStats = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  try {
    await requireOwnedCourse(courseId, req.user.id);
  } catch (e) {
    return sendError(res, e.message, e.statusCode || 403, e.code || 'FORBIDDEN');
  }
  const course = await Course.findById(courseId).lean();
  if (!course) return sendError(res, 'Course not found.', 404, 'NOT_FOUND');

  // Only real students count — an admin previewing never appears here.
  const enrollments = await Enrollment.find({ courseId }).select('userId enrolledAt completedAt').lean();
  const users = await User.find({ _id: { $in: enrollments.map((e) => e.userId) }, role: 'student' }).select('_id').lean();
  const studentIdSet = new Set(users.map((u) => u._id.toString()));
  const studentEnrollments = enrollments.filter((e) => studentIdSet.has(e.userId.toString()));

  const [progressAgg, quizAgg] = await Promise.all([
    Progress.aggregate([
      { $match: { courseId: course._id, userId: { $in: studentEnrollments.map((e) => e.userId) } } },
      { $group: { _id: '$userId', completedUnits: { $sum: { $cond: ['$completed', 1, 0] } }, touched: { $sum: 1 } } },
    ]),
    Progress.db.model('QuizAttempt').aggregate([
      { $match: { courseId: course._id, userId: { $in: studentEnrollments.map((e) => e.userId) } } },
      { $group: { _id: null, attempts: { $sum: 1 }, passedAttempts: { $sum: { $cond: ['$passed', 1, 0] } }, avgScore: { $avg: '$score' } } },
    ]),
  ]);
  const progByUser = new Map(progressAgg.map((p) => [String(p._id), p]));

  const totalUnits = course.unitCount || 0;
  let completed = 0;
  let inProgress = 0;
  let notStarted = 0;
  let percentSum = 0;
  for (const e of studentEnrollments) {
    const p = progByUser.get(String(e.userId));
    const pct = totalUnits > 0 && p ? Math.min(Math.round((p.completedUnits / totalUnits) * 100), 100) : 0;
    percentSum += pct;
    if (e.completedAt || pct === 100) completed += 1;
    else if (p && p.touched > 0) inProgress += 1;
    else notStarted += 1;
  }

  const totalEnrolled = studentEnrollments.length;
  const averageProgress = totalEnrolled > 0 ? Math.round(percentSum / totalEnrolled) : 0;
  const quiz = quizAgg[0] || { attempts: 0, passedAttempts: 0, avgScore: 0 };

  sendSuccess(res, {
    courseId,
    title: course.title,
    // Legacy fields (kept for compatibility)
    enrollmentCount: totalEnrolled,
    completionCount: completed,
    averageProgress,
    // Rich analytics
    totals: {
      enrolled: totalEnrolled,
      completed,
      inProgress,
      notStarted,
      completionRate: totalEnrolled > 0 ? Math.round((completed / totalEnrolled) * 100) : 0,
      averageProgress,
    },
    quiz: {
      attempts: quiz.attempts || 0,
      passRate: quiz.attempts > 0 ? Math.round((quiz.passedAttempts / quiz.attempts) * 100) : 0,
      averageScore: Math.round(quiz.avgScore || 0),
    },
    units: { total: totalUnits },
  });
});

module.exports = {
  getOverview,
  getCourseStats,
};
