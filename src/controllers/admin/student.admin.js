'use strict';

const User = require('../../models/User');
const Course = require('../../models/Course');
const Enrollment = require('../../models/Enrollment');
const Progress = require('../../models/Progress');
const Certificate = require('../../models/Certificate');
const Unit = require('../../models/Unit');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');

/** GET /admin/students?search=&courseId=&page=&limit=  — paginated { data, meta } */
const getStudents = asyncHandler(async (req, res) => {
  const { search, courseId } = req.query;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

  const query = { role: 'student' };
  if (search && search.trim()) {
    const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ name: regex }, { email: regex }];
  }
  // Optional: only students enrolled in a given course
  if (courseId) {
    const enrollments = await Enrollment.find({ courseId }).select('userId').lean();
    query._id = { $in: enrollments.map((e) => e.userId) };
  }

  const total = await User.countDocuments(query);
  const students = await User.find(query)
    .sort('-createdAt')
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const formatted = await Promise.all(
    students.map(async (u) => {
      const enrolledCourses = await Enrollment.countDocuments({ userId: u._id });
      return {
        id: u._id,
        name: u.name,
        email: u.email,
        phone: u.phone || null,
        createdAt: u.createdAt,
        enrolledCourses,
        lastActiveAt: u.lastActiveAt || u.createdAt,
      };
    })
  );

  sendSuccess(res, {
    data: formatted,
    meta: { page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1) },
  });
});

/** GET /admin/students/:id */
const getStudent = asyncHandler(async (req, res) => {
  const student = await User.findOne({ _id: req.params.id, role: 'student' }).lean();
  if (!student) return sendError(res, 'Student not found.', 404, 'NOT_FOUND');

  const enrollments = await Enrollment.find({ userId: student._id }).sort('-enrolledAt').lean();

  const enrollmentDetails = await Promise.all(
    enrollments.map(async (e) => {
      const course = await Course.findById(e.courseId).select('title unitCount').lean();
      const courseTitle = course ? course.title : 'Deleted Course';
      const totalUnits = course?.unitCount || 0;

      // Count completed units for this course
      const completedUnits = await Progress.countDocuments({
        userId: student._id,
        courseId: e.courseId,
        completed: true,
      });

      const progressPercent = totalUnits > 0
        ? Math.round((completedUnits / totalUnits) * 100)
        : 0;

      // Last activity
      const latestProgress = await Progress.findOne({
        userId: student._id,
        courseId: e.courseId,
      }).sort('-updatedAt').lean();

      const lastActivityAt = latestProgress ? latestProgress.updatedAt : e.enrolledAt;

      // Current unit title (first non-completed unit)
      let currentUnitTitle = null;
      const completedProgress = await Progress.find({
        userId: student._id,
        courseId: e.courseId,
        completed: true,
      }).select('unitId').lean();

      const completedIds = new Set(completedProgress.map((p) => p.unitId.toString()));
      const incompleteUnit = await Unit.findOne({
        courseId: e.courseId,
        _id: { $nin: Array.from(completedIds) },
      }).sort('order').select('title').lean();

      if (incompleteUnit) {
        currentUnitTitle = incompleteUnit.title;
      }

      // Certificate issued
      const cert = await Certificate.findOne({ userId: student._id, courseId: e.courseId }).select('_id').lean();

      return {
        courseId: e.courseId,
        title: courseTitle,
        progressPercent,
        enrolledAt: e.enrolledAt,
        completedAt: e.completedAt || null,
        lastActivityAt,
        currentUnitTitle,
        certificateIssued: !!cert,
      };
    })
  );

  sendSuccess(res, {
    student: {
      id: student._id,
      name: student.name,
      email: student.email,
      phone: student.phone || null,
      createdAt: student.createdAt,
    },
    enrollments: enrollmentDetails,
  });
});

/** GET /admin/courses/:courseId/students — per-course roster with real progress. Admins never listed (preview ≠ participation). */
const { requireOwnedCourse } = require('../../services/ownership.service');
const ModuleModel = Progress.db.model('Module');
const QuizModel = Progress.db.model('Quiz');
const QuizAttemptModel = Progress.db.model('QuizAttempt');
const { Types } = require('mongoose');

const loadOwnedCourse = async (courseId, adminId) => {
  try {
    await requireOwnedCourse(courseId, adminId);
  } catch (e) {
    return { error: e };
  }
  const course = await Course.findById(courseId).select('title unitCount moduleCount').lean();
  if (!course) return { error: { message: 'Course not found.', statusCode: 404, code: 'NOT_FOUND' } };
  return { course };
};

