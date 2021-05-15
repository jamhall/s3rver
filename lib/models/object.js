'use strict';

const { pick, pickBy } = require('lodash');

const S3Error = require('./error');

class S3Object {
  constructor(bucket, key, content, metadata) {
    this.bucket = bucket;
    this.key = key;
    this.content = content;
    if ('x-amz-storage-class' in metadata) {
      if (!S3Object.STORAGE_CLASSES.includes(metadata['x-amz-storage-class'])) {
        throw new S3Error(
          'InvalidStorageClass',
          'The storage class you specified is not valid',
        );
      }
    }
    this.metadata = pick(metadata, [
      ...S3Object.ALLOWED_METADATA,

      // intrinsic metadata determined when retrieving objects
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
  'x-amz-storage-class',
  'x-amz-website-redirect-location',
];
S3Object.STORAGE_CLASSES = [
  'STANDARD',
  'REDUCED_REDUNDANCY',
  'STANDARD_IA',
  'ONEZONE_IA',
  'INTELLIGENT_TIERING',
  'GLACIER',
  'DEEP_ARCHIVE',
  'OUTPOSTS',
];
module.exports = S3Object;
