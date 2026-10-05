'use strict';

const Payment = require('../../models/Payment');
const User = require('../../models/User');
const Course = require('../../models/Course');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess } = require('../../utils/response');
const { ownedCourseFilter } = require('../../services/ownership.service');

/** GET /admin/payments?status=&limit= */
const getPayments = asyncHandler(async (req, res) => {
  const { status, limit = 50 } = req.query;
  const parsedLimit = Math.min(parseInt(limit, 10) || 50, 100);

  const query = {};
  if (status && ['pending', 'verified', 'failed'].includes(status)) {
    query.status = status;
  }

  // An admin only sees payments for courses they own.
  const ownCourses = await Course.find(ownedCourseFilter(req.user.id)).select('_id').lean();
  query.courseId = { $in: ownCourses.map((c) => c._id) };

  const payments = await Payment.find(query)
    .sort('-createdAt')
    .limit(parsedLimit)
    .lean();

  const formatted = await Promise.all(
    payments.map(async (p) => {
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
        baseAmount: p.baseAmount ?? null,
        feeAmount: p.feeAmount ?? 0,
        totalAmount: p.totalAmount ?? p.amount,
        ownerShare: p.ownerShare ?? null,
        platformShare: p.platformShare ?? null,
        currency: p.currency || 'NGN',
        status: p.status,
        createdAt: p.createdAt,
        paidAt: p.paidAt || null,
      };
    })
  );

  sendSuccess(res, formatted);
});

/**
 * GET /admin/payments/analytics — trailing 12 months of verified sales for the
 * bar chart + all-time totals (gross, platform net, instructor share, fees).
 */
const getPaymentsAnalytics = asyncHandler(async (req, res) => {
  const ownCourses = await Course.find(ownedCourseFilter(req.user.id)).select('_id').lean();
  const courseScope = { $in: ownCourses.map((c) => c._id) };

  // First day of the month, 11 months back (=> 12 calendar months incl. current).
  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);
  since.setMonth(since.getMonth() - 11);

  const [monthlyRaw, totalsAgg] = await Promise.all([
    Payment.aggregate([
      { $match: { status: 'verified', courseId: courseScope } },
      { $project: { amount: 1, date: { $ifNull: ['$paidAt', '$createdAt'] } } },
      { $match: { date: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$date', timezone: 'Africa/Lagos' } },
          revenue: { $sum: '$amount' },
          payments: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Payment.aggregate([
      { $match: { status: 'verified', courseId: courseScope } },
      {
        $group: {
          _id: null,
          grossRevenue: { $sum: '$amount' },
          courseRevenue: { $sum: { $ifNull: ['$baseAmount', '$amount'] } },
          fees: { $sum: { $ifNull: ['$feeAmount', 0] } },
          platformShare: { $sum: { $ifNull: ['$platformShare', '$amount'] } },
          ownerShare: { $sum: { $ifNull: ['$ownerShare', 0] } },
          payments: { $sum: 1 },
        },
      },
    ]),
  ]);

  // Fill every month in the window (incl. empty ones) so the chart has 12 bars.
  const byKey = new Map(monthlyRaw.map((m) => [m._id, m]));
  const months = [];
  const cursor = new Date(since);
  for (let i = 0; i < 12; i++) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
    const hit = byKey.get(key);
    months.push({
      key,
      label: cursor.toLocaleDateString('en-NG', { month: 'short', year: '2-digit' }),
      revenue: hit ? hit.revenue : 0,
      payments: hit ? hit.payments : 0,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const t = totalsAgg[0] || {};
  sendSuccess(res, {
    months,
    totals: {
      grossRevenue: t.grossRevenue || 0,
      courseRevenue: t.courseRevenue || 0,
      fees: t.fees || 0,
      platformShare: t.platformShare || 0, // W3Skool net (10%)
      ownerShare: t.ownerShare || 0,       // instructors' share (90%)
      payments: t.payments || 0,
    },
    currency: 'NGN',
  });
});

module.exports = {
  getPayments,
  getPaymentsAnalytics,
};
