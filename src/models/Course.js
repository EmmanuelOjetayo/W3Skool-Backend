'use strict';

const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    subtitle: {
      type: String,
      trim: true,
    },
    description: {
      type: String,
    },
    thumbnailUrl: {
      type: String,
    },
    level: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced'],
      default: 'beginner',
    },
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    // Canonical ownership field. The authenticated admin who creates the course.
    // Null = platform-owned legacy course (no authoring admin).
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    price: {
      type: Number,
      default: 0,
      min: 0,
    },
    discountPrice: {
      type: Number,
      default: null,
    },
    currency: {
      type: String,
      default: 'NGN',
    },
    instructorName: {
      type: String,
    },
    instructorBio: {
      type: String,
    },
    instructorAvatarUrl: {
      type: String,
    },
    whatYouWillLearn: [String],
    requirements: [String],
    certificate: {
      enabled: { type: Boolean, default: true },
      description: { type: String },
    },
    liveClasses: {
      enabled: { type: Boolean, default: false },
      platform: {
        type: String,
        enum: ['google_meet', 'zoom', 'whatsapp', 'other'],
      },
      description: { type: String },
      whatsappGroupUrl: { type: String },
    },
    hasFinalAssessment: {
      type: Boolean,
      default: false,
    },
    finalAssessmentQuizId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Quiz',
      default: null,
    },
    totalDurationSeconds: {
      type: Number,
      default: 0,
    },
    moduleCount: {
      type: Number,
      default: 0,
    },
    unitCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Virtual: isFree
courseSchema.virtual('isFree').get(function () {
  return this.price === 0;
});

courseSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Course', courseSchema);
