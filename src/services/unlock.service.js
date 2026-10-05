'use strict';

const Module = require('../models/Module');
const Unit = require('../models/Unit');
const Progress = require('../models/Progress');
const QuizAttempt = require('../models/QuizAttempt');
const Course = require('../models/Course');

/**
 * @typedef {'completed'|'current'|'unlocked'|'locked'} ItemStatus
 *
 * @typedef {{ status: ItemStatus, lockedReason: string|null }} StatusEntry
 *
 * @typedef {{
 *   unitStatuses: Object.<string, StatusEntry>,
 *   moduleQuizStatuses: Object.<string, StatusEntry>,
 *   finalAssessmentStatus: StatusEntry|null,
 *   resumeItem: { type: 'unit'|'quiz', id: string }|null
 * }} UnlockMap
 */

/**
 * Build the full unlock / progress map for a user in a course.
 *
 * Strict sequential logic:
 *  - Unit 0   → always 'current' (unless already completed)
 *  - Unit N+1 → only unlocks when unit N is 'completed'
 *  - Exactly ONE unit has status 'current' at any given time.
 *  - Everything after 'current' is 'locked'.
 *
 * Module quizzes:
 *  - 'unlocked' only when every unit in that module is completed.
 *  - 'completed' when a passing attempt exists.
 *
 * Final assessment:
 *  - 'unlocked' only when every unit across every module is completed.
 *
 * @param {string} userId
 * @param {string} courseId
 * @returns {Promise<UnlockMap>}
 */
const getUnlockMap = async (userId, courseId) => {
  // ── Data fetching ─────────────────────────────────────────────────────────
  const [course, modules, progressRecords, quizAttempts] = await Promise.all([
    Course.findById(courseId).select('hasFinalAssessment finalAssessmentQuizId').lean(),
    Module.find({ courseId }).sort('order').lean(),
    Progress.find({ userId, courseId }).lean(),
    QuizAttempt.find({ userId, courseId }).lean(),
  ]);

  // Units per module (fetched in parallel)
  const unitsByModule = await Promise.all(
    modules.map((mod) =>
      Unit.find({ moduleId: mod._id }).sort('order').lean()
    )
  );

  // ── Index structures ──────────────────────────────────────────────────────
  /** @type {Map<string, Object>} unitId → progress */
  const progressMap = new Map();
  for (const p of progressRecords) {
    progressMap.set(p.unitId.toString(), p);
  }

  /** @type {Map<string, boolean>} quizId → hasPassed */
  const quizAttemptMap = new Map();
  for (const a of quizAttempts) {
    const qid = a.quizId.toString();
    // Once passed, keep true even if later attempts exist
    if (!quizAttemptMap.has(qid)) quizAttemptMap.set(qid, false);
    if (a.passed) quizAttemptMap.set(qid, true);
  }

  // ── Output structures ─────────────────────────────────────────────────────
  /** @type {Object.<string, StatusEntry>} */
  const unitStatuses = {};
  /** @type {Object.<string, StatusEntry>} */
  const moduleQuizStatuses = {};
  /** @type {{ type: 'unit'|'quiz', id: string }|null} */
  let resumeItem = null;

  // currentFound = true once we've placed the single 'current' unit
  let currentFound = false;
  // allPreviousCompleted is reset per-module to track module-level completion
  let allUnitsCompletedSoFar = true; // across ALL units in course (for final assessment)

  // ── Per-unit that just became 'current' ───────────────────────────────────
  /** Title of the 'current' unit so subsequent units can reference it */
  let currentUnitTitle = null;

  for (let mi = 0; mi < modules.length; mi++) {
    const mod = modules[mi];
    const units = unitsByModule[mi] || [];
    let allModuleUnitsCompleted = true;

    for (let ui = 0; ui < units.length; ui++) {
      const unit = units[ui];
      const uid = unit._id.toString();
      const prog = progressMap.get(uid);
      const isCompleted = prog?.completed === true;

      let status;
      let lockedReason = null;

      if (!currentFound) {
        // We haven't placed 'current' yet
        if (isCompleted) {
          status = 'completed';
        } else {
          // This is the first incomplete unit → 'current'
          status = 'current';
          currentFound = true;
          currentUnitTitle = unit.title;
          if (!resumeItem) {
            resumeItem = { type: 'unit', id: uid };
          }
        }
      } else {
        // Everything after 'current' is locked
        status = 'locked';
        lockedReason = currentUnitTitle
          ? `Complete "${currentUnitTitle}" to unlock this lesson.`
          : 'Complete the previous lesson to unlock this one.';
      }

      if (!isCompleted) {
        allModuleUnitsCompleted = false;
        allUnitsCompletedSoFar = false;
      }

      unitStatuses[uid] = { status, lockedReason };
    }

    // ── Module quiz status ────────────────────────────────────────────────
    if (mod.quizId) {
      const mqid = mod.quizId.toString();
      const hasPassed = quizAttemptMap.get(mqid) === true;

      let mqStatus;
      let mqLockedReason = null;

      if (allModuleUnitsCompleted) {
        if (hasPassed) {
          mqStatus = 'completed';
        } else {
          mqStatus = 'unlocked';
          // If no resumeItem set yet (all units done, quiz remains)
          if (!resumeItem) {
            resumeItem = { type: 'quiz', id: mqid };
          }
        }
      } else {
        mqStatus = 'locked';
        mqLockedReason = 'Complete all lessons in this module to unlock the quiz.';
      }

      moduleQuizStatuses[mqid] = { status: mqStatus, lockedReason: mqLockedReason };
    }
  }

  // ── Final assessment status ───────────────────────────────────────────────
  let finalAssessmentStatus = null;
  if (course?.hasFinalAssessment && course?.finalAssessmentQuizId) {
    const faqid = course.finalAssessmentQuizId.toString();
    const hasPassed = quizAttemptMap.get(faqid) === true;

    if (allUnitsCompletedSoFar) {
      const faStatus = hasPassed ? 'completed' : 'unlocked';
      if (!resumeItem && faStatus === 'unlocked') {
        resumeItem = { type: 'quiz', id: faqid };
      }
      finalAssessmentStatus = { status: faStatus, lockedReason: null };
    } else {
      finalAssessmentStatus = {
        status: 'locked',
        lockedReason: 'Complete all lessons to unlock the final assessment.',
      };
    }
  }

  return {
    unitStatuses,
    moduleQuizStatuses,
    finalAssessmentStatus,
    resumeItem,
  };
};

/**
 * Check whether a specific unit is accessible (not locked) for a user.
 *
 * @param {string} userId
 * @param {string} unitId
 * @param {string} courseId
 * @returns {Promise<boolean>}
 */
const isUnitAccessible = async (userId, unitId, courseId) => {
  const { unitStatuses } = await getUnlockMap(userId, courseId);
  const entry = unitStatuses[unitId.toString()];
  return !!entry && entry.status !== 'locked';
};

module.exports = {
  getUnlockMap,
  isUnitAccessible,
};
