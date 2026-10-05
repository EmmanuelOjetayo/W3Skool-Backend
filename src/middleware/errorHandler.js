const errorHandler = (err, req, res, next) => {
  // Log in dev
  if (process.env.NODE_ENV !== 'production') {
    console.error('[Error]', err);
  }

  // AppError (operational)
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message },
    });
  }

  // Mongoose validation
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(422).json({
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details },
    });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({
      error: { code: 'CONFLICT', message: `A record with this ${field} already exists.` },
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' },
    });
  }

  // Fallback
  return res.status(500).json({
    error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' },
  });
};

module.exports = errorHandler;
