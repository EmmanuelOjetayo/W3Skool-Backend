'use strict';

const express = require('express');
const router = express.Router();

const { authenticate } = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');

const courseAdmin = require('../controllers/admin/course.admin');
const moduleAdmin = require('../controllers/admin/module.admin');
const unitAdmin = require('../controllers/admin/unit.admin');
const quizAdmin = require('../controllers/admin/quiz.admin');
const liveSessionAdmin = require('../controllers/admin/liveSession.admin');
const studentAdmin = require('../controllers/admin/student.admin');
const paymentAdmin = require('../controllers/admin/payment.admin');
const analyticsAdmin = require('../controllers/admin/analytics.admin');
const uploadAdmin = require('../controllers/admin/upload.admin');
const payoutAdmin = require('../controllers/admin/payout.admin');

// All admin routes require authentication and admin role
router.use(authenticate, authorize('admin'));

// ---------------------------------------------------------------------------
// Stats & Overview
// ---------------------------------------------------------------------------
router.get('/stats', analyticsAdmin.getOverview);

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------
router.get('/courses', courseAdmin.getCourses);
router.post('/courses', courseAdmin.createCourse);
router.get('/courses/:id', courseAdmin.getCourse);
router.patch('/courses/:id', courseAdmin.updateCourse);
router.delete('/courses/:id', courseAdmin.deleteCourse);
router.patch('/courses/:id/status', courseAdmin.updateCourseStatus);
router.get('/courses/:id/publish-check', courseAdmin.publishCheck);
router.post('/courses/:id/publish', courseAdmin.publishCourse);
router.post('/courses/:id/unpublish', courseAdmin.unpublishCourse);
router.get('/courses/:id/preview', courseAdmin.getCoursePreview);
router.get('/courses/:courseId/stats', analyticsAdmin.getCourseStats);

// Course Quiz (Final Assessment)
router.get('/courses/:id/quiz', (req, res, next) => {
  req.quizScope = 'course';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.getQuiz);

router.put('/courses/:id/quiz', (req, res, next) => {
  req.quizScope = 'course';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.upsertQuiz);

router.delete('/courses/:id/quiz', (req, res, next) => {
  req.quizScope = 'course';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.deleteQuiz);

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------
router.post('/courses/:courseId/modules', moduleAdmin.createModule);
router.patch('/modules/:id', moduleAdmin.updateModule);
router.delete('/modules/:id', moduleAdmin.deleteModule);
router.put('/courses/:courseId/modules/order', moduleAdmin.reorderModules);

// Module Quiz
router.get('/modules/:id/quiz', (req, res, next) => {
  req.quizScope = 'module';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.getQuiz);

router.put('/modules/:id/quiz', (req, res, next) => {
  req.quizScope = 'module';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.upsertQuiz);

router.delete('/modules/:id/quiz', (req, res, next) => {
  req.quizScope = 'module';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.deleteQuiz);

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
router.post('/modules/:moduleId/units', unitAdmin.createUnit);
router.get('/units/:id', unitAdmin.getUnit);
router.patch('/units/:id', unitAdmin.updateUnit);
router.delete('/units/:id', unitAdmin.deleteUnit);
router.put('/modules/:moduleId/units/order', unitAdmin.reorderUnits);

// Unit Resources
router.post('/units/:unitId/resources', unitAdmin.createResource);
router.delete('/resources/:id', unitAdmin.deleteResource);

// Unit Quiz
router.get('/units/:id/quiz', (req, res, next) => {
  req.quizScope = 'unit';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.getQuiz);

router.put('/units/:id/quiz', (req, res, next) => {
  req.quizScope = 'unit';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.upsertQuiz);

router.delete('/units/:id/quiz', (req, res, next) => {
  req.quizScope = 'unit';
  req.quizScopeId = req.params.id;
  next();
}, quizAdmin.deleteQuiz);

// ---------------------------------------------------------------------------
// Live Sessions
// ---------------------------------------------------------------------------
router.get('/live-sessions', liveSessionAdmin.getLiveSessions);
router.post('/live-sessions', liveSessionAdmin.createLiveSession);
router.patch('/live-sessions/:id', liveSessionAdmin.updateLiveSession);
router.delete('/live-sessions/:id', liveSessionAdmin.deleteLiveSession);

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------
router.get('/students', studentAdmin.getStudents);
router.get('/students/:id', studentAdmin.getStudent);
router.get('/courses/:courseId/students', studentAdmin.getCourseStudents);
router.get('/courses/:courseId/students/:studentId', studentAdmin.getCourseStudentRecord);

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
router.get('/payments', paymentAdmin.getPayments);
router.get('/payments/analytics', paymentAdmin.getPaymentsAnalytics);

// ---------------------------------------------------------------------------
// Flutterwave payouts / subaccount
// ---------------------------------------------------------------------------
router.get('/payouts', payoutAdmin.getPayoutStatus);
router.get('/payouts/banks', payoutAdmin.getBanks);
router.get('/payouts/resolve', payoutAdmin.resolveAccountCtrl);
router.get('/payouts/subaccount', payoutAdmin.getSubaccount);
router.post('/payouts/subaccount', payoutAdmin.createSubaccountCtrl);
router.patch('/payouts/subaccount', payoutAdmin.updateSubaccountCtrl);

// ---------------------------------------------------------------------------
// Uploads (Direct Cloudinary Signature)
// ---------------------------------------------------------------------------
router.post('/uploads/signature', uploadAdmin.generateSignature);

module.exports = router;
