'use strict';

const { sendSuccess, sendError } = require('../src/utils/response');
const { sanitizeGuideHtml } = require('../src/utils/sanitize');
const AppError = require('../src/utils/AppError');
const { generateCode } = require('../src/services/certificate.service');
const { getUnitCompletion } = require('../src/services/progress.service');

describe('W3Skool Backend Unit Tests', () => {
  describe('Utils: response.js', () => {
    it('should format success envelope with { data }', () => {
      let statusCalled = null;
      let jsonCalled = null;
      const res = {
        status: (code) => { statusCalled = code; return res; },
        json: (payload) => { jsonCalled = payload; return res; },
      };

      sendSuccess(res, { foo: 'bar' }, 201);
      expect(statusCalled).toBe(201);
      expect(jsonCalled).toEqual({ data: { foo: 'bar' } });
    });

    it('should format error envelope with { error: { code, message } }', () => {
      let statusCalled = null;
      let jsonCalled = null;
      const res = {
        status: (code) => { statusCalled = code; return res; },
        json: (payload) => { jsonCalled = payload; return res; },
      };

      sendError(res, 'Unit is locked.', 403, 'UNIT_LOCKED');
      expect(statusCalled).toBe(403);
      expect(jsonCalled).toEqual({
        error: { code: 'UNIT_LOCKED', message: 'Unit is locked.' },
      });
    });
  });

  describe('Utils: sanitize.js', () => {
    it('should remove unsafe script tags and retain allowed HTML', () => {
      const dirty = '<h2>Title</h2><script>alert("hack")</script><p>Safe text</p>';
      const cleaned = sanitizeGuideHtml(dirty);
      expect(cleaned).toContain('<h2>Title</h2>');
      expect(cleaned).toContain('<p>Safe text</p>');
      expect(cleaned).not.toContain('<script>');
      expect(cleaned).not.toContain('alert');
    });

    it('should enforce rel="noopener noreferrer" on external links', () => {
      const html = '<a href="https://example.com" target="_blank">External</a>';
      const cleaned = sanitizeGuideHtml(html);
      expect(cleaned).toContain('rel="noopener noreferrer"');
    });
  });

  describe('Utils: AppError', () => {
    it('should properly set statusCode, code, and operational flag', () => {
      const err = new AppError('Payment failed', 502, 'PAYMENT_INIT_FAILED');
      expect(err.message).toBe('Payment failed');
      expect(err.statusCode).toBe(502);
      expect(err.code).toBe('PAYMENT_INIT_FAILED');
      expect(err.isOperational).toBe(true);
    });
  });

  describe('Services: Certificate Code Generator', () => {
    it('should generate codes conforming to W3S-XXXX-XXXX format', () => {
      const code = generateCode();
      expect(code).toMatch(/^W3S-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      // Ensure no easily confusable chars: 0, O, 1, I
      expect(code).not.toMatch(/[01OI]/);
    });
  });

  describe('Services: Progress Completion Logic', () => {
    it('should mark unit completed when video watch percentage requirement is met and no quiz', () => {
      const unit = {
        video: { url: 'https://video.mp4', requiredWatchPercent: 90 },
        quizId: null,
      };
      const progress = { videoCompleted: true, maxWatchedSeconds: 1800 };
      const completion = getUnitCompletion(unit, progress, []);

      expect(completion.completed).toBe(true);
      expect(completion.canMarkComplete).toBe(false);
      expect(completion.requirements[0].met).toBe(true);
    });

    it('should not mark unit completed if required quiz has not been passed', () => {
      const unit = {
        video: { url: 'https://video.mp4', requiredWatchPercent: 90 },
        quizId: '67a3f890b21a3e0000000001',
      };
      const progress = { videoCompleted: true };
      const attempts = [{ passed: false }];
      const completion = getUnitCompletion(unit, progress, attempts);

      expect(completion.completed).toBe(false);
      expect(completion.requirements.find((r) => r.key === 'quiz').met).toBe(false);
    });

    it('should allow self-complete only if unit has neither video nor quiz', () => {
      const guideOnlyUnit = { video: null, quizId: null };
      const completion = getUnitCompletion(guideOnlyUnit, null, []);

      expect(completion.canMarkComplete).toBe(true);
    });
  });
});
