'use strict';

const mongoose = require('mongoose');

const resourceSchema = new mongoose.Schema(
  {
    unitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Unit',
      default: null,
    },
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
      default: null,
    },
    courseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      // Stored as the file's extension by the admin uploader (pdf, pptx, …),
      // so it has to cover everything the uploader accepts plus 'link'.
      enum: [
        'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'odt', 'ods', 'odp',
        'csv', 'rtf', 'txt', 'md', 'json', 'zip', 'png', 'jpg', 'jpeg', 'webp',
        'gif', 'svg', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'cheatsheet', 'file', 'link',
      ],
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    publicId: {
      type: String,
      default: null,
    },
    sizeBytes: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

resourceSchema.index({ unitId: 1 });
resourceSchema.index({ moduleId: 1 });
resourceSchema.index({ courseId: 1 });

resourceSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    return ret;
  },
});

module.exports = mongoose.model('Resource', resourceSchema);
