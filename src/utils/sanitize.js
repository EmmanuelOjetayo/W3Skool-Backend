const sanitizeHtml = require('sanitize-html');

const ALLOWED_TAGS = [
  'h1','h2','h3','h4','h5','h6',
  'p','ul','ol','li','strong','b','em','i',
  'a','code','pre','blockquote','br','img',
  'table','thead','tbody','tr','th','td',
  'span','div',
];

const ALLOWED_ATTRIBUTES = {
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  '*': ['class'],
};

const sanitizeGuideHtml = (dirty) => {
  if (!dirty) return null;
  return sanitizeHtml(dirty, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    // Force noopener on external links
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
};

module.exports = { sanitizeGuideHtml };
