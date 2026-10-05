'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const connectDB = require('../config/db');
const User = require('../models/User');
const Course = require('../models/Course');
const Module = require('../models/Module');
const Unit = require('../models/Unit');
const Resource = require('../models/Resource');
const Quiz = require('../models/Quiz');
const LiveSession = require('../models/LiveSession');

const seed = async () => {
  console.log('[Seed] Connecting to MongoDB...');
  await connectDB();

  console.log('[Seed] Clearing existing demo collections...');
  await Promise.all([
    User.deleteMany({ email: { $in: ['admin@w3skool.com', 'student@w3skool.com'] } }),
    Course.deleteMany({ slug: { $in: ['modern-javascript-mastery', 'git-github-fundamentals'] } }),
  ]);

  console.log('[Seed] Creating demo users...');
  const adminPassword = await bcrypt.hash('AdminPass123!', 12);
  const studentPassword = await bcrypt.hash('StudentPass123!', 12);

  const [admin, student] = await Promise.all([
    User.create({
      name: 'Admin W3Skool',
      email: 'admin@w3skool.com',
      password: adminPassword,
      role: 'admin',
    }),
    User.create({
      name: 'Chidi Student',
      email: 'student@w3skool.com',
      password: studentPassword,
      role: 'student',
    }),
  ]);
  console.log(`  ✓ Admin created: admin@w3skool.com / AdminPass123!`);
  console.log(`  ✓ Student created: student@w3skool.com / StudentPass123!`);

  // ── Course 1: Paid Course ────────────────────────────────────────────────
  console.log('[Seed] Creating Course 1 (Paid: Modern JavaScript)...');
  const course1 = await Course.create({
    title: 'Modern JavaScript & Node.js Mastery',
    slug: 'modern-javascript-mastery',
    subtitle: 'From core runtime primitives to production-ready backend services',
    description: 'A comprehensive technical course on modern JavaScript, the V8 engine, async programming, and enterprise Node.js architecture.',
    level: 'intermediate',
    thumbnailUrl: 'https://images.unsplash.com/photo-1579468118864-1b9ea3c0db4a?auto=format&fit=crop&w=800&q=80',
    status: 'published',
    price: 25000,
    discountPrice: 18000,
    currency: 'NGN',
    instructorName: 'Alex Ekwueme',
    instructorBio: 'Senior Distributed Systems Architect and Technical Educator',
    instructorAvatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=200&q=80',
    whatYouWillLearn: [
      'Deep dive into the JavaScript execution context and call stack',
      'Master closures, prototypical inheritance, and event loop mechanics',
      'Asynchronous workflows with Promises, async/await, and generators',
      'Build robust REST APIs with Express and MongoDB',
    ],
    requirements: [
      'Basic familiarity with HTML and CSS',
      'A computer with Node.js 18+ installed',
    ],
    certificate: {
      enabled: true,
      description: 'Official W3Skool Certificate of Completion upon finishing all modules and passing assessments.',
    },
    liveClasses: {
      enabled: true,
      platform: 'google_meet',
      description: 'Weekly interactive live workshops and code reviews every Saturday at 4 PM WAT.',
      whatsappGroupUrl: 'https://chat.whatsapp.com/demo-w3skool-js',
    },
    hasFinalAssessment: true,
    moduleCount: 2,
    unitCount: 4,
    totalDurationSeconds: 4200,
  });

  // Module 1
  const mod1 = await Module.create({
    courseId: course1._id,
    title: 'Module 1: JavaScript Engine & Core Syntax',
    order: 1,
  });

  const unit1 = await Unit.create({
    courseId: course1._id,
    moduleId: mod1._id,
    title: 'Welcome to W3Skool & Environment Setup',
    order: 1,
    isPreview: true,
    video: {
      url: 'https://res.cloudinary.com/demo/video/upload/sp_hd/sea_turtle.mp4',
      publicId: 'w3skool/demo/sea_turtle',
      durationSeconds: 600,
      requiredWatchPercent: 90,
      seekPolicy: 'no_forward',
    },
    guideHtml: '<h2>Welcome to the Academy</h2><p>In this initial lesson, we verify our Node.js and VS Code development environment.</p>',
  });

  const unit2 = await Unit.create({
    courseId: course1._id,
    moduleId: mod1._id,
    title: 'Variables, Scopes & Memory Model',
    order: 2,
    isPreview: false,
    video: {
      url: 'https://res.cloudinary.com/demo/video/upload/sp_hd/sea_turtle.mp4',
      publicId: 'w3skool/demo/scopes',
      durationSeconds: 1200,
      requiredWatchPercent: 90,
      seekPolicy: 'no_forward',
    },
    guideHtml: '<h2>Variable Scopes & Closures</h2><p>Understand how lexical environments are allocated on the heap.</p>',
  });

  // Quiz for Unit 2
  const quizUnit2 = await Quiz.create({
    scope: 'unit',
    scopeId: unit2._id,
    courseId: course1._id,
    title: 'Scopes & Variables Knowledge Check',
    passMark: 70,
    maxAttempts: 3,
    required: true,
    questions: [
      {
        text: 'Which keyword creates a block-scoped variable that cannot be reassigned?',
        type: 'single',
        explanation: 'const creates a block-scoped binding that cannot be reassigned.',
        options: [
          { text: 'var', isCorrect: false },
          { text: 'let', isCorrect: false },
          { text: 'const', isCorrect: true },
        ],
      },
      {
        text: 'Where are closure variables retained when the outer function completes execution?',
        type: 'single',
        explanation: 'Variables captured in closures are preserved on the heap.',
        options: [
          { text: 'Call Stack', isCorrect: false },
          { text: 'Heap Memory', isCorrect: true },
          { text: 'CPU Registers', isCorrect: false },
        ],
      },
    ],
  });
  await Unit.findByIdAndUpdate(unit2._id, { quizId: quizUnit2._id });

  // Resources for Unit 1 & 2
  await Resource.create({
    courseId: course1._id,
    moduleId: mod1._id,
    unitId: unit1._id,
    title: 'W3Skool Node.js Setup Guide.pdf',
    type: 'pdf',
    url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
    sizeBytes: 13264,
  });

  // Module 2
  const mod2 = await Module.create({
    courseId: course1._id,
    title: 'Module 2: Asynchronous Programming & Event Loop',
    order: 2,
  });

  const unit3 = await Unit.create({
    courseId: course1._id,
    moduleId: mod2._id,
    title: 'Promises & Async/Await In-Depth',
    order: 1,
    isPreview: false,
    video: {
      url: 'https://res.cloudinary.com/demo/video/upload/sp_hd/sea_turtle.mp4',
      publicId: 'w3skool/demo/promises',
      durationSeconds: 1200,
      requiredWatchPercent: 90,
      seekPolicy: 'no_forward',
    },
    guideHtml: '<h2>Async/Await</h2><p>Syntactic sugar over Promises facilitating synchronous-looking async flow.</p>',
  });

  const unit4 = await Unit.create({
    courseId: course1._id,
    moduleId: mod2._id,
    title: 'Microtasks vs Macrotasks in the Node.js Event Loop',
    order: 2,
    isPreview: false,
    video: {
      url: 'https://res.cloudinary.com/demo/video/upload/sp_hd/sea_turtle.mp4',
      publicId: 'w3skool/demo/event_loop',
      durationSeconds: 1200,
      requiredWatchPercent: 90,
      seekPolicy: 'no_forward',
    },
    guideHtml: '<h2>The Event Loop</h2><p>Timers, pending callbacks, poll, check, and close callbacks phases.</p>',
  });

  // Module 2 Review Quiz
  const mod2Quiz = await Quiz.create({
    scope: 'module',
    scopeId: mod2._id,
    courseId: course1._id,
    title: 'Module 2 Async Certification Review',
    passMark: 80,
    maxAttempts: 3,
    required: true,
    questions: [
      {
        text: 'Which queue is processed immediately after the current operation and before the macrotask queue?',
        type: 'single',
        explanation: 'The microtask queue (e.g. process.nextTick, Promise callbacks) is processed before the next macrotask.',
        options: [
          { text: 'Microtask Queue', isCorrect: true },
          { text: 'Timer Queue', isCorrect: false },
          { text: 'I/O Polling Queue', isCorrect: false },
        ],
      },
    ],
  });
  await Module.findByIdAndUpdate(mod2._id, { quizId: mod2Quiz._id });

  // Course Final Assessment Quiz
  const finalQuiz = await Quiz.create({
    scope: 'course',
    scopeId: course1._id,
    courseId: course1._id,
    title: 'JavaScript & Node.js Academy Final Assessment',
    passMark: 75,
    maxAttempts: 2,
    required: true,
    questions: [
      {
        text: 'What happens when an unhandled Promise rejection occurs in modern Node.js?',
        type: 'single',
        explanation: 'Modern Node.js terminates the process with a non-zero exit code.',
        options: [
          { text: 'The process exits with an error', isCorrect: true },
          { text: 'It is silently ignored', isCorrect: false },
          { text: 'The thread is permanently paused', isCorrect: false },
        ],
      },
    ],
  });
  await Course.findByIdAndUpdate(course1._id, { finalAssessmentQuizId: finalQuiz._id });

  // ── Course 2: Free Course (Price = 0) ────────────────────────────────────
  console.log('[Seed] Creating Course 2 (Free: Git & GitHub)...');
  const course2 = await Course.create({
    title: 'Git & GitHub Fundamentals for Developers',
    slug: 'git-github-fundamentals',
    subtitle: 'Version control mastery for modern software teams',
    description: 'Learn Git from scratch: repositories, staging, branching, conflict resolution, and collaborative pull request workflows on GitHub.',
    level: 'beginner',
    thumbnailUrl: 'https://images.unsplash.com/photo-1618401471353-b98afee0b2eb?auto=format&fit=crop&w=800&q=80',
    status: 'published',
    price: 0,
    discountPrice: null,
    currency: 'NGN',
    instructorName: 'Tunde Bakare',
    instructorBio: 'DevOps & Cloud Engineer',
    whatYouWillLearn: [
      'Initialize Git repositories and manage staging states',
      'Branching models: feature branches and merge workflows',
      'Resolve merge conflicts like a pro',
      'Collaborate via GitHub pull requests',
    ],
    requirements: ['Any operating system with a command line terminal'],
    certificate: {
      enabled: true,
      description: 'W3Skool Certificate of Completion in Git & Version Control.',
    },
    liveClasses: {
      enabled: false,
    },
    hasFinalAssessment: false,
    moduleCount: 1,
    unitCount: 2,
    totalDurationSeconds: 1800,
  });

  const gitMod = await Module.create({
    courseId: course2._id,
    title: 'Module 1: Version Control Basics',
    order: 1,
  });

  await Unit.create({
    courseId: course2._id,
    moduleId: gitMod._id,
    title: 'Git Init & Your First Commit',
    order: 1,
    isPreview: true,
    video: {
      url: 'https://res.cloudinary.com/demo/video/upload/sp_hd/sea_turtle.mp4',
      publicId: 'w3skool/demo/git_init',
      durationSeconds: 900,
      requiredWatchPercent: 90,
      seekPolicy: 'no_forward',
    },
    guideHtml: '<h2>Getting Started with Git</h2><p>Run git init to create a new repository in your project directory.</p>',
  });

  await Unit.create({
    courseId: course2._id,
    moduleId: gitMod._id,
    title: 'Branching, Merging & Stashing',
    order: 2,
    isPreview: false,
    video: {
      url: 'https://res.cloudinary.com/demo/video/upload/sp_hd/sea_turtle.mp4',
      publicId: 'w3skool/demo/git_branch',
      durationSeconds: 900,
      requiredWatchPercent: 90,
      seekPolicy: 'no_forward',
    },
    guideHtml: '<h2>Git Branches</h2><p>Isolate changes using feature branches before merging back to main.</p>',
  });

  // ── Live Session Demo ────────────────────────────────────────────────────
  const upcomingSaturday = new Date();
  upcomingSaturday.setDate(upcomingSaturday.getDate() + ((6 - upcomingSaturday.getDay() + 7) % 7 || 7));
  upcomingSaturday.setHours(16, 0, 0, 0);

  await LiveSession.create({
    courseId: course1._id,
    title: 'Saturday Interactive Code Review & Q&A',
    startsAt: upcomingSaturday,
    durationMinutes: 60,
    platform: 'google_meet',
    joinUrl: 'https://meet.google.com/abc-defg-hij',
    notes: 'Bring questions regarding Module 1 & 2 asynchronous patterns.',
  });

  console.log('\n=============================================');
  console.log('✓ Seeding complete!');
  console.log('  Courses: 2 (1 Paid, 1 Free)');
  console.log('  Admin User:   admin@w3skool.com  / AdminPass123!');
  console.log('  Student User: student@w3skool.com / StudentPass123!');
  console.log('=============================================\n');

  await mongoose.disconnect();
  process.exit(0);
};

seed().catch((err) => {
  console.error('[Seed] Error during seeding:', err);
  process.exit(1);
});
