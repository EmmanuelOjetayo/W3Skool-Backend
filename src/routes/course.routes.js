'use strict';

const express = require('express');
const router = express.Router();
const { getCourses, getCourse, getPreviewUnit } = require('../controllers/course.controller');
const { optionalAuthenticate } = require('../middleware/authenticate');

router.get('/', optionalAuthenticate, getCourses);
router.get('/:idOrSlug', optionalAuthenticate, getCourse);
router.get('/:courseId/units/:unitId/preview', getPreviewUnit);

module.exports = router;
