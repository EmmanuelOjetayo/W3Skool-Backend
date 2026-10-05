'use strict';

const { generateUploadSignature } = require('../../services/cloudinary.service');
const asyncHandler = require('../../utils/asyncHandler');
const { sendSuccess, sendError } = require('../../utils/response');

/** POST /admin/uploads/signature */
const generateSignature = asyncHandler(async (req, res) => {
  const { kind } = req.body;
  if (!kind || !['video', 'image', 'raw'].includes(kind)) {
    return sendError(res, 'kind must be video, image, or raw.', 422, 'VALIDATION_ERROR');
  }

  const signatureData = generateUploadSignature(kind);
  sendSuccess(res, signatureData);
});

module.exports = {
  generateSignature,
};
