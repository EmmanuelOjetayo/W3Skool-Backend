'use strict';

const Course = require('../../models/Course');
const Module = require('../../models/Module');
const Unit = require('../../models/Unit');
const Enrollment = require('../../models/Enrollment');
const Progress = require('../../models/Progress');
const QuizAttempt = require('../../models/QuizAttempt');
const Certificate = require('../../models/Certificate');
const LiveSession = require('../../models/LiveSession');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess } = require('../../utils/response');
const { getUnlockMap } = require('../../services/unlock.service');
const { computeStatus } = require('../admin/liveSession.admin');

/**
 * Format enrolled courses list for a student.
 */
const buildEnrolledCourses = async (userId) => {
  const enrollments = await Enrollment.find({ userId }).sort('-enrolledAt').lean();
  if (enrollments.length === 0) return [];

  const courseIds = enrollments.map((e) => e.courseId);
  const courses = await Course.find({ _id: { $in: courseIds } }).lean();
  const courseMap = new Map(courses.map((c) => [c._id.toString(), c]));

  const result = await Promise.all(
    enrollments.map(async (e) => {
      const course = courseMap.get(e.courseId.toString());
      if (!course) return null;

      const totalUnits = course.unitCount || 0;
      const completedUnits = await Progress.countDocuments({
        userId,
        courseId: course._id,
        completed: true,
      });

      const progressPercent = totalUnits > 0
        ? Math.min(Math.round((completedUnits / totalUnits) * 100), 100)
        : 0;

      // Resume item from unlock map
      const unlockMap = await getUnlockMap(userId, course._id);
      const resumeUnitId = unlockMap.resumeItem?.id || null;

      const cert = await Certificate.findOne({ userId, courseId: course._id }).select('_id code').lean();

      const status = e.completedAt || progressPercent === 100 ? 'completed' : 'in_progress';
      // `started` = the student has touched the course at all (authoritative, not inferred)
      const startedCount = await Progress.countDocuments({ userId, courseId: course._id });

      return {
        id: course._id,
        slug: course.slug,
        title: course.title,
        thumbnailUrl: course.thumbnailUrl,
        level: course.level,
        durationSeconds: course.totalDurationSeconds || 0,
        moduleCount: course.moduleCount || 0,
        progressPercent,
        status,
        started: startedCount > 0,
        resumeUnitId,
        certificateAvailable: !!cert,
      };
    })
  );

  return result.filter(Boolean);
};

/** GET /student/courses */
const getEnrolledCourses = asyncHandler(async (req, res) => {
  const courses = await buildEnrolledCourses(req.user.id);
  sendSuccess(res, courses);
});

/** GET /student/dashboard */
const getDashboard = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [courses, certCount, passedQuizzesCount, completedUnitsCount] = await Promise.all([
    buildEnrolledCourses(userId),
    Certificate.countDocuments({ userId }),
    QuizAttempt.countDocuments({ userId, passed: true }),
    Progress.countDocuments({ userId, completed: true }),
  ]);

  const coursesCompleted = courses.filter((c) => c.status === 'completed').length;

  // Continue learning: most recent incomplete course
  let continueLearning = null;
  const inProgressCourses = courses.filter((c) => c.status === 'in_progress');
  const targetCourse = inProgressCourses[0] || null;

  if (targetCourse && targetCourse.resumeUnitId) {
    const unit = await Unit.findById(targetCourse.resumeUnitId).lean();
    if (unit) {
      const mod = await Module.findById(unit.moduleId).select('title').lean();
      continueLearning = {
        courseId: targetCourse.id,
        courseTitle: targetCourse.title,
        moduleTitle: mod ? mod.title : '',
        unitId: unit._id,
        unitTitle: unit.title,
        progressPercent: targetCourse.progressPercent,
      };
    }
  }

  // Upcoming live sessions for enrolled courses
  const enrolledCourseIds = courses.map((c) => c.id);
  const now = new Date();
  const pastBuffer = new Date(Date.now() - 30 * 60 * 1000); // include ongoing

  const liveSessionsRaw = await LiveSession.find({
    courseId: { $in: enrolledCourseIds },
    startsAt: { $gte: pastBuffer },
  })
    .sort('startsAt')
    .limit(5)
    .lean();

  const upcomingLive = liveSessionsRaw.map((s) => {
    const course = courses.find((c) => c.id.toString() === s.courseId.toString());
    const startsAtMs = new Date(s.startsAt).getTime();
    const joinOpensAt = new Date(startsAtMs - 15 * 60 * 1000);
    const nowMs = Date.now();
    const status = computeStatus(s);

    const isJoinOpen = nowMs >= joinOpensAt.getTime() && status !== 'ended';

    return {
      id: s._id,
      courseId: s.courseId,
      courseTitle: course ? course.title : '',
      title: s.title,
      startsAt: s.startsAt,
      durationMinutes: s.durationMinutes,
      platform: s.platform,
      status,
      joinUrl: isJoinOpen ? s.joinUrl : null,
      joinOpensAt: joinOpensAt.toISOString(),
      notes: s.notes || '',
    };
  });

  // Authoritative dashboard state (A/B/C/D) so the client never infers it
  const hasIncomplete = courses.some((c) => c.status !== 'completed');
  let state = 'A';
  if (courses.length > 0) state = continueLearning ? 'C' : (hasIncomplete ? 'B' : 'D');
  const startCourse = state === 'B' ? (courses.find((c) => c.status !== 'completed') || null) : null;

  // Certificates earned (dashboard "Certificates" section)
  const certs = await Certificate.find({ userId }).select('code issuedAt pdfUrl courseId').sort('-issuedAt').lean();
  let certificates = [];
  if (certs.length) {
    const certCourses = await Course.find({ _id: { $in: certs.map((c) => c.courseId) } }).select('title').lean();
    const titleById = new Map(certCourses.map((c) => [String(c._id), c.title]));
    certificates = certs.map((c) => ({
      courseId: c.courseId,
      courseTitle: titleById.get(String(c.courseId)) || 'W3Skool Course',
      code: c.code,
      issuedAt: c.issuedAt,
      pdfUrl: c.pdfUrl || null,
    }));
  }

  sendSuccess(res, {
    state,
    startCourse,
    continueLearning,
    courses,
    upcomingLive,
    certificates,
    achievements: {
      unitsCompleted: completedUnitsCount,
      quizzesPassed: passedQuizzesCount,
      coursesCompleted,
      certificates: certCount,
    },
  });
});

module.exports = {
  getDashboard,
  getEnrolledCourses,
};
