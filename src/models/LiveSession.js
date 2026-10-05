'use strict';

const mongoose = require('mongoose');

const liveSessionSchema = new mongoose.Schema(
  {
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
    startsAt: {
      type: Date,
      required: true,
    },
    durationMinutes: {
      type: Number,
      required: true,
      default: 60,
    },
    platform: {
      type: String,
      enum: ['google_meet', 'zoom', 'whatsapp', 'other'],
      default: 'google_meet',
    },
    joinUrl: {
      type: String,
      required: true,
    },
    notes: {
      type: String,
    },
    // Whether enrolled students should be notified (email) about this session.
    notifyStudents: {
      type: Boolean,
      default: true,
    },
    // When the last notification was sent and for which revision (idempotency).
    notifiedAt: {
      type: Date,
      default: null,
    },
    notifiedRevision: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// ── Virtuals ──────────────────────────────────────────────────────────────────

/**
 * status — derived from current time relative to session window.
 * 'scheduled' : more than 15 min before start
 * 'live'      : within the session window (15 min early access → end)
 * 'ended'     : after the session window
 */
liveSessionSchema.virtual('status').get(function () {
  const now = Date.now();
  const start = new Date(this.startsAt).getTime();
  const earlyOpenMs = 15 * 60 * 1000;
  const durationMs = this.durationMinutes * 60 * 1000;

  if (now < start - earlyOpenMs) return 'scheduled';
  if (now >= start - earlyOpenMs && now < start + durationMs) return 'live';
  return 'ended';
});

/**
 * joinOpensAt — 15 minutes before the scheduled start time.
 */
liveSessionSchema.virtual('joinOpensAt').get(function () {
  const start = new Date(this.startsAt).getTime();
  return new Date(start - 15 * 60 * 1000);
});

/**
 * joinUrlActive — returns joinUrl only while the session is 'live', else null.
 */
liveSessionSchema.virtual('joinUrlActive').get(function () {
  return this.status === 'live' ? this.joinUrl : null;
});

liveSessionSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('LiveSession', liveSessionSchema);
