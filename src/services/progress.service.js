'use strict';

const Unit = require('../models/Unit');
const Progress = require('../models/Progress');
const QuizAttempt = require('../models/QuizAttempt');

/**
 * Upsert a video-watch progress record for a unit.
 *
 * Anti-cheat rules:
 *  - Incoming maxWatchedSeconds is capped at durationSeconds.
 *  - Stored maxWatchedSeconds only ever increases (Math.max).
 *
 * Completion rules:
 *  - videoCompleted = true  ↔  watchedPercent ≥ unit.video.requiredWatchPercent (default 90)
 *  - unitCompleted  = true  ↔  videoCompleted AND (no quiz OR quiz passed)
 *
 * When the unit has no video, videoCompleted is forced to true and only the
 * quiz gate (if any) is evaluated.
 *
 * @param {Object} p
 * @param {string} p.userId
 * @param {string} p.unitId
 * @param {string} p.courseId
 * @param {string} p.moduleId
 * @param {number} p.positionSeconds     - Current playback position
 * @param {number} p.durationSeconds     - Total video duration (authoritative)
 * @param {number} p.maxWatchedSeconds   - Furthest position the client reports
 * @returns {Promise<{
 *   progress: Object,
 *   videoCompleted: boolean,
 *   unitCompleted: boolean,
 *   watchedPercent: number
 * }>}
 */
const upsertProgress = async ({
  userId,
  unitId,
  courseId,
  moduleId,
  positionSeconds = 0,
  durationSeconds = 0,
  maxWatchedSeconds: incomingMax = 0,
}) => {
  // ── 1. Existing progress record ───────────────────────────────────────────
  const existing = await Progress.findOne({ userId, unitId }).lean();

  // ── 2. Fetch unit to determine video config & quiz ────────────────────────
  const unit = await Unit.findById(unitId).select('video quizId').lean();

  const hasVideo = !!(unit?.video?.durationSeconds || durationSeconds);
  const effectiveDuration = durationSeconds || unit?.video?.durationSeconds || 0;
  const requiredWatchPercent = unit?.video?.requiredWatchPercent ?? 90;

  let videoCompleted;
  let watchedPercent = 0;
  let newMaxWatched;

  if (!hasVideo) {
    // No video — treat as watched
    videoCompleted = true;
    newMaxWatched = existing?.maxWatchedSeconds || 0;
  } else {
    // ── 3. Anti-cheat cap ───────────────────────────────────────────────────
    const cappedIncoming =
      effectiveDuration > 0
        ? Math.min(incomingMax, effectiveDuration)
        : incomingMax;

    // ── 4. Only ever increase maxWatchedSeconds ─────────────────────────────
    newMaxWatched = Math.max(existing?.maxWatchedSeconds || 0, cappedIncoming);

    // ── 5. Percent watched ──────────────────────────────────────────────────
    watchedPercent =
      effectiveDuration > 0 ? (newMaxWatched / effectiveDuration) * 100 : 0;

    videoCompleted = watchedPercent >= requiredWatchPercent;
  }

  // ── 6. Quiz gate ──────────────────────────────────────────────────────────
  let quizPassed = false;
  if (unit?.quizId) {
    const attempt = await QuizAttempt.findOne({
      userId,
      quizId: unit.quizId,
      passed: true,
    })
      .select('_id')
      .lean();
    quizPassed = !!attempt;
  }

  const hasQuiz = !!unit?.quizId;
  const completed = videoCompleted && (!hasQuiz || quizPassed);

  // ── 7. Determine completedAt ──────────────────────────────────────────────
  const wasAlreadyCompleted = existing?.completed === true;
  const completedAt =
    completed && !wasAlreadyCompleted
      ? new Date()
      : existing?.completedAt || null;

  // ── 8. Upsert ─────────────────────────────────────────────────────────────
  const progress = await Progress.findOneAndUpdate(
    { userId, unitId },
    {
      $set: {
        userId,
        unitId,
        courseId,
        moduleId,
        maxWatchedSeconds: newMaxWatched,
        lastPositionSeconds: positionSeconds,
        videoCompleted,
        completed,
        ...(completed && !wasAlreadyCompleted ? { completedAt } : {}),
      },
    },
    { upsert: true, new: true }
  );

  return {
    progress,
    videoCompleted,
    unitCompleted: completed,
    watchedPercent,
  };
};

/**
 * Fetch all progress records for a user in a course and return them as a Map
 * keyed by unitId string.
 *
 * @param {string} userId
 * @param {string} courseId
 * @returns {Promise<Map<string, Object>>}
 */
const getProgressMap = async (userId, courseId) => {
  const records = await Progress.find({ userId, courseId }).lean();
  const map = new Map();
  for (const p of records) {
    map.set(p.unitId.toString(), p);
  }
  return map;
};

/**
 * Compute completion metadata for a single unit, given its progress and quiz
 * attempts. Pure function — no DB calls.
 *
 * @param {Object}      unit         - Unit document (must include video, quizId)
 * @param {Object|null} progress     - Progress document for this unit, or null
 * @param {Object[]}    quizAttempts - All QuizAttempt docs for this unit's quiz
 * @returns {{
 *   completed: boolean,
 *   canMarkComplete: boolean,
 *   requirements: Array<{ key: string, label: string, met: boolean }>
 * }}
 */
const getUnitCompletion = (unit, progress, quizAttempts = []) => {
  const requirements = [];
  const hasVideo = !!(unit?.video?.url);
  const hasQuiz = !!unit?.quizId;

  // ── Video requirement ─────────────────────────────────────────────────────
  if (hasVideo) {
    const requiredPct = unit.video?.requiredWatchPercent ?? 90;
    const videoMet = progress?.videoCompleted === true;
    requirements.push({
      key: 'video',
      label: `Watch at least ${requiredPct}% of the video`,
      met: videoMet,
    });
  }

  // ── Quiz requirement ──────────────────────────────────────────────────────
  if (hasQuiz) {
    const quizPassed = quizAttempts.some((a) => a.passed === true);
    // Derive pass mark label from quiz attempts if possible; fall back to generic.
    requirements.push({
      key: 'quiz',
      label: 'Pass the quiz',
      met: quizPassed,
    });
  }

  const allMet = requirements.length === 0 || requirements.every((r) => r.met);
  const completed = allMet;

  // canMarkComplete is true only when there are no requirements at all
  // (no video AND no quiz) — the student may self-mark.
  const canMarkComplete = !hasVideo && !hasQuiz;

  return { completed, canMarkComplete, requirements };
};

module.exports = {
  upsertProgress,
  getProgressMap,
  getUnitCompletion,
};
