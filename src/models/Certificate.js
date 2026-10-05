'use strict';

const mongoose = require('mongoose');

const certificateSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    // Format: 'W3S-XXXX-XXXX' (uppercase alphanumeric segments)
    code: {
      type: String,
      required: true,
      unique: true,
    },
    issuedAt: {
      type: Date,
      default: Date.now,
    },
    // Stored certificate PDF (Cloudinary secure_url). Null until generated.
    pdfUrl: { type: String, default: null },
    pdfPublicId: { type: String, default: null },
  },
  // No { timestamps: true } — issuedAt is managed manually above
);

certificateSchema.index({ userId: 1, courseId: 1 }, { unique: true });

certificateSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Certificate', certificateSchema);
