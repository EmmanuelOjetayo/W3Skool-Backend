'use strict';
/* Inspect course duration data: course.totalDurationSeconds vs unit video durations. */
require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const Course = require('./src/models/Course');
  const Unit = require('./src/models/Unit');
  const courses = await Course.find({}).select('title status totalDurationSeconds moduleCount unitCount').lean();
  for (const c of courses) {
    const units = await Unit.find({ courseId: c._id }).select('title video.durationSeconds video.url').lean();
    const sum = units.reduce((s, u) => s + (u.video?.durationSeconds || 0), 0);
    console.log(`\nCOURSE "${c.title}" status=${c.status} unitCount=${c.unitCount} totalDurationSeconds=${c.totalDurationSeconds} (sum of units=${sum})`);
    for (const u of units) {
      console.log(`   - "${u.title}" dur=${u.video?.durationSeconds ?? 'none'} url=${u.video?.url ? 'yes' : 'no'}`);
    }
  }
  await mongoose.disconnect();
  process.exit();
})();