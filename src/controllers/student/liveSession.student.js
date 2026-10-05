'use strict';

const LiveSession = require('../../models/LiveSession');
const Course = require('../../models/Course');
const Enrollment = require('../../models/Enrollment');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess } = require('../../utils/response');
const { computeStatus } = require('../admin/liveSession.admin');

/** GET /student/live-sessions?upcoming=true */
const getLiveSessions = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { upcoming } = req.query;

  // Find enrolled course IDs
  const enrollments = await Enrollment.find({ userId }).select('courseId').lean();
  const enrolledCourseIds = enrollments.map((e) => e.courseId);

  if (enrolledCourseIds.length === 0) {
    return sendSuccess(res, []);
  }

  const query = { courseId: { $in: enrolledCourseIds } };

  // Upcoming filter: includes ongoing sessions
  if (upcoming === 'true') {
    const buffer = new Date(Date.now() - 60 * 60 * 1000); // within last hour
    query.startsAt = { $gte: buffer };
  }

  const sessions = await LiveSession.find(query).sort('startsAt').lean();

  const formatted = await Promise.all(
    sessions.map(async (s) => {
      const course = await Course.findById(s.courseId).select('title').lean();
      const startsAtMs = new Date(s.startsAt).getTime();
      const joinOpensAt = new Date(startsAtMs - 15 * 60 * 1000);
      const nowMs = Date.now();
      const status = computeStatus(s);

      const isJoinOpen = nowMs >= joinOpensAt.getTime() && status !== 'ended';

      return {
        id: s._id,
        courseId: s.courseId,
        courseTitle: course ? course.title : 'W3Skool Course',
        title: s.title,
        startsAt: s.startsAt,
        durationMinutes: s.durationMinutes,
        platform: s.platform,
        status,
        joinUrl: isJoinOpen ? s.joinUrl : null,
        joinOpensAt: joinOpensAt.toISOString(),
        notes: s.notes || '',
      };
    })
  );

  sendSuccess(res, formatted);
});

module.exports = {
  getLiveSessions,
};
