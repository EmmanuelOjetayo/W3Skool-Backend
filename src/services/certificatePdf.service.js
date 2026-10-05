'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'logo.png');

const BRAND = {
  primary: '#97F75F',
  secondary: '#15A06B',
  bg: '#011110',
  white: '#F8FDF8',
  darkGreen: '#1E5129',
  ink: '#0B2E2C',
};

const fmtDate = (d) => new Date(d).toLocaleDateString('en-NG', { dateStyle: 'long' });

/**
 * Build a certificate PDF (A4 landscape) as a Buffer.
 *
 * @param {Object} p
 * @param {string} p.studentName
 * @param {string} p.courseTitle
 * @param {string} p.instructorName
 * @param {Date|string} p.issuedAt
 * @param {string} p.code
 * @param {string} p.verifyUrl
 * @returns {Promise<Buffer>}
 */
const buildCertificatePdf = ({ studentName, courseTitle, instructorName, issuedAt, code, verifyUrl }) =>
  new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const H = doc.page.height;

      // Background + brand frame
      doc.rect(0, 0, W, H).fill(BRAND.bg);
      doc.rect(24, 24, W - 48, H - 48).lineWidth(3).strokeColor(BRAND.primary).stroke();
      doc.rect(34, 34, W - 68, 10).fill(BRAND.primary);
      doc.rect(34, H - 44, W - 68, 10).fill(BRAND.secondary);

      // Logo (real brand asset)
      if (fs.existsSync(LOGO_PATH)) {
        try { doc.image(LOGO_PATH, W / 2 - 32, 56, { width: 64, height: 64 }); } catch (_) { /* skip if unreadable */ }
      }

      doc.fillColor(BRAND.white);
      doc.font('Helvetica-Bold').fontSize(16).text('W3Skool', 0, 128, { align: 'center' });

      doc.fillColor(BRAND.primary)
        .font('Helvetica-Bold').fontSize(34)
        .text('Certificate of Completion', 0, 158, { align: 'center' });

      doc.fillColor('#9DB4AC').font('Helvetica').fontSize(12)
        .text('This certifies that', 0, 214, { align: 'center' });

      doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(30)
        .text(studentName || 'Student', 0, 236, { align: 'center' });

      doc.fillColor('#9DB4AC').font('Helvetica').fontSize(12)
        .text('has successfully completed', 0, 282, { align: 'center' });

      doc.fillColor(BRAND.primary).font('Helvetica-Bold').fontSize(22)
        .text(courseTitle || 'W3Skool Course', 60, 302, { align: 'center', width: W - 120 });

      // Footer details
      const baseY = H - 118;
      doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(11);
      doc.text(fmtDate(issuedAt), W * 0.18, baseY, { width: 200, align: 'center' });
      doc.text(instructorName || 'W3Skool Academy', W * 0.42, baseY, { width: 200, align: 'center' });
      doc.text(code, W * 0.66, baseY, { width: 200, align: 'center' });

      doc.fillColor('#9DB4AC').font('Helvetica').fontSize(9);
      doc.text('Date issued', W * 0.18, baseY + 16, { width: 200, align: 'center' });
      doc.text('Instructor', W * 0.42, baseY + 16, { width: 200, align: 'center' });
      doc.text('Certificate ID', W * 0.66, baseY + 16, { width: 200, align: 'center' });

      if (verifyUrl) {
        doc.fillColor('#9DB4AC').font('Helvetica').fontSize(9)
          .text(`Verify this certificate at ${verifyUrl}`, 0, H - 62, { align: 'center' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

module.exports = { buildCertificatePdf };