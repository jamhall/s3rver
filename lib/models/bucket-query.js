'use strict';
var BucketQuery = function (bucket, matches, options) {
  return {
    bucket: bucket,
    matches: matches,
    isTruncated: false,
    marker: options.marker,
    prefix: options.prefix,
    maxKeys: options.maxKeys,
    delimiter: options.delimiter
  };
};
module.exports = BucketQuery;