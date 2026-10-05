'use strict';

const mongoose = require('mongoose');

// ── Option subdocument ────────────────────────────────────────────────────────
const optionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    isCorrect: { type: Boolean, required: true, default: false },
  },
  { _id: true }
);

// ── Question subdocument ──────────────────────────────────────────────────────
const questionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    type: {
      type: String,
      enum: ['single', 'multiple', 'true_false'],
      default: 'single',
    },
    explanation: { type: String },
    options: [optionSchema],
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

// ── Quiz schema ───────────────────────────────────────────────────────────────
const quizSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ['unit', 'module', 'course'],
      required: true,
    },
    scopeId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    passMark: {
      type: Number,
      default: 70,
      min: 0,
      max: 100,
    },
    maxAttempts: {
      type: Number,
      default: 3, // 0 = unlimited
    },
    required: {
      type: Boolean,
      default: true,
    },
    questions: [questionSchema],
  },
  { timestamps: true }
);

// One quiz per unit/module/course
quizSchema.index({ scope: 1, scopeId: 1 }, { unique: true });

quizSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Quiz', quizSchema);
