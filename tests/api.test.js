'use strict';

const request = require('supertest');

// Note: Ensure env vars are set before loading app
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test_jwt_secret_super_secure_key_12345';
process.env.CLIENT_URL = 'http://localhost:3000';

const app = require('../src/app');

describe('W3Skool API Integration Tests', () => {
  it('GET /health should return 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.timestamp).toBeDefined();
  });

  it('GET /unknown-route should return 404 with NOT_FOUND code', async () => {
    const res = await request(app).get('/api/v1/unknown-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('POST /api/v1/auth/register with missing fields should return 400 with VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/v1/auth/login with missing credentials should return 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /api/v1/certificates/verify/INVALID-CODE should return valid: false', async () => {
    const res = await request(app).get('/api/v1/certificates/verify/INVALID-CODE-XYZ');
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
  });
});
