'use strict';

const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');

const dashboardStudent = require('../controllers/student/dashboard.student');
const outlineStudent = require('../controllers/student/outline.student');
const unitStudent = require('../controllers/student/unit.student');
const quizStudent = require('../controllers/student/quiz.student');
const liveSessionStudent = require('../controllers/student/liveSession.student');
const certificateStudent = require('../controllers/student/certificate.student');
const paymentStudent = require('../controllers/student/payment.student');
const leaderboardStudent = require('../controllers/student/leaderboard.student');

// All student routes require authentication
router.use(authenticate);

// ---------------------------------------------------------------------------
// Dashboard & Enrolled Courses
// ---------------------------------------------------------------------------
router.get('/dashboard', dashboardStudent.getDashboard);
router.get('/courses', dashboardStudent.getEnrolledCourses);

// ---------------------------------------------------------------------------
// Course Learning Flow (Outline & Certificate)
// ---------------------------------------------------------------------------
router.get('/courses/:courseId/outline', outlineStudent.getCourseOutline);
router.get('/courses/:courseId/certificate', certificateStudent.getCourseCertificate);

// ---------------------------------------------------------------------------
// Unit Player & Progress
// ---------------------------------------------------------------------------
router.get('/units/:unitId', unitStudent.getUnit);
router.post('/units/:unitId/progress', unitStudent.updateProgress);
router.post('/units/:unitId/complete', unitStudent.completeUnit);

// ---------------------------------------------------------------------------
// Quizzes
// ---------------------------------------------------------------------------
router.get('/quizzes/:quizId', quizStudent.getQuiz);
router.post('/quizzes/:quizId/submit', quizStudent.submitQuiz);

// ---------------------------------------------------------------------------
// Leaderboard (students AND admins may view; only students are ranked)
// ---------------------------------------------------------------------------
router.get('/leaderboard', leaderboardStudent.getLeaderboard);

// ---------------------------------------------------------------------------
// Payments & receipts
// ---------------------------------------------------------------------------
router.get('/payments', paymentStudent.getMyPayments);
router.get('/payments/:id/receipt', paymentStudent.getReceipt);

// ---------------------------------------------------------------------------
// Live Sessions
// ---------------------------------------------------------------------------
router.get('/live-sessions', liveSessionStudent.getLiveSessions);

module.exports = router;
