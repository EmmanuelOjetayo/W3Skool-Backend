'use strict';

const LiveSession = require('../../models/LiveSession');
const Course = require('../../models/Course');
const Enrollment = require('../../models/Enrollment');
const User = require('../../models/User');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');
const { sendLiveSession } = require('../../services/email.service');

/** Only the owning admin (or a platform-owned course) may manage the session. */
const canManageCourse = (course, userId) => !course.owner || course.owner.toString() === userId.toString();

/**
 * Notify enrolled students about a live session (asynchronous, idempotent per revision).
 * Returns the number of students queued.
 */
const notifyEnrolledStudents = async (session, course) => {
  const enrollments = await Enrollment.find({ courseId: course._id }).select('userId').lean();
  const userIds = enrollments.map((e) => e.userId);
  if (userIds.length === 0) return 0;

  const students = await User.find({ _id: { $in: userIds } }).select('name email').lean();
  const revision = session.notifiedRevision || 0;
  for (const s of students) {
    if (!s.email) continue;
    sendLiveSession({
      sessionId: session._id.toString(),
      revision,
      email: s.email,
      name: s.name,
      title: session.title,
      courseTitle: course.title,
      startsAt: session.startsAt,
      platform: session.platform,
      joinUrl: session.joinUrl,
    });
  }
  return students.length;
};

/**
 * Compute session status from wall-clock time.
 */
const computeStatus = (session) => {
  const now = Date.now();
  const start = new Date(session.startsAt).getTime();
  const end = start + (session.durationMinutes || 60) * 60 * 1000;
  const joinWindow = start - 15 * 60 * 1000;

  if (now < joinWindow) return 'scheduled';
  if (now >= joinWindow && now < end) return 'live';
  return 'ended';
};

/** GET /admin/live-sessions */
const getLiveSessions = asyncHandler(async (req, res) => {
  const sessions = await LiveSession.find().sort('-startsAt').lean();

  const formatted = await Promise.all(
    sessions.map(async (s) => {
      const course = await Course.findById(s.courseId).select('title').lean();
      return {
        id: s._id,
        courseId: s.courseId,
        courseTitle: course ? course.title : 'Unknown Course',
        title: s.title,
        startsAt: s.startsAt,
        durationMinutes: s.durationMinutes,
        platform: s.platform,
        joinUrl: s.joinUrl,
        notes: s.notes || '',
        status: computeStatus(s),
      };
    })
  );

  sendSuccess(res, formatted);
});

/** POST /admin/live-sessions */
const createLiveSession = asyncHandler(async (req, res) => {
  const { courseId, title, startsAt, durationMinutes = 60, platform = 'google_meet', joinUrl, notes } = req.body;
  const notifyStudents = req.body.notifyStudents !== false;

  if (!courseId || !title || !startsAt || !joinUrl) {
    return sendError(res, 'courseId, title, startsAt, and joinUrl are required.', 422, 'VALIDATION_ERROR');
  }

  const course = await Course.findById(courseId).lean();
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!canManageCourse(course, req.user.id)) {
    return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');
  }

  const session = await LiveSession.create({
    courseId,
    title,
    startsAt: new Date(startsAt),
    durationMinutes,
    platform,
    joinUrl,
    notes,
    notifyStudents,
    notifiedRevision: notifyStudents ? 1 : 0,
  });

  // Notify enrolled students (asynchronous, idempotent)
  let notified = false;
  if (notifyStudents) {
    await notifyEnrolledStudents(session, course);
    session.notifiedAt = new Date();
    await session.save();
    notified = true;
  }

  sendSuccess(
    res,
    {
      id: session._id,
      courseId: session.courseId,
      courseTitle: course.title,
      title: session.title,
      startsAt: session.startsAt,
      durationMinutes: session.durationMinutes,
      platform: session.platform,
      joinUrl: session.joinUrl,
      notes: session.notes,
      notifyStudents,
      notified,
      status: computeStatus(session),
    },
    201
  );
});

/** PATCH /admin/live-sessions/:id */
const updateLiveSession = asyncHandler(async (req, res) => {
  const session = await LiveSession.findById(req.params.id);
  if (!session) return sendError(res, 'Live session not found.', 404, 'NOT_FOUND');

  const course = await Course.findById(session.courseId).lean();
  if (!course) return sendError(res, 'Course not found.', 404, 'COURSE_NOT_FOUND');
  if (!canManageCourse(course, req.user.id)) {
    return sendError(res, 'You do not have access to this course.', 403, 'FORBIDDEN');
  }

  const allowed = ['title', 'startsAt', 'durationMinutes', 'platform', 'joinUrl', 'notes'];
  let materialChange = false;
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      const next = f === 'startsAt' ? new Date(req.body[f]) : req.body[f];
      const changed = f === 'startsAt'
        ? new Date(session[f]).getTime() !== new Date(next).getTime()
        : session[f] !== next;
      if (changed && (f === 'title' || f === 'startsAt' || f === 'joinUrl')) materialChange = true;
      session[f] = next;
    }
  }

  const notifyStudents = req.body.notifyStudents !== undefined
    ? req.body.notifyStudents !== false
    : session.notifyStudents;
  session.notifyStudents = notifyStudents;

  // Notify on material change (or when explicitly requested), once per revision.
  let notified = false;
  if (notifyStudents && (materialChange || session.notifiedRevision === 0)) {
    session.notifiedRevision = (session.notifiedRevision || 0) + 1;
    await session.save();
    await notifyEnrolledStudents(session, course);
    session.notifiedAt = new Date();
    await session.save();
    notified = true;
  } else {
    await session.save();
  }

  sendSuccess(res, {
    id: session._id,
    courseId: session.courseId,
    courseTitle: course.title,
    title: session.title,
    startsAt: session.startsAt,
    durationMinutes: session.durationMinutes,
    platform: session.platform,
    joinUrl: session.joinUrl,
    notes: session.notes,
    notifyStudents,
    notified,
    status: computeStatus(session),
  });
});

/** DELETE /admin/live-sessions/:id */
const deleteLiveSession = asyncHandler(async (req, res) => {
  const session = await LiveSession.findByIdAndDelete(req.params.id);
  if (!session) return sendError(res, 'Live session not found.', 404, 'NOT_FOUND');

  sendSuccess(res, { message: 'Live session deleted.' });
});

module.exports = {
  getLiveSessions,
  createLiveSession,
  updateLiveSession,
  deleteLiveSession,
  computeStatus,
};
