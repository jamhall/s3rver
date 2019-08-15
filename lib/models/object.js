'use strict';

const { pick, pickBy } = require('lodash');

class S3Object {
  constructor(bucket, key, content, metadata) {
    this.bucket = bucket;
    this.key = key;
    this.content = content;
    this.metadata = pick(metadata, [
      ...S3Object.ALLOWED_METADATA,

      // instrinsic metadata determined when retrieving objects
      'last-modified',
      'etag',
      'content-length',
    ]);
    if (!this.metadata['content-type']) {
      this.metadata['content-type'] = 'binary/octet-stream';
    }
    Object.assign(
      this.metadata,
      pickBy(metadata, (v, k) => k.startsWith('x-amz-meta-')),
    );
  }

  get size() {
    return Number(this.metadata['content-length']);
  }

  get lastModifiedDate() {
    return new Date(this.metadata['last-modified']);
  }
}
S3Object.ALLOWED_METADATA = [
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-type',
  'expires',
  'x-amz-website-redirect-location',
];
module.exports = S3Object;
