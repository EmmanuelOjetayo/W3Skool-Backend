'use strict';

const mongoose = require('mongoose');

const unitSchema = new mongoose.Schema(
  {
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
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
      trim: true,
    },
    order: {
      type: Number,
      required: true,
    },
    isPreview: {
      type: Boolean,
      default: false,
    },
    video: {
      type: {
        url: { type: String },
        publicId: { type: String },
        durationSeconds: { type: Number, default: 0 },
        requiredWatchPercent: { type: Number, default: 90, min: 0, max: 100 },
        seekPolicy: {
          type: String,
          enum: ['no_forward', 'free'],
          default: 'no_forward',
        },
      },
      default: null,
    },
    guideHtml: {
      type: String,
      default: null,
    },
    quizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      default: null,
    },
  },
  { timestamps: true }
);

unitSchema.index({ moduleId: 1, order: 1 });
unitSchema.index({ courseId: 1 });

// Virtuals
unitSchema.virtual('hasVideo').get(function () {
  return !!(this.video && this.video.url);
});

unitSchema.virtual('hasGuide').get(function () {
  return !!this.guideHtml;
});

unitSchema.virtual('hasQuiz').get(function () {
  return !!this.quizId;
});

unitSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Unit', unitSchema);
