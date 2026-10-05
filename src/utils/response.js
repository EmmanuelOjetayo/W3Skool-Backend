const sendSuccess = (res, data, statusCode = 200) => {
  return res.status(statusCode).json({ data });
};

const sendError = (res, message, statusCode = 500, code = 'SERVER_ERROR', details = null) => {
  const payload = { error: { code, message } };
  if (details) payload.error.details = details;
  return res.status(statusCode).json(payload);
};

module.exports = { sendSuccess, sendError };