const getCourseStudents = asyncHandler(async (req, res) => {
  const { courseId } = req.params;
  const check = await loadOwnedCourse(courseId, req.user.id);
  if (check.error) return sendError(res, check.error.message, check.error.statusCode || 403, check.error.code || 'FORBIDDEN');
  const { course } = check;

  const enrollments = await Enrollment.find({ courseId: course._id }).sort('-enrolledAt').lean();
  const users = await User.find({ _id: { $in: enrollments.map((e) => e.userId) }, role: 'student' })
    .select('name email').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const [progressAgg, certDocs] = await Promise.all([
    Progress.aggregate([
      { $match: { courseId: course._id } },
      { $group: { _id: '$userId', completedUnits: { $sum: { $cond: ['$completed', 1, 0] } }, touched: { $sum: 1 }, lastAt: { $max: '$updatedAt' } } },
    ]),
    Certificate.find({ courseId: course._id }).select('userId').lean(),
  ]);
  const progByUser = new Map(progressAgg.map((p) => [String(p._id), p]));
  const certUserIds = new Set(certDocs.map((c) => String(c.userId)));
  const totalUnits = course.unitCount || 0;

  const students = enrollments
    .filter((e) => byId.has(String(e.userId)))
    .map((e) => {
      const u = byId.get(String(e.userId));
      const p = progByUser.get(String(e.userId));
      const completedUnits = p ? p.completedUnits : 0;
      return {
        id: e.userId,
        name: u.name,
        email: u.email,
        enrolledAt: e.enrolledAt,
        completed: !!e.completedAt,
        completedAt: e.completedAt || null,
        completedUnits,
        totalUnits,
        progressPercent: totalUnits > 0 ? Math.min(Math.round((completedUnits / totalUnits) * 100), 100) : 0,
        started: !!p && p.touched > 0,
        lastActivityAt: p ? p.lastAt : null,
        certificateIssued: certUserIds.has(String(e.userId)),
      };
    });

  sendSuccess(res, {
    course: { id: course._id, title: course.title, unitCount: totalUnits, moduleCount: course.moduleCount || 0 },
    students,
  });
});

/** GET /admin/courses/:courseId/students/:studentId — full record: progress, modules, quizzes, certificate. */
const getCourseStudentRecord = asyncHandler(async (req, res) => {
  const { courseId, studentId } = req.params;
  const check = await loadOwnedCourse(courseId, req.user.id);
  if (check.error) return sendError(res, check.error.message, check.error.statusCode || 403, check.error.code || 'FORBIDDEN');
  const { course } = check;

  if (!Types.ObjectId.isValid(studentId)) return sendError(res, 'Student not found.', 404, 'NOT_FOUND');
  const student = await User.findOne({ _id: new Types.ObjectId(studentId), role: 'student' })
    .select('name email createdAt').lean();
  if (!student) return sendError(res, 'Student not found.', 404, 'NOT_FOUND');

  const enrollment = await Enrollment.findOne({ userId: student._id, courseId: course._id }).lean();
  if (!enrollment) return sendError(res, 'This student is not enrolled in this course.', 404, 'NOT_FOUND');

  const modules = await ModuleModel.find({ courseId: course._id }).sort('order').lean();
  const [unitProgress, attempts, cert, latest] = await Promise.all([
    Progress.find({ userId: student._id, courseId: course._id }).select('unitId completed updatedAt').lean(),
    QuizAttemptModel.find({ userId: student._id, courseId: course._id }).lean(),
    Certificate.findOne({ userId: student._id, courseId: course._id }).select('code issuedAt pdfUrl').lean(),
    Progress.findOne({ userId: student._id, courseId: course._id }).sort('-updatedAt').select('updatedAt').lean(),
  ]);

  const completedUnitIds = new Set(unitProgress.filter((p) => p.completed).map((p) => String(p.unitId)));
  const totalUnits = course.unitCount || 0;

  const moduleRows = [];
  for (const m of modules) {
    const mUnits = await Unit.find({ moduleId: m._id }).select('_id').lean();
    const done = mUnits.filter((u) => completedUnitIds.has(String(u._id))).length;
    moduleRows.push({
      title: m.title,
      totalUnits: mUnits.length,
      completedUnits: done,
      percent: mUnits.length > 0 ? Math.round((done / mUnits.length) * 100) : 0,
    });
  }

  const quizzesBy = new Map();
  for (const a of attempts) {
    const key = String(a.quizId);
    const cur = quizzesBy.get(key) || { quizId: a.quizId, attempts: 0, bestScore: 0, passed: false, lastAttemptAt: null };
    cur.attempts += 1;
    cur.bestScore = Math.max(cur.bestScore, a.score || 0);
    cur.passed = cur.passed || a.passed === true;
    if (!cur.lastAttemptAt || new Date(a.createdAt) > new Date(cur.lastAttemptAt)) cur.lastAttemptAt = a.createdAt;
    quizzesBy.set(key, cur);
  }
  const quizRows = [];
  for (const row of quizzesBy.values()) {
    const quiz = await QuizModel.findById(row.quizId).select('title').lean();
    quizRows.push({
      title: quiz ? quiz.title : 'Quiz',
      attempts: row.attempts,
      bestScore: row.bestScore,
      passed: row.passed,
      lastAttemptAt: row.lastAttemptAt,
    });
  }
  quizRows.sort((a, b) => String(a.title).localeCompare(String(b.title)));

  const completedUnits = completedUnitIds.size;
  const progressPercent = totalUnits > 0 ? Math.min(Math.round((completedUnits / totalUnits) * 100), 100) : 0;
  const avgQuizScore = quizRows.length > 0 ? Math.round(quizRows.reduce((s, q) => s + q.bestScore, 0) / quizRows.length) : 0;

  sendSuccess(res, {
    student: { id: student._id, name: student.name, email: student.email, joinedAt: student.createdAt },
    enrollment: {
      enrolledAt: enrollment.enrolledAt,
      completedAt: enrollment.completedAt || null,
      lastActivityAt: latest ? latest.updatedAt : enrollment.enrolledAt,
    },
    performance: {
      progressPercent,
      completedUnits,
      totalUnits,
      quizzesPassed: quizRows.filter((q) => q.passed).length,
      avgQuizScore,
    },
    modules: moduleRows,
    quizzes: quizRows,
    certificate: cert ? { code: cert.code, issuedAt: cert.issuedAt, pdfUrl: cert.pdfUrl || null } : null,
  });
});

module.exports = {
  getStudents,
  getStudent,
  getCourseStudents,
  getCourseStudentRecord,
};
