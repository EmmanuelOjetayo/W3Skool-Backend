'use strict';

const User = require('../../models/User');
const Progress = require('../../models/Progress');
const QuizAttempt = require('../../models/QuizAttempt');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess } = require('../../utils/response');

const PERIOD_DAYS = { weekly: 7, monthly: 30, overall: null };
const POINTS = { perUnit: 10, perQuiz: 50 };

/**
 * GET /student/leaderboard?period=weekly|monthly|overall
 * Real performance data only: units completed × 10 + quizzes passed × 50.
 * Students only — admins never appear (preview ≠ participation).
 */
const getLeaderboard = asyncHandler(async (req, res) => {
  const period = ['weekly', 'monthly', 'overall'].includes(req.query.period) ? req.query.period : 'overall';
  const days = PERIOD_DAYS[period];
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;

  const unitMatch = since ? { completed: true, completedAt: { $gte: since } } : { completed: true };
  const quizMatch = since ? { passed: true, createdAt: { $gte: since } } : { passed: true };

  const [unitAgg, quizAgg] = await Promise.all([
    Progress.aggregate([
      { $match: unitMatch },
      { $group: { _id: '$userId', units: { $sum: 1 }, lastActiveAt: { $max: '$completedAt' } } },
    ]),
    QuizAttempt.aggregate([
      { $match: quizMatch },
      { $group: { _id: '$userId', quizzes: { $sum: 1 }, lastQuizAt: { $max: '$createdAt' } } },
    ]),
  ]);

  const unitsBy = new Map(unitAgg.map((x) => [String(x._id), x]));
  const quizzesBy = new Map(quizAgg.map((x) => [String(x._id), x]));
  const activeIds = [...new Set([...unitsBy.keys(), ...quizzesBy.keys()])];
  const users = activeIds.length
    ? await User.find({ _id: { $in: activeIds }, role: 'student' }).select('name email avatar').lean()
    : [];

  const entries = users
    .map((u) => {
      const ua = unitsBy.get(String(u._id)) || { units: 0 };
      const qa = quizzesBy.get(String(u._id)) || { quizzes: 0 };
      const units = ua.units || 0;
      const quizzes = qa.quizzes || 0;
      const times = [ua.lastActiveAt, qa.lastQuizAt].filter(Boolean).map((d) => new Date(d).getTime());
      return {
        userId: u._id,
        name: u.name,
        avatar: u.avatar || null,
        unitsCompleted: units,
        quizzesPassed: quizzes,
        score: units * POINTS.perUnit + quizzes * POINTS.perQuiz,
        lastActiveAt: times.length ? new Date(Math.max(...times)) : null,
      };
    })
    .sort((a, b) =>
      b.score - a.score ||
      new Date(b.lastActiveAt || 0).getTime() - new Date(a.lastActiveAt || 0).getTime() ||
      String(a.name).localeCompare(String(b.name))
    );

  entries.forEach((e, i) => { e.rank = i + 1; });

  const me = entries.find((e) => String(e.userId) === String(req.user.id)) || null;
  sendSuccess(res, { period, entries: entries.slice(0, 50), me, scoring: POINTS });
});

module.exports = { getLeaderboard };